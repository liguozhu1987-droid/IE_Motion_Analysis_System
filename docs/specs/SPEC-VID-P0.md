# SPEC-VID-P0 · Web 视频帧级分析（服务端派生 + 帧步进吸附）

> 状态：**Spec（设计细化输入）** | 上游：`ADR-VID-001.md`（决策 2/3/4 已写死命令与表结构）
> 不依赖决策门 1（HTTPS）；P0 在现状明文 HTTP 内网即可全量交付。HTTPS 落地后 P1 轨B 无感开启。

---

## 1. 目标与范围

- **目标**：在 Web 端达到「逐帧精确 + 无跨 GOP 抖动」的帧级分析基础能力，为 P1（WebCodecs 倒放/超慢/像素分析）与 P2（摄像头/AI 帧同步）铺路。
- **范围（本 Spec）**：服务端 ffmpeg 派生层（代理/精灵图/帧索引）、新表 `t_video_derivative`、端点草案、前端 `<video>` 帧步进吸附、分片上传、416 修复。
- **不在范围**：WebCodecs 解码环、canvas 缩放标注、真倒放（→ P1）；摄像头采集、AI 帧同步、双视频比较（→ P2）；WorkbenchPage 2855 行完整拆分（→ P1 硬要求，本 Spec 仅新增独立 hook，不改动主体）。

---

## 2. 服务端 ffmpeg 命令（写死）

### 2.1 元数据探测（不引入 ffprobe 二进制硬依赖）

```
ffmpeg -i <SRC> 2>&1        # 捕获 stderr
```

解析字段：

- `duration`：`Duration: 00:00:10.00` → `durationMs`。
- `fps`：`avg_frame_rate` / `tbr` / `tbn` 交叉校验；29.97 这类近似不得被硬钉成 30（可用 `rVFC` 前端采样降级交叉校验）。
- 分辨率：`Stream #0:0 ... 1280x720` → `width/height`。
- `codec_name`、`bit_rate`、`nb_frames`（若有）。
- **VFR 检测**：`avg_frame_rate` 与 `r_frame_rate` 差异超阈值 → `vfr=1`（须存逐帧 entries）。

### 2.2 分析代理（all-intra，Web 帧级消费的硬前提，非优化）

```
ffmpeg -y -i <SRC> -an -c:v libx264 -preset ultrafast -tune fastdecode \
  -g 1 -keyint_min 1 -sc_threshold 0 -crf 26 -pix_fmt yuv420p \
  -vf "scale=854:-2" -movflags +faststart -progress pipe:1 <OUT>/proxy.mp4
```

**硬件编码探测顺序（必须实跑 1 帧并校验输出非空；NVENC 失败会产 0 字节文件）：**

1. `h264_qsv`（`-c:v h264_qsv`，本机可用，约快 2.4×）
2. `h264_nvenc`（本机不可用，探测失败回退）
3. `libx264`（兜底）

> VP9 / AV1 否决：all-intra 编码过慢，且内网老旧 PC 无硬解。

### 2.3 精灵图 + 索引

```
# 每秒 1 帧，10 列网格，rows=ceil(count/10)，count=floor(durationSec)
ffmpeg -y -i <SRC> -vf "fps=1,scale=160:-2,tile=10x<ROWS>" -frames:v 1 -update 1 -q:v 3 <OUT>/sprite.jpg
```

- `sprite.json`（服务生成，非 ffmpeg 产出）：`{ cols:10, rows:<ROWS>, count:<count>, tileW:160, tileH:<derived>, fps:1, srcW, srcH }`
- **铁律**：tile 不补格，索引**必须携带实际 cols/rows/count**，禁止用 `cols×rows` 推算。

### 2.4 帧索引（canonical fps + VFR entries）

- **CFR**：`index.json = { fps, frames, durationMs, vfr:0 }`；前端按 `t = n / fps` 计算。
- **VFR（vfr=1）**：遍历代理逐帧 pts 生成 entries（仅 VFR 时存，避免大数组）：
  `ffmpeg -i <PROXY> -vf showinfo -f null - 2>&1` 解析 `pts_time` → `entries=[t_ms per frame]`。
- 代理为 all-intra，逐帧 seek 精确；index 主要用于前端时间轴与 AI 帧同步换算（`frame_no = round(t_ms × fps / 1000)` 仅显示对齐，t_element 毫秒语义与 ST 计算链不变）。

---

## 3. 新表 `t_video_derivative`（DDL，不加 FK）

```sql
IF OBJECT_ID('t_video_derivative','U') IS NULL CREATE TABLE t_video_derivative (
  id           NVARCHAR(36)  NOT NULL PRIMARY KEY,
  file_name    NVARCHAR(64)  NOT NULL,   -- 源视频 uuid.mp4（对应 t_video_asset.file_name）
  kind         NVARCHAR(16)  NOT NULL,   -- proxy | sprite | index
  status       NVARCHAR(16)  NOT NULL DEFAULT 'pending', -- pending | ready | error
  path         NVARCHAR(512) NULL,       -- 派生文件磁盘路径
  size         BIGINT        NULL,
  frames       INT           NULL,
  duration_ms  INT           NULL,
  width        INT           NULL,
  height       INT           NULL,
  fps          REAL          NULL,       -- canonical fps
  vfr          BIT           NULL,       -- 1=可变帧率，需用 entries
  retry        TINYINT       NOT NULL DEFAULT 0,
  last_accessed_at DATETIME2 NULL,       -- 预留 LRU（P0 不写入，P0.5 启用）
  error_msg    NVARCHAR(512) NULL,
  created_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UQ_video_derivative_file_kind ON t_video_derivative(file_name, kind);
```

- **幂等**：唯一键 `(file_name, kind)`；重复请求不重转（`status=ready` 直接返回；`status=error` 且 `retry<2` 才重入队）。
- **存储布局**：`storage/videos/derived/<uuid>/` 下 `{proxy.mp4, sprite.jpg, sprite.json, index.json}`，`<uuid>` 取自 `file_name` 去扩展名。

---

## 4. 端点草案（复用现有范式：`@Public()+?token=` 鉴权、`assertReadable(name, user)` 资源校验）

> 鉴权范式来自 `videos.controller.ts`：`@Public()` + 手动 `authenticate()` + `user.permissions.has('station:read')` + `videos.assertReadable(name, user)`。

| # | Method / Path | 鉴权 | 行为 |
|---|---|---|---|
| 1 | `POST /api/videos/:name/derive` | Bearer + `station:read` + `assertReadable` | 入参 `{ kinds?: ('proxy'\|'sprite'\|'index')[] }`（默认全三种）；upsert 派生行(pending) 并入队；返回当前各 kind 状态 |
| 2 | `GET /api/videos/:name/derivatives` | Bearer + `station:read` + `assertReadable` | 返回该视频全部派生 meta 数组（status/fps/frames/duration_ms/size/retry） |
| 3 | `GET /api/videos/:name/derivative/:kind` | `@Public()` + `?token=` + 手动鉴权 | `kind ∈ {proxy, sprite}`；`res.sendFile` 带 `Accept-Ranges:bytes` + `Content-Type`（proxy=video/mp4, sprite=image/jpeg）+ `Cache-Control: private, max-age=3600`；Range 206 由 sendFile 原生提供（补 callback 防 416→500） |
| 4 | `GET /api/videos/:name/derivative/:kind/meta` | `@Public()` + `?token=` + 手动鉴权 | 单 kind JSON meta（供 `<video>`/`<img>` 预载前探活，不暴露列表） |

> `:name` = 源视频文件名 `uuid.mp4`（沿用现有 `file/:name` 参数风格，便于复用 `filePathOf` / `assertReadable`）。

---

## 5. 队列与 worker（复用 ai-task 5s 轮询范式）

- 进程内 `setInterval(5000)` 轮询 `status='pending'` 且不在 in-flight Map 的行；**in-flight Map 去重**（同 `file_name+kind` 只跑一个）。
- **并发上限**：默认 2（QSV 优先；纯 libx264 队尾约 54min/50 并发，预热 + QSV 缓解）。
- 状态机：`pending → running → ready`(填 meta) / `error`(retry+1)；`retry<2` 下轮自动重入。
- 进度 MVP 用轮询（端点 2/4），**不上 SSE**（ARR 缓冲未验证）。

---

## 6. 前端帧步进吸附（P0，轨A，`<video>`）

- **新增独立模块** `src/video/useVideoEngine.ts`（≤300 行，**不改动 WorkbenchPage 2855 行主体**；完整拆分留 P1）：

  - `load(videoEl, { fps, proxyUrl, keyframeList })`
  - `stepFrame(dir)`：`const f = Math.round(video.currentTime*fps) + dir; video.currentTime = f/fps;`
    —— 代理为 all-intra，逐帧精确落帧，**消除跨 GOP seek 抖动**。
  - `seekToFrame(n)`：`video.currentTime = n / fps`。
  - `snapToFrameGrid()`：把 `currentTime` 吸附到最近 `1/fps`（处理浏览器浮点吸附误差）；非代理视频则吸附到最近 `keyframeList` 项。
  - **优先使用代理视频** `/api/videos/:name/derivative/proxy?token=`，未 ready 时回退原始 `file/:name`。

- **键盘绑定**：J/L 逐帧后退/前进（沿用现状 K 播放/暂停）；代理就绪后步进精确，未就绪走现状吸附。
- **标注 overlay**（DOM/SVG）与现有一致，本 Spec 不改。

---

## 7. 传输层修复（P0）

### 7.1 分片上传（契约已锁定——前后端并行开发的唯一对齐点）

**触发策略（前端上传工具统一封装）**：文件 ≤8MB 走现有单文件直传；>8MB 走分片模式（规避 IIS `maxAllowedContentLength` 28.6MB 默认 413 拦截）。

| 项 | 锁定值 |
|---|---|
| 端点 | `POST /api/videos/upload`（复用现有端点，分片为查询参数模式，不新增路径） |
| 分片参数 | `?uploadId=<uuid>&chunkIndex=<0-based>&chunkTotal=<N>`（三者齐全即分片模式） |
| multipart 字段 | `file` = 当前分片二进制；`chunkIndex=0` 时附带表单字段 `originalname`、`raw`（沿用现有语义） |
| 分片大小 | ≤8MB，**顺序上传**（P0 不做并行/断点续传，见 §10 backlog） |
| 服务端落盘 | `storage/videos/tmp/chunks/<uploadId>/<chunkIndex>.part`；同 index 重传覆盖（天然幂等） |
| 合并时机 | 收到 `chunkIndex === chunkTotal-1` 且 0..N-1 齐全 → 顺序合并为 `storage/videos/tmp/up_<ts>_<rand>.<ext>` → 复用现有 `ingest()`（探测/转码/直通）→ 清理分片目录 |
| 响应 | 非末片 `{ received: <n+1>, total: <N> }`；末片 = 与现有单文件上传**完全相同**的 ingest 返回 |
| 权限 | `element:write`（同现有） |
| 残留清理 | 分片目录 TTL >24h，由派生 worker 顺带清理（防中断遗留） |

> **合并策略选型说明**：选 **temp+concat**（临时分片 + 末片合并）而非「边收边 append 到目标文件」——前者天然支持将来并行分片/乱序/断点续传（纯内部演进，契约参数不变），后者锁死顺序模式。成本差异可忽略。

### 7.2 416 修复

- `res.sendFile` 增加 callback，裸 416 Error **不再**被 `AllExceptionsFilter` 转 500（区分 416 与真 500）。

### 7.3 Range 206

- sendFile 原生支持，已实测；保持 `Accept-Ranges: bytes`。

---

## 8. 验收标准

- [ ] 上传视频后触发派生，`proxy.mp4` 全 I 帧（校验 `g=1` 或 总帧数 = duration×fps）。
- [ ] `GET .../derivative/proxy` 支持 Range 206 拖动。
- [ ] `<video>` + J/L 在代理视频上逐帧精确（与帧号一致，无跨 GOP 抖动）。
- [ ] 50 人并发口径下派生队列不崩溃，in-flight 去重生效。
- [ ] 分片上传 >28.6MB 视频成功，无 413。
- [ ] 现有冒烟/集成套件仍通过（新增端点补契约测试）。

---

## 9. 风险与依赖

- 依赖决策门 1（B 通道 AD CS）仅影响 P1/P2；**P0 明文 HTTP 可交付**。
- ffmpeg 二进制须手动放置；硬件编码探测须实跑校验（防 NVENC 0 字节）。
- 磁盘：每 10min 视频 400–750MB 代理；先加 `VIDEO_DERIVED_MAX_GB` 告警，LRU 删代理保源可归入 P0.5。
- 回归基线：后端冒烟 139/139、集成 31、dashboard 30、auth 48、settings 20、diff 15；前端多套 UI 测试全通过——新增代码须不破坏既有套件。

---

## 10. 后续优化 backlog（P0 验收后排期；影响评估结论均为「增量演进、无需返工」）

| 项 | 目标迭代 | 后补方式 | 影响评估结论（2026-10-29 总监裁决） |
|---|---|---|---|
| 派生自动触发（上传完成后服务端自动入队预热） | P0.5 | `videos.service.ingest()` 成功回调内调用入队逻辑（1 处服务端改动）；P0 前端工作台载入视频时自动调 `POST /derive` 已覆盖多数场景 | 现在不做、后补成本低（幂等由唯一键+状态机保证，无契约变更） |
| `VIDEO_DERIVED_MAX_GB` 告警阈值与 LRU 删代理 | P0.5 | 告警 = worker 顺带 du + warn 日志 + env 阈值；LRU = 启用 `last_accessed_at`（DDL 已预留，无迁移）+ 新增 `evicted` 状态（前端对未知状态统一按「未就绪回退原始视频」处理，§6 已定义） | 现在不做、后补成本低（列已预留 + 状态枚举增量扩展） |
| 分片并行上传 / 断点续传 / tus 协议 | P1+ | temp+concat 合并策略天然支持乱序与续传，契约参数不变 | 现在不做、后补成本低 |

## 11. 变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|---|---|---|---|
| 2026-10-29 | §3 DDL 预留 `last_accessed_at`；§7.1 分片上传契约锁定（端点/参数/字段/合并策略/响应/清理）；新增 §10 backlog | 3 个细化项影响评估（总监裁决）：均为「后补成本低」，无必须编码前再细化的高风险项；分片契约是前后端并行开发唯一对齐点，编码前锁定 | 无新端点、无新表、不改页面——属小改，按变更流程更新后继续开发 |
