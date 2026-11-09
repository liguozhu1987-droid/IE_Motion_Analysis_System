import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * 视频资产归属（v3.55 补漏）+ 源视频保留决定（2026-11-06 决策）。
 *
 * 背景：工位视频原为「上传即入全局目录、文件名=uuid」的裸文件池，
 * 下载端点只校验 `station:read` 权限点 → **任何登录用户凭文件名即可取任意租户的视频**，
 * 这是比工位分析数据更直接的跨租户泄露（现场录像含其他产线/工位画面）。
 *
 * 本表记录上传归属，使下载可按「上传者 / 关联工位可见权 / 数据范围」判定。
 * 历史文件（迁移前上传、无登记）走无记录分支，保持既有行为不做破坏性收紧。
 *
 * 源视频保留口径（用户决策 2026-11-06，覆盖此前「只归档不删」草案）：
 *  - 默认保留 10 天（VIDEO_RETENTION_DAYS）；到期前 3 天（VIDEO_RETENTION_NOTICE_DAYS）提醒；
 *  - 上传者/管理员可选「再保留 10 天」或「永久保留」；到期仍未选择 → 自动硬删；
 *  - 硬删 = 源文件 + 派生文件（proxy/sprite/index）及其行一并删除，不做回收站；
 *  - 每次删除写 t_audit_log（来源 auto_expired / manual），删除失败重试并告警。
 *
 * 生产库补列见 deploy/sql/manual/2026-11-06-video-retention.sql（手工执行，不自动 migrate）；
 * 开发 sqlite 由 synchronize 建列。SQLite 侧 DATETIME 存文本，TypeORM 双向转换成立。
 */
@Entity({ name: 't_video_asset' })
@Index('idx_video_asset_retention', ['retention_status', 'retention_until'])
export class VideoAsset {
  /** 存储文件名（uuid.mp4），与 storage/videos/ 下的文件名一致 */
  @PrimaryColumn({ length: 64 }) file_name: string;
  @Column({ length: 32 }) tenant_id: string;
  /** 上传者 user_id */
  @Column({ length: 32 }) owner_user_id: string;
  /** 上传者用户名（审计用） */
  @Column({ length: 64, nullable: true }) owner_username: string | null;
  @CreateDateColumn() created_at: Date;

  /** auto=默认到期删除 / extended=用户选择再保留 / permanent=用户选择永久保留 */
  @Column({ length: 16, default: 'auto' }) retention_status: string;
  /** 到期时间；permanent 时为 NULL。历史行为 NULL 时由扫描按 created_at+保留天数惰性回填 */
  @Column({ type: 'datetime', nullable: true }) retention_until: Date | null;
  /** 首次成功发出到期提醒的时间（成功即不再重复提醒） */
  @Column({ type: 'datetime', nullable: true }) notified_at: Date | null;
  /** 最近一次提醒尝试时间（失败后按 VIDEO_RETENTION_NOTIFY_RETRY_HOURS 冷却重试） */
  @Column({ type: 'datetime', nullable: true }) last_notify_at: Date | null;
  /** 提醒尝试次数（含失败，便于运维观测通知链路是否可用） */
  @Column({ type: 'int', default: 0 }) notify_attempts: number;
}
