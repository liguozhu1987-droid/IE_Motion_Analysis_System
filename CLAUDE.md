# CLAUDE.md · IE Motion Analysis System

> 本文件是**最高优先级的项目硬性规则**。与 `AGENT必读.md`、`deliverables/*`、`docs/*` 或任何历史说明冲突时，以本文件为准。
> 生效日期：2026-11-20。修改本文件必须由用户明确书面同意。

---

## 1. 数据库操作硬性规则（生产环境）

### 1.1 唯一允许的连接目标

| 项 | 值 |
|---|---|
| SQL Server 地址 | `IRSCNYTFINEREPORT.ap.inalfa.local` |
| 端口 | `1433` |
| 数据库 | `CN_AME` |
| 登录账号 | `publicUser` |
| 口令 | **只允许存放在 `app/api/.env`（已在 gitignore 中）**；禁止写入 `CLAUDE.md`、`AGENT必读.md`、`.env.example`、代码、日志、提交记录、聊天记录或任何受版本控制的文件 |
| 连接方式 | `DB_TYPE=mssql`、`DB_ENCRYPT=false`（内网） |

### 1.2 写入/建表范围（DDL + DML）

**只允许**在 `CN_AME` 数据库内、对下列 **30 张本系统表**执行建表、改表、写入、删除：

```
t_tenant                 t_user                    t_role
t_permission             t_user_role               t_role_permission
t_refresh_token          t_password_reset          t_rule_set
t_project                t_line                    t_station
t_station_collaborator   t_line_share              t_element
t_improvement            t_video_asset             t_video_derivative
t_ai_task                t_ai_suggestion_batch     t_ai_suggestion
t_ai_custom_dict         t_ai_setting              t_ai_llm_profile
t_ai_waste_batch         t_ai_waste_finding        t_ai_waste_issue
t_ai_waste_kb            t_ai_usage_event          t_audit_log
```

**禁止**：

- 对任何**其他数据库**执行 `CREATE / ALTER / DROP / TRUNCATE / INSERT / UPDATE / DELETE / MERGE`。
- 对 `CN_AME` 内**上述 30 张表以外**的任何表执行写入或 DDL（包括 `CN_AME_SSO_*`、CMC 表、任何第三方表）。
- `CREATE DATABASE`、`ALTER DATABASE`、`DROP DATABASE`、`USE <非 CN_AME 库>`。
- 链接服务器、`OPENROWSET`、`OPENQUERY`、`xp_cmdshell`、`sp_addlinkedserver`。
- 通过动态 SQL / 变量拼接绕过上述限制。
- 新增数据表：**必须先更新本文件的白名单并经用户书面同意**，否则不得落地。

### 1.3 只读例外（明确授权）

以下访问**只允许 SELECT，永远禁止任何写/DDL**：

| 对象 | 用途 | 限制 |
|---|---|---|
| `CMC.dbo.factories`、`CMC.dbo.production_lines`、`CMC.dbo.cbco_records`、`CMC.dbo.project_line_allocations` | CMC 产能系统集成：工厂/产线/项目/分配关系 | 同实例跨库只读；失败时降级，不得伪造数据、不得回写 CMC |
| `CN_AME_SSO_User`、`CN_AME_SSO_UserMap` | 统一身份认证映射 | 仅在 `AUTH_OIDC_ENABLED=true` 时读取；默认关闭；**只读** |
| `CN_AME` 内的 `sys.*` 系统目录 | 幂等建表/升级的存在性判断 | 只读元数据，不得改写 |

> CMC 只读是本项目**唯一**的跨库访问例外。除上表外，数据库代码中不得出现任何其他 `库名.schema.表名` 形式的三段式引用。

### 1.4 凭据与最小权限

- `publicUser` 若在服务器上拥有超出 `CN_AME` 的权限，**应用层仍不得使用**；权限宽不等于操作许可。
- 建表需要 `CN_AME` 内的 DDL 权限；若 `publicUser` 无此权限，停下来找 DBA 在 `CN_AME` 内授权，**不得换用其他库或其他账号绕过**。
- 口令轮换后只改 `app/api/.env`；禁止把新口令同步进任何文档。
- 一旦口令进入受版本控制的文件或日志，视为泄露，必须立即轮换并向用户报告。

### 1.5 布署与升级的强制流程

1. `npm run migrate:prod`（只创建/升级上述 30 张表，幂等）。
2. 手工执行 `deploy/sql/manual/2026-11-06-auth-sso.sql`（只改 `t_user` / `t_refresh_token`）。
3. 手工执行 `deploy/sql/manual/2026-11-06-video-retention.sql`（只改 `t_video_asset`）。
4. `npm run seed`（只写上述 30 张表）。
5. 任何新增 SQL 脚本必须放在 `deploy/sql/manual/` 并在本文件登记其目标表。

### 1.6 强制校验

提交或部署前必须执行：

```bash
npm run ops:db-scope-check
```

该脚本会检查：

- `migrate.ts` 与手工 SQL 中出现的建表/写表语句是否全部命中 30 张白名单；
- 是否存在跨库写、`CREATE/ALTER/DROP DATABASE`、`USE` 其他库、链接服务器/`OPENROWSET` 等；
- `app/api/.env` 在生产模式下是否确实指向 `CN_AME@IRSCNYTFINEREPORT.ap.inalfa.local`、账号 `publicUser`。

校验失败 = 禁止部署；不得以“只是测试”“只是临时”为理由跳过。

---

## 2. 代码与运行约束（与数据库规则相关）

- 生产 `NODE_ENV=production` 时 TypeORM `synchronize=false`：表结构只能来自 `migrate.ts` 与手工 SQL，**禁止靠同步自动建表**。
- 生产数据库连接配置一律来自 `app/api/.env`；代码中不得硬编码其他 SQL Server 地址/库名/账号。
- 任何新增实体必须先落 `migrate.ts` 的幂等 DDL、加入 30 表白名单、再更新本文件；三者缺一不可。
- CMC 查询保持 SELECT-only；不得引入 CMC 的物化同步表（会形成跨库写）。
- 不启用 OIDC 时不读取 `CN_AME_SSO_*`；启用 OIDC 需先取得用户书面同意，并确认只读。

---

## 3. 已知与本规则相关的实现事实

- `migrate.ts` 不包含 `t_user.auth_source`、`t_refresh_token.source`、`t_video_asset` 的 5 个保留列；这些列由 1.5 的两个手工 SQL 补齐。**只跑 migrate 会导致登录和视频模块失败。**
- 默认 `DB_NAME` 在代码中是 `IEPlatform`，不是 `CN_AME`；因此 `.env` 必须显式写 `DB_NAME=CN_AME` 与上面的地址/账号。
- 代码启动时会预热 `CMC.dbo.factories`；CMC 不可达只 warn，不阻塞启动。该查询属于 1.3 允许的只读例外。
