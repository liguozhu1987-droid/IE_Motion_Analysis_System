/*
 * ============================================================================
 * 统一身份认证（OIDC 双轨）—— 手工执行 SQL（v3.57，2026-11-06）
 * ============================================================================
 * 适用范围：生产 SQL Server CN_AME（t_user / t_refresh_token 增量列）
 *
 * 执行方式：SSMS 手工执行；**不接入 migrate.ts，不在应用启动时自动执行**。
 * 执行前：确认已备份（本项目决定「不保留备份」，见 DEPLOY-CONFIG.md §11，故请自行临时导出）。
 * 幂等：所有变更均带存在性判断，可重复执行。
 *
 * 说明：
 *  - SSO 五表（CN_AME_SSO_User / UserMap / StgAdUser / SyncLog / PermLedger）由统一身份认证
 *    实施包 `scripts/sql/01_create_sso_tables.sql` 创建，本系统**只读**其 User/UserMap，
 *    不在此重复建表，避免与中央库 DDL 分叉。
 *  - auth_source：账号来源标记（local/oidc），仅用于 /auth/me 展示与离职状态回写范围，
 *    不参与登录判定。
 *  - source：refresh 令牌签发来源，保证 SSO 会话刷新后 /auth/me 仍显示 oidc。
 * ============================================================================
 */

SET NOCOUNT ON;
GO

/* 0) 预检（只读）：确认 SSO 中央表已存在；缺表请先执行统一身份认证实施包的建表脚本 */
SELECT name AS sso_table
FROM sys.tables
WHERE name IN (
  'CN_AME_SSO_User', 'CN_AME_SSO_UserMap', 'CN_AME_SSO_StgAdUser',
  'CN_AME_SSO_SyncLog', 'CN_AME_SSO_PermLedger'
)
ORDER BY name;
GO

/* 1) t_user.auth_source */
IF COL_LENGTH('dbo.t_user', 'auth_source') IS NULL
BEGIN
  ALTER TABLE dbo.t_user
    ADD auth_source NVARCHAR(8) NOT NULL
        CONSTRAINT DF_t_user_auth_source DEFAULT N'local';
  PRINT 'added dbo.t_user.auth_source';
END
ELSE
  PRINT 'dbo.t_user.auth_source already exists';
GO

/* 2) t_refresh_token.source */
IF COL_LENGTH('dbo.t_refresh_token', 'source') IS NULL
BEGIN
  ALTER TABLE dbo.t_refresh_token
    ADD source NVARCHAR(8) NOT NULL
        CONSTRAINT DF_t_refresh_token_source DEFAULT N'local';
  PRINT 'added dbo.t_refresh_token.source';
END
ELSE
  PRINT 'dbo.t_refresh_token.source already exists';
GO

/* 3) 工号查询索引（SSO 身份解析按 employee_no 命中，登录路径上会被高频调用） */
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'idx_user_employee_no' AND object_id = OBJECT_ID('dbo.t_user')
)
BEGIN
  CREATE INDEX idx_user_employee_no ON dbo.t_user (employee_no);
  PRINT 'created idx_user_employee_no';
END
ELSE
  PRINT 'idx_user_employee_no already exists';
GO

/* 4) 校验 */
SELECT
  COL_LENGTH('dbo.t_user', 'auth_source')           AS t_user_auth_source_len,
  COL_LENGTH('dbo.t_refresh_token', 'source')       AS t_refresh_token_source_len,
  (SELECT COUNT(1) FROM sys.indexes
   WHERE name = 'idx_user_employee_no' AND object_id = OBJECT_ID('dbo.t_user')) AS employee_index_count;
GO

/* ============================================================================
 * 回滚（仅在需要撤销本次变更时手工执行）
 * ----------------------------------------------------------------------------
 * ALTER TABLE dbo.t_user DROP CONSTRAINT DF_t_user_auth_source;
 * ALTER TABLE dbo.t_user DROP COLUMN auth_source;
 * ALTER TABLE dbo.t_refresh_token DROP CONSTRAINT DF_t_refresh_token_source;
 * ALTER TABLE dbo.t_refresh_token DROP COLUMN source;
 * DROP INDEX idx_user_employee_no ON dbo.t_user;
 * GO
 * 注意：回滚列会丢失「账号来源」信息；已由 SSO 自动建档的账号仍可凭 SSO 登录
 *      （身份解析回落到 CN_AME_SSO_User 比对，不依赖 auth_source），
 *      但离职状态回写将失去筛选范围，需人工核对。
 * ============================================================================
 */

/* ============================================================================
 * SQLite 变体（仅开发/隔离环境手工补列；开发库默认由 TypeORM synchronize 建列）
 * ----------------------------------------------------------------------------
 * ALTER TABLE t_user ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';
 * ALTER TABLE t_refresh_token ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
 * CREATE INDEX IF NOT EXISTS idx_user_employee_no ON t_user (employee_no);
 * ============================================================================
 */
