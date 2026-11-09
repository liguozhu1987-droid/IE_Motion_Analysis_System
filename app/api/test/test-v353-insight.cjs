/**
 * v3.53 AI 洞察（诊断/解读）回归。
 *
 * 场景覆盖（AI 三铁律 + 降级链 + 隔离）：
 *  A. AI 关（AI_ENABLED=false，主实例 3001）
 *     → diagnose/interpret 走模板降级：generated_by=template、status=pending_review、文案含「系统模板」标识
 *  B. 跨租户（other1 → DEFAULT 租户工位）→ 404（BaseRepository 租户过滤，与 analysis 现网口径一致）
 *  C. 权限守卫（临时收回 OTHER 租户 ie_engineer 的 analysis:read）→ 403；测后恢复
 *  D. AI mock 开（自起实例 3002：AI_ENABLED=true + mock LLM）
 *     → LLM 文案夹带数字，输出必须被 sanitize 剥净（百分比/秒/金额 → 占位符）；
 *       interpret 的 regressionWarnings 由规则引擎算出（非 LLM 产物）；两者均待审态
 *
 * 说明：POST 端点 Nest 默认返 201；mock LLM 不消耗真实 token。
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const sql = require('mssql');

const BASE = 'http://127.0.0.1:3001/api';
const BASE2 = 'http://127.0.0.1:3002/api';
const API_DIR = path.resolve(__dirname, '..');
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}
const DB = { server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS, options: { encrypt: false, trustServerCertificate: true } };

const MOCK_LLM_PORT = 19113;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ✓ ' + n + (d ? ' ' + d : '')); } else { fail++; console.log('  ✗ ' + n + ' ' + d); } };

/** mock LLM：故意在文案里夹带数字（秒/百分比/金额），验证 sanitize 剥净 */
const DIAG_TEXT = '根因判断：该工位双手作业失衡，无效等待偏高。\n1. 周期 CT 达 45.2 秒，超出节拍\n2. NVA 占比 32.5%，持住与延迟集中\n3. 单件浪费成本约 ¥120/件';
const INTERP_TEXT = '整体解读：调整后效率提升。\n1. CT 从 45.2 秒降到 40.1 秒\n2. NVA 占比 32.5% → 21.3%\n3. 单件节省成本约 ¥120/件';
let lastPrompt = '';
function startMockLlm() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const sys = String(parsed?.messages?.[0]?.content ?? '');
      lastPrompt = String(parsed?.messages?.[1]?.content ?? '');
      const content = sys.includes('对比') ? INTERP_TEXT : DIAG_TEXT;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 88 } }));
    });
  });
  return new Promise((r) => server.listen(MOCK_LLM_PORT, '127.0.0.1', () => r(server)));
}

async function waitHealth(base, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

(async () => {
  const mockLlm = await startMockLlm();
  let pool = await sql.connect(DB);
  let child = null;

  const login = async (u, p, base = BASE) => {
    const r = await fetch(base + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    return (await r.json()).accessToken;
  };
  const call = async (m, p, body, token, base = BASE) => {
    const res = await fetch(base + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    return { status: res.status, data: d };
  };
  const setKey = async (k, v) => pool.request().query(
    `IF EXISTS (SELECT 1 FROM t_ai_setting WHERE setting_key='${k}') UPDATE t_ai_setting SET setting_value='${v}' WHERE setting_key='${k}'
     ELSE INSERT INTO t_ai_setting (setting_key, setting_value, updated_by) VALUES ('${k}','${v}','v353-insight')`);

  const admin = await login('admin', '123456');
  const other = await login('other1', '123456');
  ok('双账号登录成功', Boolean(admin && other));

  /* 取 DEFAULT 租户含要素工位 */
  const st = await call('GET', '/stations', null, admin);
  const arr = Array.isArray(st.data) ? st.data : (st.data.stations ?? []);
  let SID = null;
  for (const s of arr.slice(0, 25)) {
    const els = await call('GET', `/stations/${s.station_id}/elements`, null, admin);
    if ((els.data?.elements ?? []).length > 0) { SID = s.station_id; break; }
  }
  ok('找到含要素的 DEFAULT 工位', Boolean(SID), String(SID));

  /* 造 v2 版本要素（std_time ×1.2 → ΔCT>0 → 规则引擎应出「CT 增加」倒退预警） */
  const mk = await pool.request().input('sid', SID).query(`
    INSERT INTO t_element (element_id, tenant_id, station_id, seq, start_ms, dur_s, hand, type, [desc], va_class,
      outlier_flag, outlier_reason, video_id, source, rating, allowance, std_time, bol_version)
    SELECT LEFT(element_id,40)+'_v2', tenant_id, station_id, seq+100, start_ms, ROUND(dur_s*1.2,2), hand, type, [desc], va_class,
      outlier_flag, outlier_reason, video_id, source, rating, allowance, ROUND(std_time*1.2,2), 2
    FROM t_element WHERE station_id=@sid AND bol_version=1`);
  ok('注入 v2 版本要素（CT 恶化 20%）', mk.rowsAffected[0] > 0, `rows=${mk.rowsAffected[0]}`);

  /* ── A. AI 关 → 模板降级（主实例未配 AI_ENABLED） ── */
  const dg = await call('POST', `/stations/${SID}/analysis/diagnose`, null, admin);
  ok('A1 AI 关：diagnose 201', dg.status === 201, `status=${dg.status}`);
  ok('A2 AI 关：模板降级 + 待审态',
    dg.data?.generated_by === 'template' && dg.data?.status === 'pending_review' && /系统模板诊断/.test(dg.data?.report ?? ''),
    `by=${dg.data?.generated_by} state=${dg.data?.status}`);

  const it = await call('POST', `/stations/${SID}/compare/interpret`, {}, admin);
  ok('A3 AI 关：interpret 201', it.status === 201, `status=${it.status}`);
  ok('A4 AI 关：模板解读 + 待审态',
    it.data?.generated_by === 'template' && it.data?.status === 'pending_review' && /系统模板解读/.test(it.data?.interpretation ?? ''),
    `by=${it.data?.generated_by} state=${it.data?.status}`);
  ok('A5 AI 关：倒退预警由规则引擎算出（ΔCT>0 → CT 增加）',
    Array.isArray(it.data?.regressionWarnings) && it.data.regressionWarnings.some((w) => /CT 增加/.test(w)),
    JSON.stringify(it.data?.regressionWarnings ?? []));

  /* ── B. 跨租户 → 404（BaseRepository 租户过滤） ── */
  const cross = await call('POST', `/stations/${SID}/analysis/diagnose`, null, other);
  ok('B1 跨租户 diagnose → 404', cross.status === 404, `status=${cross.status}`);
  const cross2 = await call('POST', `/stations/${SID}/compare/interpret`, {}, other);
  ok('B2 跨租户 interpret → 404', cross2.status === 404, `status=${cross2.status}`);

  /* ── C. 权限守卫：新建无 analysis:read / compare:read 的自定义角色用户 → 403 ── */
  const SUFFIX = Date.now().toString().slice(-6);
  const T_ROLE = `t_insight_${SUFFIX}`;
  const T_USER = `insight_u_${SUFFIX}`;
  const T_PWD = 'Insight@12345';
  const cRole = await call('POST', '/admin/roles', {
    code: T_ROLE, name: '洞察回归角色', description: 'v3.53 无分析权限', permissions: ['station:read', 'auth:self'],
  }, admin);
  const T_ROLE_ID = cRole.data?.roleId;
  ok('C0 新建无 analysis:read 角色', cRole.status === 200 && Boolean(T_ROLE_ID), `status=${cRole.status}`);
  const cUser = await call('POST', '/admin/users', {
    username: T_USER, password: T_PWD, displayName: '洞察回归用户', roles: [T_ROLE], dataScope: 'tenant',
  }, admin);
  const T_UID = cUser.data?.userId;
  ok('C0b 授权该角色建号', cUser.status === 200 && Boolean(T_UID), `status=${cUser.status}`);
  const noperm = await login(T_USER, T_PWD);
  const denied = await call('POST', `/stations/${SID}/analysis/diagnose`, null, noperm);
  ok('C1 无 analysis:read → diagnose 403', denied.status === 403, `status=${denied.status}`);
  const denied2 = await call('POST', `/stations/${SID}/compare/interpret`, {}, noperm);
  ok('C2 无 compare:read → interpret 403', denied2.status === 403, `status=${denied2.status}`);
  const unauth = await fetch(BASE + `/stations/${SID}/analysis/diagnose`, { method: 'POST' });
  ok('C3 未登录 → 401', unauth.status === 401, `status=${unauth.status}`);

  /* ── D. AI mock 开：自起实例 3002（AI_ENABLED=true + mock LLM） ── */
  console.log('— 启动 mock-AI 实例（3002） —');
  child = spawn('node', ['dist/src/main.js'], {
    cwd: API_DIR, stdio: 'ignore', detached: false,
    env: { ...process.env, PORT: '3002', AI_ENABLED: 'true', AI_BASE_URL: `http://127.0.0.1:${MOCK_LLM_PORT}/v1`, AI_API_KEY: 'mock-key', AI_MODEL: 'mock-model' },
  });
  const up = await waitHealth(BASE2);
  ok('D0 mock-AI 实例就绪', up);

  if (up) {
    const admin2 = await login('admin', '123456', BASE2);
    const dg2 = await call('POST', `/stations/${SID}/analysis/diagnose`, null, admin2, BASE2);
    ok('D1 AI mock：diagnose 201', dg2.status === 201, `status=${dg2.status}`);
    ok('D2 AI mock：AI 产出 + 待审态',
      dg2.data?.generated_by === 'ai' && dg2.data?.status === 'pending_review',
      `by=${dg2.data?.generated_by} state=${dg2.data?.status}`);
    const rp2 = String(dg2.data?.report ?? '');
    ok('D3 AI mock：秒数被剥净（45.2 秒 → 占位符）', !/\d+(\.\d+)?\s*(?:秒|s\b|sec\b)/i.test(rp2) && /时长由系统计算/.test(rp2), rp2.slice(0, 80));
    ok('D4 AI mock：百分比被剥净（32.5% → 占位符）', !/\d+(\.\d+)?\s*%/.test(rp2) && /比例由系统计算/.test(rp2), rp2.slice(0, 80));
    ok('D5 AI mock：金额被剥净（¥120 → 占位符）', !/[¥$]\s*\d+/.test(rp2) && /金额由系统计算/.test(rp2), rp2.slice(0, 80));

    const it2 = await call('POST', `/stations/${SID}/compare/interpret`, {}, admin2, BASE2);
    ok('D6 AI mock：interpret 201 + AI 产出', it2.status === 201 && it2.data?.generated_by === 'ai', `status=${it2.status} by=${it2.data?.generated_by}`);
    const ip2 = String(it2.data?.interpretation ?? '');
    ok('D7 AI mock：解读文本无残留数字', !/\d+(\.\d+)?\s*(?:%|秒|s\b|sec\b)|[¥$]\s*\d+/i.test(ip2), ip2.slice(0, 80));
    ok('D8 AI mock：倒退预警仍由规则引擎给出（ΔCT>0）',
      Array.isArray(it2.data?.regressionWarnings) && it2.data.regressionWarnings.some((w) => /CT 增加/.test(w)),
      JSON.stringify(it2.data?.regressionWarnings ?? []));
    ok('D9 AI mock：prompt 注入了真实指标作背景（LLM 不产数但看得见数）',
      /CT|VA|NVA/.test(lastPrompt), lastPrompt.slice(0, 60));
  }

  /* ── 清理：v2 要素 / 测试账号 / 恢复现场 ── */
  try { if (child) { child.kill(); } } catch { /* ignore */ }
  await pool.request().query(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version=2`);
  if (T_UID) {
    // 无删用户端点：先改绑既有角色释放测试角色（roles 至少 1 个），再禁用户、删角色
    await call('POST', '/admin/users/bulk-roles', { userIds: [T_UID], roles: ['viewer'], mode: 'replace' }, admin);
    await call('PATCH', `/admin/users/${T_UID}`, { status: 'disabled' }, admin);
  }
  if (T_ROLE_ID) await call('DELETE', `/admin/roles/${T_ROLE_ID}`, null, admin);
  await setKey('llm_base_url', '');
  await pool.request().query(`UPDATE t_ai_llm_profile SET enabled = 1 WHERE name = N'初始配置'`);
  await pool.close();
  mockLlm.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('异常：', e);
  try {
    const p = await sql.connect(DB);
    await p.request().query('UPDATE t_ai_llm_profile SET enabled = 1 WHERE name = N\'初始配置\'');
    await p.request().query("UPDATE t_ai_setting SET setting_value = '' WHERE setting_key = 'llm_base_url'");
    await p.close();
  } catch { /* ignore */ }
  process.exit(1);
});
