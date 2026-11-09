import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type DashboardFilters, type DashboardSummary, type Improvement } from '../api';
import { useAuth } from '../auth';
import FilterSelect from '../components/FilterSelect';

const STATUS_CLS: Record<string, string> = { 已验证: 't-teal', 已完成: 't-blue', 待实施: 't-amber' };
const NEXT_STATUS: Record<string, string> = { 待实施: '已完成', 已完成: '已验证' };
const STATUS_OPTIONS = ['待实施', '已完成', '已验证'];

/**
 * L4 改善任务清单（v3.3 · #/improvements）：从工位清单底部抽出的独立任务页。
 *  - 有 group:read（sys_admin / ie_admin）：跨公司模式，走 /dashboard/improvements，
 *    筛选 = 区域/公司/工艺/产品类型/项目类型/状态；
 *  - 其他角色：租户内模式，走 /improvements，筛选 = 产线/项目类型/状态。
 * 三态流转交互与工位页一致（已验证由后端校验复测版本，冲突时透传 hint）。
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

  /* 维度字典（集团模式的下拉选项源；只拉一次） */
  useEffect(() => {
    if (!groupMode) return;
    let alive = true;
    api.dashboard.summary().then((s) => { if (alive) setDim(s); }).catch(() => { /* 下拉为空则手输 */ });
    return () => { alive = false; };
  }, [groupMode]);

  /* 租户内模式的产线下拉（本租户工位） */
  useEffect(() => {
    if (groupMode) return;
    let alive = true;
    api.stations().then((ss) => { if (alive) setLineOptions([...new Set(ss.map((s) => s.line_id))].sort()); })
      .catch(() => { /* 忽略：下拉为空 */ });
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
    } catch (err) {
      setError((err as Error).message);
      setRows([]);
    }
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
      if (err instanceof ApiError) {
        setError(`${err.message}${err.hint ? `（${err.hint}）` : ''}`);
      } else setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  /** 导出 CSV（前端拼装，注释行带全部筛选条件） */
  const exportCsv = () => {
    const head = ['建议编号', '工位', '产线', '公司', '区域', '项目类型', '浪费类型', '措施', '预估节省(s)', '优先级', '状态', '责任人', '截止'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      `# 筛选条件: ${JSON.stringify(filters)}`,
      `# 导出行数: ${rows.length}  导出时间: ${new Date().toISOString()}`,
      head.join(','),
      ...rows.map((r) => [r.imp_id, r.station_name ?? r.station_id, r.line_name ?? r.line_id ?? '', r.company ?? '', r.region ?? '',
        r.project_type ?? '', r.waste_type, r.measure, r.est_save_s, r.priority, r.status, r.owner ?? '', r.due ?? ''].map(esc).join(',')),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `improvements-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg(`已导出 ${rows.length} 条任务（含筛选条件）`);
  };

  const activeCount = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);
  const pending = rows.filter((r) => r.status === '待实施').length;
  const done = rows.filter((r) => r.status === '已完成').length;
  const verified = rows.filter((r) => r.status === '已验证').length;

  return (
    <div>
      <div className="page-head">
        <h1>改善任务</h1>
        <span className="sub">
          {groupMode ? '跨公司任务跟踪（聚合列表，不含要素明细）' : '本租户任务跟踪'}
          {' · '}{rows.length} 项 · 待实施 {pending} · 已完成 {done} · 已验证 {verified}
        </span>
        <div className="spacer" />
        <button className="btn sm" onClick={exportCsv} disabled={rows.length === 0}>导出 CSV</button>
        {activeCount > 0 && <button className="btn sm" onClick={() => setFilters({})}>重置筛选（{activeCount}）</button>}
      </div>

      {/* v3.59 筛选条全部 SelectMenu 自绘（FilterSelect），根治原生 popup 漂移飞走 */}
      <div className="filter-bar no-print">
        {groupMode ? (
          <>
            <FilterSelect label="区域" value={filters.region ?? ''}
              options={(dim?.by_region ?? []).map((r) => ({ value: r.region, label: r.region }))}
              onChange={(v) => patch({ region: v || undefined })} />
            <FilterSelect label="公司" value={filters.company ?? ''}
              options={(dim?.by_company ?? []).map((c) => ({ value: c.company, label: c.company }))}
              onChange={(v) => patch({ company: v || undefined })} />
            <FilterSelect label="工艺" value={filters.process ?? ''}
              options={(dim?.by_process ?? []).map((p) => ({ value: p.process_type, label: p.process_type }))}
              onChange={(v) => patch({ process: v || undefined })} />
            <FilterSelect label="产品类型" value={filters.product_type ?? ''}
              options={(dim?.by_product ?? []).map((p) => ({ value: p.product_type, label: p.product_type }))}
              onChange={(v) => patch({ product_type: v || undefined })} />
          </>
        ) : (
          <FilterSelect label="产线" value={filters.line_id ?? ''}
            options={lineOptions.map((l) => ({ value: l, label: l }))}
            onChange={(v) => patch({ line_id: v || undefined })} />
        )}
        <FilterSelect label="项目类型" value={filters.project ?? ''}
          options={[
            ...(groupMode ? (dim?.by_project ?? []).map((p) => ({ value: p.project_type, label: p.project_type })) : []),
            ...(!groupMode ? [
              { value: '量产改善', label: '量产改善' },
              { value: 'NPI导入', label: 'NPI导入' },
              { value: '自动化改造', label: '自动化改造' },
              { value: '布局优化', label: '布局优化' },
              { value: '质量改善', label: '质量改善' },
            ] : []),
          ]}
          onChange={(v) => patch({ project: v || undefined })} />
        <FilterSelect label="状态" value={filters.status ?? ''}
          options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
          onChange={(v) => patch({ status: v || undefined })} />
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>工位</th><th>产线</th>
                {groupMode && <><th>公司</th><th>区域</th></>}
                <th>项目类型</th><th>浪费类型</th><th>措施</th>
                <th className="num">节省(s)</th><th className="num">优先级</th><th>状态</th>
                <th>责任人</th><th>截止</th>{canFlow && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const next = NEXT_STATUS[r.status];
                return (
                  <tr key={r.imp_id}>
                    <td>{r.station_name ?? r.station_id}<div className="muted mono">{r.station_id}</div></td>
                    <td>{r.line_name ?? r.line_id ?? '—'}</td>
                    {groupMode && <><td>{r.company ?? '—'}</td><td>{r.region ?? '—'}</td></>}
                    <td>{r.project_type ?? '—'}</td>
                    <td>{r.waste_type}</td>
                    <td title={r.measure}>{r.measure.length > 40 ? r.measure.slice(0, 40) + '…' : r.measure}</td>
                    <td className="num">{r.est_save_s}</td>
                    <td className="num">{r.priority}</td>
                    <td><span className={`tag ${STATUS_CLS[r.status] ?? 't-gray'}`}>{r.status}</span></td>
                    <td>{r.owner ?? '—'}</td>
                    <td>{r.due ? String(r.due).slice(0, 10) : '—'}</td>
                    {canFlow && (
                      <td>
                        {next ? (
                          <button className="btn sm" disabled={busyId === r.imp_id}
                            onClick={() => void flow(r)}>
                            {busyId === r.imp_id ? '…' : `标记${next}`}
                          </button>
                        ) : <span className="muted">—</span>}
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={groupMode ? 13 : 11} className="empty">
                  {activeCount > 0 ? '该筛选组合暂无任务。' : '暂无改善任务：先到工位「分析结果」页生成建议并采纳。'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
