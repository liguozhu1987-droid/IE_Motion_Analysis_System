import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * 分解任务—工位关联 / 快照（Phase 2 / 定稿方案 §3.2）。
 *
 * 同一物理工位可出现在多个任务下（不同时期多轮改善），复合主键 (task_id, station_id)。
 * bol_version = 该任务**锁定**的要素版本；导出只读此版本，不随后续修订漂移。
 * 名称快照保证工位改名后历史归档文件仍可追溯。
 *
 * 所有查询必带 tenant_id；生产 DDL 见 scripts/migrate.ts。
 */
@Entity({ name: 't_task_station' })
@Index('idx_task_station_tenant_station', ['tenant_id', 'station_id'])
export class TaskStation {
  @PrimaryColumn({ length: 32 }) task_id: string;
  @PrimaryColumn({ length: 32 }) station_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 64, nullable: true }) station_code_snapshot: string | null;
  @Column({ length: 64, nullable: true }) station_name_snapshot: string | null;
  /** 任务锁定的要素版本（导出唯一取数版本） */
  @Column({ type: 'int' }) bol_version: number;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) ct_snapshot: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) tt_snapshot: number | null;
  /** 任务内展示顺序（导出按此排序，回落 station_id ASC） */
  @Column({ type: 'int', default: 0 }) seq_no: number;
}
