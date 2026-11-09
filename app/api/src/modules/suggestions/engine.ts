import { round2, today } from '../../core/shared/util';

/**
 * 改善建议引擎（MVP suggestions/service.js 1:1 平移，纯函数）。
 * 纪律：规则集（ecrsa_map / redline_keywords）由调用方注入；计算口径零变化。
 *
 * 生成口径（文档04 §1）：
 *   est_save_s = 证据涉及要素 std_time 合计 × factor（系数 0.3~0.8 经验初值）；
 *   优先级 = est_save_s × 日频次 ÷ difficulty，跨候选归一化 0~100；
 *   分档 ≥60 P1 / 30~59 P2 / <30 P3；降序输出。
 */

export interface Candidate {
  mapping_id: string | null;
  waste_type: string;
  method: string; // E|C|R|S
  measure: string;
  element_ids: string[];
  evidence: string;
  est_save_s: number;
  difficulty: number;
  note: string | null;
  manual?: boolean;
  raw_priority: number;
  priority: number; // 归一化 0~100
  tier: 'P1' | 'P2' | 'P3';
}

export interface RedlineConfirmation {
  name?: string;
  date?: string;
}

export interface AdoptConfirmations {
  quality?: RedlineConfirmation;
  ergonomics?: RedlineConfirmation;
}

export interface RedlineRequirement {
  type: 'quality' | 'ergonomics';
  message: string;
}

/** 候选草稿（入栈时未计算优先级，raw_priority/priority/tier 由归一化步骤补齐） */
type CandidateDraft = Omit<Candidate, 'raw_priority' | 'priority' | 'tier'>;

/**
 * 生成候选建议（不落库——铁律①：IE 确认采纳后才写 t_improvement）。
 * @param analysis   analyzeStation 结果（elements/wastes/metrics）
 * @param ecrsaRules ecrsa_map 规则集 JSON
 * @param dailyOutput 日产量（null=未配置，优先级按频次=1 计算）
 */
export function buildCandidates(analysis: any, ecrsaRules: any, dailyOutput: number | null): Candidate[] {
  const byId = new Map<string, any>((analysis.elements ?? []).map((el: any) => [el.element_id, el]));
  const candidates: Candidate[] = [];
  const push = (draft: CandidateDraft) => {
    const candidate = draft as Candidate;
    const dup = candidates.some((c) => c.mapping_id === candidate.mapping_id
      && c.element_ids.join(',') === candidate.element_ids.join(','));
    if (!dup) candidates.push(candidate);
  };

  for (const waste of analysis.wastes ?? []) {
    const mappings = (ecrsaRules?.mappings ?? []).filter((m: any) => m.waste === waste.waste);
    const involvedStd = round2((waste.element_ids ?? []).reduce((acc: number, id: string) => acc + (byId.get(id)?.std_time ?? 0), 0));
    if (mappings.length === 0) {
      // 检验冗余无标准映射：按需追加人工评估项（并在建议书上标注）
      if (waste.waste === '检验冗余') {
        push({
          mapping_id: null,
          waste_type: waste.waste,
          method: 'E',
          measure: '取消重复确认/合并检验（须品质确认）',
          element_ids: waste.element_ids ?? [],
          evidence: waste.evidence,
          est_save_s: round2(involvedStd * 0.5),
          difficulty: 1,
          note: '无标准ECRSA映射，需人工评估（红线：须品质确认）',
          manual: true,
        });
      }
      continue;
    }
    for (const mapping of mappings) {
      push({
        mapping_id: mapping.id,
        waste_type: waste.waste,
        method: mapping.method,
        measure: mapping.measure,
        element_ids: waste.element_ids ?? [],
        evidence: waste.evidence,
        est_save_s: round2(involvedStd * mapping.factor),
        difficulty: mapping.difficulty,
        note: mapping.note,
      });
    }
  }

  // 定位专项（M06 对称防呆 / M09 来料定向）：定位要素 ST≥2s（文档04 §1 M09；动素三分法后"预对"归入"定位"）
  const preAlign = (analysis.elements ?? []).filter((el: any) => Number(el.outlier_flag) === 0 && el.type === '定位' && Number(el.std_time) >= 2);
  if (preAlign.length > 0) {
    const sum = round2(preAlign.reduce((acc: number, el: any) => acc + Number(el.std_time), 0));
    for (const mapping of (ecrsaRules?.mappings ?? []).filter((m: any) => m.id === 'M06' || m.id === 'M09')) {
      push({
        mapping_id: mapping.id,
        waste_type: '定位',
        method: mapping.method,
        measure: mapping.measure,
        element_ids: preAlign.map((el: any) => el.element_id),
        evidence: `定位要素${preAlign.length}个、ST合计${sum}s（单个≥2s）`,
        est_save_s: round2(sum * mapping.factor),
        difficulty: mapping.difficulty,
        note: mapping.note,
      });
    }
  }

  const freqValue = dailyOutput ?? 1;
  for (const candidate of candidates) {
    candidate.raw_priority = round2((candidate.est_save_s * freqValue) / candidate.difficulty);
  }
  const max = candidates.length > 0 ? Math.max(...candidates.map((c) => c.raw_priority), 0.01) : 1;
  for (const candidate of candidates) {
    candidate.priority = Math.round((candidate.raw_priority / max) * 100);
    candidate.tier = candidate.priority >= 60 ? 'P1' : candidate.priority >= 30 ? 'P2' : 'P3';
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

/**
 * 2 条红线检测（文档04 §5）：命中=须确认后放行（非阻断）。
 *   quality：waste_type=检验冗余 且 measure 含取消/弱化检验关键词；
 *   ergonomics：measure 含弯腰/扭转/高举等人因风险关键词。
 * 返回未确认项清单（空数组=可放行）。
 */
export function checkRedlines(candidates: any[], redlineRules: any, confirmations?: AdoptConfirmations): RedlineRequirement[] {
  const qualityHits = candidates.filter((c) => c.waste_type === '检验冗余'
    && (redlineRules?.quality?.keywords ?? []).some((k: string) => String(c.measure).includes(k)));
  const ergoHits = candidates.filter((c) => (redlineRules?.ergonomics?.keywords ?? []).some((k: string) => String(c.measure).includes(k)));

  const requires: RedlineRequirement[] = [];
  if (qualityHits.length > 0 && !confirmations?.quality) {
    requires.push({ type: 'quality', message: `本批${qualityHits.length}条措施取消/弱化检验，须品质确认（填写确认人+日期）` });
  }
  if (ergoHits.length > 0 && !confirmations?.ergonomics) {
    requires.push({ type: 'ergonomics', message: `本批${ergoHits.length}条措施涉及弯腰/扭转/高举等人因风险，须人因复核` });
  }
  return requires;
}

/** 红线确认标记（追加到 measure 尾部留痕，月抽审核对） */
export function buildRedlineMarkers(confirmations?: AdoptConfirmations): string[] {
  const markers: string[] = [];
  if (confirmations?.quality) markers.push(`[品质确认:${confirmations.quality.name} ${confirmations.quality.date ?? today()}]`);
  if (confirmations?.ergonomics) markers.push(`[人因复核:${confirmations.ergonomics.name} ${confirmations.ergonomics.date ?? today()}]`);
  return markers;
}
