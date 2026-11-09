import { Injectable, Inject, ServiceUnavailableException } from '@nestjs/common';
import { LlmGatewayService } from '../../ai/llm-gateway.service';
import { AnalysisService } from '../analysis/analysis.service';
import { CompareService } from '../compare/compare.service';
import { APP_CONFIG } from '../../core/config/configuration';
import { AppConfig } from '../../core/config/configuration';

/**
 * AI 洞察服务（v3.53）：统一收敛「诊断 / 解读」两类纯文案生成。
 * 复用全局 LlmGatewayService（自带 AI_ENABLED 开关 / 熔断 / 未启用降级）与 AnalysisService / CompareService。
 * 铁律：LLM 只产出自然语言归因与改善方向，绝不产数字；输出经 sanitize 剥离定量；全部标注 pending_review。
 */
@Injectable()
export class AiInsightService {
  constructor(
    private readonly llm: LlmGatewayService,
    private readonly analysis: AnalysisService,
    private readonly compare: CompareService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** 工位诊断（T1）：基于分析结果生成根因诊断 + 3 条改善方向（纯文案） */
  async diagnose(stationId: string): Promise<{ report: string; status: string; generated_by: string; model: string }> {
    const analysis = await this.analysis.analyzeStation(stationId);
    const ctx = this.buildDiagnoseContext(analysis);
    let report: string;
    let generatedBy = 'ai';
    let model = this.cfg?.aiModel ?? 'llm';
    try {
      const text = await this.llm.chat(
        [
          { role: 'system', content: DIAGNOSE_SYSTEM_PROMPT },
          { role: 'user', content: ctx },
        ],
        { maxTokens: 600, temperature: 0.3 },
      );
      report = this.sanitize(text.text);
    } catch {
      report = this.templateDiagnose(analysis);
      generatedBy = 'template';
      model = 'template';
    }
    return { report, status: 'pending_review', generated_by: generatedBy, model };
  }

  /** 对比差异解读（T2）：基于前后版本对比结果生成解读 + 倒退预警（纯文案） */
  async interpretDiff(
    stationId: string,
    v1?: string,
    v2?: string,
  ): Promise<{ interpretation: string; regressionWarnings: string[]; status: string; generated_by: string; model: string }> {
    const cmp = await this.compare.compareVersions(stationId, { v1, v2 } as any);
    const regressionWarnings = this.buildRegressionWarnings(cmp);
    const ctx = this.buildInterpretContext(cmp);
    let interpretation: string;
    let generatedBy = 'ai';
    let model = this.cfg?.aiModel ?? 'llm';
    try {
      const text = await this.llm.chat(
        [
          { role: 'system', content: INTERPRET_SYSTEM_PROMPT },
          { role: 'user', content: ctx },
        ],
        { maxTokens: 500, temperature: 0.3 },
      );
      interpretation = this.sanitize(text.text);
    } catch {
      interpretation = this.templateInterpret(cmp);
      generatedBy = 'template';
      model = 'template';
    }
    return { interpretation, regressionWarnings, status: 'pending_review', generated_by: generatedBy, model };
  }

  // ── 上下文构建（真实数字作为 LLM 背景，输出经 sanitize 剥离定量）──

  private idleSum(arr: any[]): number {
    return Array.isArray(arr) ? arr.reduce((a: number, b: any) => a + Number(b?.dur_s ?? 0), 0) : 0;
  }

  private buildDiagnoseContext(analysis: any): string {
    const m = analysis.metrics ?? {};
    const hands = analysis.hands ?? {};
    const idle = hands.idle ?? {};
    const wastes = Array.isArray(analysis.wastes) ? analysis.wastes.slice(0, 8) : [];
    const wasteLines = wastes.map((w: any) => `- ${w.waste}：占比 ${w.pct}%，证据：${w.evidence ?? ''}`).join('\n');
    const pending = Array.isArray(analysis.pending) ? analysis.pending.length : 0;
    return [
      `工位指标：周期CT=${m.ct}s，节拍TT=${m.tt}s，TT-Gap=${m.tt_gap}s`,
      `VA/RNVA/NVA 占比：${m.va_pct}% / ${m.rnva_pct}% / ${m.nva_pct}%`,
      `要素数=${m.element_count}，异常要素=${m.outlier_count}`,
      `双手空闲：左=${this.idleSum(idle.L)}s，右=${this.idleSum(idle.R)}s，双手同时=${this.idleSum(idle.both)}s`,
      `待复核要素=${pending} 项`,
      `浪费清单（Top${wastes.length}）：\n${wasteLines || '（无）'}`,
    ].join('\n');
  }

  private buildInterpretContext(cmp: any): string {
    const prev = cmp.prev?.metrics ?? {};
    const curr = cmp.curr?.metrics ?? {};
    return [
      `对比版本：v${cmp.prev?.version} → v${cmp.curr?.version}`,
      `周期CT：前=${prev.ct}s，后=${curr.ct}s，ΔCT=${cmp.delta_ct}s`,
      `VA占比：前=${prev.va_pct}% → 后=${curr.va_pct}%`,
      `RNVA占比：前=${prev.rnva_pct}% → 后=${curr.rnva_pct}%`,
      `NVA占比：前=${prev.nva_pct}% → 后=${curr.nva_pct}%`,
      `要素配对率=${cmp.pairing_rate}%`,
      `新增要素=${cmp.added?.length ?? 0} 项，移除=${cmp.removed?.length ?? 0} 项`,
      `系统预警：${(cmp.warnings ?? []).join('；') || '无'}`,
    ].join('\n');
  }

  private buildRegressionWarnings(cmp: any): string[] {
    const prev = cmp.prev?.metrics ?? {};
    const curr = cmp.curr?.metrics ?? {};
    const prevCt = Number(cmp.prev?.ct ?? prev.ct ?? 0);
    const currCt = Number(cmp.curr?.ct ?? curr.ct ?? 0);
    const w: string[] = [];
    if (Number(curr.nva_pct) > Number(prev.nva_pct)) w.push('NVA 占比上升，存在改善倒退风险');
    // ΔCT 口径（compare 服务）：delta_ct = prev.ct - curr.ct，正=改善；CT 增加 ⟺ curr.ct > prev.ct
    if (currCt > prevCt) w.push('周期 CT 增加，整体效率下降');
    if ((cmp.pairing_rate ?? 100) < 60) w.push('前后要素配对率偏低，建议以工位级 ΔCT 为准');
    return w;
  }

  // ── 模板降级（AI 未启用 / 调用失败时，规则口径概览）──

  private templateDiagnose(analysis: any): string {
    const m = analysis.metrics ?? {};
    const hands = analysis.hands ?? {};
    const idle = hands.idle ?? {};
    const both = this.idleSum(idle.both);
    const wasteCount = Array.isArray(analysis.wastes) ? analysis.wastes.length : 0;
    return [
      `【系统模板诊断】本工位周期 CT ${m.ct}s，VA 占比 ${m.va_pct}%，NVA 占比 ${m.nva_pct}%。`,
      `建议优先压缩 NVA 与持住/延迟类浪费（共 ${wasteCount} 项），并关注双手失衡（双手同时空闲约 ${both}s）。`,
      `（AI 诊断未启用或暂不可用，以上为规则口径概览；启用 AI 后可获取归因与改善建议。）`,
    ].join('\n');
  }

  private templateInterpret(cmp: any): string {
    const prev = cmp.prev?.metrics ?? {};
    const curr = cmp.curr?.metrics ?? {};
    const delta = Number(cmp.delta_ct); // 口径：prev.ct - curr.ct，正=CT 下降=效率提升
    const trend = delta > 0 ? '效率提升' : delta < 0 ? '效率下降' : '持平';
    return [
      `【系统模板解读】v${cmp.prev?.version} → v${cmp.curr?.version}：周期 CT ${prev.ct}s → ${curr.ct}s（${trend}，ΔCT ${delta}s）。`,
      `VA 占比 ${prev.va_pct}% → ${curr.va_pct}%，NVA 占比 ${prev.nva_pct}% → ${curr.nva_pct}%。`,
      `（AI 解读未启用或暂不可用，以上为规则口径对比；启用 AI 后可获取变化归因。）`,
    ].join('\n');
  }

  /** 铁律②：剥离 LLM 可能夹带的定量数字（百分比/秒数/金额），保留序数词（如「3条」） */
  private sanitize(text: string): string {
    return String(text ?? '')
      .replace(/\d+(?:\.\d+)?\s*%/g, '[比例由系统计算]')
      .replace(/\d+(?:\.\d+)?\s*秒/g, '[时长由系统计算]')
      .replace(/\d+(?:\.\d+)?\s*sec/gi, '[时长由系统计算]')
      .replace(/\d+(?:\.\d+)?\s*s(?![a-zA-Z])/gi, '[时长由系统计算]')
      .replace(/[¥$]\s*\d+(?:\.\d+)?/g, '[金额由系统计算]')
      .trim();
  }
}

const DIAGNOSE_SYSTEM_PROMPT = `你是工业工程(IE)分析助手。基于给定的工位动作分析结果，用简体中文输出两部分：
1) 一句话根因诊断（为什么该工位效率/增值比偏低）；
2) 3 条具体、可落地的改善方向（每条一句话）。
严格要求：纯定性描述，绝对不要输出任何具体秒数、百分比数值、金额；不要编造数据；用 Markdown 有序列表呈现改善方向。`;

const INTERPRET_SYSTEM_PROMPT = `你是工业工程(IE)分析助手。基于给定的前后版本对比数据，用简体中文输出：
1) 变化解读（效率/NVA/VA 发生了什么变化及可能原因）；
2) 若存在改善倒退（如 NVA 占比上升、CT 增加），明确给出「倒退预警」及建议。
严格要求：纯定性描述，绝对不要输出任何具体秒数、百分比数值、金额；不要编造数据。`;
