import { compile } from '../../core/rules/dsl';
import { VA_MARKER_RE, normalizeDesc, round1, round2 } from '../../core/shared/util';

/**
 * 智能分析引擎（MVP analysis/engine.js 1:1 平移）。
 * 纪律：纯函数——规则集由调用方注入（RulesService 双源加载结果），
 * 计算口径（CT/VA 归类/浪费阈值/平衡率/瓶颈）与 MVP 逐字一致。
 */

const MARK_RE = VA_MARKER_RE;

function ctxOf(el: any, sameDescCount: number): Record<string, any> {
  return {
    type: el.type,
    dur_s: Number(el.dur_s),
    std_time: Number(el.std_time),
    start_ms: Number(el.start_ms),
    hand: el.hand,
    desc: el.desc,
    element_id: el.element_id,
    seq: el.seq,
    same_desc_count: sameDescCount,
  };
}

function descKey(el: any): string {
  return `${el.type}|${normalizeDesc(el.desc)}`;
}

function countByDesc(elements: any[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const el of elements) {
    const key = descKey(el);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** VA 归类：标记优先（人工裁决）→ 例外规则（按序首个命中）→ 类型默认 */
export function classifyElements(elements: any[], vaRules: any): any[] {
  const counts = countByDesc(elements);

  return elements.map((el) => {
    const same = counts.get(descKey(el)) ?? 1;
    const ctx = ctxOf(el, same);
    if (MARK_RE.test(String(el.desc ?? ''))) {
      return { ...el, va_effective: el.va_class, va_confidence: 'human', va_reason: '人工改判/确认（desc标记）', rule_id: null };
    }
    const rule = (vaRules?.types ?? []).find((t: any) => t.type === el.type);
    if (!rule) return { ...el, va_effective: el.va_class, va_confidence: 'low', va_reason: '无匹配规则', rule_id: null };
    for (const exception of rule.exceptions ?? []) {
      let hit = false;
      try { hit = compile(exception.when)(ctx); } catch { hit = false; }
      if (hit) {
        return {
          ...el,
          va_effective: exception.result,
          va_confidence: exception.confidence ?? 'low',
          va_reason: exception.reason ?? '',
          rule_id: rule.id,
        };
      }
    }
    return { ...el, va_effective: rule.default, va_confidence: rule.confidence ?? 'high', va_reason: rule.reason ?? '', rule_id: rule.id };
  });
}

function fill(template: string, vars: Record<string, unknown>): string {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
}

function compare(value: number, op: string, target: number): boolean {
  switch (op) {
    case '>=': return value >= target;
    case '>': return value > target;
    case '<=': return value <= target;
    case '<': return value < target;
    case '=': return Number(value) === Number(target);
    default: return false;
  }
}

/** 6 类浪费触发器（元素级 + 工位级聚合），输出证据与涉及要素（文档02 §3） */
export function detectWastes(active: any[], ct: number, wasteRules: any): any[] {
  const out: any[] = [];
  const counts = countByDesc(active);

  for (const trigger of wasteRules?.triggers ?? []) {
    if (trigger.level === 'element') {
      for (const el of active) {
        const same = counts.get(descKey(el)) ?? 1;
        let hit = false;
        try { hit = compile(trigger.when)(ctxOf(el, same)); } catch { hit = false; }
        if (!hit) continue;
        const dur = Number(el.dur_s);
        const pct = ct > 0 ? round1((dur / ct) * 100) : 0;
        out.push({
          id: trigger.id,
          waste: trigger.waste,
          level: 'element',
          element_ids: [el.element_id],
          seqs: [el.seq],
          involved_s: round2(dur),
          pct,
          evidence: fill(trigger.evidence, {
            dur_s: round2(dur), element_id: el.element_id, pct, desc: el.desc, count: same, sum: round2(dur * same),
          }),
        });
      }
      continue;
    }

    const matched = active.filter((el) => {
      try { return compile(trigger.agg.filter)(ctxOf(el, counts.get(descKey(el)) ?? 1)); } catch { return false; }
    });
    if (matched.length === 0) continue;
    const sum = round2(matched.reduce((acc, el) => acc + Number(el.dur_s), 0));
    const count = matched.length;
    const pct = ct > 0 ? round1((sum / ct) * 100) : 0;
    let hit = false;
    if (trigger.agg.count) hit = compare(count, trigger.agg.op, trigger.agg.value);
    else if (trigger.agg.ratioOf === 'CT') hit = compare(pct / 100, trigger.agg.op, trigger.agg.value);
    else hit = compare(sum, trigger.agg.op, trigger.agg.value);
    if (!hit) continue;
    out.push({
      id: trigger.id,
      waste: trigger.waste,
      level: 'station',
      element_ids: matched.map((el) => el.element_id),
      seqs: matched.map((el) => el.seq),
      involved_s: sum,
      pct,
      evidence: fill(trigger.evidence, { sum, count, pct, dur_s: sum, element_id: '-', desc: '-' }),
    });
  }
  return out;
}

function gapsOf(list: { start_ms: number; end_ms: number }[]): { start_ms: number; end_ms: number; dur_s: number }[] {
  const gaps: { start_ms: number; end_ms: number; dur_s: number }[] = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i + 1].start_ms > list[i].end_ms) {
      gaps.push({ start_ms: list[i].end_ms, end_ms: list[i + 1].start_ms, dur_s: round2((list[i + 1].start_ms - list[i].end_ms) / 1000) });
    }
  }
  return gaps;
}

function intersect(gapsA: { start_ms: number; end_ms: number }[], gapsB: { start_ms: number; end_ms: number }[]) {
  const out: { start_ms: number; end_ms: number; dur_s: number }[] = [];
  for (const a of gapsA) {
    for (const b of gapsB) {
      const start = Math.max(a.start_ms, b.start_ms);
      const end = Math.min(a.end_ms, b.end_ms);
      if (end > start) out.push({ start_ms: start, end_ms: end, dur_s: round2((end - start) / 1000) });
    }
  }
  return out.sort((x, y) => x.start_ms - y.start_ms);
}

/** 双手作业图数据（文档02 §7） */
export function handsChart(elements: any[]): any {
  const rows: Record<string, any[]> = { L: [], R: [], B: [] };
  for (const el of elements) {
    const start = Number(el.start_ms);
    const end = start + Math.round(Number(el.dur_s) * 1000);
    rows[el.hand]?.push({
      element_id: el.element_id, seq: el.seq, desc: el.desc, type: el.type,
      va: el.va_effective ?? el.va_class, start_ms: start, end_ms: end,
    });
  }
  for (const key of Object.keys(rows)) rows[key].sort((a, b) => a.start_ms - b.start_ms);
  return {
    L: rows.L,
    R: rows.R,
    B: rows.B,
    cycle_ms: Math.max(0, ...Object.values(rows).flat().map((b) => b.end_ms)),
    idle: { L: gapsOf(rows.L), R: gapsOf(rows.R), both: intersect(gapsOf(rows.L), gapsOf(rows.R)) },
  };
}

/**
 * 单工位分析：口径 CT=Σ生效且非异常要素 ST（v2.1 补丁#3）。
 * @param station 工位行（tt 字段为节拍；version 为当前版本指针）
 * @param elements 当前版本全部要素（含异常）
 */
export function analyzeStation(station: any, elements: any[], vaRules: any, wasteRules: any): any {
  const classified = classifyElements(elements, vaRules);
  const active = classified.filter((el) => Number(el.outlier_flag) === 0);
  const ct = round2(active.reduce((acc, el) => acc + Number(el.std_time), 0));
  const sums: Record<string, number> = { VA: 0, RNVA: 0, NVA: 0 };
  for (const el of active) sums[el.va_effective] = (sums[el.va_effective] ?? 0) + Number(el.std_time);
  const pct = (value: number) => (ct > 0 ? round1((value / ct) * 100) : 0);
  const wastes = detectWastes(active, ct, wasteRules);
  const pending = classified.filter((el) => Number(el.outlier_flag) === 0 && el.va_confidence === 'low' && !MARK_RE.test(String(el.desc ?? '')));
  const outliers = classified
    .filter((el) => Number(el.outlier_flag) === 1)
    .map((el) => ({ element_id: el.element_id, seq: el.seq, type: el.type, desc: el.desc, dur_s: Number(el.dur_s), std_time: Number(el.std_time), reason: el.outlier_reason }));

  const tt = Number(station.tt ?? 0);
  return {
    station,
    elements: classified,
    metrics: {
      ct,
      tt,
      tt_gap: round2(ct - tt),
      element_count: active.length,
      va: round2(sums.VA),
      rnva: round2(sums.RNVA),
      nva: round2(sums.NVA),
      va_pct: pct(sums.VA),
      rnva_pct: pct(sums.RNVA),
      nva_pct: pct(sums.NVA),
      outlier_count: outliers.length,
      outlier_s: round2(outliers.reduce((acc, el) => acc + Number(el.std_time), 0)),
    },
    wastes,
    pending,
    outliers,
    hands: handsChart(classified),
  };
}

/**
 * 产线分析：山积图 + 平衡率 + 瓶颈榜（文档02 §4-§6）。
 * @param rows 工位行（含各自当前版本要素），由 Service 层按租户加载后注入
 */
export function buildLineAnalysis(lineId: string, rows: { station: any; elements: any[] }[], vaRules: any, wasteRules: any): any {
  if (rows.length === 0) throw new Error(`产线 ${lineId} 无工位`);

  const lineRows = rows.map(({ station, elements }) => {
    const analysis = analyzeStation(station, elements, vaRules, wasteRules);
    return {
      station_id: station.station_id,
      name: station.name,
      version: station.version,
      ct_s: analysis.metrics.ct,
      tt_s: analysis.metrics.tt,
      va_s: analysis.metrics.va,
      rnva_s: analysis.metrics.rnva,
      nva_s: analysis.metrics.nva,
      va_pct: analysis.metrics.va_pct,
      element_count: elements.length,
      outlier_count: analysis.metrics.outlier_count,
      waste_count: analysis.wastes.length,
      is_bottleneck: false,
    };
  });

  const maxCt = Math.max(0, ...lineRows.map((r) => r.ct_s));
  for (const row of lineRows) row.is_bottleneck = maxCt > 0 && Math.abs(row.ct_s - maxCt) < 1e-6;
  const total = round2(lineRows.reduce((acc, r) => acc + r.ct_s, 0));
  const balanceRate = maxCt > 0 ? round1((total / (maxCt * lineRows.length)) * 100) : 0;
  const tt = lineRows[0]?.tt_s ?? 0;
  const bottleneck = [...lineRows]
    .sort((a, b) => (b.ct_s - b.tt_s) - (a.ct_s - a.tt_s))
    .slice(0, 5)
    .map((row) => ({
      station_id: row.station_id,
      name: row.name,
      ct_s: row.ct_s,
      tt_s: row.tt_s,
      gap_s: round2(row.ct_s - row.tt_s),
      va_pct: row.va_pct,
      waste_count: row.waste_count,
    }));

  return {
    line_id: lineId,
    tt_s: tt,
    station_count: lineRows.length,
    balance_rate: balanceRate,
    rows: lineRows,
    bottleneck,
    totals: {
      ct_s: total,
      va_s: round2(lineRows.reduce((acc, r) => acc + r.va_s, 0)),
      rnva_s: round2(lineRows.reduce((acc, r) => acc + r.rnva_s, 0)),
      nva_s: round2(lineRows.reduce((acc, r) => acc + r.nva_s, 0)),
      outlier_count: lineRows.reduce((acc, r) => acc + r.outlier_count, 0),
    },
  };
}
