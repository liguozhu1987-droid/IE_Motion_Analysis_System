# AGENTS.md — 本项目所有 Agent 通用规则

> **项目**：IE Motion Analysis System（IE 动作分析 / BOL 工时与改善平台）
> **Memory Bank 规范生效**：Claude Code / Cursor / Cline 等 Agent **必须**遵守本文件。
> 技术细节与运行状态在 `handoff/`，可检索的原子结论在 `memory-bank/`，硬性数据库规则在 `CLAUDE.md`。

---

## 0. 优先级（冲突时按此顺序裁决）

```
CLAUDE.md（数据库硬性规则，需用户书面同意才能改）
  > AGENTS.md（本文件，跨 Agent 通用规则）
  > memory-bank/facts 中 status: confirmed 的条目
  > handoff/明细/project_memory/business_rules.md（业务口径正文）
  > handoff/01~04（速查与看板）
  > SKILL.md 与 .claude/skills/*（工作流说明）
```

发现两级规则冲突：**停止自行推断**，写入 `memory-bank/handoffs/` 的待确认项并向用户报告，等待人工裁决。

## 1. Memory Bank 总原则

记忆分四类，**严格区分，不要混写**：

| 目录 | 只写什么 | 写入权限 |
|---|---|---|
| `memory-bank/facts/` | 长期稳定事实：指标定义、公式、路径、环境约束、已知坑 | **只新建 draft**；改 `confirmed` 必须人工确认 |
| `memory-bank/decisions/` | 「选择 + 理由 + 风险 + 否决项」，追加式，不删旧决策 | 可新建；替代旧决策须标注 `supersedes` |
| `memory-bank/handoffs/` | 跨 Agent 接力单，状态 `pending / claimed / done` | 可新建与改状态 |
| `memory-bank/logs/` | 会话原始草稿，**默认不注入上下文**，仅供回溯 | 自由追加 |

**硬性约束**

1. 不要把聊天碎片直接写进 facts/decisions；必须提炼、结构化、可独立阅读。
2. facts **不复制正文**，只写「结论 + 权威来源指针」（正文仍在 `handoff/明细/` 或代码里）——这是本项目防止多源冲突的第一道闸（历史教训见 `memory-bank/facts/2026-11-22-memory-layering.md`）。
3. 敏感数据：`app/api/.env` 的数据库口令、JWT 密钥 **永不得**写入 memory-bank、logs、聊天记录或任何受版本控制的文件。
4. 所有文件带 YAML frontmatter（`tags` + `status`），文件名 `yyyy-mm-dd-简短主题.md`。
5. **Agent 不执行 git add / commit**；Git 由人工审阅后完成。

## 2. 启动流程（每个会话开始）

1. 读本文件 → 读 `CLAUDE.md`（数据库硬性规则）。
2. 扫描 `memory-bank/handoffs/` 中 `status: pending` 的交接单；存在则**复述摘要并确认接手**，接手时把状态改为 `claimed`。
3. 读 `handoff/00-交接区入口.md` 与 `handoff/02-任务看板.md` 认领任务（开工改「进行中」并署名）。
4. **按需检索** facts / decisions（不要全量读取）；摘要级检索命令见 `/memory-bank search`。

## 3. 收工义务（缺一不可）

- [ ] `handoff/02-任务看板.md` 更新状态 + 日期
- [ ] `handoff/03-开发记录.md` 顶部追加本次会话日志（含验证命令与实际输出）
- [ ] 新结论沉淀：长期事实 → `memory-bank/facts/`（status: draft）；方案取舍 → `memory-bank/decisions/`
- [ ] 需要交给下一个 Agent → `/memory-bank handoff` 生成 pending 交接单
- [ ] 向用户说明：改了什么、当前阻塞、哪些 draft 待人工确认

## 4. 能力入口

通过 `.claude/skills/memory-bank/SKILL.md`（命令 `/memory-bank`）提供：

| 命令 | 用途 |
|---|---|
| `/memory-bank search <关键词>` | 检索 facts + decisions（摘要级，优先 confirmed），有冲突即告警 |
| `/memory-bank new-fact <标题>` | 新建事实草稿（status: draft，待人工确认） |
| `/memory-bank new-decision <标题>` | 新建决策记录 |
| `/memory-bank handoff` | 生成标准交接单（status: pending） |
| `/memory-bank archive-log` | 归档本次会话草稿到 logs |

## 5. 与既有体系的分工（重要）

本项目原有 `handoff/` 交接区与根目录 `SKILL.md` 已存在且有大量正文资产，**不推翻、不双写**：

- **`handoff/`** = 过程与正文（看板、开发记录、业务口径正文、风险台账、历史归档）
- **`memory-bank/`** = 可检索的原子结论（每条一句话结论 + 指针回 handoff 或代码）
- 同一条事实**只有一个正文来源**；facts 里写的是索引卡片，不是正文副本。

## 6. 交付给人工确认的动作

以下必须经用户确认后才可执行：

- 修改 `CLAUDE.md`（含白名单增删）
- 把 facts 从 `draft` 改为 `confirmed`
- 删除或覆盖 `memory-bank/` 下任何 `confirmed` 文件
- 对生产库执行任何非幂等的写操作