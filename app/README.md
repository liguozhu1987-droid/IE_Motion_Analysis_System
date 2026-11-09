# IE改善效率平台 · MVP 工程骨架

AI赋能IE改善效率工具的可运行实现：**4个页面 / 3张表16字段 / 规则引擎驱动**。
设计依据：`deliverables/MVP详细设计-00~04` + `deliverables/MVP系统架构设计.md`。

## 快速开始

```bash
npm install          # 仅前端需要构建依赖；后端零依赖
npm run seed         # 首次：灌入演示线 L01（6工位，ST03已复测）
npm run dev          # API :3001 + Vite :5173（代理 /api）
# 生产模式
npm run build && npm start   # 单进程 :3001，同源托管前端
npm run smoke        # 39项接口冒烟（需服务已启动）
node scripts/e2e.js  # 11项端到端链路（建→导入→分析→复测→对比，自带清理）
```

打开 http://localhost:5173（开发）或 http://127.0.0.1:3001（生产）。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 服务端 | Node 22 + `node:http` + `node:sqlite` | **零运行时依赖**，离线可部署 |
| 数据库 | SQLite（WAL）单文件 `data/ie.db` | 备份=复制文件 |
| 前端 | Vite 6 + React 19 + TypeScript | 图表全部手绘 SVG，无图表库 |
| 规则 | JSON 文件（`config/rules/*.json`，RV版本） | 改规则=改文件+重启；DSL 禁 eval |

## 目录

```
config/rules/    va_rules / waste_triggers / ecrsa_map / redline_keywords
config/          benefit_params.json（线级收益参数）
server/src/      index / config / logger / errors / routes / http / db / rules / shared / features
web/src/         api / constants / App / styles / components / pages
scripts/         dev.js（双进程）/ smoke.js / e2e.js
data/ie.db       运行时数据库（gitignore）
```

## 接口速查

`GET /api/health` `GET /api/rules` `GET /api/lines` `GET /api/stations?line_id=`
`POST /api/stations` `GET /api/stations/:id` `POST /api/stations/:id/retest` `DELETE /api/stations/:id/retest`
`POST /api/stations/:id/elements/{validate|submit}` `POST /api/stations/:id/import` `GET /api/stations/:id/export.csv`
`POST /api/elements/:id/va` `POST /api/elements/:id/va-confirm`
`GET /api/stations/:id/analysis` `GET /api/lines/:lineId/analysis`
`POST /api/stations/:id/suggestions/{generate|adopt}` `GET /api/improvements` `PATCH /api/improvements/:id/status`
`GET /api/stations/:id/compare` `GET/PUT /api/config/benefit-params`

错误体统一：`{ title, status, detail, request_id, details? }`；校验失败=422，状态冲突=409。

## 环境变量

`PORT`(3001) `HOST`(127.0.0.1) `DB_PATH` `RULES_DIR` `WEB_DIST` `ORIGIN`(http://localhost:5173) `LOG_LEVEL`(info) `SEED`(1) `MAX_BODY_BYTES`(5MB)

## 已实现的MVP纪律

- 3条即时校验（V1必填/V2时间轴重叠/V3循环数<15）**服务端拦截提交**
- CT = Σ生效且非异常要素ST；异常要素单列、不进山积图
- 复测=版本指针推进：`bol_version < station.version` 天然只读，写操作有守卫，不可解封
- 建议先生成候选、**IE点采纳才落库**；2条红线命中→提示+确认人放行
- 收益公式固定：`ΔCT × 日产量 × 365 × 费率(元/h) ÷ 3600 × 落地率`，参数未配置则阻断

## 尚未实现（按MVP闸门延后）

登录/权限（仅内网）、LLM润色、.xlsx直读、审批流、效益台账、RAG案例库。
