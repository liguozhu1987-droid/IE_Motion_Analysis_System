# Agent 工作规矩 · 编码 / 修复 / 回归（coding）

> 适用：功能实现、缺陷修复、重构、回归验证。
> 开工前先按 `handoff/明细/project_memory/README.md` §三 读完总入口，再进本目录。
> 完整工程纪律见 `handoff/04-规则与纪律.md` 与 `handoff/明细/project_memory/business_rules.md` §F。

## 一、动手前四问（未确认不动代码）

1. 业务口径是否与 `business_rules.md` 一致？
2. 本轮任务是否已记入 `todo.md` 与 `progress.md`？
3. `risk_log.md` 是否有相关已知风险 / 未决？
4. 本轮结论收口时要回写哪些文件？

## 二、改代码的高频硬约束

- **表结构唯一来源 `app/api/scripts/migrate.ts`**；改实体必跑 `npm run migrate:prod`
  + **真起 API**（dist 重建 ≠ 进程更新）；新实体注册 `database.module` ENTITIES；
  **布尔列不写 type**；实体 length/type 与 DDL 同步。
- **规则改 JSON 不生效**，必须 `POST /rules/:code/publish` 发布到 DB 并升 rv。
- **禁原生 `<select>`**：一律自绘 `SelectMenu` / `FilterSelect` / `TypeSelect`（portal + Flip）。
- React 钩子全在第一个条件 return 之前；受保护数据 `useEffect` 依赖 `user`。
- CSS 动画 `fill both` + `to` 含 transform → 恒等 matrix 成 fixed 包含层；浮层 `createPortal` 挂 body。
- `desc` 是保留字（裸 SQL 用 `[desc]`）；mssql 只认 `@0` 位置参数；裸 SQL 自行转义 `'`。
- 显式事务走 `BaseRepository.transaction`；聚合**必须在引擎计算前**过滤工位。

## 三、验证与回归

| 命令 | 用途 | 基线 |
|---|---|---|
| `npm run test:gate` | **统一门禁 fast**：类型检查 + 静态门 + 离线契约 + 隔离 smoke | 阻断 7/7 PASS（2026-11-18，`deliverables/gates/gate-report-20261119-070834.md`） |
| `npm run test:gate:full` | fast + 全部已迁移隔离套件 + 依赖审计（advisory，耗时更长） | 未在 0a 首轮跑 |
| `npm run test:eval` | AI 分解评测基线；无**人工**真值时 SKIP(78)，不得当 PASS | 0c 待填真值 |
| `cd app/api && npm run smoke` | 契约冒烟 | 147/0（经 `test:smoke:isolated` 双遍） |
| `node test/ai-waste-contract.cjs` / `ai-suggest-contract.cjs` | AI 双线 | 85/85、62/62 |
| `npm run test:task-scope` / `test:wave3:contract` | 任务归属 | 13/13+7/7、11/11 |
| `cd app/web && npm run test:css-classes` | CSS 类门禁 | PASS/0 |
| `npm run test:performance:isolated` | 容量与浏览器性能 | k6 50VU 0 错、LCP 1.082s |
| `npm run test:security:isolated` | 权限矩阵 + XSS | 125/125、11/11 |
| `npm run test:deps` | 依赖审计 | api **FAIL 10 high/1 critical**（未清零） |

- **隔离回归必须串行**；`test:smoke:isolated` 前后比 `app/api/storage` 指纹，
  同期跑 HTTP 契约（写 exports 快照）会让总判定 FAIL——守卫正常，不是代码缺陷。
- 正式库清库后仅余 ST010；**严禁 `npm run seed`**；缺 ST11 跑 `_setup-st11.cjs`。
- UI 测试禁并行；前置 `UPDATE t_ai_llm_profile SET enabled=0`，跑完置回 1 且整段连跑。
- 放宽断言须先说明「原期望为何错」并给 Spec 依据，不许直接改期望。
- **`progress.md` 只记实际输出（通过数/失败数），不写「应该通过」**。

## 四、生产 / 非生产分离（SKILL.md §3.3）

`app/`、`database/`、根配置为 `PRODUCTION`，不随手改；`tests/` 标 `TEST_ONLY`；
一次性脚本标 `DEBUG_OR_TEST_ONLY` 且不得被运行时导入；归档优先于删除。
清理冗余代码时**归档优先于硬删除**，且不得顺带重构运行时逻辑。

## 五、提交前

- 说明分支、是否已提交、未提交内容；本仓库存在 **仅 1 提交、大批文件未提交** 的风险（R05）。
  未提交数随新增文件变化（95/96/98 均为快照），**不得拿数字当完成判据**；0b 以
  `git status --porcelain` 为空 ＋ 已打 tag ＋ tag 含 `scripts/gates/` 为准。
- 不可逆 DB 变更（加列、回填、改唯一键）须**逐项确认**后执行。
