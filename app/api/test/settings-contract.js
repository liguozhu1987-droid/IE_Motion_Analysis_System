/* 设置中心契约测试（v3.4）：收益参数读取 + 规则库读取/内容/404 + 权限边界。
   说明：不在此脚本内做写操作（发布会产生规则版本行），写路径由人工走查覆盖。*/
const BASE = process.env.BASE || process.env.API_BASE || 'http://127.0.0.1:3001/api';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function login(username, password = '123456') {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  return j.accessToken || j.access_token;
}

async function api(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const RULE_CODES = ['va_rules', 'waste_triggers', 'ecrsa_map', 'redline_keywords', 'benefit_params', 'motion_standard'];

(async () => {
  const admin = await login('admin');
  ok(Boolean(admin), 'admin 登录');

  console.log('== 1. 收益参数 ==');
  const p = await api('/config/benefit-params', admin);
  ok(p.status === 200 && typeof p.body.version === 'string', '参数读取 200 + version', p.body?.version);
  ok(Array.isArray(p.body.lines), 'lines 数组形态（兼容 by_line 历史）', `${p.body?.lines?.length} 行`);
  ok(typeof p.body.formula === 'string' && p.body.formula.includes('365'), '公式回显含 365 天口径');
  const bad = p.body.lines.filter((l) => !(l.rate_yuan_per_hour > 0) || !(l.daily_output > 0) || !(l.land_rate > 0 && l.land_rate <= 1));
  ok(bad.length === 0, '现有参数全部满足引擎校验（rate>0 / output>0 / 0<land≤1）');

  console.log('== 2. 规则库 ==');
  const snap = await api('/rules', admin);
  ok(snap.status === 200 && Object.keys(snap.body).length === 6, '规则快照 6 组（含 motion_standard 动作标准）', Object.keys(snap.body || {}).join(','));
  ok(Object.values(snap.body).every((v) => typeof v.version === 'string' && ['db', 'file'].includes(v.source)), '每组含 version+source');

  for (const code of RULE_CODES) {
    const c = await api(`/rules/${code}`, admin);
    ok(c.status === 200 && c.body.code === code && c.body.content && typeof c.body.content === 'object',
      `GET /rules/${code} 返回内容`, `${c.body?.version} · 字段 ${Object.keys(c.body?.content ?? {}).length}`);
  }
  ok((await api('/rules/va_rules', admin)).body.content?.rv, 'va_rules 内容含 rv 版本字段');

  const sets = await api('/rules/sets', admin);
  ok(sets.status === 200 && Array.isArray(sets.body), '历史版本列表可用', `${sets.body?.length} 条`);
  ok(sets.body.every((s) => 'rule_set_id' in s && 'is_active' in s), '列表含 rule_set_id/is_active');

  const nf = await api('/rules/not_exist', admin);
  ok(nf.status === 404, '未知规则码 → 404', `status=${nf.status}`);

  console.log('== 3. 权限边界 ==');
  const viewer = await login('viewer1');
  ok((await api('/rules/va_rules', viewer)).status === 200, 'viewer 可读规则（rule:read）');
  ok((await api('/config/benefit-params', viewer)).status === 403, 'viewer 读收益参数 → 403（无 settings:benefit-read）');
  const pubR = await fetch(`${BASE}/rules/va_rules/publish`, {
    method: 'POST', headers: { Authorization: `Bearer ${viewer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { rv: 'X' } }),
  });
  ok(pubR.status === 403, 'viewer 发布规则 → 403（无 rule:write）');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
