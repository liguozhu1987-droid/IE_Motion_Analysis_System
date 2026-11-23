import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type DashboardFilters, type DashboardSummary, type Improvement } from '../api';
import { useAuth } from '../auth';
import FilterSelect from '../components/FilterSelect';

const STATUS_CLS: Record<string, string> = { 已验证: 't-teal', 已完成: 't-blue', 进行中: 't-blue', 待实施: 't-amber' };
const NEXT_STATUS: Record<string, string> = { 待实施: '进行中', 进行中: '已完成', 已完成: '已验证' };
const STATUS_OPTIONS = ['待实施', '进行中', '已完成', '已验证'];

/** 超期判定：与服务端口径一致（仅 待实施/进行中），并复用同一个 now 避免逐行 new Date */
function isOverdue(r: Improvement, now: number): boolean {
  if (!r.due || (r.status !== '待实施' && r.status !== '进行中')) return false;
  return new Date(r.due).getTime() < now;
}

/**
 * L4 改善任务清单（v3.3 → v3.66 P2：闭环管理）——新增编辑弹窗/进行中/超期高亮/实际措施
 *  - 有 group:read（sys_admin / ie_admin）：跨公司模式，走 /dashboard/improvements
 *  - 其他角色：租户内模式，走 /improvements
 */
export default function ImprovementsPage() {
  const { can } = useAuth();
  const groupMode = can('group:read');
  const canFlow = can('suggestion:status');

  const [filters, setFilters] = useState<DashboardFilters & { status?: string; line_id?: string }>({});
  const [rows, setRows] = useState<Improvement[]>([]);
  const [dim, setDim] = useState<DashboardSummary | null>(null);
  const [lineOptions, setLineOptions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /* v3.66 P2：编辑弹窗 */
  const [editRow, setEditRow] = useState<Improvement | null>(null);
  const [editOwner, setEditOwner] = useState('');
  const [editDue, setEditDue] = useState('');
  const [editActual, setEditActual] = useState('');
  const [editStatus, setEditStatus] = useState('');

  const openEdit = (r: Improvement) => {
    setEditRow(r);
    setEditOwner(r.owner ?? '');
    setEditDue((r.due ?? '').slice(0, 10));
    setEditActual(r.actual_measure ?? '');
    setEditStatus(r.status);
  };

  const saveEdit = async () => {
    if (!editRow) return;
    const ro = editRow;
    setBusyId(ro.imp_id); setError(null);
    try {
      await api.updateImprovement(ro.imp_id, {
        owner: editOwner,
        due: editDue,
        actual_measure: editActual,
        ...(editStatus !== ro.status ? { status: editStatus } : {}),
      });
      setMsg(`${ro.imp_id} 已更新`);
      await load();
      setEditRow(null);
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.message}${err.hint ? `（${err.hint}）` : ''}`);
      else setError((err as Error).message);
    } finally { setBusyId(null); }
  };

  /* 维度字典 */
  useEffect(() => {
    if (!groupMode) return;
    let alive = true;
    api.dashboard.summary().then((s) => { if (alive) setDim(s); }).catch(() => {});
    return () => { alive = false; };
  }, [groupMode]);

  useEffect(() => {
    if (groupMode) return;
    let alive = true;
    api.stations().then((ss) => { if (alive) setLineOptions([...new Set(ss.map((s) => s.line_id))].sort()); }).catch(() => {});
    return () => { alive = false; };
  }, [groupMode]);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (groupMode) {
        const res = await api.dashboard.improvements({
          region: filters.region, company: filters.company, process: filters.process,
          product_type: filters.product_type, project: filters.project, status: filters.status,
        });
        setRows(res.improvements);
      } else {
        const res = await api.improvements({
          line_id: filters.line_id, project_type: filters.project, status: filters.status,
        });
        setRows(res.improvements);
      }
    } catch (err) { setError((err as Error).message); setRows([]); }
  }, [groupMode, filters]);

  useEffect(() => { void load(); }, [load]);

  const patch = (p: Partial<DashboardFilters & { status?: string; line_id?: string }>) =>
    setFilters((prev) => ({ ...prev, ...p }));

  const flow = async (imp: Improvement) => {
    const next = NEXT_STATUS[imp.status];
    if (!next) return;
    setBusyId(imp.imp_id); setError(null); setMsg(null);
    try {
      await api.updateImprovementStatus(imp.imp_id, next);
      setMsg(`${imp.imp_id} 已标记为「${next}」`);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.message}${err.hint ? `（${err.hint}）` : ''}`);
      else setError((err as Error).message);
    } finally { setBusyId(null); }
  };

  const exportCsv = () => {
    const head = ['建议编号', '工位', '产线', '公司', '区域', '项目类型', '浪费类型', '措施', '实际措施', '预估节省(s)', '优先级', '状态', '责任人', '截止'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      `# 筛选条件: ${JSON.stringify(filters)}`,
      `# 导出行数: ${rows.length}  导出时间: ${new Date().toISOString()}`,
      head.join(','),
      ...rows.map((r) => [r.imp_id, r.station_name ?? r.station_id, r.line_name ?? r.line_id ?? '', r.company ?? '', r.region ?? '',
        r.project_type ?? '', r.waste_type, r.measure, r.actual_measure ?? '', r.est_save_s, r.priority, r.status, r.owner ?? '', r.due ?? ''].map(esc).join(',')),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `improvements-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    setMsg(`已导出 ${rows.length} 条任务`);
  };

  const activeCount = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);
  const { pending, prog, done, verified, overdueCount, now } = useMemo(() => {
    const now = Date.now();
    let pending = 0, prog = 0, done = 0, verified = 0, overdueCount = 0;
    for (const r of rows) {
      if (r.status === '待实施') pending++;
      else if (r.status === '进行中') prog++;
      else if (r.status === '已完成') done++;
      else if (r.status === '已验证') verified++;
      if (isOverdue(r, now)) overdueCount++;
    }
    return { pending, prog, done, verified, overdueCount, now };
  }, [rows]);

  return (
    <div>
      <div className="page-head">
        <h1>改善任务</h1>
        <span className="sub">
          {groupMode ? '跨公司任务跟踪（聚合列表，不含要素明细）' : '本租户任务跟踪'}
          {' · '}{rows.length} 项 · 待 {pending} · 进行 {prog} · 完成 {done} · 验证 {verified}
          {overdueCount > 0 && <em style={{ color: 'var(--red)', fontWeight: 600, marginLeft: 8 }}>超期 {overdueCount}</em>}
        </span>
        <div className="spacer" />
        <button className="btn sm" onClick={exportCsv} disabled={rows.length === 0}>导出 CSV</button>
        {activeCount > 0 && <button className="btn sm" onClick={() => setFilters({})}>重置筛选（{activeCount}）</button>}
      </div>

      <div className="filter-bar no-print">
        {groupMode ? (<>
          <FilterSelect label="区域" value={filters.region ?? ''} options={(dim?.by_region ?? []).map((r) => ({ value: r.region, label: r.region }))} onChange={(v) => patch({ region: v || undefined })} />
          <FilterSelect label="公司" value={filters.company ?? ''} options={(dim?.by_company ?? []).map((c) => ({ value: c.company, label: c.company }))} onChange={(v) => patch({ company: v || undefined })} />
          <FilterSelect label="工艺" value={filters.process ?? ''} options={(dim?.by_process ?? []).map((p) => ({ value: p.process_type, label: p.process_type }))} onChange={(v) => patch({ process: v || undefined })} />
          <FilterSelect label="产品类型" value={filters.product_type ?? ''} options={(dim?.by_product ?? []).map((p) => ({ value: p.product_type, label: p.product_type }))} onChange={(v) => patch({ product_type: v || undefined })} />
        </>) : (
          <FilterSelect label="产线" value={filters.line_id ?? ''} options={lineOptions.map((l) => ({ value: l, label: l }))} onChange={(v) => patch({ line_id: v || undefined })} />
        )}
        <FilterSelect label="项目类型" value={filters.project ?? ''}
          options={[...(groupMode ? (dim?.by_project ?? []).map((p) => ({ value: p.project_type, label: p.project_type })) : []),
            ...(!groupMode ? [{ value: '量产改善', label: '量产改善' }, { value: 'NPI导入', label: 'NPI导入' }, { value: '自动化改造', label: '自动化改造' }, { value: '布局优化', label: '布局优化' }, { value: '质量改善', label: '质量改善' }] : []),
          ]} onChange={(v) => patch({ project: v || undefined })} />
        <FilterSelect label="状态" value={filters.status ?? ''} options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))} onChange={(v) => patch({ status: v || undefined })} />
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>工位</th><th>产线</th><th>来源</th>
                {groupMode && <><th>公司</th><th>区域</th></>}
                <th>项目类型</th><th>浪费类型</th><th>措施</th>
                <th className="num">节省(s)</th><th>状态</th>
                <th>责任人</th><th>截止</th>{canFlow && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const next = NEXT_STATUS[r.status];
                const ov = isOverdue(r, now);
                return (
                  <tr key={r.imp_id}
                    style={ov ? { background: 'var(--red-bg)', borderLeft: '3px solid var(--red)' } : undefined}>
                    <td>{r.station_name ?? r.station_id}<div className="muted mono">{r.station_id}</div></td>
                    <td>{r.line_name ?? r.line_id ?? '—'}</td>
                    <td>
                      <span className={`tag ${r.element_source === 'ai_assisted' ? 't-blue' : r.element_source === 'manual' ? 't-amber' : 't-gray'}`}>
                        {r.element_source === 'ai_assisted' ? 'AI 分解' : r.element_source === 'manual' ? '手工分解' : r.element_source === 'mixed' ? '混合' : '—'}
                      </span>
                      {r.bol_version != null && <span className="muted mono" style={{ marginLeft: 4, fontSize: 11 }}>v{r.bol_version}</span>}
                      {r.source && <div className="muted" style={{ fontSize: 10 }}>{r.source === 'ai' ? 'AI 建议' : r.source === 'manual' ? '人工录入' : '规则建议'}</div>}
                    </td>
                    {groupMode && <><td>{r.company ?? '—'}</td><td>{r.region ?? '—'}</td></>}
                    <td>{r.project_type ?? '—'}</td>
                    <td>{r.waste_type}</td>
                    <td title={r.measure}>{r.measure.length > 40 ? r.measure.slice(0, 40) + '…' : r.measure}
                      {r.actual_measure && <div className="muted" style={{ fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.actual_measure}>实：{r.actual_measure}</div>}
                    </td>
                    <td className="num">{r.est_save_s}</td>
                    <td><span className={`tag ${STATUS_CLS[r.status] ?? 't-gray'}`}>{r.status}</span>{ov && <span className="tag" style={{ background: 'var(--red)', color: '#fff', marginLeft: 4, fontSize: 10 }}>超期</span>}</td>
                    <td>{r.owner ?? '—'}</td>
                    <td>{r.due ? String(r.due).slice(0, 10) : '—'}</td>
                    {canFlow && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {next ? (
                          <button className="btn sm" disabled={busyId === r.imp_id} onClick={() => void flow(r)}>
                            {busyId === r.imp_id ? '…' : `标记${next}`}
                          </button>
                        ) : <span className="muted">—</span>}
                        <button className="btn sm ghost" style={{ marginLeft: 4 }} disabled={busyId === r.imp_id} onClick={() => openEdit(r)}>编辑</button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={groupMode ? 14 : 12} className="empty">
                  {activeCount > 0 ? '该筛选组合暂无任务。' : '暂无改善任务：先到工位「分析结果」页生成建议并采纳。'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* v3.66 P2：编辑弹窗（责任人/截止/实际措施/状态） */}
      {editRow && (
        <div className="modal-mask" onClick={() => setEditRow(null)}>
          <div className="modal" style={{ maxWidth: 480, padding: 24 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>编辑措施 · {editRow.imp_id.slice(0, 8)}…</h3>
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                责任人
                <input value={editOwner} onChange={(e) => setEditOwner(e.target.value)} maxLength={32} placeholder="登录名" style={{ padding: '6px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--line2)' }} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                计划完成
                <input type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--line2)' }} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                实际措施
                <input value={editActual} onChange={(e) => setEditActual(e.target.value)} maxLength={200} placeholder="与拟定方案不同的部分（留空=按拟定执行）" style={{ padding: '6px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--line2)' }} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                状态
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {STATUS_OPTIONS.map((s) => (
                    <button key={s} type="button" className={`btn sm${editStatus === s ? '' : ' ghost'}`}
                      onClick={() => setEditStatus(s)}>{s}</button>
                  ))}
                </div>
              </label>
              <label style={{ fontSize: 12, color: 'var(--ink3)' }}>
                拟定方案：{editRow.measure.slice(0, 120)}{editRow.measure.length > 120 ? '…' : ''}
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn sm ghost" onClick={() => setEditRow(null)}>取消</button>
              <button className="btn sm primary" disabled={busyId === editRow.imp_id}
                onClick={() => void saveEdit()}>{busyId === editRow.imp_id ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}