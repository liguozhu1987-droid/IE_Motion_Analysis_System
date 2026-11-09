import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * 正式 AI 业务的逐次 HTTP 调用事实表。
 * 一批次可对应多次调用（解析重试/参数重试）；缓存与幂等命中不写本表。
 * Token 可空表示上游未报告，绝不能把未知用量写成 0。 Prompt、响应和 API Key 不落库。
 */
@Entity({ name: 't_ai_usage_event' })
export class AiUsageEvent {
  @PrimaryColumn({ length: 36 }) usage_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @Column({ length: 32 }) feature: string;
  @Column({ length: 16, default: 'business' }) purpose: string;
  @Column({ length: 36 }) batch_id: string;
  @Column({ length: 32 }) user_id: string;
  @Column({ length: 32 }) station_id: string;
  @Column({ length: 32 }) line_id: string;
  @Column({ length: 32 }) provider: string;
  @Column({ length: 128 }) model: string;
  @Column({ type: 'int', default: 1 }) attempt_no: number;
  @Column({ type: 'int', default: 0 }) internal_retry: number;
  @Column({ length: 128, nullable: true }) request_id: string | null;
  @Column({ length: 16 }) status: string;
  @Column({ type: 'int', nullable: true }) http_status: number | null;
  @Column({ type: 'int' }) latency_ms: number;
  @Column({ length: 64, nullable: true }) error_code: string | null;
  @Column({ type: 'int', nullable: true }) prompt_tokens: number | null;
  @Column({ type: 'int', nullable: true }) completion_tokens: number | null;
  @Column({ type: 'int', nullable: true }) total_tokens: number | null;
  @Column({ type: 'int', nullable: true }) cached_tokens: number | null;
  @Column({ length: 16 }) usage_status: string;
  @CreateDateColumn() created_at: Date;
}
