# MVP系统架构设计（v2.1 落地工程）

> ⚠️ **已被《系统架构设计-v3.0-企业级演进版.md》取代（目标架构部分）**。本文档保留为 MVP 实现的历史记录：`app/server/`（Node 原生 http + SQLite）继续运行于 3001 端口供试点演示；面向多用户/权限/SQL Server/AI 的目标架构见 v3.0 及其实现代码 `app/api/`（NestJS + TypeORM，冒烟 28/28 通过）。
>
> **文档定位**：把 `MVP详细设计-00~04` 五份设计文档翻译成**可运行的系统架构与工程骨架**。读者：开发（2人）、测试、IE主管。凡与本文件冲突处，以 `00-总览与接口裁决` 的冻结口径为准。
>
> **对应交付**：代码位于 `app/`（server + web 双包）。本文件描述**已实现**的架构，并明确标注**未实现/延后**部分，不做"纸面架构"。

---

## 1. 交付范围

| 项 | 状态 |
|---|---|
| 4 个页面（工位清单 / 分解工作台 / 分析结果页 / 改善对比页） | ✅ 已实现，路由与交互打通 |
| 3 张表 16 字段数据底座 + bol_version 封存 | ✅ 已实现（SQLite，含写守卫与事务） |
| 3 条即时校验（V1/V2/V3）拦截提交 | ✅ 已实现（服务端权威、前端展示） |
| 一键增值分析（VA归类+6类浪费证据） | ✅ 已实现（规则JSON驱动） |
| 一键平衡诊断（山积图/平衡率/瓶颈榜/双手图） | ✅ 已实现（手绘SVG） |
| 改善建议（12条ECRSA映射+三因子优先级+2红线） | ✅ 已实现（候选→人工采纳→三态流转） |
| 前后对比 + 收益估算（配对算法/参数配置） | ✅ 已实现（含参数未配置时的阻断） |
| Excel 导入 / CSV 导出 | ✅ 已实现（CSV；.xlsx 需另存为CSV） |
| LLM 可选开关 | ⏸ 未接入（契约已在设计04定义，默认关闭，不阻塞） |
| 认证/权限/审批/报表仪表盘 | ⛔ 按MVP边界不做（扩线闸门后再议） |

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│ 浏览器 · SPA（Vite + React 19 + TypeScript）                  │
│                                                              │
│  #/stations        工位清单（卡片/新建/CSV导入/建议总表）        │
│  #/workbench/:id   分解工作台（视频/双手时间线/属性面板/提交）    │
│  #/analysis/:id    分析结果（饼图/浪费/待复核/山积图/双手图/建议）│
│  #/compare/:id     改善对比（配对表/收益行/参数设置/打印）        │
│                                                              │
│  图表=手绘SVG（零图表库）  时间线=DOM+Pointer（帧级吸附33ms）     │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP/JSON  /api/*（开发: Vite代理 5173→3001；生产: 同源）
┌──────────────────────────▼───────────────────────────────────┐
│ Node 22 单进程服务（node:http，零运行时依赖）                   │
│                                                              │
│  Router（方法+路径匹配）                                       │
│    → Controller（取参/返回，无业务）                            │
│      → Service / Engine（业务规则、事务、计算）                  │
│        → Repository（prepared SQL，node:sqlite）               │
│                                                              │
│  横切：请求ID结构化日志 · 类型化错误 · Body大小限制 · CORS白名单 │
│        · 静态托管(web/dist) · SIGTERM优雅关闭                  │
└────────────┬─────────────────────────────┬───────────────────┘
             │                             │
   ┌─────────▼─────────┐        ┌──────────▼──────────────────┐
   │ SQLite 单文件      │        │ 规则/参数 JSON（文件即配置）   │
   │ data/ie.db（WAL）  │        │ config/rules/*.json (RV1.0)  │
   │ 3表：station/      │        │ config/benefit_params.json   │
   │ element/improvement│        │ 改规则=改文件+重启/重载        │
   └───────────────────┘        └──────────────────────────────┘
```

**一句话**：一个单进程、单文件数据库、零外部依赖的内网工具——IE 开浏览器就用，IT 只需复制一个目录即可部署与备份。

---

## 3. 技术选型与理由（对照MVP约束）

| 决策点 | 选择 | 理由 | 否决的替代方案 |
|---|---|---|---|
| 运行时 | Node 22（`node:http` + `node:sqlite`） | 内置 SQLite 驱动，**零运行时依赖**；单进程足够支撑1条线5~10工位、1~2名IE并发 | FastAPI（多一套Python环境）、Spring（2人8周过重） |
| 后端框架 | 原生 http + 自研 30 行 Router | 接口约30个、无中间件生态需求；避免依赖供应链（内网/离线部署） | Fastify/Express（引入node_modules，升级与审计成本） |
| 数据库 | SQLite（WAL 模式） | 文档01 DDL 即按 SQLite 设计；单机<10万行；**备份=复制一个文件**；WAL 支持读写并发 | PostgreSQL（多一个服务要运维）、JSON文件（无事务/索引） |
| 前端 | Vite 6 + React 19 + TypeScript | 时间线拖拽/分割属高交互页面，需要组件化与状态管理；TS 保证 API 契约不漂移 | 纯HTML模板（时间线交互难维护） |
| 图表 | 手绘 SVG（饼图/山积图/双手图） | 三类图形结构固定，SVG 约200行/个；**离线可用、无CDN**、打印清晰 | ECharts（体积大、离线打包、样式难统一） |
| 路由 | hash 路由（零依赖） | 4页面、无SEO/SSR需求，避免引 react-router | react-router（多一个依赖，收益低） |
| 状态管理 | 页面内 `useState` + 服务端为唯一真相 | 页面自洽、数据量小，提交后强制 reload；**不做前端缓存**（避免与封存语义冲突） | Redux/Zustand（复杂度不匹配） |
| 校验 | 服务端唯一权威；前端只做即时提示 | 数据是命：任何客户端绕过都拦不住（文档01 §7） | 仅前端校验（可被绕过） |
| 规则表达式 | 自研 DSL（禁 `eval`） | 规则由JSON维护，需安全求值；DSL 支持比较/AND/OR/NOT/括号/正则 | `eval`/`new Function`（代码注入风险） |
| 导出 | CSV + 浏览器打印（PDF/PPT） | Excel 导入=另存CSV；报告导出=网页打印，零依赖 | xlsx/PptxGenJS 库（多依赖，MVP不需要真pptx） |
| 部署 | 单机内网，生产由 Node 托管 `web/dist` | 一个命令启动；无反向代理需求 | Docker/K8s（一条试点线用不上） |

---

## 4. 工程结构（feature-first）

```
app/
├─ package.json                 # npm workspaces（server + web）
├─ config/
│  ├─ rules/va_rules.json       # 10类默认VA + 例外条件（DSL）
│  ├─ rules/waste_triggers.json  # 6类浪费触发器（元素级/工位级聚合）
│  ├─ rules/ecrsa_map.json       # 12条ECRSA映射（措施/难度/估算系数）
│  ├─ rules/redline_keywords.json# 2条红线关键词
│  └─ benefit_params.json        # 线级收益参数（费率/日产量/落地率）
├─ data/ie.db                    # SQLite（运行时生成，gitignore）
├─ scripts/{dev.js, smoke.js}    # 一键开发（双进程）/ 冒烟测试
├─ server/src/
│  ├─ index.js                   # 启动/中间件/静态托管/优雅关闭
│  ├─ config.js                  # 环境变量集中收口（fail fast）
│  ├─ logger.js                  # JSON结构化日志
│  ├─ errors.js                  # 类型化错误层级
│  ├─ routes.js                  # 30个接口的路由表（Controller层）
│  ├─ http/router.js             # 方法+`/path/:param` 匹配
│  ├─ db/{index.js, seed.js}     # schema/事务/CT重算 + 演示数据
│  ├─ rules/{rules.js, dsl.js}   # 规则加载自检 + 条件表达式引擎
│  ├─ shared/{util.js, csv.js}   # 格式化/相似度/CSV
│  └─ features/
│     ├─ stations/               # 工位CRUD、版本、复测封存
│     ├─ elements/               # 校验(V1V2V3)、提交事务、导入导出、VA改判
│     ├─ analysis/               # VA归类、6类浪费、山积图、双手图
│     ├─ suggestions/            # 候选生成、采纳(红线)、三态流转、建议书
│     ├─ compare/                # 双版本配对、ΔCT、收益、对比报告
│     └─ settings/               # 收益参数读写与校验
└─ web/src/
   ├─ api.ts                     # 类型化fetch封装（ApiError→用户提示）
   ├─ constants.ts               # 10类/默认VA/颜色/帧长
   ├─ App.tsx                    # hash路由 + 布局
   ├─ styles.css                 # 蓝图同源设计系统（浅色）
   ├─ components/{PieChart, YamazumiChart, HandsChart}.tsx
   └─ pages/{StationList, Workbench, Analysis, Compare}Page.tsx
```

**分层纪律**：Controller 只取参/返回；Service 承载规则与事务；任何 SQL 不得出现在路由层；Service 不感知 HTTP。

---

## 5. 数据层设计

### 5.1 表结构（与文档01 §5 逐字段一致）

| 表 | 关键约束 | 说明 |
|---|---|---|
| `t_station` | PK `station_id`；`version INTEGER`（=生效bol_version指针） | CT 由引擎回写；TT 手工配置；`updated_by/at` 即留痕 |
| `t_element` | PK `element_id = {station}-V{ver}-{seq3}`；`UNIQUE(station_id,bol_version,seq)`；CHECK 覆盖 hand/type/va/rating/allowance/dur | `"desc"` 是 SQL 保留字，**所有SQL必须加双引号**；`std_time` 为系统计算列 |
| `t_improvement` | CHECK method∈E/C/R/S、status∈三态 | `element_ids` 逗号分隔；`before_ct/after_ct` 由系统回填 |

索引：`idx_station_line`、`idx_element_station_version`、`idx_element_station`、`idx_imp_station_status`。

### 5.2 bol_version 封存语义（v2.1补丁#1）的实现

| 规则 | 代码落点 |
|---|---|
| 点“开始复测” → `version+1`，旧版因指针移开**天然只读** | `stations.startRetest()`（事务内 UPDATE version） |
| 写守卫：任何要素写操作要求 `element.bol_version === station.version` | `elements.submitElements()` / `updateVAClass()` / `confirmVAClass()` |
| 旧版 16 字段全锁、不可解封 | 无“解封”接口；只提供查看/导出/视频回放 |
| 作废复测：删当前版本行 + version 回退 + 按恢复版本重算 CT（同事务） | `stations.cancelRetest()` |

> 这是全系统最重要的一条不变量：**封存不是状态标志，是版本指针的指针语义**——少一个标志位，就少一类“忘记翻转”的bug。

### 5.3 事务边界

| 业务动作 | 事务内容 |
|---|---|
| 提交分解 | `DELETE(当前版本) → INSERT 全量 → 重算CT → UPDATE station(CT/by/at)` |
| 开始复测 | `UPDATE station SET version=version+1` |
| 作废复测 | `DELETE(当前版本行) → UPDATE station(version−1, CT=恢复版CT)` |
| 采纳建议 | 批量 `INSERT t_improvement`（before_ct=当前CT） |

### 5.4 备份与恢复

SQLite WAL 模式下：停服 → 复制 `data/ie.db`（及 `-wal/-shm`）即完整备份；恢复=覆盖后启动。建议每日班后复制一份到网络盘（`ie-YYYYMMDD.db`），无需专门备份工具。

---

## 6. 模块映射：五份详细设计 → 代码

| 详细设计 | 服务端实现 | 前端实现 | 关键点 |
|---|---|---|---|
| 01 视频分解与BOL | `features/elements/{validation,service}.js`、`features/stations/service.js`、`rules/va_rules.json` | `WorkbenchPage.tsx` | V1/V2/V3 精确规则、`std_time` 公式、封存写守卫、CSV整批事务 |
| 02 增值分析与平衡诊断 | `features/analysis/engine.js`、`rules/waste_triggers.json` | `AnalysisPage.tsx` + 三个SVG组件 | 规则DSL求值、例外优先、待复核队列、异常口径、平衡率 |
| 03 对比与收益 | `features/compare/service.js`、`features/settings/service.js` | `ComparePage.tsx` | 三层配对、ΔCT权威口径、÷3600收益、参数未配置阻断 |
| 04 建议与实施验收 | `features/suggestions/service.js`、`rules/ecrsa_map.json`、`redline_keywords.json` | `AnalysisPage`（候选抽屉）+`StationList`（建议总表） | 候选不落库、采纳才写、2红线提示+确认、三态流转校验 |
| 00 总览与裁决 | `shared/util.js`（相似度/标记解析）、`stations`（version整数） | 全局 | 预对/检验/搬运=NNVA、改判标记统一、version=INTEGER |

---

## 7. API 契约（REST，JSON）

约定：成功 `200` + 数据；业务校验失败 `422`；不存在 `404`；状态冲突 `409`；错误体统一
`{ title, status, detail, request_id, details? }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` `/api/ready` | 存活/就绪（含DB探测） |
| GET | `/api/rules` | 规则快照（RV版本+全部规则） |
| GET | `/api/lines` | 产线列表（含工位数） |
| GET | `/api/stations?line_id=` | 工位卡片（CT/VA%/版本数/状态） |
| POST | `/api/stations` | 新建工位 |
| GET | `/api/stations/:id` | 工位详情+当前版本要素+版本列表 |
| PATCH | `/api/stations/:id` | 改名称/TT |
| GET | `/api/stations/:id/versions` | 版本列表（is_current/is_sealed） |
| POST | `/api/stations/:id/retest` | **开始复测**（封存+version+1） |
| DELETE | `/api/stations/:id/retest` | 作废复测（回退） |
| POST | `/api/stations/:id/elements/validate` | 只校验不落库（返回errors/warnings） |
| POST | `/api/stations/:id/elements/submit` | 提交分解（V1V2V3拦截→事务写入→CT） |
| POST | `/api/stations/:id/import` | CSV整批导入（任一行失败整批拒绝） |
| GET | `/api/stations/:id/export.csv` | 导出当前版本CSV |
| POST | `/api/elements/:id/va` | VA改判（写`[VA改判|...]`标记） |
| POST | `/api/elements/:id/va-confirm` | 确认暂定归类（写`[VA确认|...]`） |
| GET | `/api/stations/:id/analysis?version=` | 单工位分析（指标/浪费/待复核/异常/双手图） |
| GET | `/api/lines/:lineId/analysis` | 全线山积图+平衡率+瓶颈榜 |
| POST | `/api/stations/:id/suggestions/generate` | 生成候选（**不落库**） |
| POST | `/api/stations/:id/suggestions/adopt` | 采纳（红线未确认→422 `REDLINE_CONFIRM_REQUIRED`） |
| GET | `/api/improvements?line_id&station_id&status` | 建议清单（三态） |
| PATCH | `/api/improvements/:id/status` | 三态流转（已验证要求存在v+1） |
| GET | `/api/improvements/:id/report` | 建议书数据 |
| GET | `/api/stations/:id/compare` | 前后对比（配对/ΔCT/收益） |
| GET | `/api/stations/:id/compare/report` | 对比报告数据（KPI/配对/签署行） |
| GET/PUT | `/api/config/benefit-params` | 线级收益参数（无默认值，未配置阻断计算） |

---

## 8. 规则引擎

### 8.1 条件 DSL（`rules/dsl.js`）

```
expr    := orExpr
orExpr  := andExpr ( "OR" andExpr )*
andExpr := unary ( "AND" unary )*
unary   := "NOT" unary | primary
primary := "(" expr ")" | field op value | field
op      := = | != | > | >= | < | <= | ~=
```

- 值：数字或裸字符串（如 `持住`）；`~=` 为正则（`desc~=返工|重装|拆`，`|` 属于值，不会被当作 OR）
- 上下文字段：`type/dur_s/std_time/start_ms/hand/desc/element_id/seq/same_desc_count`
- 编译结果按表达式缓存；**字段引用不存在直接抛错**（尽早暴露规则配置错误）
- 求值顺序：**例外规则（数组序，首个命中）→ 类型默认**

### 8.2 规则文件与版本

| 文件 | 内容 | 版本字段 |
|---|---|---|
| `va_rules.json` | VR01~VR10：默认归类/置信度/例外/判定理由 | `rv=RV1.0` |
| `waste_triggers.json` | WT01~WT12：6类浪费、元素级`when`/工位级`agg`、证据模板 | `rv=RV1.0` |
| `ecrsa_map.json` | M01~M12：措施/ECRS方法/难度/估算系数0.3~0.8 | `rv=RV1.0` |
| `redline_keywords.json` | 品质/人因关键词表 | — |

启动自检（`loadRules()`）：10类齐全、全部表达式可编译，否则**拒绝启动**（fail fast）。W8 冻结=锁定文件版本号并停止修改（改规则=改文件+重启，MVP不做配置中心）。

### 8.3 计算口径（与文档02/03一致）

| 指标 | 实现 |
|---|---|
| `std_time` | `round2(dur_s × rating × (1 + allowance))`，提交时服务端计算，禁手填 |
| 工位工时 CT | `Σ std_time`（`outlier_flag=0` 且当前版本），回写 `t_station.CT` |
| 浪费占比 pct | `涉及dur_s ÷ CT × 100`（1位小数） |
| 平衡率 | `Σ各工位CT ÷ (瓶颈CT × 工位数) × 100` |
| 瓶颈 | CT 最大者（并列全部标记）；瓶颈榜按 `CT−TT` 降序 Top5 |
| 收益 | `ΔCT × 日产量 × 365 × 费率(元/h) ÷ 3600 × 落地率`（参数未配置→返回 null 并阻断展示） |
| 配对 | ①改判标记/建议关联 ②同类型+描述精确 ③同类型+相似度≥0.75（包含关系记0.85） ④未匹配=消除 |
| 优先级 | `est_save_s × 日频次 ÷ 难度`，跨候选归一化0~100，≥60=P1 / 30~59=P2 / <30=P3 |

---

## 9. 前端架构

### 9.1 路由与状态

| 路由 | 页面 | 数据来源 |
|---|---|---|
| `#/stations` | 工位清单 | lines + stations + improvements |
| `#/workbench/:id` | 分解工作台 | station detail（当前版本要素） |
| `#/analysis/:id` | 分析结果 | analysis + line analysis + improvements |
| `#/compare/:id` | 改善对比 | compare + benefit params |

状态原则：**服务端为唯一真相**；页面本地态只用于“未提交的草稿”（分解工作台）。

### 9.2 分解工作台交互模型

- **草稿态**：进入页面把当前版本要素载入本地 `draft`，所有编辑只改本地；点“提交分解”才走服务端事务（与文档01 §10 一致）
- **时间线**：三行（左/右/双手），`left = start_ms/1000 × 60px`、`width = dur_s × 60px`；最小步长=1帧(33ms)
- **拖拽调边界**：`pointerdown` 打点 → `pointermove` 按 33ms 吸附 → `pointerup` 收尾（window 级监听，避免拖出元素丢失事件）
- **双击分割**：在播放头处把要素切成两段（任一段 <1帧则忽略）
- **播放头**：与 `<video>` 双向同步（`timeupdate` 更新，点时间线/拖块 seek）
- **改判**：VA 与类型默认不一致时，提交前自动补 `[VA改判|原|新|理由|人|日期]` 标记（与02同格式，服务端 V1 校验该标记）

### 9.3 图表

- 饼图：极坐标弧段 + 中心值；山积图：三色堆叠柱 + TT 虚线 + 瓶颈标注；双手图：两行时间条 + 空闲段
- 全部使用 `viewBox` 自适应，打印时按矢量输出
- 对比页“打印/导出PDF”直接调用 `window.print()`，打印样式隐藏导航与参数表单

---

## 10. 横切关注点

| 关注点 | 实现 |
|---|---|
| 配置 | `config.js` 集中读取环境变量并校验（PORT/DB_PATH/ORIGIN/LOG_LEVEL/SEED/MAX_BODY_BYTES），非法值启动即失败 |
| 日志 | `{ts, level, msg, request_id, method, path, status, duration_ms}` 单行JSON；错误日志含 stack，响应不含 |
| 错误 | `AppError` 派生 NotFound/Conflict/BadRequest/Validation/Rule；全局处理器统一 `{title,status,detail,request_id}` |
| 校验 | 三层：字段类型/范围（V1）→ 时间轴（V2）→ 循环数（V3）→ DB CHECK 兜底 |
| CORS | 显式白名单（`ORIGIN`，默认 `http://localhost:5173`），不用 `*` |
| Body 限制 | 5MB（CSV/JSON），超限直接 400 并断开 |
| 静态托管 | 生产同源托管 `web/dist`，SPA 回退 `index.html`；路径穿越防护 |
| 关闭 | SIGINT/SIGTERM → 停止接收 → 关闭DB → 退出（5s 兜底） |

---

## 11. 非功能目标与现状

| 指标 | 目标 | 现状 |
|---|---|---|
| 单工位分析接口 | ≤100ms | ✅ 实测（6工位20要素级别，纳秒~毫秒级） |
| 一屏分析渲染 | ≤3s | ✅ 数据量级下即时 |
| 并发 | 1~2名IE同时操作 | ✅ WAL + 短事务；单写者天然串行 |
| 部署 | 一条命令 | ✅ `npm run build && npm start` |
| 离线 | 无外部网络依赖 | ✅ 零CDN、零运行时依赖 |
| 备份 | 复制文件 | ✅ 单文件 |

**安全边界（明确接受的风险）**：MVP 无认证/权限（审批与权限体系已按MVP边界砍掉），仅允许部署在受控内网；扩线前必须补登录与操作者身份（否则 `updated_by` 可被任意填写）。

---

## 12. 8周施工映射（与文档04 §8 对齐）

| 周 | 详细设计任务 | 本工程对应 | 状态 |
|---|---|---|---|
| W1~W2 | 3表+工位清单+CSV导入 | `db/schema`、`stations`、`elements/import`、`StationListPage` | ✅ 骨架完成 |
| W3~W4 | 视频分解工作台（最重） | `WorkbenchPage`（时间线/分割/拖拽/校验/提交） | ✅ 核心交互完成，帧级打磨与性能待W7按现场反馈迭代 |
| W5 | 一键分析 | `analysis/engine` + `AnalysisPage` + 3个SVG | ✅ 完成 |
| W6 | 建议清单+对比页 | `suggestions`、`compare`、`ComparePage` | ✅ 完成 |
| W7 | 试点实跑 | 参数校准：`ecrsa` 系数、三因子阈值、红线词表 | ⏳ 待现场数据 |
| W8 | 固化验收 | 规则JSON冻结、操作手册1页、验收埋点核对 | ⏳ 待执行 |

---

## 13. 验证证据

- **后端冒烟**：`npm run smoke` → **39 项全部通过**（健康检查/规则自检/工位版本/CT口径/浪费识别/山景图/瓶颈/平衡率/V2V3拦截/建议生成/建议清单/对比ΔCT=4.26s/年化¥16,326/参数读取）
- **前端**：`tsc --noEmit` 类型检查通过；`vite build` 产物构建通过
- **手工回归清单**（W7前必做）：4页面可达 → 新建工位 → CSV导入 → 时间线拖拽/分割 → 故意触发V1/V2/V3 → 提交 → 分析页改判/确认 → 生成建议并采纳（含红线拦截）→ 开始复测 → 提交新版本 → 对比页收益 → 打印报告

---

## 14. 已知边界与演进路径（按闸门，不在MVP内）

| 能力 | 现状 | 触发条件（文档7.2闸门） |
|---|---|---|
| 登录/权限/操作者身份 | 无 | 扩第二条线前必须补 |
| LLM建议润色 | 契约已定，未接 | IE主动要求且规则建议质量不足时 |
| 审批流/SOP签认 | 无（口头+现场确认兜底） | IE抱怨“版本乱了/找不到谁改的” |
| .xlsx 直读 | 仅CSV | 现场Excel另存CSV阻力大时 |
| 视频服务端切帧/抽帧 | 纯前端播放 | 需要AI辅助分解时（P3试点） |
| 效益台账/财务口径 | 一行公式 | 财务明确要求报数口径 |
| 案例库/RAG | 无 | 案例≥30条 |

---

## 15. 运行手册

```bash
cd app
npm install          # 安装前端构建依赖（后端零依赖）
npm run seed         # 空库灌入演示线 L01（6工位，ST03已复测）
npm run dev          # 同时启动 API(3001) + Vite(5173)
# 或生产模式：
npm run build        # 前端产物 web/dist
npm start            # 单进程 3001，同源托管前端
npm run smoke        # 冒烟测试（需服务已启动）
```

环境变量（均可选，见 `server/src/config.js`）：`PORT` `HOST` `DB_PATH` `RULES_DIR` `WEB_DIST` `ORIGIN` `LOG_LEVEL` `SEED` `MAX_BODY_BYTES`。
