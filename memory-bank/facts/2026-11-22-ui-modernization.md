---
tags: ["前端","现代化","dialog","动效","视频","select"]
status: draft
date: 2026-11-22
source: app/web/src/styles/{workbench,base,shell,ai}.css, app/web/src/ai-segment/AiBatchConfirm.tsx
---

# UI 现代化落地状态（2026-11-22）

- **`transition: all` 全站 0 处**：workbench 14 处、base 1 处、shell 2 处已改为显式属性（color / background-color / border-color / opacity / box-shadow / transform）。
- **模态统一走原生 `<dialog>`**：`AiBatchConfirm` 已改造（去掉手写 `role="dialog"`/`aria-modal`/Esc/焦点管理，保留 v3.27「关闭后焦点归 body」铁律）；**该组件当前未被任何页面引用**（看板 P1-2 未接线），接线时直接可用。`AiSuggestionsPage` 的红线确认框仍是手写 mask，待改。
- **必须保留的两条 CSS**：`dialog:modal { overscroll-behavior: contain }` 与 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain }`（缺任一，滚轮会穿透到页面）。
- **视频**：已加 `preload="metadata"`；`poster` 未做——`sprite.jpg` 是 10×9 网格图不能当封面，需要后端单帧端点。
- **自绘 `<SelectMenu>` 保持不动**：CSS Anchor Positioning 在 Chrome 157（2026-11）才可用、Firefox 不支持；`appearance: base-select` 可用但会放弃原生移动端 picker。
- **语义甄别**：UserMenu 是非模态信息浮层（补 `aria-controls`）；Toolbox 是模态命令面板（`role="dialog"` 正确，未迁原生 dialog）。