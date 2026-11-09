import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../core/config/configuration';
import { AppConfig } from '../../core/config/configuration';
import { BaseRepository } from '../../core/database/base.repository';
import { RulesService } from '../../core/rules/rules.service';
import { AiWasteBatch } from './entities/ai-waste-batch.entity';
import { AiWasteFinding } from './entities/ai-waste-finding.entity';
import { AiWasteIssue } from './entities/ai-waste-issue.entity';
import { AiWasteKb } from './entities/ai-waste-kb.entity';
import { AiSetting } from '../ai-suggest/entities/ai-setting.entity';
import { AiLlmProfile } from '../ai-suggest/entities/ai-llm-profile.entity';
import { Improvement } from '../../entities/improvement.entity';
import { AnalysisService } from '../analysis/analysis.service';
import { StationRepository } from '../stations/stations.service';
import { LlmGatewayService } from '../../ai/llm-gateway.service';
import {
  WASTE_SYSTEM_PROMPT, buildWasteUserPrompt, extractJsonObject,
} from './prompt';
import {
  WASTE_PROMPT_VERSION, checkWastePayload, severityOf,
  type RawFinding, type RawIssue, type TraceItem,
} from './validator';
import { round2 } from '../../core/shared/util';

/**
 * P3-9 浪费识别 + 改善问题清单自动生成（v3.45 起双来源线）。
 *
 * 边界铁律（用户裁定）：本模块与分解工作台 AI 建议模块（ai-suggest）是相互独立的两个模块——
 *  - 只按 source 处理对应来源的要素：'ai_assisted' = AI 自动分解写入；'manual' = 手工分解写入
 *  - 独立表（t_ai_waste_* 三表）、独立校验引擎（W1-W3）、独立优先级算器；不 import ai-suggest 的 service/validator/calculator
 *  - 复用仅限平台公共基建：LlmGatewayService（调系统 AI API）、t_ai_setting 生效配置（ai-suggest 的实体类，
 *    表是平台共享配置非模块私产）、AnalysisService 分析口径、动态浪费白名单口径
 *
 * 双线隔离（v3.45，设计 D2）：端点/批次/幂等/single-flight 全部按 element_source 隔离——
 * lastBatchOf 必须带 source；两线互不 fallback、不合并（混合工位两清单分开呈现）。
 *
 * AI 三铁律继承：永远待处理（确认才进 t_improvement）/ LLM 禁产数字（全服务端算）/ 校验轨迹落库。
 */
class AiWasteBatchRepository extends BaseRepository<AiWasteBatch> {
  protected entityTarget() { return AiWasteBatch; }
}
class AiWasteFindingRepository extends BaseRepository<AiWasteFinding> {
  protected entityTarget() { return AiWasteFinding; }
}
class AiWasteIssueRepository extends BaseRepository<AiWasteIssue> {
  protected entityTarget() { return AiWasteIssue; }
}

@Injectable()
export class AiWasteService {
  private readonly batchRepo: AiWasteBatchRepository;
  private readonly findingRepo: AiWasteFindingRepository;
  private readonly issueRepo: AiWasteIssueRepository;

  /** 进程内 single-flight（同工位并发生成合并为一次） */
  private static inflight = new Map<string, Promise<{ status: number; payload: any }>>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly analysis: AnalysisService,
    private readonly rules: RulesService,
    private readonly llm: LlmGatewayService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.batchRepo = new AiWasteBatchRepository(ds);
    this.findingRepo = new AiWasteFindingRepository(ds);
    this.issueRepo = new AiWasteIssueRepository(ds);
  }

  // ───────────────────────── 生效配置（复用平台 t_ai_setting；同 ai-suggest 读法但独立实现） ─────────────────────────

  /**
   * 生效 AI 配置（v3.48 对齐 ai-suggest 三级优先）：
   * 启用的连接配置（t_ai_llm_profile）→ t_ai_setting 键值行（旧版兼容）→ .env。
   *
   * 修复背景（BJFA1/ST010 实测「浪费识别失败：fetch failed」）：本模块原先只读
   * t_ai_setting → .env，而 .env 的 AI_LLM_BASE_URL 指向未运行的本地 vLLM
   * （127.0.0.1:8000）→ ECONNREFUSED；管理员在「AI 配置」页维护的启用 profile（方舟）
   * 被完全旁路。两模块端点解析不一致是本 P0 的直接根因。
   * profile.api_key 为空串视为未设（key 回落下一级）；总开关 ai_enabled 仍独立读行。
   */
  private async effectiveAi(): Promise<{ enabled: boolean; baseUrl: string; apiKey: string; model: string }> {
    const rows = await this.ds.getRepository(AiSetting).find();
    const map = new Map(rows.map((r) => [r.setting_key, String(r.setting_value ?? '')]));
    const db = (k: string): string | undefined => {
      const v = map.get(k);
      return v !== undefined && v !== '' ? v : undefined;
    };
    const enabledRaw = db('ai_enabled');
    const active = await this.ds.getRepository(AiLlmProfile).findOne({ where: { enabled: true } });
    const legacyUrl = db('llm_base_url');
    const legacyKey = db('llm_api_key');
    const legacyModel = db('llm_model');
    return {
      enabled: enabledRaw !== undefined ? enabledRaw === '1' : this.cfg.aiSuggestEnabled,
      baseUrl: (active?.base_url || legacyUrl) ?? this.cfg.aiLlmBaseUrl,
      apiKey: (active && active.api_key !== '' ? active.api_key : legacyKey) ?? this.cfg.aiLlmApiKey,
      model: (active?.model || legacyModel) ?? this.cfg.aiLlmModel,
    };
  }

  private async assertEnabled(): Promise<void> {
    const eff = await this.effectiveAi();
    if (!eff.enabled) {
      throw new ServiceUnavailableException('AI 服务未启用（可在 AI 配置页开启服务）');
    }
  }

  // ───────────────────────── 上下文装载（按来源线隔离 + 异常点分离） ─────────────────────────

  /**
   * 按来源线装载当前版本上下文（v3.45，设计 D5）：
   *  - elements = outlier_flag=0 且 source===source 的子集（W1-W3 校验与 finding 引用的唯一候选集）；
   *  - outliers = outlier_flag=1 的全部要素（与来源无关——异常标记是数据质量属性，两线共用同一异常视野），
   *    只进 prompt 异常点线索段，绝不进 validator ctx（引用 outlier seq 的条目被 W1.3 自然拦截）；
   *  - ct = elements 子集 Σstd_time（round2；分析引擎 ct 是全量 active 的——混合工位须按子集重算）。
   * 两集合严格分离（设计风险#2 的实现红线）。
   */
  private async loadBySource(
    station: any, source: 'manual' | 'ai_assisted',
  ): Promise<{ elements: any[]; outliers: { seq: number; type: string; desc: string; reason: string }[]; ct: number }> {
    const result = await this.analysis.analyzeStationAtVersion(station, station.version);
    const all = result.elements ?? [];
    const elements = all.filter((el: any) =>
      Number(el.outlier_flag) === 0 && el.source === source);
    const outliers = all
      .filter((el: any) => Number(el.outlier_flag) === 1)
      .map((el: any) => ({
        seq: Number(el.seq), type: el.type,
        desc: String(el.desc ?? '').slice(0, 60), reason: String(el.outlier_reason ?? ''),
      }));
    // CT 口径：该来源要素的 ST 合计（分析引擎 ct 是全量 active 的——混合工位须按来源子集重算）
    const ct = round2(elements.reduce((acc: number, el: any) => acc + Number(el.std_time), 0));
    return { elements, outliers, ct };
  }

  /** 动态 waste 白名单（与 ai-suggest 同口径但独立实现：waste_triggers ∪ ecrsa_map wastes） */
  private wasteWhitelist(): string[] {
    const set = new Set<string>();
    for (const t of this.rules.getActive('waste_triggers').json?.triggers ?? []) set.add(t.waste);
    for (const m of this.rules.getActive('ecrsa_map').json?.mappings ?? []) set.add(m.waste);
    return [...set];
  }

  /**
   * 依据等级 → route（v3.57，方案文档「两轴规则」轴 2 的工程落地）：
   * 触发器级 basis 字段标注依据等级——【既有】=平台确定性锚点 /【建议】=未现场标定值。
   * 聚合口径（AI finding 只有 waste_type、不携带触发器 id，故按 waste_type 聚合）：
   *   - 该 waste_type 下存在任一【既有】触发器 → route=finding（已有确定锚点，计收益）
   *   - 该 waste_type 下全部为【建议】触发器 → route=pool（进清单展示，收益待现场标定后计值）
   *   - 无触发器（纯 ecrsa_map 自定义项）→ 保守回落 finding（人工可显式改 pool）
   * 这一口径让第 7 类「动作浪费」（走动/转身/弯腰/大臂/往返，阈值均未标定）自动沉入 pool、
   * 收益不计值，而既有 6 类确定性浪费维持 finding——实现「不误判前提下最大化识别」。
   */
  private routeOf(wasteType: string): 'finding' | 'pool' {
    const triggers = this.rules.getActive('waste_triggers').json?.triggers ?? [];
    const mine = triggers.filter((t: any) => t.waste === wasteType);
    if (mine.length === 0) return 'finding';
    const hasExisting = mine.some((t: any) => (t.basis ?? '既有') === '既有');
    return hasExisting ? 'finding' : 'pool';
  }

  // ───────────────────────── 生成 ─────────────────────────

  /**
   * 识别（POST /stations/:stationId/ai-waste/generate 与 generate-manual 共享实现）。
   * 状态机（全部按 source 隔离，设计 D2/风险#1）：running 中 → 409；最近成功批 → 200 幂等（idempotent_hit）；failed → 重开。
   * source 缺省 'ai_assisted'——现有端点契约零改动（旧调用行为逐字节不变）。
   * 与 ai-suggest 不同点：无用户配额槽位（浪费识别按工位最新批覆盖查询，历史批只读溯源）。
   */
  async generate(
    stationId: string, userId: string, source: 'manual' | 'ai_assisted' = 'ai_assisted',
  ): Promise<{ status: number; payload: any }> {
    await this.assertEnabled();
    const station = await this.stationOf(stationId);
    const { elements, outliers, ct } = await this.loadBySource(station, source);
    if (elements.length === 0) {
      throw new BadRequestException(source === 'manual'
        ? '该工位当前版本没有手工分解要素（source=manual）。手工线只识别分解工作台提交的手工分解要素——请先在分解工作台提交分解，或切换到「AI 分解线」页签。'
        : '该工位当前版本没有 AI 自动分解写入的要素（source=ai_assisted）。AI 线只识别 AI 自动分解写入的要素——请先做一次 AI 自动分解，或切换到「手工分解线」页签。');
    }
    if (!(ct > 0)) {
      throw new BadRequestException(source === 'manual'
        ? '手工分解要素 ST 合计为 0，无法识别浪费'
        : 'AI 要素 ST 合计为 0，无法识别浪费');
    }

    // 最近成功批 → 幂等 200（同源同版本才命中——跨线不幂等，风险#1）
    const lastDone = await this.lastBatchOf(stationId, ['done', 'done_empty'], source);
    if (lastDone && lastDone.version === station.version) {
      const payload = await this.batchPayload(lastDone, station);
      return { status: 200, payload: { ...payload, idempotent_hit: true } };
    }

    // running → 409（同源）
    const running = await this.lastBatchOf(stationId, ['running'], source);
    if (running) {
      throw new ConflictException({ message: '该工位已有浪费识别任务进行中', code: 'AI_WASTE_IN_PROGRESS', batch_id: running.batch_id });
    }

    // single-flight（key 含 source：两线并发互不合并、互不阻塞）
    const flightKey = `${station.tenant_id}|${stationId}|${source}`;
    const existing = AiWasteService.inflight.get(flightKey);
    if (existing) return existing;
    const task = this.doGenerate(station, userId, elements, ct, outliers, source)
      .finally(() => AiWasteService.inflight.delete(flightKey));
    AiWasteService.inflight.set(flightKey, task);
    return task;
  }

  private async stationOf(stationId: string) {
    const station = await new StationRepository(this.ds).findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);
    return station;
  }

  /**
   * v3.55 条目所属工位反查（供控制器做资源级写守卫）。
   * 这些端点的路径参数是 finding_id / issue_id，不是 station_id——
   * 此前完全没有资源级校验 → 同租户任意有 suggestion:generate 的人都能编辑/删除
   * **他人工位**的人工浪费点与改善措施，或把别人的条目结算成改善任务。
   */
  async stationIdOfFinding(findingId: string): Promise<string> {
    const row = await this.findingRepo.findOne({ finding_id: findingId } as any);
    if (!row) throw new NotFoundException(`浪费点 ${findingId} 不存在`);
    return (row as any).station_id;
  }

  /** v3.55 条目所属工位反查（改善措施） */
  async stationIdOfIssue(issueId: string): Promise<string> {
    const row = await this.issueRepo.findOne({ issue_id: issueId } as any);
    if (!row) throw new NotFoundException(`改善措施 ${issueId} 不存在`);
    return (row as any).station_id;
  }

  /**
   * v3.55 知识库条目的归属信息（供控制器做资源级写守卫）。
   * KB 有两种形态：① 绑定工位（station_id 非空）→ 按该工位判写权；
   * ② 通用条目（station_id 为 NULL）→ 属租户级公共资产，
   *    仅全权角色（admin）或条目创建者可改（避免普通用户改动影响全公司 AI 生成的经验库）。
   */
  async kbGuardInfo(kbId: string): Promise<{ station_id: string | null; created_by: string | null }> {
    const row = await this.ds.getRepository(AiWasteKb).findOne({ where: { kb_id: kbId } });
    if (!row) throw new NotFoundException(`知识条目 ${kbId} 不存在`);
    return { station_id: row.station_id, created_by: row.created_by };
  }

  /**
   * 最近批次（按状态集 + 来源线查询；created_at 倒序取最新）。
   * 所有调用点必须传 source——漏一处的后果是跨线幂等假 200 / 假 409（设计风险#1，correctness 关键）。
   */
  private async lastBatchOf(
    stationId: string, statuses: string[], source: 'manual' | 'ai_assisted',
  ): Promise<AiWasteBatch | null> {
    const rows = await this.ds.getRepository(AiWasteBatch)
      .createQueryBuilder('b')
      .where('b.station_id = :sid', { sid: stationId })
      .andWhere('b.status IN (:...sts)', { sts: statuses })
      .andWhere('b.element_source = :src', { src: source })
      .orderBy('b.created_at', 'DESC')
      .getMany();
    return rows[0] ?? null;
  }

  private async doGenerate(
    station: any, userId: string, elements: any[], ct: number,
    outliers: { seq: number; type: string; desc: string; reason: string }[],
    source: 'manual' | 'ai_assisted',
  ): Promise<{ status: number; payload: any }> {
    const eff = await this.effectiveAi();
    // failed 批复用（只复用同源失败批——其 element_source 本就正确，update 无需携带该字段），否则新建
    const failed = await this.lastBatchOf(station.station_id, ['failed'], source);
    let batch: AiWasteBatch;
    if (failed) {
      await this.batchRepo.update({ batch_id: failed.batch_id }, {
        status: 'running', version: station.version, user_id: userId,
        element_count: elements.length, error: null,
        // v3.48：复用时同步刷新 model/prompt_version——失败批的 model 是旧配置快照，
        // 不复刷会让批次历史显示与实际调用不符的模型（可追溯性）
        model: eff.model, prompt_version: WASTE_PROMPT_VERSION,
      } as any);
      batch = (await this.batchRepo.findOne({ batch_id: failed.batch_id } as any))!;
    } else {
      batch = await this.batchRepo.create({
        batch_id: randomUUID(), tenant_id: station.tenant_id, station_id: station.station_id,
        version: station.version, user_id: userId, status: 'running',
        element_source: source, element_count: elements.length,
        model: eff.model, prompt_version: WASTE_PROMPT_VERSION,
      } as any);
    }
    const batchId = batch.batch_id;

    try {
      const run = await this.runLlmAndValidate(station, batchId, userId, elements, ct, outliers, source, eff);
      const doneStatus = (run.findings.length + run.issues.length) > 0 ? 'done' : 'done_empty';
      await this.batchRepo.update({ batch_id: batchId } as any, {
        status: doneStatus, finding_count: run.findings.length, issue_count: run.issues.length,
        tokens_used: run.tokensUsed, completed_at: new Date(),
      } as any);
      const fresh = (await this.batchRepo.findOne({ batch_id: batchId } as any))!;
      return { status: 200, payload: await this.batchPayload(fresh, station) };
    } catch (e: any) {
      await this.batchRepo.update({ batch_id: batchId } as any, {
        status: 'failed', error: String(e?.message ?? e).slice(0, 256),
      } as any);
      throw new ServiceUnavailableException(`浪费识别失败：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  /** LLM 调用 → JSON 解析（重试 1 次）→ 数字剥除 → W1-W3 校验 → 服务端算数 → 落库 */
  private async runLlmAndValidate(
    station: any, batchId: string, userId: string, elements: any[], ct: number,
    outliers: { seq: number; type: string; desc: string; reason: string }[],
    source: 'manual' | 'ai_assisted',
    eff: { baseUrl: string; apiKey: string; model: string },
  ): Promise<{ findings: any[]; issues: any[]; tokensUsed: number }> {
    const whitelist = this.wasteWhitelist();
    const compact = elements.map((el: any) => ({
      seq: Number(el.seq), type: el.type, va_class: el.va_effective ?? el.va_class,
      dur_s: round2(Number(el.dur_s)), hand: el.hand, desc: String(el.desc ?? '').slice(0, 60),
    }));

    // v3.51：知识库检索注入（关键词/规则轻量打分；命中条数上限 6，失败静默降级不阻断生成）
    const elementTypes = [...new Set(compact.map((e: any) => String(e.type ?? '')).filter(Boolean))];
    const kb = await this.searchKb(station.tenant_id, station.station_id, elementTypes, 6);
    const kbHints = {
      findings: kb.lines.filter((l) => l.kind === 'finding').map((l) => l.text),
      issues: kb.lines.filter((l) => l.kind === 'issue').map((l) => l.text),
    };

    const userPrompt = buildWasteUserPrompt({
      station_id: station.station_id, ct, tt: Number(station.tt ?? 0),
      elements: compact, waste_whitelist: whitelist,
      decomposition_source: source, outliers, kb_hints: kbHints,
    });
    const messages = [
      { role: 'system' as const, content: WASTE_SYSTEM_PROMPT },
      { role: 'user' as const, content: userPrompt },
    ];
    const opts = {
      maxTokens: Math.min(4000, 1800 + 40 * compact.length),
      temperature: 0.3, ignoreGlobalSwitch: true, disableThinking: true,
      endpoint: { baseUrl: eff.baseUrl, apiKey: eff.apiKey, model: eff.model },
    };

    let parsed: { findings?: any[]; issues?: any[] } | null = null;
    let tokensUsed = 0;
    let lastText = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.llm.chat(messages, {
        ...opts,
        usage: {
          feature: 'waste_analysis', tenantId: station.tenant_id,
          userId, stationId: station.station_id, lineId: station.line_id,
          batchId, attemptNo: attempt + 1,
        },
      });
      tokensUsed += r.tokensUsed;
      lastText = r.text;
      parsed = extractJsonObject(r.text);
      if (parsed !== null) break;
    }
    if (parsed === null) throw new Error(`LLM 输出无法解析为 JSON 对象：${lastText.slice(0, 80)}`);

    // 数字字段剥除（铁律②）：只保留 LLM 允许产出的字段，数字一律服务端算
    const rawFindings: RawFinding[] = (Array.isArray(parsed.findings) ? parsed.findings : []).map((f: any) => ({
      element_seqs: Array.isArray(f?.element_seqs) ? f.element_seqs : [],
      waste_type: typeof f?.waste_type === 'string' ? f.waste_type : '',
      evidence: typeof f?.evidence === 'string' ? f.evidence : '',
    }));
    const rawIssues: RawIssue[] = (Array.isArray(parsed.issues) ? parsed.issues : []).map((it: any) => ({
      element_seqs: Array.isArray(it?.element_seqs) ? it.element_seqs : [],
      waste_type: typeof it?.waste_type === 'string' ? it.waste_type : '',
      problem: typeof it?.problem === 'string' ? it.problem : '',
      ecrs: typeof it?.ecrs === 'string' ? it.ecrs : '',
      suggestion: typeof it?.suggestion === 'string' ? it.suggestion : '',
    }));

    const check = checkWastePayload(rawFindings, rawIssues, {
      elements: elements.map((el: any) => ({
        seq: Number(el.seq), type: el.type,
        va_class: el.va_effective ?? el.va_class,
        dur_s: Number(el.dur_s), std_time: Number(el.std_time), desc: el.desc,
      })),
      ct, wasteWhitelist: whitelist, issueCeiling: 12,
    });
    if (check.batchBlocked) throw new BadRequestException(check.batchBlocked);
    // 知识库命中计数（被真正用于生成本批的条目才计数）
    void this.bumpKbHits(kb.rows);

    // 服务端算数 + 落库（校验轨迹随行）
    const findings = check.findings.map((f) => ({
      finding_id: randomUUID(), batch_id: batchId,
      tenant_id: station.tenant_id, station_id: station.station_id, version: station.version,
      element_refs: f.seqs.join(','), waste_type: f.waste_type,
      severity: f.severity, involved_s: f.involved_s, pct_of_ct: f.pct_of_ct,
      evidence: f.evidence,
      // v3.57：按 waste_type 的触发器依据等级自动判 route（既有→finding 计收益 / 全建议→pool 收益待标定）
      route: this.routeOf(f.waste_type),
      validation_trace: JSON.stringify(f.trace),
    }));
    const issues = this.scoreIssues(check.issues, ct).map((it) => ({
      issue_id: randomUUID(), batch_id: batchId,
      tenant_id: station.tenant_id, station_id: station.station_id, version: station.version,
      element_refs: it.seqs.join(','), waste_type: it.waste_type,
      problem: it.problem, ecrs: it.ecrs, suggestion: it.suggestion,
      est_save_s: it.est_save_s, priority: it.priority, tier: it.tier,
      status: '待处理', validation_trace: JSON.stringify(it.trace),
    }));

    await this.batchRepo.transaction(async (mgr) => {
      for (const f of findings) await mgr.save(AiWasteFinding, f as any);
      for (const it of issues) await mgr.save(AiWasteIssue, it as any);
    });
    return { findings, issues, tokensUsed };
  }

  /**
   * 问题清单打分（独立实现，不 import ai-suggest calculator）：
   * est_save_s：E=ΣST 全额 / C·R·S=ΣST×0.5（保守折算系数——两线独立维护，不复用 ecrsa factor 表）
   * priority：Σest_save_s/CT 占比归一化 ×100；tier：P1≥40 / P2≥15 / P3<15（浪费清单以占比定级更直观）
   */
  private scoreIssues(issues: { seqs: number[]; problem: string; suggestion: string; ecrs: string; waste_type: string; involvedStd: number; trace: TraceItem[] }[], ct: number) {
    const scored = issues.map((it) => {
      const full = it.ecrs === 'E';
      const est = round2(full ? it.involvedStd : it.involvedStd * 0.5);
      const pct = ct > 0 ? (est / ct) * 100 : 0;
      return { ...it, est_save_s: est, rawPriority: pct };
    });
    const max = Math.max(...scored.map((s) => s.rawPriority), 0.01);
    return scored.map((it) => {
      const priority = Math.round((it.rawPriority / max) * 100);
      const tier = priority >= 40 ? 'P1' : priority >= 15 ? 'P2' : 'P3';
      return {
        seqs: it.seqs, waste_type: it.waste_type, problem: it.problem, ecrs: it.ecrs,
        suggestion: it.suggestion, est_save_s: it.est_save_s, priority, tier, trace: it.trace,
      };
    });
  }

  // ───────────────────────── 查询 ─────────────────────────

  /** 最新批次视图（findings + issues + 批次元信息 + ct/summary；无批 → 空）。
   *  source 缺省 'ai_assisted'——不传即旧行为逐字节不变（53/53 契约回归安全）。
   *  v3.48 additive：source_availability（当前版本各来源线的非异常要素数）——
   *  前端空态据此提示「切换到有数据的那条线」，修复手工分解工位在默认 AI 线页签
   *  看到空列表却无处可点的问题（BJFA1/ST010 实测）。 */
  async latest(stationId: string, source: 'manual' | 'ai_assisted' = 'ai_assisted') {
    await this.assertEnabled();
    const station = await this.stationOf(stationId);
    const availability = await this.sourceAvailability(station);
    const batch = await this.lastBatchOf(stationId, ['running', 'done', 'done_empty', 'failed'], source);
    if (!batch) {
      return { station_id: stationId, version: station.version, batch: null, findings: [], issues: [], source_availability: availability };
    }
    return { station_id: stationId, version: station.version, ...(await this.batchPayload(batch, station)), source_availability: availability };
  }

  /**
   * 当前版本各来源线的非异常要素数（只读探查，失败降级全 0——不拖垮查询）。
   * 口径与 loadBySource 一致：analyzeStationAtVersion → outlier_flag=0 → 按 source 计数。
   */
  private async sourceAvailability(station: any): Promise<{ manual: number; ai_assisted: number }> {
    try {
      const result = await this.analysis.analyzeStationAtVersion(station, station.version);
      const all = result.elements ?? [];
      const count = (src: string) => all.filter((el: any) => Number(el.outlier_flag) === 0 && el.source === src).length;
      return { manual: count('manual'), ai_assisted: count('ai_assisted') };
    } catch {
      return { manual: 0, ai_assisted: 0 };
    }
  }

  /** 批次列表（历史溯源；只读；按 source 隔离，缺省 ai_assisted） */
  async listBatches(stationId: string, source: 'manual' | 'ai_assisted' = 'ai_assisted') {
    await this.assertEnabled();
    await this.stationOf(stationId);
    const rows = await this.ds.getRepository(AiWasteBatch)
      .createQueryBuilder('b')
      .where('b.station_id = :sid', { sid: stationId })
      .andWhere('b.element_source = :src', { src: source })
      .orderBy('b.created_at', 'DESC')
      .getMany();
    return {
      station_id: stationId,
      batches: rows.map((b) => ({
        batch_id: b.batch_id, status: b.status, version: b.version, user_id: b.user_id,
        element_source: b.element_source, element_count: b.element_count,
        finding_count: b.finding_count, issue_count: b.issue_count, tokens_used: b.tokens_used,
        model: b.model, prompt_version: b.prompt_version, error: b.error,
        created_at: b.created_at, completed_at: b.completed_at,
      })),
    };
  }

  /**
   * 批次载荷（findings + issues + 批次元信息）。
   * v3.45 additive：ct（loadBySource 现场复算的只读值——不落列；分析失败降级 0，轮询场景不因只读成本失败）
   * 与 summary（服务端口径汇总：by_type 分布计数 + total_est_save_s + est_pct_of_ct——前端零计算，P1-3）。
   * 既有字段语义不变。
   */
  private async batchPayload(batch: AiWasteBatch, station: any) {
    const findings = await this.findingRepo.find({ batch_id: batch.batch_id } as any, { order: { severity: 'DESC' } });
    const issues = await this.issueRepo.find({ batch_id: batch.batch_id } as any, { order: { priority: 'DESC' } });
    let ct = 0;
    try {
      const ctx = await this.loadBySource(station, batch.element_source as 'manual' | 'ai_assisted');
      ct = ctx.ct;
    } catch {
      ct = 0; // 只读复算失败不拖垮查询（3s 轮询场景）
    }
    const byType: Record<string, number> = {};
    for (const f of findings) byType[f.waste_type] = (byType[f.waste_type] ?? 0) + 1;
    const totalEstSaveS = round2(issues.reduce((acc, it) => acc + Number(it.est_save_s), 0));
    return {
      batch_id: batch.batch_id, status: batch.status, version: batch.version,
      element_source: batch.element_source, element_count: batch.element_count,
      finding_count: batch.finding_count, issue_count: batch.issue_count,
      tokens_used: batch.tokens_used, model: batch.model, prompt_version: batch.prompt_version,
      error: batch.error, created_at: batch.created_at, completed_at: batch.completed_at,
      ct,
      summary: {
        by_type: byType,
        total_est_save_s: totalEstSaveS,
        est_pct_of_ct: ct > 0 ? round2((totalEstSaveS / ct) * 100) : 0,
      },
      findings: findings.map((f) => this.findingVo(f)),
      issues: issues.map((it) => this.issueVo(it)),
    };
  }

  private findingVo(f: AiWasteFinding) {
    return {
      finding_id: f.finding_id, batch_id: f.batch_id, station_id: f.station_id, version: f.version,
      element_seqs: (f.element_refs ?? '').split(',').map(Number).filter(Boolean),
      waste_type: f.waste_type, severity: Number(f.severity),
      involved_s: Number(f.involved_s), pct_of_ct: Number(f.pct_of_ct),
      evidence: f.evidence, created_at: f.created_at,
      // v3.51 additive：来源与录入人（AI 默认 ai / 人工 manual；旧契约字段语义不变）
      origin: (f as any).origin ?? 'ai', created_by: (f as any).created_by ?? null, updated_at: (f as any).updated_at ?? null,
      // v3.57 additive：路由（finding=确定性命中计收益 / pool=待标定观察项仍进清单、est 不计值）
      route: (f as any).route ?? 'finding',
    };
  }

  private issueVo(it: AiWasteIssue) {
    return {
      issue_id: it.issue_id, batch_id: it.batch_id, finding_id: it.finding_id,
      station_id: it.station_id, version: it.version,
      element_seqs: (it.element_refs ?? '').split(',').map(Number).filter(Boolean),
      waste_type: it.waste_type, problem: it.problem, ecrs: it.ecrs, suggestion: it.suggestion,
      est_save_s: Number(it.est_save_s), priority: it.priority, tier: it.tier,
      status: it.status, imp_id: it.imp_id, reviewed_by: it.reviewed_by, reviewed_at: it.reviewed_at,
      validation_trace: it.validation_trace ? JSON.parse(it.validation_trace) : null,
      created_at: it.created_at,
      // v3.51 additive
      origin: (it as any).origin ?? 'ai', created_by: (it as any).created_by ?? null, updated_at: (it as any).updated_at ?? null,
    };
  }

  // ───────────────────────── v3.51 人工录入（与 AI 生成并存） ─────────────────────────

  /**
   * 人工条目上下文：当前版本全部非异常要素（与 AI 线不同——AI 线按 element_source 取子集，
   * 人工看的是整份分解，故取全量 active 要素；CT 同口径为 Σstd_time）。
   */
  private async manualCtx(station: any): Promise<{ elements: any[]; ct: number }> {
    const result = await this.analysis.analyzeStationAtVersion(station, station.version);
    const all = result.elements ?? [];
    const elements = all.filter((el: any) => Number(el.outlier_flag) === 0);
    const ct = round2(elements.reduce((acc: number, el: any) => acc + Number(el.std_time), 0));
    return { elements, ct };
  }

  /** 人工条目要素引用归一：去空/去重/丢弃不存在的 seq（引用不存在 = 无效引用，静默裁剪） */
  private normalizeSeqs(raw: unknown, bySeq: Map<number, any>): number[] {
    const list: unknown[] = Array.isArray(raw) ? raw : [];
    return [...new Set(list.map((q) => Number(q)))]
      .filter((q) => Number.isFinite(q) && q > 0 && bySeq.has(q));
  }

  /** waste_type 白名单断言（人工录入与 AI 同口径，避免人工写入后统计口径分裂） */
  private assertWasteType(wt: string): string {
    const t = String(wt ?? '').trim();
    if (!t) throw new BadRequestException('waste_type 不能为空');
    const whitelist = this.wasteWhitelist();
    if (!whitelist.includes(t)) {
      throw new BadRequestException(`waste_type「${t}」不在浪费白名单（可选：${whitelist.join('、')}）`);
    }
    return t;
  }

  /** route 断言（v3.57）：finding=确定性命中计收益 / pool=待标定观察项仍进清单、est 不计值 */
  private assertRoute(route: unknown): string {
    if (route === undefined || route === null || route === '') return 'finding';
    const r = String(route).trim().toLowerCase();
    if (r === 'finding' || r === 'pool') return r;
    throw new BadRequestException(`route 仅支持 finding（确定性命中）或 pool（待标定观察项），收到「${route}」`);
  }

  /** 人工录入·浪费点（数字服务端算：involved_s/pct_of_ct/severity） */
  async createManualFinding(stationId: string, dto: any, operator: string) {
    const station = await this.stationOf(stationId);
    const wt = this.assertWasteType(dto.waste_type);
    const evidence = String(dto.evidence ?? '').trim().slice(0, 250);
    if (evidence.length < 6) throw new BadRequestException('evidence 至少 6 个字（需写明依据）');
    const { elements, ct } = await this.manualCtx(station);
    const bySeq = new Map<number, any>(elements.map((e: any) => [Number(e.seq), e]));
    const seqs = this.normalizeSeqs(dto.element_seqs, bySeq);
    const involved = round2(seqs.reduce((acc, q) => acc + Number(bySeq.get(q)!.std_time), 0));
    const pct = ct > 0 ? round2((involved / ct) * 100) : 0;
    // v3.57：route 未显式指定时按 waste_type 的触发器依据等级自动判（既有→finding / 全建议→pool）；显式指定仍以人工为准
    const route = dto.route !== undefined && dto.route !== null && dto.route !== ''
      ? this.assertRoute(dto.route)
      : this.routeOf(wt);
    const row: any = {
      finding_id: randomUUID(), batch_id: null, tenant_id: station.tenant_id,
      station_id: station.station_id, version: station.version,
      element_refs: seqs.join(','), waste_type: wt,
      severity: severityOf(pct), involved_s: involved, pct_of_ct: pct, evidence,
      origin: 'manual', created_by: operator,
      route,
      validation_trace: JSON.stringify([{ round: 'M', rule: 'M1', hit: false, reason: '人工录入（数字服务端计算，非 LLM 产出）' }]),
    };
    const saved = await this.findingRepo.create(row);
    return this.findingVo(saved as any);
  }

  /** 人工条目编辑（仅 origin='manual' 可改；AI 产出不可改——铁律①AI 产出只可确认/忽略） */
  async updateManualFinding(id: string, dto: any, operator: string) {
    const row = await this.findingRepo.findOne({ finding_id: id } as any);
    if (!row) throw new NotFoundException(`浪费点 ${id} 不存在`);
    if ((row as any).origin !== 'manual') {
      throw new ConflictException('AI 识别产出的浪费点不可编辑（如需调整请人工新增一条）');
    }
    const station = await this.stationOf(row.station_id);
    const { elements, ct } = await this.manualCtx(station);
    const bySeq = new Map<number, any>(elements.map((e: any) => [Number(e.seq), e]));
    const patch: any = { updated_at: new Date() };
    if (dto.waste_type !== undefined) patch.waste_type = this.assertWasteType(dto.waste_type);
    if (dto.route !== undefined) patch.route = this.assertRoute(dto.route);
    // v3.57：改了 waste_type 但未显式指定 route 时，跟随新类型的依据等级自动重判（保持口径一致）
    if (dto.route === undefined && patch.waste_type !== undefined) {
      patch.route = this.routeOf(patch.waste_type);
    }
    if (dto.evidence !== undefined) {
      const ev = String(dto.evidence).trim().slice(0, 250);
      if (ev.length < 6) throw new BadRequestException('evidence 至少 6 个字（需写明依据）');
      patch.evidence = ev;
    }
    let seqs: number[] = [];
    if (dto.element_seqs !== undefined) {
      seqs = this.normalizeSeqs(dto.element_seqs, bySeq);
      patch.element_refs = seqs.join(',');
      const involved = round2(seqs.reduce((acc, q) => acc + Number(bySeq.get(q)!.std_time), 0));
      patch.involved_s = involved;
      patch.pct_of_ct = ct > 0 ? round2((involved / ct) * 100) : 0;
      patch.severity = severityOf(patch.pct_of_ct);
    }
    await this.findingRepo.update({ finding_id: id } as any, patch);
    return this.findingVo((await this.findingRepo.findOne({ finding_id: id } as any))!);
  }

  async deleteManualFinding(id: string) {
    const row = await this.findingRepo.findOne({ finding_id: id } as any);
    if (!row) throw new NotFoundException(`浪费点 ${id} 不存在`);
    if ((row as any).origin !== 'manual') throw new ConflictException('AI 识别产出的浪费点不可删除');
    await this.findingRepo.remove({ finding_id: id } as any);
    return { finding_id: id, deleted: true };
  }

  /**
   * 人工录入·改善措施。
   * est_save_s：填了由服务端 clamp 到 [0, CT]；未填且挂了要素 → 按 E 全额 / C·R·S 半折算（同 scoreIssues 口径）。
   * priority/tier：单条录入无法做批内归一化，改用「占 CT 百分比」绝对定级（P1≥40% / P2≥15% / P3<15%）。
   */
  async createManualIssue(stationId: string, dto: any, operator: string) {
    const station = await this.stationOf(stationId);
    const wt = this.assertWasteType(dto.waste_type);
    const problem = String(dto.problem ?? '').trim().slice(0, 250);
    const suggestion = String(dto.suggestion ?? '').trim().slice(0, 250);
    if (problem.length < 8 || suggestion.length < 8) {
      throw new BadRequestException('problem 与 suggestion 均至少 8 个字');
    }
    const { elements, ct } = await this.manualCtx(station);
    const bySeq = new Map<number, any>(elements.map((e: any) => [Number(e.seq), e]));
    const seqs = this.normalizeSeqs(dto.element_seqs, bySeq);
    const involvedStd = round2(seqs.reduce((acc, q) => acc + Number(bySeq.get(q)!.std_time), 0));
    const ecrs = String(dto.ecrs ?? 'S').trim().toUpperCase().slice(0, 1) || 'S';
    let est: number;
    if (dto.est_save_s !== undefined && dto.est_save_s !== null) {
      est = round2(Math.max(0, Math.min(Number(dto.est_save_s), ct > 0 ? ct : Number(dto.est_save_s))));
    } else {
      est = round2(ecrs === 'E' ? involvedStd : involvedStd * 0.5);
    }
    const pct = ct > 0 ? (est / ct) * 100 : 0;
    const priority = Math.round(Math.min(100, pct));
    const tier = priority >= 40 ? 'P1' : priority >= 15 ? 'P2' : 'P3';
    const row: any = {
      issue_id: randomUUID(), batch_id: null, finding_id: null, tenant_id: station.tenant_id,
      station_id: station.station_id, version: station.version,
      element_refs: seqs.join(','), waste_type: wt, problem, ecrs, suggestion,
      est_save_s: est, priority, tier, status: '待处理',
      origin: 'manual', created_by: operator,
      validation_trace: JSON.stringify([{ round: 'M', rule: 'M2', hit: false, reason: '人工录入（数字服务端计算，非 LLM 产出）' }]),
    };
    const saved = await this.issueRepo.create(row);
    return this.issueVo(saved as any);
  }

  async updateManualIssue(id: string, dto: any, operator: string) {
    const row = await this.issueRepo.findOne({ issue_id: id } as any);
    if (!row) throw new NotFoundException(`改善措施 ${id} 不存在`);
    if ((row as any).origin !== 'manual') {
      throw new ConflictException('AI 识别产出的改善措施不可编辑（如需调整请人工新增一条）');
    }
    const station = await this.stationOf(row.station_id);
    const { elements, ct } = await this.manualCtx(station);
    const bySeq = new Map<number, any>(elements.map((e: any) => [Number(e.seq), e]));
    const patch: any = { updated_at: new Date() };
    if (dto.waste_type !== undefined) patch.waste_type = this.assertWasteType(dto.waste_type);
    if (dto.problem !== undefined) {
      const p = String(dto.problem).trim().slice(0, 250);
      if (p.length < 8) throw new BadRequestException('problem 至少 8 个字');
      patch.problem = p;
    }
    if (dto.suggestion !== undefined) {
      const s = String(dto.suggestion).trim().slice(0, 250);
      if (s.length < 8) throw new BadRequestException('suggestion 至少 8 个字');
      patch.suggestion = s;
    }
    if (dto.ecrs !== undefined) patch.ecrs = String(dto.ecrs).trim().toUpperCase().slice(0, 1) || 'S';
    const recalcPriority = () => {
      const pct = ct > 0 ? (Number(patch.est_save_s ?? row.est_save_s) / ct) * 100 : 0;
      patch.priority = Math.round(Math.min(100, pct));
      patch.tier = patch.priority >= 40 ? 'P1' : patch.priority >= 15 ? 'P2' : 'P3';
    };
    if (dto.element_seqs !== undefined) {
      const seqs = this.normalizeSeqs(dto.element_seqs, bySeq);
      patch.element_refs = seqs.join(',');
      const involvedStd = round2(seqs.reduce((acc, q) => acc + Number(bySeq.get(q)!.std_time), 0));
      const ecrs = patch.ecrs ?? row.ecrs;
      patch.est_save_s = round2(ecrs === 'E' ? involvedStd : involvedStd * 0.5);
      recalcPriority();
    }
    if (dto.est_save_s !== undefined && dto.est_save_s !== null) {
      patch.est_save_s = round2(Math.max(0, Math.min(Number(dto.est_save_s), ct > 0 ? ct : Number(dto.est_save_s))));
      recalcPriority();
    }
    await this.issueRepo.update({ issue_id: id } as any, patch);
    return this.issueVo((await this.issueRepo.findOne({ issue_id: id } as any))!);
  }

  async deleteManualIssue(id: string) {
    const row = await this.issueRepo.findOne({ issue_id: id } as any);
    if (!row) throw new NotFoundException(`改善措施 ${id} 不存在`);
    if ((row as any).origin !== 'manual') throw new ConflictException('AI 识别产出的改善措施不可删除');
    if (row.imp_id) throw new ConflictException('该条目已确认进入改善任务，不可删除');
    await this.issueRepo.remove({ issue_id: id } as any);
    return { issue_id: id, deleted: true };
  }

  /**
   * 合并清单查询（v3.51 主查询入口）：AI 批次条目 + 人工录入条目按 origin 过滤合并返回。
   * 与 latest 的关键差异：① 不 require AI 开关（AI 关闭时历史与人工清单照常可查，这是「AI 出不来清单」时的兜底）；
   * ② scope=all 可跨全部历史批次（latest 只看最新批）；③ 人工条目（batch_id IS NULL）纳入同一视图。
   */
  async items(stationId: string, origin = 'all', scope = 'latest', source: 'manual' | 'ai_assisted' = 'ai_assisted') {
    const station = await this.stationOf(stationId);
    let aiFindings: AiWasteFinding[] = [];
    let aiIssues: AiWasteIssue[] = [];
    const batchesUsed: string[] = [];
    if (origin !== 'manual') {
      const all = await this.ds.getRepository(AiWasteBatch)
        .createQueryBuilder('b')
        .where('b.station_id = :sid', { sid: stationId })
        .andWhere('b.element_source = :src', { src: source })
        .orderBy('b.created_at', 'DESC')
        .getMany();
      const picked = scope === 'all' ? all : all.slice(0, 1);
      const ids = picked.map((b) => b.batch_id);
      batchesUsed.push(...ids);
      if (ids.length > 0) {
        aiFindings = await this.findingRepo.find({ batch_id: In(ids) } as any, { order: { severity: 'DESC' } });
        aiIssues = await this.issueRepo.find({ batch_id: In(ids) } as any, { order: { priority: 'DESC' } });
      }
    }
    let manualFindings: AiWasteFinding[] = [];
    let manualIssues: AiWasteIssue[] = [];
    if (origin !== 'ai') {
      manualFindings = await this.findingRepo.find(
        { station_id: stationId, origin: 'manual' } as any, { order: { severity: 'DESC' } },
      );
      manualIssues = await this.issueRepo.find(
        { station_id: stationId, origin: 'manual' } as any, { order: { priority: 'DESC' } },
      );
    }
    const findings = [...aiFindings, ...manualFindings].map((f) => this.findingVo(f));
    const issues = [...aiIssues, ...manualIssues].map((it) => this.issueVo(it));
    const byType: Record<string, number> = {};
    for (const f of findings) byType[f.waste_type] = (byType[f.waste_type] ?? 0) + 1;
    const totalEstSaveS = round2(issues
      .filter((i) => i.status !== '已忽略')
      .reduce((acc, i) => acc + Number(i.est_save_s), 0));
    let ct = 0;
    try { ct = (await this.manualCtx(station)).ct; } catch { ct = 0; }
    return {
      station_id: stationId, version: station.version, origin, scope, source,
      batch_ids: batchesUsed,
      /** 动态浪费白名单（人工录入下拉用；与 AI 校验同口径，避免人工写入后统计口径分裂） */
      waste_types: this.wasteWhitelist(),
      summary: {
        by_type: byType, total_est_save_s: totalEstSaveS,
        est_pct_of_ct: ct > 0 ? round2((totalEstSaveS / ct) * 100) : 0,
      },
      findings, issues,
    };
  }

  // ───────────────────────── v3.51 改善知识库 ─────────────────────────

  /**
   * 关键词抽取（整理入库存时服务端生成，不进 LLM）：
   * waste_type + ecrs + 要素类型 + 文本里的动作/对象关键词（2~6 字中文词，去停用词后取前 12 个）。
   */
  private extractKeywords(parts: (string | null | undefined)[], elementTypes: string[]): string {
    const STOP = new Set(['这个', '导致', '进行', '可以', '需要', '应该', '目前', '由于', '因此', '建议', '改善', '问题', '工位']);
    const text = parts.filter(Boolean).join(' ');
    const words = new Set<string>();
    for (const m of text.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) {
      const w = m[0];
      if (!STOP.has(w)) words.add(w);
    }
    for (const t of elementTypes) if (t) words.add(String(t));
    return [...words].slice(0, 12).join(',');
  }

  /** 被引用的要素类型（用于检索打分：要素类型命中 = 同类动作的经验） */
  private typesOfSeqs(elementRefs: string | null, bySeq: Map<number, any>): string[] {
    return [...new Set((elementRefs ?? '').split(',').map(Number).filter(Boolean)
      .map((q) => String(bySeq.get(q)?.type ?? '')).filter(Boolean))];
  }

  /**
   * 手动整理进知识库：把「人工录入条目」+（可选）「已确认 AI 条目」归档为可检索经验。
   * 幂等：UQ_ai_waste_kb_ref(source_ref, kind)——同一条目重复整理只更新，不新增行。
   */
  async archiveKb(stationId: string, dto: any, operator: string) {
    const station = await this.stationOf(stationId);
    const kinds = Array.isArray(dto?.kinds) && dto.kinds.length > 0 ? dto.kinds : ['finding', 'issue'];
    const includeAiConfirmed = dto?.include_ai_confirmed !== false;
    const general = dto?.general === true;
    const { elements } = await this.manualCtx(station);
    const bySeq = new Map<number, any>(elements.map((e: any) => [Number(e.seq), e]));
    const kbRepo = this.ds.getRepository(AiWasteKb);
    let created = 0; let updated = 0; let skipped = 0;

    const upsert = async (row: Partial<AiWasteKb>) => {
      const embedText = [row.waste_type, row.problem ?? '', row.suggestion ?? '', row.evidence ?? '', row.element_types ?? ''].filter(Boolean).join(' ');
      const emb = await this.embed(embedText).catch(() => null);
      // 列类型为 NVARCHAR(MAX)：必须存 JSON 字符串（读取端 JSON.parse）；原样写数组会被 tedious 拒收
      const embJson = emb ? JSON.stringify(emb) : null;
      const existing = row.source_ref
        ? await kbRepo.findOne({ where: { source_ref: row.source_ref, kind: row.kind } })
        : null;
      if (existing) {
        await kbRepo.update({ kb_id: existing.kb_id }, {
          waste_type: row.waste_type, ecrs: row.ecrs ?? null, problem: row.problem ?? null,
          suggestion: row.suggestion ?? null, evidence: row.evidence ?? null,
          keywords: row.keywords ?? null, element_types: row.element_types ?? null,
          embedding: embJson,
          station_id: general ? null : row.station_id ?? null,
          source_origin: row.source_origin ?? 'manual', status: 'active', updated_at: new Date(),
        });
        updated += 1;
        return;
      }
      await kbRepo.save(kbRepo.create({
        kb_id: randomUUID(), tenant_id: station.tenant_id,
        station_id: general ? null : (row.station_id ?? stationId),
        kind: row.kind!, waste_type: row.waste_type!, ecrs: row.ecrs ?? null,
        problem: row.problem ?? null, suggestion: row.suggestion ?? null, evidence: row.evidence ?? null,
        keywords: row.keywords ?? null, element_types: row.element_types ?? null,
        embedding: embJson,
        source_origin: row.source_origin ?? 'manual', source_ref: row.source_ref ?? null,
        hit_count: 0, status: 'active', created_by: operator,
      }));
      created += 1;
    };

    if (kinds.includes('finding')) {
      const rows = await this.findingRepo.find({ station_id: stationId } as any, { order: { severity: 'DESC' } });
      for (const f of rows) {
        const origin = (f as any).origin ?? 'ai';
        if (origin !== 'manual') { skipped += 1; continue; } // 浪费点无「已确认」态：AI 产出不自动入知识库
        const types = this.typesOfSeqs(f.element_refs, bySeq);
        await upsert({
          kind: 'finding', waste_type: f.waste_type, evidence: f.evidence,
          element_types: types.join(','), source_origin: 'manual', source_ref: f.finding_id,
          keywords: this.extractKeywords([f.waste_type, f.evidence], types),
        });
      }
    }
    if (kinds.includes('issue')) {
      const rows = await this.issueRepo.find({ station_id: stationId } as any, { order: { priority: 'DESC' } });
      for (const it of rows) {
        const origin = (it as any).origin ?? 'ai';
        // 只沉淀「经过人确认」的经验：人工录入 +（可选）已确认 AI 条目；待处理/已忽略不入
        if (origin !== 'manual' && !(includeAiConfirmed && it.status === '已确认')) { skipped += 1; continue; }
        const types = this.typesOfSeqs(it.element_refs, bySeq);
        await upsert({
          kind: 'issue', waste_type: it.waste_type, ecrs: it.ecrs, problem: it.problem,
          suggestion: it.suggestion, element_types: types.join(','),
          source_origin: origin === 'manual' ? 'manual' : 'ai', source_ref: it.issue_id,
          keywords: this.extractKeywords([it.waste_type, it.problem, it.suggestion], types),
        });
      }
    }
    return { station_id: stationId, created, updated, skipped, general, include_ai_confirmed: includeAiConfirmed };
  }

  /**
   * 知识库列表（按工位/类型/关键词过滤；station 为空时返回本租户全部含通用条目）。
   *
   * v3.55 可见范围收口：通用条目（station_id IS NULL）属租户级公共经验，全租户可见；
   * 绑定具体工位的条目仅在该工位对调用者可见时才返回——
   * 否则可通过知识库列表反查他人工位的浪费描述与改善措施。
   */
  async listKb(query: any) {
    const where: any = { tenant_id: query?.tenant_id ?? undefined };
    const qb = this.ds.getRepository(AiWasteKb).createQueryBuilder('k');
    qb.where('1=1');
    if (query?.tenant_id) qb.andWhere('k.tenant_id = :tid', { tid: query.tenant_id });
    if (query?.station_id) {
      qb.andWhere('(k.station_id = :sid OR k.station_id IS NULL)', { sid: query.station_id });
    }
    // v3.55：非全权角色 → 只见「通用条目 ∪ 自己可见工位的条目」
    const visibleIds = query?.visibleStationIds;
    if (visibleIds !== null && visibleIds !== undefined) {
      const allow = [...visibleIds].map((i: string) => `'${i.replace(/'/g, "''")}'`).join(',');
      qb.andWhere(`(k.station_id IS NULL OR k.station_id IN (${allow}))`);
    }
    if (query?.kind) qb.andWhere('k.kind = :kind', { kind: query.kind });
    if (query?.waste_type) qb.andWhere('k.waste_type = :wt', { wt: query.waste_type });
    if (query?.status && query.status !== 'all') qb.andWhere('k.status = :st', { st: query.status });
    if (query?.q) {
      qb.andWhere('(k.keywords LIKE :q OR k.problem LIKE :q OR k.suggestion LIKE :q OR k.evidence LIKE :q)',
        { q: `%${String(query.q).slice(0, 40)}%` });
    }
    const rows = await qb.orderBy('k.hit_count', 'DESC').addOrderBy('k.updated_at', 'DESC')
      .take(Math.min(200, Number(query?.limit ?? 100))).getMany();
    return { items: rows.map((r) => this.kbVo(r)), total: rows.length };
  }

  private kbVo(r: AiWasteKb) {
    return {
      kb_id: r.kb_id, station_id: r.station_id, kind: r.kind, waste_type: r.waste_type,
      ecrs: r.ecrs, problem: r.problem, suggestion: r.suggestion, evidence: r.evidence,
      keywords: r.keywords, element_types: r.element_types, source_origin: r.source_origin,
      source_ref: r.source_ref, hit_count: Number(r.hit_count), last_hit_at: r.last_hit_at,
      status: r.status, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  async updateKb(id: string, dto: any) {
    const row = await this.ds.getRepository(AiWasteKb).findOne({ where: { kb_id: id } });
    if (!row) throw new NotFoundException(`知识条目 ${id} 不存在`);
    const patch: any = { updated_at: new Date() };
    for (const k of ['status', 'waste_type', 'problem', 'suggestion', 'evidence', 'ecrs']) {
      if (dto?.[k] !== undefined) patch[k] = String(dto[k]).slice(0, 256);
    }
    if (dto?.general !== undefined) patch.station_id = dto.general ? null : row.station_id;
    await this.ds.getRepository(AiWasteKb).update({ kb_id: id }, patch);
    return this.kbVo((await this.ds.getRepository(AiWasteKb).findOne({ where: { kb_id: id } }))!);
  }

  async deleteKb(id: string) {
    const n = await this.ds.getRepository(AiWasteKb).delete({ kb_id: id });
    if (!n.affected) throw new NotFoundException(`知识条目 ${id} 不存在`);
    return { kb_id: id, deleted: true };
  }

  /**
   * 关键词/规则轻量检索（AI 生成时注入 prompt 用；零向量依赖）。
   * 打分：waste_type 命中 +3 / 要素类型命中 +2 每个 / 关键词命中 +1 每个 / 本工位专属 +2（通用为 +0）。
   * 返回按 kind 分组的 Top-N 文本行；命中行 hit_count++（越用越准的排序依据）。
   */
  private async searchKb(
    tenantId: string, stationId: string, elementTypes: string[],
    limit = 6,
  ): Promise<{ rows: AiWasteKb[]; lines: { kind: string; text: string }[] }> {
    let rows: AiWasteKb[] = [];
    try {
      rows = await this.ds.getRepository(AiWasteKb).createQueryBuilder('k')
        .where('k.tenant_id = :tid', { tid: tenantId })
        .andWhere('k.status = :st', { st: 'active' })
        .andWhere('(k.station_id IS NULL OR k.station_id = :sid)', { sid: stationId })
        .take(300).getMany();
    } catch {
      return { rows: [], lines: [] }; // 知识库表未建/查询失败 → 静默降级，不阻断 AI 生成
    }
    if (rows.length === 0) return { rows: [], lines: [] };
    const et = new Set(elementTypes.filter(Boolean).map((t) => String(t)));
    const qText = elementTypes.filter(Boolean).join(' ');
    const qEmbed = qText ? await this.embed(qText).catch(() => null) : null;
    const scored = rows.map((r) => {
      let score = 0;
      const kws = String(r.keywords ?? '').split(',').filter(Boolean);
      const types = String(r.element_types ?? '').split(',').filter(Boolean);
      for (const t of types) if (et.has(t)) score += 2;
      score += kws.length > 0 ? Math.min(3, kws.filter((k) => et.has(k)).length) : 0;
      if (r.station_id === stationId) score += 2;
      score += Math.min(2, Math.floor(Number(r.hit_count ?? 0) / 5));
      // v3.53 向量召回分支：embedding 后端启用且两边均有向量时，余弦相似度融合（缩放至与关键词分可比）
      if (qEmbed && r.embedding) {
        try {
          const kbVec = JSON.parse(r.embedding) as number[];
          const cos = this.cosine(qEmbed, kbVec);
          if (cos > 0) score += 0.4 * Math.max(0, cos) * 5;
        } catch { /* 向量解析失败忽略（退化为关键词分） */ }
      }
      return { row: r, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, limit).map((s) => s.row);
    const lines = picked.map((r) => ({
      kind: r.kind,
      text: r.kind === 'finding'
        ? `${r.waste_type}｜证据：${r.evidence ?? '—'}`
        : `${r.waste_type}｜${r.ecrs ?? 'S'}｜问题：${r.problem ?? '—'}｜措施：${r.suggestion ?? '—'}`,
    }));
    return { rows: picked, lines };
  }

  /** 命中计数（fire-and-forget：统计失败不影响生成主流程） */
  private async bumpKbHits(rows: AiWasteKb[]): Promise<void> {
    try {
      const repo = this.ds.getRepository(AiWasteKb);
      for (const r of rows) {
        await repo.update({ kb_id: r.kb_id }, { hit_count: Number(r.hit_count ?? 0) + 1, last_hit_at: new Date() });
      }
    } catch { /* 统计失败静默 */ }
  }

  /**
   * v3.53 向量化 embedding（默认关闭，零依赖零成本）。
   * 后端由 env AI_EMBED_BACKEND 控制：
   *   'ollama'   → 本地 Ollama /api/embeddings（AI_EMBED_OLLAMA_URL / AI_EMBED_MODEL）
   *   'transformers' → 懒加载 @xenova/transformers（仅启用且已安装时；AI_EMBED_MODEL 默认 all-MiniLM-L6-v2）
   *   其他/未配置 → 返回 null（退化为纯关键词打分，行为不变）
   * 任何失败静默返回 null，绝不阻断知识库主流程。
   */
  private async embed(text: string): Promise<number[] | null> {
    const backend = process.env.AI_EMBED_BACKEND;
    if (!backend || backend === 'none') return null;
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    try {
      if (backend === 'ollama') {
        const base = process.env.AI_EMBED_OLLAMA_URL ?? 'http://localhost:11434';
        const model = process.env.AI_EMBED_MODEL ?? 'nomic-embed-text';
        const r = await fetch(`${base}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: clean }),
        });
        if (!r.ok) return null;
        const data = (await r.json()) as any;
        return Array.isArray(data?.embedding) ? (data.embedding as number[]) : null;
      }
      if (backend === 'transformers') {
        // 懒加载，避免未安装时启动崩溃；非生产默认路径
        // @ts-ignore 动态加载：未安装 @xenova/transformers 时由 catch 兜底返回 null
        const mod = (await import('@xenova/transformers')) as any;
        const model = process.env.AI_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
        const pipe = await mod.pipeline('feature-extraction', model);
        const out = await pipe(clean, { pooling: 'mean', normalize: true });
        const vec = out?.data ?? out?.tensor?.data;
        return Array.isArray(vec) ? (vec as number[]).slice(0, 384) : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** 余弦相似度（应用层；KB 规模小，无性能压力） */
  private cosine(a: number[], b: number[]): number {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  // ───────────────────────── 状态流转（确认/忽略） ─────────────────────────

  /**
   * 确认（status='已确认'）→ 复制进 t_improvement（source='ai_waste'，溯源 issue_id）+ 回写。
   * 已确认/已忽略 → 409；工位不存在 → 404。
   */
  async settle(issueId: string, status: '已确认' | '已忽略', operator: string) {
    await this.assertEnabled();
    const issue = await this.issueRepo.findOne({ issue_id: issueId } as any);
    if (!issue) throw new NotFoundException(`问题条目 ${issueId} 不存在`);
    if (issue.status !== '待处理') throw new ConflictException(`问题条目状态为「${issue.status}」，只有待处理条目可流转`);

    if (status === '已忽略') {
      await this.issueRepo.update({ issue_id: issueId } as any, {
        status: '已忽略', reviewed_by: operator, reviewed_at: new Date(),
      } as any);
      const fresh = await this.issueRepo.findOne({ issue_id: issueId } as any);
      return this.issueVo(fresh!);
    }

    const station = await this.stationOf(issue.station_id);
    const impId = `IMP-${issue.station_id}-${Date.now()}-AIW`;
    await this.issueRepo.transaction(async (mgr) => {
      const imp: any = mgr.create(Improvement, {
        imp_id: impId, tenant_id: issue.tenant_id, station_id: issue.station_id,
        element_ids: '', waste_type: issue.waste_type, method: issue.ecrs,
        measure: `${issue.problem}｜改善建议：${issue.suggestion}`.slice(0, 250),
        est_save_s: Number(issue.est_save_s), priority: issue.priority,
        status: '待实施', before_ct: Number(station.ct ?? 0), after_ct: null,
        // v3.51：人工录入条目确认后溯源为 manual（AI 条目仍为 ai，既有契约不变）
        source: (issue as any).origin === 'manual' ? 'manual' : 'ai', ai_suggestion_id: issue.issue_id,
      } as any);
      await mgr.save(imp);      await mgr.update(AiWasteIssue, { issue_id: issueId } as any, {
        status: '已确认', imp_id: impId, reviewed_by: operator, reviewed_at: new Date(),
      } as any);
    });
    const fresh = await this.issueRepo.findOne({ issue_id: issueId } as any);
    return { ...this.issueVo(fresh!), imp_id: impId };
  }

  /** 工位删除级联（stations.service.remove 调用）：先子后主 */
  async cascadeDeleteByStation(stationId: string, mgr: import('typeorm').EntityManager): Promise<void> {
    const batches = await mgr.find(AiWasteBatch, { where: { station_id: stationId } as any });
    for (const b of batches) {
      await mgr.delete(AiWasteFinding, { batch_id: b.batch_id } as any);
      await mgr.delete(AiWasteIssue, { batch_id: b.batch_id } as any);
    }
    await mgr.delete(AiWasteBatch, { station_id: stationId } as any);
    // v3.51：人工录入条目（batch_id 为空，不在批次级联范围内）+ 本工位知识库条目
    await mgr.delete(AiWasteFinding, { station_id: stationId } as any);
    await mgr.delete(AiWasteIssue, { station_id: stationId } as any);
    await mgr.delete(AiWasteKb, { station_id: stationId } as any);
  }
}
