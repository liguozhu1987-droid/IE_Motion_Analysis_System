# v3.42 交付报告：工位增删改查 + 个人工作台（归属 / 隔离 / 共享协作）

日期：2026-10-26 ｜ 状态：✅ 全部完成，全套回归绿

## 用户决策（四项，已全部落地）

| # | 决策 | 落地方式 |
|---|------|----------|
| 1 | 普通用户可看集团看板，改名「综合看板」 | seed 全角色加 `group:read`；全站改名（顶栏/面包屑/空态）；**租户边界收口**（见下） |
| 2 | 删除工位权限仅 owner + admin | 前端按钮双重判定 + 后端 `assertWritable` 403 兜底（ie1 删 owner 工位 403 实锤） |
| 3 | 产线级共享 P3 一并做，按行业最佳实践 | `t_line_share` 产线级批量授权（grantor 名下产线 → grantee editor/viewer），ShareDialog「整线共享」tab |
| 4 | 存量工位一律归属 created_by | 迁移回填 `owner_user_id = ISNULL(created_by, 按租户 seed 映射)` |

## 数据模型（migrate.ts 增量，幂等）

- `t_station` 加 `owner_user_id NVARCHAR(32) NULL` + 唯一约束 `UQ_station_owner_name(tenant_id, owner_user_id, name)`
  —— 跨用户允许同名（用户A/B 都可建「SHFA1线PA10」），同名场景 UI 用 `@拥有人` 徽标消歧
- 新表 `t_station_collaborator`（工位级 editor/viewer 授权，granted_by/at）
- 新表 `t_line_share`（产线级批量授权）

## ACL 双层模型

RBAC 25 权限点/5 角色不动；新增资源级判定，最终可操作性 = RBAC × ACL 交集：

- **读可见** `filterVisible`：全权角色（sys_admin/ie_admin）全量；普通用户 = 我的 + 共享给我（工位级 ∪ 产线级）
- **写校验** `assertWritable`：owner / editor 协作者 / 产线级 editor / 全权角色，否则 403
- 接线：GET /stations → `listVisible`（含 owner_name 批量 enrich）；PATCH/DELETE → assertWritable；POST → owner = 操作人 + 同归属人重名护栏

## 前端（StationListPage / ShareDialog / CreateStationWizard）

- **视角页签**：我的（N）/ 共享给我（N）/ 全部（N，仅 admin）；页头标题随视角切换（我的工作台/共享给我/产线总览）
- **卡片操作**：分解/分析/对比/导入/导出 + 新增 共享/编辑/删除（仅 owner+admin 且 station:write）
- **删除**：自建确认弹窗（列级联影响：全部版本要素/改善记录/协作者授权）→ 确认后级联删除
- **ShareDialog**：本工位协作者 + 整线共享双 tab；候选用户 = 本租户 active 用户（`GET /stations/share-candidates`，无需 user:read）
- **编辑模式**：向导复用，仅名称/TT 可改（编码是全链引用键、产线来自 CMC 均锁定）
- **改名**：集团看板 → 综合看板（App 顶栏/面包屑/DashboardPage/StationListPage 全部命中点）

## 关键回归修复：SEC-13 跨租户隔离（critical → 0）

决策 1 把 `group:read` 开放全角色后，baseline 套件 SEC-13 首次真正进入 dashboard 查询，
暴露 `resolveScope` 无调用者租户约束（原设计仅 sys_admin 持有该权限，跨租户聚合是特性）。

修复：`/dashboard/summary` 与 `/dashboard/improvements` 对非全权角色 **锁定本租户聚合**
（`resolveScope` 加 tenantScope 下推；缓存键按 scope 分区 `ALL` vs `tenantId`，互不串味）。
验证：other1 仅见 OTHER 租户；admin 保留跨租户。

## 测试结果

| 套件 | 结果 |
|------|------|
| smoke（API） | 143/143 ✅ |
| integration | 31/31 ✅ |
| change-pwd | 7 步全过 ✅ |
| auth-management | 48/48 ✅ |
| perf-security baseline | critical=0 high=0 ✅ |
| ai-suggest contract | 62/62 ✅ |
| ai-waste contract | 53/53 ✅ |
| **test-v342.cjs（新增 UI）** | **19/19 ✅** |
| test-v341 UI | 20/20 ✅ |
| test-ai-segment UI | 30/30 ✅ |
| test-ai-waste UI | 22/22 ✅（L01-ST33 自建自清适配） |

test-v342 覆盖：三账号视角（viewer 只读/ie1 协作者/admin 全量）、按钮 ACL、删除全链
（弹窗→确认→级联→卡片消失）、共享授权 UI→落库 API 回验、编辑弹窗、综合看板改名。

## 库终态

演示工位 5 个（L01-ST01/ST02、L02-ST01 隔离验证、PA10/PA20 CMC 演示），
owner 映射干净，0 测试残留，协作者仅 seed 演示授权（L01-ST02→ie1 editor）。

## 遗留与建议

- 「共享给我」列表目前只认 `owner_user_id` 非我（协作者/整线授权服务端可见性已并入同过滤链，UI 计数一致）
- 方案 B（workspace 空间模型）为未来演进方向，方案 A 是其子集可平滑升级
- 后续候选：audit:read 审计页、共享通知、协作者操作审计日志
