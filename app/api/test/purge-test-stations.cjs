/** 清理冒烟/契约测试残留工位（v3.42 同名护栏：UQ(tenant,owner,name) 会让重跑 400） */
require('dotenv/config');
const { loadConfig } = require('../dist/src/core/config/configuration.js');
const cfg = loadConfig();
async function q(sql) {
  const mssql = require('mssql');
  const pool = await mssql.connect({
    server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try { const r = await pool.request().query(sql); return r.recordset; } finally { await pool.close(); }
}
(async () => {
  // v3.47：v3.42 同名护栏 UQ(tenant,owner,name) 下，名称撞车会让新建返回 400，
  // 进而让后续断言 404 失败。此处改为「模糊 + smoke 固定名名单」双重覆盖：
  // 冒烟/契约等随机名前走 LIKE，smoke.ts 里写死的工位名走显式名单，避免清理遗漏。
  const FIXED = [
    '越权测试', '冒烟测试工位', '格式错误', '要素冒烟工位',
    'VA归类验证工位', '对比验证工位', '建议验证工位',
  ].map((n) => "'" + n + "'").join(',');
  const rows = await q(
    `SELECT s.station_id, s.name, s.owner_user_id, u.username FROM t_station s LEFT JOIN t_user u ON u.user_id = s.owner_user_id
     WHERE s.name LIKE '%冒烟%' OR s.name LIKE '%契约%' OR s.name IN (${FIXED})`,
  );
  console.log(JSON.stringify(rows, null, 1));
  const ids = rows.map((r) => "'" + r.station_id + "'").join(',');
  if (!ids) { console.log('无残留'); return; }
  for (const t of ['t_ai_waste_issue', 't_ai_waste_finding', 't_ai_waste_batch', 't_ai_suggestion', 't_ai_suggestion_batch', 't_improvement', 't_element', 't_station_collaborator']) {
    await q(`DELETE FROM ${t} WHERE station_id IN (${ids})`).catch((e) => console.log(t, String(e.message).slice(0, 80)));
  }
  await q(`DELETE FROM t_station WHERE station_id IN (${ids})`);
  console.log('已清理:', ids);
})().catch((e) => { console.error(e.message); process.exit(1); });
