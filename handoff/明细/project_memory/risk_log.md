# 风险与未决事项台账（risk_log）

> 滚动维护。每条待决项**必须带推荐项**（SKILL.md §四）。整理 2026-11-18。

## 〇、时效声明（2026-11-22 核验）

> 本台账是**带日期的历史记录**，正文按「不静默改写」原则保留原貌。下列条目已确认过时，**勿再作为现状引用**：

| 条目 | 过时原因（2026-11-22 实测） | 现行口径 |
|---|---|---|
| **R04** | `AGENT必读.md` 已瘦身为 27 行指针，其看板并入 `handoff/02-任务看板.md`，不存在「表格散落/编号重复」 | 看板见 `handoff/02-任务看板.md` |
| **R10** | 5173 现由**本项目** `app/web` 的 vite 占用（PID 属本仓库），不再是 Intelligent Capacity System | 无需改 5174；本项目 dev 跑 5173 |
| **R05 的「仅 1 提交」** | 当前 `git rev-list --count HEAD` = **14**；R05 已于 2026-11-19 标注闭合 | 见 R05 行末处置说明 |
| **文中对 `AGENT必读.md` 章节/编号（§4.1、#110、§7 等）的引用** | 该文件已瘦身，原详尽内容迁至 `handoff/归档/AGENT必读-本机开发版-2026-11-20.md` 与 `handoff/02-任务看板.md` | 以迁移后的文件为准 |

> 判定依据：以实际运行状态为准（SKILL.md §3.1）；本表只登记**已实测证伪**的条目，未实测者保持原样。

## 一、已确认事项（口径已定，不再讨论）

- Phase 2（分解任务全链路）与 Phase 3（#103–#108 任务归属）**全部完成并验收**，零遗留 DDL。
- **ST 链完整**：`rating/allowance/std_time` 落库、CT 与 VA 占比基于 std_time、导出含三列与公式。不再按「无标准时间」立项。
- **置信度/证据帧/评测基线/VA 可解释性/改善闭环骨架**均已存在；后续只做「复用与串联」，不新建大模块。
- 清库后正式库仅余 ST010；**严禁 `npm run seed`**；缺 ST11 跑 `_setup-st11.cjs`。
- `test:smoke:isolated` 与 HTTP 契约（写 exports 快照）互斥属守卫正常，不是代码缺陷。
- 厂商 ROI 数字（提速 90% / 年省数百万美元）均为厂商自述或内部建模，未经第三方审计，**不得作为投资决策基准**。
- **0a 门禁执行器已落地（2026-11-18）**：`scripts/gates/` + `npm run test:gate`（fast）/`test:gate:full`、
  `npm run test:eval`；首份基线 `deliverables/gates/gate-report-20261119-070834.md`（阻断门 7/7 PASS）。
- **0b 版本历史已补齐（2026-11-19）**：基线提交 `0a72733` + tag `baseline-2026-11-19`，执行器与基线同批；
  strict 复核 `TRACE_CHECKS=3/3`（tag 含 `scripts/gates` 5/5）。
  **这不等于 QA 解禁**：0c（人工真值评测基线）仍未闭环，No-Go 维持。
- **AI 自动分解口径已合并（2026-11-19）**：两版独立评审结论合并，硬事实无冲突；清单见
  `AGENT必读.md` §4.1、`todo.md` §七。纠正：`motion_standard` 当前 MS1.6（MS1.4 为上一版）= **28 类**（41 是 MS1.0 历史值）、
  `va_rules` RV3.64 = **44 类**；**分类不查词表，但描述模板与 SOP 动词查 `motion_standard`**。

## 二、活跃风险

| ID | 风险 | 证据 | 影响 | 推荐项（待用户拍板） |
|---|---|---|---|---|
| **R01** | **四套记忆文件口径冲突、无唯一事实源** | `SKILL.md` 指向不存在的 `memory/`；`AGENT必读.md` / `项目记忆.md` / `docs/CODE-WIKI.md` / `.workbuddy/memory/` 各记一份，历史文档出现「无宽放/评比」「无标准时间」等低估 | 新 Agent 读错口径 → 提出重复建设建议 | **已处置**：本目录建成，`business_rules.md` 为唯一准绳 + 勘误三条。推荐：后续每次评审先做实码复核再下结论 |
| **R02** | **SKILL.md 是跨项目模板，技术栈与验证命令全错配** | 原文写 Intelligent Capacity System / Python / `.venv\Scripts\python.exe -m pytest` / `app.main` / `frontend` / `alembic` / `sql_migrations`；本项目为 NestJS+React+SQL Server；§七把 `.workbuddy/` 列为反模式，与 `AGENT必读.md` §7 冲突 | 按 SKILL.md 跑命令必然失败；治理动作被误判 | **已处置（2026-11-19）**：用户确认修订，`SKILL.md` 已按本项目重写（旧跨项目模板清空）；验证命令改为 `test:gate` / `test:eval` / `smoke:isolated` / `migrate:prod`，反模式纠正 `.workbuddy` 口径 |
| **R03** | **文档路径口径不一致** | 看板/汇报写 `tools/eval-ai-segment.cjs`、`docs/AI-SEGMENT-EVAL.md`，实际在 **`app/web/tools/` 与 `app/web/docs/`**；根 `tools/`、根 `docs/` 下无 | 门/CI 按根路径写会找不到脚本；QA 判「有地基无门」 | **推荐**：统一为 `app/web/...` 全路径，并把该脚本接进单命令回归门 |
| **R04** | **AGENT必读.md 看板结构损坏** | §6 表格在 §7「看板更新规则」之后又散落 `\|57\|…\|108\|` 行；编号重复（两个 57、两个 93）、顺序倒错；看板更新规则夹在表格中间 | 看板不再可读，无法作为进度事实源 | **推荐**：把散落行归回 §6 表格、编号去重、§7 移到表格之后。**本轮未大改，仅按规则追加一行 #109**　【已过期 2026-11-22：AGENT必读已瘦身为 27 行指针，看板在 handoff/02】 |
| **R05** | **版本历史断裂（最高优先级）** | `git log` 仅 1 提交（884b71e / 2026-11-09 init）；`git status` **95 文件未提交**（80 在 `app/`，含 `SKILL.md`、`AGENT必读.md`、`migrate.ts`、deliverables）；分支 main；Phase 2/3 成果无版本历史 | 无法回滚到上一个可用状态；所有「通过数」对应 HEAD 之外代码 | **已处置（2026-11-19）**：基线提交 `0a72733` + tag `baseline-2026-11-19`；`git status` 干净；strict `TRACE_CHECKS=3/3`（tag 含 gates 5/5）。不再按未提交文件数核对　【时效注 2026-11-22：当前提交数 14，本项已闭合】 |
| **R06** | **回归门缺位 / 断言腐蚀** | 无 CI；`eval-ai-segment.cjs` 未证实绑定单命令门；`test-ai-segment` 28/30 中 B2/B10 断言过期；11 套 UI 串行回归未跑；`test-dw-isolation-guard.cjs` 未迁隔离基座；v348 恒定 3 项失败 | 「历史跑过」被误写为「持续已验证」 | **推荐**：按 QA 解禁路径 ②–⑤ 逐条收口；放宽期望须先说明「原期望为何错」并给 Spec 依据 |
| **R07** | **安全依赖与部署** | `test:deps` api **FAIL 10 high / 1 critical**、web PASS；无 CI 拦截；OIDC/IIS-ARR/内网证书未落地；SMTP 告警未配；留档导出无自动清理 | 上线合规不通过 | **推荐**：先清 critical，再逐条 high 带复审日期豁免；接 CI 快门（`perf-security-baseline.mjs`） |
| **R08** | **AI 切分现场泛化未验证** | #90 实证 ROI 写死 0.18–0.78 / 0.30–0.80，换工位须重标复测；光照突变、机位漂移无护栏；MediaPipe 手部在蓝手套场景检出率仅 34.6%（左手 0.3%），已改帧差默认 | 固定 30fps 固定机位全绿 ≠ 换工位可用 | **推荐**：保留帧差默认（勿回切姿态路线）；把「ROI 标定 + 换工位复测」写进上线检查表；补 3 类素材对照 |
| **R09** | **两套时间轴未对齐** | `ai-segment/landmark.ts:148` 用 `frameIndex*SAMPLE_MS`；`video/useVideoEngine.ts:70` 用 `round(currentTime*fps)` | 任何「点数字跳源帧/逐帧工效学」都会静默指错帧（VFR 或非 all-intra 代理） | **推荐**：canonical fps 单一来源 + all-intra 代理前置；实现前不做逐帧打分 |
| **R10** | **5173 端口被另一项目占用** | 2026-11-12 日志：`D:\Application\Intelligent Capacity System\frontend` 的 vite 占 5173（PID 23824），**不是本项目进程，不可擅自 kill** | 直接 `npm run dev` 会漂到不确定端口 | **推荐**：本项目固定 `--port 5174 --strictPort --host 127.0.0.1`；恢复 5173 须先与用户确认　【已过期 2026-11-22：5173 现由本项目 vite 占用，无需改 5174】 |
| **R11** | 进程内状态 / 无 down 脚本 | 登录限流桶、dashboard TTL 缓存、告警 firing 均在进程内；`migrate.ts` 无回滚脚本；无 CI | 多实例失效；迁移只能靠备份回滚 | 推荐：单实例部署（当前）；扩实例前状态外置；每次迁移前 `npm run ops:backup` |
| **R12** | 不可逆决策门（架构评审 D1–D4） | 改 `hand` 语义会破坏 V2 同手链与三轨时间线；改 `std_time` 口径会让 CT/VA/平衡率/收益不可比；对外 ±x% 声明需统计方法背书；PMTS 覆盖 std_time 会污染历史 ST | 做错要重做整个分析体系 | **推荐：本轮一律不做**。若后续要做，逐项确认 + ADR + 双轨并存（不覆盖历史） |
| **R19** | **AI 分解落库丢失源视频基准（审计链断）** | `AiSegmentPage.tsx:661-672` 用 cursor 从 0 重排、完全不用候选 `start_ms`；`:693` 写死 `video_id='ai-segment'`；导出 JSON 有真实时间但落库丢失 | 要素无法回指源帧；点数字跳源帧对 AI 要素不成立 | **推荐（P0，零 DDL）**：落库改用 `r.start_ms` + 真实 `video_id`。**改前须定重叠处理策略**（会触发 `validation.ts:116-131` V2 同手重叠），不得放宽校验 |
| **R20** | **AI 证据帧无精确帧基准** | `AiSegmentPage.tsx:352-362` 用 `currentTime ±80ms` 经验偏移，无 `mediaTime`、无帧吸附 | 证据帧与要素边界有偏差，复核可能看错动作 | **推荐（P1）**：复用 `useVideoEngine.snapToFrameGrid` + `metadata.mediaTime`，判合格＝0 帧偏差 |
| **R21** | **已建能力未接线（死代码/未接入）** | `AiBatchConfirm` 仅被 `ai-segment/index.ts` 导出、页面未引用；`chunkedUpload.ts` 仅 WorkbenchPage 使用、AI 页走单文件 XHR；`motion.ts:121` 的 `confAdj` 赋值后无消费 | 重复实现/功能缺失被误判为「已具备」 | **推荐（P1）**：接入 `AiBatchConfirm` 与分片上传；`confAdj` 要么参与分档（需口径确认）要么删除 |

## 三、行业对标带来的待决策（每条带推荐）

| ID | 待决策 | 推荐项 |
|---|---|---|
| D-A | 是否引入 PMTS 预定时间标准（MTM/MOST/MODAPTS/GSD） | **C 待拍板**：已解释 PMTS 是预定动作时间系统（TMU 码表，非实测）；推荐 **C1 不做**，ST 锁定「实测×评比×宽放」。若客户需要，另立独立导入/导出，不覆盖 `std_time` |
| D-B | 是否把 AI 从 `AI_ENABLED=false` 改为受控灰度 | **先做零 LLM 的规则层闭环**（帕累托、置信透出、改善闭环接线），AI 灰度排在之后 |
| D-C | 是否做逐帧 REBA/RULA 工效学、SMED、OEE | **砍/缓**：偏离「帮 IE 看出问题」主线，且依赖 R09 时间轴前置 |
| D-D | 是否输出 Yamazo 式 ±x% 精度声明 | **已确认 B2（2026-11-19）**：分析页与 6-sheet 导出只写「基于 N 个周期」不给答案；**内部评测/校准报告**才声明 ±x% 与「样本不足判不可靠」；硬前置 P0-0/P0-4 |
| D-E | 是否修订 SKILL.md 原文 | **已处置（2026-11-19）**：`SKILL.md` 已按本项目重写，旧跨项目模板清空 |
| D-F | 全 B（双手）要素是否拆左右手 | **已确认 A1（2026-11-19）**：维持现状，分析页标注「双手要素未拆手，双手图仅供参考」；不改 `hand` 语义 |

## 四、2026-11-18 实码新发现（评审收口补充）

| ID | 发现 | 证据 | 推荐项 |
|---|---|---|---|
| **R13** | **跨引擎口径分裂（本轮最高优先级实码缺陷，功能级漏报，不是展示偏差）** | `engine.ts:95-96,103,117-119,131` 的 dur/sum/involved_s/pct 用 **`dur_s`（观测）**，而 `:190` CT=`Σstd_time`（标准）经 `:194` 传入 → 分子观测、分母标准，默认 k=1.15 时 **pct 偏低 13.04%**。三层影响：① `:122` `ratioOf==='CT'` 阈值也吃这个 pct → **WT02/06/08/10/11/18 本该命中的不命中（漏报）**，浪费清单变短，`suggestions/engine.ts:63` 候选随之减少；② `detectWastes.involved_s`(观测) 与 `suggestions/engine.ts:65` involvedStd(ST)、`:92` est_save_s、`workbook.ts:465` 排序**两个引擎给出两个「涉及时间」**；③ 下游波及浪费命中率/建议候选数/导出帕累托/收益估算四处 | **推荐**：统一 `std_time`；`involved_s` 语义改 ST 属**行为变更**，须升 `waste_triggers` 新 RV + `publish` + `rule_versions` 标记 + 前端/导出同步；`evidence` 的观测值另加 `involved_obs_s`（零 DDL）承载，**不许悄悄改名**。杀手断言＝**等比改 rating/allowance，所有 `wastes.pct` 不变**（修后 `pct=ΣST_in/ΣST_all` 与 k 无关），注入缺陷须变红；边界用例「等待恰占 CT 10% → WT08 命中」。**属口径变更，须用户确认后先改 `business_rules.md` 再改代码；本轮零代码改动** |
| **R14** | `waste_triggers.json` RV1.4 的 `note` 仍自称「6 类浪费触发器」，实际含第 7 类动作浪费 WT15–WT18 | `app/config/rules/waste_triggers.json` 首行 note | 推荐：下次 publish 时同步更正 note 文案，避免口径文档自相矛盾 |
| **R15** | 5 条架构风险须转成**可执行验证项**，否则又是「有资产无门」 | QA 附录 A（2026-11-18）：① 200 但聚合值跨可见范围 = 越权 FAIL；② 改 JSON 不 publish 结果不变、DB 兜底须显式告警；③ 变帧率素材端到端帧对齐走查（≤1 帧）；④ 注入含定量字段的伪造 AI 候选须被拦（含 AI_ENABLED=false）；⑤ 双库各跑一次 + 无 down 即 P0 阻断 + 2 实例状态验证 | 推荐：每条绑定执行器/单命令门并输出 PASS/FAIL + `文件:行`；#④ 做变异定向加固（故意注入缺陷必须有杀手测试变红）；静态审查不算证据，须补行为测试与用户业务确认 |
| **R16** | QA 阈值升级 | 定稿「越权实测」原判据 403/404 不足，存在「接口返回 200 但数据是跨租户全线聚合值」的更隐蔽越权；#90 对照指标（覆盖率/碎片/空白）验不出源帧指针错位 | 推荐：越权判据升级为「200 且聚合值随可见范围变化」；源帧链路补端到端帧对齐走查 |
| **R17** | 门禁前置缺口 | 无 CI、无 down 脚本、迁移前无门禁基线；新增能力无「真实消费者」检查 | 推荐：迁移前先跑门禁基线（无基线则「改坏了」无法判定）；新增能力跑 G12 孤儿能力检查 |
| **R18** | **0c 未闭环（0b 已补齐后的唯一阻塞）** | 0a：`scripts/gates/` + `test:gate` 已落地，阻断门 7/7 PASS（`deliverables/gates/gate-report-20261119-070834.md`）。0b：**已完成**（2026-11-19 基线提交 `0a72733` + tag `baseline-2026-11-19`，strict 3/3）。0c：真实候选已导出（20 条，`sample60.mp4`、`motion`、默认 ROI），但真值 `segments` 仍为空 → `eval:ai-segment` **SKIPPED（78）**，尚无真实评测基线 | No-Go 维持。推荐：人工标注 `deliverables/ai-segment/eval/ground-truth.json`（≥20 段、实名 labeler，不得参考候选反向生成），再跑 `npm run test:eval`；禁止把 SKIPPED 写成 PASS |
| **R06 补** | smoke 随机工位号碰撞导致 flake | 2026-11-18 门禁基线实捕获：`smoke.ts` 的 `cmpStationId` 与 `vaStationId` 各自随机 `L01-ST10..99`，约 1/90 撞号 → cmp 的 v2 提交使 va 工位变成双版本 →「单版本工位对比 → 409」偶发 200（实测 146/1） | **已修复（test-only）**：`uniqueStationId()` 进程内去重；复跑 147/0 ×2。保留失败报告 `gate-report-20261118-231855` 作为证据 |

**QA 最终裁决：No-Go 维持。** 解禁路径（按顺序）：

> **起跑前置 0a → 0b → 0c（QA 附录 E/H 终裁，先于下方 ①…⑥）**：
> **0a** 落地门禁执行器 `scripts/gates/`（实码确认现无文件、两个 `package.json` 无 gate/eval 脚本，
> 「跑 `test:gate`」目前是空指令）→ **0b** `git add -A` 全量提交打 tag →
> **0c** 产出可对比上一版的 `eval-ai-segment.cjs` 首次基线。
> 0a 是 P0-0 / P0-4 共同硬前置；链条终裁 `0a → 0b → 0c → P0-0 → P0-4 → 决策 B 发卡`。
> **0b 可判死三项**：`git status --porcelain` 为空 ＋ 已打 tag ＋ tag 指向 commit 含 `scripts/gates/` 全部文件。
> **禁止按文件数核对**：文档里 95 / 96 / 98 均为各自成文时点快照（本轮新建 memory/、报告、日志后实测 98），
> 该漂移本身即证明「未提交清单」不可核对。
>
> **R05 / R06 / R17 状态更新 2026-11-19（实码复核）**：0a ✅ 门禁执行器已落地
> （`scripts/gates/` 5 文件 + root/api/web 三处 `test:gate`/`test:eval` 脚本）；
> 0b ✅ 基线提交 `0a72733`（141 files）+ tag `baseline-2026-11-19`、strict `TRACE_CHECKS=3/3`、
> 工作区干净；**R05 版本历史断裂已闭合**。0c 仍 ⛔：缺人工真值标注，`test:eval` SKIPPED(78)。
> **QA No-Go 维持**（0c 未出首次可比基线）；本节 ①…⑥ 的「补齐版本历史」项已完成，勿重复执行。

① 补齐版本历史（R05：基线提交+tag）→ ①后插「门禁基线」→ ② 评测资产进单命令回归门（R03/R06）
→ ③ 断言腐蚀收口 + G12 检查 → ④ 11 套 UI 串行回归 → ⑤ 真机换工况三类素材
→ ⑤后加「双库回归 + 多实例验证」→ ⑥ critical 依赖清零并接 CI 快门。
每一项须给「命令 + 实际输出（通过数/失败数）」，不写「应该通过」。

> 维护规则：新增风险/待确认写这里；已解决项移入「已确认事项」并注明日期与证据。
