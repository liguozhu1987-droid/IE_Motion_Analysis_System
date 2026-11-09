/**
 * SQL Server 生产迁移：建 14 张表 + 8 索引（TypeORM synchronize=false 的生产路径）。
 * 用法：npm run migrate:prod（连接配置从 .env 读取，DB_TYPE=mssql 时执行）。
 * 说明：开发库（sqlite）用 synchronize=true 自动建表，无需本脚本；
 *      本脚本对 mssql 执行幂等 DDL（IF OBJECT_ID 保护，可重复执行）。
 *
 * ── 建表规范（与 src/entities/*.entity.ts 一一对应，改 DDL 必须同步改实体）──
 *  表名    t_ + 模块_实体，snake_case 单数（t_station / t_element / t_improvement …）
 *  主键    <实体>_id，NVARCHAR(32/36/48)；无代理键，全部业务自然键
 *  外键    <关联实体>_id，FK_<表>_<关联实体>，与实体 @ManyToOne 声明一致
 *  租户列  业务表一律 tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT'，行级隔离依赖此列
 *  时间列  created_at/updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()（UTC）
 *  标志列  布尔语义一律 INT 0/1（outlier_flag / is_active / is_frozen / revoked …）
 *  度量列  时长/金额 DECIMAL(10,2)；评比系数 DECIMAL(4,2)
 *  长文本  JSON/规则原文 NVARCHAR(MAX)；desc 为保留字，裸 SQL 必须 [desc] 转义
 *  约束    PK_<表>（复合主键）/ UQ_<表>_<列…> / FK_<表>_<关联> / idx_<表>_<列…>
 */
import 'dotenv/config'; // 从 .env 读取连接配置（与 main.ts 同一份配置）
import 'reflect-metadata';
import { loadConfig } from '../src/core/config/configuration';
import { createConnection } from 'typeorm';

const DDL: string[] = [
  // —— 租户（法人/事业部；region=区域维度挂公司；其余业务表 tenant_id 均指向本表）——
  `IF OBJECT_ID('t_tenant','U') IS NULL CREATE TABLE t_tenant (
    tenant_id NVARCHAR(32) NOT NULL PRIMARY KEY,
    code NVARCHAR(32) NOT NULL,
    name NVARCHAR(64) NOT NULL,
    region NVARCHAR(32) NOT NULL DEFAULT '总部',
    status NVARCHAR(16) NOT NULL DEFAULT 'active',
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // —— 用户（登录锁定：failed_count>=LOGIN_MAX_FAIL → locked_until=now+LOGIN_LOCK_MIN）——
  // status：active|pending|rejected|locked|disabled；username 全局唯一（登录仅凭用户名，跨租户不重名）
  `IF OBJECT_ID('t_user','U') IS NULL CREATE TABLE t_user (
    user_id NVARCHAR(32) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL,
    username NVARCHAR(64) NOT NULL,
    password_hash NVARCHAR(128) NOT NULL,
    display_name NVARCHAR(32) NOT NULL,
    email NVARCHAR(128) NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'active',
    failed_count INT NOT NULL DEFAULT 0,
    locked_until DATETIME2 NULL,
    must_change_pwd INT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_user_username UNIQUE (username),
    CONSTRAINT FK_t_user_tenant FOREIGN KEY (tenant_id) REFERENCES t_tenant(tenant_id))`,
  // —— 角色（按租户隔离；系统角色 is_system=1 不可删除）——
  `IF OBJECT_ID('t_role','U') IS NULL CREATE TABLE t_role (
    role_id NVARCHAR(32) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL,
    code NVARCHAR(32) NOT NULL,
    name NVARCHAR(32) NOT NULL,
    is_system INT NOT NULL DEFAULT 0,
    CONSTRAINT FK_t_role_tenant FOREIGN KEY (tenant_id) REFERENCES t_tenant(tenant_id))`,
  // —— 权限点字典（系统级，无租户列）——
  `IF OBJECT_ID('t_permission','U') IS NULL CREATE TABLE t_permission (
    perm_id NVARCHAR(32) NOT NULL PRIMARY KEY,
    code NVARCHAR(48) NOT NULL,
    module NVARCHAR(32) NOT NULL,
    name NVARCHAR(32) NOT NULL,
    CONSTRAINT UQ_permission_code UNIQUE (code))`,
  // —— 用户-角色 / 角色-权限（纯关联表，复合主键）——
  `IF OBJECT_ID('t_user_role','U') IS NULL CREATE TABLE t_user_role (
    user_id NVARCHAR(32) NOT NULL, role_id NVARCHAR(32) NOT NULL,
    CONSTRAINT PK_t_user_role PRIMARY KEY (user_id, role_id),
    CONSTRAINT FK_t_user_role_user FOREIGN KEY (user_id) REFERENCES t_user(user_id),
    CONSTRAINT FK_t_user_role_role FOREIGN KEY (role_id) REFERENCES t_role(role_id))`,
  `IF OBJECT_ID('t_role_permission','U') IS NULL CREATE TABLE t_role_permission (
    role_id NVARCHAR(32) NOT NULL, perm_id NVARCHAR(32) NOT NULL,
    CONSTRAINT PK_t_role_permission PRIMARY KEY (role_id, perm_id),
    CONSTRAINT FK_t_role_permission_role FOREIGN KEY (role_id) REFERENCES t_role(role_id),
    CONSTRAINT FK_t_role_permission_perm FOREIGN KEY (perm_id) REFERENCES t_permission(perm_id))`,
  // —— Refresh Token（轮换 + 复用检测：重放旧 token → 全族吊销）——
  `IF OBJECT_ID('t_refresh_token','U') IS NULL CREATE TABLE t_refresh_token (
    token_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    user_id NVARCHAR(32) NOT NULL,
    token_hash NVARCHAR(128) NOT NULL,
    expires_at DATETIME2 NOT NULL,
    revoked INT NOT NULL DEFAULT 0,
    replaced_by NVARCHAR(36) NULL,
    ip NVARCHAR(45) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_t_refresh_token_user FOREIGN KEY (user_id) REFERENCES t_user(user_id))`,
  // —— 密码重置码（helpdesk 模式：无 SMTP，管理员人工下发；sha256 存储/30 分钟/一次性/尝试上限 5）——
  `IF OBJECT_ID('t_password_reset','U') IS NULL CREATE TABLE t_password_reset (
    reset_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    user_id NVARCHAR(32) NOT NULL,
    code_hash NVARCHAR(64) NOT NULL,
    expires_at DATETIME2 NOT NULL,
    used INT NOT NULL DEFAULT 0,
    attempts INT NOT NULL DEFAULT 0,
    ip NVARCHAR(45) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_t_password_reset_user FOREIGN KEY (user_id) REFERENCES t_user(user_id))`,
  // —— 规则集（规则库入库；每个 code 仅一条 is_active=1，发布=插入+切换可回滚）——
  `IF OBJECT_ID('t_rule_set','U') IS NULL CREATE TABLE t_rule_set (
    rule_set_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    code NVARCHAR(32) NOT NULL,
    version NVARCHAR(16) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    is_active INT NOT NULL DEFAULT 1,
    is_frozen INT NOT NULL DEFAULT 0,
    effective_from DATETIME2 NULL,
    created_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // —— 视频资产归属（v3.55 补漏：工位视频原为全局裸文件池，任一登录用户凭文件名即可跨租户下载）——
  // 记录上传者与租户，使播放端点可按「上传者 / 关联工位可见权 / 数据范围」判定。
  `IF OBJECT_ID('t_video_asset','U') IS NULL CREATE TABLE t_video_asset (
    file_name NVARCHAR(64) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL,
    owner_user_id NVARCHAR(32) NOT NULL,
    owner_username NVARCHAR(64) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // —— 视频派生物（SPEC-VID-P0 §3：proxy|sprite|index 懒生成；唯一键 (file_name,kind) 保幂等，不加 FK）——
  // status：pending|running|ready|error；retry<2 的 error 行由 worker 下轮自动重入
  // last_accessed_at 为 LRU 预留列（P0 不写入，P0.5 磁盘告警/LRU 删代理启用，无迁移）
  `IF OBJECT_ID('t_video_derivative','U') IS NULL CREATE TABLE t_video_derivative (
    id NVARCHAR(36) NOT NULL PRIMARY KEY,
    file_name NVARCHAR(64) NOT NULL,
    kind NVARCHAR(16) NOT NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'pending',
    path NVARCHAR(512) NULL,
    size BIGINT NULL,
    frames INT NULL,
    duration_ms INT NULL,
    width INT NULL,
    height INT NULL,
    fps REAL NULL,
    vfr BIT NULL,
    retry TINYINT NOT NULL DEFAULT 0,
    last_accessed_at DATETIME2 NULL,
    error_msg NVARCHAR(512) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // —— AI 任务队列（SQL Server-backed，无 Redis；状态 pending|running|done|failed）——
  `IF OBJECT_ID('t_ai_task','U') IS NULL CREATE TABLE t_ai_task (
    task_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL,
    type NVARCHAR(32) NOT NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'pending',
    input_json NVARCHAR(MAX) NULL,
    output_json NVARCHAR(MAX) NULL,
    tokens_used INT NOT NULL DEFAULT 0,
    error NVARCHAR(256) NULL,
    retry_count INT NOT NULL DEFAULT 0,
    created_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // —— 审计日志（保留 2 年；不建外键：用户注销后审计必须留存）——
  `IF OBJECT_ID('t_audit_log','U') IS NULL CREATE TABLE t_audit_log (
    log_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL,
    user_id NVARCHAR(32) NULL,
    username NVARCHAR(32) NULL,
    action NVARCHAR(64) NOT NULL,
    entity NVARCHAR(32) NOT NULL,
    entity_id NVARCHAR(64) NULL,
    before_json NVARCHAR(MAX) NULL,
    after_json NVARCHAR(MAX) NULL,
    ip NVARCHAR(45) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // v3.58.1 审计列扩容（存量库 ALTER）：v3.42 拦截器把 entity 从短实体名改成完整请求路径
  // （55+ 字符）后，NVARCHAR(32) 装不下 → TDS 报错、审计全量静默丢失（v3.58 加错误日志才暴露）。
  // action 同步扩到 128（path 派生的 action 更长）。只加不缩，幂等可重跑。
  `IF (SELECT CAST(max_length AS INT)/2 FROM sys.columns WHERE object_id=OBJECT_ID('t_audit_log','U') AND name='entity') < 64
   ALTER TABLE t_audit_log ALTER COLUMN entity NVARCHAR(64) NOT NULL`,
  `IF (SELECT CAST(max_length AS INT)/2 FROM sys.columns WHERE object_id=OBJECT_ID('t_audit_log','U') AND name='action') < 128
   ALTER TABLE t_audit_log ALTER COLUMN action NVARCHAR(128) NOT NULL`,
  // —— 产线（v3.3 一等实体：工艺/产品元数据 + 集团驾驶舱维度；复合主键支持跨公司同线码）——
  // —— 项目主数据（v3.7：新建分析对象向导的项目下拉；产线通过 product_project 关联编号）——
  `IF OBJECT_ID('t_project','U') IS NULL CREATE TABLE t_project (
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    project_id NVARCHAR(32) NOT NULL,
    name NVARCHAR(64) NOT NULL,
    customer NVARCHAR(64) NOT NULL DEFAULT '',
    stage NVARCHAR(16) NOT NULL DEFAULT '量产',
    status NVARCHAR(16) NOT NULL DEFAULT 'active',
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_t_project PRIMARY KEY (tenant_id, project_id),
    CONSTRAINT FK_project_tenant FOREIGN KEY (tenant_id) REFERENCES t_tenant(tenant_id))`,
  `IF OBJECT_ID('t_line','U') IS NULL CREATE TABLE t_line (
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    line_id NVARCHAR(32) NOT NULL,
    name NVARCHAR(64) NOT NULL,
    process_type NVARCHAR(32) NOT NULL DEFAULT '装配',
    product_type NVARCHAR(64) NOT NULL DEFAULT '待补充',
    product_project NVARCHAR(64) NOT NULL DEFAULT '-',
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_t_line PRIMARY KEY (tenant_id, line_id),
    CONSTRAINT FK_line_tenant FOREIGN KEY (tenant_id) REFERENCES t_tenant(tenant_id))`,
  // —— 工位（version = 生效 bol_version 指针；封存=指针推进，旧版数据不动）——
  // v3.42：owner_user_id 归属人（新建库直接带列；存量库走 MIGRATIONS 补列+回填）
  `IF OBJECT_ID('t_station','U') IS NULL CREATE TABLE t_station (
    station_id NVARCHAR(32) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    line_id NVARCHAR(32) NOT NULL,
    name NVARCHAR(64) NOT NULL,
    owner_user_id NVARCHAR(32) NULL,
    ct DECIMAL(10,2) NULL,
    tt DECIMAL(10,2) NULL,
    version INT NOT NULL DEFAULT 1,
    updated_by NVARCHAR(32) NULL,
    updated_at DATETIME2 NULL,
    created_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_t_station_tenant FOREIGN KEY (tenant_id) REFERENCES t_tenant(tenant_id))`,
  // —— 要素（BOL 核心表；desc 为保留字需 [desc] 转义；UQ 防止同版本同序号重复提交）——
  `IF OBJECT_ID('t_element','U') IS NULL CREATE TABLE t_element (
    element_id NVARCHAR(48) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    seq INT NOT NULL,
    start_ms INT NOT NULL,
    dur_s DECIMAL(10,2) NOT NULL,
    hand NVARCHAR(4) NOT NULL,
    type NVARCHAR(16) NOT NULL,
    [desc] NVARCHAR(120) NOT NULL,
    va_class NVARCHAR(8) NOT NULL,
    outlier_flag INT NOT NULL DEFAULT 0,
    outlier_reason NVARCHAR(128) NULL,
    video_id NVARCHAR(64) NULL,
    source NVARCHAR(16) NOT NULL DEFAULT 'manual',
    rating DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    allowance DECIMAL(4,2) NOT NULL DEFAULT 0.15,
    std_time DECIMAL(10,2) NOT NULL,
    bol_version INT NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_element_tenant_ver_seq UNIQUE (tenant_id, station_id, bol_version, seq),
    CONSTRAINT FK_t_element_station FOREIGN KEY (station_id) REFERENCES t_station(station_id))`,
  // —— 改善建议（三态：待实施→已完成→已验证；after_ct 由系统回填）——
  `IF OBJECT_ID('t_improvement','U') IS NULL CREATE TABLE t_improvement (
    imp_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    element_ids NVARCHAR(256) NOT NULL,
    waste_type NVARCHAR(16) NOT NULL,
    method NVARCHAR(4) NOT NULL,
    measure NVARCHAR(256) NOT NULL,
    est_save_s DECIMAL(10,2) NOT NULL,
    priority INT NOT NULL,
    status NVARCHAR(16) NOT NULL DEFAULT '待实施',
    project_type NVARCHAR(32) NOT NULL DEFAULT '量产改善',
    owner NVARCHAR(32) NULL,
    due DATETIME2 NULL,
    before_ct DECIMAL(10,2) NULL,
    after_ct DECIMAL(10,2) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_t_improvement_station FOREIGN KEY (station_id) REFERENCES t_station(station_id))`,
  // —— AI 建议批次（幂等槽位+溯源；AI 改善建议模块 · 合并实施规格书 §1）——
  // status：pending|running|done|done_empty|failed；attempt 仅记审计（无 24h 上限，P1-6）
  // 槽位唯一过滤索引含 version 列，但业务语义按 station 维度（规格书 §1 ⚠）：
  // 生成前先查 (tenant,station,user) 是否已有任意版本成功槽位；索引留 version 列为将来 AI_QUOTA_SCOPE=station+version 预留
  // v3.46：element_source 来源线（mixed=全量 legacy 默认 / manual=手工分解线 / ai_assisted=AI 分解线）——
  // 存量库升级见 INDEXES 中 UQ_ai_batch_slot 的删旧建新（存量行默认 mixed，唯一性保持不变）
  `IF OBJECT_ID('t_ai_suggestion_batch','U') IS NULL CREATE TABLE t_ai_suggestion_batch (
    batch_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    version INT NOT NULL,
    user_id NVARCHAR(32) NOT NULL,
    element_source NVARCHAR(16) NOT NULL DEFAULT 'mixed',
    is_unlimited INT NOT NULL DEFAULT 0,
    status NVARCHAR(16) NOT NULL DEFAULT 'pending',
    input_hash NVARCHAR(64) NOT NULL,
    cache_from NVARCHAR(36) NULL,
    attempt INT NOT NULL DEFAULT 0,
    suggestion_count INT NOT NULL DEFAULT 0,
    tokens_used INT NOT NULL DEFAULT 0,
    model NVARCHAR(64) NULL,
    prompt_version NVARCHAR(16) NULL,
    error NVARCHAR(256) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_at DATETIME2 NULL,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ai_batch_station FOREIGN KEY (station_id) REFERENCES t_station(station_id))`,
  // v3.46：存量库补齐 element_source 来源线列（新库已由上方建表含该列，此处为幂等 no-op）。
  // 必须置于 DDL 段：下方 INDEXES 中 UQ_ai_batch_slot 新索引含 element_source，列补齐须早于索引执行
  `IF COL_LENGTH('t_ai_suggestion_batch','element_source') IS NULL ALTER TABLE t_ai_suggestion_batch ADD element_source NVARCHAR(16) NOT NULL DEFAULT 'mixed'`,
  // —— AI 建议（审前态：待审|已采纳|已否决；采纳才复刻进 t_improvement）——
  // element_ids NVARCHAR(MAX)（P1-3：防站级触发器 element_ids 击穿 256）
  // est_save_s 服务端计算（铁律②）；priority 归一化 0~100；tier P1/P2/P3（P0-2 不引入 P0）
  // verif 可验证性 1/2/3（次级排序键）；risk_flags 正交风险标记（转人工/加签，不参与打分）
  `IF OBJECT_ID('t_ai_suggestion','U') IS NULL CREATE TABLE t_ai_suggestion (
    suggestion_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    batch_id NVARCHAR(36) NOT NULL,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    version INT NOT NULL,
    element_ids NVARCHAR(MAX) NOT NULL,
    waste_type NVARCHAR(16) NOT NULL,
    method NVARCHAR(4) NOT NULL,
    action_class NVARCHAR(8) NOT NULL,
    measure NVARCHAR(256) NOT NULL,
    eliminate_basis NVARCHAR(256) NULL,
    est_save_s DECIMAL(10,2) NOT NULL,
    priority INT NOT NULL,
    tier NVARCHAR(4) NOT NULL,
    difficulty INT NOT NULL,
    verif INT NOT NULL DEFAULT 2,
    risk_flags NVARCHAR(128) NULL,
    status NVARCHAR(16) NOT NULL DEFAULT '待审',
    validation_trace NVARCHAR(MAX) NULL,
    raw_json NVARCHAR(MAX) NULL,
    reviewed_by NVARCHAR(32) NULL,
    reviewed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ai_sugg_batch FOREIGN KEY (batch_id) REFERENCES t_ai_suggestion_batch(batch_id))`,
  // —— AI 自定义字典（租户级；waste_type 必填 va_class / measure_type 必填 method_hint+action_class）——
  `IF OBJECT_ID('t_ai_custom_dict','U') IS NULL CREATE TABLE t_ai_custom_dict (
    dict_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    dict_type NVARCHAR(16) NOT NULL,
    code NVARCHAR(32) NOT NULL,
    name NVARCHAR(16) NOT NULL,
    va_class NVARCHAR(8) NULL,
    method_hint NVARCHAR(4) NULL,
    action_class NVARCHAR(8) NULL,
    alias_of NVARCHAR(32) NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'active',
    created_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ai_dict_tenant_type_code UNIQUE (tenant_id, dict_type, code))`,
  // —— AI 模块键值设置（v3.31：LLM 网关配置 UI 化存储；DB 行优先，缺失回落 .env）——
  `IF OBJECT_ID('t_ai_setting','U') IS NULL CREATE TABLE t_ai_setting (
    setting_key NVARCHAR(64) NOT NULL PRIMARY KEY,
    setting_value NVARCHAR(MAX) NOT NULL,
    updated_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // —— LLM 连接配置 profiles（v3.40：多配置，同一时刻仅一条启用；过滤唯一索引库层硬保证单活）——
  `IF OBJECT_ID('t_ai_llm_profile','U') IS NULL CREATE TABLE t_ai_llm_profile (
    profile_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    name NVARCHAR(64) NOT NULL,
    base_url NVARCHAR(256) NOT NULL,
    api_key NVARCHAR(256) NOT NULL DEFAULT '',
    model NVARCHAR(128) NOT NULL,
    enabled BIT NOT NULL DEFAULT 0,
    created_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_t_ai_llm_profile_single')
     CREATE UNIQUE INDEX UX_t_ai_llm_profile_single ON t_ai_llm_profile (enabled) WHERE enabled = 1`,
  // 回填：表为空且旧 t_ai_setting 有 llm_base_url 时，迁为「初始配置」并启用（幂等）
  `IF NOT EXISTS (SELECT 1 FROM t_ai_llm_profile) AND EXISTS (SELECT 1 FROM t_ai_setting WHERE setting_key = 'llm_base_url') BEGIN
     INSERT INTO t_ai_llm_profile (profile_id, name, base_url, api_key, model, enabled, created_by)
     SELECT LOWER(CONVERT(NVARCHAR(36), NEWID())), N'初始配置',
            (SELECT setting_value FROM t_ai_setting WHERE setting_key = 'llm_base_url'),
            ISNULL((SELECT setting_value FROM t_ai_setting WHERE setting_key = 'llm_api_key'), ''),
            ISNULL((SELECT setting_value FROM t_ai_setting WHERE setting_key = 'llm_model'), ''),
            1, 'migrate'
   END`,
  // —— P3-9 浪费识别批次（与 ai-suggest 完全独立：AI 自动分解要素的浪费识别专用，不与手工分解线共用任何表）——
  // status：running|done|done_empty|failed（无配额槽位——浪费识别按最新批次覆盖查询，历史批次只读溯源）
  `IF OBJECT_ID('t_ai_waste_batch','U') IS NULL CREATE TABLE t_ai_waste_batch (
    batch_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    version INT NOT NULL,
    user_id NVARCHAR(32) NOT NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'running',
    element_source NVARCHAR(16) NOT NULL DEFAULT 'ai_assisted',
    element_count INT NOT NULL DEFAULT 0,
    finding_count INT NOT NULL DEFAULT 0,
    issue_count INT NOT NULL DEFAULT 0,
    tokens_used INT NOT NULL DEFAULT 0,
    model NVARCHAR(64) NULL,
    prompt_version NVARCHAR(16) NULL,
    error NVARCHAR(256) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_at DATETIME2 NULL,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ai_waste_batch_station FOREIGN KEY (station_id) REFERENCES t_station(station_id))`,
  // —— P3-9 浪费点（LLM 产出；severity/involved_s/pct_of_ct 全服务端计算，LLM 禁产数字铁律继承）——
  // waste_type 动态白名单（waste_triggers ∪ ecrsa_map wastes，与 ai-suggest 同口径但独立校验实现）
  // element_refs NVARCHAR(MAX)：涉及要素 seq 逗号串（AI 要素随 submit 重排，存 seq 而非 element_id 可随版本重建对齐）
  `IF OBJECT_ID('t_ai_waste_finding','U') IS NULL CREATE TABLE t_ai_waste_finding (
    finding_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    batch_id NVARCHAR(36) NOT NULL,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    version INT NOT NULL,
    element_refs NVARCHAR(MAX) NOT NULL,
    waste_type NVARCHAR(16) NOT NULL,
    severity INT NOT NULL,
    involved_s DECIMAL(10,2) NOT NULL,
    pct_of_ct DECIMAL(5,2) NOT NULL,
    evidence NVARCHAR(256) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ai_waste_finding_batch FOREIGN KEY (batch_id) REFERENCES t_ai_waste_batch(batch_id))`,
  // —— P3-9 改善问题清单（审前态：待处理|已确认|已忽略；确认才进 t_improvement，铁律①永远待审继承）——
  // est_save_s 服务端重算（E 全额/折算同 ai-suggest 口径但独立实现）；tier P1/P2/P3 服务端归一
  `IF OBJECT_ID('t_ai_waste_issue','U') IS NULL CREATE TABLE t_ai_waste_issue (
    issue_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    batch_id NVARCHAR(36) NOT NULL,
    finding_id NVARCHAR(36) NULL,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NOT NULL,
    version INT NOT NULL,
    element_refs NVARCHAR(MAX) NOT NULL,
    waste_type NVARCHAR(16) NOT NULL,
    problem NVARCHAR(256) NOT NULL,
    ecrs NVARCHAR(4) NOT NULL,
    suggestion NVARCHAR(256) NOT NULL,
    est_save_s DECIMAL(10,2) NOT NULL,
    priority INT NOT NULL,
    tier NVARCHAR(4) NOT NULL,
    status NVARCHAR(16) NOT NULL DEFAULT '待处理',
    validation_trace NVARCHAR(MAX) NULL,
    imp_id NVARCHAR(64) NULL,
    reviewed_by NVARCHAR(32) NULL,
    reviewed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ai_waste_issue_batch FOREIGN KEY (batch_id) REFERENCES t_ai_waste_batch(batch_id))`,
  // —— 正式 AI 业务逐次 HTTP 调用用量（不含 prompt/响应/API Key；NULL Token=上游未报告）——
  `IF OBJECT_ID('t_ai_usage_event','U') IS NULL CREATE TABLE t_ai_usage_event (
    usage_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL,
    feature NVARCHAR(32) NOT NULL,
    purpose NVARCHAR(16) NOT NULL DEFAULT 'business',
    batch_id NVARCHAR(36) NOT NULL,
    user_id NVARCHAR(32) NOT NULL,
    station_id NVARCHAR(32) NOT NULL,
    line_id NVARCHAR(32) NOT NULL,
    provider NVARCHAR(32) NOT NULL,
    model NVARCHAR(128) NOT NULL,
    attempt_no INT NOT NULL DEFAULT 1,
    internal_retry INT NOT NULL DEFAULT 0,
    request_id NVARCHAR(128) NULL,
    status NVARCHAR(16) NOT NULL,
    http_status INT NULL,
    latency_ms INT NOT NULL,
    error_code NVARCHAR(64) NULL,
    prompt_tokens INT NULL,
    completion_tokens INT NULL,
    total_tokens INT NULL,
    cached_tokens INT NULL,
    usage_status NVARCHAR(16) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
];

/** 存量库幂等升级（DDL 仅对新建库生效；老库需下列 ALTER 补齐增量） */
const MIGRATIONS: string[] = [
  // v3.1：t_user 增加 email 列
  `IF COL_LENGTH('t_user','email') IS NULL ALTER TABLE t_user ADD email NVARCHAR(128) NULL`,
  // v3.1：username 由租户内唯一改为全局唯一（存量无跨租户重名时安全；执行前已由迁移前检查保证）
  `IF OBJECT_ID('UQ_user_tenant_username','UQ') IS NOT NULL ALTER TABLE t_user DROP CONSTRAINT UQ_user_tenant_username`,
  `IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_user_username' AND parent_object_id = OBJECT_ID('t_user'))
   ALTER TABLE t_user ADD CONSTRAINT UQ_user_username UNIQUE (username)`,
  // v3.3：t_tenant 增加 region 列（区域维度挂公司；按区域汇总 = GROUP BY tenant.region）
  `IF COL_LENGTH('t_tenant','region') IS NULL ALTER TABLE t_tenant ADD region NVARCHAR(32) NOT NULL DEFAULT '总部'`,
  // v3.3：t_improvement 增加 project_type 列（项目类型维度：NPI导入|量产改善|自动化改造|布局优化|质量改善）
  `IF COL_LENGTH('t_improvement','project_type') IS NULL ALTER TABLE t_improvement ADD project_type NVARCHAR(32) NOT NULL DEFAULT '量产改善'`,
  // v3.3：project_type 索引（须在 ALTER 之后建，故放 MIGRATIONS 而非 INDEXES）
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_imp_project_type') CREATE INDEX idx_imp_project_type ON t_improvement (tenant_id, project_type, status)`,
  // v3.3：t_line 存量回填（工位反推；DISTINCT + NOT EXISTS 保证幂等，不覆盖已有记录）
  `IF OBJECT_ID('t_line','U') IS NOT NULL
   INSERT INTO t_line (tenant_id, line_id, name, process_type, product_type, product_project, created_at)
   SELECT DISTINCT s.tenant_id, s.line_id, s.line_id, '装配', '待补充', '-', SYSUTCDATETIME()
   FROM t_station s
   WHERE NOT EXISTS (SELECT 1 FROM t_line l WHERE l.tenant_id = s.tenant_id AND l.line_id = s.line_id)`,
  // v3.21：CMC 产能系统集成——工位/产线记录 CMC 来源（基础信息以 CMC 为准，本地只存快照+关联键）
  //  t_station.program_number：CMC 项目号（cbco_records.program_number），驾驶舱"产品项目"维度数据源
  //  t_station.cmc_line_id：CMC 产线主键（production_lines.id），反查/对账用
  //  t_line.cmc_line_id / factory_code：CMC 产线主键 + 工厂码，快照刷新按此关联
  `IF COL_LENGTH('t_station','program_number') IS NULL ALTER TABLE t_station ADD program_number NVARCHAR(32) NULL`,
  `IF COL_LENGTH('t_station','cmc_line_id') IS NULL ALTER TABLE t_station ADD cmc_line_id INT NULL`,
  `IF COL_LENGTH('t_line','cmc_line_id') IS NULL ALTER TABLE t_line ADD cmc_line_id INT NULL`,
  `IF COL_LENGTH('t_line','factory_code') IS NULL ALTER TABLE t_line ADD factory_code NVARCHAR(32) NULL`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_station_program') CREATE INDEX idx_station_program ON t_station (tenant_id, program_number)`,
  // v3.30：AI 改善建议模块——配额（t_user 两列：0=禁用 / -1=无限 / N=次数）
  `IF COL_LENGTH('t_user','ai_quota') IS NULL ALTER TABLE t_user ADD ai_quota INT NOT NULL DEFAULT 1`,
  `IF COL_LENGTH('t_user','ai_quota_used') IS NULL ALTER TABLE t_user ADD ai_quota_used INT NOT NULL DEFAULT 0`,
  // v3.30：t_improvement 溯源（source='rule'|'ai'；ai_suggestion_id 反查 t_ai_suggestion）
  `IF COL_LENGTH('t_improvement','source') IS NULL ALTER TABLE t_improvement ADD source NVARCHAR(16) NOT NULL DEFAULT 'rule'`,
  `IF COL_LENGTH('t_improvement','ai_suggestion_id') IS NULL ALTER TABLE t_improvement ADD ai_suggestion_id NVARCHAR(36) NULL`,
  // v3.33：t_element 来源溯源（source='manual'|'ai_assisted'，供 AI 采纳率统计；候选不入库，接受后落此列）
  `IF COL_LENGTH('t_element','source') IS NULL ALTER TABLE t_element ADD source NVARCHAR(16) NOT NULL DEFAULT 'manual'`,
  // v3.42：工位归属与协作（方案 A）——owner_user_id 归属人；存量一律归 created_by（用户决策 #4，无例外）
  `IF COL_LENGTH('t_station','owner_user_id') IS NULL ALTER TABLE t_station ADD owner_user_id NVARCHAR(32) NULL`,
  `IF OBJECT_ID('t_station','U') IS NOT NULL AND COL_LENGTH('t_station','owner_user_id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = OBJECT_ID('t_station') AND c.name = 'owner_user_id' AND c.is_nullable = 0)
   UPDATE t_station SET owner_user_id = created_by WHERE owner_user_id IS NULL`,
  // v3.42：同名工位区分——唯一键落 (tenant_id, owner_user_id, name)，允许跨用户同名
  `IF OBJECT_ID('t_station','U') IS NOT NULL AND COL_LENGTH('t_station','owner_user_id') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_station_owner_name' AND parent_object_id = OBJECT_ID('t_station'))
   ALTER TABLE t_station ADD CONSTRAINT UQ_station_owner_name UNIQUE (tenant_id, owner_user_id, name)`,
  // v3.42：工位协作者（工位级 ACL 授权）+ 产线级批量授权（grantor 名下该线现有+未来工位共享给 grantee）
  `IF OBJECT_ID('t_station_collaborator','U') IS NULL CREATE TABLE t_station_collaborator (
    station_id NVARCHAR(32) NOT NULL,
    user_id NVARCHAR(32) NOT NULL,
    acl_role NVARCHAR(16) NOT NULL,
    granted_by NVARCHAR(32) NULL,
    granted_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_t_station_collaborator PRIMARY KEY (station_id, user_id),
    CONSTRAINT FK_stcoll_station FOREIGN KEY (station_id) REFERENCES t_station(station_id))`,
  `IF OBJECT_ID('t_line_share','U') IS NULL CREATE TABLE t_line_share (
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    line_id NVARCHAR(32) NOT NULL,
    grantor_user_id NVARCHAR(32) NOT NULL,
    grantee_user_id NVARCHAR(32) NOT NULL,
    acl_role NVARCHAR(16) NOT NULL,
    granted_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_t_line_share PRIMARY KEY (tenant_id, line_id, grantor_user_id, grantee_user_id))`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_line_share_grantee') CREATE INDEX idx_line_share_grantee ON t_line_share (tenant_id, grantee_user_id)`,
  // v3.43：AI 分解操作区 ROI 逐工位标定（归一化 JSON {"x","y","w","h"}；null=未标定用内置默认）
  `IF COL_LENGTH('t_station','roi') IS NULL ALTER TABLE t_station ADD roi NVARCHAR(64) NULL`,
  // v3.44 P2-1：ROI 功能区子区（HOI 对象层）——JSON 数组 [{"name":"扫码枪卡位","x":..,"y":..,"w":..,"h":..}]，
  // 坐标相对操作区 ROI（ROI 内再划功能子区，行业手段分析 §一.3 手段①③）；null=未配置（HOI 静默关闭）
  `IF COL_LENGTH('t_station','roi_zones') IS NULL ALTER TABLE t_station ADD roi_zones NVARCHAR(MAX) NULL`,
  // v3.44 P2-2：SOP 期望步骤序列（封闭词表自动命名）——JSON 数组 [{"verb":"拿取","object":"后横梁"}]，
  // verb 必须 ∈ motion_standard 词表（服务端 RulesService 校验）；null=未配置
  `IF COL_LENGTH('t_station','sop_steps') IS NULL ALTER TABLE t_station ADD sop_steps NVARCHAR(MAX) NULL`,

  // —— v3.50：用户与权限中心（RBAC 治理柱）——
  // 人员档案：部门 / 岗位 / 工号（对应行业软件「多站点 + 组织维度」的人员主数据）
  `IF COL_LENGTH('t_user','department') IS NULL ALTER TABLE t_user ADD department NVARCHAR(64) NULL`,
  `IF COL_LENGTH('t_user','position') IS NULL ALTER TABLE t_user ADD position NVARCHAR(64) NULL`,
  `IF COL_LENGTH('t_user','employee_no') IS NULL ALTER TABLE t_user ADD employee_no NVARCHAR(32) NULL`,
  // 数据范围（RBAC 之外的行级范围）：own=仅本人创建 / line=本产线 / tenant=本租户 / all=全集团
  `IF COL_LENGTH('t_user','data_scope') IS NULL ALTER TABLE t_user ADD data_scope NVARCHAR(16) NOT NULL DEFAULT 'own'`,
  // 方法资质（借鉴 MTM Blue Card / MOST 分级认证：等级 + 有效期，到期需复训再认证）
  `IF COL_LENGTH('t_user','cert_level') IS NULL ALTER TABLE t_user ADD cert_level NVARCHAR(16) NULL`,
  `IF COL_LENGTH('t_user','cert_expires_at') IS NULL ALTER TABLE t_user ADD cert_expires_at DATETIME2 NULL`,
  // 角色说明（自定义角色用途标注，便于交接与审计追溯）
  `IF COL_LENGTH('t_role','description') IS NULL ALTER TABLE t_role ADD description NVARCHAR(128) NULL`,

  // —— v3.51：人工浪费识别与改善建议（与 AI 生成并存）+ 改善知识库 ——
  // origin：ai=LLM 识别产出（既有行默认，契约零改动）/ manual=人工录入。
  // 人工条目不隶属任何批次（batch_id 放宽可空），与 AI 批次条目同表并存，查询按 origin 过滤。
  // AI 服务关闭或模型产出被 W1-W3 全量剔除时，人工录入 + 历史批次查询是本模块的有效兜底路径。
  `IF COL_LENGTH('t_ai_waste_finding','origin') IS NULL ALTER TABLE t_ai_waste_finding ADD origin NVARCHAR(16) NOT NULL DEFAULT 'ai'`,
  `IF COL_LENGTH('t_ai_waste_finding','created_by') IS NULL ALTER TABLE t_ai_waste_finding ADD created_by NVARCHAR(32) NULL`,
  `IF COL_LENGTH('t_ai_waste_finding','updated_at') IS NULL ALTER TABLE t_ai_waste_finding ADD updated_at DATETIME2 NULL`,
  `IF COL_LENGTH('t_ai_waste_finding','batch_id') IS NOT NULL ALTER TABLE t_ai_waste_finding ALTER COLUMN batch_id NVARCHAR(36) NULL`,
  // v3.57：route 路由（finding=确定性命中计收益 / pool=待标定观察项仍进清单、est 不计值）
  `IF COL_LENGTH('t_ai_waste_finding','route') IS NULL ALTER TABLE t_ai_waste_finding ADD route NVARCHAR(16) NOT NULL DEFAULT 'finding'`,
  `IF COL_LENGTH('t_ai_waste_issue','origin') IS NULL ALTER TABLE t_ai_waste_issue ADD origin NVARCHAR(16) NOT NULL DEFAULT 'ai'`,
  `IF COL_LENGTH('t_ai_waste_issue','created_by') IS NULL ALTER TABLE t_ai_waste_issue ADD created_by NVARCHAR(32) NULL`,
  `IF COL_LENGTH('t_ai_waste_issue','updated_at') IS NULL ALTER TABLE t_ai_waste_issue ADD updated_at DATETIME2 NULL`,
  `IF COL_LENGTH('t_ai_waste_issue','batch_id') IS NOT NULL ALTER TABLE t_ai_waste_issue ALTER COLUMN batch_id NVARCHAR(36) NULL`,
  // 知识库（人工录入 + 已确认 AI 条目沉淀；后续 AI 识别按 waste_type/关键词检索注入 prompt）
  // station_id 可空 = 跨工位通用经验；kind：finding=浪费识别 / issue=改善措施
  // source_ref 溯源原条目（重复整理按 UQ_ai_waste_kb_ref 幂等更新，不产生重复行）
  `IF OBJECT_ID('t_ai_waste_kb','U') IS NULL CREATE TABLE t_ai_waste_kb (
    kb_id NVARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    station_id NVARCHAR(32) NULL,
    kind NVARCHAR(8) NOT NULL,
    waste_type NVARCHAR(16) NOT NULL,
    ecrs NVARCHAR(4) NULL,
    problem NVARCHAR(256) NULL,
    suggestion NVARCHAR(256) NULL,
    evidence NVARCHAR(256) NULL,
    keywords NVARCHAR(256) NULL,
    element_types NVARCHAR(256) NULL,
    source_origin NVARCHAR(16) NOT NULL DEFAULT 'manual',
    source_ref NVARCHAR(36) NULL,
    hit_count INT NOT NULL DEFAULT 0,
    last_hit_at DATETIME2 NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'active',
    created_by NVARCHAR(32) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME())`,
  // 检索主索引 + 溯源去重（过滤索引：source_ref 非空才唯一）+ 清单按工位/来源查询
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_waste_kb_lookup') CREATE INDEX idx_ai_waste_kb_lookup ON t_ai_waste_kb (tenant_id, status, waste_type)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ai_waste_kb_ref') CREATE UNIQUE INDEX UQ_ai_waste_kb_ref ON t_ai_waste_kb (source_ref, kind) WHERE source_ref IS NOT NULL`,
  `IF COL_LENGTH('t_ai_waste_kb','embedding') IS NULL ALTER TABLE t_ai_waste_kb ADD embedding NVARCHAR(MAX) NULL`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_waste_finding_station_origin') CREATE INDEX idx_ai_waste_finding_station_origin ON t_ai_waste_finding (tenant_id, station_id, origin)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_waste_issue_station_origin') CREATE INDEX idx_ai_waste_issue_station_origin ON t_ai_waste_issue (tenant_id, station_id, origin)`,
];

const INDEXES: string[] = [
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_element_tenant_ver') CREATE INDEX idx_element_tenant_ver ON t_element (tenant_id, station_id, bol_version)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_element_station') CREATE INDEX idx_element_station ON t_element (tenant_id, station_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_station_line') CREATE INDEX idx_station_line ON t_station (tenant_id, line_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_imp_station_status') CREATE INDEX idx_imp_station_status ON t_improvement (tenant_id, station_id, status)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_task_pending') CREATE INDEX idx_ai_task_pending ON t_ai_task (status, created_at)`,
  // SPEC-VID-P0 §3：派生幂等唯一键（同 file_name+kind 只允许一行；重复 derive 不重转）
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_video_derivative_file_kind') CREATE UNIQUE INDEX UQ_video_derivative_file_kind ON t_video_derivative (file_name, kind)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_user') CREATE INDEX idx_audit_user ON t_audit_log (tenant_id, user_id, created_at)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_password_reset_user') CREATE INDEX idx_password_reset_user ON t_password_reset (user_id, used, expires_at)`,
  // v3.30：AI 批次——槽位唯一过滤索引（普通用户 is_unlimited=0；超管绕过）+ 缓存命中索引
  // mssql 过滤索引语法；sqlite 方言在 ai-suggest 模块内以 CREATE UNIQUE INDEX + 部分索引实现
  // v3.46：槽位按来源线隔离（element_source 入唯一键）——存量库需先删旧索引再建含 source 的新索引；
  // 存量行 element_source 默认全为 'mixed'，删旧建新后唯一性语义保持不变
  `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ai_batch_slot' AND object_id = OBJECT_ID('t_ai_suggestion_batch')) DROP INDEX UQ_ai_batch_slot ON t_ai_suggestion_batch`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ai_batch_slot' AND object_id = OBJECT_ID('t_ai_suggestion_batch')) CREATE UNIQUE INDEX UQ_ai_batch_slot ON t_ai_suggestion_batch (tenant_id, station_id, version, user_id, element_source) WHERE is_unlimited = 0`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_batch_cache') CREATE INDEX idx_ai_batch_cache ON t_ai_suggestion_batch (tenant_id, station_id, version, input_hash)`,
  // P3-9：浪费识别批次按工位查询 + 批次明细查询
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_waste_batch_station') CREATE INDEX idx_ai_waste_batch_station ON t_ai_waste_batch (tenant_id, station_id, created_at)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_waste_issue_batch') CREATE INDEX idx_ai_waste_issue_batch ON t_ai_waste_issue (batch_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_usage_tenant_time') CREATE INDEX idx_ai_usage_tenant_time ON t_ai_usage_event (tenant_id, created_at)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_usage_station_time') CREATE INDEX idx_ai_usage_station_time ON t_ai_usage_event (tenant_id, station_id, created_at)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_usage_user_time') CREATE INDEX idx_ai_usage_user_time ON t_ai_usage_event (tenant_id, user_id, created_at)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ai_usage_batch') CREATE INDEX idx_ai_usage_batch ON t_ai_usage_event (batch_id)`,
];

async function main() {
  const cfg = loadConfig();
  if (cfg.dbType !== 'mssql') {
    console.error(' migrate 仅用于 mssql；开发库 sqlite 由 synchronize 自动建表');
    process.exit(1);
  }
  const conn = await createConnection({
    type: 'mssql',
    host: cfg.dbHost,
    port: cfg.dbPort,
    username: cfg.dbUser,
    password: cfg.dbPass,
    database: cfg.dbName,
    options: { encrypt: cfg.dbEncrypt, trustServerCertificate: true },
  });
  for (const sql of [...DDL, ...INDEXES]) {
    await conn.query(sql);
  }
  for (const sql of MIGRATIONS) {
    await conn.query(sql);
  }
  console.log(`SQL Server 迁移完成：${DDL.length} 表 + ${INDEXES.length} 索引 + ${MIGRATIONS.length} 项存量升级（库 ${cfg.dbName}@${cfg.dbHost}）`);
  await conn.destroy();
}

main().catch((e) => { console.error('迁移失败:', e.message); process.exit(1); });
