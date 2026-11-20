# 0c 首次评测输入（待人工标注）

## 文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `candidates.json` | ✅ 已由 AI 分解页导出 | 工位 `L01-ST11`，视频 `sample60.mp4`，20 条候选，`detector=motion`，`roi_calibrated=false`（默认 ROI） |
| `ground-truth.json` | ⛔ **待人工标注** | `segments` 为空；`labeler` 仍是占位值，评测门会明确 SKIPPED(78) |
| 视频 | `deliverables/ai-segment/real/sample60.mp4` | 60.07s / 1920×1080 / 30fps / H.264 |

## 人工标注步骤

1. 用 Chrome 打开标注器 `app/web/tools/label-ai-segment.html`（单文件、离线、零依赖）。
   - 默认加载 `deliverables/ai-segment/real/sample60.mp4`；打不开时点「选择视频文件」。
   - 空格播放/暂停，0.25×/0.5× 慢放，←/→ 逐帧，Shift+←/→ 跳 1 秒。
   - 在动作切换处按 `N` 切分；把播放头放在某段内按 `1–6` 赋类型（等待/移物/目检/拿取/装配/其他）。
   - 切点不准时按 `B` 把最近边界吸附到播放头；`Del` 与下一段合并；`Ctrl+Z` 撤销。
   - 右上角填标注人实名，然后「导出 ground-truth.json」，移到本目录覆盖模板。
   - 标注器**不加载 candidates.json**，从工具层面保证真值独立。
2. 标注要求：
   - `segments` 建议 ≥20 段，边界取动作开始/结束的静止点；
   - **不要**参考或复制 `candidates.json` 的切分来反向生成真值。
3. 保存后运行：

   ```bash
   npm run test:eval
   ```

4. 首次报告会写入 `deliverables/gates/eval/ai-segment-YYYYMMDD-HHMMSS.json` 与 `latest.json`；
   报告含查全/查准、覆盖率、边界误差（中位/P90/±0.5/1/2s 命中率）、类型准确率与 `达标项 n/3`。

标注器自身可用 `node app/web/test-labeler.cjs` 自检（无需起服务，真实 Chrome，21 项断言）。

## 判读与后续

- 三项验收：边界 ±2s 命中 ≥70%、类型严格准确率 ≥70%、查全率 ≥70%。
- 本次基线刻意使用**默认 ROI + motion 检测**，代表当前默认配置；若先标定 ROI 再导出，需另存候选并注明配置差异，不能混为同一基线。
- 真值必须由人独立标注；否则测的是「人机一致性」，不能用于精度声明。
