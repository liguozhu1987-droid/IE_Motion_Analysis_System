/* 强制改密全流程验证（用 other1 演练，结束后还原口令）。 */
const bcrypt = require('bcryptjs');
const sql = require('mssql');
const BASE = 'http://127.0.0.1:3001/api';
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}

(async () => {
  const login = async (u, p) => (await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }),
  }));

  // 1. other1 登录（must_change_pwd=1）
  const l1 = await (await login('other1', '123456')).json();
  console.log('1. other1 登录 → mustChangePwd =', l1.mustChangePwd);

  // 2. 改密（规则：≥8位含字母数字）
  const chg = await fetch(BASE + '/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l1.accessToken },
    body: JSON.stringify({ oldPassword: '123456', newPassword: 'Ie12345678' }),
  });
  console.log('2. 改密 →', chg.status, chg.status === 200 ? 'ok' : await chg.text());

  // 3. /me 的 mustChangePwd 应翻 false
  const me = await (await fetch(BASE + '/auth/me', { headers: { Authorization: 'Bearer ' + l1.accessToken } })).json();
  console.log('3. /me mustChangePwd =', me.mustChangePwd, '（应 false）');

  // 4. 旧口令应失效
  const old = await login('other1', '123456');
  console.log('4. 旧口令登录 →', old.status, '（应 401）');

  // 5. 新口令可登录且不再强制改密
  const l2 = await (await login('other1', 'Ie12345678')).json();
  console.log('5. 新口令登录 →', l2.accessToken ? 'ok, mustChangePwd = ' + l2.mustChangePwd : 'FAIL');

  // 6. 弱新密码应被拒（服务端同规则）
  const weak = await fetch(BASE + '/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l2.accessToken },
    body: JSON.stringify({ oldPassword: 'Ie12345678', newPassword: '123456' }),
  });
  console.log('6. 弱新密码改密 →', weak.status, '（应 400）');

  // 7. 还原 other1 口令为 123456（bcrypt cost 10，与 seed 一致）
  const hash = bcrypt.hashSync('123456', 10);
  const pool = await sql.connect({
    server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS,
    options: { encrypt: false, trustServerCertificate: true },
  });
  await pool.request().input('h', hash)
    .query("UPDATE t_user SET password_hash = @h, must_change_pwd = 1 WHERE username = 'other1'");
  await pool.close();
  console.log('7. other1 口令已还原为 123456（must_change_pwd=1）');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
