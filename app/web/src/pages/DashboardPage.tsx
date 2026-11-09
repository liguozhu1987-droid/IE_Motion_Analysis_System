import { api, type DashboardFilters, type DashboardSummary } from '../api';
import { useAuth } from '../auth';
import SelectMenu, { type SelectOption } from '../components/SelectMenu';

interface Props {
  /** 当前筛选（App 持有，与集团树/面包屑/关注面板联动） */
  filters: DashboardFilters;
  /** 当前筛选下的聚合结果 */
  summary: DashboardSummary | null;
  /** 无筛选维度字典（下拉选项源，只随数据变更刷新） */
  dim: DashboardSummary | null;
  loading: boolean;
  onChange: (patch: Partial<DashboardFilters>) => void;
  onReset: () => void;
  /** 点击产线行 → 进入该产线总览（L2） */
  onOpenLine: (lineId: string) => void;
}

/** 平衡率着色（与 ContextPanel 口径一致：低于 70 红 / 70-85 琥珀 / ≥85 青） */
const rateCls = (r: number) => (r >= 85 ? 't-teal' : r >= 70 ? 't-amber' : 't-red');
const rateColor = (r: number) => (r >= 85 ? 'var(--teal)' : r >= 70 ? 'var(--amber)' : 'var(--red)');

const fmtTime = (t: string | null) => (t ? t.slice(0, 16).replace('T', ' ') : '—');

/**
 * 维度筛选下拉（v3.59）：SelectMenu 自绘替代原生 <select>。
 * 为什么必须换：Chromium 在特定 DPI/缩放/版本组合下原生 popup 定位 bug——
 * 弹出列表飘到浏览器窗口左上角（v3.21 在「新建分析对象」弹窗实测同款问题，
 * 本仓库无头环境无法复现、CSS 侧无解）。看板筛选条此前仍用原生 select，
 * 用户在真实桌面实测「产品类型/项目类型」下拉飞走 → 全部换 SelectMenu 根治。
 * 空值统一 ''（=「全部」），与 DashboardFilters 的 undefined 语义在此转换。
 */
function DimSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="filter-item">
      <span>{label}</span>
      <SelectMenu
        ariaLabel={`按${label}筛选`}
        value={value}
        placeholder="全部"
        options={[{ value: '', label: '全部' }, ...options]}
        onChange={onChange}
      />
    </label>
  );
}

/**
 * L1 综合看板（v3.3 · #/dashboard；v3.42 由「集团看板」改名并全角色开放）。
 * 跨公司/跨工艺/跨产品综合视图：筛选条五维联动 → KPI → 五分布 → 产线横评表（平衡率升序）。
 * 铁律：只含聚合指标（计数/均值/汇总），不含工位要素明细；下钻即筛选（无独立公司页）。
 */
export default function DashboardPage({ filters, summary, dim, loading, onChange, onReset, onOpenLine }: Props) {
  const { can } = useAuth();
  const activeCount = Object.values(filters).filter(Boolean).length;

  /* 空态分级：全库无数据 → 引导；筛选无数据 → 提示重置 */
  const noDataAtAll = dim != null && dim.kpis.station_count === 0;
  const noDataForFilter = !noDataAtAll && summary != null && summary.kpis.station_count === 0;

  if (noDataAtAll) {
    return (
      <div className="card empty" style={{ textAlign: 'left', padding: '28px 32px' }}>
        <h3>综合看板还没有任何数据</h3>
        <p className="muted">按下面任一步骤开始，30 秒后本页即出现跨公司综合视图：</p>
        <ol className="dash-guide">
          <li><b>建真实数据</b>：以 IE 工程师身份到「产线总览 → 新建工位 → 分解工作台」录入第一条分解。</li>
          <li><b>灌演示数据</b>（管理员）：在服务器执行 <code>npm run seed:demo</code>，生成 3 公司 / 11 产线 / 62 工位演示集，可随时按清理 SQL 移除。</li>
          <li><b>看帮助</b>：维度说明见《多维综合驾驶舱与信息架构优化设计方案》（deliverables 目录）。</li>
        </ol>
        {can('station:write') && (
          <a className="btn primary" href="#/stations">去建第一个工位</a>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Level 1 · Multi-dimension View</div>
          <h1>综合看板</h1>
        </div>
        <span className="sub">跨公司 · 跨工艺 · 跨产品 综合视图（聚合指标，不含要素明细）</span>
        <div className="spacer" />
        {activeCount > 0 && <button className="btn sm" onClick={onReset}>重置筛选（{activeCount}）</button>}
      </div>

      {/* 维度筛选条：五维联动，全部卡片随之重算（v3.59 下拉全部 SelectMenu 自绘，根治原生 popup 漂移） */}
      <div className="filter-bar no-print">
        <DimSelect label="大区" value={filters.region ?? ''}
          options={(dim?.by_region ?? []).map((r) => ({ value: r.region, label: r.region }))}
          onChange={(v) => onChange({ region: v || undefined })} />
        {/* v3.25 层级配置化：公司筛选值从 tenant_id 改为公司名（CMC factory 优先）——与树/表格显示同源 */}
        <DimSelect label="公司" value={filters.company ?? ''}
          options={(dim?.by_company ?? []).map((c) => ({ value: c.company, label: c.company }))}
          onChange={(v) => onChange({ company: v || undefined })} />
        <DimSelect label="工艺类型" value={filters.process ?? ''}
          options={(dim?.by_process ?? []).map((p) => ({ value: p.process_type, label: p.process_type }))}
          onChange={(v) => onChange({ process: v || undefined })} />
        <DimSelect label="产品类型" value={filters.product_type ?? ''}
          options={(dim?.by_product ?? []).map((p) => ({ value: p.product_type, label: p.product_type }))}
          onChange={(v) => onChange({ product_type: v || undefined })} />
        <DimSelect label="项目类型" value={filters.project ?? ''}
          options={(dim?.by_project ?? []).map((p) => ({ value: p.project_type, label: p.project_type }))}
          onChange={(v) => onChange({ project: v || undefined })} />
        {loading && <span className="filter-loading">刷新中…</span>}
      </div>

      {noDataForFilter ? (
        <div className="card empty">
          该筛选组合暂无数据。<button className="btn sm" onClick={onReset}>重置筛选</button>
        </div>
      ) : summary && (
        <>
          {/* KPI 覆盖范围 */}
          <div className="metrics" style={{ marginBottom: 14 }}>
            <div className="metric"><div className="v">{summary.kpis.region_count}</div><div className="l">大区</div></div>
            <div className="metric"><div className="v">{summary.kpis.company_count}</div><div className="l">公司</div></div>
            <div className="metric"><div className="v blue">{summary.kpis.line_count}</div><div className="l">产线</div></div>
            <div className="metric"><div className="v">{summary.kpis.station_count}</div><div className="l">工位</div></div>
            <div className="metric"><div className="v teal">{summary.kpis.avg_va_pct}%</div><div className="l">平均 VA 占比</div></div>
            <div className="metric"><div className="v" style={{ color: rateColor(summary.kpis.avg_balance_rate) }}>{summary.kpis.avg_balance_rate}%</div><div className="l">平均平衡率</div></div>
            <div className="metric"><div className="v amber">{summary.kpis.imp_pending}</div><div className="l">待实施建议</div></div>
            <div className="metric"><div className="v teal">{summary.kpis.imp_verified}</div><div className="l">已验证建议</div></div>
          </div>

          {/* 五分布 */}
          <div className="grid cols2">
            <div className="card">
              <h3>按大区</h3>
              <div className="dist-list">
                {summary.by_region.map((r) => (
                  <div key={r.region} className={`dist-row${filters.region === r.region ? ' on' : ''}`}
                    onClick={() => onChange({ region: filters.region === r.region ? undefined : r.region })}
                    title="点击筛选该大区">
                    <span className="dist-name">{r.region}</span>
                    <div className="dist-bar"><div className="dist-bar-fill" style={{ width: `${summary.by_region[0].station_count ? (r.station_count / Math.max(...summary.by_region.map((x) => x.station_count)) * 100) : 0}%` }} /></div>
                    <span className="dist-val">{r.station_count} 工位</span>
                    <span className="dist-sub">{r.company_count} 公司 · {r.line_count} 线 · VA {r.avg_va_pct}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>按公司</h3>
              <div className="table-scroll">
                <table className="dash-table">
                  <thead><tr><th>公司</th><th>大区</th><th className="num">产线</th><th className="num">工位</th><th className="num">平衡率</th><th className="num">VA</th><th className="num">待办</th></tr></thead>
                  <tbody>
                    {summary.by_company.map((c) => (
                      <tr key={c.company} className={`pick${filters.company === c.company ? ' on' : ''}`}
                        onClick={() => onChange({ company: filters.company === c.company ? undefined : c.company })}
                        title="点击筛选该公司">
                        <td>{c.company}</td><td>{c.region}</td>
                        <td className="num">{c.line_count}</td><td className="num">{c.station_count}</td>
                        <td className="num"><span className={`tag ${rateCls(c.avg_balance_rate)}`}>{c.avg_balance_rate}%</span></td>
                        <td className="num">{c.avg_va_pct}%</td>
                        <td className="num">{c.imp_pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h3>按工艺类型</h3>
              <div className="dist-list">
                {summary.by_process.map((p) => (
                  <div key={p.process_type} className={`dist-row${filters.process === p.process_type ? ' on' : ''}`}
                    onClick={() => onChange({ process: filters.process === p.process_type ? undefined : p.process_type })}
                    title="点击筛选该工艺">
                    <span className="dist-name">{p.process_type}</span>
                    <div className="dist-bar"><div className="dist-bar-fill" style={{ width: `${(p.station_count / Math.max(...summary.by_process.map((x) => x.station_count), 1) * 100)}%` }} /></div>
                    <span className="dist-val">{p.station_count} 工位</span>
                    <span className="dist-sub">{p.line_count} 线 · VA {p.avg_va_pct}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <h3>按产品类型</h3>
              <div className="dist-list">
                {summary.by_product.map((p) => (
                  <div key={p.product_type} className={`dist-row${filters.product_type === p.product_type ? ' on' : ''}`}
                    onClick={() => onChange({ product_type: filters.product_type === p.product_type ? undefined : p.product_type })}
                    title="点击筛选该产品类型">
                    <span className="dist-name">{p.product_type}</span>
                    <div className="dist-bar"><div className="dist-bar-fill" style={{ width: `${(p.station_count / Math.max(...summary.by_product.map((x) => x.station_count), 1) * 100)}%` }} /></div>
                    <span className="dist-val">{p.station_count} 工位</span>
                    <span className="dist-sub">{p.line_count} 线 · VA {p.avg_va_pct}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h3>按项目类型（改善任务）</h3>
              <div className="dist-list">
                {summary.by_project.map((p) => (
                  <div key={p.project_type} className={`dist-row${filters.project === p.project_type ? ' on' : ''}`}
                    onClick={() => onChange({ project: filters.project === p.project_type ? undefined : p.project_type })}
                    title="点击筛选该项目类型">
                    <span className="dist-name">{p.project_type}</span>
                    <div className="dist-bar"><div className="dist-bar-fill amber" style={{ width: `${(p.imp_count / Math.max(...summary.by_project.map((x) => x.imp_count), 1) * 100)}%` }} /></div>
                    <span className="dist-val">{p.imp_count} 项</span>
                    <span className="dist-sub">待实施 {p.pending} · 已完成 {p.done} · 已验证 {p.verified} · 预估节省 {p.est_save_s}s</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 产线汇总表：平衡率升序，最差的线排最上；点击行进产线总览 */}
          <div className="card" style={{ marginTop: 14 }}>
            <h3>产线汇总（按平衡率升序 · {summary.lines.length} 条）</h3>
            <div className="table-scroll">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>产线</th><th>公司</th><th>大区</th><th>工艺</th><th>产品</th>
                    <th className="num">工位</th><th className="num">平衡率</th><th className="num">VA</th>
                    <th className="num">瓶颈</th><th className="num">待实施</th><th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.lines.map((l) => (
                    <tr key={`${l.tenant_id}|${l.line_id}`} className="pick"
                      onClick={() => onOpenLine(l.line_id)} title="点击进入该产线总览">
                      <td><b>{l.line_name}</b><div className="muted mono">{l.line_id}</div></td>
                      <td>{l.company}</td><td>{l.region}</td><td>{l.process_type}</td>
                      <td>{l.product_type}{l.product_project && l.product_project !== '-' ? ` · ${l.product_project}` : ''}</td>
                      <td className="num">{l.station_count}</td>
                      <td className="num"><span className={`tag ${rateCls(l.balance_rate)}`}>{l.balance_rate}%</span></td>
                      <td className="num">{l.avg_va_pct}%</td>
                      <td className="num" style={{ color: l.bottleneck_count > 0 ? 'var(--red)' : undefined, fontWeight: l.bottleneck_count > 0 ? 700 : undefined }}>{l.bottleneck_count || '—'}</td>
                      <td className="num">{l.imp_pending || '—'}</td>
                      <td className="muted">{fmtTime(l.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
              规则版本：VA {summary.rule_versions.va_rules} · 浪费 {summary.rule_versions.waste_triggers}（口径与单工位分析一致）
            </p>
          </div>
        </>
      )}
    </div>
  );
}
