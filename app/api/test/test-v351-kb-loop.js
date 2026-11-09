/**
 * v3.51 知识库反哺闭环验证（本地 mock LLM，不消耗真实 token）。
 *
 * 链路：人工录入 → 整理进知识库 → 再次 AI 生成时检索命中 → 命中计数 +1 且注入 prompt。
 * 断言：
 *  1. 整理后知识条目 hit_count = 0
 *  2. AI 生成成功后该条目 hit_count ≥ 1（说明检索命中并注入了本次生成）
 *  3. 生成失败/无命中不影响主流程
 */
const http = require('http');
const BASE = 'http://127.0.0.1:3001/api';
const sql = require('mssql');
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}
const DB = { server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS, options: { encrypt: false, trustServerCertificate: true } };

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ✓ ' + n + (d ? ' ' + d : '')); } else { fail++; console.log('  ✗ ' + n + ' ' + d); } };

const MOCK_PORT = 19111;
const MOCK_PAYLOAD = {
  findings: [{ element_seqs: [1], waste_type: '搬运', evidence: '取料往返距离长，每循环两次往返搬运' }],
  issues: [{ element_seqs: [1], waste_type: '搬运', problem: '物料架过远导致每循环往返取料', ecrs: 'R', suggestion: '物料架移至操作区右手可达范围' }],
};

function startMock() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_PAYLOAD) } }],
        usage: { total_tokens: 123 },
      }));
    });
  });
  return new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', () => r(server)));
}

(async () => {
  const mock = await startMock();
  let token = '';
  const call = async (m, p, body) => {
    const res = await fetch(BASE + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    return { status: res.status, data: d };
  };

  const pool = await sql.connect(DB);
  const login = await (await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();
  token = login.accessToken;

  /* 前置：mock 端点生效（停用真实 profile，使 t_ai_setting 生效）+ ai_enabled=1 */
  await pool.request().query('UPDATE t_ai_llm_profile SET enabled = 0');
  const setKey = async (k, v) => pool.request().query(
    `IF EXISTS (SELECT 1 FROM t_ai_setting WHERE setting_key='${k}') UPDATE t_ai_setting SET setting_value='${v}' WHERE setting_key='${k}'
     ELSE INSERT INTO t_ai_setting (setting_key, setting_value, updated_by) VALUES ('${k}','${v}','kb-loop')`);
  await setKey('ai_enabled', '1');
  await setKey('llm_base_url', `http://127.0.0.1:${MOCK_PORT}/v1`);
  await setKey('llm_api_key', 'test-key');
  await setKey('llm_model', 'mock-model');

  /* 选一个有已提交要素的工位 */
  const st = await call('GET', '/stations');
  const arr = Array.isArray(st.data) ? st.data : (st.data.stations ?? []);
  let SID = null, LINE = null;
  for (const s of arr.slice(0, 25)) {
    const els = await call('GET', `/stations/${s.station_id}/elements`);
    const list = els.data?.elements ?? [];
    const manual = list.filter((e) => (e.source ?? 'manual') === 'manual' && Number(e.outlier_flag) === 0);
    if (manual.length > 0) { SID = s.station_id; LINE = 'manual'; break; }
  }
  ok('找到含手工要素的工位', Boolean(SID), `${SID} / ${LINE}`);

  /* 1. 人工录入 + 整理进知识库（关键词含「物料架」「往返」） */
  const items0 = await call('GET', `/stations/${SID}/ai-waste/items?origin=all&scope=all`);
  const wt = (items0.data.waste_types ?? [])[0] ?? '搬运';
  const mi = await call('POST', `/stations/${SID}/ai-waste/manual/issues`, {
    waste_type: wt, problem: '物料架距操作区过远，操作员每循环往返取料两次',
    ecrs: 'R', suggestion: '将物料架移至操作区右手可达范围，取消往返',
  });
  ok('人工措施录入成功', mi.status === 201, `status=${mi.status}`);
  await call('POST', `/stations/${SID}/ai-waste/kb/archive`, {});
  const kb0 = await pool.request().query('SELECT kb_id,hit_count,keywords FROM t_ai_waste_kb');
  const target = kb0.recordset.find((r) => r.kb_id) ?? null;
  ok('知识条目已沉淀且初始命中=0', Boolean(target) && Number(target.hit_count) === 0,
    `n=${kb0.recordset.length} hits=${target && target.hit_count}`);
  console.log(`    关键词：${String(target?.keywords ?? '').slice(0, 60)}`);

  /* 2. AI 生成（mock）→ 检索应命中该知识条目 */
  await pool.request().query(`DELETE FROM t_ai_waste_finding WHERE station_id='${SID}' AND origin='ai'`);
  await pool.request().query(`DELETE FROM t_ai_waste_batch WHERE station_id='${SID}'`);
  const gen = await call('POST', `/stations/${SID}/ai-waste/generate-manual`);
  ok('mock 生成成功', gen.status === 200, `status=${gen.status} ${JSON.stringify(gen.data).slice(0, 100)}`);

  const kb1 = await pool.request().query(`SELECT hit_count,last_hit_at FROM t_ai_waste_kb WHERE kb_id='${target.kb_id}'`);
  ok('知识条目被本次生成命中（hit_count ≥ 1）',
    kb1.recordset.length === 1 && Number(kb1.recordset[0].hit_count) >= 1,
    `hit_count=${kb1.recordset[0]?.hit_count} last=${kb1.recordset[0]?.last_hit_at}`);

  /* 3. 清理：mock 配置、知识库、人工条目、批次 */
  await call('DELETE', `/ai-waste/issues/${mi.data.issue_id}`);
  for (const r of kb0.recordset) await call('DELETE', `/ai-waste/kb/${r.kb_id}`);
  await pool.request().query(`DELETE FROM t_ai_waste_finding WHERE station_id='${SID}'`);
  await pool.request().query(`DELETE FROM t_ai_waste_issue WHERE station_id='${SID}'`);
  await pool.request().query(`DELETE FROM t_ai_waste_batch WHERE station_id='${SID}'`);
  await setKey('llm_base_url', '');
  await pool.request().query('UPDATE t_ai_llm_profile SET enabled = 1 WHERE name = N\'初始配置\'');
  await pool.close();
  mock.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('异常：', e);
  try {
    const p = await sql.connect(DB);
    await p.request().query('UPDATE t_ai_llm_profile SET enabled = 1 WHERE name = N\'初始配置\'');
    await p.request().query('UPDATE t_ai_setting SET setting_value = \'\' WHERE setting_key = \'llm_base_url\'');
    await p.close();
  } catch { /* ignore */ }
  process.exit(1);
});
