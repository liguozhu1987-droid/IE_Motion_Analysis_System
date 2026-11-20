# AGENT 开发必读 · IE Motion Analysis System

> **第一入口。** 本文件已瘦身为指针；全部项目状态、任务看板、项目记忆、工程规则集中在 **`handoff/` 交接区**，每个 Agent 的工作进展必须更新到那里（规则见 `handoff/00-交接区入口.md`）。
> 数据库等硬性规则最高优先级文件是根目录 `CLAUDE.md`。

## 接手路线（强制顺序）

1. 读 [CLAUDE.md](CLAUDE.md) —— 数据库边界、30 表白名单、部署流程（§1.5）。
2. 读 [handoff/00-交接区入口.md](handoff/00-交接区入口.md) —— 交接区文件地图与 Agent 工作流。
3. 读 [handoff/01-项目记忆.md](handoff/01-项目记忆.md) —— 项目定位、技术栈、数据模型、领域口径。
4. 读 [handoff/02-任务看板.md](handoff/02-任务看板.md) —— 认领任务，开工即改「进行中」并署名。
5. 读 [handoff/04-规则与纪律.md](handoff/04-规则与纪律.md) —— 工程纪律与高频坑。
6. 需要细节口径 / 风险台账 / 历史待办时，再进 [handoff/明细/](handoff/明细/)（业务口径唯一准绳 `project_memory/business_rules.md`）。

## 收工义务（强制）

- 更新 [handoff/02-任务看板.md](handoff/02-任务看板.md) 对应任务行的状态与日期；
- 在 [handoff/03-开发记录.md](handoff/03-开发记录.md) 顶部追加本次会话日志（格式见文件头）。

## 历史快照

旧工作区（IE_Improvement_Platform，2026-10-24 前）的完整开发手册与项目记忆已归档至 [handoff/归档/](handoff/归档/)，仅供溯源，其中的状态、版本号、账号配置**不再是本仓库的事实**。
