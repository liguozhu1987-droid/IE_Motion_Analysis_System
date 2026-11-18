# Phase 3 · Wave 2 加列 + 回填逐项确认清单

> **状态：✅ 已逐项确认 → 已执行 → 已验收（2026-11-11 21:40）。执行记录见 §9；本清单自此冻结，实现与清单不符时改实现。**
> 依据：`deliverables/Phase3_分解任务归属_排期与验收口径.md` §2.2 铁律 5、§7 迁移窗口裁定（2026-11-09 20:47）。
> 探查时间：2026-11-11 20:20；数据源：生产 SQL Server `CN_AME`（直连只读 SELECT + `sys.*` 元数据）。
> 探查脚本：临时只读脚本 `_inspect_wave2.cjs`（跑完已删除），原始输出见 §2。

---

## 1. 结论先行

Wave 2 涉及 **5 张表加列 + 1 个唯一索引重建 + 6 行存量回填**。生产库实测数据量很小（业务表合计 6 行），**回填完全可逆**（原值全为 `NULL`，回滚即 `SET ... = NULL`）；唯一不可自动逆的是 `t_audit_log` 的 7731 行历史日志，但本方案对其**零回填**，只加可空列，风险最低。

**但实码复核挖出 4 个排期文档未覆盖的事实，必须先定口径再动 DB**（详见 §5）：

| # | 发现 | 影响 |
|---|---|---|
| F1 | `t_ai_task` **无 `station_id` / `line_id`**，且当前 **0 行** | A-105-2「按 (tenant,line) 回填」对它无对象；新写入的 `decomp_task_id` 只能由 `TaskScopeService` 从请求上下文注入 |
| F2 | `t_ai_waste_batch` **没有 `input_hash` / `cache_from` 列** | D4「缓存键纳入 task_id」**只作用于 ai-suggest 一处**；ai-waste 无缓存，A-105-4 对它不适用 |
| F3 | `UQ_ai_batch_slot` 唯一键 = `(tenant, station, version, user, element_source)`，**不含 task_id** | 不改索引则同工位同版本在 T1/T2 各生成一次会撞 2601/2627，**A-105-3 无法通过** → 必须删旧建新 |
| F4 | 审计拦截器**只拦非 GET**，批量导出是 `GET /export/batch.xlsx`，当前**无任何审计行** | #108 需在导出成功后显式调 `AuditService.record()`；`record()` 现无 taskId 参数，须扩展；A-108-3「失败不阻断」已由 `.catch()` 天然满足 |

另：排期文档 §#106 写 `suggestions.service.ts:105`，实码为 **`:107`**（`mgr.create(Improvement, …)`），另两处 `:1119` / `:1121` 准确。行号仅作定位提示，不动冻结断言。

---

## 2. 生产库实测快照（2026-11-11 20:20）

### 2.1 五张表行数与回填影响行数

| 表 | 当前行数 | 需回填行数 | 回填目标 | 孤儿行 |
|---|---:|---:|---|---:|
| `t_ai_task` | **0** | **0** | 无（新写入注入） | — |
| `t_ai_suggestion_batch` | 1 | **1** | `DT-LEGACY` | 0 |
| `t_ai_waste_batch` | 1 | **1** | `DT-LEGACY` | 0 |
| `t_improvement` | 4 | **4** | `DT-LEGACY` | 0 |
| `t_audit_log` | **7731** | **0** | 历史保持 NULL | — |
| **合计** | 7737 | **6** | — | **0** |

### 2.2 产线与 legacy 任务

- 工位仅 2 个：`ST010` → `DEFAULT/BJFA1`，`L01-ST11` → `DEFAULT/L01`。
- legacy 任务 2 条：`DT-LEGACY`（DEFAULT/BJFA1/archived）、`DT-LEGACY-L01`（DEFAULT/L01/archived）。
- 三张业务表存量行**全部挂在 `ST010`/BJFA1**，零 L01 行 → 回填目标唯一确定为 `DT-LEGACY`；§2.2 铁律 4「按 (tenant,line) 映射」仍必须写成通用 JOIN，不能硬编码。

### 2.3 目标列现状（确认均不存在，加列幂等前置成立）

- 五张表**均无** `task_id` / `decomp_task_id`（`t_ai_task.task_id` 是既有 **UUID 主键** `NVARCHAR(36)`，D5 冲突属实）。
- `t_ai_suggestion_batch.input_hash` = `NVARCHAR(64)` NOT NULL、`cache_from` = `NVARCHAR(36)` NULL；1 行 `is_unlimited=1 / status=done / element_source=mixed / cache_from=null`（超管行，**不受过滤唯一索引约束**，重建索引不会冲突）。
- `t_improvement.element_ids` = `NVARCHAR(256)` NOT NULL，4 行中 **3 行非空**、最长 90 字符 → A-106-3「零改写」实际保护这 3 行。
- `t_audit_log.action` DB 实为 `NVARCHAR(128)`（实体写 `length: 64`，v3.58.1 遗留不同步，本轮不动）。
- 现有相关索引：`UQ_ai_batch_slot`、`idx_ai_batch_cache`、`idx_ai_waste_batch_station`、`idx_imp_station_status`、`idx_imp_project_type`、`idx_ai_task_pending`、`idx_audit_user`。

---

## 3. 逐项 DDL 清单（须逐项点头）

> 全部写入 `app/api/scripts/migrate.ts`（表结构唯一来源），`IF COL_LENGTH / IF NOT EXISTS` 幂等；加索引写进 `INDEXES` 或紧随回填的 `MIGRATIONS` 末尾（同 Phase 2 ⑧ 的做法）。
> **加列一律 `NULL` 且不带 DEFAULT**：避免 SQL Server 生成默认约束、使 `DROP COLUMN` 回滚无需先删约束；回填由独立 `UPDATE` 完成。

### 3.1 #105 · AI 批次三表（P1）

| 项 | `t_ai_task` | `t_ai_suggestion_batch` | `t_ai_waste_batch` |
|---|---|---|---|
| 新增列 | **`decomp_task_id`** (D5) | `task_id` | `task_id` |
| 类型 | `NVARCHAR(32) NULL` | `NVARCHAR(32) NULL` | `NVARCHAR(32) NULL` |
| 默认值 | 无 | 无 | 无 |
| 实体同步 | `AiTask` 加 `@Column({length:32, nullable:true})` | `AiSuggestionBatch` 同 | `AiWasteBatch` 同 |
| 存量回填 | **0 行，不回填** | **1 行** | **1 行** |
| 回填 SQL | — | 见 §3.4 通用模板 | 同左 |
| 新增索引 | `idx_ai_task_decomp (tenant_id, decomp_task_id, created_at)` | `idx_ai_suggest_batch_task (tenant_id, task_id, station_id, created_at)` | `idx_ai_waste_batch_task (tenant_id, task_id, station_id, created_at)` |
| 索引影响行数 | 0 | 1 | 1 |

**额外 DDL（F3，必须）**：重建槽位唯一索引，加入 `task_id`

```sql
-- 删旧（migrate.ts 已有先例：v3.46 同样删旧建新）
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name='UQ_ai_batch_slot' AND object_id=OBJECT_ID('t_ai_suggestion_batch'))
  DROP INDEX UQ_ai_batch_slot ON t_ai_suggestion_batch;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UQ_ai_batch_slot' AND object_id=OBJECT_ID('t_ai_suggestion_batch'))
  CREATE UNIQUE INDEX UQ_ai_batch_slot ON t_ai_suggestion_batch
    (tenant_id, station_id, version, user_id, element_source, task_id)
    WHERE is_unlimited = 0;
```
- 影响行数：现有 1 行 `is_unlimited=1`，**不在过滤范围内 → 零冲突**。
- 顺序硬约束：**回填完成后**才建此索引（否则 NULL 参与唯一键，多行 NULL 会撞）。

**D4 随附代码改动（非 DDL）**：`ai-suggest.service.ts`
- `computeInputHash()`（:817）：`raw` 的 JSON 增加 `task: taskId`。
- 缓存命中查询（:782）：加 `AND b.task_id = :taskId` 硬条件（保证 `cache_from` 不跨任务）。
- `slotWhere`（:670）与 `flightKey`（:674）：加 taskId，避免跨任务槽位互并 / single-flight 误合并。
- `ai-waste` **无缓存键，零改动**（F2）。

### 3.2 #106 · 改善任务（P1）

| 项 | 值 |
|---|---|
| 表 / 新增列 | `t_improvement` / `task_id` |
| 类型 / 默认 | `NVARCHAR(32) NULL` / 无 |
| 实体同步 | `Improvement` 加 `@Column({length:32, nullable:true})` |
| 存量回填 | **4 行**（全部 → `DT-LEGACY`），**`element_ids` 字符串零改写** |
| 新增索引 | `idx_imp_task (tenant_id, task_id, status)` |
| 三处创建点 | `suggestions.service.ts:107`、`ai-suggest.service.ts:1119`、`ai-waste.service.ts:1121` 注入当前任务 |
| 列表端点 | `GET /api/improvements?task_id=` 过滤；**不传时行为逐字不变**（A-106-2） |
| 影响行数 | 回填 4 行；报表 / dashboard 调用方因不传参而零行为变化 |

### 3.3 #108 · 导出审计（Wave 3 / P2，可选可撤销）

| 项 | 值 |
|---|---|
| 表 / 新增列 | `t_audit_log` / `task_id` |
| 类型 / 默认 | `NVARCHAR(32) NULL` / 无 |
| 存量回填 | **0 行 —— 7731 行历史日志全部保持 NULL，不冒充任务号** |
| 实体同步 | `AuditLog` 加 `@Column({length:32, nullable:true})` |
| 新增索引 | `idx_audit_task (tenant_id, task_id, created_at)`（影响 7731 行，加列与建索引均为元数据/扫描操作） |
| action 派生 | **不改** `audit.interceptor.ts` 的 path 派生规则（A-108-2）；新增业务自审计 action，命名待定（见 §6 D6） |
| 代码改动 | `AuditService.record()` 增加可选 `taskId`；`batch-export.controller.ts` 导出成功后显式 record，`after_json` 带 `task_no` + sheet 数；复下载**不**写导出审计行 |
| 失败不阻断 | `record()` 内 `.catch()` 已吞异常并返回 void → A-108-3 天然满足，无需额外 try/catch |

### 3.4 通用回填 SQL 模板（三张业务表共用，仅表名不同）

```sql
-- 幂等：只回填 NULL，绝不覆盖已归属用户新建任务的行
UPDATE x SET task_id = t.task_id
FROM <t_ai_suggestion_batch | t_ai_waste_batch | t_improvement> x
JOIN t_station s ON s.station_id = x.station_id AND s.tenant_id = x.tenant_id
JOIN t_decomposition_task t ON t.tenant_id = x.tenant_id
  AND t.round_type = 'legacy' AND t.line_id = s.line_id
WHERE x.task_id IS NULL;
```
- 影响行数：1 / 1 / 4（合计 **6**）。
- 验收：回填后 `task_id IS NULL` = 0、跨线行数 = 0、孤儿 = 0（A-105-2 / A-106-3）。
- **不触碰**：`element_ids` 字符串、任何主键 `*_id`、任何 `element_id` 原值（D3 铁律延续）。

---

## 4. 执行顺序（不可调换）

1. `MIGRATIONS` 末尾追加 5 条 `ADD COLUMN`（全部 `NULL`、无 DEFAULT）→ 幂等。
2. 追加 3 条通用回填 `UPDATE`（1+1+4 = 6 行）。
3. 追加 `UQ_ai_batch_slot` 删旧建新（**必须在回填后**）。
4. `INDEXES` 追加 6 条新索引。
5. 实体 5 个类加字段 + `database.module.ts` ENTITIES 核对（三表实体均已注册，无需新增注册）。
6. `npm run migrate:prod` → **真起生产 mssql API**（`dist` 重建 ≠ 进程更新）确认无 `DataTypeNotSupportedError` / 列截断。
7. 只读迁移验证脚本（新增 `test/phase3-wave2-migration-verify.cjs`）断言列长 32、NULL 性、索引存在、6 行回填正确、零跨线零孤儿、7731 行审计零回填。
8. §2.3 全量回归（11/11 · 17/17 · 27/27 · 43/43 · smoke 147/0×2 **串行** · 前端门禁 · MS1.4），加 `test:task-scope` 13/13 + 7/7、`test:ai-waste` / `test:ai-suggest` 0 新增失败、权限矩阵 125/125。

---

## 5. 冻结断言对照（不因实现而改）

| 断言 | 本清单的对应动作 |
|---|---|
| A-105-1 | 5 表列存在、类型/长度与实体一致；`t_ai_task` 不出现第二个 `task_id`；`migrate:prod` 重跑幂等 |
| A-105-2 | 3 条回填按 (tenant,line) JOIN；跨线 = 0、孤儿 = 0；`t_ai_task` 0 行天然满足 |
| A-105-3 | `UQ_ai_batch_slot` 加 `task_id` + 三处创建路径注入 → T1/T2 可各生成一次；采纳写 `t_improvement` 带任务号（与 #106 联验） |
| A-105-4 | `computeInputHash` 含 task + 命中查询加 `task_id` 硬条件；ai-waste 无缓存键（F2） |
| A-105-5 | 沿用 `assertTaskReadable` / `filterVisible`；AI 建议永远待审、LLM 禁产数字不回归 |
| A-106-1~4 | 三处 `mgr.create` 注入；`?task_id=` 可筛且不传行为不变；4 行回填零 `element_ids` 改写；报表口径与权限矩阵不变 |
| A-108-1~3 | 导出后新审计行带 `task_id` / `task_no` / sheet 数；兼容模式记 `null`；action 派生不变；`.catch()` 保证不阻断 |

---

## 6. 新增决策点（本轮挖出，须与 DDL 一并确认）

| 编号 | 决策 | 推荐值 | 若改推荐值的影响 |
|---|---|---|---|
| **D6** | #108 导出自审计的 `action` 取值 | `export_batch_xlsx`（新增一个业务自审计值，**不改 path 派生规则**） | 若复用 `get_export_batch_xlsx` 会与拦截器派生格式混淆；若完全不加 action 字段则无法与登录/写操作区分 |
| **D7** | 执行前备份方式 | 只导出 5 张表快照（`SELECT INTO` 临时表或 bcp），**不做全库 `BACKUP DATABASE`** | 全库备份更保险但耗时/占空间；因回填可逆（原值全 NULL），表级快照足够 |
| **D8** | 三张业务表回填后是否收紧为 `NOT NULL` | **不收紧**，保持 NULL + service 层保证注入（#103 `resolveTaskId` 恒有返回，含 legacy-fallback） | 收紧需额外 `ALTER COLUMN` 且影响 6 行；不收紧时若代码漏写会在唯一索引处报错，反而是保护 |
| **D9** | #108 是否本轮做 | **做**（列已列清单，零回填、风险最低） | 可撤销：看板 #108 标「撤销」，则只剩 4 表加列 + 5 索引，#105/#106 不动 |

---

## 7. 回滚方案（逐项）

| 动作 | 回滚 SQL | 可逆性 |
|---|---|---|
| 5 条 `ADD COLUMN`（无 DEFAULT） | `ALTER TABLE <t> DROP COLUMN <col>;`（须先删 §3.1/3.2/3.3 的 6 个新索引） | ✅ 完全可逆 |
| 6 行回填 `UPDATE` | `UPDATE <t> SET task_id = NULL WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE round_type='legacy');` | ✅ **完全可逆**：原值全为 NULL，可精确还原，且不动任何主键 / 字符串引用 |
| `UQ_ai_batch_slot` 删旧建新 | 按 `migrate.ts` 内旧 DDL 原文重建 `(tenant, station, version, user, element_source) WHERE is_unlimited=0` | ✅ 可逆（旧定义已版本化留存） |
| 6 条新索引 | `DROP INDEX <name> ON <t>;` | ✅ 完全可逆 |
| 7731 行审计日志 | **零回填 → 零影响**；加列回滚不影响任何历史行 | ✅ 无风险 |
| 代码改动 | `git checkout` 对应文件 + 重新 `tsc` / `nest build` + 重启 API | ✅ 可逆 |

**唯一需谨慎的窗口**：`migrate:prod` 执行期间到 API 重启之间，若有在线写入会落到新列的 NULL；因生产当前无并发写入（服务已停），推荐**停服执行**。

---

## 8. 确认记录

> **2026-11-11 20:31 已逐项确认，6/6 全部按推荐值采纳（用户）。确认后即刻执行，见 §9 执行记录。**

| 项 | 范围 | 确认结果 |
|---|---|---|
| #105 三表加列 + `UQ_ai_batch_slot` 重建 + 2 行回填 + D4 代码改动 | §3.1 | ✅ 按推荐全采纳 |
| #106 `t_improvement` 加列 + 4 行回填 + 三处注入 + 列表筛选 | §3.2 | ✅ 按推荐全采纳 |
| #108 `t_audit_log` 加列（7731 行零回填）+ 导出自审计 | §3.3 | ✅ 做，四项决策按推荐 |
| D6 / D7 / D8 / D9 | §6 | ✅ D6 `export_batch_xlsx` / D7 表级快照 / D8 不收紧 NOT NULL / D9 保留 #108 |
| 迁移窗口 | §4 | ✅ 确认后即刻执行（`migrate:prod` + 真起 API + §2.3 全量回归） |
| 确认人 / 时间 | — | 用户 / 2026-11-11 20:31 |

**本清单自此冻结为实施口径**：§3 的 DDL、§4 的顺序、§5 的 A-xx 对照不得为适配实现而改；实现与清单不符时改实现，不改清单。

---

## 9. 执行记录（2026-11-11 21:40 收口）

**结论：#105 / #106 / #108 全部完成并验收，A-xx 断言 100% 通过，正式库零夹具残留。**

### 9.1 顺序与产物（严格按 §4）

| 步骤 | 命令 / 产物 | 结果 |
|---|---|---|
| D7 迁移前快照 | `node test/phase3-wave2-snapshot.cjs` → `app/api/storage/wave2/backup_before.json` | `t_ai_task=0 · t_ai_suggestion_batch=1 · t_ai_waste_batch=1 · t_improvement=4 · t_audit_log=7731`，与 §2.1 实测逐项一致 |
| 构建 | `npx tsc -p tsconfig.json --outDir dist --incremental false` | 退出码 0，`dist/scripts/migrate.js` 更新 |
| 停服确认 | `netstat :3001` | 迁移时 API 未运行（零并发写入窗口） |
| 迁移 | `npm run migrate:prod` | `35 表 + 20 索引 + 76 项存量升级`，退出码 0；**连跑第二遍同样成功**（A-105-1 幂等） |
| 真起 API | `node dist/src/main.js`（生产 mssql） | `Nest application successfully started`；`/api/health` 200；无 `DataTypeNotSupportedError` / 列截断 |
| 迁移只读验证 | `node test/phase3-wave2-migration-verify.cjs` | **12/12**（连跑迁移后复验仍 12/12） |
| 真实 HTTP 契约 | `node test/phase3-wave2-contract.cjs` | **17/17** |

### 9.2 实现与清单的偏差（只有 1 处，已修正实现不改清单）

- **F5（新发现）**：`INDEXES` 里 v3.46 留的 `UQ_ai_batch_slot` 删旧建新按**旧 5 列定义**，而 `main()` 先跑 `INDEXES` 再跑 `MIGRATIONS`。库里一旦出现「同工位同版本、不同任务各一条」记录，第二次 `migrate:prod` 会在旧定义上撞 2601/2627，A-105-1「幂等重跑无错」不成立。
  → 把该索引从 `INDEXES` 移除，统一由 `MIGRATIONS` ③ 在「加列 + 回填之后」按含 `task_id` 的新定义删旧建新；`DDL` 注释同步。已用契约夹具「T1/T2 同槽位各插一条成功 + 同任务内重复插入被拦截」双向证明。

### 9.3 关键实现点

- **#105**：`TaskScopeService`（@Global）注入 `ai-suggest` / `ai-waste`；`generate/list/latest/batches/items` 的槽位、success/active/concurrent、缓存命中、single-flight 全部按任务号隔离（`taskFilter(taskId)`，兼容模式 `IS NULL`）；`computeInputHash` 加 `task`（D4）；`t_ai_task` 无 station/line（F1）→ `AiTaskService.submit` 从 `PolishDto.task_id` 或 `currentTaskScope()` 写 `decomp_task_id`，无上下文写 NULL。
- **#106**：三处 `mgr.create(Improvement)` 全部注入；AI 建议采纳与浪费问题结算**取来源批次 task_id**（不重新解析当前任务，避免前端切任务后改挂历史建议）；`GET /api/improvements?task_id=` 过滤，不传逐字不变；VO 增 `task_id`。
- **#108**：`AuditService.record()` 末位加可选 `taskId` 并 clip 32；旧 7 个调用点零改动；`BatchExportController` 导出成功后显式 `record()`（D6 `export_batch_xlsx`）；兼容模式 `null`；复下载不写。

### 9.4 全量回归（§2.3 + 清单 §4 step 8）

| 门禁 | 结果 |
|---|---|
| Phase2 迁移只读 / Wave2 迁移只读 | **11/11** · **12/12** |
| 离线工作簿 / 真实 HTTP / 真人 Chrome UI | **17/17** · **27/27** · **43/43** |
| `test:task-scope`（Wave1 不回归） | **13/13 + 7/7** |
| 隔离 smoke 串行两轮 | **147/0 ×2**，两轮总判定 PASS（正式库 / storage 指纹未变化） |
| ai-waste / ai-suggest | **85/85** · **62/62**（见 9.5 隔离副本） |
| ai-suggest-source / 权限矩阵 | **43/43 ×2** · **125/125 ×2**（isolated-run） |
| 前端 | tsc 0 错 · CSS 门禁 0 未定义 · vite build · 拆包 6/6 · 原生 `<select>` 仅注释 |
| 规则 | `publish-ms14.cjs` → MS1.4 active、幂等跳过 |

### 9.5 两个历史 AI 套件的隔离执行（避免破坏正式库）

`ai-waste-contract.cjs` / `ai-suggest-contract.cjs` 会 `DELETE FROM t_ai_setting` 并清理 `L01-ST%` 数据，直连 `CN_AME` 会破坏现有数据。故：

1. `CREATE DATABASE CN_AME_W2QA` → `DB_NAME=CN_AME_W2QA npm run migrate:prod` → 同库 `npm run seed` → 跑两套契约 → `DROP DATABASE CN_AME_W2QA`（跑完已删，临时备份文件也已删）。
2. 过程中暴露两个**既存环境问题**（与 Wave 2 无关）：① 全新库 `migrate.ts` 建表缺 7 个实体列（`t_user.auth_source`、`t_refresh_token.source`、5 个 `t_video_asset.*`），seed 会报 `Invalid column name 'auth_source'`；② `L02-ST01` 夹具工位需归属 `u_other1`，否则 ai-suggest 第 61 项 403。两项均只在隔离副本补齐，正式库未动；补齐后 ai-suggest **62/62**。
3. **发现（待单独排期）**：`migrate.ts` 并非全新安装的完整 schema 来源（另有 4 张 `CN_AME_SSO_*` 外部表不在脚本内，属预期）；上述 7 列需补进 `migrate.ts` 才能保证空库可部署。

### 9.6 清理与遗留

- 正式库夹具残留：`ST97/ST98` 工位 0、`Phase3契约测试*` 任务 0、`W2TEST-*` 批次/措施 0；D7 快照文件保留作回滚证据。
- `t_audit_log` 新增 22 行带任务号的自审计/回落日志（append-only，按设计不删）；其中 4 行因测试任务已清理而悬空引用，验证脚本已按「旧 action 行必须指向合法任务 / 自审计行 append-only」区分，不算缺陷。
- 未在本次窗口内：#107（Wave 3 / P2，无 DDL）、§6 之外 B/C/D 组遗留。
