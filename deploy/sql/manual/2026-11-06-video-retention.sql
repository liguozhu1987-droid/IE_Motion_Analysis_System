/* =============================================================================
 * 源视频保留策略（2026-11-06 用户决策）：t_video_asset 增加保留决定字段
 * -----------------------------------------------------------------------------
 * 执行方式：**手工执行**（SQL Server Management Studio / sqlcmd），不要接入
 *          app/api/scripts/migrate.ts 的自动迁移流程。
 * 目标库：生产 CN_AME（SQL Server 2017）。执行前请用只读账号核对表名与列名。
 * 幂等：所有 DDL 均先判断存在性，可重复执行。
 * 回滚：文件末尾「回滚段」，按需手工执行。
 *
 * 字段口径：
 *  - retention_status：auto=默认到期删除 / extended=用户选择再保留 / permanent=永久保留
 *  - retention_until ：auto/extended 的到期时间；permanent 为 NULL
 *  - notified_at     ：首次成功发出到期提醒的时间（成功即不再重复提醒）
 *  - last_notify_at  ：最近一次提醒尝试时间（失败按冷却重试）
 *  - notify_attempts ：提醒尝试次数（含失败，用于观测通知链路）
 *
 * 开发环境（SQLite）由 TypeORM synchronize 自动建列，无需执行本脚本；
 * 存量 SQLite 若关闭 synchronize，可参考文件末尾的 SQLite 变体（逐条手工执行）。
 * ============================================================================= */

SET NOCOUNT ON;

-- 1) 保留状态
IF COL_LENGTH('dbo.t_video_asset', 'retention_status') IS NULL
BEGIN
  ALTER TABLE dbo.t_video_asset
    ADD retention_status NVARCHAR(16) NOT NULL
        CONSTRAINT DF_t_video_asset_retention_status DEFAULT ('auto');
END
GO

-- 2) 到期时间
IF COL_LENGTH('dbo.t_video_asset', 'retention_until') IS NULL
BEGIN
  ALTER TABLE dbo.t_video_asset ADD retention_until DATETIME2 NULL;
END
GO

-- 3) 首次成功提醒时间
IF COL_LENGTH('dbo.t_video_asset', 'notified_at') IS NULL
BEGIN
  ALTER TABLE dbo.t_video_asset ADD notified_at DATETIME2 NULL;
END
GO

-- 4) 最近一次提醒尝试时间
IF COL_LENGTH('dbo.t_video_asset', 'last_notify_at') IS NULL
BEGIN
  ALTER TABLE dbo.t_video_asset ADD last_notify_at DATETIME2 NULL;
END
GO

-- 5) 提醒尝试次数
IF COL_LENGTH('dbo.t_video_asset', 'notify_attempts') IS NULL
BEGIN
  ALTER TABLE dbo.t_video_asset
    ADD notify_attempts INT NOT NULL
        CONSTRAINT DF_t_video_asset_notify_attempts DEFAULT (0);
END
GO

-- 6) 到期扫描索引（保留期扫描按 status + until 过滤）
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'idx_video_asset_retention'
    AND object_id = OBJECT_ID('dbo.t_video_asset')
)
BEGIN
  CREATE INDEX idx_video_asset_retention
    ON dbo.t_video_asset (retention_status, retention_until);
END
GO

-- 7) 回填存量行：仅 auto 且尚未设置到期时间的行（已有决定的不覆盖）
--    注意：GO 会结束批，变量不能跨批；此处单独声明。
DECLARE @RetentionDays INT = 10; -- 必须与 .env 的 VIDEO_RETENTION_DAYS 一致（默认 10）
UPDATE dbo.t_video_asset
SET retention_until = DATEADD(day, @RetentionDays, created_at)
WHERE retention_status = 'auto'
  AND retention_until IS NULL;
GO

-- 核对：执行后应返回 5 列 + 1 索引
-- SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.t_video_asset')
--   AND name IN ('retention_status','retention_until','notified_at','last_notify_at','notify_attempts');
-- SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.t_video_asset') AND name = 'idx_video_asset_retention';

/* =============================================================================
 * 回滚段（仅在需要整体撤销本次变更时手工执行；先确认没有依赖这些列的代码在跑）
 * -----------------------------------------------------------------------------
 * IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_video_asset_retention'
 *            AND object_id=OBJECT_ID('dbo.t_video_asset'))
 *   DROP INDEX idx_video_asset_retention ON dbo.t_video_asset;
 * GO
 * ALTER TABLE dbo.t_video_asset DROP CONSTRAINT DF_t_video_asset_retention_status;
 * ALTER TABLE dbo.t_video_asset DROP CONSTRAINT DF_t_video_asset_notify_attempts;
 * GO
 * ALTER TABLE dbo.t_video_asset DROP COLUMN retention_status;
 * ALTER TABLE dbo.t_video_asset DROP COLUMN retention_until;
 * ALTER TABLE dbo.t_video_asset DROP COLUMN notified_at;
 * ALTER TABLE dbo.t_video_asset DROP COLUMN last_notify_at;
 * ALTER TABLE dbo.t_video_asset DROP COLUMN notify_attempts;
 * GO
 * ============================================================================= */

/* =============================================================================
 * SQLite 变体（仅当开发库关闭 synchronize 且需手工补列时使用；逐条执行）
 * -----------------------------------------------------------------------------
 * ALTER TABLE t_video_asset ADD COLUMN retention_status TEXT NOT NULL DEFAULT 'auto';
 * ALTER TABLE t_video_asset ADD COLUMN retention_until DATETIME NULL;
 * ALTER TABLE t_video_asset ADD COLUMN notified_at DATETIME NULL;
 * ALTER TABLE t_video_asset ADD COLUMN last_notify_at DATETIME NULL;
 * ALTER TABLE t_video_asset ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
 * CREATE INDEX IF NOT EXISTS idx_video_asset_retention
 *   ON t_video_asset (retention_status, retention_until);
 * UPDATE t_video_asset SET retention_until = datetime(created_at, '+10 days')
 *   WHERE retention_status='auto' AND retention_until IS NULL;
 * ============================================================================= */
