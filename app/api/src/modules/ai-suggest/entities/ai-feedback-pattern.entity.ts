import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * AI 否决反馈模式聚合（v3.66 P3）。
 * 每次用户否决 AI 建议时提取 reject_reason 关键词 → 按 tenant + type + key 去重累加。
 * 生成建议时查询 TOP-N 高权重模式注入 prompt 负样本段，减少同类低质建议。
 * pattern_type：waste_type | measure_type | station_type
 */
@Entity({ name: 't_ai_feedback_pattern' })
export class AiFeedbackPattern {
  @PrimaryColumn({ length: 36 }) pattern_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 16 }) pattern_type: string;
  @Column({ length: 256 }) pattern_key: string;
  @Column({ type: 'int', default: 1 }) reject_count: number;
  @Column({ type: 'datetime', nullable: true }) last_reject_at: Date;
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1.0 }) weight: number;
  @CreateDateColumn() created_at: Date;
}