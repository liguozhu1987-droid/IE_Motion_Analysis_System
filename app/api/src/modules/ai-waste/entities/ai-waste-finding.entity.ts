import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { AiWasteBatch } from './ai-waste-batch.entity';

/**
 * P3-9 浪费点（LLM 识别产出；severity/involved_s/pct_of_ct 全服务端计算——
 * 铁律② LLM 禁产数字在本模块同样生效，LLM 输出中的数字字段一律剥除）。
 * waste_type 动态白名单（waste_triggers ∪ ecrsa_map wastes；独立校验实现，不 import ai-suggest）。
 * element_refs 存要素 seq 逗号串：AI 要素随 submit 整版重排，seq 在同版本内稳定可对齐。
 */
@Entity({ name: 't_ai_waste_finding' })
export class AiWasteFinding {
  @PrimaryColumn({ length: 36 }) finding_id: string;
  @ManyToOne(() => AiWasteBatch) @JoinColumn({ name: 'batch_id' }) batch: AiWasteBatch;
  /** v3.51：人工录入条目不隶属批次（NULL）；AI 条目必属批次 */
  @Column({ length: 36, nullable: true }) batch_id: string | null;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 32 }) station_id: string;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'text' }) element_refs: string;
  @Column({ length: 16 }) waste_type: string;
  /** 1=轻微 2=一般 3=严重（服务端按 pct_of_ct 分档） */
  @Column({ type: 'int' }) severity: number;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) involved_s: number;
  /** 占 CT 百分比（0~100，一位小数） */
  @Column({ type: 'decimal', precision: 5, scale: 2 }) pct_of_ct: number;
  @Column({ length: 256 }) evidence: string;
  /** v3.51：来源——ai=LLM 识别产出（默认，存量行不变）/ manual=人工录入 */
  @Column({ length: 16, default: 'ai' }) origin: string;
  /**
   * v3.57：路由——finding=确定性命中（【既有】阈值或已标定，计收益）
   * / pool=待标定观察项（【建议】值，仍进浪费清单、est_save_s 不计值）。
   * 全量入清单：route 只决定收益是否计值，不决定清单是否展示（方案文档 0.4 两轴规则落地）。
   * AI 识别产出默认 finding（已过 W1-W3 校验的确定性浪费点）；人工录入可显式标 pool。
   */
  @Column({ length: 16, default: 'finding' }) route: string;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @Column({ type: 'datetime', nullable: true }) updated_at: Date | null;
  @CreateDateColumn() created_at: Date;
}
