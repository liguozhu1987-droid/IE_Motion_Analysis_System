/* 备份/恢复 t_ai_setting —— QA 测试纪律脚本（严过关） */
/* 用法: node t-ai-setting-backup.cjs dump|restore */
const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.resolve(__dirname, '..');
process.chdir(API_DIR);
require('dotenv').config();
const sql = require('mssql');

const BACKUP_FILE = path.join(__dirname, 't_ai_setting_backup.json');

(async () => {
  const mode = process.argv[2] || 'dump';
  const pool = await sql.connect({
    server: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });

  if (mode === 'dump') {
    const rs = await pool.request().query('SELECT setting_key, setting_value, updated_by FROM t_ai_setting');
    const rows = rs.recordset.map((r) => ({
      setting_key: r.setting_key,
      setting_value: r.setting_value,
      updated_by: r.updated_by,
    }));
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`DUMP OK: ${rows.length} rows -> ${BACKUP_FILE}`);
    console.log(rows.map((r) => `  ${r.setting_key}=${String(r.setting_value).slice(0, 24)}${String(r.setting_value).length > 24 ? '...' : ''}`).join('\n'));
    if (rows.length === 0) console.log('WARN: table empty at dump time!');
  } else if (mode === 'restore') {
    const rows = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    await pool.request().query('DELETE FROM t_ai_setting');
    for (const r of rows) {
      await pool.request()
        .input('k', sql.NVarChar, r.setting_key)
        .input('v', sql.NVarChar, r.setting_value)
        .input('u', sql.NVarChar, r.updated_by || 'qa-restore')
        .query('INSERT INTO t_ai_setting (setting_key, setting_value, updated_by, updated_at) VALUES (@k, @v, @u, SYSUTCDATETIME())');
    }
    const rs = await pool.request().query('SELECT setting_key, setting_value FROM t_ai_setting');
    console.log(`RESTORE OK: inserted ${rows.length} rows; table now has ${rs.recordset.length} rows`);
    console.log(rs.recordset.map((r) => `  ${r.setting_key}=${String(r.setting_value).slice(0, 24)}${String(r.setting_value).length > 24 ? '...' : ''}`).join('\n'));
  } else if (mode === 'verify') {
    const rs = await pool.request().query('SELECT setting_key, setting_value FROM t_ai_setting');
    console.log(`CURRENT t_ai_setting (${rs.recordset.length} rows):`);
    console.log(rs.recordset.map((r) => `  ${r.setting_key}=${String(r.setting_value).slice(0, 24)}${String(r.setting_value).length > 24 ? '...' : ''}`).join('\n'));
  }
  await pool.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
