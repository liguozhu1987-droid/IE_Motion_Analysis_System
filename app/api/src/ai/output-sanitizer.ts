/**
 * AI 输出消毒器：落实铁律②「数字由规则算、LLM 不产数字」。
 * - 润色类任务：输出含阿拉伯数字 → 判定失败 → 回退模板文案
 * - 长度截断 ≤200 字；去首尾空白
 */
export interface SanitizeResult { ok: boolean; text: string; reason?: string; }

export function sanitizePolishOutput(raw: string, fallback: string, maxLen = 200): SanitizeResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, text: fallback, reason: 'empty' };
  if (/\d/.test(text)) return { ok: false, text: fallback, reason: 'llm_output_contains_digits' };
  if (text.length > maxLen) return { ok: true, text: text.slice(0, maxLen) };
  return { ok: true, text };
}

/** 建议卡润色的 system prompt（契约：只润色 measure 文案，禁止改动/输出任何数字） */
export const POLISH_SYSTEM_PROMPT = [
  '你是工业工程（IE）改善建议的文案编辑。用户会给你一条结构化改善建议卡（JSON）。',
  '你的唯一任务：把 measure 字段改写得更专业、具体、可执行。',
  '铁律：',
  '1. 禁止输出任何阿拉伯数字、百分号、单位数值；所有量化信息必须原样保留在 JSON 数字字段中。',
  '2. 禁止改变建议的技术含义、ECRS 方法归类、涉及要素。',
  '3. 输出为一段连续中文，不超过 200 字，不要标题、不要列表符号。',
].join('\n');

export function buildPolishUserPrompt(card: Record<string, unknown>): string {
  return `请润色以下建议卡的 measure 文案：\n${JSON.stringify(card, null, 2)}\n只输出润色后的 measure 文本。`;
}
