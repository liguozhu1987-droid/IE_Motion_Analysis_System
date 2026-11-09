import { normalizeDesc, round2, similarity } from '../../core/shared/util';

/**
 * 前后对比配对引擎（MVP compare/service.js 1:1 平移，纯函数）。
 * 三层配对：L1 同类型+描述归一化全等（exact）/ L2 同类型+相似度≥0.75（partial）/
 *           L3 未匹配 = 消除（removed）。
 * 工位级 ΔCT 为权威口径，要素级仅作归因。
 */

export interface PairSide {
  element_id: string;
  seq: number;
  type: string;
  desc: string;
  hand: string;
  dur_s: number;
  std_time: number;
  va_class: string;
}

export interface Pair {
  prev: PairSide | null;
  curr: PairSide | null;
  quality: 'success' | 'partial' | 'unmatched';
  rule: string;
  delta_std: number;
  referenced: boolean;
}

function slim(el: any): PairSide {
  return {
    element_id: el.element_id,
    seq: el.seq,
    type: el.type,
    desc: el.desc,
    hand: el.hand,
    dur_s: Number(el.dur_s),
    std_time: Number(el.std_time),
    va_class: el.va_effective ?? el.va_class,
  };
}

export interface PairingResult {
  pairs: Pair[];
  added: PairSide[];
  removed: PairSide[];
  pairing_rate: number;
}

export function pairElements(prevActive: any[], currActive: any[], referencedIds: Set<string>): PairingResult {
  const used = new Set<string>();
  const pairs: Pair[] = [];

  for (const prevEl of prevActive) {
    let match = currActive.find((c) => !used.has(c.element_id)
      && c.type === prevEl.type && normalizeDesc(c.desc) === normalizeDesc(prevEl.desc));
    let quality: 'success' | 'partial' = 'success';
    let rule = 'exact';
    if (!match) {
      const candidates = currActive
        .filter((c) => !used.has(c.element_id) && c.type === prevEl.type)
        .map((c) => ({ el: c, sim: similarity(c.desc, prevEl.desc) }))
        .sort((a, b) => b.sim - a.sim);
      if (candidates[0] && candidates[0].sim >= 0.75) {
        match = candidates[0].el;
        quality = 'partial';
        rule = `similarity:${round2(candidates[0].sim)}`;
      }
    }
    if (!match) {
      pairs.push({
        prev: slim(prevEl), curr: null, quality: 'unmatched', rule: 'removed',
        delta_std: round2(Number(prevEl.std_time)), referenced: referencedIds.has(prevEl.element_id),
      });
      continue;
    }
    used.add(match.element_id);
    pairs.push({
      prev: slim(prevEl),
      curr: slim(match),
      quality,
      rule,
      delta_std: round2(Number(prevEl.std_time) - Number(match.std_time)),
      referenced: referencedIds.has(prevEl.element_id),
    });
  }

  const added = currActive.filter((c) => !used.has(c.element_id)).map(slim);
  const removed = pairs.filter((p) => p.quality === 'unmatched').map((p) => p.prev as PairSide);
  const matched = pairs.filter((p) => p.quality !== 'unmatched').length;
  const pairingRate = pairs.length > 0 ? Math.round((matched / pairs.length) * 100) : 0;

  return { pairs, added, removed, pairing_rate: pairingRate };
}

export interface LineBenefitParams {
  daily_output: number;
  rate_yuan_per_hour: number;
  realization_rate: number;
  configured_by: string | null;
  configured_at: string | null;
}

/**
 * 从 benefit_params 规则集取产线参数。兼容两种历史形态：
 *   lines[]（v3.0 API 在线发布形态）/ by_line{}（MVP 配置文件形态）。
 * 费率与日产量无默认值：缺失或非法 → 返回 null（阻止收益计算）。
 */
export function getLineParams(json: any, lineId: string): LineBenefitParams | null {
  const fromLines = (json?.lines ?? []).find((l: any) => l?.line_id === lineId);
  const raw = fromLines ?? json?.by_line?.[lineId] ?? null;
  if (!raw) return null;
  const dailyOutput = Number(fromLines ? raw.daily_output : raw.daily_output);
  const rate = Number(fromLines ? raw.rate_yuan_per_hour : raw.rate_yuan_per_hour);
  const realization = Number(fromLines ? (raw.land_rate ?? 0.7) : (raw.realization_rate ?? 0.7));
  if (!Number.isFinite(dailyOutput) || dailyOutput <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isFinite(realization) || realization <= 0 || realization > 1) return null;
  return {
    daily_output: dailyOutput,
    rate_yuan_per_hour: rate,
    realization_rate: realization,
    configured_by: raw.configured_by ?? null,
    configured_at: raw.configured_at ?? null,
  };
}

/** 年化收益 = 节省秒数 × 日产量 × 365 × 费率(元/工时) ÷ 3600 × 落地率（文档03 §4） */
export function estimateBenefit(deltaCt: number, params: LineBenefitParams): Record<string, unknown> {
  return {
    saved_s_per_unit: deltaCt,
    daily_output: params.daily_output,
    rate_yuan_per_hour: params.rate_yuan_per_hour,
    realization_rate: params.realization_rate,
    annual_yuan: round2((deltaCt * params.daily_output * 365 * params.rate_yuan_per_hour / 3600) * params.realization_rate),
    formula: '节省秒数×日产量×365×费率(元/工时)÷3600×落地率',
    configured_by: params.configured_by,
    configured_at: params.configured_at,
  };
}
