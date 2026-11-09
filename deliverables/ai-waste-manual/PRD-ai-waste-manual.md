# 增量 PRD：分解工作台「AI 自动识别浪费」（手工分解线）

- Language: 简体中文
- Programming Language: NestJS 10 + TypeORM + React 19 + Vite 6 + TS（既有栈，无新增）
- Project Name: ie_improvement_platform（增量模块 ai-waste-manual）
- 原始需求复述：在分解工作台中实现动作要素手工分解完成后的 AI 自动分析与建议——新增「AI自动识别浪费」按钮触发分析；AI 依据已定义的非增值要素（RNVA/NVA）识别浪费并生成问题识别清单；结合非增值要素、较大移动距离及操作异常点制定改善措施建议；基于现有 ai-waste 方案补全，输出结构化问题清单与优化建议。

## 1. 背景与目标

ai-waste 模块（v3.40，P3-9）已上线「AI 自动分解线」的浪费识别，但只处理 `source='ai_assisted'` 要素，手工分解工位被 400 挡回。本次补全「手工分解线」：工作台新增按钮，一键对已提交的 manual 要素跑同一套识别引擎，产出结构化浪费清单与改善建议。

产品目标：
1. 手工分解完成即得 AI 浪费识别，不需切页签手动操作（按钮一步触发）
2. 识别信号覆盖 RNVA/NVA 非增值要素 + 移动距离代理信号 + 操作异常点
3. 结果 100% 复用现有 AiWastePage 与 t_ai_waste_* 三表，零新建数据模型

## 2. 用户故事

1. 作为 IE 工程师，我在工作台手工分解完要素并提交后，想点「AI自动识别浪费」直接得到浪费点清单，以便不用凭肉眼逐条找浪费。
2. 作为 IE 工程师，我想看到每条浪费都引用了具体要素序号和证据，以便判断 AI 说得对不对。
3. 作为 IE 工程师，我想对认可的改善建议点「确认」直接进改善台账（t_improvement），不认可的忽略，以便全程留痕可审计。

## 3. 需求池

### P0（必须有）

| # | 需求 | 验收标准 |
|---|---|---|
| P0-1 | 后端新增端点 `POST /stations/:stationId/ai-waste/generate-manual`（权限 `suggestion:generate`，独立控制器方法，不改现有 `generate` 契约） | ① 无权限 403；② 无 manual 要素返回 400 且文案为「当前版本没有手工分解要素（source=manual）」；③ running 中 409；④ 同版本已有成功批幂等 200 带 `idempotent_hit`；⑤ 契约测试 manual 用例通过且 AI 线 53/53 不回退 |
| P0-2 | 要素装载 manual 化：新增 `loadManualElements`（按 `source='manual'`、`outlier_flag=0` 过滤当前版本），CT=manual 子集 Σstd_time，批次 `element_source='manual'` | ① 混合工位只取 manual 子集；② CT 与前端 stats 中 manual 部分一致（±0.01）；③ batch.element_source 落库 'manual'，latest/batches 返回可见 |
| P0-3 | Prompt 适配（prompt.ts）：`buildWasteUserPrompt` 增加 decomposition_source 参数，首行措辞随源切换（「要素由手工分解写入」）；新增「异常点提示」上下文段（outlier 要素 seq/type/desc/reason，明示仅作线索、不得引用）；`prompt_version` bump（WV2）并随批落库 | ① 手工线 LLM 输入含异常点段；② 引用 outlier seq 的 finding 被 W1.3 拦截；③ 新批 prompt_version=WV2，旧批 WV1 不变 |
| P0-4 | 工作台顶栏按钮「AI自动识别浪费」：置于 `wb-top-acts`「复用要素」之后（v3.33 AI 切分按钮同址先例），权限 `suggestion:generate`（无权限不渲染），`submitted` 态外置灰（title 说明「请先提交分解」） | ① 无权限用户 DOM 无此按钮；② 未提交/提交失败时 disabled；③ 提交成功后可点 |
| P0-5 | 点击流程：POST generate-manual → 按钮转「分析中…」禁用 → 200 弹 toast「识别完成：N 个浪费点 / M 条建议」+「前往浪费识别 →」链接（`#/ai-waste/:stationId`）；409 弹「已有识别任务进行中」+ 同链接；错误码 toast 透传文案 | ① 成功后 blur 回 body（提交类动作焦点策略）；② 链接跳转后 StationTabs 第 6 页签展示本批结果 |
| P0-6 | 结果呈现复用 AiWastePage：findings 表（waste_type/severity/involved_s/pct_of_ct/element_seqs/evidence）+ issues 表（ecrs/suggestion/est_save_s/priority/tier）+ 确认/忽略；页头增加 `element_source` 标识与 version 展示 | ① 确认进 t_improvement（source='ai'、imp_id 溯源）复用现有 settle，零改动；② issues 恒为「待处理」，无直接执行按钮 |
| P0-7 | 结构化清单口径：findings/issues 的 `element_seqs` 必须引用 manual 主表 seq，数字字段（severity/involved_s/pct/est_save_s/priority/tier）全部服务端重算 | ① W1.3 防幻觉对 manual 线生效；② 响应体无 LLM 产数字 |

### P1（应有）

| # | 需求 | 验收标准 |
|---|---|---|
| P1-1 | 草稿脏检查：提交成功后任何草稿变更（增/删/改/复用/清空）令 `submitted` 复位，按钮与结果入口同步置灰/隐藏 | ① 提交后改 1 条要素再提交前按钮不可用；② 顺带修正现有「查看分析结果 →」链接的同款不一致 |
| P1-2 | 批次历史（batches）与 latest 按 element_source 可区分展示，避免两线清单混淆 | ① 前端可见「手工分解/AI 分解」来源标签 |
| P1-3 | 识别结果摘要卡片：浪费类型分布（6 类计数）+ 预计总节省 Σest_save_s 与占 CT 比 | ① 数字均由服务端字段汇总，前端零计算口径分叉 |

### P2（可延后）

| # | 需求 | 验收标准 |
|---|---|---|
| P2-1 | 工作台内右下角 portal 抽屉内嵌结果（不跳转），作为 A 方案的补充入口 | 不破坏单屏 100vh-48px 布局 |
| P2-2 | 混合工位双源清单对比视图（manual 批 vs ai_assisted 批并列） | 只读，不改任一来源数据 |

## 4. 边界铁律

**继承项（跨会话有效，本次全部延续）**
1. AI 三铁律：① 建议永远待审，确认才进 t_improvement；② LLM 禁产数字，定量结论服务端重算；③ 数据质量靠校验（W1-W3）+ 审计（validation_trace 落库）。
2. 与 ai-suggest（AI 建议）模块相互独立，不得合并；ai-waste 内部两线（manual / ai_assisted）端点、批次、幂等相互独立，互不 fallback。
3. 工作台铁律：不重构已打磨的单屏工作室；浮层一律 createPortal 挂 body；提交类动作后 blur 回 body。
4. 权限模型：按钮与接口均按 `suggestion:generate` 控制，无权限不发请求。

**本次变更项**
5. 「较大的移动距离」产品口径（不新建字段，三条代理信号）：① 移物要素 `dur_s>=2`（WT05 搬运阈值，时长即距离代理）；② desc 自由文本中的距离信息（motion_standard MS1.1「移物 +对象 +距离」「走动 +距离」格式）作为 LLM 证据文本进入 prompt，服务端不做距离数字解析；③ 同描述移物计数 ≥2（WT03，暗示往返）。理由：t_element 无结构化距离字段，新建字段将触发全模块迁移，违背「工具做薄」哲学；时长+文本已是现有规则体系（RV1.1）的既定代理口径。
6. 「操作异常点」口径：`outlier_flag=1` 要素（含 outlier_reason）作为 prompt 异常点上下文段进入 LLM 视野，但**不参与** CT 计算、不进入 finding 引用候选集（被 W1.3 自然拦截），与 waste_triggers「只扫 outlier_flag=0」口径一致。
7. CT 口径：manual 线 CT = 当前版本 manual 子集 Σstd_time（与 AI 线对称，按源各自独立，不合并）。

## 5. 交互草案

**方案 A（推荐）：顶栏按钮 + 跳转第 6 页签**
- 按钮在 `wb-top-acts`「复用要素」后；点击后按钮 loading、toast 摘要 + 「前往浪费识别 →」链接跳 `#/ai-waste/:stationId`；结果完整呈现在既有 AiWastePage。
- 优点：零新结果面板，不碰 2503 行工作台布局；AiWastePage 22/22 测试全绿直接复用；与 AiSegmentPage 写入成功提示「直接运行浪费识别」先例同构；单屏铁律不破。
- 缺点：需一次页面跳转。

**方案 B：工作台内嵌抽屉**
- 右下角 portal 浮层内嵌结果组件，不跳转。
- 优点：少一次跳转。缺点：工作台再挂一整套结果态与确认交互，违背「不改已打磨的工作台」；窄屏表格体验差；settle 交互要重接。

**推荐 A。** 后续如需减少跳转，以 P2-1 抽屉作补充入口，不替换 A。

## 6. 非目标

- 不新建距离/异常结构化字段，不改 t_element 模型与 va_rules
- 不合并、不改动 ai-suggest 模块与 ai-waste AI 线现有端点契约（53/53 契约测试不回退）
- 不改 W1-W3 校验引擎、打分器（est_save_s/priority/tier 口径两线共用不改）
- 不做实时/流式识别、不做多工位批量识别、不做跨版本对比
- 不在工作台内新建结果表格（P2-1 抽屉除外）

## 7. 待确认问题

1. **混合工位**（manual + ai_assisted 并存）：工作台按钮只分析 manual 子集，AI 线端点只分析 ai_assisted 子集，两清单分开呈现。默认建议如此（版本/来源隔离哲学）；若业务要求合并视图，转 P2-2。
2. **outlier 要素进 prompt**：默认建议进（作异常点线索，不可引用、不计 CT）；若担心提示词被污染，可降级为仅在 finding evidence 外的工作台侧提示。默认取前者。
3. **prompt_version bump**：WV1→WV2（措辞+异常点段变化）。默认建议 bump，保证历史批溯源；若希望旧批新批同版复用，则不加异常点段（退化为仅改措辞）——不推荐。
