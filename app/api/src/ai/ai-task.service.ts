import { Injectable, Logger, OnModuleInit, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { LlmGatewayService } from './llm-gateway.service';
import { sanitizePolishOutput, POLISH_SYSTEM_PROMPT, buildPolishUserPrompt } from './output-sanitizer';
import { APP_CONFIG } from '../core/config/configuration';
import { AppConfig } from '../core/config/configuration';
import { Inject } from '@nestjs/common';

export interface AiTaskView {
  task_id: string; type: string; status: string;
  output_json: string | null; error: string | null; tokens_used: number; created_at: Date;
}

/**
 * AI 任务服务：写 t_ai_task（pending）+ worker 轮询执行。
 * 队列后端=SQL Server 表（无 Redis，Windows Server 友好）。
 * 月度 token 熔断：当月累计超限 → 新任务直接 failed(quota_exceeded)。
 */
@Injectable()
export class AiTaskService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AiTask');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly llm: LlmGatewayService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.drain(); }, 5000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 提交任务（立即返回 task_id；AI 关闭时返回 503 由调用方降级为本地模板） */
  async submit(type: string, input: Record<string, unknown>, operator: string): Promise<AiTaskView> {
    if (!this.cfg.aiEnabled) {
      throw new ServiceUnavailableException('AI 未启用（AI_ENABLED=false），已降级为本地模板文案');
    }
    const repo = this.ds.getRepository('t_ai_task');
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTokens = ((await repo.createQueryBuilder('t')
      .select('COALESCE(SUM(t.tokens_used), 0)', 's')
      .where('t.created_at >= :m', { m: monthStart })
      .getRawOne()) as any)?.s ?? 0;
    const row: any = repo.create({
      task_id: randomUUID(),
      tenant_id: 'DEFAULT', // 由 TenantInterceptor/调用方覆盖（本服务在租户上下文外调用时兜底）
      type,
      status: 'pending',
      input_json: JSON.stringify(input),
      tokens_used: 0,
      retry_count: 0,
      created_by: operator,
    } as any);
    if (monthTokens >= this.cfg.aiMonthlyTokenLimit) {
      row.status = 'failed';
      row.error = 'quota_exceeded: 本月 AI token 额度已用完';
    }
    await repo.save(row);
    if (row.status === 'failed') throw new ServiceUnavailableException(row.error!);
    return this.view(row);
  }

  async get(taskId: string): Promise<AiTaskView | null> {
    const row = await this.ds.getRepository('t_ai_task').findOne({ where: { task_id: taskId } } as any) as any;
    return row ? this.view(row) : null;
  }

  async listByTenant(tenantId: string, take = 50): Promise<AiTaskView[]> {
    const rows = await this.ds.getRepository('t_ai_task').find({
      where: { tenant_id: tenantId }, order: { created_at: 'DESC' }, take,
    } as any) as any[];
    return rows.map((r) => this.view(r));
  }

  /** worker：串行领取 pending 任务执行 */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const repo = this.ds.getRepository('t_ai_task');
      const tasks = await repo.find({ where: { status: 'pending' }, order: { created_at: 'ASC' }, take: 3 } as any) as any[];
      for (const t of tasks) {
        await repo.update({ task_id: t.task_id } as any, { status: 'running' });
        try {
          if (t.type === 'suggestion_polish') {
            const card = JSON.parse(t.input_json ?? '{}');
            const r = await this.llm.chat([
              { role: 'system', content: POLISH_SYSTEM_PROMPT },
              { role: 'user', content: buildPolishUserPrompt(card) },
            ]);
            const s = sanitizePolishOutput(r.text, card.measure ?? '', 200);
            await repo.update({ task_id: t.task_id } as any, {
              status: 'done',
              output_json: JSON.stringify({ measure: s.text, sanitized: !s.ok, reason: s.reason ?? null }),
              tokens_used: r.tokensUsed,
            });
          } else {
            await repo.update({ task_id: t.task_id } as any, { status: 'failed', error: `未知任务类型 ${t.type}` });
          }
        } catch (e) {
          const retries = (t.retry_count ?? 0) + 1;
          await repo.update({ task_id: t.task_id } as any, {
            status: retries >= 2 ? 'failed' : 'pending',
            retry_count: retries,
            error: (e as Error).message,
          });
          this.log.warn(`任务 ${t.task_id} 失败（第 ${retries} 次）：${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 开关/熔断状态（前端角标） */
  status(): { enabled: boolean; circuitOpen: boolean } {
    return { enabled: this.cfg.aiEnabled, circuitOpen: this.llm.circuitOpen };
  }

  private view(r: any): AiTaskView {
    return {
      task_id: r.task_id, type: r.type, status: r.status,
      output_json: r.output_json, error: r.error, tokens_used: r.tokens_used, created_at: r.created_at,
    };
  }
}
