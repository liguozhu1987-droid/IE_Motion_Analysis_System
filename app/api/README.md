# IE改善平台 · 目标架构（v3.0 企业级演进版）

NestJS 10 + TypeScript + TypeORM 双数据源（**SQL Server 生产 / SQLite 开发**）的后端，面向多用户、数据隔离、RBAC、AI Agent、规则库五大场景。

> **架构设计全文**：`../../deliverables/系统架构设计-v3.0-企业级演进版.md`（选型/分层/DDL/部署/迁移路径，必读）
> **建表规范与部署手册**：`../../deliverables/SQL-Server建表规范与部署手册.md`（命名规则/外键清单/CN_AME 实操步骤）
> 业务口径与 MVP（`app/server/`）完全一致，本目录是上线态架构，MVP 代码为试点参考实现。

## 快速开始

```bash
npm install
npm run build
npm run seed     # 种子：admin/ie1/leader1/viewer1/other1，口令 123456（首次登录强制改密）
npm start        # http://127.0.0.1:3001/api（仅回环；Windows Server 上由 IIS ARR 反代）
npm run smoke    # 冒烟测试 137 项（认证/锁定/RBAC/租户隔离/规则/AI降级/审计/四大业务模块）
```

## 配置（单一事实来源：.env）

所有入口（`main.ts` / `scripts/*.ts` / `test/smoke.ts`）首行 `import 'dotenv/config'`，运行时全部读 `.env`：

```bash
cp .env.example .env   # 填入 DB_HOST/DB_USER/DB_PASS/DB_NAME 与 JWT 密钥后使用
```

关键项：`DB_TYPE=mssql`（生产）/ `sqlite`（开发）、`DB_NAME=CN_AME`、`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`（生产必填，fail-fast）。`.env` 已 gitignore，模板见 `.env.example`。

## SQL Server 生产（CN_AME 已验证）

```bash
# 1) 建表（幂等 DDL：13 表 + 10 外键 + 6 索引；库需已存在）
npm run migrate:prod
# 2) 种子（生产 synchronize=false，依赖第 1 步）
npm run seed
# 3) 启动（配置全在 .env）
npm start
# 4) 验证（137 项冒烟直连生产库）
npm run smoke
```

## 目录

```
src/
├─ main.ts / app.module.ts        # 启动 + 全局守卫/拦截器/过滤器链
├─ core/
│  ├─ config/                     # loadConfig 集中收口（fail-fast）+ dotenv 加载
│  ├─ database/                   # 双数据源 + BaseRepository（租户强制过滤 + 事务串行锁）
│  ├─ rules/{dsl.ts, rules.service.ts}  # 规则 DSL（MVP 平移）+ 双源加载/发布/自检
│  ├─ shared/util.ts              # 格式化/相似度
│  └─ all-exceptions.filter / metrics.interceptor
├─ auth/                          # JWT 登录/刷新/登出/改密 + AuthUserLoader
├─ rbac/                          # @Public / @RequirePermission / @CurrentUser / PermissionsGuard
├─ tenant/                        # TenantGuard + TenantInterceptor（AsyncLocalStorage）
├─ audit/                         # AuditInterceptor + t_audit_log
├─ ai/                            # LLM 网关 + ai_task 队列 worker + OutputSanitizer + 熔断
├─ entities/                      # 13 张表实体（业务表均含 tenant_id；与 migrate.ts DDL 一一对应）
└─ modules/                       # stations / elements / analysis / suggestions / compare / settings
```

## 三条铁律的架构落地

1. **AI 只建议不执行**——LLM 输出只进 `ai_task.output_json`；`t_improvement` 必须 IE 采纳才写。
2. **数字由规则算、LLM 不产数字**——`OutputSanitizer` 正则拦截含数字的润色输出，失败回退模板。
3. **数据质量靠校验不靠审批**——V1/V2/V3 服务端拦截 + 审计日志留痕。

## 已验证 / 未验证

- ✅ 编译通过；冒烟 **137/137**（sqlite 与 SQL Server 双环境各连续两轮全绿）。
- ✅ SQL Server（CN_AME@localhost）迁移 + 种子 + 生产启动 + 端点实测全部通过（2026-10-22）。
- ✅ 前端接入 v3.0（2026-10-22）：JWT 双令牌 + 强制改密 + 权限路由 + 四页面新契约；`npm run test:integration` 31/31 全链路联调、`npm run test:change-pwd` 改密流验证通过。
- ⏸ AI 网关内网 vLLM 接入（现为关闭降级态）。

## 2026-10-22 新增端点（前端接入支撑）

- `POST /auth/login` 与 `GET /auth/me` 返回 `mustChangePwd`（首次登录强制改密拦截）。
- `GET /stations/:id/versions`：版本清单（自 `t_element.bol_version` 聚合推导）。
- `DELETE /stations/:id/retest`：作废复测（删当前版本草稿 + 版本指针回退）。
- `GET /lines/:lineId/analysis` 的 `rows[]` 增加 `element_count`。
- `GET /config/benefit-params` 将历史 `by_line` 形态合并进 `lines` 只读视图。

完整 API 契约以项目根 **`AGENT必读.md` §5** 为准（唯一事实来源）。
