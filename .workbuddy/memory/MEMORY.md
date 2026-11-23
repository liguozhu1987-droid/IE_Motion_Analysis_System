# IE 项目记忆（精简索引 · 复核 2026-11-23）
细节见 `.workbuddy/memory/2026-*.md`、`AGENT必读.md`、`memory/`。
**唯一事实源＝`memory/project_memory/business_rules.md`（业务口径）；本文件仅为跨会话索引**。
`.workbuddy/memory/2026-*.md` 是 Append-only 会话日志，不得充当口径源；`项目记忆.md` 已冻结。
落笔前凡涉及字段/行号/数值，**必须实码复核**——历史报告含多处以讹传讹（见下方「7 处误记」）。

## 当前状态（2026-11-23 本轮实机复核，优先于历史快照）
- **版本历史**：`main` 4 提交 `884b71e → 0a72733 → 6eae591 → 0141c78`，tag `baseline-2026-11-19`，HEAD=`0141c78`；11-19 复核时 `git status --porcelain` 为空。本轮仅启动服务、未改代码；git 状态以实查为准。11-18 文档里「仅 1 提交/96 文件未提交/0a 无文件」均为当时快照、已失效。
- **QA No-Go 维持**：0a ✅ 门禁执行器 `scripts/gates/`（run-gates.cjs / gates.config.cjs / run-eval-gate.cjs / check-no-native-select.cjs / check-repo-traceability.cjs；root+api+web 三处 `test:gate`/`test:eval`；`npm run test:gate` 阻断门 7/7 PASS）；0b ✅ 基线提交+tag（strict `TRACE_CHECKS=3/3`，tag 含 gates 5/5）；0c ⛔ 真值缺口——20 条候选已导出 `deliverables/ai-segment/eval/candidates.json`，`ground-truth.json.segments` 为空 → `npm run test:eval` = **SKIPPED(78)**，不得冒充 PASS。标注器已就绪 `app/web/tools/label-ai-segment.html`（离线单文件/不加载候选/帧精确切分/6 类赋值/草稿恢复；自检 `node app/web/test-labeler.cjs`=21/0），须人工标注 ≥20 段、工具不代标。0c 后按 P0-0 → P0-4 推进；发卡≠解禁。
- **服务启动（本轮实测通过，可直接复用）**：
  - API：`npm run start:api`（＝`node dist/src/main.js` @ app/api）→ `127.0.0.1:3001/api`。`/api/health`=200 `{"status":"ok"}`；`/api/ready`=200 `ready/db:up/rules:up/ai.enabled:false`。启动自检 **ok=11 warn=1 fail=0**（唯一 WARN＝SMTP 告警只写日志不发信）。`ai=off`、OIDC 关、自助注册关、METRICS_TOKEN 已配。日志显示监听 `0.0.0.0:3001/api`、可信反代 127.0.0.1。
  - 前端：`cd app/web && node ../node_modules/vite/bin/vite.js --port 5174 --strictPort --host 127.0.0.1`（VITE v6.4.6）→ `127.0.0.1:5174`，首页 200、`/api` 代理 200（代理 target 写死 `http://127.0.0.1:3001`）。
  - DB：远程 `IRSCNYTFINEREPORT.ap.inalfa.local:1433 / CN_AME`（DNS=172.26.2.199，1433 可达）；**非本地 SQL 服务**，本机查不到 MSSQLSERVER 属正常。
  - 本轮变化：`VIDEO_DERIVED_MAX_GB=60GB` 并发 2（旧记忆 90 已失效）；`WEB_DIST=../web/dist` 已找到（旧记忆 WARN 已消）。
- **端口/网络铁律（复发）**：`5173` 被另一项目 `D:\Application\Intelligent Capacity System\frontend` 长期占用 → 本项目必须 `--port 5174 --strictPort`。回环代理 `HTTP_PROXY=127.0.0.1:50410` 使 curl/node fetch 访问本地失败 → 脚本顶部 `delete HTTP(S)_PROXY` + `NO_PROXY=127.0.0.1`，探测加 `--noproxy '*'`。本轮便携版 curl 触发 `Illegal instruction`，改用 PowerShell `Invoke-WebRequest` 验证成功。

## 待决策/评审结论（2026-11-18；正文 `deliverables/系统功能全面评审与行业最佳实践对标_20261118.md`、日志 `2026-11-18.md`；报告通过数均引用既有基线、未复跑）
- **品类边界**：本系统＝问题发现品类（视频→动素→浪费→改善），**非标准工时品类**。ST 链（观测×评比×宽放）已完整落库并贯穿 CT/VA 占比/6-sheet 导出；PMTS（MTM/MOST/MODAPTS/GSD 的 TMU 码）按「工具做薄」**不做**（决策 C）。
- **P0-1 跨引擎口径分裂（功能级漏报）**：`analysis/engine.ts:95-96,117-119` 浪费 pct 分子 `dur_s`（观测）、`:190` CT 分母 `Σstd_time`（标准）→ 默认 k=1.15 时 pct 偏低 13.04%，`:122` `ratioOf:'CT'` 六条阈值（WT02/06/08/10/11/18）漏报。杀手断言＝**等比改 rating/allowance，所有 `wastes.pct` 不变**。修法属口径变更须用户确认：升 RV+publish+`rule_versions` 标记，观测值另加 `involved_obs_s`（零 DDL），不许把 `involved_s` 悄悄改名成 ST。
- **E15**：`suggestions.service.ts:102` 用 `Date.now()` 造 `imp_id` → 重复采纳生成重复改善项；改确定性 hash（tenant/task/station/rule_rv/waste_type/method/sorted element_ids），禁时间戳/自增。其余改善闭环（事务+before_ct/复测 after_ct/状态机溯源）已实现。
- **RV 验收＝四点对齐**：publish 只写 DB，磁盘 `config/rules/*.json` 只读兜底不回写。判据＝publish version(含 bumped)==`getActive(code).version`==`analysis.service.ts:44 rule_versions[code]`==`workbook.ts:101` 导出封面 RV；`source='file'` 须标注；绕过 publish 直写 `t_rule_set`→FAIL。帧基准用 `metadata.mediaTime`、**0 帧偏差**（`currentTime` 可领先 1 帧≈33.3ms）。
- **7 处误记（落笔前必查）**：`end_ms` 是编造字段（element 只有 `start_ms`+`dur_s`+`video_id`）；`AI_ENABLED=false` 只关服务端 LLM（`configuration.ts:131`），浏览器端本地推理/抽帧常开；视频**会进厂内 storage**，人脸匿名化是真缺口；ST 链/置信度三档/证据三帧/改善闭环均已存在；`eval-ai-segment.cjs` 在 `app/web/tools/` 根下无副本。
- QA 终裁链条：`0a → 0b → 0c → P0-0 → P0-4 → 决策 B 发卡`；0b 判据＝git 空+已打 tag+tag 含 gates 全部文件，禁按文件数核对。决策 A 只发卡（推荐 A1 维持现状+标注双手图仅供参考）；B 暂缓。
- `SKILL.md` 描述的是另一个项目（Python/pytest/alembic/.venv，模板错配 R02），**未擅自修订**，待用户确认。

## 铁律
- 工具做"薄"：帮 IE 看出问题（留）／帮管理层管住 IE（砍）；主线"人拆 AI 校"。
- 三层 AI＝规则引擎（LLM 禁产数字）+LLM+人工审核；AI 建议永远待审；模拟值不回写正式 ST；RNVA 只压不删；eliminate_basis≥8 字。CMC 全程 SELECT-only、单一数据源、不可达宁缺勿错。
- 动素 19 类＝VA8+RNVA6+NVA4；检查＝RNVA（客户/规范要求），无依据返检＝NVA。VA 非绝对：操作族默认 RNVA，对象为装入产品的物料/零部件→VA。
- 模块隔离：AI 分解独立页；ai-waste 零 import ai-suggest；element_source ∈ mixed/manual/ai_assisted，幂等/409/缓存按 source 隔离。
- **`migrate.ts` 是表结构唯一来源**；改实体必跑 `npm run migrate:prod` + 真起 API（dist 重建≠进程更新）。实体 length/type 与 DDL 同步（v3.58.1 审计列截断丢 3 月；「Data type 0xE7」＝列短）。**布尔列不写 type**（v3.60 令 DataSource 崩）。新实体注册 `database.module` ENTITIES。
- **禁原生 `<select>`**（复发≥3 轮）：DPI/缩放/transform 下 popup 漂移，CSS 无解。一律自绘 `SelectMenu`（portal+JS 坐标+Flip）；筛选条 `FilterSelect`、类型 `TypeSelect`。验收 `grep -rn "<select" app/web/src` 只剩注释。
- 改 UI 后必跑 `npm run test:css-classes`（TSX 写 className 而 CSS 无定义不报错）。

## 架构与权限
- NestJS+TypeORM+SQL Server `CN_AME`（3001，/api）；React+Vite（hash 路由 `App.tsx parseHash()`）；production+mssql+localhost，无 pm2/Docker，IIS ARR 未验。
- 样式分层 `src/styles/*.css`，`styles.css` 仅 @import；暖灰 #F1EFE9／钢青 #2F5D6C／铜 #B0703C；顶栏锁 48px；图标 `components/Icons.tsx` 单色描边，**禁装饰 emoji**。权限显示 `UserMenu.tsx`+`/me`（仅展示）；全权角色源 `rbac/full-access.ts`。
- 权限三层（v3.55）：RBAC 能否调接口／租户隔离／data_scope 能否看同公司别人的（own/line/tenant/all，非法回落 own）。唯一口径 `stations.service.resolveVisibleStationIds()`＝ACL 三并集 ∪ data_scope；`assertReadable`（读认 viewer）／`assertWritable`（写只认 editor/owner/admin）／`visibleStationIds`（null=不限）。19 处读端点已接；对象级写端点须先反查 station_id。line 分支全程带 tenant_id 防跨租户串号（v3.59.2）；**聚合须在引擎计算前过滤工位**；dashboard 缓存键带可见范围指纹（FNV-1a）。P0-2：`group:read` 保留→数据层收口。

## 坑
- mssql 只认 `@0` 位置参数；裸 SQL 自行转义 `'`；tedious requestTimeout 60000；PUT llm-config 用 snake_case `api_key`。
- 登录限流桶在内存：连跑多套件后假 401 → 重启 API。
- 孤儿端口：Bash 后台壳被回收后 node 占 3001/5173（failed 通知是噪音）。重启前 PowerShell 按端口杀；vite 用 `cd app/web && node ../node_modules/vite/bin/vite.js`。
- `nest build` 锁死 → `npx tsc -p tsconfig.json --outDir dist`；UI 测试禁并行。
- UI 测试：token 条件化注入；React select 用原型 value setter；dblclick 须 clickCount 递进；块选中挂 onPointerDown 须真实鼠标；UI 回归前置 `UPDATE t_ai_llm_profile SET enabled=0` 跑完置回 1 且整段连跑；三元式 `('ai_assisted' as const)`。
- CSS 动画 fill both + to 含 transform → 恒等 matrix 成 fixed 包含层；浮层 createPortal 挂 body；`<video>` 无 Authorization → @Public()+`?token=`。
- 契约 setupStation 按名 purge；清 t_station 按 FK 倒序 finding→issue→batch→station；限流桶经 `x-real-ip` 分桶。

## 回归与现状
- 门禁：`npm run test:gate`（fast，阻断 7/7 PASS）／`test:gate:full`／`test:eval`；执行器唯一 `scripts/gates/run-gates.cjs`+`gates.config.cjs`；报告落 `deliverables/gates/`（含 HEAD/未提交数/tag）；**SKIPPED 不计 PASS**；基线 `gate-report-20261119-070834.md`。
- 基线（2026-10-30）：smoke 147／ai-waste 85／acl-guard 56／dashboard 34 全绿；权限矩阵 125/125、拆包 6/6、k6 50VU 0 错、Lighthouse LCP 1.082s。`test:deps` api FAIL 10 high/1 critical、web PASS；无 CI。烟测 flake 已修（`smoke.ts` test-only `uniqueStationId`）。
- **清库后仅余 ST010**，v341/v343/v344/v351/v353 依赖 L01-ST01/ST11 跑不起来（**严禁 `npm run seed`**）；可跑 ST010 系（v349 22/0，v348 恒定 3 项数据态失败）；缺 ST11 跑 `_setup-st11.cjs`。
- **Phase 2 批量导出（#102，已完成）**：`t_decomposition_task`+`t_task_station`+`element.task_id` 48→96、`DT-LEGACY` 按 (tenant,line) 回填（BJFA1 19/L01 3，单条会违反"任务属单产线"）、MS1.4 `time_bucket` 配置化（**改 JSON 不生效，须走 `/rules/motion_standard/publish` 发布到 DB**）、任务 API/按任务导出+留档/前端任务下拉。验证迁移 11/11、离线 17/17、HTTP 27/27、Chrome UI 43/43、smoke 147/0×2。复跑 `test:batch-export`/`:http`/`:ui`/`phase2-migration-verify.cjs`。
- **Phase 3 任务归属（#103–#108 全部完成）**：`core/task-scope/` 统一上下文（resolveTaskId：显式→校验/唯一→自动/多→409/无→legacy-fallback），写入带 task_id+`taskElementId`（存量 elementId 零改写），读取六模块经 TaskScopeService、engine.ts 未动；`test:task-scope` write 13/13+read 7/7、wave3 11/11、真人 UI 12/12。Wave 2 加列回填清单 `deliverables/Phase3_Wave2_加列回填逐项确认清单.md`（已冻结）。D1–D9 已确认。
- **导出文件名**：服务端 `Content-Disposition.filename*` 是唯一口径（含任务号+时间段）；`downloadFile` 已改为优先解析服务端名（`useServerName`）。
- **隔离回归必须串行**：`test:smoke:isolated` 前后比对 `app/api/storage` 指纹，同期跑 HTTP 契约会 FAIL——守卫正常，非缺陷。
- 遗留：留档无自动清理；UI 11 套串行回归未跑；焦点阈值待产线校准；双手双轨时间线未完成；SQL Server/IIS 生产容量/spike/soak/现场 INP 未跑；生产依赖 10 high/1 critical；部署未开始。
- 用户偏好：中文；重成本；实操反馈细；要求真落地；不可逆 DB 变更前须逐项确认。

## AI 自动分解（2026-11-19 口径合并）
- 必读 `AGENT必读.md` §4.1；任务状态 `memory/project_management/todo.md` §七（AIS-P0/P1/P2）；风险 R19–R21。
- 本质＝浏览器端确定性规则（帧差默认/MediaPipe 可选），只产候选不落库；后端无推理。
- **分类不查词表**（6 类硬编码/hand 恒「其他」）；**描述模板与 SOP 动词查 `motion_standard`**。
- `motion_standard` MS1.4＝28 类（41 为 MS1.0 历史值）；`va_rules` RV3.64＝44 类。
- P0：0c 人工真值／落库保留 `start_ms`+真实 `video_id`（须先定重叠策略）／阈值配置化／机位光照护栏。
