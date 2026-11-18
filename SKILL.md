---
name: project-memory-workflow
description: Intelligent Capacity System 的统一项目记忆与交接工作流：接手任务前按总入口确认业务口径、任务状态与风险；工作中坚持口径优先、代码证据与生产/非生产分类；收口时回写 memory/ 与进度文件。适用于新会话接手、开始编码/分析/调研任务、口径或验收标准变更、任务收口与跨 Agent 交接。
---

# 统一项目记忆与交接工作流

本 skill 把本项目的 Agent 记忆体系与项目管理方式固化为一套可重复执行的流程。
**记忆的唯一事实来源是 `memory/`，不是工具本地缓存、会话日志或代码注释。**

## 一、开工：按总入口读取（顺序不可颠倒）

1. `memory/project_memory/README.md` —— 记忆库总入口与归口原则
2. `memory/project_memory/overview.md` —— 项目背景、模块、边界
3. `memory/project_memory/business_rules.md` —— 业务口径（**唯一准绳**）
4. `memory/project_memory/risk_log.md` —— 风险与未决事项
5. `memory/project_management/todo.md` —— 待办与优先级
6. `memory/project_management/progress.md` —— 当前进度与验收证据
7. 按任务类型进入细化目录：
   - 编码/修复/回归：`memory/agent_memory/coding/README.md`
   - 口径分析/影响评估：`memory/agent_memory/analysis/README.md`
   - 需求调研/PRD/方案比对：`memory/agent_memory/research/README.md`

若 `memory/` 不存在（新克隆仓库），先按 `memory/project_memory/` 与
`memory/project_management/` 的结构创建最小骨架，再继续；**绝不要把长期项目记忆写进
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

### 3.2 证据原则
- 每个结论都要同时给出「业务事实 + 代码证据（`file.py:line`）」。
- “不可达分支 / 死代码”类结论，必须用函数的实际返回值范围或调用链证明，
  **不能只凭注释或函数名推断**。
- 验证用最小命令，并在 `progress.md` 记录**实际输出**（通过数/失败数），不要写“应该通过”。

### 3.3 生产 / 非生产分离（详见根目录 `AGENTS.md`）
| 分类 | 位置 | 要求 |
|---|---|---|
| `PRODUCTION` | `app/`、`database/`、`alembic/`、根配置 | 不随手改，改动需有明确理由 |
| `TEST_ONLY` | `tests/` | 必须有 `# TAG: NON_PRODUCTION` 头 |
| `DEBUG_OR_TEST_ONLY` | 一次性脚本 | 必须带 TAG 头，不得被运行时导入 |
| `ARCHIVED` | `archive/non_production/` | 归档优先于删除，并在 README 中留索引 |

非生产文件头部模板：

```python
# TAG: NON_PRODUCTION
# CATEGORY: TEST_ONLY | DEBUG_OR_TEST_ONLY | ARCHIVED
# STATUS: ACTIVE | ARCHIVED
# SYSTEM_IMPACT: NONE
# DO_NOT_IMPORT_IN_RUNTIME: TRUE
# PURPOSE: <一句话说明>
```

- 清理冗余代码时**归档优先于硬删除**。
- 清理过程中不得顺带重构运行时逻辑。

### 3.4 历史兼容性
- 历史快照、旧版本数据不得被静默覆盖或回溯改写。
- 口径变更必须在交接说明中写明影响范围。
- 新增 DB 默认值、返回字段删除等兼容性动作，优先选择“保留字段形状、只删除不可达分支”。

## 四、收口：回写记忆（缺一不可）

任务完成或阶段性收口时：

- [ ] `progress.md` 追加本轮结论：改了什么、为什么、**验证命令与实际结果**
- [ ] `todo.md` 更新完成状态；未完成项拆成明确遗留项（含 P1/P2 或 backlog 标记）
- [ ] `risk_log.md`：新增风险/待确认项；已解决项移入「已确认事项」
- [ ] 文档与代码不一致之处一并更正（含 PRD、更改说明、测试 docstring）
- [ ] 向用户说明：改动是否已提交、提交在哪个分支、是否有未提交内容

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

## 五、常用验证命令

Windows（本项目默认）：

```bash
.venv\Scripts\python.exe -m pytest tests -q
.venv\Scripts\python.exe -m pytest tests/test_matrix_preview_consistency.py -q
.venv\Scripts\python.exe -c "import app.main"
cd frontend && npx tsc --noEmit
```

- 数据库迁移：`sql_migrations/NNN_*.sql` 由 `app/core/sql_migrator.py` 按数字前缀执行，
  脚本必须幂等（`IF COL_LENGTH(...) IS NULL` 守卫）。
- 测试库为 SQLite、生产库为 SQL Server：涉及方言的 SQL 必须走兼容 helper
  （见 `app/utils/sql_dialect.py`），不要写死 `OUTPUT INSERTED`。

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
- 把 `.workbuddy/`、`.claude/` 本地缓存、工具日志当作项目事实来源。
- 未验证就写「已完成 / 已修复」。
- 用删除代替归档；或在清理任务里顺带改运行时逻辑。
- 只改代码不改文档，导致注释、PRD 与实现长期背离。
