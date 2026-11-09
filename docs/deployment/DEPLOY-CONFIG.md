# 系统配置说明 · 部署与访问配置（IE 改善平台 · 视频分析）

> 适用范围：将「IE 改善平台」部署到生产服务器 `IRScnKettle01.ap.inalfa.local`。
> 关联决策：`ADR-VID-001.md`（视频管线架构）、`OPEN-DECISIONS.md`（决策门 1 已 RESOLVED 选 B 通道 AD CS）。

---

## 0. 部署服务器（已确认）

| 项 | 值 |
|---|---|
| 计算机名 | `IRScnKettle01` |
| 全名（FQDN） | `IRScnKettle01.ap.inalfa.local` |
| 域 | `ap.inalfa.local`（已加域，Windows AD） |
| 应用形态 | **一期上线**：NestJS 单进程同时托管 API(`/api`) 与 SPA(`web/dist`)；IIS/ARR 降为二期 |
| Node 监听 | HTTP，默认端口 3001；一期直连需设 `HOST=0.0.0.0`（二期由 IIS 反代时改回 `127.0.0.1`） |
| HTTPS | **一期：明文 HTTP（内网直连）**；二期：IIS ARR 反代 + AD CS 证书终止 TLS（见 §8） |

---

## 1. 访问 URL 约定（核心）

**一期上线（当前路径）= Node 直连，用户访问 `http://IRScnKettle01.ap.inalfa.local:3001`。**

- **一期（Node 托管静态 + API）**：Node 监听 `0.0.0.0:3001`，内网防火墙仅对 LAN 开放 3001；`http://IRScnKettle01.ap.inalfa.local:3001`。
  - 代价：**明文 HTTP 不满足 Secure Context**，WebCodecs / getUserMedia 等 P1/P2 能力在一期不可用（`localhost` 除外）。
  - 若现场必须 HTTPS，只能等二期 IIS+AD CS，或另行实现 Node 侧 TLS（当前 `main.ts` 未实现）。
- **二期（IIS/ARR）**：IIS 监听 443 做 TLS 终止 + 反代到 `127.0.0.1:3001`，用户访问 `https://IRScnKettle01.ap.inalfa.local`（无端口）。
  **端口号不影响安全上下文判定**——`https://` + 受信任证书下，任意端口都属于 Secure Context。
- **端口口径（二期）**：外部端口 = IIS 443；内部端口 = Node 3001，只对回环监听，不对外暴露。

**域名默认值 = `IRScnKettle01.ap.inalfa.local`**，写入部署文档与可选环境变量 `APP_PUBLIC_HOST`。
SPA 为同源 hash 路由，页面内导航不需要绝对 URL；该变量仅用于将来生成可分享链接 / PWA scope 等场景。

---

## 2. 部署拓扑

**一期（当前上线路径，无 IIS/ARR）：**
```
浏览器(域成员机)
   │  HTTP  :3001   （内网明文，仅对 LAN 开放）
   ▼
Node 单进程 (0.0.0.0:3001)
   └─ 托管 web/dist（SPA）+ /api（NestJS）+ 视频文件/派生静态
```

**二期（待启用，见 §8）：**
```
浏览器(域成员机)
   │  HTTPS  :443   (证书 = AD CS 签发 IRScnKettle01.ap.inalfa.local)
   ▼
IIS + ARR 反向代理  ──(SSL 卸载 + 反向代理 / 和 /api)──►  Node (127.0.0.1:3001, HTTP)
```

- 一期不需要 `web.config`、URL Rewrite、ARR、AD CS 证书；`web.config` 仅保留为二期模板，**不是当前上线路径**。
- 一期 `WEB_DIST` 必须指向 `app/web/dist`（或打包随附的 web 目录），否则 SPA 不挂载（`/api` 仍可用）。

---

## 3. 前置依赖（服务器侧）

- **Node.js**：与开发同版本；用 NSSM 或 pm2 服务化（项目既定：无 Docker）。
- **SQL Server `CN_AME`**：生产库（mssql）；CMC 同实例跨库只读（SELECT-only）。
- **ffmpeg**：本机必须存在 `app/api/bin/ffmpeg.exe`（ffmpeg-static npm 二进制不会自动下载，需手动放置；实测 6.1.1 gyan build）。
- **AD CS 企业 CA**：见 §4（安全上下文落地）。
- **防火墙**：一期仅对 LAN 开放 Node 3001（`HOST=0.0.0.0`）；二期改为仅开放 IIS 443，Node 3001 回到 127.0.0.1。

---

## 4. AD CS 证书（安全上下文落地 · B 通道）

> WebCodecs / getUserMedia（P1/P2 功能）需要 Secure Context；本域 `.local` 公共 CA 无法发证，故走 AD CS 内部 CA（零费用）。

1. **先确认域内是否已有企业 CA**：`certutil -config - -ping` 或 `certsrv.msc`。已有则跳过安装。
2. **安装 AD CS 企业根 CA**（若无）：
   `Install-WindowsFeature ADCS-Cert-Authority -IncludeManagementTools`
   `Install-AdcsCertificationAuthority -CAType EnterpriseRootCa -KeyLength 2048 -HashAlgorithmName SHA256 -ValidityPeriod Years -ValidityPeriodUnits 10`
3. **建 Web Server 模板 `HTTPS-Internal`**：复制「Web Server」→ 有效期 **5 年** →「申请处理」启用自动颁发 → 安全选项卡给 **Domain Computers** 授予 **读取 + 注册 + 自动注册**（漏「自动注册」是头号失败原因）→ 在 CA 控制台发布该模板。
4. **GPO 自动注册**：`gpmc.msc` → `计算机配置 → 策略 → Windows 设置 → 安全设置 → 公钥策略 → 证书服务客户端-自动注册` → 启用并勾选：续订过期证书 / 更新挂起的证书 / 删除已吊销的证书 / 更新使用证书模板的证书。
   - 域成员机会**自动获得企业根证书信任**（无需逐台装根），策略刷新时自动申请/续期 `HTTPS-Internal`。
5. **在 IRScnKettle01 申请并绑定**：`gpupdate /force` → IIS 管理器申请证书（**SAN 含 `IRScnKettle01.ap.inalfa.local`**，可加服务器 IP）→ 绑到站点 https。
6. **内网 DNS**：确保 `IRScnKettle01.ap.inalfa.local` 有 A 记录指向服务器私网 IP（域环境默认已有）。
7. **Firefox 信任域根**：`security.enterprise_roots.enabled=true`（用 GPO 推 Firefox 策略）；Chrome/Edge 随 AD 根自动信任。
8. **非加域客户端**（外包笔记本等）：手动装一次企业根证书，或走 Tauri 壳（决策门 4，仅当此类机器多时启用）。

---

## 5. 应用配置（`.env` 关键项）

| 变量 | 建议值 | 说明 |
|---|---|---|
| `PORT` | `3001` | Node 监听端口 |
| `HOST` | **一期 `0.0.0.0` / 二期 `127.0.0.1`** | 一期 Node 直连需对外监听；二期由 IIS 反代收回回环 |
| `WEB_DIST` | `../web/dist`（按安装目录） | 一期必填，否则 SPA 不挂载 |
| `DB_TYPE` | `mssql` | 生产库 |
| `DB_HOST` / `DB_NAME` | `CN_AME` 等 | SQL Server 连接 |
| `SEC_HSTS` | **一期 `off` / 二期 `on`** | 明文 HTTP 下发 HSTS 会把浏览器钉死到 HTTPS（一期会直接打不开），必须显式关；二期上 TLS 后再开 |
| `APP_PUBLIC_HOST` | `IRScnKettle01.ap.inalfa.local` | 域名默认值（见 §1） |
| `VIDEO_MAX_MB` | `2048` | 上传上限（注意 §6 的 IIS 413 坑） |
| `ORIGIN` | 同源默认 | SPA 由本进程托管，无需跨源 |
| `AUTH_OIDC_ENABLED` | 一期 `false`（默认） | 统一身份认证总开关；关闭时登录行为与改造前完全一致 |
| `AUTH_LOCAL_LOGIN_ENABLED` | `true` | 双轨期保留本地账号登录；两开关都关会在启动期 fail |
| `AUTH_REGISTRATION_ENABLED` | `false` | 自助注册默认关闭（兼容旧别名 `REGISTER_ENABLED`） |
| `AUTH_OIDC_ISSUER` | Keycloak realm issuer | 结尾斜杠自动去除；开启 OIDC 时必填 |
| `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_REQUIRED_GROUP` | `ie-platform` / `app-ie` | 交底书 D8 约定 |
| `AUTH_OIDC_CLIENT_SECRET` | **仅部署环境注入** | 不落 `.env` 文件、不入库、不入文档 |
| `AUTH_OIDC_REDIRECT_URI` | `https://<平台域名>/api/auth/oidc/callback` | **生产必须显式固定**；留空按请求 Host 推导仅用于单机/开发 |
| `SMTP_HOST` / `SMTP_PORT` | 生产 `172.19.253.10` / `25`（内网中继、无认证） | 告警邮件与源视频到期提醒的发信通道；未配置时只写日志不发信 |
| `SMTP_USER` / `SMTP_PASS` | 生产留空；仅开发机联调时注入 | **凭据只写 `app/api/.env`**，禁止进入 `.env.example`、文档或任何受版本控制的文件 |
| `SMTP_FROM` / `ALERT_MAIL_TO` | 生产按现场发件人 / 告警收件人 | `ALERT_MAIL_TO` 为空时告警邮件通道不启用；源视频提醒只要求 `SMTP_HOST` |

> **SMTP 通道切换**：开发机若临时用公网邮箱联调（如 `smtp.126.com:465`，授权码即 `SMTP_PASS`），
> 上线前改回内网中继 `172.19.253.10:25` 并清空 `SMTP_USER`/`SMTP_PASS` 即可，`SMTP_FROM` 与
> `ALERT_MAIL_TO` 按现场填写；全套改完重启后端生效。

**统一身份认证上线前置（详见 `docs/identity/SSO-INTEGRATION-PLAN.md`）：**

1. 先执行 `deploy/sql/manual/2026-11-06-auth-sso.sql`（**不自动 migrate**，加 `t_user.auth_source` /
   `t_refresh_token.source` 与工号索引，含回滚段）；用 `sqlcmd` 执行时**必须加 `-f 65001`**（见 §12 手工 SQL 说明）；
2. Keycloak 固定 25.0.6（26.x 与 SQL Server 2017 不兼容），client 为 confidential，回调地址必须 HTTPS；
3. 首次切换建议 `AUTH_OIDC_ENABLED=true` + 本地登录保持开启，观察一小时一次的中央状态同步；
4. 回滚只需 `AUTH_OIDC_ENABLED=false`，无需改库、无需重发前端；
5. **一期为单实例内存态**（state/OTK），上 IIS/ARR 或多实例前必须先落库，否则登录会丢 state。

---

## 6. 已知部署坑

- **IIS 上传上限（仅二期）**：`maxAllowedContentLength` 默认 28.6MB，大视频会被 **413 拦在 Node 之前**。二期需在 `applicationHost.config` / `web.config` 调大（≥ `VIDEO_MAX_MB`），或依赖 P0 已实现的 ≤8MB 分片上传规避。一期 Node 直连不受此限（上限由 `VIDEO_MAX_MB` 控制）。
- **416 vs 500**：`sendFile` 无 callback 时 416 裸 Error 被全局过滤器转 500（P0 修复）。
- **ffmpeg 二进制**：必须手动放 `app/api/bin/ffmpeg.exe`。
- **HSTS**：仅 `SEC_HSTS=on` 下发。一期是明文 HTTP，**必须 off**；二期上 TLS 后再开（提前开启会把浏览器钉死到 HTTPS）。

---

## 7. 验证清单

- [ ] 一期：`http://IRScnKettle01.ap.inalfa.local:3001` 能打开登录页，`/api/health` 返回 200。
- [ ] 一期：`VIDEO_DERIVED_MAX_GB` 生效（`GET /api/videos/storage` 回显 `max_gb_configured=true` 与 `derived_max_gb`）。
- [ ] 上传视频 → 派生任务生成 proxy / sprite / index；到期提醒/保留决定接口可见（`GET /api/videos/assets`）。
- [ ] 帧步进（J/L）在代理视频上逐帧精确。
- [ ] 二期：`https://IRScnKettle01.ap.inalfa.local` 无安全告警、`window.isSecureContext === true`；非加域机器手动装根或列入 Tauri 备选。

---

## 8. IIS 站点与 `web.config`（**二期，当前未启用**）

> 用户决策 2026-11-06：IIS/ARR **降为二期**。一期上线用 Node 单进程托管静态文件（§2），
> `web.config` 保留在仓库作为二期模板，**不作为当前上线路径**，现在不需要安装 URL Rewrite / ARR / 配置证书。

二期启用前提：一期 Node 直连稳定运行、现场确认需要 HTTPS（WebCodecs/getUserMedia）且 AD CS 证书就绪（§4）。

模板位置：`deploy/iis/web.config`（复制到站点根目录，即 `wwwroot`）。

- **二期形态**：IIS 托管 `app/web/dist` 静态文件，`/api/*` 反代到 `http://127.0.0.1:3001`；切换后 `HOST` 改回 `127.0.0.1`、`SEC_HSTS=on`，防火墙只开 443。
- **SPA 回退**：非 `/api`、非真实文件/目录的请求回退 `/index.html`，支持前端路由刷新。
- **请求体上限**：`maxAllowedContentLength=16777216`（16MB），与前端 8MB 分片阈值 2 倍对齐；大于 8MB 的文件由前端自动分片，单请求不会接近 `VIDEO_MAX_MB=2048`。
- **静态缓存**：`/assets/*`（Vite 内容寻址）长缓存 + immutable；入口 HTML 不缓存。
- **服务器级前置**（必须在 IIS/服务器层配置，写在 web.config 会 500.19）：
  ```powershell
  # 1) 安装 URL Rewrite + ARR，并启用代理
  # 2) 允许规则设置 X-Real-IP（否则反代规则报 500.19）
  appcmd set config /section:rewrite /+allowedServerVariables.[name='HTTP_X_REAL_IP']
  # 3) 关闭 ARR 响应缓冲，避免视频拖动被整段缓冲；applicationHost.config 的 <proxy>：
  #    <proxy enabled="true" preserveHostHeader="true" responseBufferLimit="0" />
  # 4) 若大请求仍报 413，applicationHost.config：
  #    <serverRuntime uploadReadAheadSize="16777216" />
  ```
- **校验**：`[xml](Get-Content deploy/iis/web.config)` 能解析；部署后用浏览器刷新前端路由不 404、`/api/health` 经 IIS 可达。

---

## 9. 启动自检（P0-3）

`node dist/scripts/startup-check.js`（或 `npm run ops:startup-check`）在启动前打印配置清单：

- **warn 不阻断**：`NODE_ENV` 非 production、`DB_PASS` 为空、生产用 SQLite、SMTP 未配、`VIDEO_DERIVED_MAX_GB` 未配、ffmpeg 缺失、`storage/videos` 或 `LOG_DIR` 不可写、`WEB_DIST` 缺失、`METRICS_TOKEN` 未配。
- **fail 才中止**：仅安全项——生产环境仍使用 `dev-` 前缀 JWT 密钥（`loadConfig` 与自检双重兜底）。
- 服务启动时同一套检查会写入 `StartupCheck` 日志，运维无需额外执行脚本也能看到缺失项与修复动作。

---

## 10. 审计与日志保留清理（P0-3）

- **默认干跑**：`node dist/scripts/audit-retention.js` 只统计「超期审计行数 + 超期日志文件数/字节」，不删除。
- **执行删除**：加 `--apply`；`AUDIT_RETENTION_DAYS` / `LOG_RETENTION_DAYS` 默认 **730 天**，`AUDIT_RETENTION_BATCH` 默认 5000 行/批（避免长事务锁表）。
- **可观测**：每次执行追加一行 JSON 到 `LOG_DIR/audit-retention.log`（时间戳、截止时间、删除数、剩余数、日志文件数/字节、是否干跑、错误）。
- **计划任务（2026-11-06 已落地，每日 02:30 干跑）**：
  - 注册：`powershell -ExecutionPolicy Bypass -File deploy\windows\register-audit-retention-task.ps1`
    默认任务名 `IE-Audit-Retention-DryRun`，命令为 `node dist\scripts\audit-retention.js`（**不带 --apply**）。
  - 卸载：`powershell -ExecutionPolicy Bypass -File deploy\windows\unregister-audit-retention-task.ps1`
  - 无人值守（无人登录也执行）：用管理员 PowerShell 加 `-RunAsSystem` 重新注册。
  - **查看执行日志**：`app/api/logs/audit-retention.log`（每次一行 JSON：时间、截止、删除数、剩余、是否干跑、错误）；stdout 追加在 `app/api/logs/audit-retention-task.out.log`。
  - **切真实删除**（确认后）：
    ```powershell
    powershell -ExecutionPolicy Bypass -File deploy\windows\register-audit-retention-task.ps1 -Apply
    ```
  - **一周后如何判定可以切 `--apply`**（三条同时满足）：
    1) 连续 ≥7 天日志里 `error` 为空、`dry_run=true`；2) 每日 `remaining`/`deleted_candidates` 平稳，无异常骤增；3) 抽查 `deleted_candidates` 与业务确认「这些记录确实可清理」。达标后再用 `-Apply` 重新注册。
  - 若任务未运行：先 `schtasks /Query /TN IE-Audit-Retention-DryRun /V` 看「上次运行时间/结果」，默认任务是「仅登录时运行」，服务器重启后未登录会跳过——此时改用 `-RunAsSystem`。

---

## 11. 数据库备份与恢复校验（**用户决策 2026-11-06：不做备份**）

> **决策**：用户明确「不需要保留备份」。`deploy/sql/backup.ps1` 仅保留在仓库作为将来可选项，
> **没有注册任何计划任务，也没有纳入上线流程**。
>
> **风险（如实记录）**：
> - 数据库损坏 / 误删 / 勒索加密 / 服务器磁盘故障时，**没有任何回退手段**，只能从零重建（业务数据不可恢复）；
> - 视频源文件同样无备份，硬删后不可恢复（保留期策略已明确不做回收站）；
> - 应用发布回滚只能回退代码，不能回退数据库结构/数据。
>
> **将来启用只需一条命令**（按需手工执行，不自动定时）：
> ```powershell
> powershell -ExecutionPolicy Bypass -File deploy\sql\backup.ps1 -Database CN_AME -BackupDir D:\backup\ie -RetentionDays 14
> ```
> 若将来决定改为每日自动备份，再单独注册计划任务（当前刻意不注册）。

脚本行为（保留在仓库、未启用）：SQL Server 原生 `BACKUP DATABASE`，不默认挂定时器。

```powershell
# 干跑（不连库、不落盘）
powershell -ExecutionPolicy Bypass -File deploy/sql/backup.ps1 `
  -Database CN_AME -BackupDir D:\backup\ie -DryRun

# 正式备份（Windows 集成认证；默认保留 14 天）
powershell -ExecutionPolicy Bypass -File deploy/sql/backup.ps1 `
  -Database CN_AME -BackupDir D:\backup\ie -RetentionDays 14
```

- 认证：默认 `sqlcmd -E`（Windows 集成认证）。SQL 认证用 `-SqlUser`，口令经 `-SqlPassword` 只写入进程环境变量 `SQLCMDPASSWORD`，**不落盘、不写日志、不入库**。
- 备份参数：`WITH INIT, COMPRESSION, CHECKSUM, STATS = 10`。
- **恢复校验**：备份后自动 `RESTORE VERIFYONLY ... WITH CHECKSUM`，失败非 0 退出；不要只看「文件存在」就认为备份可用。
- **保留策略**：只删本库命名规则 `CN_AME-YYYYMMDD-HHMMSS.bak` 且修改时间早于 `RetentionDays` 的文件，其他文件不碰。
- 完整恢复演练（建议每季度一次，恢复到临时库，不影响生产）：
  ```sql
  RESTORE DATABASE [IEPlatform_restorecheck]
    FROM DISK = N'D:\backup\ie\CN_AME-20261106-023000.bak'
    WITH MOVE 'CN_AME' TO N'D:\restore\CN_AME_test.mdf',
         MOVE 'CN_AME_log' TO N'D:\restore\CN_AME_test.ldf',
         RECOVERY, REPLACE;
  DBCC CHECKDB ([IEPlatform_restorecheck]) WITH NO_INFOMSGS;
  -- 校验行数/关键表后删除临时库
  DROP DATABASE [IEPlatform_restorecheck];
  ```
- 备份文件应与源库分盘存放；若只有一块盘（当前 150GB 同盘），备份会进一步压缩可用空间，需把备份目录纳入磁盘预算监控。
  （注：以上仅为脚本能力说明，2026-11-06 用户决策不启用备份。）

---

## 12. 源视频保留与到期删除（2026-11-06 用户决策）

**口径**：源视频默认保留 **10 天**（`VIDEO_RETENTION_DAYS`）；到期前 **3 天**（`VIDEO_RETENTION_NOTICE_DAYS`）提醒；
上传者本人或管理员可选择「再保留 10 天」或「永久保留」；到期仍未选择 → **自动硬删**
（源文件 + proxy/sprite/index 及派生行一并删除，不做回收站）。

**配置**（`.env`，未配置时按默认 10/3 并启动 warn「待现场确认」）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIDEO_RETENTION_DAYS` | `10` | 保留天数；「再保留」也是再延这么多天 |
| `VIDEO_RETENTION_NOTICE_DAYS` | `3` | 到期前多少天进入提醒窗口 |
| `VIDEO_RETENTION_NOTIFY_RETRY_HOURS` | `24` | 通知失败后的重试冷却（成功通知只发一次） |

**数据库变更（手工执行，不自动 migrate）**：
`deploy/sql/manual/2026-11-06-video-retention.sql`
- SQL Server 2017（生产）：幂等 `ALTER TABLE`，新增 `retention_status` / `retention_until` / `notified_at` / `last_notify_at` / `notify_attempts` + `idx_video_asset_retention`，并回填存量行的到期时间；
- 开发 SQLite：TypeORM `synchronize` 自动建列；手工变体写在脚本末尾；
- 回滚段在脚本末尾（注释形式）。

**手工 SQL 执行方式（`sqlcmd` 必读）**：`deploy/sql/manual/` 下的脚本是无 BOM 的 UTF-8，Windows 版
`sqlcmd` 默认按代码页 936（GBK）读取源文件，中文注释会直接报「`) 附近有语法错误」（消息 102），
**不是脚本写错**。执行时一律显式指定 UTF-8：

```powershell
# 生产 CN_AME（SQL 认证；SQLCMDPASSWORD 只在进程环境内，不落盘）
$env:SQLCMDPASSWORD = '<sa 口令>'
sqlcmd -S localhost -U sa -d CN_AME -f 65001 -i deploy\sql\manual\2026-11-06-video-retention.sql
sqlcmd -S localhost -U sa -d CN_AME -f 65001 -i deploy\sql\manual\2026-11-06-auth-sso.sql
# 集成认证则把 -U sa 换成 -E，其余不变
```

- `-f 65001` = 输入文件按 UTF-8 解析；漏掉它脚本本身没问题也会失败，属于必踩坑，执行前先核对参数。
- 也可在 SSMS 中打开文件执行（SSMS 能正确识别 UTF-8），但**仍需自行确认目标库为 `CN_AME`**。
- 若为脚本加 BOM，`sqlcmd` 也能识别；但仓库脚本统一保持无 BOM，执行侧统一加 `-f 65001` 更稳妥。
- 幂等：重复执行返回 `already exists`、退出码 0，不产生变更。

**站内入口与 API**（列表/详情带保留状态与操作入口）：
- `GET /api/videos/assets` —— 可见范围内的视频列表，返回 `retention_status`、`retention_until`、`days_left`、`notified_at`、`can_manage`、`play_url`；
- `GET /api/videos/assets/:name` —— 单条详情（工作台/详情页提示用同一契约）；
- `POST /api/videos/assets/:name/retention` —— `{ "action": "extend" | "permanent" }`；
- `DELETE /api/videos/assets/:name` —— 立即硬删（写审计 `source=manual`）。
- 权限：查看沿用视频可见范围；操作（延期/永久/删除）仅**上传者本人或全权管理员**（sys_admin/ie_admin）。
- 现状说明：前端当前没有「视频库列表页」，`GET /assets` 是站内状态的数据契约；工作台详情应据此渲染提示条（后续页面接入任务）。

**通知与失败处置**：
- 邮件复用 `SMTP_HOST` 通道发送到上传者邮箱（`t_user.email`）；`SMTP_HOST` 未配时只写日志并在列表状态中可见，不影响删除。
- 通知去重：成功发出后 `notified_at` 置位，不再重复；失败按 `VIDEO_RETENTION_NOTIFY_RETRY_HOURS` 冷却重试，不每天轰炸。
- **删除可观测**：每次删除写 `t_audit_log`（动作 `video.delete` / `video.delete_failed`，明细含 `source=auto_expired|manual`、文件、上传者、时间）；失败保留记录、写 `error` 日志、计数 + 告警邮件（走 `ALERT_MAIL_TO`，1 小时节流），下一轮扫描重试。
- 运行状态：`GET /api/videos/storage` 返回 `retention_days`、`last_retention_sweep_at`、`retention_deleted_total`、`retention_delete_failures`、`retention_notice_failures`、`source_active_gb`、`source_permanent_gb`。

**运维核对**：
1. 上线前手工执行 SQL，确认 5 列 + 1 索引存在；
2. 启动日志确认保留参数无「未配置」warn（或已确认默认值）；
3. 用一条测试视频修改 `retention_until` 到过去时间 + 下一轮扫描（最多 1 小时），核对文件/派生目录/归属行均删除、审计有 `video.delete`；
4. 选择「永久保留」后确认不再出现在到期扫描中；
5. 删除失败的告警邮件只在 `ALERT_MAIL_TO` 配置时发出；未配置时以 error 日志 + storage 计数为准。
