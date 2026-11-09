# ADR-VID-001 · Web 视频分析管线架构（本地原生级帧级分析）

> 状态：**Proposed（决策门 1 已据实 RESOLVED → 选 B 通道 AD CS；待决策门 2-4 确认后转 Accepted）** | 作者：高见远（架构师），总监汇编 | 关联：OPEN-DECISIONS 2026-10-29 / ADR-AI-SEG-001 / ADR-AI-SEG-002 / 项目记忆 §7

## Background（为什么做这个决策）

用户决定**锁定 Web 部署**（局域网/云端数据共享 + AI 智能分析优先），唯一核心待解项 = **Web 视频性能**：要在 Web 上达到本地原生级帧级分析（逐帧步进 / 倒放）+ 平滑加速播放（不卡顿）+ 缩放标注 + 摄像头采集。对标产品 AviX / OTRS10 均为 Windows 桌面端（本地视频引擎）。

三方调研结论（贾思敏前端 / 贝洛奇后端 / 高见远架构）：

1. `<video>` 的 seek 语义是「落到之前最近关键帧再解到目标帧」，普通 GOP=250 下最坏要解 250 帧，且 currentTime 被吸附到关键帧时刻 → **all-keyframe（GOP=1）分析代理是 Web 帧级消费的硬前提，不是优化**。
2. `video.seekToNextFrame()` 已全浏览器死亡（Firefox 128 移除，Chrome 从未支持）；负 playbackRate 在 Chrome/Edge/Firefox 抛 NotSupportedError → 帧级定位只有两条路：all-keyframe + currentTime，或 WebCodecs。
3. playbackRate 在 Chromium/Firefox 为 0.0625–16（源码实证），覆盖 OTRS10 的 0.03–8× 主要区间；<0.0625 超慢与真正倒放需 WebCodecs。
4. WebCodecs 2026 支持：Chrome/Edge 94+、Firefox 130+、Safari 16.4+（16.4–18.7 仅视频类，26.0 全量）；**要求 Secure Context**。
5. 纯 HTTP 内网（`http://192.168.x.x`）**不是** potentially trustworthy origin → WebCodecs / getUserMedia / getDisplayMedia 全部不可用（W3C 规范级硬约束）；`http://localhost` 是；**MSE / hls.js 不受此限**（任务书偏差，已纠正）。
6. 本机 ffmpeg 6.1.1 实测：all-intra 480p 代理 crf26 ≈ 29MB/min，13s/60s（libx264）/ **5.5s/60s（h264_qsv，本机可用，快 2.4×）**；VP9/AV1 all-intra 编码过慢且内网老旧 PC 无硬解 → 否决，编码器锁定 H.264。

## Decision（选择了什么）

1. **双轨前端引擎（capability-gated，UI 同一套控件热切换）**
   - 轨A `<video>`（全 origin 可用，默认）：常规播放 + playbackRate 0.0625–16× + J/L/K 帧步进（吸附服务端关键帧列表，消除跨 GOP seek 抖动）+ 片段循环 + DOM/SVG 标注 overlay。
   - 轨B WebCodecs + canvas（`window.isSecureContext && 'VideoDecoder' in window` 才启用）：<0.0625 超慢、真倒放（解码环缓冲）、帧号精确寻址、像素级分析；demux 用 mediabunny（mp4box.js 备选），**ffmpeg.wasm 不作主路径**；`hardwareAcceleration:'prefer-hardware'`；VideoFrame 必须 close()，decodeQueueSize ≤2-3 背压。
   - 降级：无 WebCodecs 时轨A 全功能可用（现状 J 键点按后退保留）；再兜底服务端精确抽帧 JPEG。
2. **服务端派生层（P0，懒生成 + 上传后预热）**
   - 分析代理（**必须 all-intra**）：
     `ffmpeg -y -i <src> -an -c:v libx264 -preset ultrafast -tune fastdecode -g 1 -keyint_min 1 -sc_threshold 0 -crf 26 -pix_fmt yuv420p -vf "scale=854:-2" -movflags +faststart -progress pipe:1 <out>/proxy.mp4`
     硬件探测顺序 h264_qsv → h264_nvenc → libx264（**探测必须实跑 1 帧并校验输出非空**，NVENC 失败会产 0 字节文件）。
   - 精灵图：`-vf "fps=1,scale=160:-2,tile=10x<ROWS>" -frames:v 1 -update 1 -q:v 3`；索引 JSON **必须携带实际 cols/rows/count**（tile 不补格，禁止用 cols×rows 推算）。
   - 帧索引：canonical fps（扩展 probe 解析 `ffmpeg -i` stderr，**不引入 ffprobe 二进制硬依赖**）+ VFR 必须存逐帧 entries。
   - **裁决记录**：架构初稿中代理 `g=50` 一行系笔误，作废；常规 GOP 预览代理如未来带宽需要可另增，不影响分析代理。
3. **传输层**：HTTP Range 206 已实测支持（res.sendFile 原生），补两处——① sendFile 增加 callback（416 裸 Error 现被全局过滤器转 500）；② 上传改分片（每片 ≤8MB，规避 IIS maxAllowedContentLength 默认 28.6MB vs VIDEO_MAX_MB=2048MB 的 413 拦截）。
4. **存储与队列**：`storage/videos/derived/<uuid>/{proxy.mp4,sprite.jpg,sprite.json,index.json}`；新表 `t_video_derivative`（**不加 FK**，唯一键 (file_name, kind) 保幂等，pending/ready/error + retry<2）；复用 ai-task 5s 轮询队列范式 + in-flight Map 去重；进度 MVP 用轮询不上 SSE（ARR 缓冲未验证）。
5. **安全上下文解法（决策门 1 — 已据实拍板方向）**：现场域为 `ap.inalfa.local`（**`.local` 后缀 + 内部 AD 域**），据此四通道判定如下：
   - **A 通道（公共 CA / Let's Encrypt / 阿里云·腾讯云免费 DV）❌ 不可行**：RFC 6762 保留 `.local` 给 mDNS，CA/Browser Forum 2015 起禁止公共 CA 给 `.local` / 内网名 / 私有 IP 发证；`*.ap.inalfa.local` 申请不到任何公开信任证书。
   - **B 通道（AD CS 内部 CA）✅ 已选（部署服务器已确认为 `IRScnKettle01.ap.inalfa.local`）**：机器已加域，部署 AD CS 后企业根证书**自动下发到全部域成员机信任库**，配 GPO「证书自动注册」即自动签发 + 到期前约 20% 有效期自动续期；内部 CA **可**给 `.local` 名与 IP 发证（恰是公共 CA 不能做的）。证书费用 = 0，代价仅 IT 一次性装 AD CS 角色 + 建 Web Server 模板（建议 5 年有效期）+ 开 GPO。
   - **C 通道（自签 + 手动信任）⚠️ 可行不推荐**：逐台装根证书体力活，仅作无 AD CS 时的兜底。
   - **D 通道（Tauri 桌面壳）✅ 备选**：`http://tauri.localhost` 以 `.localhost` 结尾属 trustworthy，**彻底免证书**；适合不想碰证书运维、或需覆盖**非加域客户端**（见下）的场景，代价是逐台装客户端。
   - **关键澄清**：HTTPS 证书**不需要付费购买**——公共 CA 对本场景本就发不出，而 AD CS 内部 CA 与自签均零费用；所谓「证书 + 续期监控」是**运维动作**（装 AD CS、保 CA/CRL 健康、到期监控），不是采购费。
   - **非域客户端覆盖**：B 通道只信任域成员机；未加域的终端（外包笔记本等）需手动装一次企业根证书（或也加域）。若此类客户端多，倾向直接走 D 通道免证书运维。
   - 落地步骤：IIS 绑 `IRScnKettle01.ap.inalfa.local` 的 AD CS 证书 + `SEC_HSTS=on`（maxAge 先 86400 观察）；Firefox 需单独企业策略信任（同域根已随 AD 信任，Firefox 仍可能要 `security.enterprise_roots.enabled`）；证书到位后 P1 轨B 无感开启。
6. **AI 帧同步**：canonical fps 由服务端供数（前端 rVFC 12 采样降级为交叉校验，消除 29.97 被 COMMON 档位钉成 30 的量化偏差）；`frame_no = round(t_ms × fps / 1000)` 仅作显示对齐，**t_element 毫秒语义与 ST 计算链不变**；AI 三铁律（永远待审 / LLM 禁产数字 / 模拟值不回写正式 ST）原样保持。
7. **本地视频边界（决策门 3）**：ADR-AI-SEG 系列既定「现场视频不上传、浏览器内存分析」继续适用于 ai-segment 页；本地文件帧级走浏览器 WebCodecs（mediabunny BlobSource，可精确寻址，回退跳帧有解码成本）。**上传/共享场景才生成服务端代理**。

## Consequences（后果）

**正面**：P0 在现状明文 HTTP 内网即可全量交付且零破坏（轨A + 代理 + 精灵图）；HTTPS 落地后轨B 无感开启；复用既有鉴权链（`@Public()+?token=` + assertReadable）、队列范式、migrate.ts 幂等 DDL；Web 分发形态不变（无安装、无更新链路）。

**负面**：引入 AD CS 内部 CA 运维依赖（IT 一次性装角色 + 建模板 + 开 GPO；需监控 CA 服务与 CRL 发布健康，证书经 GPO 自动续期）；代理磁盘每 10min 视频 400-750MB（50 人 × 5 条 ≈ 100-190GB，需 LRU 删代理保源 + `VIDEO_DERIVED_MAX_GB` 告警）；50 人并发纯 libx264 队尾约 54min（预热 + QSV 缓解）；**WorkbenchPage.tsx 2855 行必须拆分为 `useVideoEngine()` + `components/VideoStage.tsx` + `video/`（单文件 ≤300 行纪律）**——这是本次升级的强制副产品。

**风险**：CA 服务宕机或 CRL 未发布导致域机证书校验失败（高严重度）→ 监控 CA 服务 + CRL 发布，证书经 GPO 自动续期无需手动；**非加域客户端缺失企业根证书** → 访问报不安全，需手动装根或走 D 通道；Firefox WebCodecs H.264 解码缺陷（bug 1918769，isConfigSupported 返回 true 实际抛错）→ Firefox 强制走轨A；企业 GPO 可能禁摄像头/录屏（VideoCaptureAllowed/ScreenCaptureAllowed）→ 显式提示不静默失败；ffmpeg-static npm 二进制未下载成功（postinstall 需直连 GitHub）→ 部署机必须手动放 `app/api/bin/ffmpeg.exe`。

## 工作量（1 名高级全栈口径）

| 阶段 | 内容 | 人月 | 依赖 |
|---|---|---|---|
| P0 | 服务端 fps 化 + 代理/精灵图/索引 + 队列去重 + 新端点 + `<video>` 帧步进吸附 + 分片上传 + 416 修复 | 1.2-1.5 | 无，可立即开工 |
| P1 | WebCodecs 解码环 + canvas 缩放标注 + 平滑倒放 + WorkbenchPage 拆分 | 1.0-1.2 | P0 + 决策门 1 |
| P2 | 摄像头采集 + AI 帧同步 + 双视频比较播放 | 1.0 | P1 + 证书落地 |

合计 **3.2-3.7 人月**；关键路径 = 决策门 1（证书）→ P1 → P2，P0 与证书决策并行。
