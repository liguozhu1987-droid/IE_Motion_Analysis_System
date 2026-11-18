/**
 * Phase 3 / Wave 1 · task-scope 契约测试公共库。
 * 回环代理坑：node fetch 访问 127.0.0.1 前必须摘除 HTTP(S)_PROXY。
 */
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
process.env.NO_PROXY = '127.0.0.1,localhost';

require('dotenv/config');
const assert = require('node:assert/strict');
const sql = require('mssql');

const BASE = process.env.TASK_SCOPE_BASE || 'http://127.0.0.1:3001';
const PREFIX = 'Phase3契约测试';
const CSV_HEADER = ['工位编码', '版本', '序号', '手别', '类型', '描述', '时长s', 'VA类别', '异常标记', '异常原因', '评比', '宽放', '标准工时', '起点ms'];

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function finish(label) {
  console.log(`\n${label}：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
  return fail === 0;
}

async function login(username, password = '123456') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${username} 登录失败 ${res.status}: ${JSON.stringify(data)}`);
  return data.accessToken;
}

async function call(method, p, { token, body, raw = false } = {}) {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, headers: res.headers, data, text };
}
const postJson = (p, b, t) => call('POST', p, { token: t, body: b });
const getJson = (p, t) => call('GET', p, { token: t });

async function db() {
  return sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });
}
async function query(pool, text, params = {}) {
  const r = pool.request();
  for (const [k, v] of Object.entries(params)) r.input(k, sql.NVarChar(64), String(v));
  return (await r.query(text)).recordset;
}
async function exec(pool, text, params = {}) {
  const r = pool.request();
  for (const [k, v] of Object.entries(params)) r.input(k, sql.NVarChar(64), String(v));
  return r.query(text);
}

/** 4 条合法要素（沿用既有 ai-suggest 契约夹具；满足 V1/V2/V3） */
const BASE_ELEMENTS = [
  { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
  { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
  { seq: 3, start_ms: 6000, dur_s: 2.5, hand: 'R', type: '寻找', desc: '目视寻找料件', va_class: 'RNVA', rating: 1, allowance: 0.15 },
  { seq: 4, start_ms: 8500, dur_s: 2.0, hand: 'L', type: '可避免延迟', desc: '等上件', va_class: 'NVA', rating: 1, allowance: 0.15 },
];
const elements = (n) => BASE_ELEMENTS.slice(0, n).map((e) => ({ ...e, outlier_flag: 0, outlier_reason: '' }));

/** 按名清理测试任务 + 按 station_id 清理测试工位（严格 FK 倒序，避免污染正式库） */
async function cleanup(pool, stationId) {
  if (stationId) {
    const tables = [
      't_ai_waste_finding', 't_ai_waste_issue', 't_ai_suggestion', 't_ai_suggestion_batch',
      't_ai_waste_batch', 't_improvement', 't_element', 't_station_collaborator',
      't_task_station', 't_station',
    ];
    for (const t of tables) await exec(pool, `DELETE FROM ${t} WHERE station_id = @sid`, { sid: stationId }).catch(() => {});
  }
  await exec(pool, `DELETE FROM t_element WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE name LIKE N'${PREFIX}%')`).catch(() => {});
  await exec(pool, `DELETE FROM t_task_station WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE name LIKE N'${PREFIX}%')`).catch(() => {});
  await exec(pool, `DELETE FROM t_decomposition_task WHERE name LIKE N'${PREFIX}%' OR task_id = 'DT-XTEST-999'`).catch(() => {});
}

module.exports = {
  BASE, PREFIX, CSV_HEADER, assert, ok, finish, login, call, postJson, getJson,
  db, query, exec, elements, cleanup,
};
