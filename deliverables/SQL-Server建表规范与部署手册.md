# SQL Server 建表规范与部署手册

> IE 改善平台 · 目标架构（NestJS + TypeORM + SQL Server）
> 版本：v1.0 ｜ 2026-10-22 ｜ 配套代码：`app/api/`（实体 `src/entities/`、迁移 `scripts/migrate.ts`、种子 `scripts/seed.ts`）
> 本次落地库：**CN_AME@localhost**（SQL Server，sa 账户，配置见 `app/api/.env`）

---

## 1. 总则

1. **配置单一事实来源 = `.env` 文件**。所有入口（`main.ts` / `scripts/migrate.ts` / `scripts/seed.ts` / `test/smoke.ts`）首行均 `import 'dotenv/config'`，不允许散落的环境变量或硬编码连接串。`.env` 已列入 `.gitignore`，仓库只保留 `.env.example` 模板。
2. **建表唯一入口 = `scripts/migrate.ts`**（幂等 DDL，`IF OBJECT_ID(...) IS NULL` 保护，可重复执行）。生产模式 `NODE_ENV=production` 下 TypeORM `synchronize=false`，表结构只认迁移脚本，杜绝运行时自动改表。
3. **实体与 DDL 一一对应**：`src/entities/*.entity.ts` 是 ORM 视角的唯一权威，DDL 是其 SQL 投影；任一侧变更必须同步另一侧，并在冒烟测试中验证。
4. 本次已在 **CN_AME** 完成：13 张表 + 10 个外键 + 6 个非唯一索引 + 种子数据（5 用户 / 10 角色 / 23 权限 / 5 组规则 / 3 演示工位），**137 项冒烟全绿**（详见 §6）。

---

## 2. 配置规范（.env）

| 分组 | 变量 | 本次取值 | 说明 |
|---|---|---|---|
| 运行时 | `NODE_ENV` | `production` | 生产；`synchronize=false`，JWT 占位符 fail-fast |
| | `PORT` | `3001` | 仅绑 `127.0.0.1`，对外由 IIS ARR 反代 |
| | `ORIGIN` | `http://localhost:5173` | CORS 白名单（逗号分隔多源） |
| 数据库 | `DB_TYPE` | `mssql` | `sqlite` 为开发演示（零依赖单文件） |
| | `DB_HOST` / `DB_PORT` | `localhost` / `1433` | SQL Server 实例 |
| | `DB_NAME` | `CN_AME` | 目标库（不存在时需先建库） |
| | `DB_USER` / `DB_PASS` | `sa` / （见 .env） | 生产建议改用最小权限应用账户 |
| | `DB_ENCRYPT` | `false` | 本机内网；跨网段启用并配证书 |
| | `DB_POOL_MAX` | `20` | 连接池上限 |
| JWT | `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | （.env，32 字节随机 hex） | 两串必须不同；生产禁 `dev-` 前缀 |
| | `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `7d` | access 短签 + refresh 轮换 |
| 登录 | `LOGIN_MAX_FAIL` / `LOGIN_LOCK_MIN` | `5` / `15` | 连错锁定 |
| AI | `AI_ENABLED` | `false` | 内网 vLLM 就绪后置 true 并填 `AI_BASE_URL`/`AI_KEY`/`AI_MODEL` |
| 其他 | `RULES_DIR` | `../config/rules` | 规则 JSON 双源之一（文件源） |
| | `LOG_DIR` | `./logs` | 运行日志目录 |

生成 JWT 密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`（两串）。

---

## 3. 建表规范（统一命名规则）

### 3.1 命名总则

| 对象 | 规则 | 示例 |
|---|---|---|
| 表名 | `t_` + 模块_实体，snake_case **单数** | `t_station`、`t_element`、`t_improvement` |
| 主键 | `<实体>_id`，NVARCHAR(32/36/48)，**业务自然键、无代理自增列** | `station_id`、`element_id`、`imp_id` |
| 外键列 | `<关联实体>_id`，与父表主键同类型同长度 | `station_id` → `t_station.station_id` |
| 租户列 | 业务表一律 `tenant_id NVARCHAR(32) NOT NULL DEFAULT 'DEFAULT'` | 行级隔离依赖此列（BaseRepository 强制附加） |
| 时间列 | `created_at` / `updated_at`，`DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()`（UTC） | 审计与排序统一口径 |
| 标志列 | 布尔语义一律 `INT 0/1`（SQL Server 无统一 bool 语义） | `outlier_flag`、`is_active`、`is_frozen`、`revoked` |
| 度量列 | 时长/金额 `DECIMAL(10,2)`；评比系数 `DECIMAL(4,2)` | `std_time`、`ct`、`est_save_s`、`rating` |
| 长文本 | JSON / 规则原文 `NVARCHAR(MAX)`；描述类限定长度 | `content`、`input_json`、`[desc] NVARCHAR(120)` |
| 保留字 | `desc` 为 SQL 保留字：实体由 TypeORM 按方言转义，**裸 SQL 必须 `[desc]`** | DDL 中 `[desc] NVARCHAR(120)` |
| 主键约束 | `PK_<表>`（仅复合主键命名；单列主键内联） | `PK_t_user_role`、`PK_t_role_permission` |
| 唯一约束 | `UQ_<表>_<列…>` | `UQ_user_tenant_username`、`UQ_element_tenant_ver_seq`、`UQ_permission_code` |
| 外键约束 | `FK_<表>_<关联实体>` | `FK_t_element_station`、`FK_t_user_tenant` |
| 索引 | `idx_<表>_<列…>`，非唯一非聚集，覆盖租户过滤列 | `idx_element_tenant_ver`、`idx_station_line` |

### 3.2 表清单（13 张）

| # | 表 | 用途 | 租户列 | 备注 |
|---|---|---|---|---|
| 1 | `t_tenant` | 租户（法人/事业部） | —（本表即租户） | 种子：DEFAULT / OTHER |
| 2 | `t_user` | 用户、口令哈希、登录锁定 | ✅ | `UQ_user_tenant_username` 同租户用户名唯一 |
| 3 | `t_role` | 角色（按租户隔离） | ✅ | `is_system=1` 系统角色不可删 |
| 4 | `t_permission` | 权限点字典（系统级 23 个） | — | `UQ_permission_code` |
| 5 | `t_user_role` | 用户-角色关联 | — | 复合主键 + 双外键 |
| 6 | `t_role_permission` | 角色-权限关联 | — | 复合主键 + 双外键 |
| 7 | `t_refresh_token` | Refresh 轮换 + 重放检测 | — | `replaced_by` 追溯轮换链 |
| 8 | `t_rule_set` | 规则库入库（5 组 RV1.0 JSON） | — | 每 code 仅一条 `is_active=1`，发布=插入+切换 |
| 9 | `t_ai_task` | AI 任务队列（无 Redis） | ✅ | `status` pending→running→done/failed |
| 10 | `t_audit_log` | 写操作审计（保留 2 年） | ✅ | **不建外键**：用户注销后审计必须留存 |
| 11 | `t_station` | 工位；`version`=生效 bol_version 指针 | ✅ | 封存=指针推进，旧版数据不动 |
| 12 | `t_element` | BOL 核心表（16 字段 + tenant_id） | ✅ | `UQ_element_tenant_ver_seq` 防同版同序重复 |
| 13 | `t_improvement` | 改善建议（三态流转） | ✅ | `after_ct` 由系统回填，前端不可写 |

### 3.3 外键清单（10 个，与实体 `@ManyToOne` 声明一致）

```
t_user.tenant_id            → t_tenant.tenant_id      (FK_t_user_tenant)
t_role.tenant_id            → t_tenant.tenant_id      (FK_t_role_tenant)
t_station.tenant_id         → t_tenant.tenant_id      (FK_t_station_tenant)
t_element.station_id        → t_station.station_id    (FK_t_element_station)
t_improvement.station_id    → t_station.station_id    (FK_t_improvement_station)
t_refresh_token.user_id     → t_user.user_id          (FK_t_refresh_token_user)
t_user_role.user_id         → t_user.user_id          (FK_t_user_role_user)
t_user_role.role_id         → t_role.role_id          (FK_t_user_role_role)
t_role_permission.role_id   → t_role.role_id          (FK_t_role_permission_role)
t_role_permission.perm_id   → t_permission.perm_id    (FK_t_role_permission_perm)
```

> 外键纪律：删数据必须**先子表后主表**（如清理工位：t_element → t_improvement → t_station）；
> 开发库 sqlite 由 TypeORM 按实体自动建同名关系，与生产 DDL 行为一致。

### 3.4 索引清单（6 个）

| 索引 | 表 | 列 | 服务场景 |
|---|---|---|---|
| `idx_element_tenant_ver` | t_element | (tenant_id, station_id, bol_version) | 按工位+版本取分解 |
| `idx_element_station` | t_element | (tenant_id, station_id) | 版本清单/计数 |
| `idx_station_line` | t_station | (tenant_id, line_id) | 产线山积图 |
| `idx_imp_station_status` | t_improvement | (tenant_id, station_id, status) | 建议清单过滤 |
| `idx_ai_task_pending` | t_ai_task | (status, created_at) | 队列 worker 取待办 |
| `idx_audit_user` | t_audit_log | (tenant_id, user_id, created_at) | 审计检索 |

---

## 4. 部署步骤（CN_AME 实操顺序）

```bash
# 0) 配置：复制 .env.example 为 .env，填入 DB_HOST/DB_USER/DB_PASS/DB_NAME 与 JWT 密钥
cd app/api && npm install && npm run build

# 1) 建表（幂等；CN_AME 需已存在——不存在时先用 sa 连 master 执行 CREATE DATABASE CN_AME）
npm run migrate:prod
#    输出：SQL Server 迁移完成：13 表 + 6 索引（库 CN_AME@localhost）

# 2) 种子（生产模式 synchronize=false，依赖第 1 步已建表）
npm run seed
#    输出：种子完成：用户5 / 角色10 / 权限23 / 规则入库5组 / 工位3

# 3) 启动（读 .env；仅回环 127.0.0.1:3001，Windows Server 上由 IIS ARR 反代对外）
npm start

# 4) 验证（137 项冒烟，直接打生产库）
npm run smoke
```

> 重复执行第 1 步安全（IF OBJECT_ID 保护）；第 2 步幂等（已存在则跳过）。
> 默认账号 `admin`（系统管理员）/ `ie1` / `leader1` / `viewer1` / `other1`，口令 `123456`，首次登录强制改密。

---

## 5. 与旧环境的差异处理

| 项 | sqlite（开发） | SQL Server（生产） | 处理 |
|---|---|---|---|
| 建表方式 | `synchronize=true` 自动 | 迁移脚本 DDL | DDL 与实体逐列对齐 |
| 保留字 `desc` | `"desc"` 双引号 | `[desc]` 方括号 | TypeORM 自动转义；裸 SQL 手工 |
| 事务 | 单连接串行锁（BaseRepository.transaction） | 连接池真并发 | 同一事务 API，无需改动 |
| 清理测试数据 | node:sqlite 直连 | mssql 驱动直连 | 冒烟 cleanStation 双实现 |
| 审计校验 | 直连查表 | 直连查表 | 冒烟双分支，均真校验 |

---

## 6. 本次验证证据（2026-10-22）

- **连通性**：localhost:1433 / sa / CN_AME 连接成功（SQL Server 17.0.1000.7）；CN_AME 原为空库，按规范全量建表。
- **迁移输出**：`SQL Server 迁移完成：13 表 + 6 索引（库 CN_AME@localhost）`；库内复核：表 13、外键 10（命名全部符合 `FK_t_*`）、自定义非唯一索引 6。
- **种子输出**：用户 5 / 角色 10 / 权限 23 / 规则入库 5 组 / 工位 3。
- **冒烟**：`137 通过 / 0 失败`，连续两轮稳定（认证/锁定/RBAC 403/租户双向隔离/规则双源/AI 降级/参数发布/审计直连校验/要素 V1-V3/写守卫/CSV/VA 改判/分析引擎/三层配对/收益 18779.25 元/红线 422/三态流转/建议书报告）。
- **生产启动**：`npm start`（NODE_ENV=production + mssql）启动成功；实测登录签发 accessToken、工位列表、建议生成端点均正常。
- **精度**：DECIMAL(10,2) 往返实测 `12.66 / 3.68` 精确回读为 number，无字符串化、无精度损失。

## 7. 运维要点

1. **口令管理**：`.env` 含 sa 口令与 JWT 密钥，仅限部署机本地保存；生产建议为应用建独立 SQL 账户（`db_datareader/datawriter` + 执行权），禁用 sa 直连。
2. **备份**：CN_AME 纳入 SQL Server 维护计划（每日完整 + 每小时日志）；`t_audit_log` 保留 2 年，超期归档删除。
3. **结构变更**：只改 `scripts/migrate.ts` 的 DDL + 对应实体，重新执行 `npm run migrate:prod`（幂等）；禁止在生产开 `synchronize`。
4. **规则发布**：`t_rule_set` 在线发布（RV 版本切换），与 `config/rules/*.json` 文件源双轨；W8 冻结后 `is_frozen=1`。
5. **监控**：`/api/health`、`/api/ready`（db/rules 双探活）；`t_ai_task` 堆积与月度 token 熔断看 `AI_MONTHLY_TOKEN_LIMIT`。
