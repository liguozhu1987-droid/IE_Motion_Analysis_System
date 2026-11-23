-- ============================================================================
-- deploy/sql/manual/2026-11-23-fix-chinese-encoding.sql
-- 修复因 migrate.ts DEFAULT 字面量未加 N 前缀导致的中文变 ? 问题
-- 目标表（全部在 CLAUDE.md 33 表白名单内）：t_line, t_improvement, t_tenant, t_project
-- 注意：用 LIKE N'%?%' 匹配已损坏值，用已知枚举复原；执行前建议先 SELECT COUNT 确认受损行数
-- ============================================================================

-- 1. 先确认受损范围（注释掉即跳过，紧急时直接执行）
-- SELECT 't_line' AS tbl, COUNT(*) AS damaged_rows FROM t_line WHERE product_type LIKE N'%?%' OR process_type LIKE N'%?%'
-- UNION ALL SELECT 't_improvement', COUNT(*) FROM t_improvement WHERE project_type LIKE N'%?%' OR status LIKE N'%?%'
-- UNION ALL SELECT 't_tenant', COUNT(*) FROM t_tenant WHERE region LIKE N'%?%'
-- UNION ALL SELECT 't_project', COUNT(*) FROM t_project WHERE stage LIKE N'%?%';

-- 2. 修复已知枚举值（值可恢复——因为 DEFAULT 值是写死的枚举，非用户输入）
UPDATE t_line SET product_type = N'待补充' WHERE product_type LIKE N'%?%';
UPDATE t_line SET process_type = N'装配' WHERE process_type LIKE N'%?%';
UPDATE t_improvement SET project_type = N'量产改善' WHERE project_type LIKE N'%?%';
UPDATE t_improvement SET status = N'待实施' WHERE status LIKE N'%?%';
UPDATE t_tenant SET region = N'总部' WHERE region LIKE N'%?%';
UPDATE t_project SET stage = N'量产' WHERE stage LIKE N'%?%';

-- 3. 再次确认清零
SELECT 't_line product_type' AS col, COUNT(*) AS remaining FROM t_line WHERE product_type LIKE N'%?%'
UNION ALL SELECT 't_line process_type', COUNT(*) FROM t_line WHERE process_type LIKE N'%?%'
UNION ALL SELECT 't_imp project_type', COUNT(*) FROM t_improvement WHERE project_type LIKE N'%?%'
UNION ALL SELECT 't_imp status', COUNT(*) FROM t_improvement WHERE status LIKE N'%?%'
UNION ALL SELECT 't_tenant region', COUNT(*) FROM t_tenant WHERE region LIKE N'%?%'
UNION ALL SELECT 't_project stage', COUNT(*) FROM t_project WHERE stage LIKE N'%?%';

-- 预期结果：全部 0。若非零 → 该值非 DEFAULT 枚举，需人工判断原意。