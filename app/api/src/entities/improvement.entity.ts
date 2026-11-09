import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Station } from './station.entity';

/** 改善建议（MVP 3 表之 t_improvement，全字段保留 + tenant_id）。
 *  状态：待实施|已完成|已验证；element_ids 逗号分隔；before_ct/after_ct 系统回填。 */
@Entity({ name: 't_improvement' })
export class Improvement {
  @PrimaryColumn({ length: 36 }) imp_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @ManyToOne(() => Station) @JoinColumn({ name: 'station_id' }) station: Station;
  @Column({ length: 32 }) station_id: string;
  @Column({ length: 256 }) element_ids: string;
  @Column({ length: 16 }) waste_type: string;
  @Column({ length: 4 }) method: string; // E|C|R|S
  @Column({ length: 256 }) measure: string;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) est_save_s: number;
  @Column({ type: 'int' }) priority: number; // 归一化 0~100
  @Column({ length: 16, default: '待实施' }) status: string;
  @Column({ length: 32, default: '量产改善' }) project_type: string; // v3.3：NPI导入|量产改善|自动化改造|布局优化|质量改善
  @Column({ length: 32, nullable: true }) owner: string | null;
  @Column({ type: 'datetime', nullable: true }) due: Date | null;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) before_ct: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) after_ct: number | null;
  /** 溯源：rule=规则引擎 | ai=AI 建议采纳（v3.30；铁律①） */
  @Column({ length: 16, default: 'rule' }) source: string;
  /** source='ai' 时指向 t_ai_suggestion.suggestion_id */
  @Column({ length: 36, nullable: true }) ai_suggestion_id: string | null;
  @CreateDateColumn() created_at: Date;
}
