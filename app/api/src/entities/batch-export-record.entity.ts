import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * 批量导出留档（v3.62，用户决策 2026-11-09「写入数据库」）。
 *
 * 每次 GET /export/batch.xlsx 成功生成后：
 *  - XLSX 落盘 storage/exports/<record_id>.xlsx（文件名 = 主键，天然防碰撞/防遍历）；
 *  - 本表登记一行（谁 / 何时 / 哪条产线 / 范围参数 / sheet 数 / 字节数 / 规则版本指纹）。
 *
 * 口径纪律（与 v3.61 MVP 一致，不因留档而变化）：
 *  - 留档只记「导出行为与产物」，不快照业务数据——表内数字是当时统计值，
 *    工位后续改版后复下载的仍是**当时生成的那份文件**，不重新计算；
 *  - 可见性 = 本人 ∪ 全权角色（hasFullAccess），租户隔离由 Repository 行级过滤兜底；
 *  - 复下载按记录可见性判定，与工位可见性无关（产物归属导出人，不随工位共享）。
 *
 * status：ready=文件在盘可复下载 / missing=文件丢失或落盘失败（记录仅作历史）。
 * 布尔列不写 type（mssql→BIT / sqlite→BOOLEAN，v3.60 教训）。
 * 生产建表见 scripts/migrate.ts DDL 段；开发 sqlite 由 synchronize 自动建列。
 */
@Entity({ name: 't_batch_export_record' })
@Index('idx_batch_export_user_time', ['tenant_id', 'user_id', 'created_at'])
@Index('idx_batch_export_tenant_time', ['tenant_id', 'created_at'])
export class BatchExportRecord {
  /** 主键 = 存储文件名（<record_id>.xlsx） */
  @PrimaryColumn({ length: 36 }) record_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 32 }) user_id: string;
  /** 导出人显示名（审计用；用户可能被注销，冗余存一份） */
  @Column({ length: 64, nullable: true }) username: string | null;
  @Column({ length: 32 }) line_id: string;
  @Column({ length: 64, nullable: true }) line_name: string | null;
  /** Phase 2：导出所属分解任务（未指定任务的历史记录为 null，兼容 v3.62 存量行） */
  @Column({ length: 32, nullable: true }) task_id: string | null;
  /** 任务号快照（DT-2026-011 / DT-LEGACY），归档脱离系统后仍可追溯 */
  @Column({ length: 64, nullable: true }) task_no: string | null;
  @Column({ type: 'int', default: 0 }) station_count: number;
  @Column({ type: 'int', default: 0 }) element_count: number;
  @Column({ type: 'int', default: 0 }) focus_count: number;
  @Column({ type: 'int', default: 5 }) sheet_count: number;
  @Column({ default: true }) with_focus: boolean;
  @Column({ default: false }) include_outliers: boolean;
  @Column({ default: false }) include_undecomposed: boolean;
  @Column({ type: 'int', default: 30 }) focus_top: number;
  /** storage/exports/ 下的文件名（= <record_id>.xlsx）；落盘失败时为空串 */
  @Column({ length: 128 }) file_name: string;
  @Column({ type: 'int', default: 0 }) file_size: number;
  /** 复下载时的展示文件名（原下载名，中文） */
  @Column({ length: 256, nullable: true }) download_name: string | null;
  /** 规则版本指纹（va:x|waste:y|ecrsa:z|motion:w，追溯口径用） */
  @Column({ length: 256, nullable: true }) rule_versions: string | null;
  @Column({ length: 16, default: 'ready' }) status: string;
  @Column({ type: 'int', default: 0 }) download_count: number;
  @CreateDateColumn() created_at: Date;
  @Column({ type: 'datetime', nullable: true }) last_downloaded_at: Date | null;
}
