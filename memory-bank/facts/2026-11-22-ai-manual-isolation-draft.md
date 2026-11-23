---
tags: ["AI分解","人工分解","版本隔离","草稿","视频"]
status: draft
date: 2026-11-22
source: app/web/src/pages/WorkbenchPage.tsx, app/api/src/modules/elements/elements.service.ts
---

# AI 与人工分解的隔离实现 + 工作台本地草稿

## 口径（用户 2026-11-22 明确）

AI 自动分解与人工分解**独立存在、互不覆盖**；可后续对比，但不得相互替换。

## 实现方式：按版本隔离（沿用 v3.41 设计）

- AI 写入新版本（`AiSegmentPage` 注释：AI 写入一律开新版本，禁止与手工数据混在同一版本）。
- 人工在同一版本提交时，若该版本已含 `source='ai_assisted'` 要素，服务端**拒绝**（`elements.service.ts:143-162`），提示先复测开新版本。
- 因此「独立」= **AI 在旧版封存，人工在新版工作**；对比时按版本 diff。

## 2026-11-22 补齐的引导（此前缺失）

1. 工作台载入含 AI 要素的版本 → 顶部铜色提示条 + 「复测并继续」按钮。
2. 提交被 AI 守卫拦截（409）→ 提示中直接给出复测路径。
3. **复测时本地草稿自动带到新版本**（此前版本号变化会导致草稿不恢复）。

## 本地草稿（未提交内容不丢）

- 键 `ie-wb-draft:<stationId>`，含 `stationVersion / savedAt / elements / cycles / cv`。
- 仅 `draftDirty` 为真时 800ms 防抖写入；提交成功或回干净态即清除。
- 恢复条件：版本一致且草稿非空；恢复时自动并回服务端已有的 AI 要素（AI 成果不可丢）。
- 边界：仅存本机浏览器，换机/清缓存即失效；不跨设备同步。

## 视频鉴权

- 服务端视频 URL 带 `?token=`（access token 15min）。长时间分解会过期 → `video.error.code===2`。
- 2026-11-22：onError 检测到 code 2 且为服务端 URL 时，自动 `refreshTokens()` 一次并恢复播放位置（`netRetriedRef` 防循环）；错误文案按 code 1/2/3/4 细分。

## 版本线（第一层，2026-11-22 落地）

- **线判定**：某版本内要素全部 `source='ai_assisted'` → **A 线**；否则 **M 线**。生产实测每个版本内 AI/manual 不混合，判定可靠。
- **编号**：`M-01` / `A-01` 为**线内序号**（不是 `t_station.version`）。服务端 `stations.versions()` 与 `elements.list()` 返回 `line` + `line_no`。
- **防误写**：工作台打开 A 线版本时，**提交按钮禁用**（「AI 版本不可提交」，Toolbox 同步禁用），只留「复测并继续」。
- **未做（第二层）**：显式 `version_line` 字段 + `t_station.manual_version/ai_version` 独立计数器 + 唯一键加线，需 DDL 与用户同意。当前两条线共用 `t_station.version` 单序列。