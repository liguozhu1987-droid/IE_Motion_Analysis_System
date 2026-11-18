/**
 * Phase 3 · Wave 2 · D7 表级快照（迁移前执行，只读）
 * ------------------------------------------------------------
 * 冻结清单 §6 D7：只导出 5 张表快照，不做全库 BACKUP DATABASE。
 * 产出 app/api/storage/wave2/backup_before.json，供
 * phase3-wave2-migration-verify.cjs 逐行比对（主键 / element_ids / 历史审计零改写）。
 *
 *   cd app/api && node test/phase3-wave2-snapshot.cjs
 */
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const sql = require('mssql');

const OUT = path.resolve(__dirname, '../storage/wave2/backup_before.json');

(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });
  const q = async (text) => (await pool.request().query(text)).recordset;

  const snapshot = { at: new Date().toISOString(), db: process.env.DB_NAME || 'CN_AME', tables: {} };
  // 前 4 张全量导出（行数 0 / 1 / 1 / 4）；t_audit_log 只留身份指纹，避免 7731 行大对象
  for (const t of ['t_ai_task', 't_ai_suggestion_batch', 't_ai_waste_batch', 't_improvement']) {
    snapshot.tables[t] = await q(`SELECT * FROM ${t}`);
  }
  snapshot.tables.t_audit_log = await q(`SELECT log_id, action, created_at FROM t_audit_log`);
  snapshot.auditTotal = snapshot.tables.t_audit_log.length;

  // 回填前所有目标列都不存在；若已存在说明重复执行，直接拒绝覆盖快照
  const cols = await q(`SELECT t.name AS tbl, c.name AS col FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    WHERE (t.name IN ('t_ai_suggestion_batch','t_ai_waste_batch','t_improvement','t_audit_log') AND c.name = 'task_id')
       OR (t.name = 't_ai_task' AND c.name = 'decomp_task_id')`);
  if (cols.length) {
    await pool.close();
    console.error(`目标列已存在，拒绝覆盖迁移前快照：${cols.map((c) => `${c.tbl}.${c.col}`).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2), 'utf8');
  await pool.close();
  console.log(`快照已写入 ${OUT}`);
  console.log(`  t_ai_task=${snapshot.tables.t_ai_task.length} · t_ai_suggestion_batch=${snapshot.tables.t_ai_suggestion_batch.length} · t_ai_waste_batch=${snapshot.tables.t_ai_waste_batch.length} · t_improvement=${snapshot.tables.t_improvement.length} · t_audit_log=${snapshot.auditTotal}`);
})().catch((e) => { console.error('快照失败：', e); process.exitCode = 1; });
