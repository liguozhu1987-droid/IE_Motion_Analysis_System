# UI 回归「隔离可重复」立项评估

> 状态：方案（未改代码、未跑任何写库操作）
> 评估日期：2026-11-04
> 范围：`app/web` 下全部 Puppeteer UI 套件迁移到 `app/api/test/isolated-harness.cjs` 基座
> 纪律依据：`.workbuddy/memory/MEMORY.md`、`项目记忆.md` §5/§7

---

## 0. 结论（先看这里）

**能做，且不需要重写基座。** 现有 8 套契约套件已在「临时 SQLite + 随机端口 + 自动清理」上连跑两遍一致，UI 套件迁移是同一机制的增量扩展，不是新架构。

**建议分 4 批：**

| 批次 | 内容 | 套件数（约） | 目的 |
|---|---|---|---|
| 第 0 批 | 基座扩展 + 试点 `test-wb-v322` | 1 | 用依赖最少的一套把「Web 托管 / 浏览器生命周期 / 截图边车 / 清理」跑通 |
| 第 1 批 | 仅依赖 seed 夹具的套件 | 17~20 | 消化大部分存量，风险最低 |
| 第 2 批 | 依赖 `ST010` 的套件 | 4~5 | 建立「生产夹具只读导出」范式 |
| 第 3 批 | `L01-ST11` + 直连 mssql + AI mock 套件 | 8~10 | 清掉最后的高耦合脚本 |

**最大风险：`ST010` 夹具精度，而不是 `L01-ST11`。**

- `seed` 完全不含 `ST010`（[seed.ts](../../app/api/scripts/seed.ts) 只造 `L01-ST01`/`L01-ST02`/`L02-ST01`）。
  因此「当前还能跑的」`v348/v349/v353-stop/v354` 在隔离库里同样跑不起来。
- `test-v353-stop` 断言 `seq4 start=4880ms / end=6120ms`，`test-v348` 断言 20 个要素块、6 浪费点、6 问题、3 建议——**任何一条数据偏差都会变成假失败**。
- 该夹具必须从正式库**只读导出**（GET 接口或 SELECT），不能靠脚本"再造一份差不多"。

**三条事实修正（避免立项按错误前提做预算）：**

1. **Web 静态服务其实已经存在。** API 在 `WEB_DIST` 有 `index.html` 时用同端口托管 SPA（[main.ts L44-L46](../../app/api/src/main.ts)、[web-assets.ts L41-L97](../../app/api/src/core/web-assets.ts)），且前端 API 基址是相对 `/api`（[api.ts L10](../../app/web/src/api.ts)）。
   所以**不需要**额外起 vite preview/dev，也不会产生跨源。缺的只是：`WEB_URL` 注入统一、dist 新鲜度门禁、基座显式开关。
2. **基座已有 `extraSql` 与 `prepare` 扩展点**（[isolated-harness.cjs L210-L220、L270-L278](../../app/api/test/isolated-harness.cjs)），缺的是「按套件声明期望值」和「可复用 fixture 模块」，不是从零加机制。
3. **`L01-ST11` 不是唯一缺失夹具。** `L01-ST11` 至少已有可复用的数据定义（[_setup-st11.cjs L15-L19](../../app/web/_setup-st11.cjs)）；`ST010` 连定义都没有。

---

## 1. 依赖盘点

### 1.1 seed 能提供什么 / 不能提供什么

| 资源 | seed 是否提供 | 证据 | 说明 |
|---|---|---|---|
| 用户 `admin`/`ie1`/`leader1`/`viewer1`/`other1`（密码 `123456`） | 是 | [seed.ts L59-L66](../../app/api/scripts/seed.ts) | UI 脚本默认账号 |
| 10 个角色 + 权限矩阵 + 规则集 | 是 | seed 输出「用户5 / 角色10 / 权限… / 规则入库」 | 隔离校验已有 |
| 产线 `L01` / `L02` | 是 | seed | |
| 工位 `L01-ST01` / `L01-ST02` / `L02-ST01` | 是 | [seed.ts L201-L210](../../app/api/scripts/seed.ts) | `L01-ST02` 共享给 `ie1` editor |
| `L01-ST01` 3 条手工要素 v1 | 是 | [seed.ts L218-L232](../../app/api/scripts/seed.ts) | 但 `video_id` 指向不存在的 demo 文件，视频需套件自己注入 |
| `L01-ST11`（3 要素、CT>0） | **否** | 仅 [_setup-st11.cjs](../../app/web/_setup-st11.cjs) 通过 API 现造 | 需转成 fixture |
| `ST010`（20 要素 + 6 浪费 + 6 问题 + 3 建议） | **否** | 正式库专有，seed 无 | **最大缺口** |
| `L01-ST33` / `L01-ST77` / `L01-ST90` / `L01-ST97` / `L01-ST98` / `PA10` / `BJFA1-ST01` | **否** | 各脚本自建自清 | 隔离后同样可自建 |
| 固件 `test-fixtures/aiseg-8s.mp4`、`fixtures/v328/{sample.avi,mkv,mp4}` | 磁盘已有 | 实测存在 | 需拷进临时目录或临时 storage |
| `storage/videos` 真实视频 | **否** | `videos.service` 用 `process.cwd()/storage` | cwd 已指向临时目录，需 fixture 注入 |

### 1.2 逐套依赖表（按迁移难度分组）

> 「直连 DB」= 脚本内 `require('mssql')` 直连正式库；隔离版必须改写。
> 「写库」= 调 POST/PUT/DELETE；隔离后写入临时库可接受，但仍要求 finally 清理。

#### A 组：seed 即可满足（最低风险，第 1 批）

| 套件 | 工位 | 账号 | 视频/固件 | 截图/边车 | 直连 DB | 备注 |
|---|---|---|---|---|---|---|
| `test-wb-v317` | 动态取首个有要素工位 → `L01-ST01` | admin | MediaRecorder webm | `deliverables/screenshots` | 否 | 写库 2 处 |
| `test-wb-v318` | 同上 | admin | webm | 同上 | 否 | |
| `test-wb-v319` | 同上 | admin | webm | 无 | 否 | |
| `test-wb-v320` | 首个 + `L01-ST02` | admin | webm | 无 | 否 | |
| `test-wb-v321` | `/master` `/stations` | admin | 无 | `deliverables/v321` | 否 | |
| `test-wb-v322` | `L01-ST01` | admin | 运行时 12s webm | `deliverables/v322` + `dom-sidecar.json` | 否 | **试点首选** |
| `test-wb-v323` | `L01-ST01` | admin | webm | `deliverables/v323` + `v323-dom.json` | 否 | |
| `test-wb-v324` | `/stations` `/dashboard` | admin | 无 | 待核 | 否 | |
| `test-wb-v325` | 首个 | admin | webm | `deliverables/v325` | 否 | |
| `test-wb-v326` | `L01-ST01` | admin | 无 | `deliverables/v326` | 否 | |
| `test-wb-v327` | `L01-ST01` | admin | webm | 无 | 否 | |
| `test-wb-v328` | `L01-ST01` | admin | `fixtures/v328` 三件 | 无 | 否 | 需复制固件 |
| `test-wb-v328-walkthrough` | 自建 `L01-ST90` | admin | webm | 无 | 否 | 自建自清 |
| `test-wb-v329` | 自建 `L01-ST97` + CSV | admin | 无 | 无 | 否 | 自建自清 |
| `test-v342` | `ST01`/`ST02` + 自建 `ST77` | admin/ie1/viewer1 | 无 | 无 | 否 | 多账号 |
| `test-ai-segment` | `L01-ST01` | admin | 无 | `deliverables/ai-segment/shots` | 否 | |
| `test-ai-segment-run` | `L01-ST01` | admin | `aiseg-8s.mp4` | 同上 | 否 | |
| `test-v343` | `L01-ST01` | admin | `aiseg-8s.mp4` | 无 | 否 | 写库 3 处 |
| `shot-v320` / `shot-v325` / `shot-v325-help` / `shot-v326` / `shot-v344` / `shot-ui-diag` | `L01-ST01`/`ST02`/首个 | admin（diag 另加 viewer1） | 无 | `deliverables/*` | 否 | 截图工具，可并批 |

#### B 组：依赖 `ST010`（第 2 批，需要夹具导出）

| 套件 | 工位 | 账号 | 视频/固件 | 截图 | 直连 DB | 关键断言 |
|---|---|---|---|---|---|---|
| `test-v348` | `ST010` | admin | `aiseg-8s.mp4` | `deliverables/part2/ui` | 否 | 20 块 / 6 浪费 / 6 问题 / 3 建议 |
| `test-v349` | `ST010` | admin | 无 | 同上 | 否 | 列级交互、滚动 |
| `test-v353-stop` | `ST010` | admin | `aiseg-8s.mp4` | 无 | 否 | seq4 4880→6120 精确停靠 |
| `test-v354` | `ST010` | admin | 无 | 无 | 否 | 时间码/使连续（仅本地草稿） |
| `_shot-v360` | `ST010` | admin | 无 | 有 | 否 | 截图工具 |

#### C 组：直连库 / 写库较多（第 3 批，需改写）

| 套件 | 工位 | 账号 | 直连 DB | 说明 |
|---|---|---|---|---|
| `test-v341` | `L01-ST01` | admin | **是（mssql 读写）** | 前置还原版本、断言版本隔离；隔离版改用 `node:sqlite` |
| `test-v344` | `L01-ST01` | admin | 否 | 6 处写库；AI 关闭态降级验证 |
| `_ui-v358-rbac` | 自建用户 | admin | 否 | 写 RBAC，需 finally 清理 |
| `test-ai-waste` | 自建 `L01-ST33` | admin | **是（mssql 造数/清数）** | 另需 mock LLM 19101 |
| `test-wb-waste-btn` | 自建 `BJFA1-ST01` | admin/ie1/viewer1 | **是（mssql）** | mock LLM 19101，独占端口 |
| `test-wb-ai` | AI 配置页 | admin/viewer1 | 否 | mock，需 AI 关闭态 |

#### D 组：`L01-ST11` / 大视频 / 真 AI（最后处理）

| 套件 | 工位 | 账号 | 额外依赖 | 说明 |
|---|---|---|---|---|
| `test-v351` | `L01-ST11` | admin | 写 AI waste + KB | 已有 `_setup-st11` 自愈 |
| `test-v353` | `L01-ST11` | admin | **mssql + `DB_PASS` + storage 视频 + 临时目录 mp4** | 耦合最重，最后迁 |
| `test-ai-segment-upload` | `PA10` | admin | `sample60.mp4`/`hevc15.mp4`/假 mp4 | AI 链路，耗时长 |
| `test-ai-segment-v337` | `PA10` | admin | `deliverables/.../sample30.mp4` | 真 AI |
| `test-ai-segment-write` / `write-stress` | `PA10`/`L01-ST98` | admin | 真实视频 | 写库压力测试 |
| `test-real-video` | `PA10` | admin | 外部真实视频 | |
| `verify-llm-config` / `verify-llm-e2e` / `verify-llm-test` | — | admin/viewer1 | 真 LLM 地址与密钥 | **建议不迁隔离**，保留人工执行 |

### 1.3 引用 `L01-ST01` / `L01-ST11` 的 18 个脚本（与现状一致）

`shot-v325-help`、`shot-v320`、`shot-v326`、`shot-v344`、`test-ai-segment-run`、`test-ai-segment`、
`test-v341`、`test-v342`、`test-v343`、`test-v344`、`test-wb-v320`、`test-wb-v322`、`test-wb-v323`、
`test-wb-v326`、`test-wb-v327`、`test-wb-v328`、`test-v351`、`test-v353`。

其中确定跑不起来的 5 套：`test-v341`、`test-v343`、`test-v344`、`test-v351`、`test-v353`
（依赖正式库工位 `L01-ST01`/`L01-ST11`，而清库后仅余 `ST010`）。其余 13 个脚本**在隔离库里可以靠 seed 的 `L01-ST01` 直接跑通**——这是迁移的主要收益面。

### 1.4 其它现状事实

- `app/web` 共 **45 个 Puppeteer 脚本**，**44 个文件**含写库调用（共 103 处）。
- 只有 6 个脚本读取 `process.env.WEB_URL`（`test-ai-waste`、`v348`、`v351`、`v353-stop`、`v353`、`v354`）；其余 39 个硬编码 `http://localhost:5173` 与 `http://localhost:3001/api`。
- 截图目录 100% 写 `deliverables/`（各版本子目录 + `deliverables/screenshots`），会污染交付物。
- Chrome 固定路径 `C:/Program Files/Google/Chrome/Application/chrome.exe`（实测存在），每脚本各自 `puppeteer.launch`，多数无 `finally` 关闭 → 失败即孤儿 Chrome。
- `app/web/dist/index.html` 实测 2026-11-02 11:31:18，最新 `src` 文件 11:30:28 → **当前 dist 是新鲜的**，可作为首批的 Web 托管基线。

---

## 2. 基座扩展设计

### 2.1 `serveWeb`：复用 API 同端口托管，不新起服务

**机制**

- `mode: 'api'` 启动的 API 已带 `WEB_DIST`（[isolated-harness.cjs L71](../../app/api/test/isolated-harness.cjs)），`main.ts` 命中 `index.html` 即挂载静态中间件。
- `WEB_URL` 已指向 `http://127.0.0.1:${port}`（[L83](../../app/api/test/isolated-harness.cjs)），与 API 同源；前端 `BASE='/api'` 相对路径 → 无跨域、无代理、无 host 白名单问题。
- hash 路由（`/#/workbench/...`）不参与服务端路径解析，SPA 回退只需根路径。

**需要补的三件事**

1. **开关与预检**：`webMode: 'dist' | 'off'`（默认 `dist`）。启动前检查 `<webDist>/index.html` 存在，否则明确报错（当前是静默退化为纯 API，UI 套件会以「白屏 + 登录页缺失」的假失败出现）。
2. **新鲜度门禁**：比较 `dist/index.html` 与 `app/web/src` 最新 mtime；dist 落后则 fail-fast（提示先 `npm run build`），提供 `--allow-stale-web` 逃生开关。避免测到旧构建。
3. **套件侧统一取值**：迁入的脚本一律 `const WEB = process.env.WEB_URL`、`const API = process.env.BASE`，禁止字面量。基座已注入，无需新增变量。

**不选 vite preview 的理由**：需要第二个进程/端口、需 `cwd=app/web`（破坏 cwd 隔离）、HMR 对回归无用、且会引入 dev-only 行为差异。

**选项草案**

```js
{
  suite: 'ui-wb-322',
  script: 'web/test-wb-v322.cjs',
  mode: 'api',
  webMode: 'dist',                 // 'dist' | 'off'
  webDist: 'app/web/dist',
  allowStaleWeb: false,
  timeoutMs: 300000,
  fixtures: ['minimal'],           // 第 0/1 批
  expect: {                        // 替换当前硬编码 verifyFixtures
    users: 5, tenants: 2, ruleSets: 6,
    stations: ['L01-ST01', 'L01-ST02'],
    elementsByStation: { 'L01-ST01': 3 },
  },
}
```

### 2.2 浏览器生命周期：独立模块 `test/isolated-browser.cjs`

现状问题：45 个脚本各自 launch；Chrome 路径硬编码；多数没有 `try/finally`；失败/超时后 Chrome 残留，下一次跑抢占 profile 或内存。

**模块职责（只做生命周期，不做断言）**

```js
// test/isolated-browser.cjs
launchBrowser({ suite, runId, artifactDir, timeoutMs })
  // 1) Chrome 解析顺序：CHROME_PATH → 默认安装路径 → 明确报错（附候选路径）
  // 2) userDataDir = <tempDir>/chrome-profile-<runId>（唯一，避免 profile 锁冲突）
  // 3) headless: 'new'；args 固定 --no-sandbox --autoplay-policy=no-user-gesture-required
  // 4) protocolTimeout 默认 300000
  // 5) 返回 { browser, newPage(), close() }；close() 内部：
  //    browser.close() → 3s 未退则按 pid 树 taskkill /T /F（Windows）
  attachPage(page, { sidecar, shotDir })  // 统一 pageerror/dialog/console 收集
  closeAll()                              // 供基座 finally / 信号处理器调用
```

**关键约束**

- `deviceScaleFactor: 1` 显式固定，`viewport` 由套件给（常用 1440×900 / 1600×900），避免宿主机 DPI 漂移。
- 页面初始化统一注入：`ie_refresh_token`（条件写入）+ `wb-help-seen=1`（规避帮助浮层遮罩）。
- 页面错误与 `dialog` 统一收集，作为断言来源，不依赖视觉。
- 基座在 `finally` 与 `SIGINT/SIGTERM/SIGHUP` 里调用 `closeAll()`，然后才删临时目录。

### 2.3 截图与 DOM 边车：落到临时目录，不污染 `deliverables/`

**目录约定**

```
<tempDir>/artifacts/<suite>/<runId>/
  ├─ shots/<label>.png          ← page.screenshot
  ├─ dom/<label>.json           ← DOM 边车（机器校验用）
  ├─ result.json                ← { pass, fail, cases:[{name, ok}] }
  └─ meta.json                  ← WEB_URL / API 端口 / 版本 / 固件哈希
```

- 套件通过 `ISO_ARTIFACT_DIR`（基座已有 `ISOLATED_ARTIFACT_DIR`，直接复用）取根目录，禁止再拼 `__dirname/../../deliverables`。
- **保留策略**（三个层级，默认最保守）：
  1. 默认：随临时目录一起删除；
  2. 失败时（或 `--keep-artifacts`）：先复制到 `app/api/test/artifacts/<suite>/<runId>/`（不进 `deliverables/`）；
  3. `--publish-artifacts`：才允许复制到 `deliverables/isolated-runs/...`，用于需要给用户看的验收截图。
- **DOM 边车是判定主依据，截图为证据**（符合 `项目记忆.md` §5.3：视觉模型会误读）。
  边车最小字段：`label / url / viewport / 关键选择器文本 / 元素 rect / scrollWidth-clientWidth / selectedCount`。
- 基座在批量入口（`isolated-run.cjs`）对 `deliverables/` 做**前后树指纹**，与现有 `data/ie.db` + `storage` 指纹一样纳入总判定；这样「截图污染」从人工检查变成机检。

### 2.4 失败时清理

现状：`finally` 已停 API + 删临时目录（[L315-L323](../../app/api/test/isolated-harness.cjs)）。缺口是 Chrome 与截图保留。

**顺序（固定）**

1. `closeAll()` 关闭全部浏览器 → 超时则 `taskkill /T /F`；
2. `stopServer(server)`（现有 SIGTERM→SIGKILL 逻辑）；
3. 若失败/keep：复制 artifacts 到持久目录；
4. `cleanupTempDir`（现有 6 次重试，处理 Windows 句柄占用）；
5. 打印 `清理: PASS/FAIL` 与残留路径。

**残留检测**：清理后追加断言——临时目录不存在、无 `chrome.exe` 命令行含该 `userDataDir`、该 API 端口无监听。任一失败即视为该遍失败（不能只打印）。

### 2.5 并发与端口冲突

- API 端口：已用 `findFreePort()` 随机分配，无冲突风险。
- Chrome 调试端口：`--remote-debugging-port=0`（由 Chrome 自选）或 puppeteer 默认。
- `userDataDir` 唯一：`<tempDir>/chrome-profile-<runId>`，避免同一账号 profile 锁。
- **UI 套件仍串行**（`MEMORY.md`：「UI 禁并行」）。基座加进程级互斥：`app/api/test/.ui-run.lock`（含 pid + 启动时间；进程不存在则视为陈旧锁并接管），第二个 UI 套件直接拒绝启动并给出占用 pid。
- 第 3 批的 mock LLM（19101）等固定端口，由套件自己在 `finally` 释放；基座在清理阶段检测端口占用并报错。

### 2.6 结果判定：从「退出码」升级为「用例级一致」

现状 `parseResult` 只认「结果：X 通过 / Y 失败」与「权限矩阵: X/Y 通过」，UI 脚本大多只打印 `N passed, M failed`，且无统一摘要 → 基座目前只能退化比退出码。

**扩展**

1. 解析器增加英文/中文变体：`N passed, M failed`、`通过 N / 失败 M`、`结果：N/M`。
2. 套件写 `result.json`（含每个 `ok()` 的名称与布尔值）；基座读该文件。
3. 「连跑两遍一致」判定升级为：`pass/fail 数相同` **且** `失败用例名集合相同`（避免两遍各失败不同用例却都记为 2/5）。
4. 无 `result.json` 的旧套件先按退出码兼容，迁完即淘汰该兼容分支。

---

## 3. 改造顺序与分批

### 第 0 批：基座扩展 + 试点 `test-wb-v322`

**为什么选 `test-wb-v322`（而不是 `v354`）**

| 维度 | `test-wb-v322` | `test-v354` |
|---|---|---|
| 工位依赖 | `L01-ST01`（seed 自带 3 要素） | `ST010`（seed 无，需导出 20 要素夹具） |
| 视频依赖 | 运行时 MediaRecorder 生成 12s webm | 无 |
| 直连 DB | 无 | 无 |
| 边车 | 已写 `dom-sidecar.json` | 无 |
| 失败路径 | 无 `finally`，正好验证浏览器清理 | — |

`v322` 能一次性验证：Web 托管、登录注入、视频生成、截图落盘、边车、浏览器关闭、失败清理；`v354` 会把「夹具导出」这个外部阻塞提前压进试点。

**第 0 批交付物**

- 基座选项：`webMode`、`webDist`、`allowStaleWeb`、`fixtures`、`expect`、`timeoutMs`、`--keep-artifacts`。
- 新模块：`test/isolated-browser.cjs`、`test/isolated-artifacts.cjs`（路径/边车/result.json）。
- `isolated-run.cjs` 注册 `ui-wb-322`；`deliverables/` 指纹纳入总判定。
- `test-wb-v322.cjs` 改造：`WEB/API` 取环境变量、`launchBrowser`、artifact 路径、`try/finally`、末尾写 `result.json`。

**验收标准（必须同时满足）**

1. `--repeat 2` 两遍 `result.json` 的 `pass/fail` 与失败用例名集合完全一致；
2. 两遍清理均 PASS（临时目录不存在、无残留 `chrome.exe`、端口无监听）；
3. `data/ie.db`、`storage/`、`deliverables/` 三处指纹前后不变；
4. 截图与边车出现在临时 artifacts（失败时复制到 `test/artifacts/`），`deliverables/` 零新增文件；
5. 日志中 `WEB_URL` 为隔离端口，且请求未出现 `3001/5173`。

### 第 1 批：A 组（seed 即可满足）

顺序（先短后长、先只读后写库）：

1. 只读/截图类：`shot-v320`、`shot-v325`、`shot-v325-help`、`shot-v326`、`shot-v344`、`shot-ui-diag`、`test-wb-v321`、`test-wb-v324`；
2. 单工位工作台：`v317`、`v318`、`v319`、`v320`、`v325`、`v326`、`v327`、`v322`（已在第 0 批）、`v323`；
3. 自建自清：`v329`、`v328-walkthrough`、`v342`；
4. 固件类：`v328`（复制 `fixtures/v328`）、`v343`、`ai-segment`、`ai-segment-run`。

**验收**：同第 0 批 5 条；另加
- 静态门禁：迁入脚本内 `localhost:3001|127.0.0.1:3001|localhost:5173` 出现次数为 0；
- 静态门禁：迁入脚本内 `deliverables` 字面量出现次数为 0（仅允许 helper 拼路径）。

### 第 2 批：B 组（`ST010`）

前置动作（一次性、只读、需授权）：

1. 用只读 GET（`/stations/ST010`、`/stations/ST010/elements`、浪费批次/问题/建议接口）导出为 `test/fixtures/data/st010.json`；
2. 记录导出时间、版本号、要素条数、seq4 起止（4880/6120）、浪费/问题/建议条数作为夹具自检；
3. 由 `test/fixtures/st010.cjs` 写入临时 SQLite，并在 `verify` 中断言上述全部数值。

**验收**：同第 0 批；另加
- 夹具自检：20 要素 / 6 浪费 / 6 问题 / 3 建议 / `seq4 4880-6120` 全命中；
- 两遍结果一致且**两遍都不出现 SKIP**（当前脚本缺固件会 `process.exit(1)`，必须改为基座前置失败并报明原因）。

### 第 3 批：C/D 组（直连库、`L01-ST11`、AI mock）

改造要点：

- `test-v341`、`test-v353`、`test-ai-waste`、`test-wb-waste-btn` 的 `mssql` 直连全部替换为 `test/isolated-db.cjs`（`node:sqlite` + `ISOLATED_DB_PATH`），SQL 方言差异（标识符引用、`TOP`/`LIMIT`、`GETDATE()`）逐句改；
- `v353` 的 `storage/videos` 与临时目录 mp4 改由 `prepareAfterApi` 通过 `/videos/upload` 注入（同时覆盖 `t_video_asset` 登记），不再依赖宿主机绝对路径；
- `L01-ST11` 转成 `test/fixtures/st11.cjs`（以 `_setup-st11.cjs` 的 3 要素为唯一真源），不再在测试内调 API 自愈；
- mock LLM 套件保留本地 mock server，但端口改为随机并由基座检查释放；
- `verify-llm-*` 不迁，明确标注「人工执行，需真实 LLM」。

**验收**：同第 0 批；另加
- 静态门禁：迁入脚本内 `require('mssql')`/`createRequire(...)( 'mssql')` 出现次数为 0；
- `v353` 不再要求 `DB_PASS`；
- `v351/v353` 在临时库中两遍一致，且不触碰正式 `storage`。

### 第 4 批：收口

- `isolated-run.cjs` 注册全部已迁套件，支持 `--group ui|ui-a|ui-b|ui-c`；
- 旧的手工跑法（直连 3001/5173）保留一个版本周期，但文档标记 deprecated；
- 更新 `项目记忆.md` §7/§8 的 UI 回归基线为「隔离套件 + 两遍一致」；
- 可选 CI 化（当前无 CI，不写成已接入）。

---

## 4. 风险清单

| # | 风险 | 触发点 | 应对 | 验证方式 |
|---|---|---|---|---|
| R1 | DPI/缩放导致布局与点击漂移 | 宿主机 125%/150% 缩放；`deviceScaleFactor` 未固定 | 固定 `viewport` + `deviceScaleFactor=1`；禁止原生 `<select>`（项目铁律） | 边车记录 `rect` 与 `scrollWidth`；两次跑值一致 |
| R2 | 帮助浮层遮罩拦截点击 | `wb-help-seen` 未预置 | `evaluateOnNewDocument` 统一注入 `wb-help-seen=1`；仍检测遮罩并关闭 | 点击失败时输出 overlay 的 DOM 边车 |
| R3 | 已选中块 toggle-off | 重复点击已选块 → 取消选中 | 点击前探 `.wb-panel-sel`，已选则跳过点击 | 断言 selectedCount 与预期一致 |
| R4 | 视频太短 → `play()` 静默 reject | 生成 webm < 要素区间；`readyState` 未就绪 | 生成 ≥12s webm；等 `readyState>=1` 且 `duration` 覆盖最大 `end_ms` | 若 `duration < maxEnd` 直接 fail 并报明数值 |
| R5 | CMC 联动冷启动 10s+ | 首次进入工作台/AI 页 | API 健康后再预热相关端点；断言用 `waitForFunction`（30s），不用 `sleep` | 记录首次可用耗时，超阈值 WARN |
| R6 | dist 陈旧 → 测旧构建 | 改前端后未 build | 基座 mtime 门禁 fail-fast；`--allow-stale-web` 仅显式逃生 | 日志打印 dist/src 两个时间 |
| R7 | SQLite 与 mssql 方言差异 | 隔离库跑 API 端点 500 | 逐套先跑 smoke；布尔列不写 `type`（项目铁律）；裸 SQL 改 SQLite 语法 | 首跑日志 + 端点 500 清单 |
| R8 | 直连 mssql 脚本残留 | 开发者复制旧脚本 | 静态门禁：迁入清单禁 `mssql` 字样 | grep 门禁 exit 1 |
| R9 | Chrome 孤儿进程 | 异常/超时未 `finally` | `closeAll()` + `taskkill /T /F`；信号处理器兜底 | 清理后命令行扫描 |
| R10 | 写库残留导致第二遍结果漂移 | 清理不彻底；断言依赖上一遍残留 | 每遍全新 SQLite；自建数据 `finally` 级联删除；用例级结果比对 | 两遍失败用例名集合一致 |
| R11 | 端口/并发冲突 | 人工并行跑 UI；mock 端口占用 | UI 互斥锁；mock 随机端口；端口占用检测 | 第二个进程被拒绝并提示占用 pid |
| R12 | AI/LLM 不确定性 | 真 LLM 地址被激活 | 基座强制 `AI_ENABLED=false`、`AI_SUGGEST_ENABLED=false`、`AI_WASTE_ENABLED=false`、`VIDEO_AUTO_DERIVE=0`（已设）；`verify-llm-*` 不迁 | 日志确认开关值 |
| R13 | 截图基线漂移 | 字体/抗锯齿/DPR 差异 | 一期**不做像素基线**，只做 DOM 边车机验；截图为证据 | 无 diff 门禁，避免假红 |
| R14 | 夹具精度导致假失败（最大） | `ST010` 20 要素/时间码/计数偏差 | 只读导出 + 夹具自检 + 期望值集中在一处 | 自检断言失败即夹具问题，不归因 UI |

---

## 5. 工作量与阻塞项

### 5.1 工作量（相对规模，不给工期）

| 工作包 | 规模 | 主要改动 |
|---|---|---|
| 基座 `serveWeb` + 新鲜度门禁 + 期望值配置化 | S | `isolated-harness.cjs`、`isolated-run.cjs` |
| 浏览器生命周期 + artifacts + result.json + 互斥锁 | M | 新增 2~3 个 `test/*.cjs`；`isolated-harness.cjs` 接入 |
| 第 1 批 ~20 套脚本改造 | L | 每套：URL 取环境变量、launch→helper、截图路径、`finally`、`result.json` |
| 第 2 批 `ST010` 夹具 + 4 套 | M | 新增 `fixtures/st010.cjs` + 数据 JSON + 4 套改造 |
| 第 3 批 `L01-ST11` + 直连库 + AI mock | L | 新增 `fixtures/st11.cjs`、`isolated-db.cjs`；改写 8~10 套 |
| 文档/基线/脚本注册收口 | S | `isolated-run.cjs`、`项目记忆.md`、README/AGENT 看板 |

**优先砍范围**：`verify-llm-*`（3 套）建议永远不迁；`ai-segment-*` 里依赖真实大视频的写压力测试可最后做，不影响主回归网。

### 5.2 阻塞项（需要你拍板/提供）

| # | 阻塞项 | 需要什么 | 不解决的后果 |
|---|---|---|---|
| B1 | `ST010` 夹具来源 | 授权**只读**导出（GET `/stations/ST010` + elements + 浪费/问题/建议批次），或提供脱敏 SQL dump | 第 2 批无法开工；`v348/v349/v353-stop/v354` 永远只能在正式库跑 |
| B2 | `L01-ST11` 真源 | 确认以 `_setup-st11.cjs` 的 3 要素为准，还是从正式库只读导出 | 若两边数据不一致，`v351/v353` 断言会漂 |
| B3 | Chrome 路径固定策略 | 确认固定 `CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe`，还是允许环境变量覆盖（推荐后者） | 换机器即失败；路径硬编码继续扩散 |
| B4 | AI 套件边界 | 确认 `verify-llm-*` 保持人工；`ai-segment-*` 是否必须进隔离网（需真实视频与较长超时） | 范围不清会导致第 3 批无限膨胀 |
| B5 | 视觉基线 | 确认一期**不新增**像素基线，只用 DOM 边车 + 截图证据（推荐） | 若要求像素基线，需另建基线库与容差策略，工作量显著增加 |
| B6 | 制品保留位置 | 确认失败截图放 `app/api/test/artifacts/`（gitignore）且默认不进 `deliverables/` | 保留策略不明确会继续污染交付物 |
| B7 | 「正式库指纹」口径 | 现基座只能指纹 `app/api/data/ie.db` + `storage`；**SQL Server `CN_AME` 无指纹能力**，其安全性靠「剔除连接环境变量 + 强制 sqlite」。是否接受该口径，或需额外只读行数抽查 | 若要求 SQL Server 前后校验和，需新增只读连接与授权 |
| B8 | 旧脚本退役节奏 | 是否允许迁完一批即把旧命令标记 deprecated（保留一个版本周期） | 双轨长期共存会继续误写正式库 |

### 5.3 立项建议

- **建议先批第 0 批 + 第 1 批**，这两批不依赖任何外部数据授权，能立刻把 20 套左右 UI 从「手工直连正式库」变成「隔离可重复」。
- **第 2 批以 B1 为开工条件**；拿到只读导出后按第 2 批验收标准执行。
- **第 3 批放在最后**，其中 `v353` 单独排期（它同时依赖 `L01-ST11`、mssql、storage 视频、临时目录 mp4，是耦合顶点）。
- **不要做的事**：不要为迁就测试而把 `ST010`/`L01-ST11` 写进 `scripts/seed.ts`。seed 直接植入种子工位，会与「清库后严禁 seed」的现状冲突，也会把测试夹具带进生产初始化。夹具只放 `test/fixtures/`。

---

## 6. 附：预期命令形态（迁移完成后）

```powershell
# 单套试点，连跑两遍
node app/api/test/isolated-run.cjs ui-wb-322 --repeat 2

# 第 1 批全量
node app/api/test/isolated-run.cjs --group ui-a --repeat 2

# 保留失败截图到测试制品目录（不进 deliverables）
node app/api/test/isolated-run.cjs ui-v348 --repeat 2 --keep-artifacts
```

总判定输出应同时包含：用例级一致性、清理、`data/ie.db` 指纹、`storage` 指纹、`deliverables` 指纹、静态门禁。

---

## 7. 本次评估的边界声明

- 仅阅读代码与目录、执行了只读的 `Test-Path` / 文件时间查询；**未修改任何文件、未启动服务、未连接数据库、未执行任何写库操作**。
- 文中所有「需新增/需改造」均为方案描述，落地前应逐批确认。
