import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, ApiError,
  type BatchExportRecord, type DecompositionTask, type LineAnalysis, type Station, type TaskDetail,
} from '../api';
import { useAuth } from '../auth';
import SelectMenu from './SelectMenu';
import { getLastTaskScope, setCurrentTaskId } from '../taskContext';

interface Props {
  open: boolean;
  /** 当前选中产线（任务下拉的筛选器，不再是独立导出范围） */
  lineId: string;
  /** 当前账号可见的工位集合（外壳持有，已过权限） */
  stations: Station[];
  /** 线分析：提供要素数 / CT / 版本，异步未就绪时用 station 自身字段兜底 */
  lineAnalysis: LineAnalysis | null;
  onClose: () => void;
  /** 下载完成后的顶部提示文案（由后端 X-Export-Stats 统计头生成） */
  onDone: (msg: string) => void;
}

const ROUND_OPTIONS = [
  { value: 'baseline', label: '基线测时 baseline' },
  { value: 'kaizen_after', label: '改善后复测 kaizen_after' },
  { value: 'recheck', label: '年度复核 recheck' },
  { value: 'other', label: '其他 other' },
];

/**
 * 批量导出弹窗（v3.61 MVP → v3.62 留档 → Phase 2 分解任务）。
 * 单页四区：范围（产线+任务）→ 工位多选 → 内容开关 → 留档历史，无向导、不新增路由。
 * 下拉一律用自绘 SelectMenu（项目铁律：禁止原生 <select>）。
 * 一个工作簿 = 一个分解任务；任务锁定 bol_version，工位按任务内 seq_no 排序。
 * 任务列表为空时回落「按产线兼容模式」，封面与文件如实标注，不冒充任务号。
 */
export default function BatchExportDialog({ open, lineId, stations, lineAnalysis, onClose, onDone }: Props) {
  const { can } = useAuth();
  const canFocus = can('analysis:read');
  const canWriteTask = can('element:write');

  const [tasks, setTasks] = useState<DecompositionTask[] | null>(null);
  const [taskId, setTaskId] = useState('');
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskErr, setTaskErr] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');
  const [newRound, setNewRound] = useState('baseline');
  const [newBaseline, setNewBaseline] = useState('');
  const [cloneFrom, setCloneFrom] = useState(true);
  const [createBusy, setCreateBusy] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusTop, setFocusTop] = useState('30');
  const [withFocus, setWithFocus] = useState(true);
  const [includeOutliers, setIncludeOutliers] = useState(false);
  const [includeUndecomposed, setIncludeUndecomposed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<BatchExportRecord[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [dlBusy, setDlBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const initedFor = useRef('');

  const lineStations = useMemo(
    () => stations.filter((s) => s.line_id === lineId)
      .sort((a, b) => a.station_id.localeCompare(b.station_id)),
    [stations, lineId],
  );
  /** 任务模式：工位清单 = 可见工位 ∩ 任务关联工位，按任务 seq_no 排序（与服务端导出一致） */
  const scopedStations = useMemo(() => {
    if (!taskDetail) return lineStations;
    const seq = new Map(taskDetail.stations.map((l) => [l.station_id, l.seq_no]));
    return lineStations.filter((s) => seq.has(s.station_id))
      .sort((a, b) => (seq.get(a.station_id) ?? 0) - (seq.get(b.station_id) ?? 0)
        || a.station_id.localeCompare(b.station_id));
  }, [lineStations, taskDetail]);

  const rowMap = useMemo(() => {
    const m = new Map<string, { count: number; ct: number; version: number }>();
    for (const r of lineAnalysis?.rows ?? []) {
      m.set(r.station_id, { count: r.element_count, ct: r.ct_s, version: r.version });
    }
    return m;
  }, [lineAnalysis]);

  const statOf = (s: Station) => rowMap.get(s.station_id) ?? {
    count: 0, ct: Number(s.ct ?? 0), version: s.version,
  };

  /* ── 任务列表：打开 / 切产线 / 新建成功后刷新，默认选中最近一条 ── */
  const loadTasks = async (preferId?: string) => {
    setTaskErr(null);
    try {
      const res = await api.listTasks({ line_id: lineId, limit: 50 });
      setTasks(res.items);
      const keep = preferId ?? taskId;
      const next = res.items.some((t) => t.task_id === keep)
        ? keep
        : (res.items[0]?.task_id ?? '');
      setTaskId(next);
      return next;
    } catch (err) {
      setTaskErr(err instanceof ApiError ? err.message : (err as Error).message);
      setTasks([]);
      return '';
    }
  };

  useEffect(() => {
    if (!open) { initedFor.current = ''; return; }
    void loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lineId]);

  /* 任务切换：拉详情（工位集合 + 锁定版本）；失败不阻断兼容模式 */
  useEffect(() => {
    if (!open || !taskId) { setTaskDetail(null); return; }
    let alive = true;
    void api.taskDetail(taskId)
      .then((d) => { if (alive) setTaskDetail(d); })
      .catch((err: Error) => { if (alive) { setTaskErr(err.message); setTaskDetail(null); } });
    return () => { alive = false; };
  }, [open, taskId]);

  /* 打开 / 切产线 / 切任务时默认全选该范围内工位；后端仍按可见性与开关二次过滤 */
  useEffect(() => {
    if (!open) { initedFor.current = ''; return; }
    const key = `${lineId}|${taskId}|${scopedStations.map((s) => s.station_id).join(',')}`;
    if (initedFor.current === key) return;
    initedFor.current = key;
    setSelected(new Set(scopedStations.map((s) => s.station_id)));
    setError(null);
  }, [open, lineId, taskId, scopedStations]);

  useEffect(() => {
    if (!canFocus) setWithFocus(false);
  }, [canFocus]);

  /* v3.62 留档历史：打开弹窗即拉取（失败不阻断导出主流程） */
  const loadHistory = async () => {
    setHistErr(null);
    try {
      const res = await api.listBatchExportRecords(10);
      setRecords(res.items);
    } catch (err) {
      setHistErr(err instanceof ApiError ? err.message : (err as Error).message);
      setRecords([]);
    }
  };

  useEffect(() => {
    if (open) void loadHistory();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const reDownload = async (r: BatchExportRecord) => {
    if (dlBusy) return;
    setDlBusy(r.record_id); setHistErr(null);
    try {
      const d = new Date(r.created_at);
      const z = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
      const safe = (r.task_no || r.line_name || r.line_id).replace(/[^A-Za-z0-9_-]/g, '_');
      await api.downloadBatchExportRecord(r.record_id, `VA分析_复下载_${safe}_${stamp}.xlsx`);
      void loadHistory(); // 刷新下载计数
    } catch (err) {
      setHistErr(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setDlBusy(null);
    }
  };

  /* 新建任务：可选从基线任务复制要素快照，使新任务立即可导出且与基线互不串 */
  const handleCreateTask = async () => {
    if (!newName.trim() || createBusy) return;
    setCreateBusy(true); setTaskErr(null);
    try {
      const created = await api.createTask({
        line_id: lineId,
        name: newName.trim(),
        period_start: newStart || undefined,
        period_end: newEnd || undefined,
        round_type: newRound,
        baseline_task_id: newBaseline || undefined,
        station_ids: scopedStations.map((s) => s.station_id),
      });
      if (cloneFrom && newBaseline) {
        await api.cloneTaskElements(created.task_id, newBaseline);
      }
      setShowCreate(false);
      setNewName(''); setNewStart(''); setNewEnd(''); setNewBaseline('');
      await loadTasks(created.task_id);
      setCurrentTaskId(created.task_id);
    } catch (err) {
      setTaskErr(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  /* 关闭时中断在途请求（AbortController），避免后台继续生成大文件 */
  const close = () => { abortRef.current?.abort(); abortRef.current = null; onClose(); };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(scopedStations.map((s) => s.station_id)));
  const selectNone = () => setSelected(new Set());
  const selectDecomposed = () => setSelected(new Set(
    scopedStations.filter((s) => statOf(s).count > 0 || Number(s.ct ?? 0) > 0).map((s) => s.station_id),
  ));

  const sheetCount = withFocus && canFocus ? 6 : 5;
  const estimatedRows = 1 + scopedStations
    .filter((s) => selected.has(s.station_id))
    .reduce((acc, s) => acc + Math.max(1, statOf(s).count) * 2, 0)
    + (withFocus && canFocus ? Number(focusTop) : 0);
  const activeTask = tasks?.find((t) => t.task_id === taskId) ?? null;

  const handleExport = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true); setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const stats = await api.exportBatchXlsx({
        line_id: lineId,
        task_id: taskId || null,
        stations: [...selected],
        focus_top: Number(focusTop),
        include_outliers: includeOutliers,
        include_undecomposed: includeUndecomposed,
        with_focus: withFocus && canFocus,
      }, ctrl.signal);
      let msg = `已导出 ${activeTask?.task_no ?? `产线 ${lineId}`} 的动作分解与增值分析（${sheetCount} 张 sheet）`;
      if (stats) {
        try {
          const s = JSON.parse(stats) as { stations: number; elements: number; focus: number; sheets: number };
          msg = `已导出 ${s.sheets} 张 sheet · ${s.stations} 个工位 · ${s.elements} 条有效要素 · ${s.focus} 条焦点要素`;
        } catch { /* 统计头解析失败不影响下载成功 */ }
      }
      onDone(msg);
      onClose();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof ApiError ? err.message : (err as Error).message);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  if (!open) return null;

  const taskOptions = [
    { value: '', label: '（按产线兼容模式 · 不区分任务）' },
    ...(tasks ?? []).map((t) => ({
      value: t.task_id,
      label: `${t.task_no} · ${t.name} · ${t.period_start || '?'}~${t.period_end || '?'}${t.is_legacy ? ' · 历史归集' : ''}`,
    })),
  ];
  const baselineOptions = [
    { value: '', label: '（不设基线）' },
    ...(tasks ?? []).map((t) => ({ value: t.task_id, label: `${t.task_no} · ${t.name}` })),
  ];

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal be-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="be-head">
          <div>
            <h3 className="be-title">批量导出 · 动作分解与增值分析</h3>
            <div className="be-sub">
              产线 {lineId} · 固定 {sheetCount} 张 sheet（封面 / 工位汇总 / 动作分解 / 增值非增值分析
              {withFocus && canFocus ? ' / 动作分析' : ''} / 说明）· 仅供评审打印，不可回导
            </div>
          </div>
          <button className="be-x" onClick={close} aria-label="关闭" title="关闭">×</button>
        </div>

        <div className="be-body">
          <div className="be-sec">
            <div className="be-sec-head"><span className="be-sec-n">1</span><span className="be-sec-title">导出范围</span>
              <span className="muted">产线 → 分解任务 → 工位</span>
              <div className="spacer" />
              {canWriteTask && (
                <button className="btn ghost sm" onClick={() => setShowCreate((v) => !v)} disabled={busy || createBusy}>
                  {showCreate ? '收起新建' : '新建分解任务'}
                </button>
              )}
            </div>
            <div className="be-task-pick">
              <span className="be-task-label">分解任务</span>
              <SelectMenu ariaLabel="分解任务" value={taskId}
                onChange={(v) => { setTaskId(v); setCurrentTaskId(v || null); }}
                disabled={busy || createBusy} triggerStyle={{ width: 380 }}
                options={taskOptions} />
              {activeTask && (
                <span className="be-task-info mono">
                  {activeTask.round_type} · {activeTask.period_start || '—'}~{activeTask.period_end || '—'}
                   · {activeTask.status} · 锁定 {activeTask.station_count} 工位
                </span>
              )}
            </div>
            <div className="be-meta">
              一个工作簿 = 一个分解任务，只导出该任务锁定的要素版本（不随后续修订漂移）；
              归档 / 历史归集任务仍可导出。仅导出你可见的工位，聚合指标在过滤后计算。
              {!taskId && <b> 当前为按产线兼容模式：不区分任务，不同轮次要素可能混合，建议选定任务后再导出。</b>}
              {!taskId && getLastTaskScope()?.fallback && (
                <span className="be-task-info"> 服务端最近一次请求已按 {getLastTaskScope()!.source} 回落历史归集任务（legacy-fallback）。</span>
              )}
            </div>
            {taskErr && <div className="be-err" role="alert">{taskErr}</div>}

            {showCreate && canWriteTask && (
              <div className="be-create">
                <div className="be-create-grid">
                  <label className="be-field"><span>任务名称</span>
                    <input className="be-input" value={newName} maxLength={64} placeholder="如：2026 Q4 线平衡改善"
                      onChange={(e) => setNewName(e.target.value)} /></label>
                  <label className="be-field"><span>轮次</span>
                    <SelectMenu ariaLabel="轮次" value={newRound} onChange={setNewRound} options={ROUND_OPTIONS} /></label>
                  <label className="be-field"><span>开始日期</span>
                    <input className="be-input" type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} /></label>
                  <label className="be-field"><span>结束日期</span>
                    <input className="be-input" type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} /></label>
                  <label className="be-field"><span>基线任务</span>
                    <SelectMenu ariaLabel="基线任务" value={newBaseline} onChange={setNewBaseline} options={baselineOptions} /></label>
                  <label className="be-field be-field-check"><input className="be-check" type="checkbox" checked={cloneFrom}
                    disabled={!newBaseline} onChange={(e) => setCloneFrom(e.target.checked)} />
                    <span>从基线复制要素作为新任务起点</span></label>
                </div>
                <div className="be-create-foot">
                  <span className="muted">任务号由服务端生成 DT-{'{YYYY}-{NNN}'}，租户内唯一不可变；复制要素只新增不修改基线。</span>
                  <div className="spacer" />
                  <button className="btn primary sm" onClick={() => void handleCreateTask()}
                    disabled={!newName.trim() || createBusy}>{createBusy ? '创建中…' : '创建并选中'}</button>
                </div>
              </div>
            )}
          </div>

          <div className="be-sec">
            <div className="be-sec-head"><span className="be-sec-n">2</span><span className="be-sec-title">工位</span>
              <span className="muted">已选 {selected.size} / {scopedStations.length}</span>
              <div className="spacer" />
              <div className="be-tools">
                <button className="btn ghost sm" onClick={selectAll} disabled={busy}>全选</button>
                <button className="btn ghost sm" onClick={selectDecomposed} disabled={busy}>仅已分解</button>
                <button className="btn ghost sm" onClick={selectNone} disabled={busy}>反选</button>
              </div>
            </div>
            <div className="be-list">
              {scopedStations.length === 0 && <div className="be-empty">该范围内暂无可见工位。</div>}
              {scopedStations.map((s) => {
                const st = statOf(s);
                const on = selected.has(s.station_id);
                const locked = taskDetail?.stations.find((l) => l.station_id === s.station_id)?.bol_version;
                return (
                  <label key={s.station_id} className={`be-row${on ? '' : ' be-row-off'}`}>
                    <input className="be-check" type="checkbox" checked={on} disabled={busy}
                      onChange={() => toggle(s.station_id)} />
                    <span className="be-row-code mono">{s.station_id}</span>
                    <span className="be-row-name">{s.name}</span>
                    <span className="be-row-stats">
                      {locked !== undefined ? `锁定 v${locked}` : `v${st.version}`} · {st.count > 0 ? `${st.count} 要素` : '未分解'} · CT {st.ct.toFixed(1)}s
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="be-sec">
            <div className="be-sec-head"><span className="be-sec-n">3</span><span className="be-sec-title">内容</span></div>
            <div className="be-opts">
              <label className="be-opt"><input className="be-check" type="checkbox" checked disabled />封面 / 工位汇总 / 字段说明（固定）</label>
              <label className={`be-opt${canFocus ? '' : ' be-opt-off'}`} title={canFocus ? '' : '当前账号无 analysis:read 权限，04 表不生成'}>
                <input className="be-check" type="checkbox" checked={withFocus && canFocus} disabled={busy || !canFocus}
                  onChange={(e) => setWithFocus(e.target.checked)} />04_动作分析 · 焦点表
              </label>
              <label className="be-opt"><input className="be-check" type="checkbox" checked={includeOutliers} disabled={busy}
                onChange={(e) => setIncludeOutliers(e.target.checked)} />含异常要素（标灰、不计入合计）</label>
              <label className="be-opt"><input className="be-check" type="checkbox" checked={includeUndecomposed} disabled={busy}
                onChange={(e) => setIncludeUndecomposed(e.target.checked)} />含未分解工位</label>
              <div className="be-opt be-top">
                <span>全任务焦点上限</span>
                <SelectMenu ariaLabel="全任务焦点上限" value={focusTop} onChange={setFocusTop}
                  disabled={busy || !withFocus || !canFocus} triggerStyle={{ width: 96 }}
                  options={[{ value: '20', label: 'Top 20' }, { value: '30', label: 'Top 30' }, { value: '50', label: 'Top 50' }]} />
              </div>
            </div>
            {!canFocus && <div className="be-hint">当前账号无 analysis:read：04_动作分析 已置灰不生成；增值判定与四类时间仍照常导出。</div>}
            <div className="be-est">预计 {sheetCount} 个 sheet · 约 {estimatedRows.toLocaleString()} 行数据（含小计区）</div>
          </div>

          <div className="be-sec">
            <div className="be-sec-head"><span className="be-sec-n">4</span><span className="be-sec-title">留档历史</span>
              <span className="muted">最近 {records?.length ?? 0} 次导出</span>
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => void loadHistory()} disabled={busy || dlBusy !== null}>刷新</button>
            </div>
            <div className="be-hint">
              每次导出自动留档（谁 / 何时 / 任务 / 范围 / 规则版本）；复下载返回<b>当时生成的快照文件</b>，
              工位后续改版不影响已导出的历史。仅显示你自己的留档（管理员可见全部）。
            </div>
            {histErr && <div className="be-err" role="alert">{histErr}</div>}
            <div className="be-hist">
              {records === null && <div className="be-empty">正在读取留档…</div>}
              {records !== null && records.length === 0 && <div className="be-empty">暂无导出留档。</div>}
              {records?.map((r) => (
                <div key={r.record_id} className="be-hist-row">
                  <span className="be-hist-time mono">{new Date(r.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span className="be-hist-user">{r.username}</span>
                  <span className="be-hist-line">{r.task_no ? `${r.task_no} · ` : '按产线 · '}{r.line_name || r.line_id}</span>
                  <span className="be-hist-stats">
                    {r.station_count} 工位 · {r.element_count} 要素 · {r.sheet_count} sheet · {(r.file_size / 1024).toFixed(1)}KB
                  </span>
                  <button className="btn ghost sm" onClick={() => void reDownload(r)}
                    disabled={busy || dlBusy !== null || r.status !== 'ready'}
                    title={r.status === 'ready' ? `已复下载 ${r.download_count} 次` : '文件已被清理，无法复下载'}>
                    {dlBusy === r.record_id ? '下载中…' : '复下载'}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {busy && <div className="be-progress">正在读取工位 → 计算分析 → 生成文件，请稍候…</div>}
          {error && <div className="be-err" role="alert">{error}</div>}
        </div>

        <div className="be-foot">
          <span className="muted">四类时间由动作标准 time_bucket 判定；Σ四桶 = ΣST = CT 校验不通过时服务端不出表。</span>
          <div className="spacer" />
          <button className="btn sm" onClick={close}>{busy ? '取消导出' : '取消'}</button>
          <button className="btn primary sm" onClick={() => void handleExport()}
            disabled={busy || selected.size === 0}>{busy ? '生成中…' : '开始导出'}</button>
        </div>
      </div>
    </div>
  );
}
