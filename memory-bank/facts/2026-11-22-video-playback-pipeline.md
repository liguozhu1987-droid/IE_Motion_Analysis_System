---
tags: ["视频","转码","ffmpeg","HEVC","播放器"]
status: draft
date: 2026-11-22
source: app/api/src/modules/videos/videos.service.ts, app/web/src/pages/WorkbenchPage.tsx
---

# 视频播放链路：浏览器原生播放 + 服务端转码回退

1. **播放器是浏览器原生 `<video>`**，项目无第三方播放器库；后端 `/api/videos/file/:name` 支持 Range/206（拖动进度条依赖）。
2. **`app/api/bin/ffmpeg.exe` 不在 git 内**（体积大，走拷贝分发）。缺失时上传直接 503（探测阶段即失败），部署新机必须手动放置，或用 `FFMPEG_BIN` 指定。
3. **HEVC（H.265）视频在无 HEVC 解码的浏览器上「黑屏有声且不报错」**：`videoWidth=0`、`readyState=4`、`error=null`，`onError` 永不触发。已在前端 `onLoadedMetadata` 增加「元数据就绪但 500ms 后 videoWidth 仍为 0 → 视为解码失败 → 触发服务端转码」的补丁。
4. **转码编码器**：上传转码走 QSV 优先、NVENC、失败回退 libx264（与派生路径共用 `resolveEncoder`）。本机 Intel 核显**无 HEVC 硬解**，QSV 只加速编码侧（86s/1080p HEVC 源：软编 17.4s → QSV 11.9s）。
5. **根治 HEVC 等待**：装浏览器「HEVC 视频扩展」走原生直通，零转码。

**排查入口**：`app/api/src/modules/videos/`（ingest / transcode / derivative）、`app/web/src/video/`。