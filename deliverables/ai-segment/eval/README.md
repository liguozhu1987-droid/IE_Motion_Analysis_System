# 0c 首次评测输入（待人工标注）

## 文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `candidates.json` | ✅ 已由 AI 分解页导出 | 工位 `L01-ST11`，视频 `sample60.mp4`，20 条候选，`detector=motion`，`roi_calibrated=false`（默认 ROI） |
| `ground-truth.json` | ⛔ **待人工标注** | `segments` 为空；`labeler` 仍是占位值，评测门会明确 SKIPPED(78) |
| 视频 | `deliverables/ai-segment/real/sample60.mp4` | 60.07s / 1920×1080 / 30fps / H.264 |

## 人工标注步骤

1. 用播放器（建议 0.5× 慢放）完整看一遍 `sample60.mp4`。
2. 编辑 `ground-truth.json`：
   - 把 `labeler` 改成实际标注人；
   - 在 `segments` 中逐段填 `{ "start_ms": 毫秒, "end_ms": 毫秒, "type": "拿取/移物/目检/装配/等待/其他", "note": "可选" }`；
   - 建议 ≥20 段，边界取动作开始/结束的静止点；
   - **不要**参考或复制 `candidates.json` 的切分来反向生成真值。
3. 保存后运行：

   ```bash
   npm run test:eval
   ```

4. 首次报告会写入 `deliverables/gates/eval/ai-segment-YYYYMMDD-HHMMSS.json` 与 `latest.json`；
   报告含查全/查准、覆盖率、边界误差（中位/P90/±0.5/1/2s 命中率）、类型准确率与 `达标项 n/3`。

## 判读与后续

- 三项验收：边界 ±2s 命中 ≥70%、类型严格准确率 ≥70%、查全率 ≥70%。
- 本次基线刻意使用**默认 ROI + motion 检测**，代表当前默认配置；若先标定 ROI 再导出，需另存候选并注明配置差异，不能混为同一基线。
- 真值必须由人独立标注；否则测的是「人机一致性」，不能用于精度声明。
