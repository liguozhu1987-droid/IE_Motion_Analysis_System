---
tags: ["编码","中文","数据质量","CMC","排查"]
status: draft
date: 2026-11-22
source: 生产库实测（t_line/t_station/t_element 扫描）
---

# 中文变问号（?）的排查结论

## 结论：不是显示/解码问题，是**写入前就已损坏**

2026-11-22 全库扫描（`t_line` / `t_station` / `t_project` / `t_element.desc` / `t_user` / `t_tenant`），仅 2 处：

| 位置 | 值 | 来源判断 |
|---|---|---|
| `t_station.L01-ST88.name` | `diag??ID` | 诊断测试工位残留（已删除） |
| `t_line.SHFA9.product_type` | `???` | 某次非应用路径写入时中文被转换；原值不可逆 |

其余中文（上壳装配、静音房、装配、待补充…）全部正常。

## 排除项

- **列类型无问题**：`t_line`/`t_station` 文本列均为 `nvarchar`，库排序规则 `SQL_Latin1_General_CP1_CI_AS`（NVARCHAR 存中文正常）。
- **应用写入安全**：`lines.controller.ts` 的 create/patch 走 TypeORM `repo.save`（参数化），不会丢中文。
- **CMC 跨库读取无风险（当前）**：`CMC.dbo.production_lines` 文本列是 `varchar` + `Chinese_PRC_CI_AS`（GBK），理论上 Node 按 UTF-8 读会乱码；但实测 103 条产线**全部英文/拼音**，无中文，故当前不触发。**若 CMC 将来出现中文，跨库读取需 `CAST(col AS NVARCHAR(n))`**。
- **要素描述无损坏**：`t_element.[desc]` 扫描 0 处。

## 最可能的原因（按概率）

1. **手工 SQL / sqlcmd / bcp 导入**：未加 `N'...'` 前缀或 `-N`（Unicode）参数 → 中文变 `?`。
2. **历史迁移**（另一台机/旧库导入本库）时同样原因。
3. 通过 curl/脚本在非 UTF-8 控制台提交中文。

## 防再发

- 所有手工 SQL 写中文：字面量必须 `N'中文'`；sqlcmd 必须加 `-N`。
- 运维脚本优先走应用 API（参数化）。
- 定期跑扫描：`WHERE col LIKE '%?%'`（本次用的就是这条）。
- 若 CMC 出现中文，查询加 `CAST(... AS NVARCHAR)`。