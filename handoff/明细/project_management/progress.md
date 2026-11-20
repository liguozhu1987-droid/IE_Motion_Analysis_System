# 进度与验收证据（progress）

> 滚动维护。**只记实际输出（通过数/失败数），不写「应该通过」**（SKILL.md §3.2）。
> 最近收口：2026-11-18。

## 2026-11-18 · 全面功能评审 + 行业最佳实践对标 + 项目开发记忆治理

### 任务
用户要求：全面评审当前系统功能；对比行业内类似软件的最佳实践功能是否具备；围绕
「视频作业分解效率 / 识别浪费 / 增值非增值分析 / 改善方案建议」四条主线给提升建议；
结合当前系统状态，**按 `SKILL.md` 做好项目开发记忆管理**。

### 本轮结论（3 条）
1. **品类边界**：本系统属「问题发现品类」，不是「标准工时品类」。行业分水岭是
   「能否产出可辩护的标准时间（PMTS 口径）」；本系统 ST 链（实测×评比×宽放）**已完整落库并贯穿
   CT / VA 占比 / 批量导出**，缺的是 PMTS 预定时间码体系（按哲学应砍）。拿 D 层尺子量会误判。
2. **真实短板不是「没有功能」**：是「已有能力散落、未串成可审计闭环、未进常规回归门、
   未提交进版本历史」。本轮共纠正 **7 处**历史文档/成员产出的误记（含 1 处编造字段 `end_ms`）。
3. **QA 裁决 No-Go**：解禁路径 6 步（版本历史 → 门禁基线 → 评测进门 → 断言收口 →
   11 套 UI 串行 → 真机换工况/双库/多实例/critical 依赖），每项须给命令 + 实际通过数/失败数。

### 三条实锤新发现（本轮零代码改动）
- **R13 / P0-1｜浪费占比口径不一致（数值缺陷，非呈现缺口）**：
  `app/api/src/modules/analysis/engine.ts:95,117` 分子 `Number(el.dur_s)`；
  `:190` CT = `Σ Number(el.std_time)`；`:96,119` `pct = dur/ct*100`。
  默认 rating=1.00 / allowance=0.15 时 ST=dur×1.15 → **pct 系统性低估约 13%**；
  `ratioOf:'CT'` 触发器据此判定命中 → **评比/宽放一改，浪费识别结果静默变化**。
- **E15｜采纳幂等缺陷**：`app/api/src/modules/suggestions/suggestions.service.ts:102`
  用 `Date.now()` 生成 `imp_id` → 重复采纳生成重复改善项。改善闭环其余部分
  （`suggestions.service.ts:82-132` 事务+before_ct、`:232` 复测回填 after_ct、
  `improvement.entity.ts:27-29` source/ai_suggestion_id）**均已实现**。
- **R05｜版本历史断裂**：`git log` 仅 1 提交（884b71e / 2026-11-09 init）；
  `git status` **96 文件未提交**（80 在 `app/`，含 `SKILL.md`、`AGENT必读.md`、`migrate.ts`）；分支 `main`。

### 本轮产出（文件）
- 交付报告：`deliverables/系统功能全面评审与行业最佳实践对标_20261118.md`
- 新建统一记忆骨架 `memory/`（10 文件）：
  `project_memory/{README,overview,business_rules,architecture,risk_log}.md`、
  `project_management/{todo,progress}.md`、
  `agent_memory/{analysis,research,coding}/README.md`
- 按 `AGENT必读.md` §7 同步：看板追加 #109、追加 `.workbuddy/memory/2026-11-18.md`、
  提炼进 `.workbuddy/memory/MEMORY.md`

### 验证命令与实际输出
**本轮为只读评审，未运行任何测试、未改动任何生产代码。** 下列数字均为**引用既有基线**，
出处已标注，**未在本轮复跑**，不得写成本轮「已验证」：

| 引用项 | 数值 | 出处 |
|---|---|---|
| 契约冒烟 | 147/0（×2，串行隔离） | `AGENT必读.md` 看板 #102/#104 |
| AI 双线契约 | ai-waste 85/85、ai-suggest 62/62 | 看板 #100/#105 |
| 任务归属契约 | task-scope write 13/13 + read 7/7、wave3 11/11 + UI 12/12 | 看板 #103/#104/#107 |
| 权限与 XSS | 125/125、11/11 | `deliverables/PST-W2-W4-本地门禁落地-20261030.md` |
| 容量与性能 | k6 50VU 11,528 请求 / 8,650 checks / 错误率 0；Lighthouse LCP 1.082s、CLS 0 | `deliverables/PST-W2-W3-容量与浏览器性能-20261030.md` |
| 真人 Chrome UI | Phase2 43/43、批量导出 22/22 | 看板 #71/#72/#102 |
| 真实视频校准 | 391.8s / 1920×1080 / HEVC / 30fps；覆盖 24.5%→95.0%、段中位 0.4→2.9s、碎片 55→0、>3s 空白 28→0、耗时 853→527s | 看板 #90/#91；`deliverables/ai-segment/REAL-VIDEO-TEST-v1.md` |
| 依赖审计 | api **FAIL 10 high / 1 critical**、web PASS | 看板 #69 |

本轮实码复核执行的是只读命令（`grep` / `sed` / `wc` / `git status` / `git log` / `ls`），
关键落点：`engine.ts:43-64,84-137,185-223`、`element.entity.ts:19-32`、
`improvement.entity.ts:14-29`、`WorkbenchPage.tsx:289,1948-1953,2221-2260`、
`batch-export/workbook.ts:262-265,439`、`configuration.ts:131`、`validation.ts:100-106`、
`segmentation.ts:140-145`、`landmark.ts:148`、`useVideoEngine.ts:70`。

### 提交状态（SKILL.md §四要求说明）
- 分支 `main`；最近提交 `884b71e`（2026-11-09 init），**仅 1 个提交**。
- 评审取样时点 **96 个文件未提交**（80 在 `app/`，含 `SKILL.md`、`AGENT必读.md`、`migrate.ts`）；
  本轮新建 `memory/`、主报告、日志后复核实测 **98**。三者均为**成文时点快照**，不是完成判据
  —— 0b 判据为 `git status --porcelain` 为空 ＋ 已打 tag ＋ tag 含 `scripts/gates/`，**禁止按文件数核对**。
- Phase 2 / Phase 3 全部成果不在版本历史内。
- 本轮新增/修改的记忆与报告文件**同样未提交**（按要求如实说明，未擅自 commit）。
- 建议下一步先做一次**基线提交 + tag**（不改动任何代码），再按模块分批提交。

### 下一步（≤3 条）
1. 按 QA 解禁路径 ① 做基线提交 + tag，并补一次门禁基线留档。
2. 三道单向门方向确认（见报告 §决策卡；决策 B 在 P0-0/P0-4 落地前不得进入实现与验收）。
3. P0-0~P0-4 与 E15 按 `todo.md` 顺序推进；P0-1 须先写会红的测试再修。

### 待决策 / 已确认（2026-11-19 更新）
| 决策 | 结果 |
|---|---|
| A 全 B 双手要素是否拆左右手 | ✅ **A1 维持现状**（2026-11-19 用户确认），分析页标注「双手要素未拆手，双手图仅供参考」 |
| B 样本精度是否出可复现证据 | ✅ **B2 分层**（2026-11-19 用户确认；旧文写作 B1，统一为 B2）：界面只标 N，内部评测/校准报告才声明 ±x% 与「样本不足判不可靠」。**硬前置 P0-0 + P0-4** |
| C 是否做 PMTS 标准工时 | ⏳ **待拍板**：已解释 PMTS（MTM/MOST/MODAPTS/GSD 的预定时间标准）；推荐 **C1 明确不做**，ST 锁定「实测×评比×宽放」 |
| D 是否修订 `SKILL.md` 原文（跨项目模板错配，R02） | ✅ **已完成**（2026-11-19 用户确认）：按本项目模板重写，旧跨项目内容已清空；验证命令/反模式改为 NestJS+React+SQL Server 口径 |

## 2026-11-18 续 · QA 解禁路径 0a 落地（门禁执行器）

### 改了什么
- 新增 `scripts/gates/`：`run-gates.cjs`（串行执行、PASS/FAIL/SKIP、报告落盘）、
  `gates.config.cjs`（fast/full 清单与解析器）、`check-no-native-select.cjs`、
  `check-repo-traceability.cjs`（0b 三项判据）、`run-eval-gate.cjs`（评测进门 + 留档）。
- `package.json` / `app/api/package.json` / `app/web/package.json`：新增 `test:gate`、
  `test:gate:full`、`test:eval`（统一委托根执行器，无第二套逻辑）。
- `app/web/tools/eval-ai-segment.cjs`：新增 `--json <report.json>`（结构化指标留档）与
  `--gate`（三项验收未全达标退出 1）；默认输出与退出语义保持不变。
- `app/web/docs/AI-SEGMENT-EVAL.md`：统一 `app/web/...` 全路径；补评测输入放置、门禁命令、
  SKIP 语义与真人标注纪律。
- `app/api/test/smoke.ts`：**测试侧缺陷修复**——`cmpStationId`/`vaStationId` 各自随机
  `L01-ST10..99`，约 1/90 撞号导致「单版本工位对比 → 409」偶发 200。改为进程内
  `uniqueStationId()` 去重（test-only，不改生产代码）。

### 验证命令与实际输出
| 命令 | 实际输出 |
|---|---|
| `node scripts/gates/run-gates.cjs`（0b 前） | **PASS**；阻断门 7/7 通过：api:typecheck 1/0、web:typecheck 1/0、CSS 未定义 0、desc-hints 6/0、原生 select 0（69 文件）、batch-export 17/0、smoke **147/0（双遍）**；eval **SKIPPED**（无真值/候选）；repo:traceability **FAIL 0/3**（advisory，当时 0b 未达成） |
| `npm run test:gate -- --no-report` | **PASS**；7/7 阻断门通过（证明 npm 单命令接线可用） |
| `node scripts/gates/check-repo-traceability.cjs`（0b 后 strict） | `TRACE_DIRTY_COUNT=0`、`TRACE_TAGS=baseline-2026-11-19`、`TRACE_TAG_WITH_GATES=baseline-2026-11-19`、`TRACE_GATE_FILES_IN_TAG=5/5`、`TRACE_CHECKS=3/3` → **PASS** |
| `npm run test:gate -- --no-report`（tag 后复核） | **PASS**；阻断 7/7；`repo:traceability` **通过 3 / 失败 0**；eval **SKIPPED(78)** |
| `node .temp-probe/export-ai-candidates.cjs`（一次性 UI 导出） | 候选 **20 条**，覆盖 0–60066ms；类型 移物9/目检7/拿取3/装配1；`detector=motion`、`roi_calibrated=false`；落盘 `deliverables/ai-segment/eval/candidates.json` |
| `npm run test:eval`（真值模板未标注） | **SKIPPED**；`EVAL_REASON=真值 segments 为空`，退出码 **78**（不冒充通过） |
| `node app/api/test/isolated-run.cjs --repeat 2 smoke` | 147/0、147/0；一致性 PASS、清理 PASS、正式库/storage 指纹未变化 |
| `node scripts/gates/run-eval-gate.cjs` | `EVAL_SKIP=1`，退出码 **78**（不冒充 PASS） |
| 评测脚本合成夹具自测（临时、非基线） | 可生成 JSON；`EVAL_ACCEPTED=2/3`；`--enforce` 退出 1；模板占位/测试夹具均 SKIP；合成报告已删除，未留 latest |

**基线报告**：`deliverables/gates/gate-report-20261119-070834.json` / `.md`
（另保留 `gate-report-20261118-231855` 的失败报告作为 flake 证据）。

### 提交状态（如实说明）
- **0b ✅（2026-11-19）**：基线提交 `0a72733` + tag `baseline-2026-11-19`；执行器、门禁报告与
  Phase 2/3 全量成果同批进入版本历史。tag 后 strict 复核：
  `TRACE_DIRTY_COUNT=0` / `TRACE_TAG_WITH_GATES=baseline-2026-11-19` / `TRACE_GATE_FILES_IN_TAG=5/5` /
  `TRACE_CHECKS=3/3` → **PASS**。
- 本次改动均为 scripts / test / tool / docs，**未改生产代码**；为跑 smoke 已用
  `npx tsc -p tsconfig.json --outDir dist` 重建 `dist`（构建产物不入库）。
- 0b 判据三项：工作区干净 + 已打 tag + **某 tag** 指向含 `scripts/gates/` 全部文件的 commit；
  `repo:traceability` 已把三项固化为可执行门。tag 不要求停在 HEAD（基线后补文档提交不影响追溯）。
- **0c ⛔ 待人工真值**：真实候选已从 AI 分解页导出（**20 条**，`sample60.mp4`，`detector=motion`、
  默认 ROI），落盘 `deliverables/ai-segment/eval/candidates.json`；真值模板 `ground-truth.json`
  已生成（`segments` 为空、`labeler` 占位），待人工标注后跑 `npm run test:eval`。

### 下一步（≤3 条）
1. **0c**：人工标注 `deliverables/ai-segment/eval/ground-truth.json`（`labeler` 填实名、`segments`
   填 ≥20 段；边界取动作起止静止点，**不得参考候选反向生成**），然后跑 `npm run test:eval`；
   首次报告落 `deliverables/gates/eval/`。视频：`deliverables/ai-segment/real/sample60.mp4`。
2. 0c 后按链条推进 P0-0 → P0-4；P0-1 数值修复仍须先写会红的测试并在 0c 基线之后动工。
3. 解禁路径 ①–⑥（断言腐蚀、11 套 UI、双库/多实例、critical 依赖）按 `todo.md` 顺序推进。

## 2026-11-19 · AI 自动分解模块两版评审合并 + 修补清单入库

### 任务
用户要求：对比此前两条独立评审结论，综合为一份修补清单，注入项目记忆与任务清单、记录状态、
设为 Agent 必读，并纠正错误判断、更新各处非最新描述。

### 结论（合并后无硬事实冲突）
1. **本质一致**：浏览器端确定性规则算法（帧差默认 / MediaPipe 可选），只产候选、不自动落库；
   后端无分解推理，仅 ffmpeg 场景切分辅助。
2. **对方增量（经本轮实码复核为真）**：落库丢失 `start_ms` 与真实 `video_id`（审计链断）；
   证据帧 `currentTime ±80ms` 无帧吸附；`confAdj` 死字段；`AiBatchConfirm` 未接入；
   AI 页未走分片上传；hand 类型恒「其他」；写入固定 `rating=1/allowance=0.15` 不判 ST。
3. **本会话增量（对方未覆盖）**：机位漂移/光照突变护栏、主线程逐帧循环性能、1316 行页面违反
   Spec §10、分析结果刷新即丢、循环数人工猜。

### 本轮纠正（唯一实质分歧）
- 「AI 不查词表」过宽 → 修正为：**分类不查词表**（motion 6 类硬编码、hand 恒「其他」）；
  **描述模板与 SOP 动词查 `motion_standard`**（`AiSegmentPage.tsx:192-204,1172-1174`；
  后端 `stations.service.ts:526-528` 强校验）。
- `motion_standard` 41 类 → **MS1.4 = 14 一级 + 14 二级 = 28 类**；`va_rules` RV3.64 = 44 类。
- 物理验证命令：`node -e` 读取两份 JSON，输出 `level1 14 / subs 14 / total 28`、`va types 44`（本轮实际执行）。

### 产出（文件）
- `AGENT必读.md`：新增 §4.1 修补清单（Agent 必读）+ 看板 #113。
- `memory/project_management/todo.md`：新增 §七 AIS-P0/P1/P2 清单与状态。
- `memory/project_memory/`：`overview.md`（41→28、补确定性规则定位）、`business_rules.md` B1
  （限定词表范围）、`architecture.md`（conf 机制与落库脱钩）、`risk_log.md`（R19–R21 + 已确认条目）。
- `deliverables/AI自动分解模块深度理解_20261119.md`：修订「不查词表」表述并追加修订记录。
- `docs/CODE-WIKI.md`：41 类 → 28 类；`AiBatchConfirm` 标注未接入。

### 验证与提交状态
- **本轮未改生产代码、未跑测试**；仅文档/记忆更新。
- 上述 JSON 计数为唯一下达命令的实际输出；其余为静态读码复核。
- **未提交**（按纪律不擅自 commit）。

## 2026-11-20 · 0c 支撑：帧精确真值标注器（工具，不改生产代码）

### 任务
继续 P0。当前唯一卡点是 0c 需要人工独立标注 ≥20 段真值；手工编辑 JSON 难以逐帧对齐边界。
本轮不代为标注（真值必须由人观看视频生成），交付**标注工具 + 自检**，把 0c 的人工成本降下来。

### 改了什么
- 新增 `app/web/tools/label-ai-segment.html`：单文件、零依赖、离线，`file://` 直接打开。
  - 默认加载 `deliverables/ai-segment/real/sample60.mp4`，打不开可「选择视频文件」；
    **不加载、不显示任何 AI 候选**（工具层面保证真值独立）。
  - 帧精确：切点吸附帧起点（默认 30fps，可改）；←/→ 逐帧、Shift+←/→ ±1s、0.25×/0.5× 慢放。
  - 边界编辑：N 在播放头切分（新段强制未标注，不继承类型）；B 吸附最近边界；
    Del 与下一段合并（异类型合并后清空，强制重标）；Ctrl+Z 撤销。
  - 类型：1–6 快捷键或点击；未标注段在时间轴（斜纹）与列表（琥珀色）高亮。
  - 防坏真值：未填实名 / 存在未标注段 / 起止非法 → 拒绝导出；<20 段二次确认。
  - 草稿按「视频名@工位」存 localStorage，误刷新可恢复。
- 新增 `app/web/test-labeler.cjs`：真实 Chrome 烟测（无服务端依赖）。
- 文档：`app/web/docs/AI-SEGMENT-EVAL.md` 步骤 2 改为标注器流程并补「标注器自检」；
  `deliverables/ai-segment/eval/README.md` 同步。

### 验证命令与实际输出
| 命令 | 实际输出 |
|---|---|
| `node app/web/test-labeler.cjs` | **pass=21 fail=0**。视频 60067ms / readyState 4；N 切分 2 段、切点 5000ms 对齐帧、新段未标注；键盘 4/3 赋类型正确；未填标注人导出被拒；payload 契约 4 项通过；撤销/合并/异类清空/占位遮挡/时长时钟/无 JS 错误全过。截图 `deliverables/ai-segment/shots/labeler.png` |
| 首轮探针（修复前） | 22/0，但截图暴露 `.video-empty { display:flex }` 覆盖 `[hidden]`，占位文字盖在画面上 → 修 CSS 并补断言 |

### 未做 / 仍阻塞
- **0c 仍未闭环**：标注必须由人完成，工具不代标；标注完成后跑 `npm run test:eval`。
- **未提交**（按纪律不擅自 commit）。

### 下一步（≤3 条）
1. 人工用标注器标 `sample60.mp4` ≥20 段 → 导出覆盖 `deliverables/ai-segment/eval/ground-truth.json`
   → `npm run test:eval` 产出首次基线。
2. 0c 通过后按链条推进 P0-0 → P0-4；P0-1 修复仍须先写会红的测试。
3. 可并行评估 AIS-P0-3（motion 阈值配置化）：阈值现硬编码在
   `app/web/src/ai-segment/motion.ts:23-87`（STILL_* / LONG·MICRO_STILL_POINTS / MERGE / CLS），
   需改为读 `motion_standard` 发布版并保留文件兜底可观测。

