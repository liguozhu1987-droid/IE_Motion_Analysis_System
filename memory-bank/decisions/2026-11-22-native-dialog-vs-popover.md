---
tags: ["前端","现代化","dialog","select","决策"]
status: draft
date: 2026-11-22
---

# 决策：原生 dialog 替代手写模态；暂缓 select / anchor 迁移

## 目标

在不破坏现有交互与历史坑修复的前提下，把 UI 原语迁移到平台原生能力。

## 可选方案

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 全部迁原生（dialog + popover + base-select + anchor positioning） | 语义最正 | **否决**：anchor positioning 仅 Chrome 157+ 且 Firefox 不支持；popover 需重做定位，会重蹈「下拉飞走」 |
| B. 只迁 `<dialog>`，其余保持手写 | 模态收益最大、风险最低 | **采纳** |
| C. 不迁，维持手写 | 零风险 | 否决：手写 Esc/焦点管理易漏，a11y 有隐患 |

## 最终选择

方案 B：
- 模态 → 原生 `<dialog>` + `showModal()`（`AiBatchConfirm` 已改）。
- 下拉 `<SelectMenu>` 保持 `getBoundingClientRect + 翻转 + portal`；不迁 popover/anchor。
- UserMenu 保持非模态浮层，只补 `aria-controls`。

## 理由

1. `<dialog>` 自带 top-layer、焦点限制、Esc/返回手势、背景 inert，删除的是**易错的手写代码**。
2. 下拉定位的历史坑（DPI/缩放下漂移、飞走）正是手写方案被引入的原因；popover 定位在缺少 anchor positioning 时会回到同类问题。
3. 浏览器版本约束是硬条件，不能假设内网已升级到 Chrome 157。

## 风险

- 原生 dialog 默认把焦点归还触发元素，与项目 v3.27 铁律冲突 → 已在 `close` 事件里主动 `blur()` 覆盖，并有注释。
- `AiBatchConfirm` 目前未被引用，改造无运行时风险，但**也未经真实页面验证**；接线时须补一次 UI 回归。

## 否选项

- 不引入 popover polyfill / anchor polyfill：增加依赖与包体，内网升级节奏不可控。
- 不全局替换 select：见上。

## 后续

- 浏览器基线确认到 Chrome 157+ 后，可把 SelectMenu 定位迁到 `position-area + position-try-fallbacks`。
- 视频 `poster` 需后端加单帧派生（`ffmpeg -frames:v 1`），前端再加 `poster` 属性。
- `AiSuggestionsPage` 红线确认框迁 `<dialog>`（同 P1 模式）。
- Toolbox 若需要焦点陷阱再迁原生 dialog。