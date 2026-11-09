/* 检查 t_ai_llm_profile 内容（QA 侦查用，临时） */
process.chdir(require('node:path').resolve(__dirname, '..'));
require('dotenv').config();
const sql = require('mssql');
(async () => {
  const pool = await sql.connect({
    server: process.env.DB_HOST, port: +process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
  });
  const rs = await pool.request().query(
    "SELECT profile_id, name, base_url, model, enabled, CASE WHEN api_key IS NULL OR LEN(api_key)=0 THEN '' ELSE 'SET(' + CAST(LEN(api_key) AS VARCHAR) + ')' END AS api_key_info FROM t_ai_llm_profile"
  );
  console.log('t_ai_llm_profile rows:', rs.recordset.length);
  rs.recordset.forEach((r) => console.log(' ', JSON.stringify(r)));
  await pool.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
