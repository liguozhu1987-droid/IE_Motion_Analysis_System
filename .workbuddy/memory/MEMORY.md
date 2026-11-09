# IE Improvement Platform 项目记忆

> 精简版（2026-10-28，v3.56）。细节见 `.workbuddy/memory/2026-*.md` 日志。
>
> **v3.56 前端**：样式已分层 `src/styles/{tokens,base,login,shell,dashboard,legacy}.css`；**v3.60 已把 legacy 拆完**（legacy.css 删除，styles.css 变 12 条 @import）：新增 `workbench.css`(895) / `ai.css`(450) / `settings.css`(112) / `nav.css`(67) / `components.css`(109) / `diff.css`(69) / `help.css`(56)。新增样式必须落到对应层，禁止往单一文件堆。**无 user.css**——用户管理/RBAC 三页已 100% 复用 base.css 通用类。柔和工业风：暖灰 #F1EFE9 / 钢青 #2F5D6C / 铜 #B0703C / 钢板 #1E272D，旧变量 --blue 等保留为别名。**顶栏高度锁 48px**（多处硬编码 calc(100vh - 48px)）。权限显示走 `components/UserMenu.tsx` + 后端 /me 的 dataScope/fullAccess（仅展示，判定仍在服务端）；全权角色单一数据源 `api/src/rbac/full-access.ts`。图标统一走 `components/Icons.tsx`（单色描边 SVG + currentColor），**禁止再用装饰性 emoji**（☰✅❌ 已于 v3.60 清零）。

## 铁律
- 产品哲学：工具做"薄"——帮 IE 更快看出问题（留）／帮管理层管住 IE（砍）；主线"人拆 AI 校"。
- **三层 AI** = 规则引擎（LLM 禁产数字）+ LLM + 人工审核；AI 建议永远"待审"；模拟值不回写正式 ST；RNVA 只压不删。**CMC**：全程 SELECT-only，单一数据源；不可达→宁缺勿错。**AI 三铁律**：永远待审／服务端重算数字／eliminate_basis ≥ 8 字。
- **动素三分法**：19 类 = VA 8 + RNVA 6 + NVA 4。**检查 = RNVA**（用户裁定）：客户/规范要求时属必要非增值须持续改善，无依据返检 = NVA。
- **VA 非绝对**（v3.54）：操作族默认 RNVA，**对象为装入产品的物料/零部件（含借工具按压装配）→ VA**；`vaNote` 须与运行时 `va_rules` 例外同步。
- 模块隔离：AI 分解=独立页；ai-waste 零 import ai-suggest；AI 写入版本隔离；双来源线 `element_source` 三值 mixed/manual/ai_assisted，幂等/409/缓存按 source 隔离。
- **版本铁律**：改实体后必须显跑 `npm run migrate:prod` 再起 API；改后端必须重启服务（dist 重建 ≠ 进程已更新）。
- **实体 length 与迁移 DDL 必须同步改**（v3.58.1 教训：审计 entity 列实体声明 32 与拦截器写 55+ 字符路径不匹配 → TypeORM 生成 NVARCHAR(32) 参数 → TDS 错 → 审计静默丢失 3 个月）；mssql 报「Data type 0xE7 invalid data length」= 某列声明长度 < 实际值长。
- **实体 type 与迁移 DDL 必须同步，且禁写 mssql 不认的类型名**（v3.60 教训：`@Column({type:'boolean'})` 在 mssql 下报 `DataTypeNotSupportedError` → **整个 DataSource 建不起来、API 启动即崩**；DDL 里明明是 BIT。而 `test:*:isolated` 走 SQLite 支持 boolean → 隔离测试全绿漏网）。**布尔列一律不写 type**，交 TypeORM 按方言推断（mssql→BIT / sqlite→BOOLEAN）。教训：隔离测试通过 ≠ 生产 mssql 能起，改实体后必须真起一次 API。
- **禁止原生 `<select>`**（v3.59 复发避坑，已飞走 ≥3 轮）：Chromium 在 DPI/缩放/transform 容器下原生 popup 定位漂移（列表飘到窗口左上角），CSS 无解。任何下拉（**筛选条 / 表单 / 弹窗 / 浮层**）一律用自绘 `SelectMenu`（`src/components/SelectMenu.tsx`：portal 挂 body + JS 算坐标 + 空间不足 Flip 翻转）；筛选条统一走 `FilterSelect`（统一「全部」空值语义）；类型控件用 `TypeSelect`。**新增 UI 不得再写原生 `<select>`**，否则必在某台真实桌面复飞。已收口：DashboardPage(DimSelect)、ImprovementsPage(FilterSelect)、UserManagementPage 筛选行、StationListPage 产线切换、RbacAuditPanel 动作、AiWasteKbPanel 类型。对话框内残留原生 select 已于 **v3.59.1 全部换为 SelectMenu**（ShareDialog / AiWasteManualDialog / AiConfigPage / AnalysisPage / AiSegmentPage / RolePermissionPanel / StandardConfigPage / UserManagementPage 建号·档案·批量表单 / Breadcrumb / DiffPage）；全量 `grep "<select"` 仅剩注释说明文字、零实际 JSX 元素。新增 UI 仍禁止原生 select。

## 架构
- 后端 NestJS+TypeORM+SQL Server `CN_AME`（3001，前缀 `/api`）；`migrate.ts` 是表结构唯一来源。前端 React+Vite（hash 路由，`App.tsx` `parseHash()`）。部署 production+mssql+localhost，零 pm2/Docker；IIS ARR 未验，不可写"确认单实例"。业务数据未清空；回归前跑 `npm run seed`（幂等）。

## 权限三层模型（v3.55：ACL×RBAC 双层 + data_scope 行级）
- 三层正交：RBAC=能不能调接口／租户隔离=能不能看别家公司／**data_scope=能不能看同公司别人的**（此前缺失）。`AuthUser.dataScope`（own/line/tenant/all），非法值回落 own。
- 唯一口径 `stations.service.resolveVisibleStationIds()` = ACL 三并集（owner ∪ 协作者 ∪ 产线共享）∪ data_scope；对外 `assertReadable()`（读）/ `assertWritable()`（写，只认 editor）/ `visibleStationIds()`（聚合用，null=不限制）。读认 viewer，写只认 editor/owner/admin。
- 19 处读端点已接 `assertReadable`；**对象级写端点须先反查 station_id**（ai-suggest adopt/reject、ai-waste findings/issues/kb/settle、elements va-class/va-confirm）。
- **v3.59.2 line 分支加固**：`resolveVisibleStationIds` 的 line 分支 myLines 三连查 + 最终工位查询全程带 `tenant_id` 约束（绝不依赖候选集兜底），杜绝跨租户同名 line_id 串号越权；回归 `test/test-acl-line-scope.cjs`。
- **聚合层收口**：产线分析须在引擎计算**之前**过滤工位（否则 balance_rate/bottleneck 泄露）；dashboard 缓存键须带可见范围指纹（FNV-1a）。
- **P0-2 决策（勿回退）**：`group:read` **保留不撤**（绑全部 12 角色 + v3.42 决策 + test-v342 断言）→ 改**数据层收口**。
- **视频归属收口**：新增 `t_video_asset`；`videos.service.assertReadable()` 放行 = 全权 ∪ 上传者 ∪ 关联工位可见 ∪ 同租户且 scope∈{tenant,all}；历史无登记文件维持放行。
- 实测：admin 25 工位／ie1(own) 1 个／viewer1 0 个／other1 1 个本租户。

## 高频技术坑
- mssql 驱动**只支持 `@0` 位置参数**（不支持 `@p0`）→ 用错报 500；裸 SQL 拼接须自行转义 `'`。
- ValidationPipe(whitelist) 剥无装饰器字段 → PUT llm-config 须 snake_case `api_key`；login 返回驼峰。
- tedious requestTimeout 15s → 60000；**登录限流桶在内存**（连跑多套件后 auth 假 401 → 重启 API，勿改代码）。
- **UI 回归前置** `UPDATE t_ai_llm_profile SET enabled=0`，跑完置回 1；**UI 回归必须整段连跑**，中途插契约套件会激活真实地址 → ai-waste UI 期望数偏差。
- 前端三元式须 `('ai_assisted' as const)`，否则推成 string 报 tsc 错。
- UI 测试：token 注入条件化 `if (!localStorage.getItem(key)) set`；React select 用原型 value setter；`dblclick` 须 clickCount 递进；块选中挂 onPointerDown，`el.click()` 不触发须真实鼠标；孤儿 Chrome taskkill。
- CSS 动画 fill both + to 含 transform → 恒等 matrix 成 fixed 包含层；浮层 createPortal 挂 body。`<video>` 发不了 Authorization → @Public() + `?token=`。
- **回环代理坑（2026-10-30）**：环境默认设 `HTTP_PROXY=http://127.0.0.1:50410`，node `fetch`/undici 走该代理访问 `127.0.0.1:3001` 会 "fetch failed"（curl 同现，须 `--noproxy 127.0.0.1`）。测试脚本直连回环须 `env -u HTTP_PROXY -u HTTPS_PROXY` 启动 node，或脚本顶部 `delete process.env.HTTP_PROXY/HTTPS_PROXY` + `NO_PROXY=127.0.0.1`。
- ai-waste：BaseRepository 不能裸 new；新实体须注册 database.module 并重启。
- **启动服务孤儿端口坑**：Bash `run_in_background` 的后端/前端 shell 壳被环境回收时，node 子进程会变孤儿**持续占 3001/5173**，下次启动即 `EADDRINUSE` 冲突（那些 failed 通知是噪音，非真实宕机）。重启前先用 PowerShell 杀掉端口监听进程再启；前端 vite 装在 `app/node_modules`，`npm run dev` 后台偶发 exit 127，改用 `cd app/web && node ../node_modules/vite/bin/vite.js`。

- **CSS 类名「用了但没定义」裸奔（v3.60 发现 16 个，含 2 个致命）**
  - **症状**：页面不报错，但区块没样式——`.aw-issue-card` 基于 `.card`，而 `.card` 无外边距 → **相邻卡片零间距粘连**；`.aip-scene` 是裸 `<button>` → 浏览器默认样式。长期靠 inline style 撑着，肉眼易判为"本来就这样"。
  - **根因**：TSX 里写了 className，CSS 侧忘了补定义；无任何编译期或运行期报错，只能靠静态扫描发现。
  - **解法 + 门禁**：`npm run test:css-classes`（`app/web/test-css-classes.cjs`）扫描全部 JSX className 与 styles/ 定义求差集，出现新未定义类名即 exit 1。动态前缀族（`banner-`/`dot-`/`dr-`/`hand-`/`sop-`/`tier-`）已白名单——它们是 `className={`xx-${v}`}` 拼出来的。
  - **改完 UI 后顺手跑一次**，尤其新增页面/区块时。

## 避坑指南（复发类）
> 凡「已经踩过、且容易因记忆缺失而再次踩到」的坑，集中记此，避免换人或换会话后重演。

- **原生 `<select>` 下拉飞走（已复发 ≥3 轮：v3.21 新建分析对象弹窗 → v3.59 集团看板筛选条 → v3.59 改善任务/用户管理等筛选条）**
  - **症状**：点击下拉，弹出列表飘到浏览器窗口左上角/错位，无法选择（真实桌面偶发，取决于 DPI/缩放/Chromium 版本组合）。
  - **根因**：Chromium 在特定 DPI/缩放/版本 + CSS `transform`/`filter`/`zoom` 容器下，原生 `<select>` 的 popup 用**视口坐标**渲染但定位计算错乱；本仓库无头/puppeteer 环境无法复现，CSS 侧排查 transform/filter/zoom 均干净 → **无解**。
  - **解法**：一律用自绘 `SelectMenu`（portal 挂 body + JS 算坐标 + 空间不足向上翻转）。筛选条用 `FilterSelect`（统一「全部」空值语义，首项 value=''）；类型控件用 `TypeSelect`。`SelectMenu` 触发器按钮可传 `triggerStyle`/`triggerClassName` 保持原宽度。
  - **铁律**：新增任何下拉禁止原生 `<select>`（见上「禁止原生 select」铁律）。**验收动作**：改完 UI 后 `grep -rn "<select" app/web/src` 应只剩注释说明文字、不再有实际 JSX `<select>` 元素（v3.59.1 已全量清零）。
  - **为何总复发**：此前只在出问题的页面局部修，没沉淀为项目铁律，新页面/新筛选条照写原生 select → 换台机器又飞。本次已升格为铁律 + 建 `FilterSelect` 收敛入口。

## 回归基线
- 后端：smoke 147（v3.57：viewer 分析/对比断言已改「切 tenant 档→断言→恢复 own」三步式）／ai-waste 85／ai-suggest 62+source 43／integration 31／auth 48（已加 x-real-ip 隔离桶）／settings 20／change-pwd 7／dw-guard 14／rbac-admin 36／**acl-guard 56**／rbac-v358 46（同上隔离）／dashboard 34／video-derivative 26／**alert-rules 12（离线纯函数，`node test/test-alert-rules.cjs`）**。
- 2026-10-30 本地门禁：**权限矩阵 125/125 + XSS/datalist 浏览器 11/11**（`cd app/api && npm run test:security:isolated`，临时 SQLite/3101/自动清理）；**前端拆包预算 6/6**（`cd app/web && npm run build && npm run test:perf`）；**描述联想离线 6/6**（`npm run test:desc-hints`）；依赖门 `npm run test:deps` 当前 api **FAIL 10 high/1 critical**、web PASS。无 CI 不得写成已接入。
- 2026-10-30 W2/W3：`npm run test:performance:isolated`（临时 SQLite/3102/200工位/4000要素/自动清理）三阶段全过：k6 50 VU load+cachehit **11528请求/8650 checks/错误率0/全部threshold PASS**；Lighthouse **LCP 1.082s/CLS 0**；有界面Chrome固定MP4拖拽 **DrawFrame 59.90fps/rAF 60.06fps/最长RunTask 22.0ms**。原始 k6/LHR/trace 均在 deliverables；不替代 SQL Server/IIS 生产容量，现场 INP、spike/soak 未跑。
- UI 11 套全通过：v341~v353 + p2-unit。**2026-11-02 现状**：v341/v343/v344/v351/v353 依赖 `L01-ST01`／`L01-ST11`，清库后仅余 ST010 → **跑不起来**（严禁 `npm run seed` 重建夹具）；可跑的是 ST010 系（v348/v349/v353-stop/v354）。v349 22/0；**v348 恒定 3 项失败（既有数据态，非回归）**：T1/T7 期望 20 要素实际 19，T9 按按钮文本计数且待审数 2/3。
- v3.60 新增前端门禁：`npm run test:css-classes`（类名未定义审计，当前 PASS/0）。
- UI 禁并行；`nest build` 锁死 → `npx tsc -p tsconfig.json --outDir dist`；后台进程用 Bash `run_in_background:true`（nohup 无效）。
- 契约测试 setupStation 按名 purge；清 `t_station` 按 FK 倒序 finding→issue→batch→station。前置工位 `L01-ST11` 缺失跑 `app/web/_setup-st11.cjs`。
- **限流桶测试隔离**：register 3次/h/IP 仅计成功注册，内存桶无重置；套件经 call 注入 `x-real-ip`（clientIp 信任回环反代头）独立分桶；验证「同桶超限→429」的断言须用固定桶。

## 待办
- 双手双轨时间线；描述清单进 datalist 联想源 **已完成（2026-10-30）**：公司 motion_standard.format 动态骨架+同线历史，离线 6/6、隔离 Chrome 11/11。W2/W3 的 200工位+k6、Lighthouse、真实桌面拖拽帧率 **已补测通过（2026-10-30）**；仍需 SQL Server/IIS 生产复测、spike/soak、现场 INP，后端生产依赖审计 10 high/1 critical 未清零。
- **权限遗留（已清零，2026-10-29 深夜）**：原"存量 18 工位 owner 全在 `u_admin`→工程师可见为空"与"历史视频无归属登记"两项，经用户授权执行**「除 ST010(BJFA1/框架组装) 外全库业务数据清空」**后已不存在。现 `t_station` 仅余 ST010（其 20 要素/4 改善/1 AI建议批次/1 AI浪费批次保留），`t_video_asset` 归零（10 个物理孤立 .mp4 按用户选择**保留磁盘**、仍走 videos.service 的"维持放行"）。**清空后严禁 `npm run seed`**——`scripts/seed.ts` 直接植入 L01-ST01/02 等种子工位（不受 SEED 环境变量控制），会部分抵消本次清空。
- **line 分支租户约束：v3.59.2 已修复（2026-10-29）**：`resolveVisibleStationIds` 的 line 分支 myLines 三连查（owner/协作者/产线共享）+ 最终工位查询全部补 `tc/tcs/tls` 租户约束，并修 `t_line_share ls` 别名 bug；新增跨租户回归 `test/test-acl-line-scope.cjs`（8 断言全绿，原 acl-guard 56 无回归）。根因：跨租户同名 line_id 串号可越权看它租户工位。
- **视频管线遗留（SPEC-VID-P0 §10）——2026-10-30 P0.5 已落地**：①派生自动触发 `videos.service.autoDerive()`（ingest 成功后 fire-and-forget 入队，`VIDEO_AUTO_DERIVE=0` 关，allowRaw 跳过）；②告警+LRU（worker `maintainDerivedDisk()` 60s 节流 du，`VIDEO_DERIVED_MAX_GB` 默认 0=关闭待服务器实测后配；淘汰 proxy→`evicted` 状态，`fileOf` 回写 `last_accessed_at`，derive() 对 evicted 重置 pending）；③keyframes 服务端来源（`buildIndex` 第 5 参 srcPath，`-skip_frame nokey` 提取源 I 帧 → index.json.keyframes，前端 WorkbenchPage 接 `engine.load keyframeList`）；④WorkbenchPage emoji 清零（IconToolbox/IconWarnTri SVG）。契约 `video-derivative-contract.cjs` 28→32 断言全绿（S1.5/S5.1b/S7.1-4 新增）。仍遗留：UI 11 套串行回归待部署窗口；部署（AD CS/IIS ARR）未开始；残留装饰 emoji（✅❌📖💡☰，被 UI 测试断言锁定须连测试同步改）。**坑**：契约测试自造 DB 行的视频名必须匹配 `^[0-9a-f-]{36}\.mp4$` 白名单（带前缀=400）。

## 用户偏好
- 中文；重成本；实操反馈细；要求真落地而非纸面方案。
