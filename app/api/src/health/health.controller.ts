import { Controller, ForbiddenException, Get, Header, Headers, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../rbac/public.decorator';
import { RulesService } from '../core/rules/rules.service';
import { AiTaskService } from '../ai/ai-task.service';
import { APP_CONFIG, AppConfig } from '../core/config/configuration';

/** 健康检查：/health（进程活） /ready（DB+规则就绪，IIS ARR 探活） */
@Controller()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rules: RulesService,
    private readonly ai: AiTaskService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready() {
    let db = 'down';
    try {
      await this.ds.query('SELECT 1');
      db = 'up';
    } catch { /* down */ }
    let rules = 'down';
    try {
      this.rules.snapshot();
      rules = 'up';
    } catch { /* down */ }
    return {
      status: db === 'up' && rules === 'up' ? 'ready' : 'degraded',
      db, rules,
      ai: this.ai.status(),
    };
  }

  /**
   * 指标（prom-client 文本格式，Prometheus/Windows 计数器可抓取）。
   *
   * 为什么保留 @Public() 又自己校验：Prometheus 抓取端不会带 JWT，走全局守卫必然 401；
   * 但指标里含进程内存/事件循环延迟/全量路由 QPS——属于"给了就能画拓扑"的基础设施信息，
   * 不能裸奔。折中方案是抓取令牌（Prometheus 的 authorization 或自定义头都能配）。
   *
   * 拒绝时必须 403 而不是 200+空内容：探针与巡检脚本按"200 且有指标正文"判定泄露，
   * 返回 200 会让真实泄露与"已收权"看起来一样。
   */
  @Public()
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('cache-control', 'no-store')
  async metrics(
    @Headers('authorization') authorization?: string,
    @Headers('x-metrics-token') metricsToken?: string,
  ) {
    this.assertMetricsAllowed(authorization, metricsToken);
    const { register } = await import('prom-client');
    return register.metrics();
  }

  /** 令牌校验：Authorization: Bearer <t> 或 x-metrics-token: <t> 任一命中即放行 */
  private assertMetricsAllowed(authorization?: string, metricsToken?: string): void {
    const expected = (this.cfg.metricsToken ?? '').trim();
    if (!expected) {
      // 未配置令牌：生产 fail closed（宁可抓不到指标，也不能把基础设施信息暴露出去）；
      // 非生产放行以保留本地调试便利——main.ts 启动日志已就此 warn 过一句
      if (this.cfg.nodeEnv === 'production') {
        throw new ForbiddenException('指标端点未启用（未配置 METRICS_TOKEN）');
      }
      return;
    }
    const bearer = /^Bearer\s+(.+)$/i.exec((authorization ?? '').trim());
    const candidates = [bearer?.[1]?.trim() ?? '', (metricsToken ?? '').trim()];
    if (candidates.some((candidate) => safeTokenEquals(candidate, expected))) return;
    throw new ForbiddenException('指标抓取令牌无效');
  }
}

/**
 * 定长比较：先比长度（不等直接拒，timingSafeEqual 对不等长会抛），
 * 再走 timingSafeEqual，避免按字节提前返回形成时序侧信道。
 * 长度本身会泄露——但令牌长度不是秘密，可接受。
 */
function safeTokenEquals(provided: string, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
