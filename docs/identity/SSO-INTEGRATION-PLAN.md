# 统一身份认证（OIDC / Keycloak）落地说明与决策记录

> 状态：**一期已落地（2026-11-06）**。依据根目录 `统一身份认证技术交底书_MSIA与BOL实施实录.md`
> 的接口契约实现；**交底书与本文早期方案冲突时一律以交底书为准**，差异集中记在 §5。
>
> 本系统是「双轨开关」：`AUTH_OIDC_ENABLED` 与 `AUTH_LOCAL_LOGIN_ENABLED` 可独立切换；
> 两个开关都关闭会在启动期直接 fail（防全员锁死）。未开启 OIDC 时，登录/刷新/登出/`/auth/me`
> 行为与改造前完全一致（既有 auth/rbac 套件零退化，见 §10）。

---

## 1. 契约落点（交底书 → 本仓库）

### 1.1 五表

五张表在 `CN_AME` 库，前缀 `CN_AME_SSO_`。本系统**只读**其中两张，不写不回填：

| SSO 表 | 本系统用法 | 读写 |
|---|---|---|
| `CN_AME_SSO_User` | 身份事实来源：`employee_no / login_name / display_name / email / status` | 只读 |
| `CN_AME_SSO_UserMap` | `(employee_no, system_code) → local_username` | 只读 |
| `CN_AME_SSO_StgAdUser` | 不使用 | — |
| `CN_AME_SSO_SyncLog` | 不读取（运维排障用） | — |
| `CN_AME_SSO_PermLedger` | 不使用（角色由本地 RBAC 决定，D4） | — |

实体定义 [sso.entity.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/entities/sso.entity.ts) 只声明集成必读字段；
生产 `synchronize=false`，若现场 DDL 字段名不一致会**明确失败而不是静默放行**（fail-fast 是期望行为）。

### 1.2 端点

| 端点 | 方法 | 行为 |
|---|---|---|
| `/api/auth/config` | GET | 公开；`{ oidcEnabled, localLoginEnabled, registrationEnabled, passwordSelfServiceEnabled, oidcLoginPath }` |
| `/api/auth/oidc/login` | GET | 生成 state/nonce/PKCE，302 到 IdP 授权端点；OIDC 关闭时 404 |
| `/api/auth/oidc/callback` | GET | 一次性消费 state → 换令牌 → RS256 验签 → 身份解析 → 签发本地 JWT → OTK → 302 前端 `#/oidc/callback?otk=` |
| `/api/auth/oidc/token` | POST | OTK（60 秒、单次）换 `{ accessToken, refreshToken, tokenType, expiresIn, mustChangePwd:false }` |
| `/api/auth/me` | GET | **只加字段**：`authSource: 'local'|'oidc'`、`ssoEmployeeNo: string|null` |
| `/api/auth/logout` | POST | 只吊销本地 refresh，不跳 IdP 单点登出（D6） |

实现文件：[oidc.controller.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/auth/oidc/oidc.controller.ts)、
[oidc-client.service.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/auth/oidc/oidc-client.service.ts)、
[oidc-state.store.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/auth/oidc/oidc-state.store.ts)。

安全参数：授权码 + PKCE S256；ID Token 仅 RS256 + JWKS（拒绝 `none`/`HS256`，防算法混淆）；
校验 `iss / aud / azp / exp / iat(±60s) / nonce / sub`；state 一次性、10 分钟过期；
discovery/JWKS 缓存 10 分钟（验签失败强制刷新一次 JWKS）；OTK 60 秒单次；本地 Token 不进 URL。

### 1.3 双轨开关矩阵

| OIDC | LOCAL | 登录页 | 会话 | 用途 |
|---|---|---|---|---|
| 0 | 1 | 仅本地账号密码（**与改造前完全一致**） | 本地 JWT | 现状 / 回滚态 |
| 1 | 1 | 本地 + 「统一身份登录」 | 本地 JWT（两种入口都签发） | 双轨并行 |
| 1 | 0 | 仅 SSO 入口 | 本地 JWT | 单轨 |
| 0 | 0 | 启动期 fail | — | 防锁死 |

配置读取见 [configuration.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/core/config/configuration.ts)，
启动自检见 [startup-check.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/core/startup/startup-check.ts)：
`SSO_OIDC`（开启但缺 secret/redirect → warn 并给出 remediation）、`LOCAL_LOGIN`（关闭 → warn）、`SELF_REGISTER`（关闭 → ok）。

### 1.4 身份解析与拒绝码

顺序（[sso-identity.service.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/auth/oidc/sso-identity.service.ts)）：

```text
1. groups 准入（AUTH_OIDC_REQUIRED_GROUP，兼容 "/app-ie" 与 "app-ie"）   → group_denied
2. 中央表按 login_name 查询（表不可用 → directory_unavailable）          → central_not_found
3. 中央 status 必须为 1                                                 → account_disabled
4. UserMap(employee_no, system_code) → local_username；未命中回落 login_name
5. 本地 t_user 先按 employee_no 再按 username 命中
   - 工号属于另一个人 → employee_conflict（拒绝而非自动改绑）
   - 非 active → account_inactive
6. 未命中 + 允许自动建档 → 建号 + 默认角色 viewer                         → provision_failed / username_invalid
```

所有拒绝都写 `t_audit_log`（`sso.login_rejected`，`entity_id` = login_name），前端展示为
`#/oidc/callback?error=<code>` 的中文提示。

### 1.5 离职回写

[sso-status-sync.service.ts](file:///d:/Application/IE_Improvement_Platform/app/api/src/auth/oidc/sso-status-sync.service.ts)：
OIDC 开启时启动即跑一次，随后每小时；只处理 `auth_source='oidc'` 且已绑定工号的本地账号。
中央 `status=0` → 本地 `disabled` + 吊销全部 refresh + `sso.status_sync` 审计；
中央查无此人 → 只 warn 一次，**不锁人**；账号与历史数据保留，不物理删除。

---

## 2. 最终决策（D1–D12）

| # | 决策 | 落地位置 |
|---|---|---|
| D1 | `UserMap.system_code = 'ie'` | `AUTH_OIDC_SYSTEM_CODE` 默认 `ie` |
| D2 | 中央有、本地无 → 自动建档 | `AUTH_OIDC_AUTO_PROVISION` 默认 `true` |
| D3 | 默认角色 `viewer` | 取 `r_DEFAULT_viewer`，缺失则拒绝建档并审计 |
| D4 | 中央表权威，**不回写本地 `t_role`** | 自动建档只写 `t_user` + `t_user_role`；已有账号角色不动 |
| D5 | 双轨期允许本地账号登录 | `AUTH_LOCAL_LOGIN_ENABLED` 默认 `true` |
| D6 | 登出只清本地态，不做单点登出 | `/auth/logout` 仅吊销 refresh，不跳 `end_session_endpoint` |
| D7 | SSO 用户跳过强制改密 | `must_change_pwd=0`；OTK 兑换应答恒 `mustChangePwd:false` |
| D8 | client `ie-platform` / 准入组 `app-ie` | `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_REQUIRED_GROUP` 默认值 |
| D9 | 保留本地自助注册能力，默认关闭 | `AUTH_REGISTRATION_ENABLED` 默认 `false`（兼容旧别名 `REGISTER_ENABLED`） |
| D10 | 中央表查无此人 → 拒绝并记审计 | `central_not_found` + `sso.login_rejected` |
| D11 | 离职标记禁用、不删账号；复用每小时任务 | 见 §1.5 |
| D12 | 一期 state/OTK 用进程内存 | `OidcStateStore`；**上 IIS/ARR 或多实例前必须落库** |

> D9 的别名兼容：隔离基座的既有套件注入 `REGISTER_ENABLED=true`，配置读取
> `AUTH_REGISTRATION_ENABLED ?? REGISTER_ENABLED ?? 'false'`，因此老套件不退化。

---

## 3. 与交底书的差异（逐条记录）

| # | 交底书口径 | 本系统实现 | 原因 |
|---|---|---|---|
| 1 | BOL §8：中央 `status=1` 时本地恢复 `ACTIVE` | **只停用，不自动恢复**；复职由管理员在用户管理页手工启用 | 避免下一次同步把管理员手工停用的账号复活；单向策略语义明确 |
| 2 | 交底书未定义「账号来源」列 | 新增 `t_user.auth_source`（`local|oidc`）与会话来源 JWT `src` / `t_refresh_token.source` | 用于区分「本地密码可否登录」、离职回写范围与审计；**只是加法** |
| 3 | 交底书要求回调地址固定 | 未配置 `AUTH_OIDC_REDIRECT_URI` 时按请求 Host 推导，供单机/隔离测试；生产必须显式固定（启动期 warn） | 隔离环境端口随机，无法预知；生产强制固定避免 Host 注入 |
| 4 | 交底书 §6.4 身份解析未细化「未知人员」粒度 | 中央表查无此人**直接拒绝**并审计 | D10 取最保守口径，避免凭 IdP 自述身份建档 |
| 5 | 交底书把 state/nonce 放进程内存（单实例） | 一期同样内存态 | D12；文档明确标注多实例前必须落库 |
| 6 | BOL 的 `SELF_REGISTRATION_ENABLED` 由现场定 | 本系统默认关闭（D9） | 与「登录入口统一」目标一致，减少影子账号 |
| 7 | 交底书五表全部只读参考 | 本系统只读 `User` 与 `UserMap`，不读 `PermLedger` | D4：角色只由本地 RBAC 决定 |

---

## 4. 表结构与手工 SQL

**不接入自动 migrate**。脚本：[2026-11-06-auth-sso.sql](file:///d:/Application/IE_Improvement_Platform/deploy/sql/manual/2026-11-06-auth-sso.sql)。

- 预检五表是否存在（缺失只提示，不阻断本系统建列）；
- `t_user.auth_source NVARCHAR(8) NOT NULL DEFAULT N'local'`（`COL_LENGTH` 幂等）；
- `t_refresh_token.source NVARCHAR(8) NOT NULL DEFAULT N'local'`；
- `idx_user_employee_no`（工号查询索引）；
- 校验 SELECT + 回滚段（DROP CONSTRAINT / COLUMN / INDEX）；
- SQLite 变体（开发库/隔离库）。

执行顺序：停应用 → 备份 `t_user`/`t_refresh_token` → 执行脚本 → 启动并跑 `ops:startup-check`。

---

## 5. 配置项

已写入 [.env.example](file:///d:/Application/IE_Improvement_Platform/app/api/.env.example)，**默认值与现状一致**：

```ini
AUTH_OIDC_ENABLED=false
AUTH_LOCAL_LOGIN_ENABLED=true
AUTH_REGISTRATION_ENABLED=false
AUTH_OIDC_ISSUER=
AUTH_OIDC_CLIENT_ID=ie-platform
AUTH_OIDC_CLIENT_SECRET=      # 只由部署环境注入，不入库、不入文档
AUTH_OIDC_REDIRECT_URI=       # 生产必须固定；留空则按请求 Host 推导（仅单机/测试）
AUTH_OIDC_REQUIRED_GROUP=app-ie
AUTH_OIDC_AUTO_PROVISION=true
AUTH_OIDC_SYSTEM_CODE=ie
AUTH_OIDC_DEFAULT_ROLE=viewer
AUTH_OIDC_FRONTEND_CALLBACK=#/oidc/callback
AUTH_OIDC_TIMEOUT_MS=5000
```

---

## 6. 前端改动

| 文件 | 改动 |
|---|---|
| [LoginPage.tsx](file:///d:/Application/IE_Improvement_Platform/app/web/src/pages/LoginPage.tsx) | 拉 `/auth/config`；`oidcEnabled` 才显示「统一身份登录」，本地表单按 `localLoginEnabled` 显示；注册/找回入口按开关显示 |
| [OidcCallbackPage.tsx](file:///d:/Application/IE_Improvement_Platform/app/web/src/pages/OidcCallbackPage.tsx) | 解析 hash 中的 `otk/error`；兑换 → `api.me()` → 按权限分流；错误码中文映射并回登录页 |
| [auth.tsx](file:///d:/Application/IE_Improvement_Platform/app/web/src/auth.tsx) | `completeSsoLogin(otk)`：兑换、落令牌、拉 `/auth/me` |
| [VideoLibraryPage.tsx](file:///d:/Application/IE_Improvement_Platform/app/web/src/pages/VideoLibraryPage.tsx) | 「站内标记」所需视频库页：`GET /videos/assets`、再保留 10 天 / 永久保留 / 立即删除（`can_manage` 收口） |
| [App.tsx](file:///d:/Application/IE_Improvement_Platform/app/web/src/App.tsx) | `#/oidc/callback` 公开路由、`#/videos` 路由与导航（`station:read` 权限） |
| 样式 | `styles/login.css` 增 SSO 入口/回调卡片；新增 `styles/videos.css`（沿用现有柔和工业风，无装饰性 emoji） |

登出：沿用 `auth.tsx#logout` 的本地登出，不跳 IdP（D6）。

---

## 7. 测试与证据

### 7.1 假 OIDC 提供方

现场没有可连的 IdP，测试用本地假提供方（临时进程、随机端口、纯 HTTP、RSA 密钥）：
[fake-oidc-provider.cjs](file:///d:/Application/IE_Improvement_Platform/app/api/test/fake-oidc-provider.cjs)。

覆盖：discovery、`/jwks`、`/authorize`（PKCE S256）、`/token`（client_secret + redirect_uri + verifier + code 单次）、
`/__control`（切换用户与异常模式：`bad_nonce / bad_aud / bad_iss / bad_signature / expired / no_group / idp_error / token_error`）。
client_secret 使用测试值并由进程环境注入，不落仓库文件。

### 7.2 套件接入

```bash
npm run test:sso:isolated     # 只跑 SSO（dual 两遍 + off + nolocal）
npm run test:isolated         # 全量既有隔离套件 + SSO（已链式接入）
```

启动器 [sso-oidc-isolated.cjs](file:///d:/Application/IE_Improvement_Platform/app/api/test/sso-oidc-isolated.cjs) 复用隔离基座
（临时 SQLite + 随机端口 + 自动清理，不连 `CN_AME`）；用例 [sso-oidc-flow.cjs](file:///d:/Application/IE_Improvement_Platform/app/api/test/sso-oidc-flow.cjs)。

### 7.3 实测结果

| 套件 | 结果 |
|---|---|
| `sso-dual`（OIDC 开 + 本地开） | 25/25 通过，连续两遍一致 |
| `sso-off`（OIDC 关） | 6/6 通过（四端点 404、本地登录与 `/auth/me` 不变、零副作用） |
| `sso-nolocal`（本地登录关） | 4/4 通过（本地登录 403、SSO 与 refresh 可用） |
| `auth-management-flow` | 48/48 通过（未退化） |
| `rbac-v358` | 46/46 通过（未退化） |
| `permission-matrix` | 125/125 通过（未退化） |
| `smoke` | 147/147 通过（未退化） |
| 前端 | `npm run typecheck` 与 `npm run build` 通过 |

`sso-dual` 覆盖：登录跳转与 PKCE、state/nonce 校验、回调换令牌、id_token 验签（含五类异常）、
自动建档 + viewer 角色、UserMap 映射与回落、拒绝未知用户并审计、离职停用 + 吊销 refresh、
OTK/state 单次消费、SSO 账号拒绝本地口令、双轨本地登录不退化、会话刷新保持来源、登出、注册关闭。

### 7.4 未验证项（如实说明）

- **未接真实 Keycloak**：本地假提供方只覆盖协议与错误分支，真实 realm 的 discovery 字段、
  组路径、令牌有效期、`ssl-required` 行为未联调；
- **未做浏览器级 E2E**：仅类型检查与构建通过；登录页 SSO 按钮、回调页跳转、视频库操作未在真实浏览器点击验证；
- **未上 IIS/ARR 与多实例**：D12 内存态在该部署形态下会丢 state，必须先落库；
- **未连生产 `CN_AME`**：中央表真实 DDL 与字段名未核对（若不一致，登录会 fail-fast 而非静默放行）。

---

## 8. 运维与上线前置

1. Keycloak 停在 **25.0.6**（26.x 的 `OPTIMIZE_FOR_SEQUENTIAL_KEY` 与 SQL Server 2017 不兼容）；
2. 在 realm `inalfa` 建 confidential client `ie-platform`，redirect URI 精确匹配
   `https://<平台域名>/api/auth/oidc/callback`；准入组 `app-ie` 授予 IE 用户；
3. client secret 只通过部署环境注入（DPAPI/进程环境），不入库不入文档；
4. 回调地址必须 HTTPS（Keycloak 默认 `ssl-required=external`），**一期明文 HTTP 只在 localhost 用于开发**；
5. 首次切换建议顺序：OIDC 开 + 本地开（双轨观察）→ 中央表状态同步核对 → 再评估是否关闭本地入口；
6. 回滚：`AUTH_OIDC_ENABLED=false` 即回到现状，无需改库或重发前端（登录页按 `/auth/config` 渲染）。

---

## 9. 明确不做的事

- 不做单点登出（不跳 `end_session_endpoint`）；
- 不同步/回写中央 `PermLedger` 角色；
- 不自动执行任何 `CN_AME` 写入或表结构变更（全部走 `deploy/sql/manual/` 人工脚本）；
- 不引入 `openid-client` 等第三方依赖（discovery/PKCE/JWKS 用 `node:crypto` + `fetch` 闭环）。
