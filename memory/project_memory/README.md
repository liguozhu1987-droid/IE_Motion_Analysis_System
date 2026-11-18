# 统一项目记忆 · 总入口（README）

> 本目录依根目录 `SKILL.md`（project-memory-workflow）建立，是 **IE Improvement Platform 的项目级长期事实源**。
> 建立日期：2026-11-18（本轮「全面功能评审 + 行业对标」收口时补齐；此前 `memory/` 不存在）。

## 一、为什么建这个目录

`SKILL.md` §一 规定「若 `memory/` 不存在（新克隆仓库），先按 `memory/project_memory/` 与
`memory/project_management/` 的结构创建最小骨架，再继续」。本仓库此前无 `memory/`，
却有四套各自演化的记忆文件，导致同一事实多处表述、新旧冲突（详见 `risk_log.md` R01/R02）。
本目录用于**收口**，不是替换现有文件。

## 二、归口原则（唯一事实源 + 分层，不是四套并列）

| 文件/目录 | 只写什么 | 地位 |
|---|---|---|
| `memory/project_memory/business_rules.md` | **业务口径、判定标准、例外处理** | **唯一准绳**，改口径先改这里 |
| `memory/project_memory/overview.md` | 项目背景、模块、边界 | 长期事实 |
| `memory/project_memory/architecture.md` | 技术架构、关键模块、接口 | 长期事实 |
| `memory/project_memory/risk_log.md` | 风险、未决事项、已确认口径 | 滚动 |
| `memory/project_management/todo.md` | 待办、优先级、backlog | 滚动 |
| `memory/project_management/progress.md` | 进度、验收证据、交接确认 | 滚动 |
| `memory/agent_memory/*/README.md` | 按 Agent 类型的细化工作规矩 | 长期规矩 |
| `AGENT必读.md` | **第一入口**：API 契约速查 + 任务看板 + 工程纪律 | 工程执行索引（从上述口径派生，保留其历史详尽记录） |
| `项目记忆.md` | 2026-10-24 共享快照 | **已冻结的历史参考**，不再更新 |
| `docs/CODE-WIKI.md` | 完整代码导航 | 派生文档 |
| `.workbuddy/memory/YYYY-MM-DD.md` | **会话工作日志（Append-only）** | 按项目纪律保留，记录「做了什么/关键决策/坑」 |
| `.workbuddy/memory/MEMORY.md` | 跨会话精简索引（≤3000 字） | 索引，不是口径源 |

**判定顺序**：`business_rules.md` > `overview/architecture` > `AGENT必读.md` 看板 > 工作日志 > 代码注释。
文档与代码不一致时**以实际运行代码为准**，并把偏差写入 `risk_log.md`，同时更正文档（SKILL.md §3.1）。

> **与 SKILL.md 字面的差异（已在 R02 登记）**：SKILL.md §七把「把 `.workbuddy/` 当项目事实来源」列为反模式。
> 本项目落地解释是：`.workbuddy/memory/` **不得充当业务口径事实源**，但按 `AGENT必读.md` §7 继续作为
> Append-only 会话日志保留。二者不冲突——反模式针对的是「用日志替代口径」，不是「不许写日志」。

## 三、开工顺序（不可颠倒）

1. 本文件 → 2. `overview.md` → 3. `business_rules.md` → 4. `risk_log.md`
5. `todo.md` → 6. `progress.md`
7. 按任务类型进细化目录：`agent_memory/coding/`（编码/修复/回归）、
   `agent_memory/analysis/`（口径分析/影响评估）、`agent_memory/research/`（调研/PRD/方案比对）

开工前必须确认四件事：口径是否一致 / 本轮任务是否已记入 todo 与 progress /
是否有已知风险或未决 / 本轮结论是否需要收口回写。四项未确认前不动代码。

## 四、收口清单（缺一不可，SKILL.md §四）

- [ ] `progress.md` 追加本轮结论：改了什么、为什么、**验证命令与实际结果**（不写「应该通过」）
- [ ] `todo.md` 更新完成状态；未完成项拆成明确遗留项（含 P1/P2 或 backlog 标记）
- [ ] `risk_log.md`：新增风险/待确认项；已解决项移入「已确认事项」
- [ ] 文档与代码不一致之处一并更正（PRD、更改说明、测试 docstring）
- [ ] 向用户说明：改动是否已提交、提交在哪个分支、是否有未提交内容
- [ ] 按 `AGENT必读.md` §7：看板改状态+日期、追加 `.workbuddy/memory/YYYY-MM-DD.md`、
      跨会话决策提炼进 `.workbuddy/memory/MEMORY.md`

## 五、SKILL.md 的落地映射（跨项目模板偏差，见 R02）

`SKILL.md` 原文描述的是 **Intelligent Capacity System**（Python / FastAPI / pytest / alembic /
`.venv` / `frontend` / `sql_migrations`）。本项目是 **NestJS 10 + TypeORM + React 19 + SQL Server**，
下列命令在本项目**不可用**，等价物如下：

| SKILL.md 原文 | 本项目等价 |
|---|---|
| `.venv\Scripts\python.exe -m pytest tests -q` | `cd app/api && npm run smoke`（147 项契约）、`npm run test:isolated` |
| `python -c "import app.main"` | `cd app/api && npm run ops:startup-check`（真起 API + `/health`） |
| `cd frontend && npx tsc --noEmit` | `cd app/web && npm run typecheck` |
| `sql_migrations/NNN_*.sql` + `sql_migrator.py` | **`app/api/scripts/migrate.ts`**（幂等 DDL，表结构唯一来源）+ `npm run migrate:prod` |
| `app/utils/sql_dialect.py` | 双源兼容靠 Entity 同一套 + 方言敏感套件指向专用 MSSQL 测试库；`desc` 用 `[desc]` |

**修订 SKILL.md 原文属于口径变更，须用户确认后执行**（推荐项见 `risk_log.md` R02）。

## 六、写入纪律

- `business_rules.md` 只写口径，不写实现细节；每条带业务事实 + 代码证据路径。
- `progress.md` 只写有命令与数字的结果；「推断」必须标注。
- `risk_log.md` 每条待决项**必须带推荐项**，否则用户无法拍板。
- 生产/非生产分离、历史兼容、归档优先于删除，按 `SKILL.md` §3.3/§3.4 执行。
- 绝不在 `app/`、会话日志、工具缓存里另建一份长期口径。
