import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Station } from './station.entity';

/** 要素（MVP 3 表之 t_element，16 字段全保留 + tenant_id）。
 *  注意 desc 为 SQL 保留字：TypeORM 自动按方言转义（sqlite "desc" / mssql [desc]），
 *  裸 SQL 必须自行转义（与 MVP 纪律一致）。
 *  Phase 2：element_id 48→96（跨任务编码 {taskNo}-{stationId}-V{version}-{seq} 需要更长），
 *  新增 task_id（默认 DT-LEGACY 归档任务；同一任务内 station_id+bol_version+seq 唯一）。
 *  **实体 length 必须与 migrate.ts DDL 同步**（v3.58.1 截断教训）。 */
@Entity({ name: 't_element' })
export class Element {
  @PrimaryColumn({ length: 96 }) element_id: string;
  @Column({ length: 32 }) tenant_id: string;
  /** 所属分解任务；存量由迁移回填 DT-LEGACY，新要素由应用层注入当前任务 */
  @Column({ length: 32, default: 'DT-LEGACY' }) task_id: string;
  @ManyToOne(() => Station) @JoinColumn({ name: 'station_id' }) station: Station;
  @Column({ length: 32 }) station_id: string;
  @Column({ type: 'int' }) seq: number;
  @Column({ type: 'int' }) start_ms: number;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) dur_s: number;
  @Column({ length: 4 }) hand: string; // L|R|B
  @Column({ length: 16 }) type: string; // 10 类要素
  @Column({ length: 120 }) desc: string;
  @Column({ length: 8 }) va_class: string; // VA|RNVA|NVA
  @Column({ type: 'int', default: 0 }) outlier_flag: number;
  @Column({ length: 128, nullable: true }) outlier_reason: string | null;
  @Column({ length: 64, nullable: true }) video_id: string | null;
  /** 要素来源：manual（人工手工记录）/ ai_assisted（AI 切分接受后落库）。供采纳率统计，候选本身不入库 */
  @Column({ length: 16, default: 'manual' }) source: string;
  @Column({ type: 'decimal', precision: 4, scale: 2, default: 1.0 }) rating: number;
  @Column({ type: 'decimal', precision: 4, scale: 2, default: 0.15 }) allowance: number;
  @Column({ type: 'decimal', precision: 10, scale: 2 }) std_time: number;
  @Column({ type: 'int' }) bol_version: number;
  @CreateDateColumn() created_at: Date;
}
