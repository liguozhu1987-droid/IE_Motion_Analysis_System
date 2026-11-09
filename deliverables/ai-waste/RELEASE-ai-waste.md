# P3-9 交付报告：浪费识别 + 改善问题清单自动生成

**日期**：2026-10-26 ｜ **看板**：#94 ｜ **状态**：✅ 全部完成

## 0. 边界铁律（用户四条要求，全程遵守）

1. 本功能属于 **AI 自动分解层面**的应用，与分解工作台（手工分解界面）已开发的 AI 改善建议功能（ai-suggest 模块）**明确区分**——两者是**相互独立的模块**
2. 不将 P3-9 与工作台 AI 建议功能合并处理
3. 二者对应视频分解方式不同（AI 自动分解 `source='ai_assisted'` vs 手工分解 `source='manual'`），按分解方式**分别独立管理**，暂不整合
4. 浪费识别与问题清单生成均通过调用系统 AI API 模型（LlmGatewayService）实现

**隔离证据**：
- 后端：`app/api/src/modules/ai-waste/` 全新模块，**零 import** ai-suggest 的 service/validator/calculator（仅复用平台公共基建：LlmGatewayService、t_ai_setting 配置、AnalysisService、浪费白名单口径）
- 数据：独立三表 `t_ai_waste_batch / t_ai_waste_finding / t_ai_waste_issue`（与 ai-suggest 三表完全无外键交叉）
- 校验：独立 W1-W3 引擎（ai-suggest 用 R1-R3，互不引用）
- 打分：独立口径（见 §2）
- 前端：`AiWastePage.tsx` 独立 chunk（11.24KB），样式全 `aw-` 前缀零耦合；**分解工作台一行未改**（WorkbenchPage 98.08KB 与 v3.34/v3.37/v3.38b 完全一致）
- 数据入口天然隔离：只处理 `outlier_flag=0 && source='ai_assisted'` 的要素

## 1. 后端实现（app/api/src/modules/ai-waste/）

| 文件 | 职责 |
|---|---|
| entities ×3 | batch（批次）/ finding（浪费点）/ issue（问题条目，审前态） |
| validator.ts | 独立校验引擎 W1-W3，`checkWastePayload` 返回裁决+轨迹 |
| prompt.ts | WASTE_SYSTEM_PROMPT（单调用双产出）+ `extractJsonObject` |
| dto.ts | settle DTO（status ∈ 已确认/已忽略）|
| service | generate / latest / listBatches / settle / cascadeDeleteByStation |
| controller | 4 端点，权限 `suggestion:generate` |
| module | imports AnalysisModule，exports AiWasteService |

### 四端点

| 端点 | 行为 |
|---|---|
| `POST /api/stations/:id/ai-waste/generate` | 一次 LLM 调用同时产 findings+issues → W1-W3 校验 → 服务端打分 → 落库 status=done；最近成功批幂等 200（idempotent_hit）；running 409；LLM 不可解析 503（failed 批可重开） |
| `GET /api/stations/:id/ai-waste/latest` | 最新批次视图（findings+issues+元信息），无批 → null |
| `GET /api/stations/:id/ai-waste/batches` | 批次历史（只读溯源） |
| `POST /api/ai-waste/issues/:id/settle` | 已确认 → 复制为 t_improvement（source='ai'，ai_suggestion_id=issue_id 溯源，状态「待实施」）；已忽略 → 终态；非待处理 409 |

### W1-W3 独立校验引擎

- **W1**（输入层）：W1.1 Schema / W1.2 动态白名单（RulesService waste_triggers+ecrsa_map）/ W1.3 **seq 引用防幻觉**（引用不存在要素的条目裁剪，部分无效保留有效）/ W1.4 文本长度 / W1.5 去重
- **W2**（语义层）：W2.1 **VA 禁 E**（增值动作不能「取消」）/ W2.2 ECRS 语义解析（「取消」→E 等中文动词映射）/ W2.3 suggestion 长度
- **W3**（全局层）：W3.0 CT≤0 整批阻断 / W3.1 单要素 ≤2 条 / W3.2 findings≤30、issues≤12 上界

### 独立打分口径（区别于 ai-suggest）

- `est_save_s`：E = ΣST **全额**；C/R/S = ΣST × **0.5 保守折算**
- `priority`：est_save_s / CT 占比归一化 ×100
- `tier`：P1 ≥40 / P2 ≥15 / P3 <15
- `severity`：pct_of_ct ≥15% 严重 / ≥8% 一般 / 其余轻微
- **LLM 禁产数字**：AI 返回的 involved_s / pct_of_ct / severity 全部剥除，服务端按 ST 重算

### 数据与级联

- 三表 DDL + 2 索引（idx_ai_waste_batch_station / idx_ai_waste_issue_batch）进 migrate.ts（23 表）
- `stations.service.remove()` 级联链挂 `cascadeDeleteByStation`（先 finding/issue 后 batch），工位删除零 500
- element_refs 存 seq 逗号串（AI 要素随 submit 整版重排，seq 同版本内稳定）

## 2. 前端实现（app/web/）

- `StationTabs` 第 6 页签「浪费识别」（`#/ai-waste/:stationId`，权限 suggestion:generate）
- `AiWastePage.tsx`（aw- 前缀独立 chunk 11.24KB）：生成卡（版本/要素数/开始识别）+ 浪费点表（severity 三档徽标 + pct_of_ct 占比 + 证据）+ 问题清单卡片（ECRS 徽标 + tier + 待处理/已确认/已忽略流转 + 确认二次弹窗）+ 批次历史展开
- `Breadcrumb` 中文映射；`api.ts` 新增 aiWaste 组
- `AiSegmentPage` 写入成功提示加「前往浪费识别」衔接（不改工作台一行）

## 3. 验证结果（全绿）

| 测试 | 结果 |
|---|---|
| 契约 test/ai-waste-contract.cjs（mock 网关全链 53 断言） | **53/53** |
| UI test-ai-waste.cjs（mock 网关 + 真实浏览器全链） | **22/22** |
| v337 AI 分解页回归 | **18/18** |
| 上传链路（真实 HEVC 视频，直通播放 + 分析 16s/7 候选） | 通过 |
| ai-suggest 契约（相邻模块零破坏） | **62/62** |
| tsc（前后端）+ vite build | 零错；AiWastePage 11.24KB 独立 chunk；**WorkbenchPage 98.08KB 不变** |

**契约覆盖要点**：生成→数字剥除重算→白名单剔除→VA 禁 E 拦截→seq 防幻觉→幂等→状态流转→t_improvement 落库→权限 403→无 AI 要素 400→失败批次 503→W1-W3 纯函数抽测。
**UI 覆盖要点**：生成→徽标渲染→确认（改善任务落库 AIW 尾缀）→忽略→批次历史→幂等命中不调 LLM→零 JS 异常。

## 4. 实现期五坑（勿重蹈）

1. **BaseRepository 是抽象类**（entityTarget 直接抛错）——不能裸 new，须按 ai-suggest 模式定义 entityTarget 子类
2. **migrate 建表 ≠ TypeORM 认识实体**——三实体必须注册进 database.module entities 通配（漏注册报 `No metadata for "AiWasteBatch"`，且改完必须重启 API）
3. **W3.2 上界测试场景设计**：双 seq 环形配对会让 distinct seq 计数提前饱和、被 W3.1 先裁——单 seq 轮转才能精确触发 W3.2
4. **UI 测试竞态**：settle 成功 banner（setMsg 同步渲染）先于 load() 重拉完成——等 banner 再读卡片拿到旧状态；必须等**卡片 tag 真正翻转**
5. **React 重渲染替换 DOM 节点**使 ElementHandle 变 detached、点击静默失效——点击后等 DOM 状态，不缓存句柄

## 5. 当前服务态与遗留

- 服务态：t_ai_setting 测试后已清空（回落 env，默认关）；测试工位/批次/改善残留已由脚本 finally 清理
- PA10 保留 136 条 AI 要素（v3.39b 压测产物），可作为浪费识别真实演示数据
- 真实 LLM 端到端：与 ai-suggest 同样待用户在「AI 配置」页填真实 Key 后即可直接使用（网关/提示词/校验链已就绪）
- 后续候选（未排期）：AI 分解页与浪费识别页的双向跳转增强、批次对比视图
