# DW_PENDING_WASP · 双线隔离落地实施规格

> 生成日期：2026-10-27
> 基于：`deliverables/双线边界隔离审计报告.md`
> 状态：待批准 —— 未经批准不执行任何写库命令
> 粒度：一个修复一个 commit，独立可回滚，全部完成后跑一次全量回归

---

## 0. 执行铁律

| # | 铁律 | 理由 |
|---|------|------|
| 1 | 每个修复独立 commit，可单独 revert | 止血时可能需要只撤其中一个 |
| 2 | 修复之间不夹带其它改动 | 保持回滚基线干净 |
| 3 | 不改任何 entity / 字段 / withProperty / relations / DataSource / BaseRepository | 已实测租户安全依赖 `base.repository.ts:21-24` 与 `:47-49` |
| 4 | 回归必须单次一条产品或 dev 环境，不能并发套跑 | 防 JS 数据竞争导致假失败 |

---

## 1. Fix 1 — 修 P0-B1（source 贯通）

**根因**：手工线回写不带 source 字段，后端兜底成 manual。
**第二个等价入口**：CSV 导入走同一个无差别 delete（elements.controller.ts:34-38，仅 element:write），会把 AI 版本物理销毁后重建为 manual。

**改动面（有显式 source 意图的构造点，仅此四处）**

| 文件 | 位置 | 改动 |
|------|------|------|
| `web/src/pages/WorkbenchPage.tsx` | buildPayload（约 1148-1174） | 从 e-j 取材点时带上 `source`；无 source 或不是 ai_assisted 则为 manual |
| `web/src/pages/AiSegmentPage.tsx` | 写入载荷构造（约 641-646） | 确认带 `source: 'ai_assisted'`（现状已带，必须保留，不能为了统一而删） |
| `web/src/pages/AiSegmentPage.tsx` | 约 664 | 若现有要素为空，也必须走「封存再开新版」，不能跳过直接写当前版本 |
| CSV 导入相关前端构造点 | WorkbenchPage.tsx 约 1231-1237 | 与 buildPayload 同口径带上 source |

**关键前提（已核实，后端零改动）**：
- `api.ts:995` 的 `SubmitPayload.elements[].source` 契约层本来就存在
- `dto.ts:23` 已声明 `@IsOptional source?: 'manual' | 'ai_assisted'`
- `elements.service.ts:105` 已实现「有 ai_assisted 就保留」

**验收**：手工线回写后，AI 要素的 source 保持 ai_assisted，不被翻转为 manual；CSV 导入同理。

---

## 2. Fix 2 — 修 P0-B5（禁止手工线删除 AI 版本）

| 文件 | 位置 | 改动 |
|------|------|------|
| `api/src/modules/stations/stations.service.ts` | cancelRetest（487-497） | 删除前先统计当前版本 `source='ai_assisted'` 的要素数，大于 0 则抛 409 冲突并要求显式接管；等于 0 则维持原逻辑 |
| `api/src/modules/stations/stations.service.ts` | startRetest（451-462） | **同样加守卫** —— 已实测此处也会清掉当前版本要素，是容易漏掉的第二条路 |

**验收**：
1. 直接调用 DELETE 接口绕过 UI → 期望 409，AI 版本仍在
2. 直接调用 POST 开版接口 → 期望 409
3. 纯 manual 版本作废复测仍正常

---

## 3. Fix 3 — 修 P0-B6（四个写端点接资源级权限）

在四个 handler 首行各加一句守卫。

| 文件 | 位置 | 现有取当前用户方式 |
|------|------|------|
| `api/src/modules/elements/elements.controller.ts` | submit | 已有 `@CurrentUser() user: AuthUser` |
| `api/src/modules/elements/elements.controller.ts` | import | 同上 |
| `api/src/modules/stations/stations.controller.ts` | POST 开版 | 已有 `@Req() req: AuthedRequest` |
| `api/src/modules/stations/stations.controller.ts` | DELETE 作废 | 同上 |

**成本极低的原因（已实测）**：`auth/auth-user.interface.ts` 的 AuthUser 接口本身就含 `userId` 与 `roles`，与 `assertWritable(id, userId, roles)` 签名完全匹配，零签名改动、零 DTO 改动。

**验收**：
1. 非拥有人、非协作者的 IE 工程师打这四个端点 → 403
2. **正向**：拥有人本人操作 → 200（防止修复过度锁死合法用户）
3. `assertWritable` 调用点从 2 处增至 6 处，原有两处不动

---

## 4. Fix 4 — 补并发回归（P1-B3）

新文件 `app/web/test-dw-isolation-source-contention.cjs`，可复用 `test-wb-waste-btn.cjs` 的骨架。

需覆盖：
- 同工位 manual 与 ai_assisted 两条线并发触发，期望各建一批、互不合并、互不复用失败批、互不 409
- 手工线接管路径与 AI 线提交并发，期望两条批次行共存，五列唯一索引不被撞
- API 层重提交（而非 UI 层），补现有用例只测 UI 清空的缺口

---

## 5. Fix 5 — 重提交后补来源断言（P1-B4）

在 `app/web/test-wb-waste-btn.cjs` 的重提交与批量套用两处之后，各补一条数据库断言：

```sql
SELECT source, COUNT(*) FROM t_element
WHERE station_id = ? AND bol_version = ? GROUP BY source
```

断言 AI 要素计数不降为 0，且 source 仍为 ai_assisted。

---

## 6. 回滚

每个 commit 独立 revert，不要批量回滚：

```bash
git revert <sha>
```

---

## 7. 待批准事项（写操作，需你点头）

| # | 事项 | 说明 |
|---|------|------|
| R1 | 批准执行 Fix 1 至 Fix 5 | 每个独立 commit，附带自验证 |
| R2 | 批准跑全量回归 | 前后端测试全套，遵守单进程纪律 |

未批准则维持本次只读交付。
