import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Station } from '../../../entities/station.entity';

/**
 * AI 建议批次（幂等槽位+溯源；规格书 §1）。
 * status：pending|running|done|done_empty|failed；attempt 仅记审计（无上限，P1-6）。
 * 槽位唯一过滤索引含 version 列，业务语义按 station 维度（服务层先查任意版本成功槽位）。
 * v3.46 双来源线（镜像 ai-waste）：element_source 区分 mixed(legacy 全量)/manual(手工分解线)/
 * ai_assisted(AI 分解线)，幂等槽位/single-flight/缓存均按来源隔离。
 */
@Entity({ name: 't_ai_suggestion_batch' })
export class AiSuggestionBatch {
  @PrimaryColumn({ length: 36 }) batch_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @ManyToOne(() => Station) @JoinColumn({ name: 'station_id' }) station: Station;
  @Column({ length: 32 }) station_id: string;
  @Column({ type: 'int' }) version: number;
  @Column({ length: 32 }) user_id: string;
  /** v3.46 来源线：mixed=全量(legacy 默认) / manual=手工分解线 / ai_assisted=AI 分解线 */
  @Column({ length: 16, default: 'mixed' }) element_source: string;
  /** 1=超管/无限（绕过槽位唯一索引与配额）；0=普通槽位 */
  @Column({ type: 'int', default: 0 }) is_unlimited: number;
  @Column({ length: 16, default: 'pending' }) status: string;
  /** sha1(紧凑负载+规则 rv+prompt_version)；同 hash 有 done 批 → 克隆结果省调用 */
  @Column({ length: 64 }) input_hash: string;
  @Column({ length: 36, nullable: true }) cache_from: string | null;
  @Column({ type: 'int', default: 0 }) attempt: number;
  @Column({ type: 'int', default: 0 }) suggestion_count: number;
  @Column({ type: 'int', default: 0 }) tokens_used: number;
  @Column({ length: 64, nullable: true }) model: string | null;
  @Column({ length: 16, nullable: true }) prompt_version: string | null;
  @Column({ length: 256, nullable: true }) error: string | null;
  @CreateDateColumn() created_at: Date;
  /** 生成完成时间（需求②：入库并记录） */
  @Column({ type: 'datetime', nullable: true }) completed_at: Date | null;
  @UpdateDateColumn() updated_at: Date;
}
