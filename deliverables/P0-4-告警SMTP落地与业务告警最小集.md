# P0-4 告警 SMTP 落地与业务告警最小集

> 工作区：`d:\Application\IE_Improvement_Platform`　｜　范围：后端告警模块 + 只读观测端点 + 验证脚本
> 本轮不改前端页面、不写生产库 `CN_AME`、不改动另一条线 4 个未提交测试文件、不 push。

## 一、结论（先看这里）

### 1. 真正跑通的规则

6 条规则全部走同一个 `AlertMonitorService` 评估、同一条 `AlertMailerService` 通知：

| 层级 | 规则 | 是否本轮新增 | 验证结论 |
|---|---|---|---|
| 运维 | 登录锁定激增 | 否（沿用） | 回归单测通过 |
| 运维 | AI 任务堆积 | 否（沿用） | 回归单测通过 |
| 运维 | HTTP 错误率 | 否（沿用） | 回归单测通过 |
| 业务 | 派生失败率 | **是** | 触发/告警/不重发/恢复/恢复一次/冷却抑制，全部跑通 |
| 业务 | AI 任务失败率 | **是** | 同上 |
| 业务 | 派生磁盘占用 | **是（接入统一规则表）** | 同上；检测与 LRU 仍由 P0-1 worker 执行，通知收敛到告警模块，未造第二条发信通道 |

### 2. 磁盘告警去重口径

P0-1 的 derivative worker 仍负责：`du` → 判定超限 → LRU 只淘汰 proxy → 写 `diskGuardRuntime`。
P0-4 起 worker **不再直接发邮件**，磁盘条件的日志/邮件由 `AlertMonitorService` 统一发出。
这样同一超限事件只有一条通知链路，且 `/api/alerts/status` 能统一看到 6 条规则状态。
P0-1 的 `/api/videos/storage` 字段 `last_disk_alert_at` 保持兼容（worker 首次判定超限时写入）。

### 3. 验证方式与结果

| 验证 | 命令 | 结果 |
|---|---|---|
| 告警全链路（临时 SQLite + 本地假 SMTP 接收端） | `node test/alert-pipeline-p0-4.cjs` | **26 通过 / 0 失败** |
| 现有告警规则纯函数回归 | `node test/test-alert-rules.cjs` | **12 通过 / 0 失败** |
| P0-1 视频容量护栏回归（含 `last_disk_alert_at`） | `node test/video-capacity-guard.cjs` | **32 通过 / 0 失败** |
| 真实 SMTP 发信（本地公网邮箱，465/SSL） | 进程环境变量注入 + `AlertMailerService.send` | **`SEND_RESULT true`**（SMTP 服务器已接受） |
| 生产 SMTP `172.19.253.10:25` | — | 开发机网络不可达，属预期内，**未做联通验证** |

全链路脚本实际覆盖的链路：

1. 基线正常 → 不发告警；
2. 派生失败率、AI 任务失败率、派生磁盘占用同时越限 → **各发 1 封**，假 SMTP 接收端各收到 1 封；
3. 条件持续为真继续巡检 → **不重复发**（边沿触发）；
4. 数据恢复 → **各发 1 封恢复通知**；
5. 再巡检 → **恢复通知不重发**；
6. 冷却期内再次越限 → **静默抑制**，但 `/api/alerts/status` 仍能看到本轮实测失败率；
7. 业务阈值全部未配置 → 规则 `configured=false`、不发信、不做业务窗口统计；
8. `GET /api/alerts/status` 权限元数据为 `audit:read`，返回 6 条规则。

隔离说明：全链路测试使用 `os.tmpdir()` 下的临时 SQLite 与 `127.0.0.1` 随机端口假 SMTP，收尾整目录删除；未连接 `CN_AME`，未写入正式开发库。本地真实发信只使用进程环境变量，凭据未写入 `.env.example`、文档、测试脚本或日志。

## 二、改动清单

| 文件 | 改动 |
|---|---|
| `app/api/src/core/config/configuration.ts` | 新增 `ALERT_DERIVE_FAIL_PCT` / `ALERT_AI_FAIL_PCT` / `ALERT_FAIL_WINDOW_MIN` / `ALERT_FAIL_MIN_SAMPLE` 解析；非法/空值一律 `null`（未配置） |
| `app/api/src/core/alert/alert-rules.ts` | 新增 3 条业务规则与三态判定（`null`=本轮不可判定，不发火也不恢复）；保留原 3 条运维规则语义 |
| `app/api/src/core/alert/alert-monitor.service.ts` | 业务快照采集（失败率窗口 + 磁盘运行时）、6 规则状态机、启动期未配置显式 warn、`getStatus()` |
| `app/api/src/core/alert/alerts.controller.ts`（新增） | `GET /api/alerts/status`，`@RequirePermission('audit:read')`，只读 |
| `app/api/src/core/alert/alert.module.ts` | 注册 controller；导出 monitor/mailer |
| `app/api/src/core/alert/mailer.service.ts` | `send()` 返回 `boolean`（true=已交给 SMTP，false=未配置/失败），失败仍只记日志不抛 |
| `app/api/src/core/alert/alert-runtime.ts`（新增） | 磁盘治理共享运行时状态（避免 core 反向依赖 feature 模块） |
| `app/api/src/modules/videos/derivative-capacity.ts` | 原 `diskGuardRuntime` 改为 re-export 共享状态 |
| `app/api/src/modules/videos/derivative-worker.service.ts` | 删除重复的邮件告警/恢复发送；保留 du、超限判定、LRU、`last_disk_alert_at` 兼容写入 |
| `app/api/src/modules/videos/videos.module.ts` | 移除不再使用的 `AlertModule` 导入 |
| `app/api/.env.example` | 生产推荐 SMTP（`172.19.253.10:25`、无认证）与业务阈值字段说明；**无任何真实凭据** |
| `app/api/test/alert-pipeline-p0-4.cjs`（新增） | 临时 SQLite + 本地假 SMTP 全链路验证（非生产脚本，带 NON_PRODUCTION 标记） |

## 三、规则表

统一状态机：条件 `false→true` 发一次告警；`true→false` 发一次恢复；同一规则两次告警间隔不小于 `ALERT_COOLDOWN_MIN`（默认 30 分钟）。

| 规则 | 触发条件 | 阈值来源 | 恢复条件 |
|---|---|---|---|
| 登录锁定激增 | 当前锁定账号数 `>=` 阈值（`status='locked'` 或 `locked_until>now`） | `ALERT_LOGIN_LOCKED_MAX`（默认 5，沿用） | 锁定数回落到阈值以下 |
| AI 任务堆积 | `t_ai_task` 中 `pending` 数量 `>` 阈值 | `ALERT_AI_TASK_BACKLOG`（默认 50，沿用） | pending 回落到阈值内 |
| HTTP 错误率 | 两次巡检增量的 5xx 占比 `>=` 阈值%，且窗口请求数 `>=` 最小样本 | `ALERT_ERROR_RATE_PCT`（默认 1）+ `ALERT_ERROR_MIN_REQUESTS`（默认 20，沿用） | 增量错误率回落到阈值以下；样本不足时本轮不判定 |
| 派生失败率 | 窗口内 `error 且 retry>=2` / (`ready` + 上述失败) `>=` 阈值% | `ALERT_DERIVE_FAIL_PCT`、`ALERT_FAIL_WINDOW_MIN`、`ALERT_FAIL_MIN_SAMPLE`；**任一未配置 = 规则关闭** | 失败率回落到阈值以下；样本不足视为不可判定，不误发恢复 |
| AI 任务失败率 | 窗口内 `failed` / (`done` + `failed`) `>=` 阈值% | `ALERT_AI_FAIL_PCT` + 同一窗口/最小样本；**任一未配置 = 规则关闭** | 同上 |
| 派生磁盘占用 | worker `du` 实测 derived/ 占用 `>` 上限 | `VIDEO_DERIVED_MAX_GB`（复用 P0-1，未配置 = 规则关闭且 worker 不 du/不淘汰） | worker 下一轮 du 回落阈值内 |

补充口径：

- 派生失败只统计**终态失败**（`retry>=2`），`retry<2` 的 error 行会被 worker 自动重入，计入会虚高。
- AI 任务只统计终态 `done/failed`；`quota_exceeded` 在提交阶段记为 failed，也会计入失败率。
- 业务阈值「不猜」：未配置时不写默认值，启动期 `warn` 明确提示，`/api/alerts/status` 返回 `configured=false`。
- SMTP 启用条件：`SMTP_HOST` 与 `ALERT_MAIL_TO` 都非空；`SMTP_PORT=465` 自动 `secure=true`，465 以外按 STARTTLS/明文协商；`SMTP_USER` 为空即无认证（适配生产内网中继）。
- 凭据只从环境变量读取；`send()` 失败只记 `warn`，绝不阻断巡检主流程。

## 四、观测端点

`GET /api/alerts/status`（权限：`audit:read`）返回：

- `smtp.enabled`（不回传账号/密码）；
- `check_sec`、`cooldown_min`、`last_check_at`；
- `rules[]`：`code`、`name`、`configured`、`threshold`、`firing`、`last_fire_at`、`last_event`、`last_recovery_at`、`last_recovery`、`observed`（各规则本轮实测值）。

本轮不新增前端页面：最小可观测面先由只读端点 + 结构化日志满足排障；前端告警页涉及权限矩阵、历史告警存储与设计稿，建议作为后续独立任务，避免在缺少产品口径时先做一版会返工的 UI。

## 五、未验证项与验证边界

1. **生产 SMTP `172.19.253.10:25` 未联通验证**：开发机访问不到该内网地址，属已知网络隔离；代码已按「无认证 + 25 端口」配置，需在可连通生产网段的机器上补一次 `send()` 联通验证。
2. **本地真实发信只验证到 SMTP 接受**：本地公网邮箱 465/SSL 下 `sendMail` 返回成功（服务器已接受），未通过 IMAP 自动核对收件箱；「收件箱人工可见」需人工登录确认。
3. **真实业务阈值未定稿**：3 条业务规则默认全部关闭，需要现场确认失败率基线、统计窗口、最小样本后才能启用；本轮没有写死任何默认。
4. **MSSQL 实库未执行**：失败率查询只使用 `status` / `retry` / `updated_at` 与 TypeORM 参数绑定，SQLite 已验证；未在专用 SQL Server 测试库上复跑（遵循不写 `CN_AME` 约束）。
5. **多实例部署未验证**：`firing` / 冷却状态是进程内状态，当前仅适用单实例；多副本需要共享状态存储（本轮未做）。
6. **30 分钟冷却跨真实时间边界**：全链路测试用「立即再越限」验证冷却抑制；「冷却期满后补发」由现有纯函数单测覆盖，未真实等待 30 分钟。
7. **前端页面未做**：见第四节理由。
8. **另一条线 4 个测试文件**（`workbench-segment-stop.cjs`、`isolated-harness.cjs`、`isolated-run.cjs`、`db-client.cjs`）未修改、未提交。

## 六、提交信息

- 提交信息：`feat(alert): P0-4 告警 SMTP 落地与业务告警最小集`
- 提交方式：仅本地提交，未 push；具体 commit hash 见本轮终端输出。
- 提交前自查：`git grep` 已确认受版本控制文件中不含真实 SMTP 授权码与测试邮箱账号；`.env.example` 仅含生产推荐地址与字段说明。
