/**
 * AI 建议三轮校验引擎（合并实施规格书 §2，全部确定性可计算）。
 * 纯函数：规则集/要素/分析结果由调用方注入；处置写 validation_trace。
 *
 * R1 结构与引用：R1.1 Schema / R1.2 枚举（method、difficulty、factor 六档动态、waste_type 动态白名单）
 *               / R1.3 引用 / R1.4 文本 / R1.5 去重
 * R2 业务逻辑：  R2.1 VA+E→剔除；R2.2 RNVA+E 依据校验（缺→降级 S）+条件词加签
 *               / R2.3 NVA 分型（可避免放行、不可避免剔除）/ R2.4 est_save_s 语义+上界防御
 *               / R2.5 矛盾检测 / R2.6 收益一致性
 * R3 交叉一致：  R3.1 总量 / R3.2 单要素≤2 / R3.3 单一浪费≤60% / R3.4 证据再核对 / R3.5 工位有效
 *
 * 铁律：禁用 src/core/shared/util.ts WASTE_TYPES 常量（缺「预对」）——白名单动态计算。
 */
import { round2 } from '../../core/shared/util';

export const PROMPT_VERSION = 'PV1';

/** 条件词正则（R2.2）：命中 → risk_flags += needs_quality_redline（正交加签，不剔除） */
const CONDITIONAL_RE = /(若|如|经确认|评估后|不影响)/;
/** 收益一致性（R2.6）：measure 自夸高优先但计算 tier 不到 P1 → manual_review */
const URGENT_RE = /(紧急|高优先|重点)/;

export interface RuleEntry { json: any; version: string }

export interface ValidationElement {
  element_id: string;
  seq: number;
  type: string;
  va_class: string;        // 生效 VA（va_effective 优先）
  dur_s: number;
  std_time: number;
  hand: string;
  desc: string;
}

export interface ValidationContext {
  elements: ValidationElement[];        // 当前版本全量 active 要素（analyzeStation 口径）
  ct: number;                            // station CT（analysis.metrics.ct）
  wastes: { waste: string; element_ids: string[] }[];  // analysis.wastes（证据）
  factorSet: number[];                   // factor 六档（ecrsa_map.mappings[].factor 去重，P0-1）
  wasteWhitelist: string[];              // 动态白名单（P1-1）
  customDict: { dict_type: string; code: string; name: string; va_class: string | null; method_hint: string | null; action_class: string | null }[];
  batchCeiling: number;                  // AI_BATCH_CEILING（默认 0.5）
}

export type Disposition = 'pass' | 'drop' | 'downgrade_s' | 'flag';

export interface TraceItem {
  round: 'R1' | 'R2' | 'R3';
  rule: string;
  hit: boolean;
  disposition: Disposition;
  reason: string;
}

export interface RawSuggestion {
  element_seqs: number[];
  waste_type: string;
  method: string;
  factor?: number;
  measure: string;
  eliminate_basis?: string;
  verif?: number;
}

/** LLM 原始条目剥数字后的校验产物（est_save_s 等服务端字段另行计算） */
export interface ValidatedItem {
  raw: RawSuggestion;
  element_ids: string[];
  waste_type: string;
  method: string;
  action_class: string;
  measure: string;
  eliminate_basis: string | null;
  difficulty: number;
  factor: number;
  verif: number;
  involvedStd: number;
  est_save_s: number;
  risk_flags: string[];
  trace: TraceItem[];
}

export interface ValidationResult {
  items: ValidatedItem[];
  trace: TraceItem[];
  batchBlocked: string | null;  // R3.5：ct<=0 → 整批 400 拦截原因
}

/** action_class 词典解析（规格书 R2.5；默认简化） */
const ACTION_DICT: [string, RegExp][] = [
  ['取消', /(取消|删除|免掉|去除|省略)/],
  ['合并', /(合并|整合|一次多件|一次取多件)/],
  ['压缩', /(压缩|缩短|减小)/],
  ['重排', /(重排|调序|并行|移入|布局)/],
  ['自动化', /(自动化|治具|夹具|专机|机械手)/],
];

export function parseActionClass(measure: string): string {
  for (const [name, re] of ACTION_DICT) if (re.test(String(measure))) return name;
  return '简化';
}

/** 目标要素集合的「最保守」VA 归类：全 VA→VA；含 NVA→NVA；否则 RNVA（边界规则按最严执行） */
function effectiveVaOf(els: ValidationElement[]): string {
  const set = new Set(els.map((e) => e.va_class));
  if (set.size === 1) return [...set][0];
  if (set.has('NVA')) return 'NVA';
  return 'RNVA';
}

/**
 * 三轮校验主入口。
 * 输入 rawSuggestions 已剥数字字段（铁律②）；本函数不信任任何服务端数值字段。
 */
export function validateSuggestions(
  rawSuggestions: RawSuggestion[],
  ctx: ValidationContext,
): ValidationResult {
  const trace: TraceItem[] = [];
  const items: ValidatedItem[] = [];
  const bySeq = new Map<number, ValidationElement>(ctx.elements.map((e) => [e.seq, e]));

  // —— R3.5 工位有效（前置：ct<=0 整批阻断 400，规格书 R3.5）——
  if (!(ctx.ct > 0)) {
    trace.push({ round: 'R3', rule: 'R3.5', hit: true, disposition: 'drop', reason: '工位 CT<=0，整批阻断' });
    return { items: [], trace, batchBlocked: '工位无有效 CT（要素缺失或全异常），不能生成 AI 建议' };
  }

  // 自定义 waste_type 名 → 声明（code/name 双向映射）
  const customByName = new Map(ctx.customDict.filter((d) => d.dict_type === 'waste_type').map((d) => [d.name, d]));
  const whitelist = new Set(ctx.wasteWhitelist);
  for (const d of customByName.keys()) whitelist.add(d);

  const seenKeys = new Set<string>();
  const seqCount = new Map<number, number>();
  const passed: ValidatedItem[] = [];

  for (let idx = 0; idx < rawSuggestions.length; idx++) {
    const s = rawSuggestions[idx];
    const t: TraceItem[] = [];

    // —— R1.1 Schema：必填字段（eliminate_basis 不在此强制——裁决 3：缺依据在 R2 按 VA 类分流，
    //    RNVA+E 缺依据→降级 S / 可避免 NVA+E 缺依据→剔除 / VA+E→R2.1 剔除）——
    const shapeOk = Array.isArray(s?.element_seqs) && s.element_seqs.length > 0
      && typeof s.waste_type === 'string' && s.waste_type.trim().length > 0
      && typeof s.method === 'string' && typeof s.measure === 'string';
    if (!shapeOk) {
      trace.push({ round: 'R1', rule: 'R1.1', hit: true, disposition: 'drop', reason: 'Schema 缺必填字段' });
      continue;
    }

    // —— R1.2 枚举：method / factor 六档（P0-1，仅非 E 类——E 类 factor 忽略恒 1.0，裁决 9 配套）
    //    / waste_type 动态白名单（P1-1）——
    if (!['E', 'C', 'R', 'S'].includes(s.method)) {
      trace.push({ round: 'R1', rule: 'R1.2', hit: true, disposition: 'drop', reason: `method=${s.method} 不在 {E,C,R,S}` });
      continue;
    }
    const factor = s.method === 'E' ? 1 : Number(s.factor);
    if (s.method !== 'E' && !ctx.factorSet.includes(factor)) {
      trace.push({ round: 'R1', rule: 'R1.2', hit: true, disposition: 'drop', reason: `factor=${s.factor} 不在动态档位 [${ctx.factorSet.join(',')}]` });
      continue;
    }
    if (!whitelist.has(s.waste_type.trim())) {
      trace.push({ round: 'R1', rule: 'R1.2', hit: true, disposition: 'drop', reason: `waste_type「${s.waste_type}」不在动态白名单（内置∪租户自定义）` });
      continue;
    }
    // verif 自评 1/2/3，非法回退 2
    const verif = [1, 2, 3].includes(Number(s.verif)) ? Number(s.verif) : 2;

    // —— R1.3 引用：seq ∈ 输入集（防幻觉）——
    const seqs = [...new Set(s.element_seqs.map(Number))];
    if (seqs.some((q) => !bySeq.has(q))) {
      const bad = seqs.filter((q) => !bySeq.has(q)).join(',');
      trace.push({ round: 'R1', rule: 'R1.3', hit: true, disposition: 'drop', reason: `引用不存在的要素 seq=${bad}` });
      continue;
    }
    const targetEls = seqs.map((q) => bySeq.get(q)!);

    // —— R1.4 文本：10≤trim(measure)≤200；E 类 eliminate_basis≥8 字（裁决 3）——
    const measure = String(s.measure).trim();
    if (measure.length < 10 || measure.length > 200) {
      trace.push({ round: 'R1', rule: 'R1.4', hit: true, disposition: 'drop', reason: `measure 长度 ${measure.length} 越界 [10,200]` });
      continue;
    }
    const eliminateBasis = s.eliminate_basis ? String(s.eliminate_basis).trim() : null;

    // —— R1.5 去重 ——
    const dupKey = `${seqs.slice().sort((a, b) => a - b).join(',')}|${s.waste_type}|${s.method}`;
    if (seenKeys.has(dupKey)) {
      trace.push({ round: 'R1', rule: 'R1.5', hit: true, disposition: 'drop', reason: '重复建议（同要素集+浪费+方法）' });
      continue;
    }
    seenKeys.add(dupKey);

    // 到此 R1 全过，构造半成品
    const actionClass = parseActionClass(measure);
    const involvedStd = round2(targetEls.reduce((acc, el) => acc + Number(el.std_time), 0));
    const effVa = effectiveVaOf(targetEls);
    const riskFlags: string[] = [];
    const item: ValidatedItem = {
      raw: s, element_ids: targetEls.map((e) => e.element_id), waste_type: s.waste_type.trim(),
      method: s.method, action_class: actionClass, measure, eliminate_basis: eliminateBasis,
      difficulty: 1, factor, verif, involvedStd, est_save_s: 0, risk_flags: riskFlags, trace: t,
    };

    // —— R2.1 VA 边界：VA+E → 剔除（VA 禁取消，不论依据）——
    if (effVa === 'VA' && s.method === 'E') {
      trace.push({ round: 'R2', rule: 'R2.1', hit: true, disposition: 'drop', reason: 'VA 要素禁止 E（取消=改产品定义）' });
      continue;
    }

    // —— R2.2 RNVA 边界（裁决 3）：RNVA+E 依据≥8 字 → 放行；缺 → 降级 S（不剔除）——
    const hasBasis = (eliminateBasis?.length ?? 0) >= 8;
    if (effVa === 'RNVA' && item.method === 'E') {
      if (hasBasis) {
        t.push({ round: 'R2', rule: 'R2.2', hit: true, disposition: 'pass', reason: 'RNVA 根因消除型（依据齐备）' });
      } else {
        t.push({ round: 'R2', rule: 'R2.2', hit: true, disposition: 'downgrade_s', reason: 'RNVA+E 缺根因消除依据 → 降级 S' });
        item.method = 'S';
        // 降级后按折算类计：factor 取条目自带合法档，否则最浅档（最大值，保守压缩）
        item.factor = ctx.factorSet.includes(factor) ? factor : Math.max(...ctx.factorSet);
      }
    }
    // 条件词正则命中 → needs_quality_redline（正交加签，不剔除）
    if (CONDITIONAL_RE.test(measure)) {
      riskFlags.push('needs_quality_redline');
      t.push({ round: 'R2', rule: 'R2.2', hit: true, disposition: 'flag', reason: 'measure 含条件词 → 加签 needs_quality_redline（转人工）' });
    }

    // —— R2.3 NVA 分型（裁决 3）：不可避免+E → 剔除提示改 R；可避免+E 须依据（缺 → 剔除）——
    if (effVa === 'NVA' && item.method === 'E') {
      // 不可避免 NVA 识别：类型含「不可避免延迟」或 waste=等待 且要素类型为不可避免延迟/等待
      const inevitable = targetEls.every((e) => e.type === '不可避免延迟' || e.type === '休息')
        || (item.waste_type === '等待' && targetEls.some((e) => e.type === '不可避免延迟'));
      if (inevitable) {
        trace.push({ round: 'R2', rule: 'R2.3', hit: true, disposition: 'drop', reason: '不可避免 NVA 禁 E（靠重排/宽放覆盖），提示改 R' });
        continue;
      }
      if (!hasBasis) {
        trace.push({ round: 'R2', rule: 'R2.3', hit: true, disposition: 'drop', reason: '可避免 NVA+E 缺根因消除依据（裁决 3：缺依据剔除）' });
        continue;
      }
      t.push({ round: 'R2', rule: 'R2.3', hit: true, disposition: 'pass', reason: '可避免 NVA 允许 E（依据齐备，分型消除）' });
    }

    // —— R2.4 est_save_s 语义（P0-4）：E=ΣST×1.0 全额（含 M01 持住）；S/C/R=ΣST×factor；上界防御 ≤ΣST ——
    // 按「生效 method」计算（R2.2 降级条目按折算，不用原始 E）
    const computed = item.method === 'E' ? involvedStd : round2(involvedStd * item.factor);
    if (computed > involvedStd + 0.001) {
      trace.push({ round: 'R2', rule: 'R2.4', hit: true, disposition: 'drop', reason: 'est_save_s 超越 ΣST 上界（防御性剔除）' });
      continue;
    }
    item.est_save_s = computed;
    item.difficulty = item.method === 'E' ? difficultyForE(item.waste_type) : difficultyForFold(item.waste_type, item.factor);

    // —— R2.5 矛盾检测：同 seq 出现在 ≥2 条，E×S 互斥保留 priority 高者（E×C 合法共存）——
    // 检测与既有条目的冲突（暂记，轮末裁决；此处先记冲突对，归一化后按 raw_priority 裁决）
    const conflictsWith = passed.filter((p) => p.element_ids.some((id) => item.element_ids.includes(id)));
    if (conflictsWith.length > 0) {
      const mutual = conflictsWith.some((p) => {
        const pair = [p.method, s.method];
        return pair.includes('E') && pair.some((m) => m === 'S' || (m === 'E' && pair[0] !== pair[1]));
      });
      if (mutual) t.push({ round: 'R2', rule: 'R2.5', hit: true, disposition: 'flag', reason: '同要素 E×S 互斥候选（轮末按 priority 裁决）' });
    }

    // —— R2.6 收益一致性：measure 自夸 + tier≠P1 → manual_review（tier 计算后在服务层补判）——
    if (URGENT_RE.test(measure)) {
      riskFlags.push('urgent_claim');
      t.push({ round: 'R2', rule: 'R2.6', hit: true, disposition: 'flag', reason: 'measure 含紧急/高优先措辞 → 归一化后核对 tier' });
    }

    passed.push(item);
  }

  // 批次上界（R2.4 后半）：Σest_save_s > ceiling×CT → exceeds_batch_ceiling（转人工不剔除，P1-5）
  const sumSave = round2(passed.reduce((acc, i) => acc + i.est_save_s, 0));
  if (sumSave > ctx.batchCeiling * ctx.ct) {
    for (const p of passed) p.risk_flags.push('exceeds_batch_ceiling');
    trace.push({ round: 'R2', rule: 'R2.4', hit: true, disposition: 'flag', reason: `批次 Σest_save_s=${sumSave}s 超过 ${ctx.batchCeiling}×CT=${round2(ctx.batchCeiling * ctx.ct)}s → 转人工` });
  }

  // —— R2.5 轮末裁决：E×S 互斥同要素，保留 raw_priority（est_save_s/difficulty）高者 ——
  const rawPr = (i: ValidatedItem) => i.est_save_s / i.difficulty;
  const dropped: ValidatedItem[] = [];
  for (let a = 0; a < passed.length; a++) {
    for (let b = a + 1; b < passed.length; b++) {
      const x = passed[a]; const y = passed[b];
      if (!x.element_ids.some((id) => y.element_ids.includes(id))) continue;
      const pair = [x.method, y.method];
      const mutual = (pair.includes('E') && pair.includes('S'));
      if (!mutual) continue; // E×C 合法共存（取消+相邻合并）
      const loser = rawPr(x) >= rawPr(y) ? y : x;
      if (!dropped.includes(loser)) dropped.push(loser);
    }
  }
  for (const loser of dropped) {
    loser.trace.push({ round: 'R2', rule: 'R2.5', hit: true, disposition: 'drop', reason: 'E×S 互斥冲突，保留 raw_priority 高者' });
    trace.push({ round: 'R2', rule: 'R2.5', hit: true, disposition: 'drop', reason: `建议「${loser.measure.slice(0, 20)}…」E×S 互斥被剔除` });
  }
  const survivors = passed.filter((p) => !dropped.includes(p));

  // —— R3.1 总量：count ≤ min(20, max(5, 2×|analysis.wastes|))，超限按估算收益降序保留 ——
  const nMax = Math.min(20, Math.max(5, 2 * ctx.wastes.length));
  if (survivors.length > nMax) {
    const sorted = [...survivors].sort((a, b) => rawPr(b) - rawPr(a));
    for (const over of sorted.slice(nMax)) {
      over.trace.push({ round: 'R3', rule: 'R3.1', hit: true, disposition: 'drop', reason: `超出总量上限 ${nMax}` });
    }
    trace.push({ round: 'R3', rule: 'R3.1', hit: true, disposition: 'drop', reason: `候选 ${survivors.length} 条 > 上限 ${nMax}，按收益降序保留` });
  }
  let r3 = survivors.sort((a, b) => rawPr(b) - rawPr(a)).slice(0, nMax);

  // —— R3.2 单要素 ≤2 条（保留收益最高 2 条）——
  const perSeq = new Map<string, ValidatedItem[]>();
  for (const it of r3) for (const id of it.element_ids) perSeq.set(id, [...(perSeq.get(id) ?? []), it]);
  const dropOver2 = new Set<ValidatedItem>();
  for (const [, list] of perSeq) {
    if (list.length <= 2) continue;
    const sorted = [...new Set(list)].sort((a, b) => rawPr(b) - rawPr(a));
    for (const over of sorted.slice(2)) dropOver2.add(over);
  }
  if (dropOver2.size > 0) {
    trace.push({ round: 'R3', rule: 'R3.2', hit: true, disposition: 'drop', reason: `单要素 >2 条候选，剔除 ${dropOver2.size} 条` });
    for (const over of dropOver2) over.trace.push({ round: 'R3', rule: 'R3.2', hit: true, disposition: 'drop', reason: '单要素候选数超 2，保留收益最高 2 条' });
    r3 = r3.filter((i) => !dropOver2.has(i));
  }

  // —— R3.3 分布：单一 waste_type ≤ 60%×count ——
  if (r3.length >= 2) {
    const cap = Math.floor(r3.length * 0.6);
    const byType = new Map<string, ValidatedItem[]>();
    for (const it of r3) byType.set(it.waste_type, [...(byType.get(it.waste_type) ?? []), it]);
    const dropDist = new Set<ValidatedItem>();
    for (const [wt, list] of byType) {
      if (list.length <= cap) continue;
      for (const over of [...list].sort((a, b) => rawPr(b) - rawPr(a)).slice(cap)) dropDist.add(over);
    }
    if (dropDist.size > 0) {
      trace.push({ round: 'R3', rule: 'R3.3', hit: true, disposition: 'drop', reason: `单一 waste_type 超 60% 上限，剔除 ${dropDist.size} 条` });
      for (const over of dropDist) over.trace.push({ round: 'R3', rule: 'R3.3', hit: true, disposition: 'drop', reason: `「${over.waste_type}」分布超 60% 上限` });
      r3 = r3.filter((i) => !dropDist.has(i));
    }
  }

  // —— R3.4 证据再核对：waste_type ∈ analysis.wastes，或自定义声明 va_class ∩ 目标要素 va_class ≠ ∅ ——
  // v3.48：规则引擎零命中（ctx.wastes 为空）时不做证据门——
  //   根因（BJFA1/ST010 实证）：现行 waste_triggers 仅覆盖 移物/可避免延迟/寻找/选择/检查/持住，
  //   拿取/放置/清洁等类型全域无触发器，规则证据恒空 → 提示词明确邀请的「最多 5 条明显异常建议」
  //   被 R3.4 整批剔除 → done_empty（0 条，LLM tokens 已计费）。这与方案文档
  //   《动作要素浪费识别与改善措施实施方案》§1/§3「0 命中不等于无浪费」的裁定直接冲突。
  //   防幻觉不失控：R1.3 已校验 element_seqs 全部存在于输入表；提示词已约束「无明显异常返回 []」。
  const evidenceWastes = new Set(ctx.wastes.map((w) => w.waste));
  const noRuleEvidence = evidenceWastes.size === 0;
  const finalItems: ValidatedItem[] = [];
  for (const it of r3) {
    if (evidenceWastes.has(it.waste_type)) {
      it.trace.push({ round: 'R3', rule: 'R3.4', hit: false, disposition: 'pass', reason: 'waste_type 与分析证据一致' });
      finalItems.push(it);
      continue;
    }
    const decl = customByName.get(it.waste_type);
    const declVa = decl?.va_class ?? 'RNVA'; // 未声明按 RNVA 保守处理
    const intersect = it.element_ids.some((id) => ctx.elements.find((e) => e.element_id === id)?.va_class === declVa);
    if (intersect) {
      it.trace.push({ round: 'R3', rule: 'R3.4', hit: false, disposition: 'pass', reason: `自定义类型「${it.waste_type}」声明 va_class=${declVa} 与目标要素有交集` });
      finalItems.push(it);
    } else if (noRuleEvidence) {
      it.trace.push({ round: 'R3', rule: 'R3.4', hit: false, disposition: 'pass', reason: '规则引擎无浪费证据：按 LLM 识别放行（要素引用已由 R1.3 校验）' });
      finalItems.push(it);
    } else {
      it.trace.push({ round: 'R3', rule: 'R3.4', hit: true, disposition: 'drop', reason: `「${it.waste_type}」无分析证据且自定义声明 VA 无交集` });
      trace.push({ round: 'R3', rule: 'R3.4', hit: true, disposition: 'drop', reason: `建议「${it.measure.slice(0, 20)}…」证据不足被剔除` });
    }
  }

  // R2.6 收益一致性补判（tier 已可算）：urgent_claim 且归一化后 tier≠P1 → manual_review
  return { items: finalItems, trace, batchBlocked: null };
}

/** E 类 difficulty：按浪费类型经验初值（治具类 2 / 流程类 1 / 布局类 2） */
function difficultyForE(wasteType: string): number {
  if (wasteType === '检验冗余' || wasteType === '等待') return 1;
  if (wasteType === '搬运') return 2;
  return 2;
}

/** 折算类 difficulty：factor 越小（压缩越深）工程改动越大 → 难度越高 */
function difficultyForFold(wasteType: string, factor: number): number {
  if (factor <= 0.4) return 2;
  return wasteType === '等待' ? 3 : 2;
}
