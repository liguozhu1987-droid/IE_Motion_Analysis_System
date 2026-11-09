import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG } from '../core/config/configuration';
import { AppConfig } from '../core/config/configuration';
import { Inject } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service';

export interface LlmMessage { role: 'system' | 'user'; content: string; }

export interface LlmEndpointOverride {
  baseUrl: string; apiKey: string; model: string;
}

export interface LlmUsageContext {
  feature: 'waste_analysis' | 'improvement_suggestion';
  tenantId: string;
  userId: string;
  stationId: string;
  lineId: string;
  batchId: string;
  /** 业务层 JSON 解析重试序号，从 1 开始 */
  attemptNo?: number;
}

export interface LlmChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** 端点覆盖（ai-suggest 模块用 AI_LLM_* 独立端点；缺省用全局 AI_* 配置） */
  endpoint?: LlmEndpointOverride;
  /** 绕过全局 AI_ENABLED 开关（ai-suggest 有独立开关 AI_SUGGEST_ENABLED） */
  ignoreGlobalSwitch?: boolean;
  /**
   * 推理模型适配（v3.36）：火山方舟等推理模型先在 reasoning_content 思维链、再在 content 出答案；
   * max_tokens 被推理耗尽时 content 恒空（finish_reason=length）。true 时请求带 thinking:{type:'disabled'}
   * 关闭思维链（不支持的网关报 400 → 自动去掉该参数重试一次）。
   */
  disableThinking?: boolean;
  /** 仅正式业务生成传入；连接测试、自测及其他调用缺省不写正式用量。 */
  usage?: LlmUsageContext;
}

interface TokenUsage {
  prompt: number | null;
  completion: number | null;
  total: number | null;
  cached: number | null;
}

function tokenNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function readUsage(raw: any): TokenUsage {
  const prompt = tokenNumber(raw?.prompt_tokens);
  const completion = tokenNumber(raw?.completion_tokens);
  return {
    prompt,
    completion,
    total: tokenNumber(raw?.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null),
    cached: tokenNumber(raw?.prompt_tokens_details?.cached_tokens),
  };
}

/**
 * LLM 网关：OpenAI 兼容协议（内网 vLLM/Ollama / Azure OpenAI / 公网 API 可配置切换）。
 * 硬性约束：AI_ENABLED=false 时全功能可用，本服务直接拒绝（调用方降级为模板）。
 */
@Injectable()
export class LlmGatewayService {
  private readonly log = new Logger('LlmGateway');
  private failStreak = 0;
  private circuitOpenUntil = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly usage: AiUsageService,
  ) {}

  async chat(messages: LlmMessage[], opts: LlmChatOptions = {}): Promise<{ text: string; tokensUsed: number }> {
    if (!this.cfg.aiEnabled && !opts.ignoreGlobalSwitch) {
      throw new ServiceUnavailableException('AI 未启用（AI_ENABLED=false），已降级为本地模板');
    }
    if (Date.now() < this.circuitOpenUntil) {
      throw new ServiceUnavailableException('AI 熔断中（连续失败），稍后自动恢复');
    }
    const baseUrl = opts.endpoint?.baseUrl ?? this.cfg.aiBaseUrl;
    const apiKey = opts.endpoint?.apiKey ?? this.cfg.aiKey;
    const model = opts.endpoint?.model ?? this.cfg.aiModel;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.aiTimeoutMs);
    // v3.36：推理模型思维链开关——disableThinking 时带 thinking 参数；网关不识别该参数会 400，回落重试不带
    const buildBody = (withThinking: boolean) => {
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
      };
      if (withThinking && opts.disableThinking) body.thinking = { type: 'disabled' };
      return JSON.stringify(body);
    };
    const doFetch = (payload: string) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: payload,
      signal: ctrl.signal,
    });

    /** 每个真实 HTTP 请求独立留痕；写用量失败只记服务日志，不阻断已取得的模型结果。 */
    const execute = async (payload: string, internalRetry: number) => {
      const started = Date.now();
      let res: Response;
      try {
        res = await doFetch(payload);
      } catch (e: any) {
        await this.usage.recordSafe(opts.usage, {
          provider: 'openai_compatible', model, internalRetry,
          status: 'error', httpStatus: null, latencyMs: Date.now() - started,
          errorCode: e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', usage: null,
        });
        throw e;
      }
      const requestId = res.headers.get('x-request-id');
      if (!res.ok) {
        await this.usage.recordSafe(opts.usage, {
          provider: 'openai_compatible', model, internalRetry, requestId,
          status: 'error', httpStatus: res.status, latencyMs: Date.now() - started,
          errorCode: `HTTP_${res.status}`, usage: null,
        });
        return { res, data: null as any, usage: null as TokenUsage | null };
      }
      try {
        const data = await res.json() as any;
        const tokenUsage = readUsage(data?.usage);
        await this.usage.recordSafe(opts.usage, {
          provider: 'openai_compatible', model, internalRetry,
          requestId: requestId ?? (typeof data?.id === 'string' ? data.id : null),
          status: 'success', httpStatus: res.status, latencyMs: Date.now() - started,
          usage: tokenUsage,
        });
        return { res, data, usage: tokenUsage };
      } catch (e) {
        await this.usage.recordSafe(opts.usage, {
          provider: 'openai_compatible', model, internalRetry, requestId,
          status: 'error', httpStatus: res.status, latencyMs: Date.now() - started,
          errorCode: 'INVALID_JSON', usage: null,
        });
        throw e;
      }
    };

    try {
      let result = await execute(buildBody(true), 0);
      // thinking 参数不被识别（常见 400 invalid parameter）→ 去掉重试一次；两次都是真实调用，分别统计
      if (!result.res.ok && result.res.status === 400 && opts.disableThinking) {
        result = await execute(buildBody(false), 1);
      }
      if (!result.res.ok) throw new Error(`LLM HTTP ${result.res.status}`);
      const data = result.data;
      const text = data?.choices?.[0]?.message?.content ?? '';
      // 用量已按 HTTP 成功记录；后续输出为空、JSON 解析或业务校验失败不会抹掉已消耗 Token。
      if (!text && data?.choices?.[0]?.finish_reason === 'length') {
        throw new Error('LLM 输出为空（finish=length）：max_tokens 被推理思维链耗尽，建议换非推理模型或加大 token 预算');
      }
      this.failStreak = 0;
      return { text, tokensUsed: result.usage?.total ?? 0 };
    } catch (e) {
      this.failStreak++;
      if (this.failStreak >= 5) {
        this.circuitOpenUntil = Date.now() + 10 * 60_000;
        this.log.warn('LLM 连续失败 5 次，熔断 10 分钟');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  get circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }
}
