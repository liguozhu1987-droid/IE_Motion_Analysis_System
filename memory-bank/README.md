# Memory Bank · 总入口

> 本目录是**可检索的原子结论库**，与 `handoff/`（过程与正文）、`CLAUDE.md`（硬性规则）配合使用。
> 规范见根目录 [AGENTS.md](../AGENTS.md)；命令入口 `/memory-bank`（[SKILL.md](../.claude/skills/memory-bank/SKILL.md)）。

## 目录职责

| 目录 | 内容 | 状态语义 |
|---|---|---|
| [facts/](facts/) | 原子事实：定义、公式、路径、环境约束、已知坑 | `draft` 待人工确认 / `confirmed` 已确认（只读） |
| [decisions/](decisions/) | 方案选择与取舍理由、风险、否决项 | 追加式；替代旧决策用 `supersedes` |
| [handoffs/](handoffs/) | 跨 Agent 接力单 | `pending` / `claimed` / `done` |
| [logs/](logs/) | 会话草稿归档 | 不注入上下文，仅回溯 |

## 文件规范

```markdown
---
tags: ["视频","转码","ffmpeg"]
status: draft            # facts 用 draft|confirmed；handoffs 用 pending|claimed|done
date: 2026-11-22
source: handoff/明细/project_memory/business_rules.md   # 可选：权威正文来源
---

# 标题

一句话结论。

**证据 / 来源**：`file:line` 或文档路径。
**影响**：…
```

## 检索与冲突处理

1. 检索优先级：`status: confirmed` > `draft`；同标签多条结论不一致时**必须告警**，不得自行择优。
2. 命中多条时先给摘要（标题 + 一句话结论 + 路径），用户确认后再展开全文，控制 token。
3. 引用任何记忆内容时**必须标注来源路径**。

## 与其他记忆体系的关系

| 体系 | 定位 | 何时看 |
|---|---|---|
| `CLAUDE.md` | 数据库硬性规则（最高优先级） | 每次会话必读 |
| `AGENTS.md` | 跨 Agent 通用规则 | 每次会话必读 |
| `memory-bank/`（本目录） | 原子结论索引 | 需要历史结论时按需检索 |
| `handoff/00~04` | 交接入口 / 看板 / 开发记录 / 纪律 | 认领任务与收工必看 |
| `handoff/明细/project_memory/` | 业务口径正文、风险台账、架构 | 需要正文与证据链时 |
| `SKILL.md` | 深度工作流（记忆治理的完整方法论） | 做记忆治理本身时 |

> **防冲突铁律**：同一条事实只允许一个正文来源。本目录的 facts 是指针卡片，正文永远在 `handoff/明细/` 或代码里。

## 维护节奏

- 每次会话收工：新增 draft fact / decision（如适用）、更新 handoff 看板与开发记录。
- 定期（建议每轮评审）：人工把 `draft` 审为 `confirmed`；`done` 的交接单超过 30 天可移入 `logs/` 归档。
- 清理过期：只归档、不硬删。