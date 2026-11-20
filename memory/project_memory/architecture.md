# 技术架构（architecture）

> 长期事实。整理：2026-11-18。完整导航见 `docs/CODE-WIKI.md`；本文件只记「决定改动的那些约束」。

## 1. 栈与拓扑

```
浏览器 React19 SPA(hash 路由·React.lazy) ─ /api ─ IIS ARR(未落地) ─ NestJS10 :3001
   │                                                    │
   ├─ MediaPipe/帧差 浏览器端推理（视频不上传）        ├─ 守卫链 Jwt→Tenant→Permissions
   └─ 本地 object URL / 视频文件 Range 206            ├─ 15 业务模块 + core/rules(@Global)
                                                      └─ SQL Server CN_AME + CMC(只读) + storage/
```

| 层 | 选型 | 关键约束 |
|---|---|---|
| 前端 | React 19 + Vite 6 + TS，手写 hash 路由（`App.tsx:parseHash`），SVG 手绘图表 | 无 router/状态/图表库；`WorkbenchPage.tsx` 3081 行为事实上的大单体，宜局部拆不宜重写 |
| 后端 | NestJS 10 + TypeORM 0.3 + Express，端口 3001 | 全局 `ValidationPipe whitelist:true`（DTO 每字段必须有装饰器）；错误信封业务字段顶层透传 |
| 数据 | SQL Server 17 `CN_AME`（生产 `synchronize=false`）/ sqlite（开发 `synchronize=true`） | `app/api/scripts/migrate.ts` 幂等 DDL 唯一来源；**无 down 脚本**；`desc` 保留字用 `[desc]` |
| 规则 | JSON 文件 + DB `t_rule_set` 双源，DB 优先 | `RulesService.getActive(code)`；`POST /rules/:code/publish` 才生效；响应带 `rule_versions` RV 快照 |
| 认证 | JWT 双令牌（access 内存 15min / refresh localStorage 7d）+ 可选 OIDC | 401 单航班刷新重放；refresh 一次性轮换 + 重放检测（测试注入 token 须条件化） |
| 视频 | ffmpeg 6.1.1 本地二进制 + 派生缓存 worker | 场景切分零 LLM；`<video>` 无 Authorization → `@Public()` + `?token=` |

## 2. 计算口径的落点（决定改动面）

- **`app/api/src/modules/analysis/engine.ts`（284 行，规则注入式纯函数）** 是唯一口径落点：
  `classifyElements:40-66` 出 `va_effective/va_confidence/va_reason/rule_id`；
  `detectWastes:84-137` 出 `waste/basis/involved_s/pct/evidence/element_ids`；
  `analyzeStation:190-216` 的 CT 与 VA/RNVA/NVA 占比**基于 `std_time`**；
  `:195` 已按低置信度生成 `pending` 复核队列（注意：这是 **VA 归类**置信度，与 AI 边界置信度不可混用）；
  `handsChart:163-179` 用 `rows={L,R,B}`，B 独立成轨（全 B 时退化的根因）；
  `buildLineAnalysis:229-284` 平衡率/瓶颈/Top5 排序。
- **`app/api/src/entities/improvement.entity.ts:14-29`** 已有 `waste_type/method(ECRS)/est_save_s/
  status(待实施|已完成|已验证)/before_ct/after_ct/source(rule|ai)/ai_suggestion_id`
  → **改善闭环骨架已存在**，缺的只是「浪费触发器→自动建项」「复测回填 after_ct」两条接线。
- **`app/web/src/ai-segment/`（确定性规则，非 LLM）**：hand 检测器 `segmentation.ts:79,140` 用
  `median(confs)` 定 conf；默认 motion 是 0.9 起规则扣分（**非 median**，`motion.ts:384-397`）。
  候选层**有** `start_ms/end_ms`（`types.ts:16-17`），但落库时 `AiSegmentPage.tsx:661-672` 用 cursor
  从 0 重排、`:693` 写死 `video_id='ai-segment'` → 丢源视频基准、审计链断（已列 P0，见 todo §七）。
- **两套时间轴未对齐（风险）**：`ai-segment/landmark.ts:148` 用 `frameIndex*SAMPLE_MS` 单调计数器；
  `video/useVideoEngine.ts:70` 用 `round(currentTime*fps)`。任何「源帧回溯/逐帧打分」都建在这条链上，
  VFR 或非 all-intra 代理视频会静默指错帧（见 `risk_log.md` R11）。

## 3. 改动成本三档（2026-11-18 架构评审结论）

| 档 | 内容 | 可逆性 |
|---|---|---|
| **零 DDL**（前端/服务层派生） | 帕累托排序、改判证据写 `t_audit_log`、改善闭环接线、SOP 步骤导出、候选按 conf 排序、山积图只读沙盘、点数字跳源帧 | 全可逆，还原构建即回滚 |
| **仅规则集发布**（零 DDL） | TIMWOODS 归因映射、工效学评分表、阈值调整 | 可逆（发布回上一版）；**硬条件：必须 publish 升 rv**，只改 JSON 不生效 |
| **需迁移** | 置信度/证据链/样本统计持久化、全 B 拆手、PMTS 双轨列 | 加可空列/新表可逆；**改 `hand` 语义、改 `std_time` 口径、对外 ±x% 声明不可逆**，须逐项确认 |

任何迁移：`migrate.ts` → `database.module.ts` ENTITIES 注册 → `npm run migrate:prod` →
**真起 API**（dist 重建≠进程更新）→ MSSQL 与 sqlite 双端各验（方言差异曾致回归失败）。

## 4. 不可动摇的三套约束（推倒重来要重付的代价）

1. **权限唯一口径** `stations.service.resolveVisibleStationIds()`；聚合**必须在引擎计算前**过滤工位，
   否则 `balance_rate/totals/bottleneck` 仍是全线值（v3.59.2 曾跨租户串号）。
2. **三铁律**：`ai/output-sanitizer.ts` 剥 LLM 数字 + `ai-suggest/calculator.ts` 服务端重算 +
   AI 建议恒待审 + 模拟值不回写正式 ST。
3. **双源 DDL + 单一事实源**：`migrate.ts` 唯一、规则 DB 优先、CMC SELECT-only。

## 5. 进程内状态（上线前须知）

登录限流桶、dashboard TTL 缓存、告警 firing 状态均在**进程内**，单实例有效；
IIS ARR 后若扩多实例须外置。当前无 CI、无 down 脚本，回滚只能靠备份。

## 6. 回归门禁执行器（2026-11-18 落地）

```
npm run test:gate            # fast：类型检查 + 静态门 + 离线契约 + 隔离 smoke
npm run test:gate:full       # fast + 全部已迁移隔离套件 + 依赖审计（advisory）
npm run test:eval            # AI 分解评测基线（无人工真值时 SKIP=78，不是 PASS）
```

- 唯一执行器 `scripts/gates/run-gates.cjs`，清单 `gates.config.cjs`；**严格串行**（隔离/UI 禁并行）。
- 阻断门（blocking）决定退出码；advisory 只记录。`SKIPPED` 不计为 PASS，且阻断门全 SKIP 时判未执行。
- 报告落 `deliverables/gates/gate-report-<时间戳>.json|.md` + 逐门日志；含 HEAD、分支、未提交数、tag，
  保证基线可追溯（对应 P0-0 的「哪个 commit + 哪个 DB rule_set version」另一半靠 `rule_versions`）。
- `repo:traceability` 把 0b 三项判据固化为门：工作区干净 + 已打 tag + **存在一个 tag** 含 `scripts/gates/` 全部文件
  （不要求 tag 永远停在 HEAD，基线后补文档提交不影响追溯）；
  日常跑门禁忽略 `deliverables/gates/` 产物，0b 验收必须用严格模式。
- 评测门 `run-eval-gate.cjs` 要求**人工**真值（模板占位/测试夹具一律 SKIP），输出结构化
  `ai-segment-eval/v1` JSON（`deliverables/gates/eval/latest.json` 为可比对的上一版指针）。
- 仍无 CI；门禁目前是本地单命令，接入 CI 属解禁路径第 ⑤ 步。
