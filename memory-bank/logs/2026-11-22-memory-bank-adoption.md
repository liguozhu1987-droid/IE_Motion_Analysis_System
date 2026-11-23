---
tags: ["会话归档","记忆治理"]
date: 2026-11-22
type: log
---

# 会话归档 2026-11-22 · Memory Bank 落地

> 原始草稿，不注入上下文。结论已提炼到 `facts/` 与 `decisions/`。

## 用户诉求

按「Memory Bank 完整落地操作指南」（AGENTS.md + memory-bank 四分法 + .claude/skills/memory-bank/SKILL.md，纯文件 + Git，无 MCP）完善本项目 Agent 记忆管理，并给出优化点说明。

## 环境现状（执行前）

- 已有：`CLAUDE.md`（硬性规则）、`AGENT必读.md`（指针）、`handoff/00~04`（入口/记忆/看板/开发记录/纪律）、`handoff/明细/`（project_memory 5 文件、project_management 2 文件、agent_memory 3 个 README）、根目录 `SKILL.md`（172 行深度工作流）、`handoff/归档/`（3 份历史快照）。
- 缺失：`AGENTS.md`、`memory-bank/`、`.claude/skills/`。
- 历史风险：`risk_log.md` R01 记录过「四套记忆文件口径冲突、无唯一事实源」。

## 本轮动作

1. 新建 `AGENTS.md`（跨 Agent 入口 + 优先级裁决 + 启动/收工流程 + Memory Bank 四类规则）。
2. 新建 `memory-bank/`：README + facts/decisions/handoffs/logs 四个 README + 3 条 fact + 2 条 decision + 1 条 pending handoff。
3. 新建 `.claude/skills/memory-bank/SKILL.md`（5 个子指令）。
4. 更新 `AGENT必读.md`、`handoff/00-交接区入口.md`、`SKILL.md` 的引用，指向新体系。
5. **未搬迁** `handoff/` 任何正文（风险最低原则，见 decision）。

## 关键设计判断

- 拒绝「全部迁移到 memory-bank」：1600+ 行正文含 file:line 证据，重写风险高，且直接违背 R01 的教训（单一正文来源）。
- 采纳「两层并存 + 指针关联」：handoff 是过程与正文，memory-bank 是原子结论索引。
- facts 只写一句话结论 + 指针，正文永远留在 handoff/明细/ 或代码里。

## 遗留

- `handoff/明细/project_memory/risk_log.md` 中部分条目内容已过时（如 R10 说 5173 被另一项目占用、R05 说只有 1 个 git 提交），属历史记录未改；后续评审时可标注「已过期」。
- 冒烟基线与生产库规则发布副作用未处理 → 已开 `handoffs/2026-11-22-handoff-smoke-baseline.md`（pending）。