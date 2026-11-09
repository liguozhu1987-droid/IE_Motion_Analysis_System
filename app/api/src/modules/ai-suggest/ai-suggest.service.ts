import { BadRequestException, ConflictException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../core/config/configuration';
import { AppConfig } from '../../core/config/configuration';
import { BaseRepository } from '../../core/database/base.repository';
import { RulesService } from '../../core/rules/rules.service';
import { AiSuggestionBatch } from './entities/ai-suggestion-batch.entity';
import { AiSuggestion } from './entities/ai-suggestion.entity';
import { AiCustomDict } from './entities/ai-custom-dict.entity';
import { AiSetting } from './entities/ai-setting.entity';
import { AiLlmProfile } from './entities/ai-llm-profile.entity';
import { Improvement } from '../../entities/improvement.entity';
import { AnalysisService } from '../analysis/analysis.service';
import { StationRepository } from '../stations/stations.service';
import { ElementRepository } from '../elements/element.repository';
import { LlmGatewayService } from '../../ai/llm-gateway.service';
import {
  PROMPT_VERSION, SUGGEST_SYSTEM_PROMPT, buildSuggestUserPrompt,
  CompactElement, SuggestUserPayload,
} from './prompt';
import { ValidationContext, RawSuggestion, validateSuggestions, ValidatedItem } from './validator';
import { ComputeParams, estimateAnnualYuan, maxTokensFor, scoreBatch, sortWithVerif } from './calculator';
import { round2 } from '../../core/shared/util';

/** 建议表仓库（租户安全） */
class AiSuggestionRepository extends BaseRepository<AiSuggestion> {
  protected entityTarget() { return AiSuggestion; }
}
class AiBatchRepository extends BaseRepository<AiSuggestionBatch> {
  protected entityTarget() { return AiSuggestionBatch; }
}
class AiDictRepository extends BaseRepository<AiCustomDict> {
  protected entityTarget() { return AiCustomDict; }
}

/** 进程内 single-flight（并发安全③：同槽位并发请求合并为一次执行） */
const inflight = new Map<string, Promise<{ status: number; payload: any }>>();

/** LLM 建议条目数字字段剥除（铁律②：LLM 禁产数字，输出中的数字字段一律剥除重算） */
function stripNumbers(raw: any): RawSuggestion {
  return {
    element_seqs: Array.isArray(raw?.element_seqs) ? raw.element_seqs : [],
    waste_type: typeof raw?.waste_type === 'string' ? raw.waste_type : '',
    method: typeof raw?.method === 'string' ? raw.method : '',
    // factor 允许通过（枚举校验在 R1.2）；est_save_s/annual_yuan/priority/tier 等数字字段一律丢弃
    factor: Number.isFinite(Number(raw?.factor)) ? Number(raw.factor) : undefined,
    measure: typeof raw?.measure === 'string' ? raw.measure : '',
    eliminate_basis: typeof raw?.eliminate_basis === 'string' ? raw.eliminate_basis : undefined,
    verif: Number.isFinite(Number(raw?.verif)) ? Number(raw.verif) : undefined,
  };
}

/** 从 LLM 文本中提取 JSON 数组（容忍 markdown 围栏/前后缀文本；解析失败重试 1 次由调用方处理） */
export function extractJsonArray(text: string): any[] | null {
  const t = String(text ?? '').replace(/```json/gi, '```').trim();
  const fenced = /```([\s\S]*?)```/.exec(t);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** v3.46 来源线三值：mixed=全量（AI+手工混合，legacy 默认口径）/ manual=只手工分解写入的要素 / ai_assisted=只 AI 自动分解写入的要素 */
type SuggestSource = 'mixed' | 'manual' | 'ai_assisted';

/**
 * AI 改善建议服务（合并实施规格书 §1-§5）。
 * 复用：analyzeStation 口径（active 要素）/ LlmGateway（熔断/月度 token）
 * / checkRedlines 语义（本模块内实现，零修改现有引擎文件）/ estimateBenefit 公式口径。
 *
 * v3.46 双来源线（镜像 ai-waste 的双线隔离模式，两模块代码相互独立）：
 *  - mixed 为 legacy 默认口径（无 source query 参数的契约逐字节不变——存量批次默认值即 mixed）；
 *  - 幂等槽位 / single-flight / 缓存命中全部按 source 隔离（漏一处的后果是跨线幂等假 200 / 假 409）；
 *  - manual / ai_assisted 线只把对应来源（要素实体 source 列）的 active 要素送入 LLM 分析。
 */
@Injectable()
export class AiSuggestService {
  private readonly stationRepo: StationRepository;
  private readonly elementRepo: ElementRepository;
  private readonly suggRepo: AiSuggestionRepository;
  private readonly batchRepo: AiBatchRepository;
  private readonly dictRepo: AiDictRepository;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly analysis: AnalysisService,
    private readonly rules: RulesService,
    private readonly llm: LlmGatewayService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.stationRepo = new StationRepository(ds);
    this.elementRepo = new ElementRepository(ds);
    this.suggRepo = new AiSuggestionRepository(ds);
    this.batchRepo = new AiBatchRepository(ds);
    this.dictRepo = new AiDictRepository(ds);
  }

  // ───────────────────────── 开关与基础 ─────────────────────────

  /**
  /**
   * 生效 AI 配置（v3.31 建；v3.40 改三级优先）：启用的连接配置（t_ai_llm_profile）→
   * t_ai_setting 键值行（旧版兼容，管理员旧界面写入）→ .env。
   * profile.api_key 为空串视为未设（key 回落 env）；总开关 ai_enabled 仍独立读行。
   * 系统级配置（无租户列），直接用原始仓库，不走 BaseRepository（其强制注入 tenant_id）。
   */
  private async effectiveAi(): Promise<{ enabled: boolean; baseUrl: string; apiKey: string; model: string }> {
    const rows = await this.ds.getRepository(AiSetting).find();
    const map = new Map(rows.map((r) => [r.setting_key, String(r.setting_value ?? '')]));
    const db = (k: string): string | undefined => {
      const v = map.get(k);
      return v !== undefined && v !== '' ? v : undefined;
    };
    const enabledRaw = db('ai_enabled');
    // v3.40：启用的 profile 优先
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

  /** 开关关闭 → 503（语义：功能关闭；权限不足由守卫 403）。v3.31 起读「DB 优先 + env 回落」的生效开关 */
  private async assertEnabled(): Promise<void> {
    const eff = await this.effectiveAi();
    if (!eff.enabled) {
      throw new ServiceUnavailableException('AI 建议未启用（可在 AI 配置页开启服务，或设置 AI_SUGGEST_ENABLED=true）');
    }
  }

  /** config 只读（GET /ai-suggestions/config；ai:governance 或 user:read） */
  async config(userId: string) {
    const eff = await this.effectiveAi();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const tokensRow = await this.ds.getRepository(AiSuggestionBatch)
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.tokens_used), 0)', 's')
      .where('b.created_at >= :m', { m: monthStart })
      .getRawOne();
    const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
    const quota = user ? Number(user.ai_quota ?? 1) : 1;
    const used = user ? Number(user.ai_quota_used ?? 0) : 0;
    return {
      enabled: eff.enabled,
      model: eff.model,
      prompt_version: PROMPT_VERSION,
      batch_ceiling: this.cfg.aiBatchCeiling,
      quota_scope: this.cfg.aiQuotaScope,
      monthly_tokens_used: Number(tokensRow?.s ?? 0),
      monthly_token_limit: this.cfg.aiMonthlyTokenLimit,
      quota, quota_used: used,
      quota_unlimited: quota === -1,
      llm_circuit_open: this.llm.circuitOpen,
    };
  }

  // ───────────────────────── LLM 网关配置（v3.31 管理员 UI） ─────────────────────────

  /** api_key 脱敏：保留前 3 后 4；'na'/空显示为空 */
  private static maskKey(key: string): string {
    const k = String(key ?? '').trim();
    if (!k || k === 'na') return '';
    if (k.length <= 8) return '****';
    return `${k.slice(0, 3)}****${k.slice(-4)}`;
  }

  /** LLM 网关配置读取（user:write 或 ai:governance；api_key 永不回传明文）。v3.40：启用 profile 视为 db 来源 */
  async llmConfigGet() {
    const eff = await this.effectiveAi();
    const rows = await this.ds.getRepository(AiSetting).find();
    const has = new Set(rows.map((r) => r.setting_key));
    const active = await this.ds.getRepository(AiLlmProfile).findOne({ where: { enabled: true } });
    // v3.40：base_url/api_key/model 走启用 profile 时来源=db；enabled 总开关只看 ai_enabled 行
    const src = (k: string) => {
      if (k !== 'ai_enabled' && active) return 'db';
      return has.has(k) ? 'db' : 'env';
    };
    return {
      enabled: eff.enabled,
      enabled_source: src('ai_enabled'),
      base_url: eff.baseUrl,
      base_url_source: src('llm_base_url'),
      api_key_masked: AiSuggestService.maskKey(eff.apiKey),
      api_key_source: src('llm_api_key'),
      model: eff.model,
      model_source: src('llm_model'),
      active_profile: active ? { profile_id: active.profile_id, name: active.name } : null,
    };
  }

  /** LLM 网关配置写入（user:write）；api_key 传空串=清除覆盖（回落 .env）。
   *  v3.40：存在启用 profile 时改写该 profile；profiles 表完全无行时走旧 t_ai_setting 逻辑；有行但无启用 → 409 */
  async llmConfigSet(
    body: { enabled?: boolean; base_url?: string; api_key?: string; model?: string },
    username: string,
  ) {
    const settingRepo = this.ds.getRepository(AiSetting);
    const profileRepo = this.ds.getRepository(AiLlmProfile);
    const active = await profileRepo.findOne({ where: { enabled: true } });
    const anyProfile = await profileRepo.count();
    if (anyProfile > 0 && !active && (body.base_url !== undefined || body.api_key !== undefined || body.model !== undefined)) {
      throw new ConflictException('存在连接配置但无启用项——请先在「连接配置」中启用一条');
    }
    const upsert = async (key: string, value: string) => {
      const exist = await settingRepo.findOne({ where: { setting_key: key } });
      if (exist) {
        exist.setting_value = value;
        exist.updated_by = username;
        await settingRepo.save(exist);
      } else {
        await settingRepo.insert({ setting_key: key, setting_value: value, updated_by: username });
      }
    };
    // 值写入目标：有启用 profile 写 profile，否则写旧键值行
    const setVal = async (kind: 'base_url' | 'api_key' | 'model', v: string) => {
      if (active) {
        active[kind] = v;
        await profileRepo.save(active);
      } else if (kind === 'api_key' && v === '') {
        await settingRepo.delete({ setting_key: 'llm_api_key' });
      } else {
        const key = kind === 'base_url' ? 'llm_base_url' : kind === 'api_key' ? 'llm_api_key' : 'llm_model';
        await upsert(key, v);
      }
    };
    if (body.enabled !== undefined) await upsert('ai_enabled', body.enabled ? '1' : '0');
    if (body.base_url !== undefined) {
      const u = body.base_url.trim();
      if (!/^https?:\/\/.+/i.test(u)) throw new BadRequestException('Base URL 须以 http(s):// 开头');
      await setVal('base_url', u);
    }
    if (body.model !== undefined) {
      const m = body.model.trim();
      if (!m) throw new BadRequestException('模型名不能为空');
      await setVal('model', m);
    }
    if (body.api_key !== undefined) {
      const k = body.api_key.trim();
      if (k.length > 256) throw new BadRequestException('API Key 长度不能超过 256');
      await setVal('api_key', k);
    }
    return this.llmConfigGet();
  }

  // ───────────────────────── 连接配置 profiles（v3.40 多配置单活） ─────────────────────────

  /** profile 对外形状（api_key 永不回明文） */
  private static profileVo(p: AiLlmProfile) {
    return {
      profile_id: p.profile_id,
      name: p.name,
      base_url: p.base_url,
      api_key_masked: AiSuggestService.maskKey(p.api_key),
      model: p.model,
      enabled: p.enabled ? 1 : 0,
      created_at: p.created_at,
    };
  }

  private static assertProfileFields(body: { name?: string; base_url?: string; model?: string }) {
    if (body.name !== undefined && (!body.name.trim() || body.name.trim().length > 64)) {
      throw new BadRequestException('配置名称必填且不超过 64 字');
    }
    if (body.base_url !== undefined && !/^https?:\/\/.+/i.test(body.base_url.trim())) {
      throw new BadRequestException('Base URL 须以 http(s):// 开头');
    }
    if (body.model !== undefined && (!body.model.trim() || body.model.trim().length > 128)) {
      throw new BadRequestException('模型名必填且不超过 128 字');
    }
  }

  async llmProfilesList() {
    const repo = this.ds.getRepository(AiLlmProfile);
    const rows = await repo.find({ order: { enabled: 'DESC', created_at: 'ASC' } });
    return rows.map(AiSuggestService.profileVo);
  }

  async llmProfileCreate(body: { name: string; base_url: string; api_key?: string; model: string }, username: string) {
    AiSuggestService.assertProfileFields(body);
    const repo = this.ds.getRepository(AiLlmProfile);
    const key = String(body.api_key ?? '').trim();
    if (key.length > 256) throw new BadRequestException('API Key 长度不能超过 256');
    const anyActive = await repo.findOne({ where: { enabled: true } });
    const row = repo.create({
      profile_id: randomUUID(),
      name: body.name.trim(),
      base_url: body.base_url.trim(),
      api_key: key,
      model: body.model.trim(),
      enabled: !anyActive, // 首条自动启用
      created_by: username,
    });
    await repo.save(row);
    return AiSuggestService.profileVo(row);
  }

  async llmProfileUpdate(id: string, body: { name?: string; base_url?: string; api_key?: string; model?: string }) {
    AiSuggestService.assertProfileFields(body);
    const repo = this.ds.getRepository(AiLlmProfile);
    const row = await repo.findOne({ where: { profile_id: id } });
    if (!row) throw new NotFoundException('连接配置不存在');
    if (body.name !== undefined) row.name = body.name.trim();
    if (body.base_url !== undefined) row.base_url = body.base_url.trim();
    if (body.model !== undefined) row.model = body.model.trim();
    if (body.api_key !== undefined) {
      const k = body.api_key.trim();
      if (k.length > 256) throw new BadRequestException('API Key 长度不能超过 256');
      row.api_key = k; // 空串=清空（回落 env 语义）
    }
    await repo.save(row);
    return AiSuggestService.profileVo(row);
  }

  /** 启用（切换生效配置）：事务全清 0 后目标置 1；过滤唯一索引在库层兜底单活 */
  async llmProfileActivate(id: string) {
    const repo = this.ds.getRepository(AiLlmProfile);
    const row = await repo.findOne({ where: { profile_id: id } });
    if (!row) throw new NotFoundException('连接配置不存在');
    await this.ds.transaction(async (em) => {
      const r = em.getRepository(AiLlmProfile);
      await r.update({ enabled: true }, { enabled: false }); // 先熄灭当前启用行（空条件会被 TypeORM 拒绝）
      await r.update({ profile_id: id }, { enabled: true });
    });
    const fresh = await repo.findOne({ where: { profile_id: id } });
    return AiSuggestService.profileVo(fresh!);
  }

  async llmProfileRemove(id: string) {
    const repo = this.ds.getRepository(AiLlmProfile);
    const row = await repo.findOne({ where: { profile_id: id } });
    if (!row) throw new NotFoundException('连接配置不存在');
    if (row.enabled) throw new ConflictException('启用中的配置不可删除——请先启用其他配置');
    await repo.delete({ profile_id: id });
    return { profile_id: id, deleted: true };
  }

  /** test/e2e 共用：解析端点三元组——body 显式值 > profile_id 指定配置 > 生效配置（v3.40） */
  private async resolveLlmEndpoint(body: { profile_id?: string; base_url?: string; api_key?: string; model?: string }) {
    const eff = await this.effectiveAi();
    let baseUrl = eff.baseUrl;
    let apiKey = eff.apiKey;
    let model = eff.model;
    if (body.profile_id) {
      const p = await this.ds.getRepository(AiLlmProfile).findOne({ where: { profile_id: body.profile_id } });
      if (!p) throw new NotFoundException('连接配置不存在');
      baseUrl = p.base_url;
      if (p.api_key !== '') apiKey = p.api_key; // 空 key 回落生效链
      model = p.model;
    }
    return {
      baseUrl: (body.base_url?.trim() || baseUrl).replace(/\/+$/, ''),
      apiKey: body.api_key?.trim() ? body.api_key.trim() : apiKey,
      model: body.model?.trim() || model,
    };
  }

  // ───────────────────────── 连接测试（v3.32 行业最佳实践） ─────────────────────────

  /**
   * LLM 网关连接测试（POST /ai-suggestions/llm-config/test；user:write）。
   * 行业实践两级最小代价探测，**不写配置 / 不计配额 / 不计 token 统计 / 不影响熔断**：
   *  ① 零 token：GET {base}/models —— 验证 Base URL、网络可达、API Key 鉴权（不打模型、不花 token）
   *  ② 最小 token：POST {base}/chat/completions，max_tokens=1、temperature=0、单字 prompt
   *     —— 验证模型名有效、计费链路可用，实测消耗通常 1~3 token
   * 支持「表单值 dry-run」：不保存也能测（key 留空则用已存值）；错误按 HTTP/网络层分类并给修复建议。
   */
  async llmConfigTest(body: { profile_id?: string; base_url?: string; api_key?: string; model?: string }) {
    const ep = await this.resolveLlmEndpoint(body);
    const baseUrl = ep.baseUrl;
    const apiKey = ep.apiKey;
    const model = ep.model;
    if (!/^https?:\/\/.+/i.test(baseUrl)) throw new BadRequestException('Base URL 须以 http(s):// 开头');

    const auth = { authorization: `Bearer ${apiKey}` };
    const probe = async (path: string, init: RequestInit, timeoutMs: number) => {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(baseUrl + path, { ...init, signal: ctrl.signal });
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text, latency: Date.now() - t0, error: null as string | null };
      } catch (e: any) {
        const code = e?.name === 'AbortError' ? 'TIMEOUT' : String(e?.cause?.code ?? e?.code ?? 'NETWORK');
        return { ok: false, status: 0, body: '', latency: Date.now() - t0, error: code };
      } finally {
        clearTimeout(timer);
      }
    };

    /** 错误分类诊断（行业实践：把 401/404/超时/HTML 误指分开说，直接给修复动作） */
    const diagnose = (p: { status: number; error: string | null; body: string }, fallback = ''): { reason: string; suggestion: string } => {
      if (p.error === 'TIMEOUT') return { reason: '连接超时（8~15s 无响应）', suggestion: '检查 Base URL 是否可达、网络/代理是否放行；内网端点确认服务已启动' };
      if (p.error === 'ENOTFOUND') return { reason: '域名解析失败（DNS 找不到主机）', suggestion: '核对 Base URL 主机名拼写，或改用 IP 地址' };
      if (p.error === 'ECONNREFUSED') return { reason: '连接被拒绝（目标端口无服务）', suggestion: '确认 LLM 服务已启动且端口正确（如 vLLM 默认 8000）' };
      if (p.error === 'ECONNRESET') return { reason: '连接被重置（网络或代理中断）', suggestion: '检查代理/防火墙，HTTPS 证书与 TLS 版本是否被中间设备干扰' };
      if (p.error) return { reason: `网络错误（${p.error}）`, suggestion: '检查网络连通性与代理设置' };
      const excerpt = p.body.trim().slice(0, 1);
      if (excerpt === '<') return { reason: '返回 HTML 而非 API JSON', suggestion: 'Base URL 可能指向了网页/网关登录页——应填 API 前缀，如 https://host/v1' };
      switch (p.status) {
        case 400: return { reason: '请求被拒（400）', suggestion: '常见原因：模型名不存在、参数不被该网关支持。核对「模型名」与网关文档' };
        case 401: return { reason: 'API Key 无效或未授权（401）', suggestion: '重新复制密钥（注意首尾空格/换行），或该 Key 已被吊销、已过有效期' };
        case 403: return { reason: 'API Key 无该接口/模型权限（403）', suggestion: '为该 Key 开通 chat 权限，或改用有权限的 Key' };
        case 404: return { reason: '接口路径不存在（404）', suggestion: 'Base URL 通常应以 /v1 结尾（如 https://host/v1）；部分网关路径为 /openai/v1' };
        case 429: return { reason: '限流或额度耗尽（429）', suggestion: '稍后重试；确认账户余额/配额，或降低并发' };
        default:
          return p.status >= 500
            ? { reason: `上游服务异常（HTTP ${p.status}）`, suggestion: '网关自身故障或过载，查看网关日志；稍后重试' }
            : { reason: fallback || `请求失败（HTTP ${p.status}）`, suggestion: '对照网关文档检查 Base URL 与鉴权头要求' };
      }
    };

    const scoped = (s: string) => (apiKey && apiKey.length > 4 ? s.split(apiKey).join('***') : s);

    // ① 零 token 探活：列模型
    const models = await probe('/models', { method: 'GET', headers: auth }, 8000);
    let modelListed: boolean | null = null;
    let modelsSample: string[] = [];
    if (models.ok) {
      try {
        const j = JSON.parse(models.body) as any;
        const ids: string[] = Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? '')).filter(Boolean) : [];
        modelsSample = ids.slice(0, 8);
        if (ids.length) modelListed = ids.includes(model);
      } catch { /* 非标准 /models 响应：仅当探活成功处理，不算失败 */ }
    }

    // ② 最小 token：1 token 单字对话（temperature=0 保证确定性；带 thinking:disabled——推理模型 max_tokens=1 时
    //    token 全被思维链吃光，content 恒空，且部分网关按「无 content 输出」计费口径不同；不支持该参数的网关忽略即可）
    const chat = await probe('/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, temperature: 0, thinking: { type: 'disabled' } }),
    }, 15000);
    let tokensUsed: number | null = null;
    let chatJsonValid = false;
    if (chat.ok) {
      try {
        const j = JSON.parse(chat.body) as any;
        chatJsonValid = Array.isArray(j?.choices);
        tokensUsed = Number(j?.usage?.total_tokens ?? NaN);
        if (!Number.isFinite(tokensUsed)) tokensUsed = null;
      } catch { /* 非 JSON：下面按失败处理 */ }
    }

    // 结论：以 chat 为主判据（部分网关不实现 /models）；/models 失败但 chat 通过 → 仅提示
    // 200 但非 chat/completions JSON（HTML 错误页/代理页）必须判失败，否则会「假联通」
    const ok = chat.ok && chatJsonValid;
    const chatDiag = ok
      ? { reason: '', suggestion: '' }
      : (chat.ok && !chatJsonValid
        ? { reason: '返回 200 但响应不是 chat/completions JSON', suggestion: 'Base URL 可能指向网页/代理页或网关错误页——应填 API 前缀（如 https://host/v1）' }
        : diagnose(chat, '模型调用失败'));
    const modelsDiag = models.ok ? { reason: '', suggestion: '' } : diagnose(models);
    const warnings: string[] = [];
    if (ok && !models.ok) warnings.push(`零 token 探活未通过（${modelsDiag.reason}），但对话调用成功——部分网关不开放 /models，可忽略`);
    if (ok && modelListed === false) warnings.push(`模型「${model}」未出现在 /models 清单中，但对话调用成功（可能是别名或按需加载）`);
    if (ok && !apiKey.trim()) warnings.push('未配置 API Key——内网网关可能免鉴权，公网 API 通常需要');

    return {
      ok,
      base_url: baseUrl,
      model,
      api_key_set: Boolean(apiKey.trim()) && apiKey.trim() !== 'na',
      latency_ms: models.latency + chat.latency,
      tokens_used: tokensUsed,
      model_listed: modelListed,
      models_sample: modelsSample,
      checks: {
        models: {
          ok: models.ok, http_status: models.status, latency_ms: models.latency,
          reason: models.ok ? null : modelsDiag.reason,
          suggestion: models.ok ? null : modelsDiag.suggestion,
          sample: scoped(models.body).slice(0, 160) || null,
        },
        chat: {
          ok: chat.ok, http_status: chat.status, latency_ms: chat.latency,
          reason: ok ? null : chatDiag.reason,
          suggestion: ok ? null : chatDiag.suggestion,
          sample: chat.ok ? null : scoped(chat.body).slice(0, 160),
        },
      },
      diagnosis: ok ? null : chatDiag.reason,
      suggestion: ok ? null : chatDiag.suggestion,
      warnings,
    };
  }

  /**
   * AI 功能端到端自测（v3.35；POST /ai-suggestions/llm-config/e2e-test；user:write）。
   * 定位：配置完密钥后「一键验证 AI 功能模块本身能否产出合格建议」——
   * 用内置迷你工位样例走 **真实全链路**：LLM 调用 → JSON 解析 → 数字剥除 → 三轮校验 → 数字计算。
   * 与连接测试的区别：llm-config/test 只验证网关通；本方法验证「AI 产出符合本系统规格」。
   * 纪律：结果**完全不落库**（无批次/无建议行）、不扣配额、不计月度 token、不产生任何正式数据。
   */
  async llmE2eTest(body: { profile_id?: string; base_url?: string; api_key?: string; model?: string }) {
    const ep = await this.resolveLlmEndpoint(body);
    const baseUrl = ep.baseUrl;
    const apiKey = ep.apiKey;
    const model = ep.model;
    if (!/^https?:\/\/.+/i.test(baseUrl)) throw new BadRequestException('Base URL 须以 http(s):// 开头');

    /* ── 内置迷你样例（合成工位：3 要素 + 规则引擎已知浪费）——不查 DB，样例自洽 ──
     * ① 持住（NVA，E 类目标：治具代手 → 全额节省）
     * ② 寻找（辅助/RNVA，S 类：料盒可视化管理 → 0.5 折）
     * ③ 预对已给证据（R3.4 要求分析证据） */
    const elements = [
      { seq: 1, type: '持住', va_class: 'NVA', dur_s: 2.0, hand: 'L', desc: '扶住壳体等待右侧装配' },
      { seq: 2, type: '寻找', va_class: 'RNVA', dur_s: 1.5, hand: 'R', desc: '在料盒中寻找螺丝' },
      { seq: 3, type: '装配', va_class: 'VA', dur_s: 3.0, hand: 'R', desc: '将螺丝装入孔位' },
    ];
    const wastes = [
      { waste: '持住', evidence: 'L 手 2s 静止扶住壳体（seq1 全程）', seqs: [1] },
      { waste: '寻找', evidence: 'R 手 1.5s 在料盒内翻找（seq2）', seqs: [2] },
    ];
    const whitelist = ['动作浪费', '等待浪费', '搬运浪费', '库存浪费', '不良浪费', '过剩浪费', '流程浪费', '持住浪费', '寻找', '选择', '预对', '持住', '等待', '搬运'];
    const factorLevels = [0.3, 0.5, 0.6, 0.8];

    const compact = elements.map((el) => ({
      seq: el.seq, type: el.type, va_class: el.va_class, dur_s: el.dur_s, hand: el.hand, desc: el.desc,
    }));
    const userPrompt = buildSuggestUserPrompt({
      station_id: 'E2E-TEST', ct: 6.5, tt: 8, process_type: '装配',
      elements: compact, wastes, waste_whitelist: whitelist, factor_levels: factorLevels,
    });
    const messages = [
      { role: 'system' as const, content: SUGGEST_SYSTEM_PROMPT },
      { role: 'user' as const, content: userPrompt },
    ];
    const opts = {
      maxTokens: maxTokensFor(compact.length), temperature: 0.3, ignoreGlobalSwitch: true, disableThinking: true,
      endpoint: { baseUrl, apiKey, model },
    };

    const t0 = Date.now();
    let text = '';
    let tokensUsed = 0;
    let parsed: any[] | null = null;
    let parseError: string | null = null;
    try {
      // 解析失败重试 1 次（与正式生成同语义）
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await this.llm.chat(messages, opts);
        tokensUsed += r.tokensUsed;
        text = r.text;
        parsed = extractJsonArray(r.text);
        if (parsed !== null) break;
      }
      if (parsed === null) parseError = `LLM 输出无法解析为 JSON 数组：${text.slice(0, 120)}`;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      /* 200 + 响应体非 JSON：res.json() 抛 SyntaxError——语义上属「响应不可解析」（parse），
       * 与网络/HTTP 层失败（llm_call）区分。真实场景多为 Base URL 未指向 OpenAI 兼容网关。 */
      if (/Unexpected token|is not valid JSON|invalid json/i.test(msg)) {
        return {
          ok: false, stage: 'parse', latency_ms: Date.now() - t0, tokens_used: 0,
          model, base_url: baseUrl,
          error: `网关响应不是合法 JSON：${msg.slice(0, 160)}`,
          suggestion: 'Base URL 大概率未指向 OpenAI 兼容网关（缺 /v1 或指向了网页）——先用「测试连接」诊断端点',
        };
      }
      return {
        ok: false, stage: 'llm_call', latency_ms: Date.now() - t0, tokens_used: 0,
        model, base_url: baseUrl,
        error: `LLM 调用失败：${msg.slice(0, 160)}`,
        suggestion: '先用「测试连接」确认网关连通（401=Key 无效、404=路径错、429=限流）；本测试在该基础之上验证 AI 产出质量',
      };
    }
    if (parseError) {
      return {
        ok: false, stage: 'parse', latency_ms: Date.now() - t0, tokens_used: tokensUsed,
        model, base_url: baseUrl, error: parseError,
        raw_head: text.slice(0, 200),
        suggestion: '模型未按 JSON 数组输出——确认模型遵循指令能力（建议 ≥7B 指令模型），或 PV1 提示词需适配该模型',
      };
    }

    /* ── 与正式生成完全一致的三轮校验 + 数字计算（铁律②：数字剥除重算） ── */
    const customs = await this.dictRepo.find({ dict_type: 'waste_type', status: 'active' } as any);
    const ctx: ValidationContext = {
      elements: elements.map((el) => ({
        element_id: `e2e-${el.seq}`, seq: el.seq, type: el.type, va_class: el.va_class,
        dur_s: el.dur_s, std_time: el.dur_s, hand: el.hand, desc: el.desc,
      })),
      ct: 6.5,
      wastes: wastes.map((w) => ({ waste: w.waste, element_ids: w.seqs.map((s) => `e2e-${s}`) })),
      factorSet: factorLevels,
      wasteWhitelist: whitelist,
      customDict: [],
      batchCeiling: this.cfg.aiBatchCeiling,
    };
    void customs; // 样例无租户自定义字典（读出来仅对齐正式链路行为）

    const raws: RawSuggestion[] = parsed!.map(stripNumbers);
    const vr = validateSuggestions(raws, ctx);

    // 数字计算（正产线参数不可用 → dailyOutput=null → annual_yuan=null 无假金额，铁律②）
    const params: ComputeParams = { dailyOutput: null, rateYuanPerHour: null, realizationRate: 0.7 };
    const scores = scoreBatch(vr.items, params);

    const latency = Date.now() - t0;
    const dropped = Math.max(0, raws.length - vr.items.length);
    const passed = vr.items.length > 0 && !vr.batchBlocked;

    return {
      ok: passed,
      stage: passed ? 'done' : 'validation',
      latency_ms: latency,
      tokens_used: tokensUsed,
      model, base_url: baseUrl,
      raw_count: raws.length,
      accepted_count: vr.items.length,
      dropped_count: dropped,
      batch_blocked: vr.batchBlocked ?? null,
      suggestions: vr.items.map((it, i) => ({
        element_seqs: it.element_ids.map((id) => Number(String(id).replace(/^e2e-/, '')) || 0),
        waste_type: it.waste_type, method: it.method,
        factor: it.factor ?? null, measure: it.measure,
        est_save_s: scores[i]?.est_save_s ?? null,
        priority: scores[i]?.priority ?? null, tier: scores[i]?.tier ?? null,
        risk_flags: it.risk_flags,
        trace_rounds: [...new Set(it.trace.map((t: any) => t.round))],
      })),
      validation_blocked: vr.batchBlocked ? { message: vr.batchBlocked } : null,
      error: passed ? null : (vr.batchBlocked ?? '全部候选被三轮校验剔除（accepted=0）'),
      suggestion: passed
        ? null
        : (vr.batchBlocked
          ? '整批被拦截——多为 CT/上限口径问题，查看 validation_blocked 详情'
          : 'AI 产出全部被校验剔除：常见原因是 waste_type 不在白名单、method/factor 非法、或描述过短——建议换更强指令模型'),
      raw_head: vr.items.length === 0 ? text.slice(0, 200) : undefined,
    };
  }

  // ───────────────────────── 生成（幂等槽位） ─────────────────────────

  /**
   * 生成 AI 建议（POST /stations/:stationId/ai-suggestions/generate）。
   * 槽位判定：done/done_empty→200 幂等；pending/running→409；无槽位且配额尽→429；
   * failed→重开（attempt+1 不计费）；成功→running→LLM→三轮校验→落库。
   * v3.46：source 缺省 mixed（legacy 全量口径，契约不变）；槽位/single-flight 按 source 隔离。
   */
  async generate(stationId: string, userId: string, source: SuggestSource = 'mixed'): Promise<{ status: number; payload: any }> {
    await this.assertEnabled();
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);

    // 配额语义：is_unlimited = 持 user:write ∨ quota=-1（超管豁免，DB 值对超管无效）
    const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
    if (!user) throw new NotFoundException(`用户 ${userId} 不存在`);
    const quota = Number(user.ai_quota ?? 1);
    const used = Number(user.ai_quota_used ?? 0);
    const hasUserWrite = this.userHasPermission(userId, 'user:write');
    const isUnlimited = hasUserWrite || quota === -1;

    // 槽位查询：station 维度（规格书 §1 ⚠：唯一索引含 version，业务按 (tenant,station,user) 查任意版本成功槽位）
    const slotWhere: Record<string, unknown> = { tenant_id: station.tenant_id, station_id: stationId, user_id: userId };
    if (this.cfg.aiQuotaScope === 'station+version') slotWhere.version = station.version;

    // single-flight：同槽位同来源线并发合并（v3.46：flightKey 含 source——跨线不得互并）
    const flightKey = `${station.tenant_id}|${stationId}|${userId}|${source}`;
    const existing = inflight.get(flightKey);
    if (existing) return existing;

    const task = this.doGenerate(station, user, { quota, used, isUnlimited }, slotWhere, flightKey, source);
    inflight.set(flightKey, task);
    try {
      return await task;
    } finally {
      inflight.delete(flightKey);
    }
  }

  private async doGenerate(
    station: any,
    user: any,
    quotaInfo: { quota: number; used: number; isUnlimited: boolean },
    slotWhere: Record<string, unknown>,
    flightKey: string,
    source: SuggestSource,
  ): Promise<{ status: number; payload: any }> {
    const userId = user.user_id;
    const anyVersionSlot = await this.batchRepo.findOne({ ...slotWhere, ...(this.cfg.aiQuotaScope === 'station+version' ? {} : {}) });
    // station 维度：查该 (tenant,station,user) 是否已有**任意版本**的成功槽位（v3.46：按来源线隔离）
    const successSlot = await this.ds.getRepository(AiSuggestionBatch)
      .createQueryBuilder('b')
      .where('b.tenant_id = :tid AND b.station_id = :sid AND b.user_id = :uid', { tid: station.tenant_id, sid: station.station_id, uid: userId })
      .andWhere('b.element_source = :src', { src: source })
      .andWhere('b.status IN (:...sts)', { sts: ['done', 'done_empty'] })
      .orderBy('b.created_at', 'DESC')
      .getOne();

    // 幂等返回对**所有用户**生效（规格书 §4：done/done_empty→200 返回已有结果，不调模型不动配额；
    // 唯一过滤索引只承担配额管控——is_unlimited 用户同样幂等，否则每次生成都新建批次烧 token）
    if (successSlot) {
      const suggestions = await this.listByBatch(successSlot.batch_id);
      return {
        status: 200,
        payload: {
          idempotent_hit: true, batch_id: successSlot.batch_id, status: successSlot.status,
          suggestion_count: successSlot.suggestion_count, completed_at: successSlot.completed_at,
          suggestions, station_id: station.station_id, version: successSlot.version,
          element_source: source,
        },
      };
    }

    // 无成功槽位：查活动槽位（pending/running，按来源线隔离）→ 409
    const activeSlot = await this.ds.getRepository(AiSuggestionBatch)
      .createQueryBuilder('b')
      .where('b.tenant_id = :tid AND b.station_id = :sid AND b.user_id = :uid', { tid: station.tenant_id, sid: station.station_id, uid: userId })
      .andWhere('b.element_source = :src', { src: source })
      .andWhere('b.status IN (:...sts)', { sts: ['pending', 'running'] })
      .getOne();
    if (activeSlot) {
      throw new ConflictException({ message: '该工位已有 AI 生成任务进行中', code: 'AI_BATCH_IN_PROGRESS', batch_id: activeSlot.batch_id });
    }

    // 配额判定（无槽位且配额尽 → 429；failed 重开不计费）
    if (!quotaInfo.isUnlimited) {
      if (quotaInfo.quota === 0) {
        throw new HttpException({ message: 'AI 建议已对你禁用（ai_quota=0）', code: 'AI_QUOTA_DISABLED' }, 429);
      }
      if (quotaInfo.quota > 0 && quotaInfo.used >= quotaInfo.quota) {
        throw new HttpException({ message: `AI 生成配额已用尽（${quotaInfo.used}/${quotaInfo.quota}），请联系管理员调整`, code: 'AI_QUOTA_EXCEEDED' }, 429);
      }
    }

    // 失败槽位重开 or 新建槽位（is_unlimited=1 绕过唯一过滤索引；v3.46：按来源线隔离）
    const eff = await this.effectiveAi();
    const inputHash = await this.computeInputHash(station, source);
    let batch: AiSuggestionBatch | null = await this.batchRepo.findOne({ ...slotWhere, status: 'failed', element_source: source } as any);
    if (batch) {
      await this.batchRepo.update({ batch_id: batch.batch_id }, {
        status: 'running', attempt: batch.attempt + 1, error: null, input_hash: inputHash,
      } as any);
      batch = await this.batchRepo.findOne({ batch_id: batch.batch_id } as any);
    } else {
      try {
        batch = await this.batchRepo.create({
          batch_id: randomUUID(), tenant_id: station.tenant_id, station_id: station.station_id,
          version: station.version, user_id: userId, is_unlimited: quotaInfo.isUnlimited ? 1 : 0,
          status: 'running', input_hash: inputHash, attempt: 1,
          model: eff.model, prompt_version: PROMPT_VERSION, element_source: source,
        } as any);
      } catch (e: any) {
        // 并发撞唯一索引（mssql 2601/2627；sqlite UNIQUE constraint failed）→ 查已有转 200/409（按来源线查）
        if (/2601|2627|UNIQUE/i.test(String(e?.message ?? e?.code ?? ''))) {
          const concurrent = await this.ds.getRepository(AiSuggestionBatch)
            .createQueryBuilder('b')
            .where('b.tenant_id = :tid AND b.station_id = :sid AND b.user_id = :uid', { tid: station.tenant_id, sid: station.station_id, uid: userId })
            .andWhere('b.element_source = :src', { src: source })
            .orderBy('b.created_at', 'DESC')
            .getOne();
          if (concurrent?.status === 'done' || concurrent?.status === 'done_empty') {
            const suggestions = await this.listByBatch(concurrent.batch_id);
            return { status: 200, payload: { idempotent_hit: true, batch_id: concurrent.batch_id, status: concurrent.status, suggestions, station_id: station.station_id, version: concurrent.version, element_source: source } };
          }
          throw new ConflictException({ message: '该工位已有 AI 生成任务进行中', code: 'AI_BATCH_IN_PROGRESS', batch_id: concurrent?.batch_id ?? null });
        }
        throw e;
      }
    }
    const batchId = batch!.batch_id;

    // 缓存命中（调用策略 3）：同 (tenant,station,version,input_hash,来源线) 有 done 批 → 克隆结果、tokens_used=0
    const cacheHit = await this.ds.getRepository(AiSuggestionBatch)
      .createQueryBuilder('b')
      .where('b.tenant_id = :tid AND b.station_id = :sid AND b.version = :ver AND b.input_hash = :h AND b.element_source = :src AND b.status = :st AND b.batch_id != :self', { tid: station.tenant_id, sid: station.station_id, ver: station.version, h: inputHash, src: source, st: 'done', self: batchId })
      .orderBy('b.created_at', 'DESC')
      .getOne();
    if (cacheHit) {
      const cloned = await this.cloneFromCache(batchId, cacheHit);
      return { status: 200, payload: { batch_id: batchId, status: 'done', cache_from: cacheHit.batch_id, suggestion_count: cloned.length, suggestions: cloned, station_id: station.station_id, version: station.version, element_source: source } };
    }

    // 真实 LLM 调用 + 三轮校验
    try {
      const result = await this.runLlmAndValidate(station, batchId, userId, source);
      const doneStatus = result.length > 0 ? 'done' : 'done_empty';
      // 配额自增与批次 done 同事务（纪律⑤；done_empty 计费——模型成本已发生）
      await this.batchRepo.transaction(async (mgr) => {
        await mgr.update(AiSuggestionBatch, { batch_id: batchId } as any, {
          status: doneStatus, suggestion_count: result.length, completed_at: new Date(),
        } as any);
        if (!quotaInfo.isUnlimited) {
          // 双方言：TypeORM mssql 绑定名为 @0/@1（index.toString()，㊱b 延伸）；sqlite 用 ? 位置占位
          if (this.cfg.dbType === 'mssql') {
            await mgr.query('UPDATE t_user SET ai_quota_used = ai_quota_used + 1 WHERE user_id = @0', [userId]);
          } else {
            await mgr.query('UPDATE t_user SET ai_quota_used = ai_quota_used + 1 WHERE user_id = ?', [userId]);
          }
        }
      });
      const suggestions = await this.listByBatch(batchId);
      return { status: 200, payload: { batch_id: batchId, status: doneStatus, suggestion_count: result.length, completed_at: new Date().toISOString(), suggestions, station_id: station.station_id, version: station.version, element_source: source } };
    } catch (e: any) {
      // 模型/网络失败 → failed（不计费，attempt 已记审计，无 24h 上限——P1-6）
      await this.batchRepo.update({ batch_id: batchId }, { status: 'failed', error: String(e?.message ?? e).slice(0, 256) } as any);
      throw new ServiceUnavailableException(`AI 生成失败：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  /** input_hash = sha1(紧凑负载 + 规则 rv + prompt_version)（调用策略 3；v3.46：按来源线分线计算） */
  private async computeInputHash(station: any, source: SuggestSource): Promise<string> {
    const [elements, wastes] = await this.loadStationContext(station, source);
    const ecrsa = this.rules.getActive('ecrsa_map');
    const wasteRules = this.rules.getActive('waste_triggers');
    const payload: SuggestUserPayload = {
      station_id: station.station_id, ct: Number(station.ct ?? 0), tt: Number(station.tt ?? 0),
      process_type: '装配', elements, wastes, waste_whitelist: [], factor_levels: [],
    };
    const raw = JSON.stringify({ payload, ecrsa: ecrsa.version, waste: wasteRules.version, pv: PROMPT_VERSION });
    return createHash('sha1').update(raw).digest('hex');
  }

  /** 按来源线装载（v3.46）：mixed=全量 active（legacy 口径）；manual/ai_assisted=只取对应来源子集的 active 要素。
   *  要素实体来源字段名为 source（值 'manual'|'ai_assisted'）→ 紧凑负载 + 分析 wastes */
  private async loadStationContext(station: any, source: SuggestSource): Promise<[CompactElement[], { waste: string; evidence: string; seqs: number[] }[]]> {
    const analysis = await this.analysis.analyzeStationAtVersion(station, station.version);
    const active = (analysis.elements ?? []).filter((el: any) => Number(el.outlier_flag) === 0 && (source === 'mixed' || el.source === source));
    const compact: CompactElement[] = active.map((el: any) => ({
      seq: Number(el.seq), type: el.type, va_class: el.va_effective ?? el.va_class,
      dur_s: round2(Number(el.dur_s)), hand: el.hand, desc: String(el.desc ?? '').slice(0, 60),
    }));
    const wastes = (analysis.wastes ?? []).map((w: any) => ({
      waste: w.waste, evidence: String(w.evidence ?? '').slice(0, 80), seqs: (w.seqs ?? []).map(Number),
    }));
    return [compact, wastes];
  }

  /** 动态 waste 白名单（P1-1）：waste_triggers ∪ ecrsa_map ∪ 租户 active 自定义。禁用 util.ts WASTE_TYPES */
  private async wasteWhitelist(tenantId: string): Promise<string[]> {
    const set = new Set<string>();
    for (const t of this.rules.getActive('waste_triggers').json?.triggers ?? []) set.add(t.waste);
    for (const m of this.rules.getActive('ecrsa_map').json?.mappings ?? []) set.add(m.waste);
    const customs = await this.dictRepo.find({ dict_type: 'waste_type', status: 'active' } as any);
    for (const c of customs) if (c.tenant_id === tenantId) set.add(c.name);
    return [...set];
  }

  /** factor 六档（P0-1）：ecrsa_map.mappings[].factor 动态去重 */
  private factorSet(): number[] {
    return [...new Set<number>((this.rules.getActive('ecrsa_map').json?.mappings ?? []).map((m: any) => Number(m.factor)))]
      .sort((a, b) => a - b);
  }

  /** LLM 调用 + 三轮校验 + 数字计算 + 落库（校验轨迹随行；v3.46：按来源线过滤输入要素） */
  private async runLlmAndValidate(station: any, batchId: string, userId: string, source: SuggestSource): Promise<ValidatedItem[]> {
    const [compact, wastes] = await this.loadStationContext(station, source);
    const analysis = await this.analysis.analyzeStationAtVersion(station, station.version);
    // ctx.elements 用来源线过滤后的 active 子集，保持与 prompt 输入（compact）一致
    const activeEls = (analysis.elements ?? []).filter((el: any) => Number(el.outlier_flag) === 0 && (source === 'mixed' || el.source === source));
    const whitelist = await this.wasteWhitelist(station.tenant_id);
    const factors = this.factorSet();
    const customs = await this.dictRepo.find({ dict_type: 'waste_type', status: 'active' } as any);

    const ctx: ValidationContext = {
      elements: activeEls.map((el: any) => ({
        element_id: el.element_id, seq: Number(el.seq), type: el.type,
        va_class: el.va_effective ?? el.va_class, dur_s: Number(el.dur_s),
        std_time: Number(el.std_time), hand: el.hand, desc: el.desc,
      })),
      ct: Number(analysis.metrics?.ct ?? 0),
      wastes: (analysis.wastes ?? []).map((w: any) => ({ waste: w.waste, element_ids: w.element_ids ?? [] })),
      factorSet: factors,
      wasteWhitelist: whitelist,
      customDict: customs.filter((c) => c.tenant_id === station.tenant_id).map((c) => ({
        dict_type: c.dict_type, code: c.code, name: c.name, va_class: c.va_class,
        method_hint: c.method_hint, action_class: c.action_class,
      })),
      batchCeiling: this.cfg.aiBatchCeiling,
    };

    const userPrompt = buildSuggestUserPrompt({
      station_id: station.station_id, ct: Number(analysis.metrics?.ct ?? 0), tt: Number(station.tt ?? 0),
      process_type: '装配', elements: compact, wastes,
      waste_whitelist: whitelist, factor_levels: factors,
    });
    const messages = [
      { role: 'system' as const, content: SUGGEST_SYSTEM_PROMPT },
      { role: 'user' as const, content: userPrompt },
    ];
    const effLlm = await this.effectiveAi();
    const opts = { maxTokens: maxTokensFor(compact.length), temperature: 0.3, ignoreGlobalSwitch: true, disableThinking: true, endpoint: { baseUrl: effLlm.baseUrl, apiKey: effLlm.apiKey, model: effLlm.model } };

    // 解析失败重试 1 次（规格书 §5）
    const llm = this.llm;
    let parsed: any[] | null = null;
    let tokensUsed = 0;
    let lastText = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await llm.chat(messages, {
        ...opts,
        usage: {
          feature: 'improvement_suggestion', tenantId: station.tenant_id,
          userId, stationId: station.station_id, lineId: station.line_id,
          batchId, attemptNo: attempt + 1,
        },
      });
      tokensUsed += r.tokensUsed;
      lastText = r.text;
      parsed = extractJsonArray(r.text);
      if (parsed !== null) break;
    }
    if (parsed === null) throw new Error(`LLM 输出无法解析为 JSON 数组：${lastText.slice(0, 80)}`);

    // 数字字段剥除（铁律②）→ 三轮校验
    const raws: RawSuggestion[] = parsed.map(stripNumbers);
    const vr = validateSuggestions(raws, ctx);
    if (vr.batchBlocked) throw new BadRequestException(vr.batchBlocked);

    // 记录 token 用量
    await this.batchRepo.update({ batch_id: batchId }, { tokens_used: tokensUsed } as any);

    // 数字计算（est_save_s 已在 R2.4 算出；priority/tier/annual_yuan 此处补齐）
    const params = this.lineParams(station.line_id);
    const scores = scoreBatch(vr.items, params);
    const rawJson = JSON.stringify(parsed).slice(0, 20000);

    await this.batchRepo.transaction(async (mgr) => {
      for (let i = 0; i < vr.items.length; i++) {
        const it = vr.items[i];
        const sc = scores[i];
        // R2.6 补判：urgent_claim 且 tier≠P1 → manual_review
        const flags = [...it.risk_flags];
        if (flags.includes('urgent_claim') && sc.tier !== 'P1') {
          flags.push('manual_review');
          it.trace.push({ round: 'R2', rule: 'R2.6', hit: true, disposition: 'flag', reason: 'measure 自夸高优先但 tier≠P1 → manual_review' });
        }
        const row: any = mgr.create(AiSuggestion, {
          suggestion_id: randomUUID(), batch_id: batchId,
          tenant_id: station.tenant_id, station_id: station.station_id, version: station.version,
          element_ids: it.element_ids.join(','), waste_type: it.waste_type,
          method: it.method, action_class: it.action_class, measure: it.measure,
          eliminate_basis: it.eliminate_basis, est_save_s: it.est_save_s,
          priority: sc.priority, tier: sc.tier, difficulty: it.difficulty, verif: it.verif,
          risk_flags: flags.length > 0 ? flags.join('|') : null,
          status: '待审',
          validation_trace: JSON.stringify(it.trace),
          raw_json: rawJson,
        } as any);
        await mgr.save(row);
      }
    });
    return vr.items;
  }

  /** 产线收益参数（复用 getLineParams 口径；未配置 → null，无假金额 P0-5） */
  private lineParams(lineId: string): ComputeParams {
    const json = this.rules.getActive('benefit_params').json;
    const fromLines = (json?.lines ?? []).find((l: any) => l?.line_id === lineId);
    const raw = fromLines ?? json?.by_line?.[lineId] ?? null;
    if (!raw) return { dailyOutput: null, rateYuanPerHour: null, realizationRate: null };
    const dailyOutput = Number(raw.daily_output);
    const rate = Number(raw.rate_yuan_per_hour ?? raw.rate);
    const land = Number(raw.land_rate ?? raw.realization_rate ?? 0.7);
    if (!Number.isFinite(dailyOutput) || dailyOutput <= 0 || !Number.isFinite(rate) || rate <= 0) {
      return { dailyOutput: null, rateYuanPerHour: null, realizationRate: null };
    }
    return { dailyOutput, rateYuanPerHour: rate, realizationRate: Number.isFinite(land) && land > 0 ? land : 0.7 };
  }

  /** 缓存克隆：结果建议复制到新批次（tokens_used=0、cache_from 记源）。读**原始实体**（VO 的 element_ids 是数组，不能回写实体列） */
  private async cloneFromCache(batchId: string, source: AiSuggestionBatch): Promise<any[]> {
    const src = await this.suggRepo.find({ batch_id: source.batch_id } as any);
    await this.batchRepo.transaction(async (mgr) => {
      for (const s of src) {
        const row: any = mgr.create(AiSuggestion, {
          suggestion_id: randomUUID(), batch_id: batchId,
          tenant_id: s.tenant_id, station_id: s.station_id, version: s.version,
          element_ids: s.element_ids, waste_type: s.waste_type, method: s.method,
          action_class: s.action_class, measure: s.measure, eliminate_basis: s.eliminate_basis,
          est_save_s: Number(s.est_save_s), priority: s.priority, tier: s.tier,
          difficulty: s.difficulty, verif: s.verif, risk_flags: s.risk_flags,
          status: '待审', validation_trace: s.validation_trace, raw_json: s.raw_json,
        } as any);
        await mgr.save(row);
      }
      await mgr.update(AiSuggestionBatch, { batch_id: batchId } as any, {
        status: 'done', suggestion_count: src.length, completed_at: new Date(),
        cache_from: source.batch_id, tokens_used: 0,
      } as any);
    });
    return this.listByBatch(batchId);
  }

  private async listByBatch(batchId: string): Promise<any[]> {
    const rows = await this.suggRepo.find({ batch_id: batchId } as any, { order: { priority: 'DESC' } });
    return rows.map((r) => this.suggestionVo(r));
  }

  private suggestionVo(r: AiSuggestion): any {
    const flags = (r.risk_flags ?? '').split('|').filter(Boolean);
    return {
      suggestion_id: r.suggestion_id, batch_id: r.batch_id,
      station_id: r.station_id, version: r.version,
      element_ids: (r.element_ids ?? '').split(',').filter(Boolean),
      waste_type: r.waste_type, method: r.method, action_class: r.action_class,
      measure: r.measure, eliminate_basis: r.eliminate_basis,
      est_save_s: Number(r.est_save_s), priority: r.priority, tier: r.tier,
      difficulty: r.difficulty, verif: r.verif,
      risk_flags: flags,
      status: r.status,
      validation_trace: r.validation_trace ? JSON.parse(r.validation_trace) : null,
      reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at,
      created_at: r.created_at,
    };
  }

  // ───────────────────────── 列表 ─────────────────────────

  /** 建议列表（含 validation_trace、批次状态与生成时间）。
   *  v3.46：source 可选——缺省不过滤（legacy 全量：存量批次全是 mixed，语义等价）；
   *  传了按来源线过滤批次，且建议按批次 id 集合查（防多线建议混显）。 */
  async list(stationId: string, version?: number, userId?: string, source?: SuggestSource) {
    await this.assertEnabled();
    const station = await this.stationRepo.findOne({ station_id: stationId });
    if (!station) throw new NotFoundException(`工位 ${stationId} 不存在`);
    const where: Record<string, unknown> = { station_id: stationId };
    if (version) where.version = version;
    if (source) where.element_source = source;
    const batches = await this.batchRepo.find(where as any, { order: { created_at: 'DESC' } });
    if (batches.length === 0) return { station_id: stationId, version: station.version, batches: [], suggestions: [] };
    // v3.46：带 source 时按当前线批次 id 集合查建议（不同线建议分开）；缺省保持 legacy 全量查法
    let sugRows: AiSuggestion[];
    if (source) {
      const ids = batches.map((b) => b.batch_id);
      sugRows = ids.length > 0
        ? await this.ds.getRepository(AiSuggestion).createQueryBuilder('s').where('s.batch_id IN (:...ids)', { ids }).orderBy('s.priority', 'DESC').getMany()
        : [];
    } else {
      sugRows = await this.suggRepo.find(
        { station_id: stationId, ...(version ? { version } : {}) } as any,
        { order: { priority: 'DESC' } },
      );
    }
    return {
      station_id: stationId, version: version ?? station.version,
      batches: batches.map((b) => ({
        batch_id: b.batch_id, status: b.status, version: b.version, user_id: b.user_id,
        element_source: b.element_source,
        attempt: b.attempt, suggestion_count: b.suggestion_count, tokens_used: b.tokens_used,
        model: b.model, prompt_version: b.prompt_version, cache_from: b.cache_from,
        error: b.error, created_at: b.created_at, completed_at: b.completed_at,
      })),
      suggestions: sugRows.map((r) => this.suggestionVo(r)),
    };
  }

  // ───────────────────────── 采纳 / 否决 ─────────────────────────

  /**
   * 采纳（POST /ai-suggestions/:id/adopt）：
   * 红线未确认 422 REDLINE_CONFIRM_REQUIRED（语义与现引擎一致）；
   * measure+红线标记≤250 超出拒绝（P1-2）；element_ids 写入长度超限拒绝提示拆分（P1-3）；
   * 事务：写 t_improvement{source:'ai',ai_suggestion_id,status:'待实施'} + 回写 t_ai_suggestion。
   */
  async adopt(suggestionId: string, operator: string, confirmations?: { quality?: any; ergonomics?: any }) {
    await this.assertEnabled();
    const s = await this.suggRepo.findOne({ suggestion_id: suggestionId } as any);
    if (!s) throw new NotFoundException(`AI 建议 ${suggestionId} 不存在`);
    if (s.status !== '待审') throw new ConflictException(`建议状态为「${s.status}」，只有待审建议可采纳`);

    const station = await this.stationRepo.findOne({ station_id: s.station_id });
    if (!station) throw new NotFoundException(`工位 ${s.station_id} 不存在`);

    // 红线检测（redline_keywords 口径与现引擎 checkRedlines 一致：语义复刻、零修改现有文件）
    const redline = this.rules.getActive('redline_keywords').json;
    const measureStr = String(s.measure ?? '');
    const qualityHit = (s.risk_flags ?? '').includes('needs_quality_redline')
      || (s.waste_type === '检验冗余' && (redline?.quality?.keywords ?? []).some((k: string) => measureStr.includes(k)));
    const ergoHit = (redline?.ergonomics?.keywords ?? []).some((k: string) => measureStr.includes(k));
    const requires: { type: string; message: string }[] = [];
    if (qualityHit && !confirmations?.quality) {
      requires.push({ type: 'quality', message: '本条措施取消/弱化检验或含条件词，须品质确认（填写确认人+日期）' });
    }
    if (ergoHit && !confirmations?.ergonomics) {
      requires.push({ type: 'ergonomics', message: '本条措施涉及弯腰/扭转/高举等人因风险，须人因复核' });
    }
    if (requires.length > 0) {
      throw new UnprocessableEntityException({ message: '红线确认未完成，暂不能采纳', code: 'REDLINE_CONFIRM_REQUIRED', requires });
    }

    // 红线确认标记追加（留痕口径与现引擎一致）
    const markers: string[] = [];
    if (confirmations?.quality) markers.push(`[品质确认:${confirmations.quality.name || 'IE'} ${confirmations.quality.date || new Date().toISOString().slice(0, 10)}]`);
    if (confirmations?.ergonomics) markers.push(`[人因复核:${confirmations.ergonomics.name || 'IE'} ${confirmations.ergonomics.date || new Date().toISOString().slice(0, 10)}]`);
    const finalMeasure = `${measureStr}${markers.length > 0 ? ` ${markers.join(' ')}` : ''}`;
    // P1-2：measure+红线标记 ≤250（写入 t_improvement.measure NVARCHAR(256) 留安全边界）
    if (finalMeasure.length > 250) {
      throw new BadRequestException({ message: `措施文案+确认标记共 ${finalMeasure.length} 字，超出 250 上限`, code: 'MEASURE_TOO_LONG', hint: '请缩短措施文案后重试' });
    }
    // P1-3：element_ids 写入长度（t_improvement.element_ids NVARCHAR(256)）超限拒绝提示拆分
    const elementIdsStr = s.element_ids ?? '';
    if (elementIdsStr.length > 256) {
      throw new BadRequestException({ message: `涉及要素 ${s.element_ids.split(',').length} 个超出单条建议写入上限（element_ids>256 字符）`, code: 'ELEMENT_IDS_TOO_LONG', hint: '请将该建议在 AI 列表中拆分为多条后采纳' });
    }

    const params = this.lineParams(station.line_id);
    const annual = estimateAnnualYuan(Number(s.est_save_s), params);
    const impId = `IMP-${s.station_id}-${Date.now()}-AI`;
    const beforeCt = Number(station.ct ?? 0);

    await this.suggRepo.transaction(async (mgr) => {
      const imp: any = mgr.create(Improvement, {
        imp_id: impId, tenant_id: s.tenant_id, station_id: s.station_id,
        element_ids: elementIdsStr, waste_type: s.waste_type, method: s.method,
        measure: finalMeasure, est_save_s: Number(s.est_save_s), priority: s.priority,
        status: '待实施', before_ct: beforeCt, after_ct: null,
        source: 'ai', ai_suggestion_id: s.suggestion_id,
      } as any);
      await mgr.save(imp);
      await mgr.update(AiSuggestion, { suggestion_id: s.suggestion_id } as any, {
        status: '已采纳', reviewed_by: operator, reviewed_at: new Date(),
      } as any);
    });

    return {
      imp_id: impId, suggestion_id: s.suggestion_id, station_id: s.station_id,
      annual_yuan: annual,
      note: params.dailyOutput === null ? '日产量/费率未配置：无年化金额（配置后重算）' : null,
    };
  }

  /**
   * v3.55 建议所属工位反查（供控制器做资源级写守卫）。
   * adopt / reject 的路径参数是 suggestion_id，不是 station_id——
   * 此前这两个端点只受 RBAC「suggestion:generate」保护 →
   * 同租户任意用户可采纳（写入 t_improvement）或否决他人工位的 AI 建议。
   */
  async stationIdOfSuggestion(suggestionId: string): Promise<string> {
    const s = await this.suggRepo.findOne({ suggestion_id: suggestionId } as any);
    if (!s) throw new NotFoundException(`AI 建议 ${suggestionId} 不存在`);
    return s.station_id;
  }

  /** 否决：status='已否决'+reviewed_by/at */
  async reject(suggestionId: string, operator: string, reason?: string) {
    await this.assertEnabled();
    const s = await this.suggRepo.findOne({ suggestion_id: suggestionId } as any);
    if (!s) throw new NotFoundException(`AI 建议 ${suggestionId} 不存在`);
    if (s.status !== '待审') throw new ConflictException(`建议状态为「${s.status}」，只有待审建议可否决`);
    await this.suggRepo.update({ suggestion_id: s.suggestion_id } as any, {
      status: '已否决', reviewed_by: operator, reviewed_at: new Date(),
      ...(reason ? { raw_json: (s.raw_json ?? '').slice(0, 10000) } : {}),
    } as any);
    const updated = await this.suggRepo.findOne({ suggestion_id: s.suggestion_id } as any);
    return this.suggestionVo(updated!);
  }

  // ───────────────────────── 自定义字典 ─────────────────────────

  /** 内置 8 名（waste_triggers∪ecrsa_map wastes）：撞名拒绝（除非 alias_of） */
  private builtinWastes(): Set<string> {
    const set = new Set<string>();
    for (const t of this.rules.getActive('waste_triggers').json?.triggers ?? []) set.add(t.waste);
    for (const m of this.rules.getActive('ecrsa_map').json?.mappings ?? []) set.add(m.waste);
    return set;
  }

  async dictList() {
    const rows = await this.dictRepo.find({}, { order: { created_at: 'DESC' } });
    return { items: rows };
  }

  async dictCreate(body: any, operator: string, tenantId: string) {
    await this.assertEnabled();
    const { dict_type, code, name } = body;
    // code 格式（服务层校验兜底——不依赖全局 pipe 也在位；规格书 §4）
    if (!/^[a-z][a-z0-9_]{2,31}$/.test(String(code ?? ''))) {
      throw new BadRequestException('code 须为小写字母开头的 3~32 位 [a-z0-9_]');
    }
    // waste_type 必填 va_class；measure_type 必填 method_hint+action_class（规格书 §4）
    if (dict_type === 'waste_type' && !body.va_class) {
      throw new BadRequestException('自定义浪费类型必须声明 va_class（VA/RNVA/NVA）');
    }
    if (dict_type === 'measure_type' && (!body.method_hint || !body.action_class)) {
      throw new BadRequestException('自定义措施类型必须声明 method_hint 与 action_class');
    }
    // 撞内置 8 名拒绝（除非走 alias_of 别名）
    if (dict_type === 'waste_type' && this.builtinWastes().has(name) && body.alias_of !== name) {
      throw new ConflictException(`「${name}」与内置浪费类型撞名；如需别名请传 alias_of`);
    }
    // 同租户同 dict_type 同 code → UQ 拒绝
    const dup = await this.dictRepo.findOne({ dict_type, code } as any);
    if (dup) throw new ConflictException(`code「${code}」已存在（dict_type=${dict_type}）`);
    const nameDup = await this.dictRepo.findOne({ dict_type, name } as any);
    if (nameDup) throw new ConflictException(`名称「${name}」已存在（dict_type=${dict_type}）`);
    const row = await this.dictRepo.create({
      dict_id: randomUUID(), dict_type, code, name,
      va_class: body.va_class ?? null, method_hint: body.method_hint ?? null,
      action_class: body.action_class ?? null, alias_of: body.alias_of ?? null,
      status: 'active', created_by: operator, tenant_id: tenantId,
    } as any);
    return row;
  }

  async dictUpdate(id: string, body: any) {
    await this.assertEnabled();
    const row = await this.dictRepo.findOne({ dict_id: id } as any);
    if (!row) throw new NotFoundException(`字典项 ${id} 不存在`);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (row.dict_type === 'waste_type' && this.builtinWastes().has(body.name) && row.alias_of !== body.name) {
        throw new ConflictException(`「${body.name}」与内置浪费类型撞名`);
      }
      patch.name = body.name;
    }
    for (const k of ['va_class', 'method_hint', 'action_class', 'status']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    await this.dictRepo.update({ dict_id: id } as any, patch as any);
    return this.dictRepo.findOne({ dict_id: id } as any);
  }

  async dictRemove(id: string) {
    await this.assertEnabled();
    const row = await this.dictRepo.findOne({ dict_id: id } as any);
    if (!row) throw new NotFoundException(`字典项 ${id} 不存在`);
    await this.dictRepo.remove({ dict_id: id } as any);
    return { deleted: row.dict_id };
  }

  // ───────────────────────── 配额管理 ─────────────────────────

  async quotaGet(userId: string) {
    const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
    if (!user) throw new NotFoundException(`用户 ${userId} 不存在`);
    return this.quotaVo(user);
  }

  async quotaSet(userId: string, aiQuota: number, operator: string) {
    // 合法值：-1（无限）/ 0（禁用）/ ≥1 正整数（服务层兜底，不依赖全局 pipe）
    if (!Number.isInteger(aiQuota) || aiQuota < -1) {
      throw new BadRequestException('ai_quota 仅接受 -1（无限）/ 0（禁用）/ ≥1 的整数');
    }
    const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
    if (!user) throw new NotFoundException(`用户 ${userId} 不存在`);
    await this.ds.getRepository('t_user').update({ user_id: userId } as any, { ai_quota: aiQuota } as any);
    const fresh = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
    return { ...this.quotaVo(fresh ?? user), updated_by: operator };
  }

  private quotaVo(user: any) {
    const quota = Number(user.ai_quota ?? 1);
    return {
      user_id: user.user_id, username: user.username, display_name: user.display_name,
      ai_quota: quota, ai_quota_used: Number(user.ai_quota_used ?? 0),
      unlimited: quota === -1, disabled: quota === 0,
    };
  }

  /** user:write 权限检查（is_unlimited 判定）。权限在 JWT 内，由控制器在请求时注入角色缓存 */
  private userHasPermission(userId: string, perm: string): boolean {
    const roles = this.roleCache.get(userId);
    if (roles?.includes('sys_admin')) return true;
    if (perm !== 'user:write') return false;
    // 非超管：user:write 由请求上下文注入（控制器 setUserPermissionFlags）
    return this.userWriteCache.has(userId);
  }

  private roleCache = new Map<string, string[]>();
  private userWriteCache = new Set<string>();

  /** 由控制器注入（每次请求刷新），保证 is_unlimited 判定实时 */
  setUserFlags(userId: string, roles: string[], permissions: Set<string>) {
    this.roleCache.set(userId, roles);
    if (permissions.has('user:write')) this.userWriteCache.add(userId);
    else this.userWriteCache.delete(userId);
  }
}
