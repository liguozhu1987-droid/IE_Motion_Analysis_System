# ADR-AI-SEG-001 · AI 动作切分推理位置与算法

> 状态：**Accepted（2026-10-25）** | 作者：高见远（架构师，由总监代录）| 关联：Spec-AI-动作切分 v1.0 §4

## Background（为什么做这个决策）
用户已拍板三条硬约束：①推理在浏览器端（MediaPipe）；②视频不上传；③一期只做动作切分候选。
项目记忆明确「用户对 AI 视频分析高成本敏感」。需在「不装 Python/GPU/训练集」的前提下，给出一条**可落地、成本为零、且能切出 IE 认可止点**的技术路径。

## Decision（选择了什么）
1. **推理引擎**：浏览器端 `@mediapipe/tasks-vision` 1.1.1，`HandLandmarker`（numHands=2，VIDEO 模式）。
2. **模型离线分发**：`hand_landmarker.task`（7.82MB，float16/1）随包落 `app/web/public/models/`，**禁止运行时拉 CDN**（实测源站经代理约 12KB/s）。WASM 运行时（~10MB）同样离线。
3. **GPU/CPU 双 delegate，GPU 优先、失败回落 CPU**（工业 PC 常无独显）。
4. **抽帧策略**：**seek 定步长 100ms（10Hz）确定性抽帧**（`video.currentTime = t` → `seeked` → `drawImage` → `detectForVideo(cv, tsMs)`）。不依赖 `playbackRate` 加速扫描（会丢帧、覆盖不均）。代价是 seek 往返开销，但换来零漏检与可复现。
5. **切分算法**：手部轨迹**准静态运动分割（quasi-static motion segmentation）**——见 §Algorithm。
6. **不引入 YOLO / 不训练 / 不做服务端推理**（直接否决清单 §6.2 的 YOLO 方案，原因：无 Python 运行时、无 GPU、无标注集、持续训练成本，与成本铁律冲突）。

## Algorithm（工程算法，供前端实现）
```
for each frame at t = 0,100ms,200ms,…:
    res = landmarker.detectForVideo(canvas, t_ms)
    for each detected hand h:
        c_h = palmCenter(landmarks[h])            # wrist(0)+middle_mcp(9) 均值
        v_h = |c_h[t] - c_h[t-1]| / dt           # 手部质心速度（px/s）
        aperture_h = dist(thumb_tip(4), index_tip(8))
    record {t, hands:[{c, v, aperture, conf, label}], count}

# 分割：以「运动 → 准静态」的拐点 = 候选止点
for each hand-track (按 label L/R 分别，B=同时出现):
    run = []
    for f in frames:
        moving = (v_h[f] > V_THRESH) OR (aperture_change > A_THRESH)
        if moving: run.append(f); still_count=0
        else: still_count++
              if still_count >= STILL_MIN_FRAMES:        # 静止持续 → 止点
                  if run 非空: emit_segment(run)
                  run = []; still_count = 0
    if run 非空: emit_segment(run)
    # 手数变化（1↔2）= 循环断点，强制在此切段（run 提前收尾）

emit_segment(run):
    start_ms = run[0].t; end_ms = run[-1].t
    hand = dominant hand in run (B if both present ≥ half)
    conf = median(detection_conf in run)
    # R1 时长护栏
    if (end_ms-start_ms) < 300ms or > 6000ms: tier = low; precheck = false
    # R2 手别不确定
    if presence_conf(hand) < 0.60: tier = low
    # R3/R4 与人工块/已标注区重叠 < 80ms → 不生成
    if overlaps(draft, start_ms, end_ms, 80): skip
    candidates.push({start_ms, end_ms, hand, conf, type:'其他', tier})
```
- `V_THRESH`：`palmCenter` 速度阈值（px/s），建议 0.03×frame 对角长（自适应分辨率）。
- `STILL_MIN_FRAMES`：建议 4（=400ms 静止判为止点；与 IE「止点」语义对齐）。
- 置信度诚实原则：**连续值存储，UI 三档呈现**（高≥0.80 / 中 0.55–0.80 / 低<0.55），阈值落前端常量，换模型只调常量。

## Consequences（后果）
**正面**：①零服务器成本、零 GPU、零训练；②视频不出内网（隐私 + 涉密友好）；③首次加载约 18MB，浏览器缓存后复访零下载；④与既有提交链路完全解耦（候选独立数据层，AC-03）。
**负面**：①老机器（无独显 Chrome 单线程 wasm）推理慢 3–5×；②仅支持现代 Chrome/Edge（WebGL2）；③不保证类型准确（类型恒为弱建议「其他」）；④不支持移动端/小程序。
**风险与缓解**：手部出画/遮挡 → 段内检测缺失，速度取上一帧插值并降置信；快速动作合并 → 调小 `V_THRESH` 提升灵敏度、以召回优先（误切由 IE 在 I/O 阶段修）。

## 实测校验（`.temp-probe/run-probe.cjs` 真实 Chrome 155 实跑，2026-10-25）
设备：Windows 笔记本，8 核 / 8GB，Intel UHD 620 集显（典型工业 PC 无独显场景）。

- **冷启动**：GPU delegate 总计 **1867.6ms**（wasm 13.5MB 加载 836ms + 模型 7.82MB 262ms + 图构建 1856ms）；CPU delegate 兜底 919.9ms。一次加载，浏览器缓存后复访零下载。
- **单帧推理**：`detectForVideo` avg **47–50ms** / p95 63ms（集显）。drawImage 仅 0.05ms，可忽略。
- **抽帧**：seek 200ms 定步长 per-sample wall **60.6ms**（seek 59.5 + draw 1）。
- **推荐策略**：**seek 定步长 100ms（10Hz）确定性抽帧**，单帧 ≈ 110ms（抽帧+推理）。
- **预期分析时长**：集显 ≈ **视频时长的 1–1.5×**（30s 视频 ≈ 30–45s；独显快 3–4×；纯 CPU 兜底再 ×2）。非"秒出"，但零服务器成本、可接受。
- **已知限制**：探针内合成 2D 手形未被模型识别（假手不像真手，非产品问题）；真实视频手形 landmark 正常。检测准确率须经真实工位视频验证，一期 UI 不显示任何准确率数字（设计 §12 #2）。

> 时间戳陷阱：MediaPipe VIDEO 模式 `detectForVideo` 要求时间戳**严格单调递增**，用 `performance.now()` 跨段会回退报 `Packet timestamp mismatch`（探针首跑已踩，已用帧计数器修复）。真实切分代码**禁止**用墙钟，必须用帧序号 × 帧间隔。
