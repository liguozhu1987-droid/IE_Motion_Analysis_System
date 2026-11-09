import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Improvement, type LineAnalysis, type Station } from '../api';
import { useAuth } from '../auth';
import CreateStationWizard from '../components/CreateStationWizard';
import ShareDialog from '../components/ShareDialog';
import SelectMenu from '../components/SelectMenu';

interface Props {
  /** 全量工位（App 持有，对象树与本页共用）；本页按 lineId 过滤 */
  stations: Station[];
  /** 当前选中的产线（由左侧对象树驱动） */
  lineId: string;
  /** 产线切换回调（供卡片空态/快捷入口使用） */
  onLineChange: (line: string) => void;
  /** 外壳（对象树/顶栏）请求打开新建向导的信号；每次递增触发 */
  createSignal?: number;
  /** 新建向导需要的工厂上下文 */
  company?: string;
  region?: string | null;
}

type ScopeTab = 'mine' | 'shared' | 'all';

/** 产线总览：受控组件——工位数据与选中产线来自外壳（对象树），本页只聚合线分析与建议 */
export default function StationListPage({ stations, lineId, onLineChange, createSignal = 0, company = '', region = null }: Props) {
  const { can, user } = useAuth();
  const [lineAnalysis, setLineAnalysis] = useState<LineAnalysis | null>(null);
  const [improvements, setImprovements] = useState<Improvement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* v3.42 个人工作台视角：我的 / 共享给我 / 全部（全部仅 admin 可见） */
  const isAdmin = user?.roles.includes('sys_admin') || user?.roles.includes('ie_admin') || false;
  const myId = user?.userId ?? '';
  const [scope, setScopeState] = useState<ScopeTab>('mine');
  /* user 异步到达（refresh 流程）：默认视角等身份就绪再校正；用户手动切过则不覆盖（v342 UI 实锤） */
  const scopeTouched = useRef(false);
  useEffect(() => {
    if (!user || scopeTouched.current) return;
    setScopeState(isAdmin ? 'all' : 'mine');
  }, [user, isAdmin]);
  const setScope = (s: ScopeTab) => { scopeTouched.current = true; setScopeState(s); };
  const [editTarget, setEditTarget] = useState<Station | null>(null);
  const [shareTarget, setShareTarget] = useState<Station | null>(null);
  const [showLineShare, setShowLineShare] = useState(false);

  const canWrite = can('station:write');
  const canImport = can('element:write');
  /* 建议清单需要 suggestion:generate（viewer 无此权限）——无权时整块不请求、不展示 */
  const canPlan = can('suggestion:generate');

  /** v3.42 归属判定：owner=我 → 我的；owner 非我但可见（协作者/整线授权）→ 共享给我 */
  const scopeStations = stations.filter((s) => {
    if (scope === 'all') return true;
    const mine = s.owner_user_id === myId;
    return scope === 'mine' ? mine : !mine;
  });

  /** 同名工位检测（视角内）：重名才显示 @拥有人 徽标消歧 */
  const nameCount = new Map<string, number>();
  for (const s of scopeStations) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
  const [deleteTarget, setDeleteTarget] = useState<Station | null>(null);
  const confirmDelete = async (s: Station) => {
    setDeleteTarget(null);
    setBusy(true); setError(null);
    try {
      const r = await api.deleteStation(s.station_id);
      setMsg(`已删除工位 ${s.name}（${s.station_id}）· 级联删除要素 ${r.cascaded.elements} 条、改善 ${r.cascaded.improvements} 条`);
      window.dispatchEvent(new CustomEvent('stations:changed'));
      await load(lineId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  };

  /** 线级数据：线分析 + 该线建议清单；工位集合由 props 提供，不再自拉 */
  const load = useCallback(async (target: string) => {
    if (!target) { setLineAnalysis(null); setImprovements([]); return; }
    const [lineRes, impRes] = await Promise.all([
      api.lineAnalysis(target).catch(() => null),
      canPlan ? api.improvements({ line_id: target }).catch(() => ({ improvements: [] as Improvement[] })) : Promise.resolve({ improvements: [] as Improvement[] }),
    ]);
    setLineAnalysis(lineRes);
    setImprovements(impRes.improvements);
  }, [canPlan]);

  useEffect(() => { load(lineId).catch((err) => setError(err.message)); }, [lineId, load]);

  /* 对象树/顶栏请求新建（信号驱动，避免切页瞬间事件丢失） */
  useEffect(() => {
    if (createSignal > 0) setShowCreate(true);
  }, [createSignal]);

  /** 产线下拉切换时若当前线不在视角内，自动落到第一条可用线（避免假空态） */
  useEffect(() => {
    const inScope = stations.filter((s) => {
      if (scope === 'all') return true;
      const mine = s.owner_user_id === myId;
      return scope === 'mine' ? mine : !mine;
    });
    const scopeLines = [...new Set(inScope.map((s) => s.line_id))].sort();
    const lineOk = scopeLines.includes(lineId);
    if (!lineOk && scopeLines.length > 0) onLineChange(scopeLines[0]);
  }, [scope, lineId, stations]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 建号/导入成功后广播，外壳与对象树据此刷新工位集合 */
  const emitStationsChanged = () => window.dispatchEvent(new CustomEvent('stations:changed'));

  /** 向导创建/编辑成功：切到目标产线、刷新、定位并高亮新工位 */
  const onWizardDone = async (saved: Station, targetLine: string, wasEdit: boolean) => {
    setShowCreate(false);
    setEditTarget(null);
    setError(null);
    setMsg(wasEdit ? `已保存修改：${saved.name}（${saved.station_id}）` : `已创建 ${saved.name}（${saved.station_id}）· 产线 ${targetLine}`);
    setHighlightId(saved.station_id);
    if (targetLine !== lineId) onLineChange(targetLine);
    emitStationsChanged();
    await load(targetLine);
    setTimeout(() => highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
  };

  const onPickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !importTarget) return;
    const reader = new FileReader();
    reader.onload = async () => {
      setBusy(true); setError(null);
      try {
        const res = await api.importCsv(importTarget, String(reader.result ?? ''));
        setMsg(`导入成功：${res.element_count} 个要素，CT=${res.ct}s`);
        emitStationsChanged();
        await load(lineId);
      } catch (err) {
        if (err instanceof ApiError && (err.errors?.length ?? 0) > 0) {
          setError(`${err.message}：${err.errors!.map((e) => `[${e.code}] ${e.message}`).join('；')}`);
        } else setError((err as Error).message);
      } finally {
        setBusy(false);
        setImportTarget(null);
        if (fileRef.current) fileRef.current.value = '';
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const lineStations = scopeStations.filter((s) => s.line_id === lineId);
  const lines = [...new Set(scopeStations.map((s) => s.line_id))].sort();
  const rowOf = (id: string) => lineAnalysis?.rows.find((r) => r.station_id === id);
  const statusOf = (s: Station): { label: string; cls: string } => {
    const count = rowOf(s.station_id)?.element_count ?? 0;
    if (count === 0) return { label: '未分解', cls: 't-gray' };
    if (s.version > 1) return { label: '已复测', cls: 't-teal' };
    return { label: '已分解', cls: 't-blue' };
  };

  const pending = improvements.filter((i) => i.status === '待实施').length;
  const verified = improvements.filter((i) => i.status === '已验证').length;
  const avgVa = lineAnalysis && lineAnalysis.rows.length > 0
    ? Math.round(lineAnalysis.rows.reduce((a, r) => a + r.va_pct, 0) / lineAnalysis.rows.length)
    : 0;

  /* v3.3 产线维度标签（线分析 enrich；跨公司线无记录时降级为空） */
  const dimTags: string[] = [];
  if (lineAnalysis?.process_type) dimTags.push(`工艺 ${lineAnalysis.process_type}`);
  if (lineAnalysis?.product_type) dimTags.push(`产品 ${lineAnalysis.product_type}`);
  if (lineAnalysis?.product_project && lineAnalysis.product_project !== '-') dimTags.push(`项目 ${lineAnalysis.product_project}`);
  if (lineAnalysis?.company) dimTags.push(`${lineAnalysis.company}${lineAnalysis.region ? ` · ${lineAnalysis.region}` : ''}`);

  return (
    <div>
      <div className="page-head">
        <h1>{scope === 'shared' ? '共享给我' : scope === 'mine' ? '我的工作台' : '产线总览'}</h1>
        <span className="sub">
          {lineAnalysis?.line_name ?? lineId ?? '未选择产线'} · {lineStations.length} 个工位 · 选工位进分解 / 分析 / 对比
        </span>
        <div className="spacer" />
        {lines.length > 1 && (
          <SelectMenu ariaLabel="切换产线" value={lineId}
            triggerStyle={{ width: 160 }}
            onChange={(v) => onLineChange(v)}
            options={lines.map((line) => ({
              value: line,
              label: `${line}（${stations.filter((s) => s.line_id === line).length}工位）`,
            }))} />
        )}
        {canWrite && (
          <button className="btn sm" onClick={() => setShowLineShare(true)} title="把名下某产线的工位批量共享给同事">整线共享</button>
        )}
        {canWrite && <button className="btn primary" onClick={() => setShowCreate(true)}>+ 新建工位</button>}
      </div>

      {/* v3.42 个人工作台视角：我的 / 共享给我 / 全部（全部仅 admin 可见） */}
      <div className="row tight" style={{ marginBottom: 12 }}>
        <button className={`btn sm${scope === 'mine' ? ' primary' : ''}`} onClick={() => setScope('mine')}>
          我的（{stations.filter((s) => s.owner_user_id === myId).length}）
        </button>
        <button className={`btn sm${scope === 'shared' ? ' primary' : ''}`} onClick={() => setScope('shared')}>
          共享给我（{stations.filter((s) => s.owner_user_id && s.owner_user_id !== myId).length}）
        </button>
        {isAdmin && (
          <button className={`btn sm${scope === 'all' ? ' primary' : ''}`} onClick={() => setScope('all')}>
            全部（{stations.length}）
          </button>
        )}
      </div>

      {dimTags.length > 0 && (
        <div className="row tight" style={{ marginBottom: 12 }}>
          {dimTags.map((t) => <span key={t} className="tag t-gray">{t}</span>)}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}
      {busy && <div className="muted" style={{ marginBottom: 8 }}>处理中…</div>}

      {/* v3.42 删除确认：级联影响清单 + 二次确认（破坏性最强操作） */}
      {deleteTarget && (
        <div className="modal-mask" onClick={() => setDeleteTarget(null)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>确认删除工位？</h3>
            <p>
              即将删除 <b>{deleteTarget.name}</b>（{deleteTarget.station_id}）。
              该操作不可恢复，将一并删除：
            </p>
            <ul style={{ margin: '8px 0 16px', paddingLeft: 20 }}>
              <li>全部版本的动作要素</li>
              <li>改善任务与 AI 建议 / 浪费识别记录</li>
              <li>协作者共享授权</li>
            </ul>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="btn danger" onClick={() => void confirmDelete(deleteTarget)}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {/* v3.42 共享弹窗（工位级 / 整线级） */}
      <ShareDialog
        open={shareTarget !== null || showLineShare}
        station={shareTarget}
        lines={lines}
        onClose={() => { setShareTarget(null); setShowLineShare(false); }}
        onChanged={() => emitStationsChanged()}
      />


      <div className="metrics" style={{ marginBottom: 14 }}>
        <div className="metric"><div className="v blue">{lineStations.length}</div><div className="l">工位总数</div></div>
        <div className="metric"><div className="v">{avgVa}%</div><div className="l">平均VA占比</div></div>
        {canPlan && <div className="metric"><div className="v amber">{pending}</div><div className="l">待实施建议</div></div>}
        {canPlan && <div className="metric"><div className="v teal">{verified}</div><div className="l">已验证建议</div></div>}
      </div>

      <div className="grid cards">
        {lineStations.map((station) => {
          const row = rowOf(station.station_id);
          const status = statusOf(station);
          const ct = row?.ct_s ?? (station.ct ?? 0);
          const tt = row?.tt_s ?? (station.tt ?? 0);
          return (
            <div
              className={`card${highlightId === station.station_id ? ' card-hi' : ''}`}
              key={station.station_id}
              ref={highlightId === station.station_id ? highlightRef : undefined}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>
                  {station.name}
                  {/* v3.42 同名徽标/共享来源消歧 */}
                  {station.owner_user_id && station.owner_user_id !== myId && (
                    <span className="tag t-gray" style={{ marginLeft: 8, fontWeight: 400 }} title="共享给我的工位">
                      @{station.owner_name ?? station.owner_user_id}
                    </span>
                  )}
                  {nameCount.get(station.name)! > 1 && station.owner_name && (
                    <span className="tag t-gray" style={{ marginLeft: 6, fontWeight: 400 }}>@{station.owner_name}</span>
                  )}
                </h3>
                <span className={`tag ${status.cls}`}>{status.label}</span>
              </div>
              <div className="muted mono" style={{ marginBottom: 8 }}>{station.station_id}</div>
              <div className="row" style={{ gap: 18, marginBottom: 10 }}>
                <div>
                  <div className="muted">CT / TT</div>
                  <div style={{ fontWeight: 700, color: ct > tt ? 'var(--red)' : 'var(--ink)' }}>
                    {ct}s / {tt}s
                  </div>
                </div>
                <div>
                  <div className="muted">VA占比</div>
                  <div style={{ fontWeight: 700 }}>{row?.va_pct ?? 0}%</div>
                </div>
                <div>
                  <div className="muted">版本</div>
                  <div style={{ fontWeight: 700 }}>v{station.version}</div>
                </div>
              </div>
              <div className="muted">
                要素 {row?.element_count ?? 0} 个 · 更新 {station.updated_at ? station.updated_at.slice(0, 16).replace('T', ' ') : '—'} · {station.updated_by ?? '—'}
              </div>
              <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <a className="btn primary sm" href={`#/workbench/${station.station_id}`}>分解工作台</a>
                <a className="btn sm" href={`#/analysis/${station.station_id}`}>分析</a>
                <a className="btn sm" href={`#/compare/${station.station_id}`}>对比</a>
                {canImport && (
                  <button className="btn ghost sm" onClick={() => { setImportTarget(station.station_id); fileRef.current?.click(); }}>导入CSV</button>
                )}
                <button className="btn ghost sm" onClick={() => void api.exportElementsCsv(station.station_id)}>导出</button>
                {/* v3.42 共享（仅 owner/admin）；编辑/删除（owner/admin，station:write 已由 canWrite 把门） */}
                {canWrite && (station.owner_user_id === myId || isAdmin) && (
                  <button className="btn ghost sm" onClick={() => setShareTarget(station)}>共享</button>
                )}
                {canWrite && (station.owner_user_id === myId || isAdmin) && (
                  <button className="btn ghost sm" onClick={() => setEditTarget(station)}>编辑</button>
                )}
                {canWrite && (station.owner_user_id === myId || isAdmin) && (
                  <button className="btn ghost sm danger" onClick={() => setDeleteTarget(station)}>删除</button>
                )}
              </div>
            </div>
          );
        })}
        {lineStations.length === 0 && (
          <div className="card empty">
            {lines.length === 0 ? (
              <>系统还没有任何工位。</>
            ) : can('group:read') && lineId && !lines.includes(lineId) ? (
              /* v3.3 跨公司下钻：集团驾驶舱点开的其他公司产线，明细受租户隔离 */
              <>
                <b>{lineId}</b> 在当前公司（当前账号所属租户）下没有工位数据。<br />
                若你是从「综合看板」点击进入，该产线可能属于其他公司——跨公司工位明细受租户隔离，
                集团视图只提供聚合指标（计数/均值/汇总）。<br />
                <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                  <a className="btn primary sm" href="#/dashboard">← 返回综合看板</a>
                  <button className="btn sm" onClick={() => onLineChange(lines[0])}>切换到本公司产线 {lines[0]}</button>
                </div>
              </>
            ) : (
              <>{lineId} 暂无工位。</>
            )}
            {lineStations.length === 0 && lines.includes(lineId) && canWrite && '点击右上角“+ 新建工位”创建第一个工位；'}
            {lineStations.length === 0 && lines.includes(lineId) && canImport && '或在工位卡片上“导入 CSV”批量载入既有分解数据。'}
          </div>
        )}
      </div>

      {lineStations.length > 0 && canPlan && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ margin: 0 }}>本线改善建议</h3>
              <p className="muted" style={{ margin: '2px 0 0' }}>
                三态流转：待实施 → 已完成 → 已验证（已验证要求已存在复测版本）
              </p>
            </div>
            <a className="btn sm" href="#/improvements">进入改善任务页 →</a>
          </div>
          <div className="row tight" style={{ margin: '10px 0' }}>
            <span className="tag t-amber">待实施 {pending}</span>
            <span className="tag t-blue">已完成 {improvements.filter((i) => i.status === '已完成').length}</span>
            <span className="tag t-teal">已验证 {verified}</span>
          </div>
          {improvements.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>暂无建议，先到工位「分析结果」页生成建议。</p>
          ) : (
            <table className="panel-table">
              <tbody>
                {improvements.slice(0, 3).map((imp) => (
                  <tr key={imp.imp_id}>
                    <td>{imp.measure.length > 36 ? imp.measure.slice(0, 36) + '…' : imp.measure}
                      <div className="muted mono">{imp.station_name ?? imp.station_id} · {imp.waste_type} · 节省 {imp.est_save_s}s</div></td>
                    <td className="num"><span className={`tag ${imp.status === '已验证' ? 't-teal' : imp.status === '已完成' ? 't-blue' : 't-amber'}`}>{imp.status}</span></td>
                  </tr>
                ))}
                {improvements.length > 3 && (
                  <tr><td className="muted" colSpan={2}>等 {improvements.length} 条（完整清单与状态流转见「改善任务」页）</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={onPickFile} />

      <CreateStationWizard
        open={showCreate || editTarget !== null}
        stations={stations}
        company={company}
        region={region}
        defaultLineId={lineId}
        editStation={editTarget}
        onClose={() => { setShowCreate(false); setEditTarget(null); }}
        onCreated={(created, targetLine) => { void onWizardDone(created, targetLine, Boolean(editTarget)); }}
      />
    </div>
  );
}
