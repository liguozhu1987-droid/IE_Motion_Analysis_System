---
tags: ["数据库","生产环境","规则"]
status: draft
date: 2026-11-22
source: CLAUDE.md
---

# 生产库边界：CN_AME 的 33 张白名单表

- 唯一允许的连接目标：`IRSCNYTFINEREPORT.ap.inalfa.local:1433` / 库 `CN_AME` / 账号 `publicUser`；**口令只存 `app/api/.env`**，不得写入任何受版本控制的文件、日志或聊天。
- DDL + DML 仅限 **33 张 `t_` 白名单表**；跨库只读例外只有 `CMC.dbo.*`（SELECT-only）。
- 提交/部署前必须 `npm run ops:db-scope-check`；失败即禁止部署。
- 表结构唯一来源 `app/api/scripts/migrate.ts`（幂等 DDL）+ `deploy/sql/manual/` 两个手工脚本；生产 `synchronize=false`。

**权威正文**：根目录 `CLAUDE.md` §1（最高优先级，改动需用户书面同意）。

**本机注意**：本机 `app/api/.env` 直接指向生产库，因此 `migrate:prod` / `seed` / 冒烟等写库操作**即作用于生产**。