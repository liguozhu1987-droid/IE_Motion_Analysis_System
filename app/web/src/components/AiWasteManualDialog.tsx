import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AiWasteFinding, type AiWasteIssue } from '../api';
import SelectMenu from './SelectMenu';

/**
 * v3.51 人工录入浪费点 / 改善措施（与 AI 生成并存）。
 *
 * 设计约束（继承模块铁律）：
 *  - 数字不手填：涉及时长/占比/严重度/预计节省/优先级/层级全部由服务端计算；
 *    est_save_s 允许人工填「经验值」但服务端 clamp 到 [0, CT]；
 *  - waste_type 只能选动态白名单（与 AI 校验同口径，避免统计口径分裂）；
 *  - 要素引用只能选当前版本真实存在的 seq（不存在的引用服务端裁剪，不报错）；
 *  - 只可编辑/删除 origin=manual 的条目；AI 产出条目不进本表单（服务端 409 兜底）。
 */

interface ElemOption { seq: number; type: string; desc: string }

export interface AiWasteManualDialogProps {
  stationId: string;
  kind: 'finding' | 'issue';
  /** 动态浪费白名单（来自 items.waste_types） */
  wasteTypes: string[];
  /** 编辑态：null = 新增 */
  editing: AiWasteFinding | AiWasteIssue | null;
  onClose: () => void;
  onSaved: () => void;
}

const ECRS_OPTIONS: { v: string; label: string }[] = [
  { v: 'E', label: 'E 取消（仅非增值动作）' },
  { v: 'C', label: 'C 合并' },
  { v: 'R', label: 'R 重排' },
  { v: 'S', label: 'S 简化' },
];

export default function AiWasteManualDialog(
  { stationId, kind, wasteTypes, editing, onClose, onSaved }: AiWasteManualDialogProps,
) {
  const [wt, setWt] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [ecrs, setEcrs] = useState('S');
  const [est, setEst] = useState('');
  const [route, setRoute] = useState<'finding' | 'pool'>('finding');
  const [seqs, setSeqs] = useState<number[]>([]);
  const [elems, setElems] = useState<ElemOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* 当前版本要素（供勾选引用）；非异常要素才有效——异常点不计入 CT 也不可引用（与 AI 线同口径） */
  useEffect(() => {
    let alive = true;
    api.elements(stationId)
      .then((r) => {
        if (!alive) return;
        setElems((r.elements ?? [])
          .filter((e) => Number(e.outlier_flag) === 0)
          .map((e) => ({ seq: Number(e.seq), type: String(e.type ?? ''), desc: String(e.desc ?? '') })));
      })
      .catch(() => { if (alive) setElems([]); });
    return () => { alive = false; };
  }, [stationId]);

  /* 编辑态回填 */
  useEffect(() => {
    if (!editing) return;
    setWt(editing.waste_type ?? '');
    setSeqs(editing.element_seqs ?? []);
    if (kind === 'finding') {
      setEvidence((editing as AiWasteFinding).evidence ?? '');
      setRoute((editing as AiWasteFinding).route ?? 'finding');
    }
    else {
      const it = editing as AiWasteIssue;
      setProblem(it.problem ?? '');
      setSuggestion(it.suggestion ?? '');
      setEcrs(it.ecrs ?? 'S');
      setEst('');
    }
  }, [editing, kind]);

  const minType = useMemo(() => (wt || wasteTypes[0] || ''), [wt, wasteTypes]);

  /** 前端预校验（与服务端同阈值，减少一次往返） */
  const invalid = useMemo(() => {
    if (!minType) return '缺少浪费类型';
    if (kind === 'finding') return evidence.trim().length < 6 ? '证据至少 6 个字' : null;
    if (problem.trim().length < 8) return '问题描述至少 8 个字';
    if (suggestion.trim().length < 8) return '改善建议至少 8 个字';
    return null;
  }, [kind, minType, evidence, problem, suggestion]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const payload: any = { waste_type: minType, element_seqs: seqs };
      if (kind === 'finding') {
        payload.evidence = evidence.trim();
        payload.route = route;
      }
      else {
        payload.problem = problem.trim();
        payload.suggestion = suggestion.trim();
        payload.ecrs = ecrs;
        if (est.trim() !== '') payload.est_save_s = Number(est);
      }
      if (editing) {
        const id = kind === 'finding'
          ? (editing as AiWasteFinding).finding_id
          : String((editing as AiWasteIssue).issue_id ?? '');
        if (kind === 'finding') await api.aiWaste.updateFinding(id, payload);
        else await api.aiWaste.updateIssue(id, payload);
      } else if (kind === 'finding') {
        await api.aiWaste.createFinding(stationId, payload);
      } else {
        await api.aiWaste.createIssue(stationId, payload);
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError && e.hint ? `${e.message}（${e.hint}）` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSeq = (seq: number) => {
    setSeqs((prev) => (prev.includes(seq) ? prev.filter((s) => s !== seq) : [...prev, seq].sort((a, b) => a - b)));
  };

  return (
    <div className="card aw-manual-form" style={{ marginBottom: 12, padding: 12 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>
          {editing ? '编辑' : '人工录入'}·{kind === 'finding' ? '浪费点' : '改善措施'}
        </b>
        <span className="tag t-gray">origin=manual</span>
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn primary sm" disabled={busy || invalid !== null} onClick={() => void submit()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {err && <div className="error-banner">{err}</div>}

      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <label className="wb-field" style={{ minWidth: 180 }}>
          <span>浪费类型</span>
          {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
          <SelectMenu ariaLabel="浪费类型"
            value={minType}
            onChange={(v) => setWt(v)}
            options={[...(wasteTypes.length === 0 ? [{ value: '', label: '（白名单加载中）' }] : []), ...wasteTypes.map((t) => ({ value: t, label: t }))]} />
        </label>
        {kind === 'finding' && (
          <label className="wb-field" style={{ minWidth: 200 }}>
            <span>路由</span>
            <SelectMenu ariaLabel="路由"
              value={route}
              onChange={(v) => setRoute(v as 'finding' | 'pool')}
              options={[
                { value: 'finding', label: 'finding · 确定性命中（计收益）' },
                { value: 'pool', label: 'pool · 待标定观察（进清单、收益待标定）' },
              ]} />
          </label>
        )}
        {kind === 'issue' && (
          <label className="wb-field" style={{ minWidth: 200 }}>
            <span>ECRS 方向</span>
            <SelectMenu ariaLabel="ECRS 方向"
              value={ecrs}
              onChange={(v) => setEcrs(v)}
              options={ECRS_OPTIONS.map((o) => ({ value: o.v, label: o.label }))} />
          </label>
        )}
        {kind === 'issue' && (
          <label className="wb-field" style={{ minWidth: 160 }}>
            <span>预计节省 s（选填）</span>
            <input type="number" min={0} step={0.01} value={est} placeholder="留空由服务端折算"
              onChange={(e) => setEst(e.target.value)} />
          </label>
        )}
      </div>

      {kind === 'finding' ? (
        <label className="wb-field" style={{ display: 'block', marginTop: 8 }}>
          <span>证据（≥6 字）</span>
          <textarea rows={2} value={evidence} placeholder="写明现场依据，如：物料架距操作区 3.2 米，每循环往返取料 2 次"
            onChange={(e) => setEvidence(e.target.value)} />
        </label>
      ) : (
        <>
          <label className="wb-field" style={{ display: 'block', marginTop: 8 }}>
            <span>问题描述（≥8 字）</span>
            <textarea rows={2} value={problem} placeholder="描述当前问题现象与影响"
              onChange={(e) => setProblem(e.target.value)} />
          </label>
          <label className="wb-field" style={{ display: 'block', marginTop: 8 }}>
            <span>改善建议（≥8 字）</span>
            <textarea rows={2} value={suggestion} placeholder="给出可落地的改善做法"
              onChange={(e) => setSuggestion(e.target.value)} />
          </label>
        </>
      )}

      <div style={{ marginTop: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          涉及要素（可不选——不选表示全局性浪费，涉及时长记 0）
        </span>
        <div className="aw-seq-box" style={{ maxHeight: 130, overflowY: 'auto', marginTop: 4 }}>
          {elems.length === 0 && <span className="muted" style={{ fontSize: 12 }}>当前版本暂无可引用要素</span>}
          {elems.map((e) => (
            <label key={e.seq} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '2px 0' }}>
              <input type="checkbox" checked={seqs.includes(e.seq)} onChange={() => toggleSeq(e.seq)} />
              <span className="mono">seq {e.seq}</span>
              <span>{e.type}</span>
              <span className="muted">{e.desc}</span>
            </label>
          ))}
        </div>
      </div>

      {invalid && <div className="muted" style={{ marginTop: 6, fontSize: 12, color: 'var(--red)' }}>{invalid}</div>}
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        涉及时长 / 占 CT / 严重度 / 预计节省 / 优先级 / 层级均由服务端计算，人工不填写数字（预计节省仅作经验值参考，服务端按 CT 收敛）。
      </div>
    </div>
  );
}
