# Spec — AI 辅助动作切分 v1.0（分解工作台候选层）

> 生成日期：2026-10-25
> 基于：用户清单（见对话）+ 项目 AGENT必读.md v3.32 + 现状代码核对
> 状态：**草案（§4/§5/§6 待架构师回填，§8 待设计师回填）**

---

## 1. 产品定义

- **一句话描述**：在分解工作台里，用浏览器本地 AI 把手部轨迹切成分段候选，IE 只做「确认/修正/提交」，把逐帧找止点的重复劳动压掉。
- **目标用户**：现场 IE 工程师 / ME（本平台既有用户，`element:write` 权限持有者）。
- **核心问题**：一个 30 秒的作业循环有 20-40 个动作要素，全靠人工 `←→` 逐帧找止点再按 `I/O`，单个工位分解 1-2 小时，且 IE 流动大、量产项目无暇深度改善。

## 2. MVP 范围（锁定——不在此列表的功能一律不做）

| 优先级 | 功能 | 验收标准摘要 |
|---|---|---|
| P0 | 浏览器端手部轨迹推理（MediaPipe hand landmarker，离线模型） | 本地视频不上传，可在普通办公 PC 上跑完 30s 视频并产出轨迹 |
| P0 | 静止点 → 候选止点切分（速度阈值 + 持续帧数） | 输出有序候选分段，每段含 start_ms / end_ms / hand / confidence |
| P0 | 时间线候选层展示（与人工块视觉可区分） | 候选与人工块同时可见、互不遮挡、不改动人工块交互 |
| P0 | 逐条 + 批量接受/拒绝 | 接受后并入 `draft`；拒绝后消失；均可撤销 |
| P0 | 接受后衔接既有 I/O 精修回路 | 接受后仍可拖拽/`I`/`O`/`,.[]` 精修 |
| P0 | 来源留痕（人工 / AI 辅助） | 提交流程落 `t_element.source`，可统计采纳率 |
| P1 | 低置信度候选弱化表达 | 默认不勾选，需显式接纳 |

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做的功能 | 原因 | 何时考虑 |
|---|---|---|
| 浪费区间识别（清单 §6.4） | 依赖动素分类精度；分类错则浪费标注全错；与既有规则引擎结论冲突优先级未定义 | 切分准确率经试点验证后 |
| 动素类型精确分类 | MediaPipe 只给手部几何，不给「拿取/装配」语义；硬猜会污染 VA 判定 | 有标注数据后 |
| 服务端 AI Worker / Python / GPU | 用户已定：浏览器端；成本不可接受 | 浏览器端精度不达标时重议 |
| 视频上传与持久化 | 用户已定：不上传（车间涉密 + 零存储成本） | 需跨机复现分析结果时 |
| 新建 `ai_job/ai_result/ai_segment/ai_waste_candidate` 四表 | 视频不上传 ⇒ 候选无跨会话锚点，四表无从挂载 | 同上 |
| 云端/大模型视觉 API | 与「不上传」直接冲突 | 永不 |
| 多工位批量自动分析 | 一期单工位单视频 | 试点通过后 |

## 4. 技术架构

> 详见 `docs/decisions/ADR-AI-SEG-001.md`（含真实 Chrome 实测数字）。

| 层 | 技术 | 版本 | 锁定原因 |
|---|---|---|---|
| 推理 | `@mediapipe/tasks-vision` HandLandmarker（**本地 bundle 动态 import，node_modules 装不上**） | 1.1.1（bundle 已落 `public/models/vision_bundle.mjs`） | 浏览器 WASM/WebGL，零服务器成本 |
| 模型 | `hand_landmarker.task`（7.82MB，离线落 `public/models/`） | float16/1 | 单手 21 点，切分够用 |
| WASM | `public/models/wasm/vision_wasm_internal.*`（13.5MB） | — | 离线分发，禁运行时拉 CDN（实测源站经代理约 12KB/s） |
| 前端 | React 19 + Vite 6 + TS | 现状 | 不引入新框架 |
| 后端 | NestJS 10 + TypeORM | 现状 | 只承担来源留痕（`t_element.source`），不承担推理 |

**切分算法（准静态运动分割）**：seek 定步长 100ms（10Hz）确定性抽帧 → 逐帧取手部掌质心/速度/开合度 → 运动→准静态拐点（静止≥4 帧≈400ms）= 候选止点；手数 1↔2 变化=循环断点。置信度连续存储、UI 三档（高≥0.80/中0.55/0.80/低<0.55），硬规则 R1 时长护栏/R2 手别不确定/R3 贴边/R4 已标注区不重切。

**实测成本**：冷启动 GPU 1.87s（集显）；单帧推理 ~50ms；seek 抽帧 ~60ms/帧；**分析耗时 ≈ 视频时长 1–1.5×**（独显快 3–4×，纯 CPU 兜底再 ×2）。

**时间戳铁律**：`detectForVideo` 的 ts 必须严格单调递增，**绝不用 `performance.now()`**（跨段回退报 `Packet timestamp mismatch`）——见 `pitfalls.jsonl`。

## 5. API 端点清单

> 原则：**不新增任何端点**（推理在浏览器，来源落痕走既有 submit）。采纳率统计复用既有只读聚合或后续再加。
> 硬约束（保留）：禁止 `:jobId` 与 `:stationId` 同路径形状；禁止复用 `/api/ai/*` 前缀；复用现有 24 权限点，不新增。

| Method | Path | 功能 | 权限 | 请求体 | 响应体 |
|---|---|---|---|---|---|
| （无新增） | — | 候选切分全在浏览器，不触后端 | — | — | — |
| POST | `/stations/:id/elements/submit`（既有） | 接受候选后落库时带 `source:'ai_assisted'` | element:write | 既有 + 元素项加 `source` | 既有 |

## 6. 数据库表清单

> **0 新表**（详见 `docs/decisions/ADR-AI-SEG-002.md`）。候选/拒绝区间/分析中状态全部前端会话内，不持久化。
> 已确认事实：`t_element.video_id NVARCHAR(64) NULL` 列已存在（批次级）；`submit` 是整版删除后重插 ⇒ 来源标记逐条携带。

| 表名 | 变更 | 说明 |
|---|---|---|
| `t_element` | **+1 列** `source NVARCHAR(16) NOT NULL DEFAULT 'manual'`（值域 `manual` / `ai_assisted`） | 供 AI 采纳率统计。**已落 `scripts/migrate.ts`（CREATE + `IF COL_LENGTH ... ALTER`）+ 实体 + DTO + submit 透传** |
| `t_audit_log` | 复用 | 接受/拒绝动作按既有 schema 落审计 |

## 7. 页面清单

> **v3.34 架构变更（用户指令，最高优先级）**：AI 自动分解**不得在分解工作台内扩展**，必须是**并列的独立页面**。理由：工作台是反复打磨的作业面，任何内嵌都会带来未预期缺陷。原「在工作台内叠加候选层」方案已作废并已从代码中剥离。

| 页面 | 路由 | 核心组件 | 对应 API | 与工作台关系 |
|---|---|---|---|---|
| AI 自动分解（新） | `#/ai-segment/:stationId` | `pages/AiSegmentPage.tsx`（自包含：视频 + 只读时间线 + 候选表 + 写入区） | `GET /stations/:id`、`GET /stations/:id/elements`、`POST /stations/:id/elements/validate`、`POST /stations/:id/elements/submit` | **并列**：工位页签第二项，与工作台互不引用，样式全部 `aip-` 前缀 |
| 分解工作台（不改） | `#/workbench/:stationId` | 无新增（v3.34 已剥离全部 AI 代码） | 既有 | 承担写入后的精修与提交 |

**写入契约（关键）**：AI 候选**不写视频绝对时间**。按接受顺序**累加重排时间链**——现有要素在前、AI 段接后，`seq` 连续重排。原因：后端 V2 禁止同手时间重叠、V1 要求描述非空、V3 要求有效循环数 ≥15。每条 AI 要素携带 `source='ai_assisted'` + `video_id='ai-segment'`。

## 8. 设计 Token

> **增量 token 见** `deliverables/ai-segment/DESIGN-ai-candidate-layer.md` §13（全部由 `--ink/--ink2/--ink3/--blue` 经 `color-mix` 派生，**零硬编码、零新色相**）。
> **v3.34 落地差异**：独立页面的候选块无需与人工块同轨区分（页面里没有人工块），样式改用 `aip-` 前缀的简洁形态（斜纹/虚线仍保留以表达置信档），全部追加在 `styles.css` 末尾独立区块，不改任何既有规则。

## 9. 验收标准（EARS）

| 编号 | 功能 | EARS 验收标准 | 优先级 |
|---|---|---|---|
| AC-01 | 隐私 | While 用户触发 AI 切分，系统**必须**不发任何视频内容到网络（仅模型文件本地加载），Network 面板零视频请求 | P0 |
| AC-02 | 切分 | When 推理完成，系统**必须**产出按 `start_ms` 升序、无重叠、同手别不交叉的候选分段 | P0 |
| AC-03 | 隔离 | While 候选存在，系统**必须**不把候选写入 `draft`（否则会被 `submit` 整版提交） | P0 |
| AC-04 | 接受 | When 用户接受单条候选，系统**必须**把该段并入 `draft` 且可立即拖拽/`I`/`O` 精修 | P0 |
| AC-05 | 批量 | If 用户点「全部接受」，系统**必须**先弹二次确认（不可逆破坏性操作） | P0 |
| AC-06 | 拒绝 | When 用户拒绝候选，系统**必须**移除该候选且不产生 `t_element` 记录 | P0 |
| AC-07 | 不破坏 | While 候选层启用，既有交互（单击选中/双击定位/S 分割/Del/撤销/Esc/Ctrl+K）**必须**行为不变 | P0 |
| AC-08 | 中止 | When 用户在分析中关闭工作台或切工位，系统**必须**中止推理且不残留状态 | P0 |
| AC-09 | 来源 | When 提交含 AI 候选的要素，系统**必须**落 `source='ai_assisted'`；纯手工批次落 `manual` | P0 |
| AC-10 | 离线 | If 模型文件缺失，系统**必须**明确提示「模型未就绪」而非静默失败 | P0 |
| AC-11 | 焦点 | When 任何提交/接受动作完成，焦点**必须** blur 回 body（v3.27 铁律），保证 `L`/`I`/`O` 即时生效 | P0 |
| AC-12 | 版本 | While 工位处于封存版本，AI 切分入口**必须**禁用（写守卫 `bol_version = station.version`） | P0 |

## 10. 边界与约束

- 浏览器：需支持 WebAssembly + WebGL2（Chrome/Edge 现代版）；不支持 IE
- 模型体积：手部方案约 18MB（7.82MB 模型 + ~10MB WASM），浏览器缓存后复访零下载
- 首帧预热：首次加载模型需数秒，须有明确 loading 态
- 性能口径：30s 视频须在可接受时间内完成（**TBD 待架构师实测**）
- 视频来源：仅本地文件（object URL）；**不落盘服务器**
- 时间量纲：`start_ms` 整数毫秒、时长 10ms 网格、止点恒等 V2 公式（v3.29 铁律）
- 单文件 ≤300 行：新增前端代码必须拆到 `app/web/src/ai-segment/` 独立目录

## 11. 内嵌已知坑（从项目记忆拉取）

| 坑 | 技术栈指纹 | 根因 | 修法 |
|---|---|---|---|
| CSS 恒等 transform | react-19 / vite-6 | 动画 `fill both` 且 to 含 `translateY(0)` → 元素永驻 `matrix(1,0,0,1,0,0)`，成 fixed 包含层 | fixed 浮层 `createPortal` 挂 body；关键帧去 transform |
| 点击已选中块 = toggle-off | 工作台 | v3.19 语义 | 测试先探 `.wb-panel-sel` 再决定点不点 |
| puppeteer `clickCount:2` 不产生 dblclick | puppeteer-core | 只出 click detail=1 | 显式 down(d1)/up(d1)/down(d2)/up(d2)，第二次 down 带 clickCount:2 |
| 折叠面板吃掉按钮 | 工作台 | `display:none` 连面板内按钮一起隐藏 | 折叠态入口渲染在面板外（坑㉚） |
| 视频太短导致 seek 越界 | 测试数据 | play() 静默 ended | 测试视频须覆盖要素区间；MediaRecorder 造长视频 |
| 提交后焦点留输入框 | v3.27 | INPUT 聚焦时全局单键快捷键让位 | `document.activeElement.blur()` 回 body |
| 跨库查询位置参数 | TypeORM | `ds.query` 不收命名参数 | 位置参数数组 + 白名单转义 |
| 工位删除级联 | TypeORM | FK RESTRICT → DELETE 500 | `stations.service.remove()` 先子后主（若最终建表则必须加） |

## 12. 端到端验证步骤

```bash
# 1. 后端构建 + 回归（新增列后必跑）
cd app/api && npm run migrate && npm run build && npm run smoke   # 143/143

# 2. 前端构建 + 拆包门禁
cd app/web && npm run build
# 断言：index 主包 ≤280KB；各页面独立 chunk

# 3. 模型离线就位
ls app/web/public/models/hand_landmarker.task   # 7.82MB

# 4. 端到端（真实浏览器，puppeteer-core + 系统 Chrome）
node app/web/test-wb-ai-segment.cjs
# 断言语义同 §9 AC-01..AC-12

# 5. 隐私硬断言
# 在 page.on('request') 中断言：分析期间无 >=1MB 的 POST/PUT 出站请求
```

## 13. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|---|---|---|---|
| 2026-10-25 | 首版草案 | 用户三条硬约束拍板后生成 | 全篇 |
| 2026-10-25 | v3.34 架构迁移：删除「工作台内叠加候选层」方案，改为并列独立页 `#/ai-segment/:stationId`；工作台内 AI 代码全部剥离 | 用户指令：**不得在工作台内扩展，避免给打磨好的作业面带来未预期缺陷** | §7 页面清单、§8 设计 Token 落地方式；代码 `WorkbenchPage.tsx`（剥离）+ `AiSegmentPage.tsx`（新增）+ `StationTabs`/`App`（路由） |
