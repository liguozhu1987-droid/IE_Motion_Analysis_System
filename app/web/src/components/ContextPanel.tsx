import { useEffect, useState } from 'react';
import { api, type DashboardSummary, type LineAnalysis, type LineSummaryRow, type Station } from '../api';
import { useAuth } from '../auth';
import { VA_CLASS_LABEL } from '../constants';

interface Props {
  mode: 'line' | 'station' | 'group';
  lineId: string;
  station: Station | null;
  /** L1 集团看板的当前聚合结果（group 模式数据源，由外壳统一下发） */
  dash?: DashboardSummary | null;
  /** group 模式：点击关注清单产线行进产线总览 */
  onOpenLine?: (lineId: string) => void;
  /** 瓶颈榜点击 → 打开该工位 */
  onOpenStation?: (stationId: string) => void;
  /** 当前产线概览（名称/工艺/平衡率），来自导航层 */
  lineRow?: LineSummaryRow | null;
  company?: string;
  region?: string | null;
}

interface StationTodo { pending: number; done: number; verified: number; }

/**
 * 右侧上下文摘要面板（v3.6 · 角色自适应）。
 * 不再"把所有指标堆给所有人"，而是按角色给不同层次：
 *  · 只读层：归属链 + CT/TT + VA（无待办、无更新时间）
 *  · 执行层：+ 改善三态待办 + 可执行的页面跳转
 *  · 管理层：+ 最近更新（谁在什么时候动过）+ 集团视图入口
 * group 模式：集团关注清单（平衡率最差 Top5 + 临期任务）。
 */
export default function ContextPanel({ mode, lineId, station, dash, onOpenLine, onOpenStation, lineRow, company, region }: Props) {
  const { can } = useAuth();
  const [la, setLa] = useState<LineAnalysis | null>(null);
  const [todo, setTodo] = useState<StationTodo | null>(null);
  const [error, setError] = useState(false);

  const isManager = can('group:read');
  const canPlan = can('suggestion:generate');
  const canDecompose = can('element:read');
  const canAnalyze = can('analysis:read');
  const canCompare = can('compare:read');

  useEffect(() => {
    let alive = true;
    setLa(null); setTodo(null); setError(false);
    if (mode === 'group' || !lineId) return;
    (async () => {
      try {
        const analysis = await api.lineAnalysis(lineId);
        if (!alive) return;
        setLa(analysis);
        if (mode === 'station' && station && canPlan) {
          const imp = await api.improvements({ station_id: station.station_id });
          if (!alive) return;
          setTodo({
            pending: imp.improvements.filter((i) => i.status === '待实施').length,
            done: imp.improvements.filter((i) => i.status === '已完成').length,
            verified: imp.improvements.filter((i) => i.status === '已验证').length,
          });
        }
      } catch { if (alive) setError(true); }
    })();
    return () => { alive = false; };
  }, [lineId, mode, station, canPlan]);

  if (mode === 'group') {
    return (
      <aside className="panel no-print">
        <div className="panel-head">
          <div className="panel-title">集团关注清单</div>
          <div className="panel-sub">筛选范围内最需关注的产线与临期任务</div>
        </div>
        {dash ? (
          <>
            <div className="panel-sec">
              <div className="panel-sec-t">平衡率最差 Top{dash.top_bottleneck_lines.length}</div>
              {dash.top_bottleneck_lines.length === 0 ? (
                <div className="ok" style={{ margin: 0, padding: '6px 10px' }}>当前范围暂无产线数据</div>
              ) : (
                <table className="panel-table">
                  <tbody>
                    {dash.top_bottleneck_lines.map((l) => (
                      <tr key={`${l.tenant_id}|${l.line_id}`} className="pick"
                        onClick={() => onOpenLine?.(l.line_id)} title="点击进入该产线总览">
                        <td>{l.line_name}<div className="muted mono">{l.company} · {l.region}</div></td>
                        <td className="num" style={{ color: l.balance_rate < 70 ? 'var(--red)' : 'var(--amber)', fontWeight: 700 }}>{l.balance_rate}%</td>
                        <td className="num muted">待办 {l.imp_pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="panel-sec">
              <div className="panel-sec-t">临期任务（≤7 天待实施）</div>
              {dash.due_soon.length === 0 ? (
                <div className="ok" style={{ margin: 0, padding: '6px 10px' }}>无临期任务</div>
              ) : (
                <table className="panel-table">
                  <tbody>
                    {dash.due_soon.map((t) => (
                      <tr key={t.imp_id} className="pick" onClick={() => { window.location.hash = '#/improvements'; }}
                        title="进入改善任务页查看">
                        <td>{t.measure.length > 18 ? t.measure.slice(0, 18) + '…' : t.measure}
                          <div className="muted mono">{t.line_name} · {t.company}</div></td>
                        <td className="num" style={{ color: 'var(--amber)', fontWeight: 700 }}>{String(t.due).slice(5, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="panel-sec">
              <a className="btn sm" href="#/improvements">查看全部改善任务 →</a>
            </div>
          </>
        ) : <div className="panel-empty">加载中…</div>}
      </aside>
    );
  }

  if (!lineId) return null;
  if (error) return <aside className="panel panel-error"><div className="panel-empty">摘要加载失败（不影响主区操作）</div></aside>;

  const row = mode === 'station' && station
    ? la?.rows.find((r) => r.station_id === station.station_id)
    : null;

  const ct = row?.ct_s ?? station?.ct ?? null;
  const tt = row?.tt_s ?? station?.tt ?? null;
  /* 引擎的 bottleneck 是"最差差值"排序（可含 CT<TT 的未分解工位）；
     面板口径是"超出 TT"，这里显式过滤，避免把 CT=0 的工位误标为瓶颈。 */
  const overBottlenecks = (la?.bottleneck ?? []).filter((b) => b.ct_s > b.tt_s);

  return (
    <aside className="panel no-print">
      {mode === 'station' && station ? (
        <>
          <div className="panel-head">
            <div className="panel-title">{station.name}</div>
            <div className="panel-sub mono">{station.station_id} · v{station.version}</div>
          </div>

          {/* 归属链：工厂 › 产线 › 工位（回答"这个工位属于哪条线、哪个厂"） */}
          <div className="panel-chain">
            <span>{region ?? '—'}</span>
            <i>›</i>
            <span className="pc-company">{company ?? '—'}</span>
            <i>›</i>
            <a href="#/stations" title="回到产线总览">{lineRow?.line_name ?? lineId}</a>
          </div>

          <div className="panel-kpis">
            <div className="pk"><div className={`v${ct != null && tt != null && ct > tt ? ' bad' : ''}`}>{ct ?? '—'}</div><div className="l">CT (s)</div></div>
            <div className="pk"><div className="v">{tt ?? '—'}</div><div className="l">TT (s)</div></div>
            <div className="pk"><div className="v blue">{row?.va_pct ?? '—'}%</div><div className="l">VA 占比</div></div>
            <div className="pk"><div className="v">{row?.element_count ?? 0}</div><div className="l">要素数</div></div>
          </div>

          {canPlan && (
            <div className="panel-sec">
              <div className="panel-sec-t">改善待办</div>
              {todo ? (
                <div className="row tight">
                  <span className="tag t-amber">待实施 {todo.pending}</span>
                  <span className="tag t-blue">已完成 {todo.done}</span>
                  <span className="tag t-teal">已验证 {todo.verified}</span>
                </div>
              ) : <div className="muted">加载中…</div>}
            </div>
          )}

          <div className="panel-sec">
            <div className="panel-sec-t">前往</div>
            <div className="panel-actions">
              {canDecompose && <a className="btn sm" href={`#/workbench/${station.station_id}`}>分解工作台</a>}
              {canAnalyze && <a className="btn sm" href={`#/analysis/${station.station_id}`}>分析结果</a>}
              {canCompare && <a className="btn sm" href={`#/compare/${station.station_id}`}>改善对比</a>}
            </div>
          </div>

          {isManager && station.updated_by && (
            <div className="panel-sec">
              <div className="panel-sec-t">最近更新</div>
              <div className="muted">{station.updated_by} · {station.updated_at ? station.updated_at.slice(0, 16).replace('T', ' ') : '—'}</div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="panel-head">
            <div className="panel-title">{lineRow?.line_name ?? lineId}</div>
            <div className="panel-sub mono">{lineId}{lineRow?.process_type ? ` · ${lineRow.process_type}` : ''}{lineRow?.product_type ? ` · ${lineRow.product_type}` : ''}</div>
          </div>

          <div className="panel-chain">
            <span>{region ?? '—'}</span>
            <i>›</i>
            <span className="pc-company">{company ?? '—'}</span>
          </div>

          {la ? (
            <>
              <div className="panel-kpis three">
                <div className="pk"><div className={`v ${la.totals.ct_s <= 0 ? '' : (lineRow?.balance_rate ?? la.balance_rate) >= 70 ? 'blue' : 'bad'}`}>
                  {la.totals.ct_s <= 0 ? '—' : `${lineRow?.balance_rate ?? la.balance_rate}%`}
                </div><div className="l">线平衡率</div></div>
                <div className="pk"><div className="v amber">{lineRow?.bottleneck_count ?? la.bottleneck.length}</div><div className="l">瓶颈数</div></div>
                {canPlan && lineRow && <div className="pk"><div className="v">{lineRow.imp_pending}</div><div className="l">待实施</div></div>}
              </div>

              {/* 工时结构：比例条比三个 tag 更快看懂 */}
              <div className="panel-sec">
                <div className="panel-sec-t">工时结构（{la.totals.ct_s}s）</div>
                <div className="stack-bar">
                  {(() => {
                    const total = la.totals.va_s + la.totals.rnva_s + la.totals.nva_s || 1;
                    return (
                      <>
                        <span className="sb va" style={{ width: `${(la.totals.va_s / total) * 100}%` }} title={`VA ${la.totals.va_s}s`} />
                        <span className="sb rnva" style={{ width: `${(la.totals.rnva_s / total) * 100}%` }} title={`RNVA ${la.totals.rnva_s}s`} />
                        <span className="sb nva" style={{ width: `${(la.totals.nva_s / total) * 100}%` }} title={`NVA ${la.totals.nva_s}s`} />
                      </>
                    );
                  })()}
                </div>
                <div className="stack-legend">
                  <span><i className="va" />VA {la.totals.va_s}s</span>
                  <span title={`${VA_CLASS_LABEL.RNVA.full} — ${VA_CLASS_LABEL.RNVA.hint}`}><i className="rnva" />RNVA {la.totals.rnva_s}s</span>
                  <span><i className="nva" />NVA {la.totals.nva_s}s</span>
                </div>
              </div>

              <div className="panel-sec">
                <div className="panel-sec-t">瓶颈（CT 超出 TT）</div>
                {overBottlenecks.length === 0 ? (
                  <div className="ok" style={{ margin: 0, padding: '6px 10px' }}>无瓶颈，全线 CT ≤ TT</div>
                ) : (
                  <table className="panel-table">
                    <tbody>
                      {overBottlenecks.slice(0, 3).map((b) => (
                        <tr key={b.station_id} className="pick" onClick={() => onOpenStation?.(b.station_id)}>
                          <td>{b.name}<div className="muted mono">{b.station_id}</div></td>
                          <td className="num" style={{ color: 'var(--red)', fontWeight: 700 }}>{b.ct_s}s</td>
                          <td className="num muted">TT {b.tt_s}s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : <div className="panel-empty">加载中…</div>}

          {isManager && (
            <div className="panel-sec">
              <a className="btn sm" href="#/dashboard">集团视图 →</a>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
