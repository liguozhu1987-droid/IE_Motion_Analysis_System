/**
 * P3-9 浪费识别系统提示词（prompt_version='WV2'，v3.45 手工分解线）。
 *
 * 语料基础：平台既有 6 类浪费触发器（waste_triggers WT01-WT12）+ ECRS 四动作。
 * 硬约束（铁律②继承）：输出严格 JSON；禁止输出任何秒数/百分比/优先级数字——
 * involved_s/pct_of_ct/severity/est_save_s/priority/tier 全部由服务端计算。
 *
 * 边界声明：本提示词服务于工位动作要素表的浪费识别（P3-9 AI 自动分解线 +
 * v3.45 手工分解线，两线共用 WV2 单一语境，由 decomposition_source 标注来源），
 * 与分解工作台 AI 建议模块（ai-suggest）互不引用。
 */

/** 系统提示词：一次调用同时产出「浪费点」与「改善问题清单」（两次调用成本翻倍且上下文割裂，不取） */
export const WASTE_SYSTEM_PROMPT = `你是资深 IE 改善专家。基于工位的动作要素表，完成两件事：
1. 识别浪费点（findings）：指出哪些要素构成浪费、证据是什么；
2. 生成改善问题清单（issues）：每个浪费点对应可验证的问题描述与改善建议。

【浪费分类体系】（waste_type 只允许输出下列中文名）：
W1 持住：手当夹具用、无加工意图的持续握持（信号：持住要素、扶住/手持描述）
W2 重复取放：同对象多次取放/多余取放（信号：同描述计数≥2且描述含对象、单循环取放偏多；纯动词描述无对象信息不判重复）
W3 搬运：有/无负载移动、长距或往返（信号：移物≥2s、往返/再次/回取描述）
W4 等待：人等料/等设备/无谓空等（信号：可避免延迟要素、等机器/等传送描述）
W5 寻找选择：目视寻找、辨认、挑选对象（信号：寻找/发现/选择要素、混料）
W6 检验冗余：无依据重复检验（信号：同描述检验计数≥2、检查类要素占比高）
W7 动作浪费：走动/转身/弯腰/大臂伸展/往返等身体移位与姿态变更（信号：走动/转身/弯腰要素、描述含大臂/往返/再次/回取——布局/工装/供料优化可消除，均为潜在改善机会）

【ECRS 改善方向】suggestion 中体现：E 取消（仅限非增值动作）/ C 合并 / R 重排 / S 简化。
VA（增值）动作只能 S（路径/工装简化），禁止建议取消或改写产品定义。

【操作异常点规则】输入中如出现「操作异常点」段：这些要素已标记异常、不计入 CT、
不得在 element_seqs 中引用，仅可作为识别线索——引用异常点序号的条目无效，
异常点也不得计入任何时长/占比类结论。

【输出格式】严格 JSON 对象（不是数组）：
{"findings":[{"element_seqs":[序号],"waste_type":"白名单中文名","evidence":"6~200字中文证据，引用要素描述"}],"issues":[{"element_seqs":[序号],"waste_type":"白名单中文名","problem":"8~200字问题描述","ecrs":"E|C|R|S","suggestion":"8~200字改善建议，具体可落地"}]}
- element_seqs 只能引用输入要素表中存在的 seq；findings 每类浪费点到 ≤10 条、issues 合计 ≤12 条
- evidence 必须引用要素表中的实际描述，不允许编造
- issues 应覆盖 findings 的主要浪费点；无浪费时两个数组都返回 []

【绝对禁止】输出任何秒数/百分比/严重度/优先级数字——浪费时长、占比、严重度、优先级、预计节省全部由服务端计算，输出即作废。除 JSON 外不要输出任何其他文字。`;

/** 紧凑要素负载 */
export interface WasteCompactElement {
  seq: number; type: string; va_class: string; dur_s: number; hand: string; desc: string;
}

/** 操作异常点线索（outlier_flag=1）：仅作识别线索，不进 CT、禁引用、禁计入任何计算 */
export interface WasteOutlierHint {
  seq: number; type: string; desc: string; reason: string;
}

export interface WasteUserPayload {
  station_id: string;
  ct: number; tt: number;
  elements: WasteCompactElement[];
  waste_whitelist: string[];
  /** 要素来源线：首行措辞随源切换（v3.45） */
  decomposition_source: 'ai_assisted' | 'manual';
  /** 异常点线索段（可选；非空时追加段落，明示仅线索/禁引用/不计 CT） */
  outliers?: WasteOutlierHint[];
  /**
   * v3.51 知识库检索命中（可选）：本工位/通用经验，按关键词+要素类型打分取 Top-N。
   * 注入语义仅为「参考启发」——AI 不得照抄，仍须引用本次要素表中的真实 seq 与描述。
   */
  kb_hints?: { findings: string[]; issues: string[] };
}

export function buildWasteUserPrompt(payload: WasteUserPayload): string {
  const lines: string[] = [];
  const srcLabel = payload.decomposition_source === 'manual' ? '手工分解' : 'AI 自动分解';
  lines.push(`工位 ${payload.station_id}（CT=${payload.ct}s / TT=${payload.tt}s，要素由 ${srcLabel}写入）`);
  lines.push('');
  lines.push('【要素表】seq | 类型 | VA | 时长s | 手 | 描述');
  for (const e of payload.elements) {
    lines.push(`${e.seq} | ${e.type} | ${e.va_class} | ${e.dur_s} | ${e.hand} | ${e.desc}`);
  }
  lines.push('');
  lines.push(`【waste_type 白名单】${payload.waste_whitelist.join('、')}`);
  if (payload.outliers && payload.outliers.length > 0) {
    lines.push('');
    lines.push('【操作异常点】以下要素已标记异常：不计入 CT、不得在 element_seqs 中引用，仅作识别线索。');
    lines.push('seq | 类型 | 描述 | 异常原因');
    for (const o of payload.outliers) {
      lines.push(`${o.seq} | ${o.type} | ${o.desc} | ${o.reason}`);
    }
  }
  // v3.51：知识库经验（人工录入 + 已确认条目沉淀）——只作启发，不得照抄
  const kb = payload.kb_hints;
  if (kb && (kb.findings?.length || kb.issues?.length)) {
    lines.push('');
    lines.push('【历史经验参考（知识库命中）】以下为本站/通用历史已识别浪费与已验证改善措施，仅供启发：');
    if (kb.findings.length > 0) {
      lines.push('历史浪费点：');
      for (const t of kb.findings) lines.push(`- ${t}`);
    }
    if (kb.issues.length > 0) {
      lines.push('历史改善措施：');
      for (const t of kb.issues) lines.push(`- ${t}`);
    }
    lines.push('要求：不得照抄历史条目，只可在本次要素表中真实存在同类现象时输出；'
      + 'element_seqs 仍只能引用本次要素表的 seq，evidence 仍须引用本次要素描述。');
  }
  lines.push('');
  lines.push('请输出 JSON 对象（无浪费时 {"findings":[],"issues":[]}）。');
  return lines.join('\n');
}

/** 从 LLM 文本提取 JSON 对象（容忍 markdown 围栏/前后缀文本） */
export function extractJsonObject(text: string): { findings?: any[]; issues?: any[] } | null {
  const t = String(text ?? '').replace(/```json/gi, '```').trim();
  const fenced = /```([\s\S]*?)```/.exec(t);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
