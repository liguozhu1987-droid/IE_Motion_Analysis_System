# ADR-AI-SEG-002 · 数据落库裁决（零新表）

> 状态：**Accepted（2026-10-25）** | 作者：高见远（架构师，由总监代录）| 关联：Spec-AI-动作切分 v1.0 §6
>
> **v3.34 补充（不放宽本裁决）**：用户指令「AI 自动分解必须与分解工作台并列，不在工作台内扩展」后，候选层已迁出为独立页 `#/ai-segment/:stationId`。落库结论不变（**仍零新表**），但写入路径改为「独立页直接调既有 `POST /stations/:id/elements/submit`」：按接受顺序累加重排时间链、逐条带 `source='ai_assisted'` + `video_id='ai-segment'`。审计仍走既有 `t_audit_log`（submit 内已记）。

## Background（为什么做这个决策）
清单 §4 建议新建 `ai_job / ai_result / ai_segment / ai_waste_candidate` 四张表。但用户已定「视频不上传」，候选分段无跨会话锚点（换台机视频即失），建表无挂载意义，且违反项目「工具做薄」哲学与表结构唯一来源铁律（`scripts/migrate.ts`）。

## Decision（选择了什么）
- **不新建任何表**。清单四表全部否决。
- `t_element` **新增一列** `source NVARCHAR(16) NOT NULL DEFAULT 'manual'`，值域：`manual`（人工手工记录）/ `ai_assisted`（AI 切分接受后落库）。用于项目闸门要求的 AI 采纳率统计。
- 候选分段、拒绝区间、分析中状态**全部为前端会话内 state**，不持久化（刷新丢失，由 UI 常量提示）。
- 审计复用既有 `t_audit_log`（接受/拒绝动作按其既有 schema 落）。
- **不设任何新增 API 端点**。采纳率统计如需，复用现有只读聚合端点或后续再加，一期不强求。
- 若未来需要候选跨会话（用户要求复现分析），再评估建 `t_ai_job`+`t_ai_segment`——届时**必须**先在 `stations.service.remove()` 事务内补级联删除（工位删除级联铁律，v3.30 已实锤），并在 migrate.ts 登记。

## 代价对比（决策依据）

| 方案 | 新表数 | 跨会话 | 实现成本 | 与铁律 | 结论 |
|---|---|---|---|---|---|
| 清单原案 | 4 | 有（但视频无锚点，实则死数据） | 高（entity/DTO/service/级联/权限） | 撞表结构唯一来源 + 工位删除级联 | 否决 |
| 本方案（0 表 + 1 列） | 0 | 无 | 极低（1 列 + DTO 1 字段 + 提交落值） | 完全合规 | **采纳** |
| 折中（建 1 轻量表 t_ai_segment + 字段镜像） | 1 | 有 | 中 | 需补级联删除 | 一期不必要 |

## Consequences（后果）
**正面**：①零 DDL 风险（生产 synchronize=false，migrate.ts 是唯一来源，加 1 列即可）；②不引入任何新端点/权限点；③工位删除级联链无需改（无新子表）；④采纳率统计免费获得（读 `t_element.source` 聚合）。
**负面**：候选刷新即失，用户中途离开只能「接受并提交」保住成果（已在设计 §12 显性告知）。
**风险**：`source` 列若漏进 DTO 校验/漏落值 → 统计失真 → 在提交 service 与前端 submit payload 双点强制带 `source`。

## 实施约束（写入 Spec）
- `scripts/migrate.ts`：在 `t_element` 建表 DDL 内加 `source NVARCHAR(16) NOT NULL DEFAULT 'manual'`。
- `entities/element.entity.ts`：`source: string` 列。
- `modules/elements/dto.ts`：`SubmitElementsDto` 元素项加 `source?: 'manual'|'ai_assisted'`（全局 ValidationPipe whitelist 要求装饰器齐全）。
- `elements.service.submit`：`video_id` 现有批次级保留；`source` 逐条透传（默认 `manual`）。
- 既有回归 `npm run migrate` + smoke **必须**先跑，确认 143/143 不被加列破坏。
