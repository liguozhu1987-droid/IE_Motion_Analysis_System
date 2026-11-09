import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { AiSuggestionBatch } from './ai-suggestion-batch.entity';

/**
 * AI 建议（审前态；铁律①：永远待审，采纳才进 t_improvement）。
 * est_save_s/priority/tier 全部服务端计算（铁律②：LLM 禁产数字）。
 * status：待审|已采纳|已否决；verif 可验证性 1/2/3（同 priority 次级排序键）。
 * risk_flags：needs_quality_redline|exceeds_batch_ceiling|manual_review（正交加签，不剔除）。
 */
@Entity({ name: 't_ai_suggestion' })
export class AiSuggestion {
  @PrimaryColumn({ length: 36 }) suggestion_id: string;
  @ManyToOne(() => AiSuggestionBatch) @JoinColumn({ name: 'batch_id' }) batch: AiSuggestionBatch;
  @Column({ length: 36 }) batch_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 32 }) station_id: string;
  @Column({ type: 'int' }) version: number;
  /** 逗号分隔 element_id（P1-3：MAX 防站级触发器击穿） */
  @Column({ type: 'text' }) element_ids: string;
  /** 中文名直存（裁决 6；动态白名单） */
  @Column({ length: 16 }) waste_type: string;
  @Column({ length: 4 }) method: string; // E|C|R|S
  /** 词典解析：取消|合并|压缩|重排|自动化|简化（R2.5 矛盾检测用） */
  @Column({ length: 8 }) action_class: string;
  @Column({ length: 256 }) measure: string;
  /** E 类必填（裁决 3：消除的产生条件，≥8 字） */
  @Column({ length: 256, nullable: true }) eliminate_basis: string | null;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) est_save_s: number;
  /** 归一化 0~100 */
  @Column({ type: 'int' }) priority: number;
  @Column({ length: 4 }) tier: string; // P1|P2|P3
  @Column({ type: 'int' }) difficulty: number;
  /** 可验证性 1/2/3（缺省 2 不奖不罚） */
  @Column({ type: 'int', default: 2 }) verif: number;
  @Column({ length: 128, nullable: true }) risk_flags: string | null;
  @Column({ length: 16, default: '待审' }) status: string;
  /** 三轮校验处置轨迹 JSON */
  @Column({ type: 'text', nullable: true }) validation_trace: string | null;
  /** LLM 原文（数字已剥除） */
  @Column({ type: 'text', nullable: true }) raw_json: string | null;
  @Column({ length: 32, nullable: true }) reviewed_by: string | null;
  @Column({ type: 'datetime', nullable: true }) reviewed_at: Date | null;
  @CreateDateColumn() created_at: Date;
}
