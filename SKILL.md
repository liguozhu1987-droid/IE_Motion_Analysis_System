---
name: project-memory-workflow
description: IE Improvement Platform 的统一项目记忆与交接工作流：接手任务前按总入口确认业务口径、任务状态与风险；工作中坚持口径优先、代码证据与生产/非生产分类；收口时回写 handoff/明细/ 与进度文件。适用于新会话接手、开始编码/分析/调研任务、口径或验收标准变更、任务收口与跨 Agent 交接。
---

# 统一项目记忆与交接工作流（IE Improvement Platform）

> **2026-11-22 更新 · 与 Memory Bank 的分工**：本文件是**深度工作流**（口径优先、证据原则、生产/非生产分离等完整方法论）。
> **日常检索与写入**已由仓库根目录 `AGENTS.md` + `memory-bank/` + `.claude/skills/memory-bank/SKILL.md`（命令 `/memory-bank`）承担。
> 两者不冲突：`memory-bank/facts` 是指针卡片，正文仍以 `handoff/明细/` 为准；本文件的 §三 工作原则与 §四 收口清单继续有效。

本 skill 把本项目的 Agent 记忆体系与项目管理方式固化为可重复流程。
**记忆的唯一事实来源是 `handoff/明细/`，不是会话日志、工具缓存或代码注释。**
交接入口与速查表是 `handoff/00`~`04`；数据库硬性规则以根目录 `CLAUDE.md` 为准。
技术栈：NestJS 10 + TypeORM + SQL Server/SQLite；React 19 + Vite；Windows 本地开发/部署。

## 一、开工：按总入口读取（顺序不可颠倒）

0. `CLAUDE.md` —— 数据库边界与 30 表白名单（最高优先级硬性规则）
1. `handoff/明细/project_memory/README.md` —— 记忆库总入口与归口原则
2. `handoff/明细/project_memory/overview.md` —— 项目背景、模块、边界
3. `handoff/明细/project_memory/business_rules.md` —— 业务口径（**唯一准绳**）
4. `handoff/明细/project_memory/risk_log.md` —— 风险与未决事项
5. `handoff/明细/project_management/todo.md` —— 待办与优先级
6. `handoff/明细/project_management/progress.md` —— 当前进度与验收证据
7. 按任务类型进入细化目录：
   - 编码/修复/回归：`handoff/明细/agent_memory/coding/README.md`
   - 口径分析/影响评估：`handoff/明细/agent_memory/analysis/README.md`
   - 需求调研/PRD/方案比对：`handoff/明细/agent_memory/research/README.md`

速查入口：`AGENT必读.md` → `handoff/00-交接区入口.md` → `handoff/01`~`04`。

若 `handoff/明细/` 不存在（新克隆仓库），先按 `handoff/明细/project_memory/` 与
`handoff/明细/project_management/` 的结构创建最小骨架，再继续；**绝不要把长期项目记忆写进
`app/`、会话日志或工具缓存目录**。

## 二、开工前必须确认的四件事

1. 当前业务口径是否一致（以 `business_rules.md` 为准）
2. 本轮任务是否已记录在 `todo.md` 与 `progress.md`
3. 是否存在已知风险或未决事项（`risk_log.md`）
4. 本轮结论是否需要在收口时回写项目记忆

**四项未确认前不动代码。**

## 三、工作原则

### 3.1 口径优先于代码
- 顺序固定：**先总入口，后细分目录；先口径，再任务，再代码**。
- 先确认口径，再读实现，最后改代码。
- 文档、注释与代码行为不一致时，**以实际运行代码为准**，并把偏差写入 `risk_log.md`；
  同时更正文档，避免下一轮继续被误导。
- 不擅自变更口径；确需变更时，先写入 `business_rules.md` 再改代码。
- **规则改 JSON 不生效**：磁盘 `app/config/rules/*.json` 只是只读兜底，必须
  `POST /rules/:code/publish` 写入 DB 并升 RV；RV 验收用四点对齐，文件 RV 不参与一致性断言。
- **不可逆 DB 变更**（加列、回填、改唯一键）须逐项确认；`app/api/scripts/migrate.ts`
  是表结构唯一来源，改实体必跑 `npm run migrate:prod` + **真起 API**。

### 3.2 证据原则
- 每个结论都要同时给出「业务事实 + 代码证据（`file:line`）」。
- “不可达分支 / 死代码”类结论，必须用函数的实际返回值范围或调用链证明，
  **不能只凭注释或函数名推断**。
- 验证用最小命令，并在 `progress.md` 记录**实际输出**（通过数/失败数），不要写“应该通过”。
- 门禁 `SKIPPED` 不是 `PASS`；不得把未执行、模板占位或夹具数据写成通过。

### 3.3 生产 / 非生产分离（本项目映射）
| 分类 | 位置 | 要求 |
|---|---|---|
| `PRODUCTION` | `app/api/src/`、`app/api/scripts/`、`app/web/src/`、`app/config/rules/`、根配置 | 不随手改，改动需有明确理由 |
| `TEST_ONLY` | `app/api/test/`、`app/web/test-*.cjs`、`app/web/test-fixtures/` | 必须有 TAG 头；不得被运行时导入 |
| `DEBUG_OR_TEST_ONLY` | `.temp-probe/`、一次性导出/截图脚本 | 必须带 TAG 头并加入 `.gitignore`，不得被运行时导入 |
| `ARCHIVED` | `deliverables/`、历史报告 | 归档优先于删除，并在报告中留索引 |

非生产文件头部模板（JS/TS）：

```js
// TAG: NON_PRODUCTION
// CATEGORY: TEST_ONLY | DEBUG_OR_TEST_ONLY | ARCHIVED
// STATUS: ACTIVE | ARCHIVED
// SYSTEM_IMPACT: NONE
// DO_NOT_IMPORT_IN_RUNTIME: TRUE
// PURPOSE: <一句话说明>
```

- 清理冗余代码时**归档优先于硬删除**。
- 清理过程中不得顺带重构运行时逻辑。

### 3.4 历史兼容性
- 历史快照、旧版本数据不得被静默覆盖或回溯改写。
- 口径变更必须在交接说明中写明影响范围。
- 新增 DB 默认值、返回字段删除等兼容性动作，优先选择“保留字段形状、只删除不可达分支”。
- `std_time` 是正式口径（实测×评比×宽放），模拟值不得回写；AI 建议恒待审。

## 四、收口：回写记忆（缺一不可）

任务完成或阶段性收口时：

- [ ] `progress.md` 追加本轮结论：改了什么、为什么、**验证命令与实际结果**
- [ ] `todo.md` 更新完成状态；未完成项拆成明确遗留项（含 P1/P2 或 backlog 标记）
- [ ] `risk_log.md`：新增风险/待确认项；已解决项移入「已确认事项」
- [ ] 文档与代码不一致之处一并更正（含 PRD、更改说明、测试 docstring）
- [ ] 向用户说明：改动是否已提交、提交在哪个分支、是否有未提交内容
- [ ] 按 `AGENT必读.md` §7：看板改状态+日期、追加 `.workbuddy/memory/YYYY-MM-DD.md`、
      跨会话决策提炼进 `.workbuddy/memory/MEMORY.md`

记忆文件职责表：

| 文件 | 只写什么 |
|---|---|
| `business_rules.md` | 口径、判定标准、例外处理 |
| `overview.md` | 项目背景、模块、边界 |
| `architecture.md` | 技术架构、关键模块、接口 |
| `risk_log.md` | 风险、未决事项、已确认口径 |
| `todo.md` | 待办、优先级、backlog |
| `progress.md` | 进度、验收证据、交接确认 |
| `agent_memory/*` | 按 Agent 类型的细化工作规矩 |

## 五、常用验证命令（本项目，Windows）

```bash
npm run test:gate                  # 统一门禁 fast：类型/静态/离线契约/隔离 smoke；SKIPPED 不计 PASS
npm run test:gate:full             # fast + 全部隔离套件 + 依赖审计（advisory，耗时更长）
npm run test:eval                  # AI 分解评测门；无人工真值时 SKIP(78)，不得当 PASS
cd app/api && npm run test:smoke:isolated   # 隔离 smoke，基线 147/0 ×2
cd app/api && npm run test:isolated         # 全部已迁移隔离套件（串行）
cd app/api && npm run test:deps             # 生产依赖审计（当前 10 high / 1 critical）
cd app/web && npm run typecheck             # 前端 tsc
cd app/web && npm run test:css-classes      # CSS 未定义类名门禁
cd app/web && npm run test:desc-hints       # 描述联想离线回归
cd app/api && npx tsc -p tsconfig.json --outDir dist   # nest build 锁死时的编译替代
cd app/api && npm run migrate:prod          # dist 重建后跑；必须再真起 API
cd app/api && npm run ops:startup-check     # 真起 API + /health
```

- **首次基线**：`deliverables/gates/gate-report-20261119-070834.md`（阻断门 7/7 PASS）。
- **评测基线**：真值与候选放 `deliverables/ai-segment/eval/`，报告落 `deliverables/gates/eval/`。
- **规则发布**：改 `app/config/rules/*.json` → `POST /rules/:code/publish`；RV 四点对齐。
- **禁止 `npm run seed`**（会清库/覆盖正式数据）；清库后正式库仅余 ST010。
- **隔离回归必须串行**；UI 测试禁并行；前置 `t_ai_llm_profile.enabled=0`，跑完置回 1。
- **端口**：`5173` 被另一个项目长期占用；本项目固定 `--port 5174 --strictPort`，API `3001`。
- **回环探测**：带 `HTTP_PROXY` 时用 `curl --noproxy '*'` 或 `NO_PROXY=127.0.0.1`。
- **禁原生 `<select>`**；改 UI 必跑 `test:css-classes`。

## 六、固定交接话术

开场：

> 我已接手该项目。先读取统一项目记忆入口（README / business_rules / risk_log），
> 再确认 todo 与 progress，然后按任务类型进入细化目录。

结束：

> 我已按统一入口确认项目口径、任务状态和风险，再开始本轮工作；
> 如有争议或变更，先同步到项目记忆与进度文件。

## 七、反模式（出现即视为流程失败）

- 从散落文件、会话日志里搜状态，而不是从总入口读。
- 不同 Agent / 工具各维护一份“事实”。
- 把 `.workbuddy/memory/` 当业务口径源（它可以作 Append-only 日志，但不能替代 `business_rules.md`）。
- 未验证就写「已完成 / 已修复」；把 `SKIPPED` 写成 `PASS`。
- 用删除代替归档；或在清理任务里顺带改运行时逻辑。
- 只改代码不改文档，导致注释、PRD 与实现长期背离。
- 按“未提交文件数”当完成判据（0b 判据是干净工作区 + tag + tag 含 `scripts/gates/` 全部文件）。
- 改规则 JSON 不 `publish`；改实体不 `migrate`；运行 `npm run seed`。
- 使用原生 `<select>`；并行跑隔离/UI 回归。

## 八、当前 QA 解禁路径（2026-11-19）

`0a 门禁执行器 → 0b 基线提交 + tag → 0c 首次评测基线 → P0-0 → P0-1 → P0-4 → 决策 B`

- 0a ✅：`scripts/gates/` + `test:gate` / `test:eval`；基线 `gate-report-20261119-070834.md`。
- 0b ✅：提交 `0a72733` + tag `baseline-2026-11-19`；strict `TRACE_CHECKS=3/3`。
- 0c ⛔：候选 20 条已导出；**人工真值 `segments` 为空** → `test:eval` SKIP(78)。
  `ground-truth.json` 填 ≥20 段 + 实名 `labeler` 后才放行；不得参考候选反向生成真值。
- **发卡不等于解禁**；QA No-Go 维持。
