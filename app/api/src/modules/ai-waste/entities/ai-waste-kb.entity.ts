import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * v3.51 改善知识库（t_ai_waste_kb）：人工录入 + 已确认 AI 条目的沉淀，供后续 AI 识别检索注入 prompt。
 *
 * 设计要点：
 *  - kind：finding=浪费识别经验 / issue=改善措施经验——两类分开检索（注入段落不同）；
 *  - station_id 可空：NULL = 跨工位通用经验（人工整理时可选「通用」）；
 *  - source_ref 溯源原条目（finding_id / issue_id），配合 UQ_ai_waste_kb_ref 过滤唯一索引
 *    实现「重复整理 = 幂等更新」，不产生重复行；
 *  - keywords / element_types：整理时服务端抽取（不入 LLM），检索打分只用这两列 + waste_type + ecrs；
 *  - hit_count / last_hit_at：被 AI 生成命中次数，用于知识库「越用越准」的排序与清理判断。
 */
@Entity({ name: 't_ai_waste_kb' })
export class AiWasteKb {
  @PrimaryColumn({ length: 36 }) kb_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  /** NULL = 通用经验（不限工位） */
  @Column({ length: 32, nullable: true }) station_id: string | null;
  /** finding=浪费识别 / issue=改善措施 */
  @Column({ length: 8 }) kind: string;
  @Column({ length: 16 }) waste_type: string;
  @Column({ length: 4, nullable: true }) ecrs: string | null;
  @Column({ length: 256, nullable: true }) problem: string | null;
  @Column({ length: 256, nullable: true }) suggestion: string | null;
  @Column({ length: 256, nullable: true }) evidence: string | null;
  /** 检索关键词（逗号分隔；服务端抽取，含 waste_type 与要素类型同义词） */
  @Column({ length: 256, nullable: true }) keywords: string | null;
  /** 关联要素类型（逗号分隔；来自原条目引用的要素 type） */
  @Column({ length: 256, nullable: true }) element_types: string | null;
  /** 沉淀来源：manual=人工录入条目 / ai=已确认 AI 条目 */
  @Column({ length: 16, default: 'manual' }) source_origin: string;
  /** 原条目 ID（溯源 + 幂等键） */
  @Column({ length: 36, nullable: true }) source_ref: string | null;
  @Column({ type: 'int', default: 0 }) hit_count: number;
  @Column({ type: 'datetime', nullable: true }) last_hit_at: Date | null;
  /** active=参与检索 / archived=停用保留 */
  @Column({ length: 16, default: 'active' }) status: string;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  /** v3.53 向量化：embedding 向量（JSON 数组，如 384 维）；NULL=未生成（退化为关键词打分）。SQL Server 无原生 vector，应用层存 JSON + 余弦。 */
  @Column({ type: 'text', nullable: true }) embedding: string | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
