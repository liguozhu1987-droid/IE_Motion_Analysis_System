/**
 * AI 建议数字计算（规格书 §3，铁律②：LLM 禁产数字，全部服务端计算）。
 *
 * - est_save_s：见 validator R2.4（E 全额 / S-C-R 折算）
 * - annual_yuan：仅 params（rate/daily_output）完整时按现公式；未配置 → null+提示，永无假金额（P0-5）
 * - priority：现引擎公式 raw_priority=(est_save_s×日频次)÷difficulty（日频次兜底=1 仅限优先级），
 *   批内归一化×100；tier=P1≥60/P2≥30/P3<30（P0-2 不引入 P0；史稿加权公式整体删除——决策③）
 * - 红线未确认 → tier 不得 P1；V 作同 priority 次级排序键
 */
import { round2 } from '../../core/shared/util';
import { ValidatedItem } from './validator';

export interface ComputeParams {
  dailyOutput: number | null;   // null=未配置（无假金额）
  rateYuanPerHour: number | null;
  realizationRate: number | null; // 落地率（getLineParams 兜底 0.7 由调用方传入）
}

export interface ScoredSuggestion {
  est_save_s: number;
  annual_yuan: number | null;
  raw_priority: number;
  priority: number;
  tier: 'P1' | 'P2' | 'P3';
}

/** 年化收益 = 节省秒数×日产量×365×费率(元/工时)÷3600×落地率（compare/engine.ts 同口径） */
export function estimateAnnualYuan(estSaveS: number, p: ComputeParams): number | null {
  if (p.dailyOutput === null || p.rateYuanPerHour === null) return null;
  if (estSaveS <= 0) return null;
  const land = p.realizationRate ?? 0.7;
  return round2((estSaveS * p.dailyOutput * 365 * p.rateYuanPerHour / 3600) * land);
}

/**
 * 批内打分：raw_priority 归一化×100 → P1/P2/P3；V 次级排序键在服务层排序使用。
 * 红线未确认的条目（needs_quality_redline）tier 封顶 P2（规格书 §3）。
 */
export function scoreBatch(items: ValidatedItem[], p: ComputeParams): ScoredSuggestion[] {
  const freq = p.dailyOutput ?? 1; // 日频次兜底=1 仅限优先级（金额仍按无假金额阻断）
  const raws = items.map((i) => round2((i.est_save_s * freq) / i.difficulty));
  const max = raws.length > 0 ? Math.max(...raws, 0.01) : 1;
  return items.map((i, k) => {
    const priority = Math.round((raws[k] / max) * 100);
    let tier: 'P1' | 'P2' | 'P3' = priority >= 60 ? 'P1' : priority >= 30 ? 'P2' : 'P3';
    if (tier === 'P1' && i.risk_flags.includes('needs_quality_redline')) tier = 'P2'; // 红线未确认 → 封顶 P2
    return {
      est_save_s: i.est_save_s,
      annual_yuan: estimateAnnualYuan(i.est_save_s, p),
      raw_priority: raws[k],
      priority,
      tier,
    };
  });
}

/** 批内排序：priority 降序 → V 降序（次级键，规格书决策③） */
export function sortWithVerif<T extends { priority: number; verif: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.priority - a.priority) || (b.verif - a.verif));
}

/** max_tokens = min(4000, 1600+60×要素数)（v3.36：上限 2000→4000、基数 800→1600——推理模型即使关闭思维链仍可能留少量 reasoning 预算，content 需足额） */
export function maxTokensFor(elementCount: number): number {
  return Math.min(4000, 1600 + 60 * Math.max(1, elementCount));
}
