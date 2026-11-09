# 悬而未决登记册（OPEN-DECISIONS）

> 规则：只追加 + 就地关闭（OPEN → RESOLVED，补 Resolution 与日期）。已关闭项可升格为 ADR。
> 每次 Phase 开始时须把未决项复现到工作上下文最前面，逐条判断能否关闭。

**当前汇总：4 未决 / 13 已决 / 2 已关闭（转入 Spec）**

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-10-25 | Phase 0 | AI 动作切分推理跑在哪 | 用户对 AI 视频分析高成本敏感（项目记忆） | 浏览器端 on-device（MediaPipe Tasks Vision） | — | 用户已拍板 | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 0 | 一期范围是否含浪费区间识别 | 浪费识别依赖动素分类精度，与既有规则引擎结论可能冲突 | 一期只做动作切分候选，浪费识别推后 | — | 用户已拍板 | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 0 | 现场视频是否上传服务器 | 车间视频可能涉密；前端 v3.28 起本地 object URL 优先 | 不上传，只在浏览器内存分析 | — | 用户已拍板 | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 0 | 是否新建 ai_job/ai_result/ai_segment/ai_waste_candidate 四表 | 视频不上传 ⇒ 候选无跨会话锚点；`t_element.video_id` 列已存在（NVARCHAR(64) NULL，无 FK） | 倾向「只加 `t_element.source` 一列 + 复用 `t_audit_log`」，不建表 | 架构师裁决（代价对比表） | ADR-AI-SEG-002 落定 | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 0 | 手部轨迹能否切出 IE 认可的「止点」 | MediaPipe hand landmarker 每帧 21 点/手；抽帧率与推理耗时为硬约束 | 速度阈值 + 静止持续帧数 = 候选止点（与 IE 止点语义对齐） | 架构师可行性论证 + 小样本实测 | ADR-AI-SEG-001 落定（探针实跑） | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 0 | 模型文件如何离线分发 | 实测源站经代理约 12KB/s：hand 7.82MB / pose_lite 5.78MB | 随包落 `app/web/public/models/`，禁运行时拉 CDN | — | 已落地 `public/models/` | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 1 | 候选层是否新增第 4 条时间线轨道 | 1366 屏时间线仅 145px 高、3 轨×28px 已满 | 待设计师给出数字核算（新增轨是否挤爆） | 设计师回传 | DESIGN §4.2 否决第 4 轨，叠加入轨 | **RESOLVED 2026-10-25** |
| 2026-10-25 | Phase 1 | 批量「全部接受」是否允许无二次确认 | 30 段一次接受属不可逆破坏性操作 | 倾向强制二次确认 + 提供撤销 | 设计师反模式评估 | DESIGN §6.8 三级闸门（无「全部」按钮） | **RESOLVED 2026-10-25** |
| 2026-10-29 | Phase 1 | 内网 HTTPS 证书策略：企业 CA / 自签+GPO / 整体否决 | WebCodecs+getUserMedia 需 Secure Context；现场域 `ap.inalfa.local` 为 `.local` 内部 AD 域（用户 2026-10-29 提供 hostname 实测） | **已选 B 通道 AD CS 内部 CA**：部署服务器确认为 `IRScnKettle01.ap.inalfa.local`（已加域），A 通道（公共 CA）物理不可行；D 通道 Tauri 壳仅作非域客户端多的备选 | 用户 + IT | 用户确认部署服务器即该域成员机；IT 落地 AD CS 角色+模板+GPO | **RESOLVED 2026-10-29** |
| 2026-10-29 | Phase 1 | 代理转码算力与磁盘预算：derive 并发度、derived 目录上限 | 50 并发纯 libx264 队尾约 54min；每 10min 视频 400-750MB，50 人×5 条≈100-190GB | QSV 优先 + 上传后预热 + LRU 删代理保源 + VIDEO_DERIVED_MAX_GB 告警 | 用户 + IT（服务器核数/磁盘） | 目标服务器实测参数后 | **RESOLVED 2026-11-06**（目标机 6C E7-4850 v4/32G/150G 确认；压测后定并发 2、超时 30min、僵尸 35min、derived 上限 60GB，见 [docs/ops/VIDEO-CAPACITY.md](../ops/VIDEO-CAPACITY.md)） |
| 2026-10-29 | Phase 1 | 「现场视频不上传」硬约束（2026-10-25 已决）是否对分析代理放开 | 服务端 all-intra 代理需视频在服务端；本地文件可改走浏览器 WebCodecs 精确寻址 | 上传/共享场景走服务端代理；纯本地文件（ai-segment 页）维持浏览器内存分析 | 用户 | 用户确认 LAN 共享范围后 | **OPEN** |
| 2026-10-29 | Phase 1 | 是否引入 Tauri 桌面壳（证书路线被拒时的备选分发） | `http://tauri.localhost` 属 trustworthy，可同时解内网 WebCodecs+摄像头+保留 Web 栈 | 证书确认后再议，避免双线空转 | 用户（决策门 1 否决后触发） | 决策门 1 有结论后 | **OPEN** |
| 2026-10-29 | Phase 1.5 | 派生触发时机：上传后服务端自动预热 vs 手动端点 | SPEC-VID-P0 §4 端点触发源无关；队列幂等由唯一键+状态机保证 | P0 = 手动端点 + 前端工作台载入时自动调 POST /derive；P0.5 = ingest 成功回调自动入队（1 处服务端改动） | P0 验收后排期 | P0.5 排期时 | **RESOLVED 2026-10-30**（`videos.service.autoDerive()` 已落地：fire-and-forget、`VIDEO_AUTO_DERIVE=0` 可关、allowRaw 跳过；契约 S1.5） |
| 2026-10-29 | Phase 1.5 | `VIDEO_DERIVED_MAX_GB` 告警阈值与 LRU 删代理策略 | 代理磁盘每 10min 视频 400-750MB；50 人×5 条≈100-190GB | P0 先做 worker 顺带告警日志（env 阈值）；LRU 启用 `last_accessed_at`（DDL 已预留）+ `evicted` 状态（前端未知状态统一回退原始视频） | P0 验收后排期 | P0.5 排期时 | **RESOLVED 2026-10-30**（worker 60s 节流 du 告警 + LRU 淘汰 proxy→`evicted`；`fileOf` 回写 `last_accessed_at`；derive() 对 evicted 重置 pending；契约 S7.1–S7.4。阈值默认 0=关闭，目标服务器实测后配 env） |
| 2026-10-29 | Phase 1.5 | 分片并行上传 / 断点续传 / tus 协议 | SPEC-VID-P0 §7.1 temp+concat 合并策略天然支持乱序与续传，契约参数不变 | P1+ 按需演进 | P1 排期 | 大文件上传出现体验投诉时 | **OPEN（backlog）** |
| 2026-11-06 | Phase 1.5 | 源视频保留策略：到期「只归档不删」还是「通知+用户决定+到期硬删」 | 只归档没有回收磁盘效果；业务要求用户可选择延期/永久保留 | 归档草案作废，改为 auto/extended/permanent 三态 + 到期硬删 | 用户 | 用户拍板 | **RESOLVED 2026-11-06**（默认保留 10 天、提前 3 天邮件提醒、上传者/管理员可延期或永久保留、到期未响应硬删源文件+派生文件、审计来源 auto_expired/manual、失败计数+告警、手工 SQL 见 deploy/sql/manual/2026-11-06-video-retention.sql） |

## 关闭记录

- 2026-10-25：前 3 条由用户在 Phase 0 拍板，已作为不可变更硬约束写入 Spec 与 spawn 指令。三者叠加直接导致清单 §4.1–§4.4 四张表失去存在理由（无视频锚点 ⇒ 候选无跨会话价值），属本次范围最大幅收敛。
- 2026-10-25：清单原设计「`GET /api/ai/jobs/:jobId` + `GET /api/ai/jobs/:stationId`」被判定为**路由歧义缺陷**（两资源同路径形状，且项目已有 `@Get('sets')` 被 `:code` 吞掉的实锤），不进入待办，直接作废。
