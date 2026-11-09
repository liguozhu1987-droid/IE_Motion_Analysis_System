import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** AI 任务队列（SQL Server-backed，无 Redis）。状态：pending|running|done|failed */
@Entity({ name: 't_ai_task' })
export class AiTask {
  @PrimaryColumn({ length: 36 }) task_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @Column({ length: 32 }) type: string; // suggestion_polish|analysis_summary
  @Column({ length: 16, default: 'pending' }) status: string;
  @Column({ type: 'text', nullable: true }) input_json: string | null;
  @Column({ type: 'text', nullable: true }) output_json: string | null;
  @Column({ type: 'int', default: 0 }) tokens_used: number;
  @Column({ length: 256, nullable: true }) error: string | null;
  @Column({ type: 'int', default: 0 }) retry_count: number;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
