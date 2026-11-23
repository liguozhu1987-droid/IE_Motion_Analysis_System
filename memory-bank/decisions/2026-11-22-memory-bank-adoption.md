---
tags: ["记忆治理","规范","架构"]
status: draft
date: 2026-11-22
---

# 决策：在保留 handoff/ 的前提下引入 Memory Bank 四分法

## 目标

让任意 Agent（Claude Code / Cursor / Cline）用统一、低成本的方式读写项目记忆，同时不破坏已有的大量 `handoff/` 正文资产。

## 可选方案

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 全面迁移到 `memory-bank/` | 把 handoff/ 全部内容改写成 facts/decisions | **否决**：1600+ 行正文含大量 `file:line` 证据，重写风险高，且会制造第二份正文 |
| B. 只加 AGENTS.md 指针，不建目录 | 最小改动 | **否决**：没有结构化容器，Agent 无从「按需检索」 |
| C. **两层并存 + 指针关联** | handoff/ 保留为过程与正文；memory-bank/ 为原子结论索引，facts 只写结论+路径 | **采纳** |

## 最终选择

方案 C。分层：

- `CLAUDE.md` 硬性规则 > `AGENTS.md` 通用规则 > `memory-bank/facts(confirmed)` > `handoff/明细/business_rules.md` > `handoff/01~04` > `SKILL.md`
- `handoff/` = 过程与正文（看板、开发记录、口径正文、风险台账）
- `memory-bank/` = 可检索的原子结论（指针卡片）

## 理由

1. 零内容搬迁风险，历史证据链完整保留。
2. 直接针对历史上「四套记忆文件口径冲突」（risk_log R01）的根因：**强制单一正文来源**。
3. 新增的 frontmatter（tags/status）提供了此前缺失的「低成本按需检索」与「draft→confirmed 人工闸门」。

## 风险

- 两层并存可能让人困惑「该写哪」→ 缓解：`AGENTS.md` §5 用一张表定死分工，`memory-bank/README.md` 给出对照表。
- handoff 看板与 handoffs/ 状态可能不同步 → 缓解：明示「看板为准」，handoffs/ 只是单次接力的上下文包。

## 否选项

- 不引入向量/BM25 服务：检索基于文件与 frontmatter，规模（数十条 facts）足够；数据敏感、零后台服务是硬约束。
- 不允许 Agent 自动 git commit：记忆写入一律人工审阅后提交。

## 后续

- 定期把 `draft` 审为 `confirmed`；`done` 交接单 30 天后归档到 `logs/`。
- 若 facts 数量超过 ~100 条再考虑索引文件或 MCP 检索层（底层仍是这些 md）。