# v3.39b 交付报告：AI 写入链路真实规模压测 + 服务器视频上传入口

> 对应需求：「1和2开始做吧」= v3.38b 优化清单 **P0-1**（136 条真实规模写入压测）+ **P0-2**（AI 页接入服务器视频上传，手机拍片 → 上传 → 分析闭环）。
> 测试对象：真实工位视频 `SH-FA9-A12-PA10-1.mp4`（上海 SHFA9 产线 PA10 工位，391.8s / 1920×1080 / HEVC / 253MB，固定机位、单人、双手戴手套）。

---

## 一、P0-1 写入链路真实规模压测 —— 23/23 全过

测试脚本 `app/web/test-ai-segment-write-stress.cjs`（新建），走**真实产品 UI 全链路**：重置工位 → 本地载入全片 → 分析 → 全选 → UI 写入 → API 回读 → 后端纯 submit → 工作台 UI 回读。

### 1. 分析产出质量（5 项断言）

| 指标 | 实测 | 门限 | 判定 |
|---|---|---|---|
| 候选条数 | **136 条** | ≥100 | ✅ |
| 段时长中位 | **2.9s** | ≥2.0s | ✅ |
| 1.0–1.9s 段占比 | **22.1%** | <35%（v3.37 为 51.9%） | ✅ |
| 类型有值率 | **100%** | 100% | ✅ |
| 描述标准库骨架率 | **100%** | 100% | ✅ |

置信分层 高32 / 中97 / 低7——与 v3.38b 全片实测**逐项一致**，证明 v3.38b 优化在写入链路上稳定复现。分析耗时 322s（0.82× 实时）。

### 2. 写入链路（UI → API → DB → 工作台，12 项断言）

| 环节 | 实测 | 门限 | 判定 |
|---|---|---|---|
| UI 写入 136 条 | **1861ms**（CT 450.7s） | <60s | ✅ |
| 回读条数一致 | 136/136 | =纳入数 | ✅ |
| source 落库 | 全部 `ai_assisted` | 全部 | ✅ |
| video_id 落库 | 全部 `ai-segment` | 全部 | ✅ |
| V1 描述非空 | 136/136 | 全部 | ✅ |
| V1 类型非空 | 136/136 | 全部 | ✅ |
| V2 时间链零重叠 | 0 处 | 0 | ✅ |
| 后端纯 submit | **1183ms** · 响应 6004B · 201 | <30s | ✅ |
| element_count 一致 | 136 | =纳入数 | ✅ |
| 二次写入回读一致 | 136/136 | 一致 | ✅ |
| 工作台时间线回读 | **136 块** | =纳入数 | ✅ |
| 未捕获页面异常 | 0 | 0 | ✅ |

**性能结论**：136 条真实规模下，UI 写入 1.9s、后端纯 submit 1.2s，对 60s/30s 门限仅用 3%/4%——整版删除重插事务 + 三校验（V1/V2/V3）在真实规模下余量充足，无性能风险。

### 3. 证据文件

- `deliverables/ai-segment/real/stress-run.log`（完整日志）
- `deliverables/ai-segment/real/stress-write-result.json`（机读报告，含 136 条候选明细）
- `deliverables/ai-segment/real/stress-write-done.png`（写入完成态截图：已写入 v1：要素 136 条，CT 450.7s）
- `deliverables/ai-segment/real/stress-workbench.png`（工作台回读态截图：136 要素 / 450.48s / CT 60s / TT 36.9% / VA 占比）

### 4. 数据态

PA10 工位保留 136 条 AI 要素（`source=ai_assisted` / `video_id=ai-segment` / v1）——真实规模数据，可直接作演示与人工精修起点。

---

## 二、P0-2 服务器视频上传入口 —— 15/15 全过

### 1. 功能闭环

手机拍片 → 「从服务器载入」上传 → 服务端落盘 → 同源 blob 拉取 → 本机分析（与本地文件同一条链路）。

### 2. 实现要点

**后端**（`app/api/src/modules/videos/`）：
- `ingest(sourcePath, originalName, allowRaw=false)` 新增免转码参数；`POST /videos/upload?raw=1`
- `allowRaw` **仅当调用方已用 canPlayType 确认浏览器能播原始编码时传入**；分解工作台不传，v3.28 策略零变化
- 手机 HEVC 素材免去分钟级转码等待；播不了时前端自动请求转码重试一次

**前端**（`app/web/src/api.ts` + `pages/AiSegmentPage.tsx`）：
- `uploadWithProgress`：XHR 上传带进度，401 时刷新 token 重放一次（retried 守卫）
- `fetchVideoBlob`：API_ORIGIN 推导修掉 `/api/api` 双前缀 404；url 已含 /api 不再拼 BASE
- `NATIVE_EXTS` 白名单（mp4/m4v/mov/webm/3gp）+ `browserCanPlay` 双检才敢 raw；拿不准走转码保底
- `onVideoError` 免转码直通视频播不了 → 自动请求转码重试一次
- `uploading` 态禁用「开始分析」——防旧视频上抢跑分析（分析中换源 → 无输出）

### 3. 验证（test-ai-segment-upload.cjs，15/15）

| 场景 | 结果 |
|---|---|
| H.264 MP4 上传 → 直通分析 | ✅ |
| HEVC MP4 上传 → raw 免转码直通 → 可分析 | ✅ |
| H.264-in-MKV 上传 → 自动转码 → 可分析 | ✅ |
| 假 .avi → 明确报错 | ✅ |
| 假 .mp4（内容非视频）→ 触发自动转码重试 → 明确报错 | ✅ |
| 页面不白屏 / 无未捕获异常 | ✅ |

### 4. 证据文件

- `deliverables/ai-segment/real/upload-hevc-result.png`、`upload-final.png`、`head-layout-v339.png`（头部布局单行无挤压：5 控件 594px/28px）

---

## 三、测试基建修复（三项，全测试侧）

1. **const TDZ（最贵坑）**：CT 断言引用 100 行后才声明的 `sub`，长流程跑完 6 分钟分析+写入才崩。纪律：长流程脚本写完必须 `node --check` + 通读变量引用序。
2. **page.evaluate 浏览器上下文**：Node 侧常量必须显式传参（`'#/workbench/'+SID` → `SID is not defined`）。
3. **evaluateOnNewDocument 闭包语义**：闭包参数对**每次文档创建**都生效——`boot(true)` 的一次性清理在 reload 时重复执行，把「检测方式跨刷新保留」断言擦掉（v337 首跑 17/18 实锤）。修法：sessionStorage 哨兵保证仅首个文档清理。该模式同时根治了此前的跨文档刷新重放竞态（双 goto + reload 导致同一 refresh token 两文档并发使用 → 重放检测吊销全部会话 → 页面无故退回登录页）。

---

## 四、零破坏验证

- 生产构建：**WorkbenchPage 98.08KB**（与 v3.34/v3.37/v3.38b 完全一致 = 工作台零 AI 痕迹铁证）；AiSegmentPage 28.48KB
- v337 回归（确定性引导模式首验）：**18/18**
- tsc 前后端零错误
- 工作台/分解工作台代码零改动（本版全部改动限于 AI 并列页 + videos 模块 + 测试脚本）

---

## 五、后续候选（未排期）

- **P3-9 浪费识别 + 改善问题清单自动生成**（用户最初清单核心诉求，依赖动素分类精度，建议单独一期）
- audit:read 审计查询页、AI Agent 任务队列、SQL Server 定时备份、审批消息通知、多租户自助开通
