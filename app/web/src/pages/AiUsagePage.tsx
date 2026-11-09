import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type AiUsageFeature, type AiUsageSummary, type Station } from '../api';
import FilterSelect from '../components/FilterSelect';

interface Filters {
  from: string; to: string; user_id: string; line_id: string; station_id: string;
  feature: string; group_by: string;
}
const INITIAL_FILTERS: Filters = {
  from: '', to: '', user_id: '', line_id: '', station_id: '', feature: '',
  group_by: 'user,line,station,feature',
};
const FEATURE_LABEL: Record<string, string> = {
  waste_analysis: '浪费＋问题清单', improvement_suggestion: 'AI 改善建议',
};
const QUALITY_LABEL: Record<string, string> = {
  complete: '逐次明细', legacy_total_only: '历史总 Token', partial: '部分明细',
};
const fmt = new Intl.NumberFormat('zh-CN');
const number = (value: number | null) => value === null ? '—' : fmt.format(value);

/** 正式 AI 调用用量：总 Token 与建议是否采纳无关。 */
export default function AiUsagePage() {
  const [draft, setDraft] = useState<Filters>(INITIAL_FILTERS);
  const [applied, setApplied] = useState<Filters>(INITIAL_FILTERS);
  const [stations, setStations] = useState<Station[]>([]);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [data, setData] = useState<AiUsageSummary | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.stations().then((rows) => { if (alive) setStations(rows); }).catch(() => { /* 查询接口仍会执行权限收口 */ });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await api.ai.usage({
        from: applied.from || undefined, to: applied.to || undefined,
        user_id: applied.user_id || undefined, line_id: applied.line_id || undefined,
        station_id: applied.station_id || undefined,
        feature: (applied.feature || undefined) as AiUsageFeature | undefined,
        group_by: applied.group_by, page, page_size: 50,
      });
      setData(result);
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [applied, page]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!data) return;
    setUsers((prev) => {
      const next = { ...prev };
      for (const row of data.rows) {
        if (row.user_id) next[row.user_id] = row.display_name || row.username || row.user_id;
      }
      return next;
    });
  }, [data]);

  const patch = (value: Partial<Filters>) => setDraft((prev) => ({ ...prev, ...value }));
  const apply = (event?: FormEvent) => {
    event?.preventDefault();
    setPage(1);
    if (applied === draft) void load();
    else setApplied({ ...draft });
  };
  const reset = () => {
    setDraft(INITIAL_FILTERS); setApplied(INITIAL_FILTERS); setPage(1);
    if (applied === INITIAL_FILTERS && page === 1) void load();
  };
  const lines = useMemo(() => [...new Set(stations.map((s) => s.line_id))].sort(), [stations]);
  const stationOptions = stations.filter((s) => !draft.line_id || s.line_id === draft.line_id);
  const pageCount = data ? Math.max(1, Math.ceil(data.total_rows / data.page_size)) : 1;
  const groups = data?.group_by ?? applied.group_by.split(',');

  return (
    <div>
      <div className="page-head">
        <h1>AI 用量统计</h1>
        <span className="sub">按用户、产线、工位统计正式生成的实际 Token；不以是否采纳为统计前提</span>
        <div className="spacer" />
        <button className="btn sm" type="button" onClick={() => void load()} disabled={loading}>刷新</button>
      </div>

      <form className="filter-bar no-print" onSubmit={apply}>
        <label className="filter-item usage-date"><span>开始日期</span>
          <input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => patch({ from: e.target.value })} />
        </label>
        <label className="filter-item usage-date"><span>结束日期</span>
          <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => patch({ to: e.target.value })} />
        </label>
        <FilterSelect label="用户" value={draft.user_id} width={150}
          options={Object.entries(users).map(([value, label]) => ({ value, label }))}
          onChange={(user_id) => patch({ user_id })} />
        <FilterSelect label="产线" value={draft.line_id} width={140}
          options={lines.map((line) => ({ value: line, label: line }))}
          onChange={(line_id) => patch({ line_id, station_id: '' })} />
        <FilterSelect label="工位" value={draft.station_id} width={190}
          options={stationOptions.map((s) => ({ value: s.station_id, label: `${s.station_id} · ${s.name}` }))}
          onChange={(station_id) => patch({ station_id })} />
        <FilterSelect label="功能" value={draft.feature} width={160}
          options={Object.entries(FEATURE_LABEL).map(([value, label]) => ({ value, label }))}
          onChange={(feature) => patch({ feature })} />
        <FilterSelect label="分组" value={draft.group_by} width={190} placeholder="请选择分组"
          options={[
            { value: 'user,line,station,feature', label: '工位＋用户＋功能' },
            { value: 'line,station', label: '仅按工位' },
            { value: 'user', label: '仅按用户' },
            { value: 'line', label: '仅按产线' },
            { value: 'feature', label: '仅按功能' },
          ]}
          onChange={(group_by) => patch({ group_by: group_by || INITIAL_FILTERS.group_by })} />
        <button className="btn sm primary" type="submit" disabled={loading}>查询</button>
        <button className="btn sm" type="button" onClick={reset}>重置</button>
      </form>

      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <div className="empty">正在统计 AI 用量…</div>}
      {data && (
        <>
          <div className="metrics usage-metrics">
            <div className="metric"><div className="v blue">{number(data.totals.total_tokens)}</div><div className="l">总 Token（输入＋输出）</div></div>
            <div className="metric"><div className="v">{number(data.totals.prompt_tokens)}</div><div className="l">输入 Token{data.totals.legacy_batch_count > 0 ? ' · 历史未拆分' : ''}</div></div>
            <div className="metric"><div className="v">{number(data.totals.completion_tokens)}</div><div className="l">输出 Token{data.totals.legacy_batch_count > 0 ? ' · 历史未拆分' : ''}</div></div>
            <div className="metric"><div className="v">{number(data.totals.api_call_count)}</div><div className="l">真实 API 调用 · 失败 {number(data.totals.failed_call_count)}</div></div>
            <div className="metric"><div className="v">{number(data.totals.batch_count)}</div><div className="l">计量批次 · 历史 {number(data.totals.legacy_batch_count)}</div></div>
          </div>

          {data.totals.usage_missing_count > 0 && (
            <div className="warning-banner">有 {number(data.totals.usage_missing_count)} 次调用的上游响应未提供 Token 用量；这些记录计调用次数，但 Token 不按 0 虚构。</div>
          )}

          <div className="card">
            <div className="table-scroll">
              <table>
                <caption className="sr-only">AI Token 用量分组统计</caption>
                <thead><tr>
                  <th>用户</th><th>产线</th><th>工位</th><th>功能</th>
                  <th className="num">计量批次</th><th className="num">API 调用</th><th className="num">失败</th>
                  <th className="num">输入 Token</th><th className="num">输出 Token</th><th className="num">总 Token</th><th>数据口径</th>
                </tr></thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={JSON.stringify([row.user_id, row.line_id, row.station_id, row.feature, row.model])}>
                      <td>{groups.includes('user') ? (row.display_name || row.username || row.user_id || '—') : '全部'}</td>
                      <td>{groups.includes('line') ? (row.line_name ? `${row.line_id} · ${row.line_name}` : row.line_id || '—') : '全部'}</td>
                      <td>{groups.includes('station') ? (row.station_name ? `${row.station_id} · ${row.station_name}` : row.station_id || '—') : '全部'}</td>
                      <td>{row.feature ? FEATURE_LABEL[row.feature] ?? row.feature : '全部'}</td>
                      <td className="num">{number(row.batch_count)}</td>
                      <td className="num">{number(row.api_call_count)}{row.legacy_batch_count > 0 && <span className="usage-cell-note">＋历史</span>}</td>
                      <td className="num">{number(row.failed_call_count)}</td>
                      <td className="num">{number(row.prompt_tokens)}</td>
                      <td className="num">{number(row.completion_tokens)}</td>
                      <td className="num usage-total">{number(row.total_tokens)}</td>
                      <td><span className={`tag ${row.data_quality === 'complete' ? 't-teal' : 't-amber'}`}
                        title={`历史批次 ${row.legacy_batch_count}；usage 缺失 ${row.usage_missing_count}`}>
                        {QUALITY_LABEL[row.data_quality]}
                      </span></td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && <tr><td colSpan={11} className="empty-cell">当前筛选范围内没有正式 AI 调用或历史 Token 记录</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="usage-table-foot">
              <span>共 {number(data.total_rows)} 个分组 · 第 {data.page}/{pageCount} 页{loading ? ' · 刷新中…' : ''}</span>
              <div className="spacer" />
              <button className="btn sm" type="button" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
              <button className="btn sm" type="button" disabled={page >= pageCount || loading} onClick={() => setPage((p) => p + 1)}>下一页</button>
            </div>
          </div>
          <div className="usage-note">
            <b>统计说明：</b>浪费清单与问题清单由同一次生成共同产出，Token 只计一次；重试按实际调用累加；缓存和幂等命中不新增 Token。
            “计量批次”只计有 Token 明细或历史 Token 的批次；零 Token 缓存批次不新增计量批次。
            “历史总 Token”仅支持批次总量，不能拆分输入/输出或还原当时调用次数。
          </div>
        </>
      )}
    </div>
  );
}
