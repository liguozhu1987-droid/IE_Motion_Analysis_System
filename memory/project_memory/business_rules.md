# 业务口径（business_rules）· 唯一准绳

> 改口径**先改本文件再改代码**（SKILL.md §3.1）。每条 = 业务事实 + 代码证据。
> 整理：2026-11-18。本轮实码复核修正了三处历史误记，见文末「勘误」。

## A. 产品与 AI 边界

| # | 口径 | 代码证据 |
|---|---|---|
| A1 | 工具做「薄」：帮 IE 看出问题→留；帮管理层管住 IE→砍。审批/追踪/核算/报表/认证一律砍或延后 | `项目记忆.md` §1；`AGENT必读.md` §1 |
| A2 | 主线「人拆 AI 校」；三层 AI = 规则引擎（LLM **禁产数字**）+ LLM 文案 + 人工审核 | `app/api/src/ai/output-sanitizer.ts`；`modules/ai-suggest/calculator.ts`（服务端重算） |
| A3 | **AI 三铁律**：① AI 建议永远「待审」、无直接执行按钮；② 定量结论一律规则引擎算；③ 模拟值绝不回写正式 ST | `modules/ai-suggest/validator.ts` R1–R3；`modules/ai-waste/validator.ts` W1–W3 |
| A4 | AI 分解独立页；`ai-waste` 零 import `ai-suggest`；`element_source ∈ mixed/manual/ai_assisted`，幂等/409/缓存按 source 隔离 | `app/web/src/pages/AiSegmentPage.tsx`；`core/task-scope/` |
| A5 | 切分候选**绝不直接进草稿**（submit 是整版重插）；候选四重形状编码叠加三轨，不加第 4 轨 | `app/web/src/ai-segment/segmentation.ts`；`AiSegmentPage` |
| A6 | AI 写入 = 「封存→开新版→提交纯 AI」三步链，与手工数据按版本隔离 | `AGENT必读.md` 看板 #95 |

## B. 动素与增值判定

| # | 口径 | 代码证据 |
|---|---|---|
| B1 | 动素 19 类 = VA8 + RNVA6 + NVA4；并入公司标准 22 类型后词表共 **41 类**（MS1.x） | `app/web/src/constants.ts`；`app/config/rules/motion_standard.json` MS1.4 |
| B2 | **RNVA（不是 NNVA）**：必要非增值只能压缩不能直接删，全链路符号统一 | `AGENT必读.md` 看板 #50；`va_rules.json` RV1.1 |
| B3 | 检查 = RNVA（客户/规范要求），无依据返检 = NVA；VA 非绝对：操作族默认 RNVA，对象为装入产品的物料/零部件→VA | `business_rules` 历史裁决；`app/api/src/modules/analysis/engine.ts:43-64` |
| B4 | **VA 归类单一来源** = `va_rules` 规则表（可配置 + rv）。改判必须写结构化标记 `[VA改判\|原:x\|新:y\|理由:z\|人:w\|日期]`，无理由后端 V1 拦截；类型变更时前端剥离旧标记 | `app/api/src/modules/elements/validation.ts`；`app/web/src/diff.ts` |
| B5 | 每条要素输出 `va_effective` / `va_confidence` / `va_reason` / `rule_id`；人工改判标 `human`、无匹配规则标 `low` —— **可解释性已有地基** | `app/api/src/modules/analysis/engine.ts:43-64` |
| B6 | `eliminate_basis ≥ 8 字`；E 类（取消）不得施加于 VA 要素 | `modules/ai-suggest/validator.ts` R2；`modules/ai-waste/validator.ts` W2.1 |

## C. 时间、ST 与收益（本轮实码重点校正）

| # | 口径 | 代码证据 |
|---|---|---|
| C1 | **ST = 观测时长 `dur_s` × 评比 `rating` × (1 + 宽放 `allowance`)**；评比用西屋法四因子简化五档（默认 1.00），宽放四档（默认 0.15）；取值优先级 手改 > 批量 > 默认 | `app/web/src/constants.ts:89` `stdTime()`；`app/web/src/pages/WorkbenchPage.tsx:289,2221-2260` |
| C2 | `rating` / `allowance` / **`std_time`** 三列**落库**；DTO 可选；复用要素默认**不连带**评比/宽放（防跨工位 ST 虚假一致） | `app/api/src/entities/element.entity.ts:30-32`；`modules/elements/dto.ts:20-21`；`WorkbenchPage.tsx:1865-1868` |
| C3 | **CT 与 VA/RNVA/NVA 占比一律基于 `std_time`**，不是裸 `dur_s`；异常时长同样按 ST | `app/api/src/modules/analysis/engine.ts:190,192,216` |
| C4 | 批量导出含评比/宽放/ST 三列，说明行明写 ST 公式；`Σ四桶 = ΣST = CT` 三级校验失败不出表 | `app/api/src/modules/batch-export/workbook.ts:262-265,439` |
| C5 | **收益公式固定**：`节省秒数 × 日产量 × 365 × 费率(元/h) ÷ 3600 × 落地率`；费率/日产量**无默认值**，未配置即阻断（不猜） | `app/config/benefit_params.json`；`modules/compare/` |
| C6 | 样本充分性：V3 校验要求循环数 ≥15；交付条「循环/CV 实时引导」（CV>0.15 时须 ≥25） | `modules/elements/validation.ts`；`WorkbenchPage.tsx:1948-1953` |
| C7 | 止点恒等式 `start_ms + round(量化 dur_s × 1000)`；时间量纲统一（起点整数毫秒、时长 10ms 网格） | `modules/elements/validation.ts` V2；`AGENT必读.md` 看板 #82 |
| C8 | 帧级精度按视频实测 fps 吸附（23.976~120），时间码 `mm:ss.mmm`；**负 playbackRate 必抛异常**，倒放一律「点按后退」 | `app/web/src/video/useVideoEngine.ts` |
| C9 | **时间基准不得用变帧率/剪辑过的视频**（行业共识）；不得重复播放同一素材充当新增独立样本 | 行业对标结论，见 `progress.md` 2026-11-18 |

## D. 版本、任务与写入守卫

| # | 口径 | 代码证据 |
|---|---|---|
| D1 | 工位版本 = 复测代数；复测 = version+1 封存旧版；写守卫 `bol_version = station.version`（封存版只读）；空版本 400 护栏 | `modules/stations/stations.service.ts` |
| D2 | 分解任务号 `DT-{YYYY}-{NNN}` 服务端生成、不可变；单任务属单产线；`DT-LEGACY` 按 (tenant, line) 分别回填（BJFA1 / L01） | `modules/decomposition-tasks/`；`AGENT必读.md` 看板 #102 |
| D3 | 任务上下文唯一解析 `core/task-scope/resolveTaskId`：显式→校验 / 唯一→自动 / 多→409 候选 / 无→legacy-fallback；`engine.ts` 纯函数签名逐字不变 | `app/api/src/core/task-scope/`；看板 #103/#104 |
| D4 | `element_id` 48→96；新键含任务号；**存量 elementId 零改写** | `app/api/scripts/migrate.ts` |
| D5 | 导出文件名唯一口径 = 服务端 `Content-Disposition` 的 `filename*`（含任务号+时间段）；前端 `downloadFile` 优先解析服务端名（`useServerName`），CSV 等其它下载不变 | `app/web/src/api.ts`；`app/api/src/modules/batch-export/` |
| D6 | 留档 = 导出行为与产物快照，**不快照业务数据**；复下载是当时快照不重算；GET 导出须显式 `AuditService.record()`（action `export_batch_xlsx`） | 看板 #72/#108 |

## E. 权限、数据与外部系统

| # | 口径 | 代码证据 |
|---|---|---|
| E1 | 权限三层：RBAC 能否调接口 / 租户隔离 / `data_scope` 能否看同公司别人的（own/line/tenant/all，非法回落 own） | `app/api/src/rbac/`；`app/api/src/tenant/` |
| E2 | **唯一口径** `stations.service.resolveVisibleStationIds()` = ACL 三并集 ∪ data_scope；读认 viewer，写只认 editor/owner/admin；**聚合必须在引擎计算前过滤工位**；dashboard 缓存键带可见范围指纹 | `modules/stations/stations.service.ts`；`modules/dashboard/dashboard.service.ts` |
| E3 | **CMC 铁律（最高优先级）**：全程 SELECT-only 绝不写；公司/产线/项目/分配关系以 CMC 为单一数据源（同实例三段名直查零同步）；不可达 → 明确提示**宁缺勿错**，不伪造数据 | `modules/cmc/cmc.controller.ts` |
| E4 | **`migrate.ts` 是表结构唯一来源**；改实体必跑 `npm run migrate:prod` + **真起 API**（dist 重建≠进程更新）；新实体注册 `database.module` ENTITIES；**布尔列不写 type**；实体 length/type 与 DDL 同步 | `app/api/scripts/migrate.ts`；`core/database/database.module.ts` |
| E5 | 规则 DB 优先于文件；**改 JSON 不生效，须走 `POST /rules/:code/publish` 发布到 DB 并升 rv** | `core/rules/rules.service.ts`；看板 #102 MS1.4 坑 |
| E6 | 信息分层：无权限的数据**一律不请求**（避免 403 横幅污染界面）；信息密度按角色三档 | `app/web/src/App.tsx` `ROUTE_PERMISSION` |

## F. 工程纪律（违反 = 返工）

- **禁原生 `<select>`**：Chromium DPI/缩放/transform 下 popup 漂移，CSS 无解；一律自绘 `SelectMenu`（portal + JS 坐标 + Flip）、筛选条 `FilterSelect`、类型 `TypeSelect`。验收 `grep -rn "<select" app/web/src` 只剩注释。
- React 钩子**全在第一个条件 return 之前**；受保护数据 `useEffect` 必须依赖 `user`。
- 改 UI 后必跑 `npm run test:css-classes`（TSX 写 className 而 CSS 无定义无报错）+ 真实 Chrome 截图验证。
- **隔离回归必须串行**：`test:smoke:isolated` 前后比对 `app/api/storage` 指纹；同期跑 HTTP 契约（写 exports 快照）会让总判定 FAIL（守卫正常，非代码缺陷）。
- **清库后仅余 ST010**；`v341/v343/v344/v351/v353` 依赖 L01-ST01/ST11 跑不起来；**严禁 `npm run seed`**（会重新植入种子工位）；缺 ST11 跑 `_setup-st11.cjs`。
- UI 回归前置 `UPDATE t_ai_llm_profile SET enabled=0`，跑完置回 1，且整段连跑；UI 测试**禁并行**。
- 回环代理 `HTTP_PROXY=127.0.0.1:50410`：node fetch/curl 访问 127.0.0.1:3001 报 "fetch failed"；脚本顶部 delete HTTP(S)_PROXY + `NO_PROXY=127.0.0.1`。
- CSS 动画 `fill both` + `to` 含 transform → 恒等 matrix 成 fixed 包含层；浮层 `createPortal` 挂 body。
- `<video>` 无 Authorization → `@Public()` + `?token=`。

## 勘误（2026-11-18 实码复核，纠正历史文档/汇报中的三处低估）

1. **「无宽放/评比/标准时间」是错的**：C1–C4 证明 ST 链已完整落库、贯穿 CT 与 VA 占比、进批量导出。
   真实缺口仅：OT/NT/ST 三段未显式标注、无 PMTS 预定时间码体系、无样本精度声明。
2. **「无要素置信度」是错的**：AI 候选 `segmentation.ts` 有 conf 三档（高≥0.80/中0.55–0.80/低<0.55）
   + 四重形状编码；`engine.ts` 有 `va_confidence`。缺的是正式 `t_element` 无置信列、无低置信优先复核队列。
3. **「无证据帧 / 无可辩护性」是错的**：`AiSegmentPage` 已有起/中/止三帧弹窗；
   `app/web/tools/eval-ai-segment.cjs` + `app/web/docs/AI-SEGMENT-EVAL.md` 已有 IoU 评测基线。
   缺的是把源帧锚点贯穿到分析数字与导出。

4. **「无要素级起止帧」的表述要精确**：`element.entity.ts` 只有 `start_ms`(:19) + `dur_s`(:20) + `video_id`(:27)，
   **不存在 `end_ms` 字段**（`video-derivative.entity.ts:34 frames` 是派生视频总帧数，不是要素级起止帧）。
   真实缺口是「毫秒 → 帧号换算」，且帧基准必须用 `metadata.mediaTime`（`workbench-segment-stop.cjs:119-123`
   实证 `currentTime` 可领先 1 帧 ≈33.3ms），不得用 `currentTime`。
5. **「视频不上传 / 视频不出厂」是错误口径**：`AiSegmentPage.tsx:336-339,567-569` 有 server 视频分支与
   `uploadWithProgress`，`videos/` 有 chunk-upload/derivative → **视频会进厂内 storage**。
   准确声明：「**AI 推理与抽帧在浏览器端完成、帧与候选不上传服务端算力**」(`AiSegmentPage.tsx:7-8,139`)。
   因此**人脸/隐私匿名化是真实缺口**（视频确实落盘），不是「不上传所以无需处理」。
6. **`AI_ENABLED=false` 不等于「AI 校未生效」**：`configuration.ts:131` 只控服务端 LLM 网关；
   `llm-gateway.service.ts:66,81` false 时 503 降级本地模板；「AI 校」= `ai-segment/` 浏览器端本地推理，
   **不经过该开关**。故「人拆 AI 校」主线在默认配置下**完整成立**，关闭的只是 LLM 润色/辅助建议层。
7. **改善闭环已实现，唯一缺陷是采纳幂等**：`suggestions.service.ts:82-132`（事务 + before_ct）、
   `:232`（复测回填 after_ct）、`improvement.entity.ts:27-29`（source/ai_suggestion_id）均在；
   但 `:102` 用 `Date.now()` 生成 `imp_id` → 重复采纳生成重复改善项。修复用确定性键
   `IMP-<hash(tenant_id|task_id|station_id|rule_rv|waste_type|method|sorted(element_ids))>` 前 36 字符，
   事务内先查存命中即跳过，**禁止时间戳/自增序号**；`rule_rv` 参与键＝发布后允许新一轮。

## G. AI 能力边界（交付说明书原文，2026-11-18 定稿，非待决项）

> 本系统 AI 分两层。服务端 LLM 建议/润色层默认关闭（`AI_ENABLED=false`，关闭时降级本地模板；
> 该层不产数字、建议恒待审）。浏览器端本地推理层常开（AI 切分候选、手部检出、帧差运动能量，
> 全程在本机进行，不上传帧、不调服务端算力）。因此「AI 默认关闭」**仅指前者**，
> 不代表产线上没有 AI 在跑。

依据：`core/config/configuration.ts:131`、`ai/llm-gateway.service.ts:66,81`、
`.env` 模板的 `AI_SUGGEST_ENABLED`（独立开关）、`app/web/src/pages/AiSegmentPage.tsx:7-8`。
**不新建劳资告知流程**（按「工具做薄」+ 隐私前置技术措施留、认证流程留痕砍），仅在说明书如实披露。

## H. 已知实码缺陷口径（P0-1，未修，2026-11-18 登记）

`engine.ts:95-96,103,117-119,131` 的 `dur/sum/involved_s/pct` 基于 **`dur_s`（观测）**，
而 `:190` 的 `ct=Σstd_time`（标准）经 `:194` 传入 `detectWastes` → 分子观测、分母标准，
默认 k=1.15 时 pct **系统性偏低 13.04%**。三层影响：
1. `:122` `ratioOf==='CT'` 阈值判定被扭曲（WT02/06/08/10/11/18 实际按约 87% 折算）→ **本该命中的浪费不命中**，
   下游 `suggestions/engine.ts:63` 候选随之减少，属**功能缺陷**不是显示问题；
2. `detectWastes.involved_s`（观测）与 `suggestions/engine.ts:65` `involvedStd`（ST 重算）两套口径 →
   帕累托排序权重与 `est_save_s`/priority/`workbook.ts:465` 收益口径必然打架；
3. 修复后 `pct=ΣST_in/ΣST_all=(k·Σobs_in)/(k·Σobs_all)` **与 rating/allowance 无关**，
   故杀手测试断言应为「**等比修改 rating/allowance，所有 wastes.pct 不变**」，并补「等待恰占 CT 10% → WT08 命中」边界。

**修复口径（后端不得自行改字段名，须签发）**：统一到 `std_time`（CT/VA 三桶与 `workbook.ts:444`
「Σ四桶=ΣST=CT」自检全基于 ST）；`involved_s` 保留同名但语义变更属**行为变更**，须
① 升 `waste_triggers` 新 RV 并 `POST /rules/:code/publish`；② 靠 `analysis.service.ts:44` 的
`rule_versions` 标记结论所用口径；③ 前端 `AnalysisPage`/`AiWastePage` 与 `workbook.ts` 同步。
`evidence` 的 `{dur_s}`/`{sum}` 是给用户看的观测时长，须新增 `involved_obs_s` 可选字段承载（零 DDL），
**不许把观测值悄悄改名成 ST**。

**规则集「两处同步」的正确理解（架构师封版实读 `rules.service.ts`）**：`publish`(`:129`) **只写 DB
`t_rule_set.content` 与 version 列**；磁盘 `config/rules/*.json` 是 `:90` 的**只读兜底资产、不会被回写**。
故「publish 后 DB 与文件 RV 一致」几乎必然为假，**不可作为验收门**（会造出永远变红的假失败）。
正确验收＝**四点对齐**：publish 响应 `version`（含 `bumped`）== `getActive(code).version`
== `analysis.service.ts:44` `rule_versions[code]` == `workbook.ts:101` 导出封面 RV。
`RuleEntry.source:'db'|'file'`(`:32`) 已存在，但响应只透 version 不透 source → DB 预载失败降级到文件时，
结论带旧 RV 却看不出是文件兜底 → `rule_versions`/导出须补 **`rule_sources`**。
`publish` 用 `Date.now()` 作 `rule_set_id`(`:133`)、无幂等键，重复发布会撞车顺延污染版本历史 →
回归夹具须**一次性 publish 并断言 `version`/`bumped`**。

**P0-3 硬前置**：Grep 全 `engine.ts` 无 `basis` 输出，而 `waste_triggers.json` 每个 trigger 带
`basis`(既有/建议) → `detectWastes` 的 `out.push` 须补 `basis: trigger.basis`（零 DDL），
否则「`basis=建议` 不并入收益排序」在当前代码里无法实现。

> 结论口径（跨会话有效）：**本系统短板不是「没有功能」，而是「已有能力散落、未串成可审计闭环、
> 未进常规回归门、未提交进版本历史」。任何新建议先问「能否复用现有地基」。**
> 评审/汇报落笔前必须实码复核——本轮共纠正 7 处文档与成员产出的误记（含 1 处编造字段）。
