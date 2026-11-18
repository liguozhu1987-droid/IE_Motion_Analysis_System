# IE 项目记忆（精简索引 · 最近收口 2026-11-18）
细节见 `.workbuddy/memory/2026-*.md`、`AGENT必读.md`、`memory/`。
**唯一事实源＝`memory/project_memory/business_rules.md`（业务口径）；本文件仅为跨会话索引**，
`.workbuddy/memory/2026-*.md` 是 Append-only 会话日志，不得充当口径源；`项目记忆.md` 已冻结。

## 2026-11-18 全面功能评审 + 行业对标（只读，零代码改动／未跑测试／未 commit）
- **记忆治理**：按 `SKILL.md` 新建 `memory/` 骨架 10 文件（project_memory 5 + project_management 2 + agent_memory 3）。
  **`SKILL.md` 描述的是另一个项目**（Python/pytest/alembic/.venv），跨项目模板错配 R02；**未擅自修订**，登记为待决 D（推荐修 §五验证命令与 §七反模式措辞，须用户确认）。
- **品类边界**：本系统＝问题发现品类（视频→动素→浪费→改善），**非标准工时品类**。ST 链（观测×评比×宽放）已完整落库并贯穿 CT / VA 占比 / 6-sheet 导出；**PMTS（MTM/MOST/MODAPTS/GSD 的 TMU 码）按「工具做薄」哲学应砍，不是欠账**。真实短板＝已有能力散落／未串可审计闭环／未进回归门／未进版本历史。
- **P0-1 跨引擎口径分裂（功能级漏报，非展示偏差）**：`analysis/engine.ts:95-96,117-119` 浪费 pct 分子 `dur_s`（观测）、`:190` CT 分母 `Σstd_time`（标准）→ 默认 k=1.15 时 **pct 偏低 13.04%**；`:122` `ratioOf:'CT'` 六条阈值（WT02/06/08/10/11/18）据此**漏报**，连带污染建议候选与收益估算。杀手断言＝**等比改 rating/allowance，所有 `wastes.pct` 不变**。修法属口径变更须用户确认：升 RV + publish + `rule_versions` 标记，观测值另加 `involved_obs_s`（零 DDL），**不许把 `involved_s` 悄悄改名成 ST**。
- **E15**：`suggestions.service.ts:102` 用 `Date.now()` 造 `imp_id` → 重复采纳生成重复改善项；改确定性 hash 键（tenant/task/station/rule_rv/waste_type/method/sorted element_ids），禁时间戳与自增序号。改善闭环其余部分（事务+before_ct／复测 after_ct／状态机溯源）**均已实现**。
- **RV 验收＝四点对齐，不是「DB 与文件 RV 一致」**：`rules.service.ts:129` publish **只写 DB**，磁盘 `config/rules/*.json` 只读兜底不回写。判据＝publish 响应 version(含 bumped) == `getActive(code).version` == `analysis.service.ts:44` `rule_versions[code]` == `workbook.ts:101` 导出封面 RV；`source='file'` 须显式标注；反作弊＝绕过 publish 直写 `t_rule_set` → FAIL。帧基准用 `metadata.mediaTime`、**判合格 0 帧偏差**（`currentTime` 可领先 1 帧≈33.3ms，1 帧容差会绿灯放过错误）。
- **7 处误记，落笔前必须实码复核**：`end_ms` 是**编造字段**（`element.entity.ts` 只有 `start_ms`+`dur_s`+`video_id`，`video-derivative.entity.ts:34 frames` 是派生视频总帧数）；`AI_ENABLED=false` 只关服务端 LLM（`configuration.ts:131`），浏览器端本地推理/抽帧**常开**；视频**会进厂内 storage**，故人脸匿名化是真缺口；ST 链／置信度三档／证据三帧／改善闭环均**已存在**；`eval-ai-segment.cjs` 在 `app/web/tools/`、根下无副本（R03）。
- **QA 裁决 No-Go**，链条（交付总监终裁）：`0a 门禁执行器 scripts/gates/ → 0b 提交打 tag → 0c 首次基线 → P0-0 → P0-4 → 决策 B 发卡`。0b 判据＝`git status --porcelain` 为空 ＋ 已打 tag ＋ tag 指向 commit 含 `scripts/gates/` 全部文件，**禁止按文件数核对**（文档里的 95/96/98 均是各自成文时点快照）。当前**只发决策 A 卡**（推荐 A1 维持现状 + 分析页标注双手图仅供参考）；**C 直接记录「不做 PMTS」**；B 暂缓。**发卡≠解禁**。
- 主报告 `deliverables/系统功能全面评审与行业最佳实践对标_20261118.md`；看板 `AGENT必读.md` #109；日志 `.workbuddy/memory/2026-11-18.md`。报告中所有通过数均为**引用既有基线、未在本轮复跑**。

## 铁律
- 工具做"薄"：帮 IE 看出问题（留）／帮管理层管住 IE（砍）；主线"人拆 AI 校"。
- 三层 AI＝规则引擎（LLM 禁产数字）+LLM+人工审核；AI 建议永远待审；模拟值不回写正式 ST；RNVA 只压不删；eliminate_basis≥8 字。CMC 全程 SELECT-only、单一数据源、不可达宁缺勿错。
- 动素 19 类＝VA8+RNVA6+NVA4；检查＝RNVA（客户/规范要求），无依据返检＝NVA。VA 非绝对：操作族默认 RNVA，对象为装入产品的物料/零部件→VA。
- 模块隔离：AI 分解独立页；ai-waste 零 import ai-suggest；element_source ∈ mixed/manual/ai_assisted，幂等/409/缓存按 source 隔离。
- **`migrate.ts` 是表结构唯一来源**；改实体必跑 `npm run migrate:prod` + 真起 API（dist 重建≠进程更新）。实体 length/type 与 DDL 同步（v3.58.1 审计列 32→截断丢 3 月；mssql「Data type 0xE7」＝列短）。**布尔列不写 type**（v3.60 令 DataSource 崩，SQLite 隔离测试漏网）。新实体注册 `database.module` ENTITIES。
- **禁原生 `<select>`**（复发≥3 轮）：Chromium DPI/缩放/transform 下 popup 漂移，CSS 无解。一律自绘 `SelectMenu`（portal+JS 坐标+Flip）；筛选条 `FilterSelect`、类型 `TypeSelect`。验收 `grep -rn "<select" app/web/src` 只剩注释。
- 改 UI 后必跑 `npm run test:css-classes`（TSX 写 className 而 CSS 无定义无报错）。

## 架构
- NestJS+TypeORM+SQL Server `CN_AME`（3001，/api）；React+Vite（hash 路由 `App.tsx parseHash()`）；production+mssql+localhost，无 pm2/Docker，IIS ARR 未验。
- 样式分层 `src/styles/*.css`，`styles.css` 仅 @import；暖灰 #F1EFE9／钢青 #2F5D6C／铜 #B0703C；顶栏锁 48px；图标 `components/Icons.tsx` 单色描边，**禁装饰 emoji**。权限显示 `components/UserMenu.tsx` + `/me`（仅展示）；全权角色源 `rbac/full-access.ts`。

## 权限三层（v3.55）
- RBAC 能否调接口／租户隔离／data_scope 能否看同公司别人的（own/line/tenant/all，非法回落 own）。
- 唯一口径 `stations.service.resolveVisibleStationIds()`＝ACL 三并集 ∪ data_scope；`assertReadable`（读认 viewer）／`assertWritable`（写只认 editor/owner/admin）／`visibleStationIds`（null=不限）。19 处读端点已接；对象级写端点须先反查 station_id。
- v3.59.2 line 分支全程带 tenant_id 防跨租户串号。**聚合须在引擎计算前过滤工位**；dashboard 缓存键带可见范围指纹（FNV-1a）。P0-2：`group:read` 保留不撤→数据层收口。

## 坑
- mssql 只认 `@0` 位置参数；裸 SQL 自行转义 `'`；tedious requestTimeout 60000；PUT llm-config 用 snake_case `api_key`。
- 登录限流桶在内存：连跑多套件后假 401 → 重启 API。
- 回环代理 `HTTP_PROXY=127.0.0.1:50410`：node fetch/curl 访问 127.0.0.1:3001 报 "fetch failed"；脚本顶部 delete HTTP(S)_PROXY + `NO_PROXY=127.0.0.1`。
- 孤儿端口：Bash 后台壳被回收后 node 占 3001/5173（failed 通知是噪音）。重启前 PowerShell 按端口杀；vite 用 `cd app/web && node ../node_modules/vite/bin/vite.js`。
- `nest build` 锁死 → `npx tsc -p tsconfig.json --outDir dist`；UI 测试禁并行。
- UI 测试：token 条件化注入；React select 用原型 value setter；dblclick 须 clickCount 递进；块选中挂 onPointerDown 须真实鼠标；**UI 回归前置** `UPDATE t_ai_llm_profile SET enabled=0` 跑完置回 1 且整段连跑。三元式 `('ai_assisted' as const)`。
- CSS 动画 fill both + to 含 transform → 恒等 matrix 成 fixed 包含层；浮层 createPortal 挂 body；`<video>` 无 Authorization → @Public() + `?token=`。
- 契约 setupStation 按名 purge；清 t_station 按 FK 倒序 finding→issue→batch→station；限流桶经 `x-real-ip` 分桶。

## 回归与现状
- **门禁执行器（2026-11-18 续，0a ✅）**：`npm run test:gate`（fast，阻断 7/7 PASS）／`test:gate:full`／`test:eval`；唯一执行器 `scripts/gates/run-gates.cjs` + `gates.config.cjs`；报告落 `deliverables/gates/`（含 HEAD/未提交数/tag）；**SKIPPED 不计 PASS**。基线 `gate-report-20261119-070834.md`。**0b ✅ 2026-11-19 基线提交 + tag `baseline-2026-11-19`；0c 缺人工真值 → No-Go 维持**。烟测 flake 已修（`smoke.ts` 随机工位号撞号，test-only `uniqueStationId`）。
- 基线（2026-10-30）：smoke 147／ai-waste 85／acl-guard 56／dashboard 34 等全绿；权限矩阵 125/125、拆包 6/6、k6 50VU 0 错、Lighthouse LCP 1.082s。`test:deps` api **FAIL 10 high/1 critical**、web PASS；无 CI。
- **清库后仅余 ST010**，v341/v343/v344/v351/v353 依赖 L01-ST01/ST11 跑不起来（**严禁 `npm run seed`**）；可跑 ST010 系（v349 22/0，v348 恒定 3 项数据态失败）。缺 ST11 跑 `_setup-st11.cjs`。
- 批量导出：v3.61 6-sheet MVP／v3.62 `t_batch_export_record` 留档落库／**Phase 2（2026-11-09，看板 #102）分解任务全链路完成**：`t_decomposition_task`+`t_task_station`+`element.task_id`+`element_id` 48→96、`DT-LEGACY` 按 (tenant,line) 回填（BJFA1 19／L01 3，**单条 legacy 会违反"任务属于单产线"**）、MS1.4 `time_bucket` 配置化（**改 JSON 不生效，须走 `/rules/motion_standard/publish` 发布到 DB**）、任务 API、按任务导出+留档、前端任务下拉/创建。验证：迁移 11/11、离线 17/17、HTTP 27/27、Chrome UI **43/43**、smoke 147/0×2、前端门禁全绿。复跑 `test:batch-export` / `:http` / `:ui` / `phase2-migration-verify.cjs`。
- **导出文件名**：服务端 `Content-Disposition` 的 `filename*` 是唯一口径（含任务号+时间段）；`downloadFile` 前端拼名会覆盖掉任务号，已改为优先解析服务端名（`useServerName`），CSV 等其它下载不变。
- **隔离回归必须串行**：`test:smoke:isolated` 前后比对 `app/api/storage` 指纹，同期跑 HTTP 契约（写 `storage/exports` 快照）会让总判定 FAIL——守卫正常，不是代码缺陷。
- **Phase 3 任务归属**：#103/#104（Wave 1，2026-11-09 22:19 ✅ 已验收，零 DDL）：`core/task-scope/` 统一上下文（resolveTaskId：显式→校验/唯一→自动/多→409 候选/无→legacy-fallback），写入侧 submit delete/create 带 task_id + `taskElementId`（存量 elementId 零改写），读取侧六模块经 TaskScopeService、engine.ts 未动；契约 `npm run test:task-scope`（write 13/13 + read 7/7）。#105/#106/#108（Wave 2，2026-11-11 21:40 ✅ 已验收）。**#107（Wave 3，2026-11-11 23:10 ✅ 已验收，无 DB）**：versions()/GET /tasks 按 task 过滤（D1 兼容回落=旧行为）、DiffPage A/B 自绘 SelectMenu + B 侧 baseline_task_id 自动联动 A 侧、「B 侧基准」提示；compare 复用现有端点经 TaskScope，新增引擎文件数=0；`test:wave3:contract` 11/11、真人 Chrome UI 12/12。**Phase 3（#103–#108）全部完成**。D1–D5 已按推荐值确认（Phase3 排期文档）。
- **Wave 2（2026-11-11 20:31 6/6 按推荐确认、即刻执行）**：5 表加列（`t_ai_task.decomp_task_id`、另四表 `task_id`，`NVARCHAR(32) NULL` 无 DEFAULT）+ 6 行按 (tenant,line) 回填 `DT-LEGACY`（原值全 NULL 可逆）+ `UQ_ai_batch_slot` 删旧建新含 task_id + 6 条索引；`t_audit_log` 7731 行零回填。清单 `deliverables/Phase3_Wave2_加列回填逐项确认清单.md`（已冻结）。四发现：t_ai_task 无 station_id 且 0 行 / ai-waste 无缓存键 / 槽位唯一索引缺 task_id 会撞 2601 / GET 导出无审计须显式 record。新决策 D6 action `export_batch_xlsx`、D7 表级快照、D8 不收紧 NOT NULL、D9 保留 #108。
- 遗留：留档无自动清理；UI 11 套串行回归未跑；焦点阈值待真实产线校准；双手双轨时间线未完成；SQL Server/IIS 生产容量、spike/soak、现场 INP 未跑；生产依赖 10 high/1 critical；部署未开始。
- 用户偏好：中文；重成本；实操反馈细；要求真落地；不可逆 DB 变更前须逐项确认。
