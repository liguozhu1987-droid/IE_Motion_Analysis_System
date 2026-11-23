# AGENT 开发必读 · IE Motion Analysis System

> **第一入口。** 本文件已瘦身为指针；跨 Agent 通用规则见 **[AGENTS.md](AGENTS.md)**，全部项目状态、任务看板、项目记忆、工程规则集中在 **`handoff/`** 交接区，可检索的原子结论在 **`memory-bank/`**。
> 数据库等硬性规则最高优先级文件是根目录 `CLAUDE.md`。

## 接手路线（强制顺序）

1. 读 [CLAUDE.md](CLAUDE.md) —— 数据库边界、33 表白名单、部署流程（§1.5）。
2. 读 [AGENTS.md](AGENTS.md) —— 跨 Agent 通用规则、Memory Bank 四类记忆、启动与收工流程。
3. 扫描 [memory-bank/handoffs/](memory-bank/handoffs/) 中 `status: pending` 的交接单；存在则复述摘要并接手（改 `claimed`）。
4. 读 [handoff/00-交接区入口.md](handoff/00-交接区入口.md) —— 交接区文件地图与 Agent 工作流。
5. 读 [handoff/01-项目记忆.md](handoff/01-项目记忆.md) —— 项目定位、技术栈、数据模型、领域口径。
6. 读 [handoff/02-任务看板.md](handoff/02-任务看板.md) —— 认领任务，开工即改「进行中」并署名。
7. 读 [handoff/04-规则与纪律.md](handoff/04-规则与纪律.md) —— 工程纪律与高频坑。
8. 需要细节口径 / 风险台账 / 历史待办时，再进 [handoff/明细/](handoff/明细/)（业务口径唯一准绳 `project_memory/business_rules.md`）。
9. 需要历史结论时按需检索 `memory-bank/facts/` 与 `memory-bank/decisions/`（命令 `/memory-bank search <关键词>`）。

## 收工义务（强制）

- 更新 [handoff/02-任务看板.md](handoff/02-任务看板.md) 对应任务行的状态与日期；
- 在 [handoff/03-开发记录.md](handoff/03-开发记录.md) 顶部追加本次会话日志（格式见文件头）；
- 新的长期事实 → `memory-bank/facts/`（draft，待人工确认）；方案取舍 → `memory-bank/decisions/`；
- 要交给下一个 Agent → `/memory-bank handoff` 生成 pending 交接单。

## 历史快照

旧工作区（IE_Improvement_Platform，2026-10-24 前）的完整开发手册与项目记忆已归档至 [handoff/归档/](handoff/归档/)，仅供溯源，其中的状态、版本号、账号配置**不再是本仓库的事实**。
