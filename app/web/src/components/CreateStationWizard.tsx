import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Station } from '../api';
import SelectMenu, { type SelectOption } from './SelectMenu';

interface Props {
  open: boolean;
  /** 本租户全量工位：用于生成下一个工位编号 */
  stations: Station[];
  company: string;
  region: string | null;
  /** 预选产线（左侧树当前选中的本地 line_id，即 CMC 产线码） */
  defaultLineId: string;
  /** v3.42 编辑模式：传入则只改名称/TT（PATCH，产线与编码不可改——工位编码是全链引用键） */
  editStation?: Station | null;
  onClose: () => void;
  onCreated: (station: Station, lineId: string) => void;
}

interface CmcFactory { cmc_factory_id: number; code: string; name: string; region: string | null }
interface CmcLine {
  cmc_line_id: number; factory_id: number; code: string; name: string;
  process_type: string; process_type_raw: string | null; line_type: string | null;
  factory_code: string; factory_name: string; project_count: number;
}
interface CmcProject {
  program_number: string; name: string; customer: string | null; phase: string | null;
  product_group: string | null; ct_standard: number | null; allocation_ratio: number | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 下一个可用工位编码（产线内序号；产线码即 CMC code，如 BJFA1-ST03） */
function nextStationCode(stations: Station[], lineCode: string): string {
  const used = new Set(stations.filter((s) => s.line_id === lineCode).map((s) => s.station_id));
  for (let i = 1; i <= 99; i += 1) {
    const code = `${lineCode}-ST${pad2(i)}`;
    if (!used.has(code)) return code;
  }
  return `${lineCode}-ST99`;
}

/**
 * 新建分析对象向导（v3.21 重写）：CMC 三级联动 工厂 → 产线 → 项目 → 工位。
 * 为什么这么改：基础信息全部来自产能系统 CMC（factories / production_lines /
 * project_line_allocations / cbco_records），跨库实时只读，本系统零维护——
 * 用户只填「工位名称 + TT」，工位编码由 CMC 产线码自动生成（BJFA1-ST03）。
 * 本地不再提供新建产线/项目入口（那是产能系统的职责），保证多系统数据一致。
 * 下拉全部用 SelectMenu 自绘（v3.21：根治原生 popup 漂移）。
 */
export default function CreateStationWizard({ open, stations, company, region, defaultLineId, editStation = null, onClose, onCreated }: Props) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [factories, setFactories] = useState<CmcFactory[]>([]);
  /** 全量产线（打开时一次拉取，切工厂本地过滤——性能 #73：消除切厂二次网络请求） */
  const allLinesRef = useRef<CmcLine[]>([]);
  const [lines, setLines] = useState<CmcLine[]>([]);          /* 当前工厂的产线 */
  const [projects, setProjects] = useState<CmcProject[]>([]); /* 当前产线的已分配项目 */
  const [loadingProjects, setLoadingProjects] = useState(false);

  const [factoryId, setFactoryId] = useState<number | null>(null);
  const [cmcLineId, setCmcLineId] = useState<number | null>(null);
  const [programNumber, setProgramNumber] = useState('');     /* '' = 未关联项目 */
  const [station, setStation] = useState({ name: '', tt: '' });
  const [ttEdited, setTtEdited] = useState(false);
  /** 工位编码（v3.23）：默认留空由用户自己写（现场习称如 PA10）；留空提交 = 后端按产线码自动生成。
      v3.22 曾预填建议值——现场习称不符时须先删后写，多一个删除动作，已废弃 */
  const [codeInput, setCodeInput] = useState('');

  /* 打开时一次拉全量：工厂清单 + 全量产线（切工厂只做本地过滤，零网络等待）
     v3.42：编辑模式跳过 CMC 拉取（产线/编码不可改，仅名称/TT 可编辑） */
  useEffect(() => {
    if (!open) return;
    if (editStation) {
      setFactoryId(null); setCmcLineId(null);
      setStation({ name: editStation.name, tt: editStation.tt != null ? String(editStation.tt) : '' });
      setTtEdited(true);
      setCodeInput(editStation.station_id);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      try {
        const [fs, allLines] = await Promise.all([api.cmc.factories(), api.cmc.lines()]);
        if (!alive) return;
        setFactories(fs);
        allLinesRef.current = allLines;
        const hit = defaultLineId ? allLines.find((l) => l.code === defaultLineId) : undefined;
        const fid = hit ? hit.factory_id : (fs[0]?.cmc_factory_id ?? null);
        const lid = hit ? hit.cmc_line_id : (fid !== null ? allLines.find((l) => l.factory_id === fid)?.cmc_line_id ?? null : null);
        setFactoryId(fid);
        setLines(fid !== null ? allLines.filter((l) => l.factory_id === fid) : []);
        setCmcLineId(lid);
        setProgramNumber('');
        setStation({ name: '', tt: '' });
        setTtEdited(false);
        setCodeInput('');
      } catch (err) {
        if (alive) setError(cmcErrorHint(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, defaultLineId]);

  const selectedLine = useMemo(() => lines.find((l) => l.cmc_line_id === cmcLineId) ?? null, [lines, cmcLineId]);
  const selectedProject = useMemo(
    () => projects.find((p) => p.program_number === programNumber) ?? null,
    [projects, programNumber],
  );

  /* 切换工厂 → 本地过滤全量产线（性能 #73：全量已在手，不再发网络请求，
     用户实测"选 SH 后产线列表近 10 秒"即此处的二次请求 + 冷缓存叠加造成） */
  useEffect(() => {
    if (!open || factoryId === null) return;
    const ls = allLinesRef.current.filter((l) => l.factory_id === factoryId);
    setLines(ls);
    /* 仅在当前选中线不属于新工厂时重置（首次预选不冲掉） */
    setCmcLineId((prev) => (prev !== null && ls.some((l) => l.cmc_line_id === prev) ? prev : (ls[0]?.cmc_line_id ?? null)));
  }, [open, factoryId]);

  /* 切换产线 → 重新拉该项目分配清单（联动第二步） */
  useEffect(() => {
    if (!open || cmcLineId === null) { setProjects([]); setProgramNumber(''); return; }
    let alive = true;
    setLoadingProjects(true);
    (async () => {
      try {
        const ps = await api.cmc.lineProjects(cmcLineId);
        if (!alive) return;
        setProjects(ps);
        setProgramNumber('');
      } catch (err) {
        if (alive) setError(cmcErrorHint(err));
      } finally {
        if (alive) setLoadingProjects(false);
      }
    })();
    return () => { alive = false; };
  }, [open, cmcLineId]);

  /* 工位编码建议：跟随 CMC 产线码——只作占位提示（灰字），不再预填进输入框（v3.23） */
  const suggestedCode = useMemo(
    () => (selectedLine ? nextStationCode(stations, selectedLine.code) : ''),
    [selectedLine, stations],
  );

  /* 选中项目带标准节拍且用户没手填过 TT → 预填（可改） */
  useEffect(() => {
    if (ttEdited) return;
    const ct = selectedProject?.ct_standard;
    setStation((s) => ({ ...s, tt: ct !== null && ct !== undefined ? String(ct) : s.tt }));
  }, [selectedProject, ttEdited]);

  const validate = (): string | null => {
    if (factoryId === null) return '请选择工厂（来自产能系统）';
    if (cmcLineId === null) return '请选择产线（来自产能系统）';
    if (selectedLine && selectedLine.project_count === 0 && !programNumber) {
      /* 允许建，但明确告知 */
    }
    if (!station.name.trim()) return '请填写工位名称';
    /* 编码留空合法：提交后由后端按 CMC 产线码自动生成 */
    if (station.tt !== '' && (Number.isNaN(Number(station.tt)) || Number(station.tt) < 0)) return 'TT 须为非负数字';
    return null;
  };

  const submit = async () => {
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try {
      /* v3.42 编辑模式：仅 PATCH 名称/TT（编码是全链引用键、产线来自 CMC 均不可改） */
      if (editStation) {
        const patched = await api.updateStation(editStation.station_id, {
          name: station.name.trim(),
          tt: station.tt === '' ? undefined : Number(station.tt),
        });
        onCreated(patched, patched.line_id);
        return;
      }
      const created = await api.createStationFromCmc({
        cmc_line_id: cmcLineId!,
        station_id: codeInput.trim() || undefined,
        program_number: programNumber || undefined,
        name: station.name.trim(),
        tt: station.tt === '' ? undefined : Number(station.tt),
      });
      onCreated(created, created.line_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const stepDone = {
    factory: editStation ? true : factoryId !== null,
    line: editStation ? true : cmcLineId !== null,
    station: Boolean(station.name.trim()),
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wz" onClick={(e) => e.stopPropagation()}>
        <div className="wz-head">
          <div>
            <h3>{editStation ? `编辑工位 · ${editStation.station_id}` : '新建分析对象'}</h3>
            <p className="muted">{editStation
              ? '仅工位名称与 TT 可修改；工位编码是全部链路的引用键、产线与项目来自产能系统，均不可改。'
              : '公司/产线/项目实时取自产能系统（CMC），本地零维护。您只需填写工位名称。'}</p>
          </div>
          <button className="wz-x" onClick={onClose} aria-label="关闭">×</button>
        </div>

        {editStation ? (
          <div className="wz-body">
            <section className="wz-sec">
              <div className="wz-sec-head"><span className="wz-n">1</span>工位<span className="wz-tag muted">名称与节拍</span></div>
              <div className="wz-grid">
                <label className="wz-field"><span>工位编码（不可改）</span>
                  <input value={codeInput} disabled />
                </label>
                <label className="wz-field"><span>工位名称</span>
                  <input value={station.name} onChange={(e) => setStation({ ...station, name: e.target.value })} autoFocus />
                </label>
                <label className="wz-field"><span>TT 标称节拍（秒，可选）</span>
                  <input type="number" min={0} value={station.tt}
                    onChange={(e) => setStation({ ...station, tt: e.target.value })} />
                </label>
              </div>
            </section>
            {error && <div className="error-banner" style={{ margin: 0 }}>{error}</div>}
          </div>
        ) : loading ? <div className="wz-loading">连接产能系统，加载基础数据…</div> : (
          <div className="wz-body">
            {/* ① 工厂（CMC factories） */}
            <section className="wz-sec">
              <div className="wz-sec-head"><span className="wz-n">1</span>工厂<span className="wz-tag">CMC 实时</span></div>
              <div className="wz-inline">
                <SelectMenu
                  ariaLabel="选择工厂"
                  value={factoryId === null ? '' : String(factoryId)}
                  options={factories.map((f): SelectOption => ({
                    value: String(f.cmc_factory_id),
                    label: `${f.name}（${f.code}）`,
                    hint: f.region ?? undefined,
                  }))}
                  onChange={(v) => setFactoryId(Number(v))}
                />
              </div>
            </section>

            {/* ② 产线（CMC production_lines，按工厂过滤） */}
            <section className="wz-sec">
              <div className="wz-sec-head"><span className="wz-n">2</span>产线<span className="wz-tag">CMC 实时</span></div>
              <div className="wz-inline">
                <SelectMenu
                  ariaLabel="选择产线"
                  value={cmcLineId === null ? '' : String(cmcLineId)}
                  disabled={lines.length === 0}
                  placeholder={lines.length === 0 ? '该工厂暂无产线' : '请选择产线'}
                  options={lines.map((l): SelectOption => ({
                    value: String(l.cmc_line_id),
                    label: `${l.name}（${l.code}）`,
                    hint: `${l.process_type}${l.project_count > 0 ? ` · ${l.project_count} 项目` : ' · 未分配项目'}`,
                  }))}
                  onChange={(v) => setCmcLineId(Number(v))}
                />
                {selectedLine && (
                  <span className="wz-hint">
                    {selectedLine.factory_name} · {selectedLine.process_type}
                    {selectedLine.line_type ? ` · ${selectedLine.line_type}` : ''}
                    {selectedLine.project_count === 0 ? ' · 该产线暂无项目分配（工位仍可建）' : ''}
                  </span>
                )}
              </div>
            </section>

            {/* ③ 项目（CMC project_line_allocations × cbco_records） */}
            <section className="wz-sec">
              <div className="wz-sec-head"><span className="wz-n">3</span>项目
                <span className="wz-tag muted">决定驾驶舱的"产品项目"分组</span>
              </div>
              <div className="wz-inline">
                <SelectMenu
                  ariaLabel="选择项目"
                  value={programNumber}
                  disabled={loadingProjects || cmcLineId === null}
                  placeholder={loadingProjects ? '加载项目…' : (projects.length === 0 ? '该产线未分配项目' : '请选择项目（可留空）')}
                  options={[
                    { value: '', label: '未关联项目' },
                    ...projects.map((p): SelectOption => ({
                      value: p.program_number,
                      label: `${p.program_number} · ${p.name}`,
                      hint: [p.phase, p.customer].filter(Boolean).join(' · ') || undefined,
                    })),
                  ]}
                  onChange={(v) => setProgramNumber(v)}
                />
                {selectedProject && selectedProject.ct_standard !== null && selectedProject.ct_standard !== undefined && (
                  <span className="wz-hint">标准节拍 CT = {selectedProject.ct_standard}s{selectedProject.allocation_ratio !== null ? ` · 分配比例 ${selectedProject.allocation_ratio}%` : ''}（已预填到 TT）</span>
                )}
              </div>
            </section>

            {/* ④ 工位（本地唯一录入项） */}
            <section className="wz-sec">
              <div className="wz-sec-head"><span className="wz-n">4</span>工位<span className="wz-tag muted">唯一需要您填写的部分</span></div>
              <div className="wz-grid">
                <label className="wz-field"><span>工位编码（留空自动生成）</span>
                  <input value={codeInput}
                    placeholder={suggestedCode ? `由您命名，如现场习称；留空则生成 ${suggestedCode}` : '由您命名，如现场习称（如 PA10）'}
                    onChange={(e) => setCodeInput(e.target.value)}
                    title="工位编码由您自己填写（如现场习称 PA10）；留空提交则按 CMC 产线码 + 序号自动生成（如 BJFA1-ST03）" />
                </label>
                <label className="wz-field"><span>工位名称</span>
                  <input value={station.name} onChange={(e) => setStation({ ...station, name: e.target.value })} placeholder="如：上壳装配" autoFocus />
                </label>
                <label className="wz-field"><span>TT 标称节拍（秒，可选）</span>
                  <input type="number" min={0} value={station.tt}
                    onChange={(e) => { setTtEdited(true); setStation({ ...station, tt: e.target.value }); }}
                    placeholder="选中项目后自动带出标准节拍，可修正" />
                </label>
              </div>
            </section>

            {error && <div className="error-banner" style={{ margin: 0 }}>{error}</div>}
          </div>
        )}

        <div className="wz-foot">
          <span className="wz-summary muted">
            {editStation ? `${editStation.line_id} › ${station.name || editStation.name}`
              : `${company} › ${selectedLine ? `${selectedLine.name}（${selectedLine.code}）` : '—'} › ${station.name || '新工位'}`}
          </span>
          <div className="row">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy || !stepDone.factory || !stepDone.line || !stepDone.station} onClick={() => void submit()}>
              {busy ? (editStation ? '保存中…' : '创建中…') : (editStation ? '保存修改' : '创建并打开分解')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** CMC 连接失败的统一话术（后端 503 语义 400 时更友好） */
function cmcErrorHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|ETIMEDOUT|ECONNREFUSED|不存在|无法|数据库/i.test(msg)) {
    return `产能系统（CMC）暂不可联：${msg}。请稍后重试；系统不会在本地伪造基础数据。`;
  }
  return msg;
}
