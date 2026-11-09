import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { AiWasteBatch } from './ai-waste-batch.entity';

/**
 * P3-9 改善问题清单条目（审前态；铁律① AI 产出永远「待处理」，确认才进 t_improvement）。
 * est_save_s/priority/tier 全服务端计算（铁律②）。
 * status：待处理|已确认|已忽略；imp_id 回写 t_improvement 主键溯源。
 */
@Entity({ name: 't_ai_waste_issue' })
export class AiWasteIssue {
  @PrimaryColumn({ length: 36 }) issue_id: string;
  @ManyToOne(() => AiWasteBatch) @JoinColumn({ name: 'batch_id' }) batch: AiWasteBatch;
  /** v3.51：人工录入条目不隶属批次（NULL）；AI 条目必属批次 */
  @Column({ length: 36, nullable: true }) batch_id: string | null;
  /** 来源浪费点（可空：部分问题由 LLM 直接产出无对应 finding） */
  @Column({ length: 36, nullable: true }) finding_id: string | null;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 32 }) station_id: string;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'text' }) element_refs: string;
  @Column({ length: 16 }) waste_type: string;
  @Column({ length: 256 }) problem: string;
  @Column({ length: 4 }) ecrs: string; // E|C|R|S
  @Column({ length: 256 }) suggestion: string;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) est_save_s: number;
  @Column({ type: 'int' }) priority: number;
  @Column({ length: 4 }) tier: string; // P1|P2|P3
  @Column({ length: 16, default: '待处理' }) status: string;
  /** 校验处置轨迹 JSON（独立校验引擎 W1-W3） */
  @Column({ type: 'text', nullable: true }) validation_trace: string | null;
  @Column({ length: 64, nullable: true }) imp_id: string | null;
  @Column({ length: 32, nullable: true }) reviewed_by: string | null;
  @Column({ type: 'datetime', nullable: true }) reviewed_at: Date | null;
  /** v3.51：来源——ai=LLM 识别产出（默认，存量行不变）/ manual=人工录入 */
  @Column({ length: 16, default: 'ai' }) origin: string;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @Column({ type: 'datetime', nullable: true }) updated_at: Date | null;
  @CreateDateColumn() created_at: Date;
}
