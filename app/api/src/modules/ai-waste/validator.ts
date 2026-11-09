/**
 * P3-9 浪费识别校验引擎（独立实现，不 import ai-suggest——边界铁律：
 * 两条 AI 线各自维护校验规则，避免一改全改的耦合）。
 *
 * v3.45：WASTE_PROMPT_VERSION 'WV1'→'WV2'（提示词首行按来源线措辞 + 异常点线索段；
 * W1-W3 规则逻辑零改——outlier seq 不在 ctx.elements 中，引用即被 W1.3 自然拦截）。
 *
 * 输入：LLM 原始条目（数字字段已剥除——铁律②）。
 * 输出：浪费点 + 问题清单条目（数字全部服务端算）。
 *
 * W1 结构与枚举：W1.1 Schema / W1.2 waste_type 动态白名单 / W1.3 seq 引用防幻觉
 *                / W1.4 文本长度 / W1.5 去重
 * W2 业务边界：  W2.1 VA 禁 Eliminate（改善建议不得取消增值动作）
 *                / W2.2 ECRS 枚举 / W2.3 suggestion 长度
 * W3 交叉一致：  W3.1 单要素引用 ≤2 条 / W3.2 批量上界 / W3.3 evidence 非空
 */
import { round2 } from '../../core/shared/util';

export const WASTE_PROMPT_VERSION = 'WV2';

/** 动态白名单入参 */
export interface WasteCheckContext {
  /** 当前版本 active 要素（seq → element 映射的来源） */
  elements: { seq: number; type: string; va_class: string; dur_s: number; std_time: number; desc: string }[];
  ct: number;
  wasteWhitelist: string[];
  /** 批量上界（条数） */
  issueCeiling: number;
}

/** LLM 原始浪费点（剥数字后） */
export interface RawFinding {
  element_seqs: number[];
  waste_type: string;
  evidence: string;
}

/** LLM 原始问题条目（剥数字后） */
export interface RawIssue {
  element_seqs: number[];
  waste_type: string;
  problem: string;
  ecrs: string;
  suggestion: string;
}

export interface TraceItem {
  round: 'W1' | 'W2' | 'W3';
  rule: string;
  hit: boolean;
  reason: string;
}

/** 校验后浪费点（severity/involved_s/pct_of_ct 由服务层计算补齐） */
export interface CheckedFinding {
  raw: RawFinding;
  seqs: number[];
  waste_type: string;
  evidence: string;
  involved_s: number;
  pct_of_ct: number;
  severity: number;
  trace: TraceItem[];
}

/** 校验后问题条目（est_save_s/priority/tier 由服务层计算补齐） */
export interface CheckedIssue {
  raw: RawIssue;
  seqs: number[];
  waste_type: string;
  problem: string;
  ecrs: string;
  suggestion: string;
  involvedStd: number;
  est_save_s: number;
  trace: TraceItem[];
}

export interface WasteCheckResult {
  findings: CheckedFinding[];
  issues: CheckedIssue[];
  trace: TraceItem[];
  batchBlocked: string | null;
}

/** 提取 ECRS 动作词（W2.2 语义兜底：取消/合并/重排/简化四类） */
export function parseEcrs(text: string): 'E' | 'C' | 'R' | 'S' {
  if (/(取消|删除|免除|省略|免掉)/.test(text)) return 'E';
  if (/(合并|整合|一次多件|兼)/.test(text)) return 'C';
  if (/(重排|调序|移位|并行|重排布|布局)/.test(text)) return 'R';
  return 'S';
}

/** severity 分档（服务端计算，非 LLM 产出）：pct_of_ct ≥15% 严重 / ≥8% 一般 / 其余轻微 */
export function severityOf(pctOfCt: number): number {
  if (pctOfCt >= 15) return 3;
  if (pctOfCt >= 8) return 2;
  return 1;
}

/**
 * 校验主入口。raws 已剥数字（铁律②）；本函数不信任任何 LLM 数值字段。
 */
export function checkWastePayload(
  rawFindings: RawFinding[],
  rawIssues: RawIssue[],
  ctx: WasteCheckContext,
): WasteCheckResult {
  const trace: TraceItem[] = [];
  const bySeq = new Map<number, { seq: number; va_class: string; std_time: number }>(
    ctx.elements.map((e) => [e.seq, e]),
  );

  // W3 前置：无要素 / CT 无效 → 整批阻断
  if (ctx.elements.length === 0 || !(ctx.ct > 0)) {
    trace.push({ round: 'W3', rule: 'W3.0', hit: true, reason: '工位无有效要素或 CT<=0，整批阻断' });
    return { findings: [], issues: [], trace, batchBlocked: '工位无有效 AI 要素（须先在 AI 自动分解页写入要素），不能识别浪费' };
  }

  const whitelist = new Set(ctx.wasteWhitelist);
  const findings: CheckedFinding[] = [];
  const seenFinding = new Set<string>();

  // ── 浪费点校验 ──
  for (const f of rawFindings) {
    // W1.1 Schema
    const shapeOk = Array.isArray(f?.element_seqs) && f.element_seqs.length > 0
      && typeof f?.waste_type === 'string' && f.waste_type.trim().length > 0
      && typeof f?.evidence === 'string' && f.evidence.trim().length > 0;
    if (!shapeOk) {
      trace.push({ round: 'W1', rule: 'W1.1', hit: true, reason: '浪费点 Schema 缺必填字段' });
      continue;
    }
    // W1.2 白名单
    const wt = f.waste_type.trim();
    if (!whitelist.has(wt)) {
      trace.push({ round: 'W1', rule: 'W1.2', hit: true, reason: `waste_type「${wt}」不在动态白名单` });
      continue;
    }
    // W1.3 引用防幻觉
    const seqs = [...new Set(f.element_seqs.map(Number))].filter((q) => bySeq.has(q));
    if (seqs.length === 0) {
      trace.push({ round: 'W1', rule: 'W1.3', hit: true, reason: `浪费点「${wt}」引用的要素 seq 全部不存在` });
      continue;
    }
    if (seqs.length < f.element_seqs.filter(Number.isFinite).length) {
      trace.push({ round: 'W1', rule: 'W1.3', hit: false, reason: '部分引用不存在已裁剪（保留有效引用）' });
    }
    // W1.4 evidence 长度
    const evidence = String(f.evidence).trim().slice(0, 250);
    if (evidence.length < 6) {
      trace.push({ round: 'W1', rule: 'W1.4', hit: true, reason: `evidence 过短（${evidence.length} 字）` });
      continue;
    }
    // W1.5 去重
    const dupKey = `${seqs.slice().sort((a, b) => a - b).join(',')}|${wt}`;
    if (seenFinding.has(dupKey)) {
      trace.push({ round: 'W1', rule: 'W1.5', hit: true, reason: '重复浪费点（同要素集+同类型）' });
      continue;
    }
    seenFinding.add(dupKey);

    // 数字计算（铁律②）：involved_s = Σ 有效要素 dur_s；pct_of_ct = involved/CT×100
    const involvedS = round2(seqs.reduce((acc, q) => acc + Number(bySeq.get(q)!.std_time), 0));
    const pctOfCt = round2(ctx.ct > 0 ? (involvedS / ctx.ct) * 100 : 0);
    findings.push({
      raw: f, seqs, waste_type: wt, evidence,
      involved_s: involvedS, pct_of_ct: pctOfCt, severity: severityOf(pctOfCt),
      trace: [{ round: 'W2', rule: 'W2.3', hit: false, reason: '浪费点通过（evidence 非空、白名单内、引用有效）' }],
    });
  }

  // W3.2 批量上界（浪费点）：>30 条裁剪
  let keptFindings = findings;
  if (findings.length > 30) {
    trace.push({ round: 'W3', rule: 'W3.2', hit: true, reason: `浪费点 ${findings.length} 条超上界 30，保留前 30` });
    keptFindings = findings.slice(0, 30);
  }

  // ── 问题清单校验 ──
  const issues: CheckedIssue[] = [];
  const seenIssue = new Set<string>();
  const seqIssueCount = new Map<number, number>();
  for (const it of rawIssues) {
    // W1.1 Schema
    const shapeOk = Array.isArray(it?.element_seqs) && it.element_seqs.length > 0
      && typeof it?.waste_type === 'string' && it.waste_type.trim().length > 0
      && typeof it?.problem === 'string' && typeof it?.suggestion === 'string';
    if (!shapeOk) {
      trace.push({ round: 'W1', rule: 'W1.1', hit: true, reason: '问题条目 Schema 缺必填字段' });
      continue;
    }
    // W1.2 白名单
    const wt = it.waste_type.trim();
    if (!whitelist.has(wt)) {
      trace.push({ round: 'W1', rule: 'W1.2', hit: true, reason: `问题条目 waste_type「${wt}」不在动态白名单` });
      continue;
    }
    // W1.3 引用
    const seqs = [...new Set(it.element_seqs.map(Number))].filter((q) => bySeq.has(q));
    if (seqs.length === 0) {
      trace.push({ round: 'W1', rule: 'W1.3', hit: true, reason: `问题「${wt}」引用的要素 seq 全部不存在` });
      continue;
    }
    // W1.4 文本：problem/suggestion ≥8 字 ≤200
    const problem = String(it.problem).trim().slice(0, 250);
    const suggestion = String(it.suggestion).trim().slice(0, 250);
    if (problem.length < 8 || suggestion.length < 8) {
      trace.push({ round: 'W1', rule: 'W1.4', hit: true, reason: `problem/suggestion 过短（${problem.length}/${suggestion.length} 字）` });
      continue;
    }
    // W1.5 去重
    const dupKey = `${seqs.slice().sort((a, b) => a - b).join(',')}|${wt}|${problem.slice(0, 24)}`;
    if (seenIssue.has(dupKey)) {
      trace.push({ round: 'W1', rule: 'W1.5', hit: true, reason: '重复问题条目' });
      continue;
    }
    seenIssue.add(dupKey);

    // W2.1 VA 禁 E：目标要素全 VA 且动作=取消 → 剔除
    const ecrs = parseEcrs(String(it.ecrs ?? '') + String(it.suggestion ?? ''));
    const allVa = seqs.every((q) => bySeq.get(q)!.va_class === 'VA');
    if (allVa && ecrs === 'E') {
      trace.push({ round: 'W2', rule: 'W2.1', hit: true, reason: `VA 要素禁止取消（E）——问题「${problem.slice(0, 16)}…」剔除` });
      continue;
    }
    // W2.3 批量上界（问题清单）
    if (seqIssueCount.size > ctx.issueCeiling) continue; // 已超上界静默截断（配合 W3.1 轮末裁剪）

    const involvedStd = round2(seqs.reduce((acc, q) => acc + Number(bySeq.get(q)!.std_time), 0));
    for (const q of seqs) seqIssueCount.set(q, (seqIssueCount.get(q) ?? 0) + 1);
    issues.push({
      raw: it, seqs, waste_type: wt, problem, ecrs, suggestion,
      involvedStd, est_save_s: 0,
      trace: [{ round: 'W2', rule: 'W2.2', hit: false, reason: `ECRS=${ecrs}（语义解析）通过` }],
    });
  }

  // W3.1 单要素引用 ≤2 条（超出按出现序裁剪）
  const keptIssues: typeof issues = [];
  const perSeq = new Map<number, number>();
  for (const it of issues) {
    if (it.seqs.every((q) => (perSeq.get(q) ?? 0) < 2)) {
      keptIssues.push(it);
      for (const q of it.seqs) perSeq.set(q, (perSeq.get(q) ?? 0) + 1);
    } else {
      trace.push({ round: 'W3', rule: 'W3.1', hit: true, reason: `问题「${it.problem.slice(0, 16)}…」单要素引用超 2 条，裁剪` });
    }
  }
  // W3.2 问题清单上界
  const finalIssues = keptIssues.length > ctx.issueCeiling ? keptIssues.slice(0, ctx.issueCeiling) : keptIssues;
  if (keptIssues.length > ctx.issueCeiling) {
    trace.push({ round: 'W3', rule: 'W3.2', hit: true, reason: `问题清单 ${keptIssues.length} 条超上界 ${ctx.issueCeiling}，裁剪` });
  }

  return { findings: keptFindings, issues: finalIssues, trace, batchBlocked: null };
}
