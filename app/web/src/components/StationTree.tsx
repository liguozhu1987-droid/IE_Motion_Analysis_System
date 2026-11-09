import { useEffect, useMemo, useState } from 'react';
import { api, type LineSummaryRow, type Station } from '../api';
import { useAuth } from '../auth';
import { IconMenu } from './Icons';

interface Props {
  /** 本租户全量工位（导航叶子节点） */
  stations: Station[];
  /** 产线概览（名称/平衡率/待办/分解进度）——导航元数据，来自 GET /lines/summary */
  lines: LineSummaryRow[];
  company: string;
  region: string | null;
  selectedLine: string;
  currentStationId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectLine: (line: string) => void;
  onOpenStation: (stationId: string) => void;
  canWrite: boolean;
  onCreateStation: () => void;
}

interface LineStat { elementCount: number; ct: number | null; }

/**
 * 左侧对象树（v3.6 · 工厂 → 产线 → 工位 三级）。
 * 信息分层：同一份数据，按角色给不同密度——
 *  · 管理层（group:read）：产线名 + 平衡率 + 瓶颈/待办徽标，可跳集团视图；
 *  · 执行层（suggestion:generate）：产线名 + 待办数，工位显示 CT；
 *  · 只读层：只有产线名与工位数，工位只显示状态点。
 * 默认只展开当前产线，其余折叠——先给"有哪些线"，详情按需展开。
 */
export default function StationTree(props: Props) {
  const { can } = useAuth();
  const { stations, lines, selectedLine, currentStationId, collapsed } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lineStats, setLineStats] = useState<Record<string, Record<string, LineStat>>>({});
  const [keyword, setKeyword] = useState('');

  const tier: 'manager' | 'planner' | 'viewer' = can('group:read')
    ? 'manager'
    : can('suggestion:generate') ? 'planner' : 'viewer';

  const grouped = useMemo(() => {
    const map = new Map<string, Station[]>();
    for (const s of stations) {
      const arr = map.get(s.line_id) ?? [];
      arr.push(s);
      map.set(s.line_id, arr);
    }
    return map;
  }, [stations]);

  /** 产线列表：优先用概览，缺失时回退到工位里出现过的线 */
  const lineList = useMemo(() => {
    if (lines.length > 0) return lines;
    return [...grouped.keys()].sort().map((id) => ({
      line_id: id, line_name: id, process_type: null, product_type: null, product_project: null,
      station_count: grouped.get(id)?.length ?? 0, decomposed_count: 0, retested_count: 0,
      balance_rate: 0, va_pct: 0, bottleneck_count: 0, imp_pending: 0, updated_at: null,
    } as LineSummaryRow));
  }, [lines, grouped]);

  const kw = keyword.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!kw) return lineList;
    return lineList.filter((l) => {
      if (l.line_name.toLowerCase().includes(kw) || l.line_id.toLowerCase().includes(kw)) return true;
      // 工位名命中时保留其产线
      return (grouped.get(l.line_id) ?? []).some((s) => s.name.toLowerCase().includes(kw) || s.station_id.toLowerCase().includes(kw));
    });
  }, [lineList, kw, grouped]);

  /* 默认展开选中产线；搜索时展开命中的产线 */
  useEffect(() => {
    if (selectedLine) setExpanded((prev) => new Set(prev).add(selectedLine));
  }, [selectedLine]);
  useEffect(() => {
    if (!kw) return;
    setExpanded(new Set(filtered.map((l) => l.line_id)));
  }, [kw, filtered]);

  /* 懒加载线分析（仅执行层需要工位 CT），按线缓存 */
  useEffect(() => {
    if (tier === 'viewer') return;
    const pending = [...expanded].filter((l) => !lineStats[l]);
    if (pending.length === 0) return;
    let alive = true;
    (async () => {
      for (const line of pending) {
        try {
          const la = await api.lineAnalysis(line);
          if (!alive) return;
          const map: Record<string, LineStat> = {};
          for (const r of la.rows) map[r.station_id] = { elementCount: r.element_count, ct: r.ct_s };
          setLineStats((prev) => ({ ...prev, [line]: map }));
        } catch { /* 无分析数据：不展示 CT */ }
      }
    })();
    return () => { alive = false; };
  }, [expanded, lineStats, tier]);

  const toggle = (line: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(line)) n.delete(line); else n.add(line); return n; });

  /* ---- 折叠迷你态：只给一个工厂入口 ---- */
  if (collapsed) {
    return (
      <aside className="sider sider-mini">
        <button className="sider-toggle" title="展开对象树" onClick={props.onToggleCollapse}><IconMenu /></button>
        <div className="sider-mini-lines">
          <button className="sider-mini-line" title={`${props.region ?? ''} ${props.company} · ${lineList.length} 条产线`}
            onClick={props.onToggleCollapse}>{(props.region ?? props.company).slice(0, 2)}</button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sider">
      {/* 工厂上下文（区域 · 公司）：回答"我在看哪个厂" */}
      <div className="sider-head">
        <span>对象浏览</span>
        <button className="sider-toggle" title="收起对象树" onClick={props.onToggleCollapse}>⇤</button>
      </div>
      <div className="sider-factory">
        <div className="sf-region">{props.region ?? '未分区'}</div>
        <div className="sf-company" title={props.company}>{props.company}</div>
        <div className="sf-meta">
          {lineList.length} 产线 · {stations.length} 工位
          {tier === 'manager' && <a className="sf-link" href="#/dashboard" title="跨公司聚合视图（只含汇总指标）">集团视图 →</a>}
        </div>
      </div>

      {/* 产线过滤：线多时才出现，避免常驻噪声 */}
      {lineList.length > 4 && (
        <div className="sider-search">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="筛选产线或工位…" />
          {keyword && <button className="ss-clear" onClick={() => setKeyword('')} title="清除">×</button>}
        </div>
      )}

      <div className="sider-body">
        {lineList.length === 0 && (
          <div className="sider-empty">
            本公司还没有产线工位
            {props.canWrite && <button className="btn sm primary" style={{ marginTop: 8, width: '100%' }} onClick={props.onCreateStation}>+ 新建工位</button>}
          </div>
        )}
        {filtered.length === 0 && lineList.length > 0 && (
          <div className="sider-empty">没有匹配「{keyword}」的产线或工位</div>
        )}

        {filtered.map((line) => {
          const lineStations = grouped.get(line.line_id) ?? [];
          const isOpen = expanded.has(line.line_id);
          const isSel = selectedLine === line.line_id;
          const ctOf = (id: string) => lineStats[line.line_id]?.[id]?.ct;
          return (
            <div key={line.line_id} className="tree-group">
              <div className={`tree-line${isSel ? ' on' : ''}`} onClick={() => props.onSelectLine(line.line_id)}
                title={`${line.line_name}（${line.line_id}）${line.process_type ? ' · ' + line.process_type : ''}`}>
                <span className="tree-caret" onClick={(e) => { e.stopPropagation(); toggle(line.line_id); }}>
                  {isOpen ? '▾' : '▸'}
                </span>
                <span className="tree-line-name">{line.line_name}</span>
                {tier === 'manager' && line.balance_rate > 0 && (
                  <span className={`tree-rate ${line.balance_rate >= 85 ? 'good' : line.balance_rate >= 70 ? 'mid' : 'bad'}`}
                    title={`线平衡率 ${line.balance_rate}%`}>{Math.round(line.balance_rate)}%</span>
                )}
                {tier !== 'viewer' && line.imp_pending > 0 && (
                  <span className="tree-todo" title={`${line.imp_pending} 条待实施建议`}>待{line.imp_pending}</span>
                )}
                <span className="tree-count">{line.station_count}</span>
              </div>

              {isOpen && (
                <>
                  {/* 展开后先给一行摘要（只读层也能看懂这条线处于什么状态） */}
                  <div className="tree-line-sub">
                    <span>{line.process_type ?? '工艺未标注'}{line.product_type ? ` · ${line.product_type}` : ''}</span>
                    <span className="tls-progress">已分解 {line.decomposed_count}/{line.station_count}</span>
                  </div>
                  {lineStations.map((s) => {
                    const ct = ctOf(s.station_id);
                    const decomposed = ct != null && ct > 0;
                    const dot = !decomposed ? 'gray' : s.version > 1 ? 'teal' : 'blue';
                    const active = currentStationId === s.station_id;
                    return (
                      <div key={s.station_id}
                        className={`tree-station${active ? ' on' : ''}`}
                        onClick={() => props.onOpenStation(s.station_id)}
                        title={`${s.name}（${s.station_id}）${decomposed ? ` · CT ${ct}s` : ' · 未分解'}`}>
                        <span className={`dot dot-${dot}`} />
                        <span className="tree-station-name">{s.name}</span>
                        {tier !== 'viewer' && decomposed && <span className="tree-ct">{ct!.toFixed(1)}s</span>}
                      </div>
                    );
                  })}
                  {lineStations.length === 0 && <div className="tree-leaf-empty">该线暂无工位</div>}
                </>
              )}
            </div>
          );
        })}
      </div>

      {props.canWrite && lineList.length > 0 && (
        <div className="sider-foot">
          <button className="btn sm" style={{ width: '100%' }} onClick={props.onCreateStation}>+ 新建工位</button>
        </div>
      )}
    </aside>
  );
}
