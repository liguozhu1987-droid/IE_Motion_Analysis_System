# Phase 3 · 分解任务归属贯通：排期与验收口径

> 版本 v0.1（待确认稿） · 2026-11-09 · 依据 `AGENT必读.md` 看板 #102、`批量导出_产线工位VA与动作分析表单_设计方案.md` §3.7 / §9、`.workbuddy/memory/2026-11-09.md`
> **状态（2026-11-11 23:05）：Phase 3 全部完成并验收——Wave 1（#103/#104）、Wave 2（#105/#106/#108）、Wave 3（#107）均已落地。** A-xx 断言冻结不变，执行证据见 `Phase3_Wave2_加列回填逐项确认清单.md` §9 与 `AGENT必读.md` 看板。所有不可逆 DB 变更与 D1–D5 决策均经用户逐项确认后执行。

## 0. 结论摘要

A 组（§3.7「单独排期」7 项）拆成 **6 个看板任务 #103–#108**，按 3 个 Wave 推进：

| Wave | 任务 | 目标 | 优先级 |
|---|---|---|---|
| 1 | #103 写入侧收口 | 关掉**正在发生**的跨任务误删与错挂 | **P0 阻断** |
| 1 | #104 读取侧收口 | 分析 / 对比 / 驾驶舱 / 建议取数按任务隔离 | **P0** |
| 2 | #105 AI 批次归属 | 三类批次表带任务号、缓存与采纳不串 | P1 |
| 2 | #106 改善任务归属 | `t_improvement` 带任务号、列表与报表可筛 | P1 |
| 3 | #107 `#/diff` 跨任务对比 | 复用 `baseline_task_id`，不新建对比引擎 | P2 |
| 3 | #108 导出审计摘要 | `task_no` 进审计（§9 P2 可选） | P2 |

**In**：仅任务归属贯通（写入 / 读取 / 批次 / 改善 / 对比 / 审计），不改导出 6 张 sheet 结构、不改 CSV 模板列、不改纯函数分析引擎、不做任务对比包与产线级跨轮对比。
**Out**：§3.7 之外的 B/C/D 组遗留（留档清理、焦点阈值校准、UI 11 套串行回归、依赖清零、容量 / 部署）、§9 P2 的其它增强、AI 批次 / 改善任务 / CSV 导入之外的任何新功能。

---

## 1. 现状快照（2026-11-09 实码复核，非推测）

Phase 2 只收口了**导出链路**。以下为逐一读码确认的缺口：

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| S1 | `app/api/src/modules/elements/elements.service.ts:156` | `mgr.delete(Element, { station_id, bol_version, tenant_id })` **无 task_id** | 同一工位同版本的**其它任务要素会被一并删除** |
| S2 | 同文件 `:162` `mgr.create(Element, {...})` | **未设置 task_id**，落 DB 默认 `DT-LEGACY` | 工作台 / AI 分解 / CSV 导入的新要素全部错挂到归档任务 |
| S3 | 同文件 `:291` `exportCsv()` | 仅按 `{station_id, bol_version}` 取数 | 单工位 CSV 导出跨任务混数据 |
| S4 | `app/api/src/core/shared/util.ts:61` `elementId()` | 生成 `L01-ST01-V2-003`，**不含任务号**；而 Phase 2 `cloneElements` 生成 `DT-2026-001-L01-ST01-V2-003` | 同工位同版本跨任务写入会**主键冲突**；两套编码并存 |
| S5 | `app/api/src/modules/analysis/analysis.service.ts:32` | `elementRepo.find({station_id, bol_version})`，无 task_id | 分析 / 对比 / 建议 / 驾驶舱全部跨任务混算 |
| S6 | `t_ai_task` / `t_ai_suggestion_batch` / `t_ai_waste_batch` | 三表均无分解任务列 | 两轮改善的 AI 批次无法区分 |
| S7 | `t_ai_task.task_id` | **已是 AI 队列自身 UUID 主键** | 与「分解任务号」同名撞义，新增列不可复用此名 |
| S8 | `t_improvement` / `t_audit_log` | 均无 task_id / task_no | 措施与导出审计无法归属任务 |
| S9 | `app/api/src/modules/elements/dto.ts` 等 DTO | 无 `task_id` 参数（ValidationPipe whitelist 会剥离） | 前端传了也进不来 |
| S10 | 唯一键 `migrate.ts:233 / 699` | 已是 `(tenant_id, task_id, station_id, bol_version, seq)` | 设计上**允许**同工位同版本多任务并存，但 S1/S4 未跟上 → 属**设计未贯通**，不是历史遗留 |

> **结论**：#103 不是「优化」，是当前生产数据正确性的 P0 阻断项。在它完成前，任何通过工作台新提交的要素都会挂到 `DT-LEGACY`，且可能删掉另一任务的要素。

---

## 2. 通用验收口径（#103–#108 全部适用）

### 2.1 任务号与权限（沿用 Phase 2，不另立口径）

- 任务号 `DT-{YYYY}-{NNN}`，租户内唯一、不可变；兼容模式（无任务上下文）必须如实标注「未指定分解任务」，**不冒充任务号**。
- 所有新增端点一律 `TasksService.assertTaskReadable(taskId, user)`：同租户 + 不存在返回 404（不泄露存在性）；工位级仍逐工位 `StationsService.filterVisible()` / `assertReadable`，聚合**在引擎计算前**按可见工位过滤。
- 任务属于单产线；跨线请求 400，跨租户 404。

### 2.2 DB 变更铁律（违反即验收不通过）

1. `app/api/scripts/migrate.ts` 是表结构**唯一来源**；实体 `length/type` 与 DDL 同步；**布尔列不写 `type`**；新实体必须注册 `database.module.ts` 的 `ENTITIES`。
2. 改实体后必须 `npm run migrate:prod` + **真起生产 mssql API**（`dist` 重建 ≠ 进程更新），确认无 `DataTypeNotSupportedError` / 列截断。
3. 所有新增列幂等（`IF NOT EXISTS`）；加索引须写进 `INDEXES`。
4. **存量回填按 `(tenant_id, line_id)` 映射到各自 legacy 任务**（`DT-LEGACY` / `DT-LEGACY-L01`），严禁单条 `DT-LEGACY` 混线——Phase 2 已因此返工一次。
5. **不可逆 DB 变更执行前逐项确认**：列出表名、列名、类型、默认值、回填 SQL、影响行数、回滚方案，用户逐项点头后才跑。

### 2.3 回归基线（每个任务收口前全绿，禁抽样）

| 类别 | 命令 / 断言 | 门槛 |
|---|---|---|
| 生产迁移只读验证 | `node test/phase2-migration-verify.cjs` | 11/11 |
| 离线工作簿契约 | `npm run test:batch-export` | 17/17 |
| 真实 HTTP 契约 | `node test/batch-export-http.cjs` | 27/27 |
| 真人 Chrome UI | `cd app/web && node test-batch-export-ui.cjs` | 43/43 |
| 隔离 smoke | `npm run test:smoke:isolated` | 147/0 ×2，**必须串行**（同期跑 HTTP 契约会写 `storage/exports` 触发指纹守卫误 FAIL） |
| 前端 | `npm run typecheck` / `test:css-classes` / `build` / `test:perf` | 全绿、拆包 6/6 |
| 门禁 | `grep -rn "<select" app/web/src` | 仅剩注释；新增下拉一律自绘 `SelectMenu` |
| 规则 | `node test/publish-ms14.cjs` | MS1.4 active 且幂等 |

- 新测试脚本按惯例落 `app/api/test/task-scope-*.cjs` / `app/web/test-task-scope-*.cjs`，npm script 用 `test:task-scope:<域>`；契约脚本须自带按名清理，不留测试任务 / 要素。
- **严禁 `npm run seed`**（正式库清库后会重新植入种子工位）；清库数据仅 ST010 可用。
- 验收定义：上述基线全绿 + 本任务 A-xx 断言 100% 通过 + 每改动文件 ≥1 条原始证据（命令 / 退出码 / 输出）+ 无新增失败。

---

## 3. 执行前须逐项确认的决策（D1–D5）

> **状态：2026-11-09 20:47 已逐项确认，D1–D5 全部按推荐值采纳（见 §7 确认记录）。本表自此冻结为实施口径；A-xx 验收断言不得为适配实现而改。**

| ID | 决策点 | 已确认口径 | 影响 |
|---|---|---|---|
| **D1** | 「当前任务」上下文从哪来？ | 前端在产线总览 / 工作台维护当前任务；请求经 DTO/query/header 显式 `task_id` 传入；服务端统一 `resolveTaskId(user, station_id, explicit?)`：显式→`assertTaskReadable`；未显式→查 `t_task_station` 唯一生效任务；多任务→要求显式指定（返回 409 列出候选）；都没有→回落该产线 legacy 任务并标注 `legacy-fallback`。**不新增前端必填步骤**（§3.7 硬约束） | 决定 #103/#104 全部接口形态 |
| **D2** | 兼容模式（不传 task_id）保留多久？ | 保留一个版本，写 `legacy-fallback` 响应头 + 审计；UI 显示风险提示（复用批量导出兼容模式文案）；下一版可收紧为必填 | 影响存量脚本与第三方调用 |
| **D3** | `element_id` 主键如何带任务号？ | **不改写存量**（`t_improvement.element_ids` / AI 建议 `element_ids` 以字符串引用，批量改写会断链）。新增 `taskElementId(taskNo, stationId, version, seq)` 仅供带任务上下文的新写入；`elementId()` 保留给兼容模式；所有引用侧按库里实际值读取，**禁止按规则反推** | #103 最大风险点；需在 96 长度内验证 |
| **D4** | AI 批次缓存键是否纳入 task_id？ | `input_hash` / `cache_from` 目前按 station+version+source，跨任务同内容会命中同一缓存。建议把 task_id 纳入 hash 输入，但会改变缓存命中率与 LLM 成本 | 已确认接受缓存命中率下降 / LLM 成本上升 |
| **D5** | 列名冲突与审计字段 | `t_ai_task.task_id` 已是队列 UUID 主键 → 该表新增列命名 **`decomp_task_id`**（实体同名字段），其余表统一 `task_id`；审计不动 action 派生规则，新增 `task_id` 列 + `after_json` 带 `task_no` | 避免语义污染与日志检索回归 |

---

## 4. 看板任务与验收口径

### #103 · Wave 1 / P0 · 任务上下文统一 + 要素写入侧收口

**范围**：S1/S2/S3/S4/S9 + §3.7「CSV 导入上下文注入」「新建工位继承当前任务」。
**改动**：`elements/dto.ts`（加可选 `task_id`）、`elements.service.ts` 的 `submit/importCsv/exportCsv`、`elements.controller.ts`、`core/shared/util.ts`（新增 `taskElementId`）、`stations.service.ts` 的 `create/createFromCmc`（写 `t_task_station`）、`AiSegmentPage.tsx:658 buildPayload`、`CreateStationWizard.tsx`、前端 `api.ts`。CSV 模板列与回导闭环**不变**。

| 断言 | 验收口径 |
|---|---|
| A-103-1 | `submit()` 的 `mgr.delete()` 条件含 `task_id`；SQL 只读验证：同工位同版本建 T1/T2 两任务各 3 要素，提交 T1 后 `SELECT COUNT(*) WHERE task_id='T2'` 仍为 3 |
| A-103-2 | `mgr.create()` 显式写 `task_id`；新要素 `task_id` = 请求上下文任务，全库 `task_id='DT-LEGACY'` 的**新增行数为 0**（对比提交前后快照） |
| A-103-3 | 带任务号的 `element_id` 长度 ≤96；T1/T2 同工位同版本同序号写入不冲突，两任务 `element_id` 互不相同；存量 `element_id` 原值零改写 |
| A-103-4 | `POST /api/stations/:id/elements/import` 由上下文注入任务，CSV 表头逐字不变（含 UTF-8 BOM 回归），导入后要素 `task_id` 正确；导出 CSV 只含该任务要素、行数一致 |
| A-103-5 | AI 分解链路 `AiSegmentPage → submitElements` 带任务上下文；无 `element:write` 账号 403，跨租户任务 404 |
| A-103-6 | 新建工位自动关联当前任务写 `t_task_station`（锁 `bol_version`），前端无新增必填步骤；未指定任务时按 D2 回落并标注 |
| A-103-7 | `exportCsv` 按 task_id 过滤；兼容模式响应带 `legacy-fallback` 标记 |

**DB 变更**：无新增列（复用 `t_element.task_id`）；如需补索引须列清单确认。**含存量数据修正时需逐项确认影响行数与回滚**。
**门槛**：A-103-1~7 全过 + §2.3 基线全绿 + `test/task-scope-write.cjs` N/N 0 失败。
**依赖**：D1/D2/D3 确认。

---

### #104 · Wave 1 / P0 · 读取侧按任务隔离

**范围**：S5 + §3.7「`analyzeStation` 调用方传 `task_id`」。**纯函数 `engine.ts` 签名与算法不变**，仅 service 取数加条件。
**改动**：`analysis.service.ts`（`analyzeStation` / `analyzeStationAtVersion`）、`compare.service.ts`、`suggestions.service.ts`、`ai-suggest.service.ts`、`ai-waste.service.ts`、`ai-insight.service.ts`、`dashboard.service.ts`、`lines.controller.ts`、`batch-export.service.ts`（复核已隔离）、各 controller 的 query DTO、前端 `api.ts` 查询串。

| 断言 | 验收口径 |
|---|---|
| A-104-1 | 全仓 grep：`elementRepo.find` / QueryBuilder 取要素处，除明确标注的兼容路径外**全部带 task_id 条件**，残留 = 0 |
| A-104-2 | 同工位同版本两任务要素数不同 → `GET /api/stations/:id/analysis` 传不同 task_id 返回不同 `ΣCT / 浪费数 / VA%`；不传时按 D1 口径回落且不串 |
| A-104-3 | `compare` / `suggestions` / `ai-*` / `dashboard` / `lines` 五类端点逐一验证：A 任务结果不出现 B 任务的 `element_id` |
| A-104-4 | 不可见工位静默剔除；聚合在引擎计算前过滤；跨租户任务 404 |
| A-104-5 | `analyzeStation(station, elements, vaRules, wasteRules)` 函数签名与输出结构**逐字未变**（diff 为空） |

**DB 变更**：无。
**门槛**：A-104-1~5 全过 + §2.3 基线全绿（dashboard / acl-guard 套件需一并复跑）。
**依赖**：#103、D1。

---

### #105 · Wave 2 / P1 · AI 批次三类归属任务

**范围**：`t_ai_task`（注意 D5 列名 `decomp_task_id`）、`t_ai_suggestion_batch`、`t_ai_waste_batch`；生成 / 采纳入参与前端传参；D4 缓存键。
**改动**：3 个实体 + 3 个 service/controller + `migrate.ts` + `database.module.ts`（如新增实体）+ 前端 AI 各页。

| 断言 | 验收口径 |
|---|---|
| A-105-1 | 迁移只读验证：三表列存在、类型/长度与实体一致、`t_ai_task` 不出现第二个 `task_id`；`migrate:prod` 幂等重跑无错 |
| A-105-2 | 存量批次按 `(tenant,line)` 回填到对应 legacy 任务；跨线行数 = 0、孤儿 = 0 |
| A-105-3 | 同工位同版本在 T1/T2 各生成一次建议 / 浪费批次，列表按任务筛选互不串；采纳写入的 `t_improvement` 带正确任务号（与 #106 联验） |
| A-105-4 | 按 D4 决议：缓存键含 / 不含 task_id 均须有断言证明跨任务不误命中；`cache_from` 不跨任务引用 |
| A-105-5 | 无 `element:write` / 跨租户访问返回 403/404；AI 建议永远待审、LLM 不产数字等既有铁律无回归 |

**DB 变更（须逐项确认）**：3 表加列 `NVARCHAR(32) NULL`（`t_ai_task` 用 `decomp_task_id`）+ 回填 + 索引。
**门槛**：A-105-1~5 全过 + `test:ai-waste` / `test:ai-suggest` 既有套件 0 新增失败。
**依赖**：#103、#104、D4、D5。

---

### #106 · Wave 2 / P1 · 改善任务归属任务

**范围**：`t_improvement` 加 `task_id`；三处 `create(Improvement)`（`suggestions.service.ts:105`、`ai-suggest.service.ts:1119`、`ai-waste.service.ts:1121`）注入；列表 / 报表可按任务筛选。
**改动**：`improvement.entity.ts`、`migrate.ts`、`suggestions.service.ts` / `suggestions.controller.ts`、两处 AI 采纳、`ImprovementsPage.tsx`、`api.ts`。

| 断言 | 验收口径 |
|---|---|
| A-106-1 | 三处创建路径逐一验证：采纳产生的 `t_improvement.task_id` = 来源任务，无一落 legacy 默认 |
| A-106-2 | `GET /api/improvements?task_id=` 按任务过滤；不传时保持原有行为（不破坏 dashboard / 报表调用） |
| A-106-3 | 存量措施按工位所属产线回填 legacy 任务，跨线 = 0；`element_ids` 字符串引用**零改写** |
| A-106-4 | `GET /api/improvements/:id/report` 与月度报表口径不变（仅数据范围收窄）；权限矩阵 125/125 无回归 |

**DB 变更（须逐项确认）**：`t_improvement` 加 `task_id NVARCHAR(32) NULL` + 回填 + 索引。
**门槛**：A-106-1~4 全过 + 权限矩阵 + §2.3 基线全绿。
**依赖**：#103、#104。

---

### #107 · Wave 3 / P2 · `#/diff` 跨任务对比

> **[2026-11-11 ✅ 已完成·已验收]** 无 DB 变更。后端：`versions()` 按 task_id 过滤（D1 兼容回落）、`GET /tasks?station_id=` 筛选、compare 复用现有端点经 TaskScope 取数（新增引擎文件数=0，A-107-4 ✅）。前端：DiffPage A/B 两侧自绘 `SelectMenu`、B 侧基准任务自动联动 A 侧 + 「B 侧基准」提示、ComparePage 随任务上下文；清理 diff.css 原生 select 死 CSS。验证：`test:wave3:contract` **11/11**（A-107-1 旧行为等价 / A-107-2 第三任务要素 0·跨租户 404）、真人 Chrome UI **12/12**（A-107-3）、task-scope 13/13+7/7、批量导出 HTTP 27/27、前端门禁全绿；夹具残留全 0。

**范围**：复用 `baseline_task_id`，**不新建对比引擎**；`DiffPage.tsx` / `ComparePage.tsx` 支持跨任务选择；任务对比包与产线级跨轮对比**不在本轮**（§9 P2）。

| 断言 | 验收口径 |
|---|---|
| A-107-1 | `#/diff/:id/:vA/:vB` 扩展任务上下文后，两任务要素集 / `ΣCT` / 四类时间差异计算正确；不传任务时旧路由行为不变 |
| A-107-2 | 对比结果不含第三任务要素；跨租户任务 404 |
| A-107-3 | 真人 Chrome：任务下拉为自绘 `SelectMenu`（零原生 select）、切换后 DOM 差异表刷新、无 JS pageerror |
| A-107-4 | 复用现有 `computeDiff` / compare 端点，未新增对比引擎（新增引擎文件数 = 0） |

**DB 变更**：无。 **依赖**：#103、#104、#106。

---

### #108 · Wave 3 / P2 · 导出审计摘要含 task_no（§9 P2 可选）

**范围**：`t_audit_log` 加 `task_id` 列，`after_json` 带 `task_no`；**不改 action 派生规则**（避免破坏现有日志检索）。若用户判定不需要，本任务可直接从看板撤销。

| 断言 | 验收口径 |
|---|---|
| A-108-1 | 按任务导出成功后 `t_audit_log` 新增一行，`task_id` 与任务一致、`after_json` 含 `task_no` 与 sheet 数；兼容模式记 `null` 且不冒充 |
| A-108-2 | 既有 action 取值逐字不变（`post_stations` / `login` / `video.*` 等），历史日志可读 |
| A-108-3 | 审计写入失败不阻断导出（try/catch）；复下载不新增导出审计行 |

**DB 变更（须逐项确认）**：`t_audit_log` 加列。**依赖**：#103。

---

## 5. 依赖与建议顺序

```
D1–D5 逐项确认
      │
      ├─ Wave 1：#103 ──→ #104        （先关数据正确性；同 Wave 内 #103 必须先落地）
      │                    │
      ├─ Wave 2：#105 ──┬──┴──→ #106  （#105/#106 可并行，采纳链路需联验）
      │                 │
      └─ Wave 3：#107 ──────→ #108     （#108 独立可选，可撤销）
```

- **先做 #103 的理由**：S1/S2 是当前正在发生的生产数据风险，且 #104–#108 的验收都依赖「写入侧有正确的 task_id」，先做其它会得到假绿。
- 每个 Wave 收口后跑一次 §2.3 全量基线；**不要跨 Wave 合并迁移**（一次一列、一次一确认，便于回滚）。
- 未给具体日期：用户未指定窗口，看板状态统一 `🔲 未开始`、完成日期 `—`，待确认 D1–D5 与迁移窗口后再填。

## 6. 明确不在本轮（避免范围蔓延）

- §3.7 之外：留档自动清理、焦点阈值现场校准、双手双轨时间线、UI 11 套串行回归、依赖 10 high/1 critical、SQL Server/IIS 容量 / spike/soak / INP、部署。
- §9 P1 8 项的逐项用户评审（已在 v3.61/v3.62 按建议默认落地，未走确认）。
- §9 P2 其余：山积图 / 四类时间堆积图、任务对比包、产线级跨轮对比、词表治理、数据采集治理（cycle_count / CV / Route / MTM 代码）。
- 看板 §7 第 5 条 7 项历史候选（审计查询页 / 规则发布 UI / AI 队列 / 备份策略 / 审批通知 / 多租户自助 / 限流换 Redis）。

---

## 7. 当前待办（用户 2026-11-09 20:43 指定）

> **待办 = D1–D5 逐项确认 + 迁移窗口** —— **2026-11-09 20:47 已逐项确认完毕，6/6 全部按推荐值采纳**（详见下方确认记录）。
> 迁移窗口裁定：**先跑 Wave 1（#103/#104 纯代码改造，不加列、不回填）；#105/#106/#108 的加列 + 回填清单与窗口另行逐项确认**。
> 据此 #103/#104 已获准开工；**任何 `migrate:prod`（加列 / 回填）仍须先列出表名·列·默认值·影响行数·回滚方案并逐项确认**。看板 #103–#108 当前仍为 `🔲 未开始`（尚未编码）。

| 待办 | 决策内容 | 推荐值（v0.1） | 若改推荐值的影响 | 状态 |
|---|---|---|---|---|
| **D1** | 「当前任务」上下文从哪来 | 服务端 `resolveTaskId(user, station_id, explicit?)`：显式→`assertTaskReadable`；未显式→查 `t_task_station` 唯一生效任务；多任务→409 列候选；都没有→回落该产线 legacy 并标 `legacy-fallback`。前端不新增必填步骤 | 决定 #103/#104 全部接口形态；若改为「一律必填」，所有存量脚本与单工位页面都要改 | ✅ 已确认·按推荐值 |
| **D2** | 兼容模式（不传 task_id）保留多久 | 保留一个版本，写 `legacy-fallback` 响应头 + 审计，UI 显风险提示；下一版收紧为必填 | 影响存量脚本 / 第三方调用；立即收紧会打断现有回导闭环 | ✅ 已确认·按推荐值 |
| **D3** | `element_id` 如何带任务号 | **存量零改写**；新增 `taskElementId(taskNo, stationId, version, seq)` 仅供带任务上下文的新写入；`elementId()` 留给兼容模式；引用侧按库内实际值读取，禁止反推 | 若选择批量改写存量，`t_improvement.element_ids` / AI 建议 `element_ids` 等字符串引用会断链，**不可逆** | ✅ 已确认·按推荐值 |
| **D4** | AI 批次缓存键是否纳入 task_id | 纳入 `input_hash`，避免跨任务误命中；副作用是缓存命中率下降、LLM 成本上升 | 用户重成本；不纳入则须在查询侧硬隔离并加断言证明不误命中 | ✅ 已确认·按推荐值 |
| **D5** | 列名冲突与审计字段 | `t_ai_task` 新增列叫 `decomp_task_id`（其 `task_id` 已是 AI 队列 UUID 主键）；其余表统一 `task_id`；审计不动 action 派生规则，新增 `task_id` 列 + `after_json` 带 `task_no` | 复用 `task_id` 名会语义污染；改 action 派生规则会破坏既有日志检索 | ✅ 已确认·按推荐值 |
| **迁移窗口** | 何时执行 `migrate:prod` + 重启 API | 待用户指定；建议业务低峰且可回滚的独立窗口，Wave 1 的 #103/#104 **无加列**（#105/#106/#108 才加列） | 生产 SQL Server 不可逆；每次加列/回填须逐项列出表名·列·默认值·影响行数·回滚方案后再跑 | ✅ 已确认·按推荐值 |

**确认记录**（2026-11-09 20:47 用户逐项选择后填写，非预填）：

| 项 | 确认值 | 确认时间 | 确认人 |
|---|---|---|---|
| D1 | 按推荐 `resolveTaskId`：显式→校验 / 唯一生效任务→自动继承 / 多任务→409 / 无→legacy-fallback；前端不增必填 | 2026-11-09 20:47 | 用户 |
| D2 | 兼容模式保留一个版本（legacy-fallback 响应头 + 审计 + UI 风险提示），下一版收紧 | 2026-11-09 20:47 | 用户 |
| D3 | **存量零改写**；新增 `taskElementId` 供带任务上下文的新写入，`elementId()` 留给兼容模式，引用侧禁止反推 | 2026-11-09 20:47 | 用户 |
| D4 | 缓存键 `input_hash` **纳入 task_id**（接受缓存命中率下降 / LLM 成本上升） | 2026-11-09 20:47 | 用户 |
| D5 | 按推荐：`t_ai_task` 新增 `decomp_task_id`，其余表统一 `task_id`；审计不动 action 派生规则，加 `task_id` 列 + `after_json` 带 `task_no` | 2026-11-09 20:47 | 用户 |
| 迁移窗口 | **先跑 Wave 1（#103/#104 纯代码，无 DDL）；#105/#106/#108 加列 + 回填清单与窗口另定** | 2026-11-09 20:47 | 用户 |

**确认后的动作顺序**：① ✅ 已把确认值写回 §3 / 本节 / 看板 #103·#104 备注 / 今日日志；② 下一步按确认值**冻结 A-xx 断言**（禁为适配实现改断言）→ 进入 #103/#104 编码与 §2.3 全量回归（**无 DDL、无回填**）；③ #105/#106/#108 动 DB 前，另行列加列 + 回填清单逐项确认 → 才跑 `migrate:prod` + 真起生产 mssql。
