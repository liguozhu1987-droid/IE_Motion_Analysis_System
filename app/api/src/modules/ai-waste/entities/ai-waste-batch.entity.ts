import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Station } from '../../../entities/station.entity';

/**
 * P3-9 浪费识别批次（AI 自动分解线专用；与 ai-suggest 批次完全独立的表与状态机）。
 * status：running|done|done_empty|failed。
 * element_source 固定 'ai_assisted'——本模块只识别 AI 自动分解写入的要素（边界铁律：
 * 手工分解工位走分解工作台 AI 建议，不进本模块）。
 */
@Entity({ name: 't_ai_waste_batch' })
export class AiWasteBatch {
  @PrimaryColumn({ length: 36 }) batch_id: string;
  @ManyToOne(() => Station) @JoinColumn({ name: 'station_id' }) station: Station;
  @Column({ length: 32 }) station_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ type: 'int' }) version: number;
  @Column({ length: 32 }) user_id: string;
  @Column({ length: 16, default: 'running' }) status: string;
  @Column({ length: 16, default: 'ai_assisted' }) element_source: string;
  @Column({ type: 'int', default: 0 }) element_count: number;
  @Column({ type: 'int', default: 0 }) finding_count: number;
  @Column({ type: 'int', default: 0 }) issue_count: number;
  @Column({ type: 'int', default: 0 }) tokens_used: number;
  @Column({ length: 64, nullable: true }) model: string | null;
  @Column({ length: 16, nullable: true }) prompt_version: string | null;
  @Column({ length: 256, nullable: true }) error: string | null;
  @CreateDateColumn() created_at: Date;
  @Column({ type: 'datetime', nullable: true }) completed_at: Date | null;
  @UpdateDateColumn() updated_at: Date;
}
