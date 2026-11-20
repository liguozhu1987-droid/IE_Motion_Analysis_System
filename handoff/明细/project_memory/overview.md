# 项目概览（overview）

> 长期事实。整理：2026-11-18。完整代码导航见 `docs/CODE-WIKI.md`；API 契约速查见 `AGENT必读.md` §5。

## 1. 是什么 / 不是什么

**IE（工业工程）改善平台 = 「AI 赋能的 IE 分析改善效率工具」**。帮助 IE 工程师对工位作业视频做
**动素级动作分解**，自动计算 VA / RNVA / NVA 工时结构、CT、平衡率、瓶颈，给出改善建议并估算年化收益。

- **痛点**：ME/IE 人员流动大、量产项目无暇做深度改善；手工动作分析（秒表 / 录像回放）耗时且依赖老师傅经验。
- **产品哲学（用户 2026-10-21 定，长期有效）**：工具做「薄」不做「全」——**帮 IE 更快看出问题 → 留；
  帮管理层管住 IE → 砍**。审批、追踪、核算、报表、认证类管理功能一律砍掉或延后。
- **工具主线**：「人拆 AI 校」——人负责视频分解，AI/规则引擎负责校验、归类、诊断、建议。
- **AI 默认关闭**（`AI_ENABLED=false`，用户重成本）；三层 AI = 规则引擎（LLM 禁产数字）+ LLM 文案 + 人工审核。
- **不是什么**：不是标准工时/PMTS 系统（无 MTM / MOST / MODAPTS / GSD 动作码库），不是 MES/OEE 系统，
  不是审批或绩效管理系统。行业对标时须按「问题发现品类」而非「标准工时品类」比较（见进度报告）。

## 2. 核心工作流

```
视频（本地上传/手机拍摄） → 动作分解（人拆：分解工作台逐要素标注起止点）
                          → AI 校验（规则引擎 + 可选 LLM 文案/切分候选，浏览器端推理）
                          → 分析（VA/RNVA/NVA、CT、平衡率、瓶颈、浪费触发、ST 结构）
                          → 对比（版本 Diff、收益估算） → 改善建议（候选 → 采纳 → 改善任务）
```

## 3. 模块与边界（实码盘点 2026-11-18）

- **后端 `app/api/src/`**：15 个业务模块（ai-insight / ai-suggest / ai-waste / analysis / batch-export /
  cmc / compare / dashboard / decomposition-tasks / elements / lines / roles / settings / stations /
  suggestions / users / videos）+ 横切层 core / ai / audit / auth / health / rbac / tenant / entities。
- **前端 `app/web/src/`**：23 个页面 `React.lazy` 按 hash 路由拆包；`WorkbenchPage.tsx` 3081 行为核心页。
  `ai-segment/` 为独立 AI 自动分解子系统（motion / landmark / segmentation / hoi / sop），浏览器端推理、视频不上传；
  实为**确定性规则算法**（帧差运动能量默认 / MediaPipe 手部可选），**只产候选、不自动落库**，非 LLM 视觉模型。
- **规则集 `app/config/rules/`**：`va_rules.json`(RV3.x) / `waste_triggers.json`(RV1.4，18 条触发器，
  6 类基础浪费 + 第 7 类动作浪费 WT15–WT18) / `motion_standard.json`(MS1.4，14 一级 + 14 二级 = **28 类** + time_bucket；`va_rules.json` RV3.64 为 **44 类**) /
  `ecrsa_map.json`(RV1.1) / `redline_keywords.json`。**DB 优先、文件兜底，改 JSON 必须 publish 才生效**。
- **数据层**：SQL Server 17 生产库 `CN_AME`（`synchronize=false`）+ sqlite 开发库；同实例 CMC 产能库只读
  （SELECT-only，零同步）。`app/api/scripts/migrate.ts`（808 行）是**表结构唯一事实来源**。
- **外部**：IIS ARR 反代（未落地）、OIDC/Keycloak（未接入）、LLM 网关（可选，默认关）、ffmpeg 6.1.1 本地二进制。

## 4. 部署环境与并发口径

企业内网；Windows + SQL Server 17；IIS ARR 反代同机；Node 仅监听 `127.0.0.1:3001`；
前端 Vite 开发 5173（**注意 5173 常被另一项目占用，本项目显式用 `--port 5174 --strictPort`，见 R08**）；
并发口径 50+ 人。生产依赖 `test:deps` 为 api FAIL 10 high / 1 critical，尚无 CI。

## 5. 当前阶段（2026-11-18）

- 主链路（上传 → 分解 → 分析 → 建议 → 对比 → 批量导出）**已跑通且有契约与真人 Chrome 验收**。
- Phase 2（分解任务全链路）与 Phase 3（#103–#108 任务归属）**全部完成并验收**。
- **未部署、未接入 SSO、未跑现场 INP / spike / soak / SQL Server+IIS 生产容量**。
- 版本历史风险：git 仅 1 个提交（884b71e / 2026-11-09 init），成文时点有 **95 个文件未提交**（见 R07）。
  **文件数是快照、不是判据**：本轮评审新建 `memory/`、报告与日志后实测 98；0b 完成判据以
  `git status --porcelain` **为空** ＋ 已打 tag ＋ tag 含 `scripts/gates/` 为准，禁止按文件数核对。

## 6. 事实源与文档索引

| 文档 | 用途 |
|---|---|
| 本目录 `business_rules.md` | 业务口径唯一准绳 |
| `AGENT必读.md` | 第一入口：API 契约 + 任务看板 + 工程纪律 |
| `docs/CODE-WIKI.md` | 完整代码导航（2026-11-09） |
| `项目记忆.md` | 2026-10-24 历史快照（已冻结） |
| `deliverables/开发进度与后续重点难点.md` | 逐模块完成度评估与 P0/P1/P2（2026-11 初） |
| `docs/decisions/OPEN-DECISIONS.md` | 未决事项 |
| `app/web/docs/AI-SEGMENT-EVAL.md` | AI 切分评测基线（**在 app/web/docs，不在根 docs/**，见 R03） |
| `.workbuddy/memory/` | 会话工作日志（Append-only） |
