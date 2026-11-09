import { useEffect, useMemo, useState } from 'react';
import type { DashboardFilters, DashboardSummary } from '../api';
import { IconMenu } from './Icons';

interface Props {
  /** 无筛选维度字典（树结构数据源：区域/公司/产线全集） */
  dim: DashboardSummary | null;
  filters: DashboardFilters;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 点击区域/公司行 = 加筛选（下钻即筛选） */
  onFilter: (patch: Partial<DashboardFilters>) => void;
  /** 点击产线行 = 进入该产线总览（L2） */
  onOpenLine: (lineId: string) => void;
}

/**
 * 左侧集团树（v3.3 L1 专用，OTRS10 式）：区域 → 公司 → 产线三级。
 * 与产线模式树（StationTree）互为双模式：本模式回答"数据分布在哪些区域/公司/产线"，
 * 点击任一级即把该维度加为筛选（面包屑同步显示下钻路径）。
 */
export default function GroupTree({ dim, filters, collapsed, onToggleCollapse, onFilter, onOpenLine }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const regions = useMemo(() => dim?.by_region ?? [], [dim]);
  const companies = useMemo(() => dim?.by_company ?? [], [dim]);
  const lines = useMemo(() => dim?.lines ?? [], [dim]);

  /* 当前筛选涉及的区域/公司默认展开 */
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (filters.region) next.add(`r:${filters.region}`);
      if (filters.company) next.add(`c:${filters.company}`);
      return next;
    });
  }, [filters.region, filters.company]);

  const toggle = (key: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  if (collapsed) {
    return (
      <aside className="sider sider-mini">
        <button className="sider-toggle" title="展开集团树" onClick={onToggleCollapse}><IconMenu /></button>
        <div className="sider-mini-lines">
          {regions.map((r) => (
            <button key={r.region} className="sider-mini-line"
              title={`${r.region}（${r.company_count} 公司 / ${r.station_count} 工位）`}
              onClick={() => onFilter({ region: filters.region === r.region ? undefined : r.region })}>
              {r.region.slice(0, 2)}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="sider">
      <div className="sider-head">
        <span>大区 / 公司 / 产线</span>
        <button className="sider-toggle" title="收起集团树" onClick={onToggleCollapse}>⇤</button>
      </div>
      <div className="sider-body">
        {regions.length === 0 && <div className="sider-empty">暂无数据<br />（灌入演示或真实分解后出现）</div>}
        {/* v3.25 层级配置化：大区/公司 = CMC 派生（factories.region/name），公司键改公司名 */}
        {regions.map((r) => {
          const rKey = `r:${r.region}`;
          const rOpen = expanded.has(rKey);
          const rSel = filters.region === r.region;
          return (
            <div key={r.region} className="tree-group">
              <div className={`tree-line${rSel ? ' on' : ''}`} onClick={() => onFilter({ region: rSel ? undefined : r.region })}>
                <span className="tree-caret" onClick={(e) => { e.stopPropagation(); toggle(rKey); }}>{rOpen ? '▾' : '▸'}</span>
                <span className="tree-line-name">{r.region}</span>
                <span className="tree-count">{r.company_count}司/{r.station_count}位</span>
              </div>
              {rOpen && companies.filter((c) => c.region === r.region).map((c) => {
                const cKey = `c:${c.company}`;
                const cOpen = expanded.has(cKey);
                const cSel = filters.company === c.company;
                return (
                  <div key={c.company}>
                    <div className={`tree-sub${cSel ? ' on' : ''}`} onClick={() => onFilter({ company: cSel ? undefined : c.company })}>
                      <span className="tree-caret" onClick={(e) => { e.stopPropagation(); toggle(cKey); }}>{cOpen ? '▾' : '▸'}</span>
                      <span className="tree-line-name">{c.company}</span>
                      <span className="tree-count">{c.line_count}线/{c.station_count}位</span>
                    </div>
                    {cOpen && lines.filter((l) => l.company === c.company).map((l) => (
                      <div key={l.line_id} className="tree-leaf" onClick={() => onOpenLine(l.line_id)}
                        title={`${l.line_name}（${l.line_id}）· 平衡率 ${l.balance_rate}%`}>
                        <span className={`dot ${l.balance_rate >= 85 ? 'dot-teal' : l.balance_rate >= 70 ? 'dot-blue' : 'dot-gray'}`} />
                        <span className="tree-station-name">{l.line_name}</span>
                        <span className="tree-ct">{l.station_count}位</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="sider-foot">
        <span className="muted" style={{ fontSize: 12 }}>点击区域/公司 = 筛选<br />点击产线 = 进产线总览</span>
      </div>
    </aside>
  );
}
