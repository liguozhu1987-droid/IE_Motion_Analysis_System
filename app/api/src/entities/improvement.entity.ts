import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Station } from './station.entity';

/** 改善建议（MVP 3 表之 t_improvement，全字段保留 + tenant_id）。
 *  状态：待实施→进行中→已完成→已验证；element_ids 逗号分隔；before_ct/after_ct 系统回填。
 *  v3.66 P2：新增 actual_measure（实际措施）/ actual_completed_at / status_changed_at / overdue_notified_at */
@Entity({ name: 't_improvement' })
export class Improvement {
  @PrimaryColumn({ length: 36 }) imp_id: string;
  @Column({ length: 32, nullable: true }) task_id: string | null;
  @Column({ length: 32 }) tenant_id: string;
  @ManyToOne(() => Station) @JoinColumn({ name: 'station_id' }) station: Station;
  @Column({ length: 32 }) station_id: string;
  @Column({ length: 256 }) element_ids: string;
  @Column({ length: 16 }) waste_type: string;
  @Column({ length: 4 }) method: string; // E|C|R|S
  @Column({ length: 256 }) measure: string;
  /** 实际落实的措施（v3.66 P2） */
  @Column({ length: 256, nullable: true }) actual_measure: string | null;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) est_save_s: number;
  @Column({ type: 'int' }) priority: number; // 归一化 0~100
  @Column({ length: 16, default: '待实施' }) status: string;
  @Column({ length: 32, default: '量产改善' }) project_type: string;
  @Column({ length: 32, nullable: true }) owner: string | null;
  @Column({ type: 'datetime', nullable: true }) due: Date | null;
  /** 实际完成日期（v3.66 P2） */
  @Column({ type: 'datetime', nullable: true }) actual_completed_at: Date | null;
  /** 最近状态变更时间（v3.66 P2） */
  @Column({ type: 'datetime', nullable: true }) status_changed_at: Date | null;
  /** 最近超期提醒时间（v3.66 P2） */
  @Column({ type: 'datetime', nullable: true }) overdue_notified_at: Date | null;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) before_ct: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) after_ct: number | null;
  @Column({ length: 16, default: 'rule' }) source: string;
  @Column({ length: 36, nullable: true }) ai_suggestion_id: string | null;
  @CreateDateColumn() created_at: Date;
}
