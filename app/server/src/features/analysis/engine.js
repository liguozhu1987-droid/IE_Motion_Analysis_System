import { loadRules } from '../../rules/rules.js';
import { testCondition } from '../../rules/dsl.js';
import { normalizeDesc, round1, round2 } from '../../shared/util.js';
import { getDb } from '../../db/index.js';
import { NotFoundError } from '../../errors.js';

const MARK_RE = /\[VA(改判|确认)\|/;

function ctxOf(el, sameDescCount) {
  return {
    type: el.type,
    dur_s: el.dur_s,
    std_time: el.std_time,
    start_ms: el.start_ms,
    hand: el.hand,
    desc: el.desc,
    element_id: el.element_id,
    seq: el.seq,
    same_desc_count: sameDescCount,
  };
}

function descKey(el) {
  return `${el.type}|${normalizeDesc(el.desc)}`;
}

/** VA 归类：标记优先（人工裁决）→ 例外规则（按序首个命中）→ 类型默认 */
export function classifyElements(elements) {
  const rules = loadRules();
  const counts = new Map();
  for (const el of elements) counts.set(descKey(el), (counts.get(descKey(el)) ?? 0) + 1);

  return elements.map((el) => {
    const same = counts.get(descKey(el)) ?? 1;
    const ctx = ctxOf(el, same);
    if (MARK_RE.test(el.desc)) {
      return { ...el, va_effective: el.va_class, va_confidence: 'human', va_reason: '人工改判/确认（desc标记）', rule_id: null };
    }
    const rule = rules.va.types.find((t) => t.type === el.type);
    if (!rule) return { ...el, va_effective: el.va_class, va_confidence: 'low', va_reason: '无匹配规则', rule_id: null };
    for (const exception of rule.exceptions ?? []) {
      let hit = false;
      try { hit = testCondition(exception.when, ctx); } catch { hit = false; }
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

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));
}

function compare(value, op, target) {
  switch (op) {
    case '>=': return value >= target;
    case '>': return value > target;
    case '<=': return value <= target;
    case '<': return value < target;
    case '=': return Number(value) === Number(target);
    default: return false;
  }
}

/** 6类浪费触发器（元素级 + 工位级聚合），输出证据与涉及要素（文档02 §3） */
export function detectWastes(active, ct) {
  const rules = loadRules();
  const out = [];
  const counts = new Map();
  for (const el of active) counts.set(descKey(el), (counts.get(descKey(el)) ?? 0) + 1);

  for (const trigger of rules.waste.triggers) {
    if (trigger.level === 'element') {
      for (const el of active) {
        const same = counts.get(descKey(el)) ?? 1;
        let hit = false;
        try { hit = testCondition(trigger.when, ctxOf(el, same)); } catch { hit = false; }
        if (!hit) continue;
        const pct = ct > 0 ? round1((el.dur_s / ct) * 100) : 0;
        out.push({
          id: trigger.id,
          waste: trigger.waste,
          level: 'element',
          element_ids: [el.element_id],
          seqs: [el.seq],
          involved_s: round2(el.dur_s),
          pct,
          evidence: fill(trigger.evidence, {
            dur_s: round2(el.dur_s), element_id: el.element_id, pct, desc: el.desc, count: same, sum: round2(el.dur_s * same),
          }),
        });
      }
      continue;
    }

    const matched = active.filter((el) => {
      try { return testCondition(trigger.agg.filter, ctxOf(el, counts.get(descKey(el)) ?? 1)); } catch { return false; }
    });
    if (matched.length === 0) continue;
    const sum = round2(matched.reduce((acc, el) => acc + el.dur_s, 0));
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

function gapsOf(list) {
  const gaps = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    if (list[i + 1].start_ms > list[i].end_ms) {
      gaps.push({ start_ms: list[i].end_ms, end_ms: list[i + 1].start_ms, dur_s: round2((list[i + 1].start_ms - list[i].end_ms) / 1000) });
    }
  }
  return gaps;
}

function intersect(gapsA, gapsB) {
  const out = [];
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
export function handsChart(elements) {
  const rows = { L: [], R: [], B: [] };
  for (const el of elements) {
    const start = el.start_ms;
    const end = el.start_ms + Math.round(el.dur_s * 1000);
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

/** 单工位分析：口径 CT=Σ生效且非异常要素ST（v2.1补丁#3） */
export function analyzeStation(station, elements) {
  const classified = classifyElements(elements);
  const active = classified.filter((el) => el.outlier_flag === 0);
  const ct = round2(active.reduce((acc, el) => acc + el.std_time, 0));
  const sums = { VA: 0, NNVA: 0, NVA: 0 };
  for (const el of active) sums[el.va_effective] = (sums[el.va_effective] ?? 0) + el.std_time;
  const pct = (value) => (ct > 0 ? round1((value / ct) * 100) : 0);
  const wastes = detectWastes(active, ct);
  const pending = classified.filter((el) => el.outlier_flag === 0 && el.va_confidence === 'low' && !MARK_RE.test(el.desc));
  const outliers = classified
    .filter((el) => el.outlier_flag === 1)
    .map((el) => ({ element_id: el.element_id, seq: el.seq, type: el.type, desc: el.desc, dur_s: el.dur_s, std_time: el.std_time, reason: el.outlier_reason }));

  return {
    station,
    elements: classified,
    metrics: {
      ct,
      tt: station.TT,
      tt_gap: round2(ct - station.TT),
      element_count: active.length,
      va: round2(sums.VA),
      nnva: round2(sums.NNVA),
      nva: round2(sums.NVA),
      va_pct: pct(sums.VA),
      nnva_pct: pct(sums.NNVA),
      nva_pct: pct(sums.NVA),
      outlier_count: outliers.length,
      outlier_s: round2(outliers.reduce((acc, el) => acc + el.std_time, 0)),
    },
    wastes,
    pending,
    outliers,
    hands: handsChart(classified),
  };
}

/** 产线分析：山积图 + 平衡率 + 瓶颈榜（文档02 §4-§6） */
export function analyzeLine(lineId) {
  const db = getDb();
  const stations = db.prepare('SELECT * FROM t_station WHERE line_id = ? ORDER BY station_id').all(lineId);
  if (stations.length === 0) throw new NotFoundError('产线', lineId);

  const rows = stations.map((station) => {
    const elements = db.prepare('SELECT * FROM t_element WHERE station_id = ? AND bol_version = ? ORDER BY seq').all(station.station_id, station.version);
    const analysis = analyzeStation(station, elements);
    return {
      station_id: station.station_id,
      name: station.name,
      version: station.version,
      ct_s: analysis.metrics.ct,
      tt_s: station.TT,
      va_s: analysis.metrics.va,
      nnva_s: analysis.metrics.nnva,
      nva_s: analysis.metrics.nva,
      va_pct: analysis.metrics.va_pct,
      outlier_count: analysis.metrics.outlier_count,
      waste_count: analysis.wastes.length,
      is_bottleneck: false,
    };
  });

  const maxCt = Math.max(0, ...rows.map((r) => r.ct_s));
  for (const row of rows) row.is_bottleneck = maxCt > 0 && Math.abs(row.ct_s - maxCt) < 1e-6;
  const total = round2(rows.reduce((acc, r) => acc + r.ct_s, 0));
  const balanceRate = maxCt > 0 ? round1((total / (maxCt * rows.length)) * 100) : 0;
  const tt = rows[0]?.tt_s ?? 0;
  const bottleneck = [...rows]
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
    station_count: rows.length,
    balance_rate: balanceRate,
    rows,
    bottleneck,
    totals: {
      ct_s: total,
      va_s: round2(rows.reduce((acc, r) => acc + r.va_s, 0)),
      nnva_s: round2(rows.reduce((acc, r) => acc + r.nnva_s, 0)),
      nva_s: round2(rows.reduce((acc, r) => acc + r.nva_s, 0)),
      outlier_count: rows.reduce((acc, r) => acc + r.outlier_count, 0),
    },
  };
}
