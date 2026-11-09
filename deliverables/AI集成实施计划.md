# IE 改善平台 · AI 集成实施计划（v3.53 候选 · 首批 4 项）

> 状态：**详细实施计划 · 待最终拍板**。本文仅描述"怎么做"，未改动任何源码/表结构/配置。
> 确认范围（用户 2026-10-28）：**P0 三项 + P1 知识库向量化**
> 复用铁律：AI 永远「待审」；LLM 禁产数字（定量一律规则算）；模拟值不回写正式 ST；`AI_ENABLED=false` 时全部降级为本地模板，不阻断主流程。

---

## 0. 总体架构与改动面

- **新建模块 `ai-insight`（NestJS 模块）**：收敛「诊断 / 解读 / 摘要」三类*纯文案*生成。
  - 直接 `@Inject(LlmGatewayService)`（来自 `@Global()` 的 `AiModule`，**无需改 ai.module**）。
  - 复用 `AnalysisService`（ai-suggest 已注入，口径一致）拿工位分析结果。
  - 所有方法：输入=结构化数据，输出=纯文本文案；LLM 失败时降级为模板文案（不抛错阻断）。
- **改 `videos` 模块**：新增场景检测（ffmpeg，零 LLM）。
- **改 `ai-waste` 模块**：知识库加 `embedding` 列 + 向量召回分支。
- **前端**：AiSegmentPage（场景切分候选）、AnalysisPage / ComparePage（一键生成 AI 解读，待审态展示）。

> 改动面最小化：不新建 LLM 调用链、不动 `engine.ts` 计算口径、不动收益公式、CMC 仍只读。

---

## 任务卡 T1 — 分析诊断智能体（P0，analysis + ai-insight）

**目标**：工位分析页一键生成「根因诊断 + 改善方向」自然语言报告（纯文案，不产数字）。

**改动文件**
- 新增 `app/api/src/modules/ai-insight/ai-insight.module.ts` + `ai-insight.service.ts`
- 改 `analysis.controller.ts`：新增 `POST /analysis/:stationId/diagnose`
- 改 `AnalysisPage.tsx`：加「AI 诊断」按钮 + 待审态文案卡

**接口**
```
POST /api/analysis/:stationId/diagnose
→ 200 { report: string, status: 'pending_review', generated_by: 'ai'|'template', model: string }
→ 503 当 AI 未启用/熔断时返回 template 文案（前端当作普通文本，不视为 AI）
```
**关键实现**
1. 注入 `AnalysisService`，调用现有工位分析方法，取：平衡率、瓶颈 seq、VA/RNVA/NVA 占比、双手失衡、浪费列表（`engine.detectWastes` 输出：waste / involved_s / pct / evidence）。
2. 组装 system+user prompt（结构化数据→「请基于以下数据用中文给出根因诊断与 3 条改善方向，不要给出任何具体秒数/金额」）。
3. `llm.chat(messages, { maxTokens: 600, temperature: 0.3 })`；捕获 `ServiceUnavailableException` → 返回规则模板文案（如「NVA 占比 X%，建议优先压缩持住/延迟类浪费」）。
4. **铁律②**：服务端对 LLM 输出再做一次数字剥离校验（参考 ai-suggest `stripNumbers` 思路），确保无数字结论混入。

**回归用例**
- `test-v353-insight.cjs`：AI 关 → 返回 template 且 `generated_by='template'`；AI 开(mock) → 返回文案且不含任何数字；租户隔离（A 租户不能 diagnose B 租户工位）。

**成本**：纯 LLM 文案，单次 ~600 token；mock 可全量回归，零真实费用。

---

## 任务卡 T2 — 对比差异解读（P0，compare/diff + ai-insight）

**目标**：多版本/多工位对比后，LLM 生成差异自然语言解读 + 倒退预警。

**改动文件**
- 改 `ai-insight.service.ts`：加 `interpretDiff(before, after)` 方法
- 改 `compare.controller.ts`：新增 `POST /compare/interpret`（接收两份分析结果或 a/b 标识）
- 改 `ComparePage.tsx`：加「AI 解读差异」按钮

**接口**
```
POST /api/compare/interpret  body { stationId, versionA, versionB }
→ { interpretation: string, regressionWarnings: string[], status:'pending_review' }
```
**关键实现**
1. 复用 compare/diff 现有纯函数结果（前后要素集合差异、VA/NVA 占比变化、瓶颈 seq 变化），作为输入。
2. prompt 强调「若 NVA 占比上升或瓶颈恶化，明确给出倒退预警」。
3. 同样走 `llm.chat` + 模板降级 + 数字剥离。

**回归用例**
- diff 前后 NVA 占比上升 → 输出含「倒退预警」字样；AI 关 → 模板降级。

**成本**：同 T1，低。

---

## 任务卡 T3 — 视频自动场景切分（P0，videos）

**目标**：上传/转码后自动检测镜头切换点，输出候选片段起止，减少人工标记起止（零 LLM 成本）。

**改动文件**
- 改 `videos.service.ts`：加 `detectScenes(file)` 方法（复用 `resolveFfmpeg` + `runCapture`）
- 改 `videos.controller.ts`：新增 `POST /videos/:id/scene-detect`
- 改 `AiSegmentPage.tsx`：展示候选切分点，人工确认后作为分解起止

**接口**
```
POST /api/videos/:id/scene-detect
→ { scenes: [{ start_ms, end_ms, score }], durationS }
→ 无 ffmpeg → 明确报错「服务器未配置 ffmpeg，无法自动切分」（宁缺勿错）
```
**关键实现**
1. `ffmpeg -i file -filter_complex "select='gt(scene,0.3)',showinfo" -f null -` 解析 `showinfo` 的 pts_time 得到切分点（复用 `runCapture` 抓 stderr）。
2. 合并过近切分点（<0.5s 视为噪声），输出候选段。
3. **不自动落要素**：仅给前端候选起止，人工确认后才进分解流程（符合「人拆 AI 校」）。

**回归用例**
- 用现有测试视频 `SH-FA9-A12-PA10-1.mp4` 跑 detectScenes → 返回 ≥1 个候选段且时间合理；无 ffmpeg 环境 → 友好报错。

**成本**：纯 CPU（ffmpeg 本地），零 LLM、零 API 费用。

---

## 任务卡 T4 — 知识库向量化（P1，ai-waste）

**目标**：将 `t_ai_waste_kb` 关键词检索升级为「向量语义召回 + 关键词打分」融合，提升 AI 建议/浪费识别的历史经验命中质量。

**表结构变更（migrate.ts 加列）**
```sql
ALTER TABLE t_ai_waste_kb ADD embedding NVARCHAR(MAX) NULL;  -- 存 JSON 数组（如 384 维），KB 规模小，应用层算余弦
```
> 选型说明：SQL Server 无原生 vector 类型；KB 量小（百~千级），`nvarchar(max)` JSON + 应用层余弦足够，避免引入外部向量库。若后续量大再迁 FAISS/Chroma 本地。

**改动文件**
- 改 `ai-waste-kb.entity.ts`：加 `embedding: string | null`
- 改 `ai-waste.service.ts`：
  - 新增 `embed(text): Promise<number[]>`（embedding 后端：默认本地 Transformers.js `all-MiniLM`；可配置切 Ollama `nomic-embed-text`；**不默认上云**）
  - 改 `searchKb`：在现有「waste_type+3 / 要素类型+2 / 关键词+1 / 本工位+2 / hit_count 加成」打分基础上，新增向量余弦分支（权重 0.4），与关键词分融合排序取 Top6；命中 `hit_count++` 逻辑不变。
  - archive/整理路径（line ~805/819/834 写 keywords 处）同步写 `embedding`。

**接口**：`searchKb` 为内部方法，无新端点；对外行为不变（注入 prompt「历史经验参考」段）。

**回归用例**
- `test-v353-kb-vector.cjs`：整理一条 KB → embedding 列非空；searchKb 对语义相近但关键词不同的查询能召回（验证向量分支生效）；AI 关 / embed 后端缺失 → 退化为纯关键词打分（不影响现有链路）。

**成本**：引入本地 embedding 模型（约 80MB 模型文件，随 SEA 包分发），**零 API 费用**；或复用产线已部署的 Ollama（若已有）。检索在应用层算余弦，KB 量小无性能压力。

---

## 里程碑与依赖

| 序 | 任务 | 依赖 | 估时(人日) |
|---|---|---|---|
| 1 | T3 视频切分 | 无（独立） | 1 |
| 2 | T1 诊断智能体 | ai-insight 模块骨架 | 1.5 |
| 3 | T2 差异解读 | T1 的 ai-insight 骨架 | 1 |
| 4 | T4 知识库向量化 | 无（独立，但需 embed 后端选型确认） | 2 |
| 5 | 前端串联 + 截图验证 | T1-T3 | 1.5 |
| 6 | 回归 + 门禁 | 全部 | 1 |

**建议顺序**：先 T3（零 LLM 风险）+ T4（独立）+ ai-insight 骨架，再 T1/T2，最后前端与回归。

---

## 统一护栏（所有任务必须遵守）

1. `AI_ENABLED=false`（默认）时，T1/T2 返回模板文案、T4 退化为关键词打分、T3 仍可用（无需 AI）。
2. LLM 输出数字剥离（铁律②）；诊断/解读文案标注 `status:'pending_review'`，不回写正式 ST。
3. 租户隔离：diagnose/interpret 必须走 `assertWritable`/`filterVisible` 口径（参考 v3.42/v3.46 双线隔离）。
4. 熔断/降级：复用 `LlmGatewayService` 既有熔断（连续 5 次失败熔断 10 分钟），不另写。
5. 回归前 `UPDATE t_ai_llm_profile SET enabled=0`（避免真实 profile 旁路 mock），跑完置回 1（沿用 v3.48 基线）。

---

## 成本测算汇总

| 任务 | LLM 调用 | API 费用 | 新增依赖/体积 | 风险 |
|---|---|---|---|---|
| T1 诊断 | 每次 ~600 token | mock 零 / 启用后低 | 无 | 低 |
| T2 解读 | 每次 ~500 token | 同上 | 无 | 低 |
| T3 切分 | 无 | 0 | 复用 ffmpeg | 低（CPU） |
| T4 向量化 | 仅 embed | 0（本地） | 本地模型 ~80MB | 中（模型选型/分发） |

**总成本**：无强制云 API 费用；唯一增量是 T4 的本地 embedding 模型体积（可改 Ollama 复用规避）。符合你「重成本、AI_ENABLED 敏感」的偏好。

---

## 上线门禁（沿用产品哲学）

每个功能上线前过「周活≥3 + 采纳≥50%」闸门；未达即砍。所有 AI 产出默认待审，人工确认前不进正式数据。

---

## 待最终拍板

- 是否按此计划进入实施（落地代码）？
- T4 的 embedding 后端：本地 Transformers.js（增 ~80MB 包体）还是复用产线 Ollama（需确认已部署）？
- 前端 AI 文案展示位置是否接受在 AnalysisPage / ComparePage / AiSegmentPage 各加一个「待审」卡片（不进主数据区）？

> 确认后我才开始改代码；本文为实施计划，未落地任何改动。
