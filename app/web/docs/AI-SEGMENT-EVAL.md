# AI 分解评测基线操作指南（P1-4 / 门禁 0c · P0-4）

目的：回答「AI 分解到底准不准」。当前系统只有代理指标（覆盖率/段中位时长），本指南建立
**人工真值 → 量化报告** 的最小闭环，对齐行业验收目标（边界 ±2s 命中 ≥70%、类型准确率 ≥70%、查全率 ≥70%）。

> 路径唯一权威：评测脚本 `app/web/tools/eval-ai-segment.cjs`，真值模板与本文档在
> `app/web/docs/`。仓库根下**没有** `tools/`、`docs/` 副本，别按根路径找。

## 流程（每个工位约 30–60 分钟）

1. **导出候选**：AI 自动分解页 → 载入视频 → 开始分析 → 右上「导出候选JSON」
   （文件名形如 `ai-candidates-L01-ST01-2026-10-26.json`）
2. **人工标注真值**：用标注器 `app/web/tools/label-ai-segment.html`（单文件、零依赖、离线）。
   用 Chrome 直接打开该文件 → 载入视频（默认 `deliverables/ai-segment/real/sample60.mp4`，
   打不开时点「选择视频文件」）→ 按 `N` 在动作切换处切分、按 `1–6` 给每段赋类型（等待/移物/
   目检/拿取/装配/其他）→ 填右上角标注人实名 → 「导出 ground-truth.json」。
   - 标注器**不加载任何 AI 候选**，从工具层面保证真值独立；
   - 帧精确：逐帧（←/→）、0.25×/0.5× 慢放，切点吸附到帧起点；
   - 草稿自动存本机 `localStorage`，误刷新可恢复；
   - 也可手工编辑 `app/web/docs/ai-segment-ground-truth.template.json` 后另存。
   片段级标注即可，**不用逐帧精标**；标 30–60s 代表片段、≥20 段即可满足统计意义。
3. **放置评测输入（门禁自动发现）**：
   ```
   deliverables/ai-segment/eval/candidates.json      # 候选导出
   deliverables/ai-segment/eval/ground-truth.json    # 人工真值
   ```
   也可用 `deliverables/ai-segment/eval/fixtures.json` 指定路径（相对该清单目录）：
   ```json
   { "candidates": "candidates.json", "ground_truth": "ground-truth.json" }
   ```
4. **跑评测（两种等价方式）**：
   ```bash
   # 单命令门禁（推荐；自动落档 + 打印达标项）
   npm run test:eval

   # 直接调用（带结构化 JSON 输出）
   node app/web/tools/eval-ai-segment.cjs <候选.json> <真值.json> --json <报告.json>
   ```
5. 输出报告含：查全/查准、覆盖率、边界误差（中位/P90/±0.5s/±1s/±2s 命中率）、
   类型准确率（严格/宽松双口径）、**时间 IoU（匹配对均值 / 真值最佳均值）**、
   **边界 F1（±100/200/500/1000/2000ms）**、三项验收对照、`达标项 n/3`。
   门禁留档在 `deliverables/gates/eval/ai-segment-YYYYMMDD-HHMMSS.json` 与 `latest.json`。

## 指标口径（v3.60 新增）

| 指标 | 定义 | 读法 |
|---|---|---|
| `temporal_iou.matched_mean` | IoU≥阈值匹配对的平均 IoU | 只衡量「配上的」段重合度；偏高但 recall 低说明漏检多 |
| `temporal_iou.gt_best_mean` | 每条真值对全部候选取最佳 IoU 后求均值（漏检记 0） | 同时惩罚漏检，适合做跨版本对比 |
| `boundary_f1[tol_ms]` | 起点+终点都视为边界点，在 ±τ 内一对一最近匹配后的 P/R/F1 | 小段边界点密度高，@100ms 对小段偏严格；报告同时保留中位/P90 误差 |

- 边界 F1 的 τ 固定为 `100 / 200 / 500 / 1000 / 2000ms`，JSON 中为 `metrics.boundary_f1[]`；
- 改切分算法 / 阈值 / ROI 后，用**同一份真值**对比 `latest.json` 与历史报告的同名字段；
- 真值未标注时这些字段不会出现在报告中（门禁 SKIPPED），**不得用 AI 候选反向生成真值**。

## 标注器自检

```bash
node app/web/test-labeler.cjs
```

无需起 API / 前端服务（标注器用 `file://` 直接加载本地视频），真实 Chrome 运行。
覆盖：视频加载、切分对齐帧、新段强制未标注、键盘赋值（N / 1–6）、导出契约、
占位提示不遮挡画面、无 JS 错误。退出码 0 = 全部通过。

## 与统一门禁的关系

- `npm run test:gate` 的 `eval:ai-segment` 门：**没有真值/候选对时明确 SKIPPED（退出码 78），不计为 PASS**；
  模板占位（`labeler` 仍是「填写标注人姓名」）同样判 SKIPPED。
- `npm run test:eval -- --enforce`：三项验收未全达标则退出码 1。默认只记录基线，不阻断。
- 改规则集 / 切分算法前后各跑一次，用同一份真值对比 `latest.json` 与历史时间戳报告。
- **真值必须由人独立标注**，不得用 AI 候选反向生成真值；否则测的是「人机一致性」不是准确率。
  真值 JSON 属于工位知识资产，建议随工位保留。

## 判读

| 结果 | 处置 |
|---|---|
| 三项全达标 | 当前规则法够用，无需上模型路线（P3 不触发） |
| 边界达标、类型不达标 | 分类阈值/规则需调（对照真值看误判集中在哪类） |
| 查全率不达标 | ROI 未标好或能量阈值不适配该机位 → 先重标操作区再评测 |
| 覆盖率高但查全低 | 候选过碎（一段真值被切成多条）→ 反馈合并回路参数 |

## 注意

- 每次调整 ROI / 检测方式 / 阈值后，用同一份真值重跑即可量化改进幅度。
- 评测输入只进本地 `deliverables/` 留档，不上传；报告里的路径是本机绝对路径，外发前按需脱敏。
- 样本过少（匹配对 < 3）时报告会标 `⚠`；结论仅供参考，不得升级为对客户声明的 ±x%。
