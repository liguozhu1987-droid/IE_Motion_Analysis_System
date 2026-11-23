---
tags: ["冒烟","回归基线","生产库副作用","待确认"]
status: pending
date: 2026-11-22
source-agent: Claude (Opus 5 / Sonnet 5 会话)
target-agent: 下一个接手 Agent
---

# 交接单：T4 冒烟基线（139/8）与两个待决策

## 项目目标

把 `npm run smoke` 跑成稳定基线，作为后续改动的回归门；并清理冒烟对生产库造成的副作用。

## ✅ 已完成 & 已确认事实

- 生产库已补齐到 **33 张白名单表**（`migrate:prod` 成功；期间修复了 `migrate.ts` legacy 任务回填在多租户下撞主键 `DT-LEGACY` 的缺陷，改为全局首个保留、其余 `DT-LG-<租户>-<产线>`）。
- `ops:db-scope-check` 迁移前后各跑一次，均 **0 项违规**。
- `test/smoke.ts` 种子口令已支持注入：`SMOKE_ADMIN_PASS`（admin 单独）与 `SMOKE_SEED_PASS`（其余账号，默认 123456）。
- 冒烟最新结果：**139 通过 / 8 失败**。
- 失败分布：
  - 3 项：`other1 只见 L02-ST01（反向隔离）` 返回空数组；
  - 5 项：L01-ST15 工位要素 404（`VA 改判/确认/封存版改判/VA 拆分/pct/人工裁决`）。
- 事实：`L01-ST15` 工位当前**不在库中**（冒烟自建自清），`t_element` 全库仅 L01-ST01 的 3 行。
- 视频链路：HEVC 静默黑屏已修复；上传转码已改 QSV 优先；`app/api/bin/ffmpeg.exe` 已就位（不入 git）。

## ⏸️ 当前卡点、缺失数据、风险

1. **【未解谜】3001 实例上要素提交全被 V1 词表拦截**
   - 现象：`POST /api/stations/<id>/elements/validate` 对 `移物`/`装配`/`持住`/`拿取` 全部返回「不在动作词表」；
   - 对照：同一份 `dist` 用 `NestFactory` 在**进程内**引导 AppModule 并套同样 `ValidationPipe`，同一请求返回 `ok=true`；
   - 已排除：`ELEMENT_TYPES` 常量内容（44 类正常）、dist 与源码一致、DTO 装饰器完整、class-validator 单副本、无运行时变异代码、重启后问题依旧（确定性复现）。
   - **未排除方向**：真实启动路径（`dist/src/main.js`）中某个全局中间件/守卫/管道与进程内探针的差异；或进程内探针缺少了 main.ts 里其他 `use*` 调用（helmet/CORS/trust proxy/自定义中间件）。

2. **【生产库副作用，需决策】冒烟向 `t_rule_set` 发布了两条规则**
   - `va_rules RV3.65`（2026-11-20 21:43 由冒烟发布，`RV3.64` 被置 inactive）；
   - `benefit_params RV1.1`（同日发布，`RV1.0` 被置 inactive）；
   - 这是 `POST /api/config/benefit-params`（「收益参数发布」用例）与 VA 相关用例的正常测试行为，但**发生在生产库**上。需确认：是否保留 RV3.65/RV1.1，还是恢复 RV3.64/RV1.0 为 active。

3. **生产库上跑冒烟的风险**：本机 `.env` 直连生产库，冒烟会写测试工位/要素并自清理、临时锁定 leader1（用例设计）。建议后续改用 sqlite 开发库跑冒烟。

## 📌 下一步优先动作

1. 定位并修复 3001 实例 V1 词表误报（对照 `app/api/src/main.ts` 全部全局 `use*` 调用，逐步剥离复现）。
2. 修好后重跑 `SMOKE_ADMIN_PASS=<口令> npm run smoke`，确认 147/0。
3. 处理 t_rule_set 的 RV 版本决策（见上）。
4. 排查 `other1 反向隔离` 为空的原因（是否与 `t_station` 的 OTHER 租户工位状态或租户守卫有关）。
5. 冒烟改走 sqlite（`DB_TYPE` 切换）后重跑，形成不污染生产库的基线。

## ❓ 待人工确认口径

- 是否恢复 `va_rules RV3.64` / `benefit_params RV1.0` 为 active？
- 是否同意后续冒烟只在 sqlite 开发库执行？
- `L01-ST15` 相关 5 项失败是否属于冒烟用例自身的工位生命周期假设过期（而非产品缺陷）？

## 📎 关联记忆文件

- `memory-bank/facts/2026-11-22-db-boundary.md`
- `memory-bank/facts/2026-11-22-video-playback-pipeline.md`
- `handoff/02-任务看板.md` T4 / T10 / T11
- `handoff/03-开发记录.md` 2026-11-20（晚）与（晚，续）
- `handoff/明细/project_memory/risk_log.md` R06 / R17