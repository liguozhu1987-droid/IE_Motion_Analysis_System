import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * 分解任务主表（Phase 2 / 定稿方案 §3.2，2026-11-09 用户授权 "继续 PHASE 2"）。
 *
 * 业务定义：在某条产线上、针对某个项目、在某个时间段开展的**一次**动作分解与改善活动。
 * 一个任务含若干工位（t_task_station），各工位在任务下锁定自己的 bol_version。
 *
 * 口径纪律：
 *  - 任务属于单产线，不跨线；同一物理工位可归属多个任务，但同一任务内一个工位只有一套生效要素。
 *  - 任务内修订走 station.version / bol_version；跨任务对比走 baseline_task_id + #/diff，两种历史维度正交。
 *  - 所有查询必带 tenant_id（v3.59.2 跨租户 line_id 串号越权教训）。
 *  - task_no 租户内唯一、不可变；name 可改。规则版本快照 rule_versions 供归档审计。
 *  - period_start/end 为 DATE，存 ISO 日期；两类方言读回形态不同（mssql Date / sqlite string），
 *    展示统一走 formatIsoDate。
 *
 * 布尔列不写 type（v3.60 mssql 启动崩溃教训）；生产 DDL 见 scripts/migrate.ts。
 */
@Entity({ name: 't_decomposition_task' })
@Index('idx_task_tenant_line', ['tenant_id', 'line_id'])
export class DecompositionTask {
  /** 内部主键；DT-LEGACY 为存量归档任务固定 id */
  @PrimaryColumn({ length: 32 }) task_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  /** 人可读任务号：DT-{YYYY}-{NNN}，租户内唯一 */
  @Column({ length: 64 }) task_no: string;
  @Column({ length: 32 }) line_id: string;
  @Column({ length: 32, nullable: true }) project_id: string | null;
  /** 项目号快照：主数据改名后归档仍可追溯 */
  @Column({ length: 64, nullable: true }) project_no_snapshot: string | null;
  @Column({ length: 64 }) name: string;
  /** baseline | kaizen_after | recheck | legacy | other */
  @Column({ length: 16, default: 'baseline' }) round_type: string;
  @Column({ type: 'int', default: 1 }) round_no: number;
  @Column({ type: 'date', nullable: true }) period_start: string | Date | null;
  @Column({ type: 'date', nullable: true }) period_end: string | Date | null;
  /** active | closed | archived | legacy */
  @Column({ length: 16, default: 'active' }) status: string;
  @Column({ length: 32, nullable: true }) baseline_task_id: string | null;
  /** va_rules / waste_triggers / ecrsa_map / motion_standard 版本指纹 */
  @Column({ length: 128, nullable: true }) rule_versions: string | null;
  @Column({ length: 32, nullable: true }) owner_user_id: string | null;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @CreateDateColumn() created_at: Date;
  @Column({ type: 'datetime', nullable: true }) closed_at: Date | null;
}
