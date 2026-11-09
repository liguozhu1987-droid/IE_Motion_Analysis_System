/**
 * AI 用量隔离契约：临时 SQLite + 3103 + 本机 mock LLM。
 * 覆盖逐次 HTTP 留痕、重试/失败/缺失 usage、工位汇总、历史去重、日期、分页与数据范围。
 * 只 seed/写临时库；不读取生产配置，不调用公网模型。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { DataSource } = require('typeorm');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const API_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(API_DIR, '../..');
const OUT = path.resolve(ROOT, 'deliverables/AI-usage-isolated-report.json');
const BASE = 'http://127.0.0.1:3103/api';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-ai-usage-gate-'));
const dbPath = path.join(tempDir, 'gate-ai-usage.db');
const logPath = path.join(tempDir, 'api.log');
let server = null;
let db = null;
let fixtureDs = null;
let mock = null;
const checks = [];
const env = {
  ...process.env,
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3103',
  DB_TYPE: 'sqlite', DB_PATH: dbPath,
  JWT_ACCESS_SECRET: 'isolated-ai-usage-access', JWT_REFRESH_SECRET: 'isolated-ai-usage-refresh',
  RULES_DIR: path.resolve(ROOT, 'app/config/rules'), WEB_DIST: path.resolve(ROOT, 'app/web/dist'),
  LOG_DIR: tempDir, METRICS_TOKEN: 'isolated-ai-usage-metrics', SEC_HSTS: 'off',
  AI_ENABLED: 'false', AI_SUGGEST_ENABLED: 'false', VIDEO_AUTO_DERIVE: '0',
  AI_USAGE_ISOLATED: '1', AI_USAGE_DB_PATH: dbPath, BASE, WEB_URL: 'http://127.0.0.1:3103',
  HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
};

function check(name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail: detail ?? null });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${JSON.stringify(detail)}`}`);
}
function runNode(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: API_DIR, env: { ...env, ...extraEnv }, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
function openDb() {
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, (e) => e ? reject(e) : resolve(connection));
  });
}
function query(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
}
function exec(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (e) { e ? reject(e) : resolve(this); }));
}
async function waitHealthy() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`隔离 API 提前退出: ${server.exitCode}; 日志 ${logPath}`);
    try { if ((await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`隔离 API 60 秒未就绪；日志 ${logPath}`);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
}
async function login(username) {
  const res = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' }), signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`登录失败 ${username}: ${JSON.stringify(body)}`);
  return body.accessToken;
}
async function summary(token, params = '') {
  const res = await fetch(BASE + '/ai/usage/summary' + (params ? `?${params}` : ''), {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  return { status: res.status, body };
}
function usageContext(batchId, attemptNo = 1) {
  return {
    feature: 'improvement_suggestion', tenantId: 'DEFAULT', userId: 'u_admin',
    stationId: 'L01-ST01', lineId: 'L01', batchId, attemptNo,
  };
}
async function startMock() {
  const state = { handler: null, requests: [] };
  const instance = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.requests.push(JSON.parse(raw));
      state.handler(req, res);
    });
  });
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  return { instance, state, baseUrl: `http://127.0.0.1:${instance.address().port}/v1` };
}
function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'mock-request' });
  res.end(JSON.stringify(body));
}
function completion(text, usage) {
  return { id: 'mock-completion', choices: [{ message: { content: text }, finish_reason: 'stop' }], ...(usage === undefined ? {} : { usage }) };
}
async function gatewayContract() {
  const { AiUsageEvent } = require('../dist/src/entities/ai-usage-event.entity.js');
  const { AiUsageService } = require('../dist/src/ai/ai-usage.service.js');
  const { LlmGatewayService } = require('../dist/src/ai/llm-gateway.service.js');
  fixtureDs = new DataSource({ type: 'sqlite', database: dbPath, entities: [AiUsageEvent], synchronize: false });
  await fixtureDs.initialize();
  const usage = new AiUsageService(fixtureDs, {});
  const cfg = { aiEnabled: true, aiBaseUrl: mock.baseUrl, aiKey: 'not-a-real-key', aiModel: 'mock-model', aiTimeoutMs: 3000 };
  const gateway = () => new LlmGatewayService(cfg, usage);
  const opts = (batchId, extra = {}) => ({ ignoreGlobalSwitch: true, usage: usageContext(batchId), ...extra });
  const rows = (batchId) => fixtureDs.getRepository(AiUsageEvent).find({ where: { batch_id: batchId }, order: { internal_retry: 'ASC', attempt_no: 'ASC' } });

  mock.state.handler = (_req, res) => json(res, completion('ok', { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } }));
  const normal = await gateway().chat([], opts('gw-normal'));
  const normalRows = await rows('gw-normal');
  check('成功响应逐字段保存输入/输出/总量/缓存 Token', normal.tokensUsed === 12 && normalRows.length === 1
    && normalRows[0].prompt_tokens === 7 && normalRows[0].completion_tokens === 5
    && normalRows[0].total_tokens === 12 && normalRows[0].cached_tokens === 3, normalRows);

  await gateway().chat([], { ignoreGlobalSwitch: true });
  check('无正式 usage context 的连接/自测调用不入统计', (await query("SELECT COUNT(*) n FROM t_ai_usage_event WHERE model='mock-model'"))[0].n === 1);

  mock.state.handler = (_req, res) => json(res, completion('retry-result', { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }));
  const retryGateway = gateway();
  await retryGateway.chat([], { ignoreGlobalSwitch: true, usage: usageContext('gw-outer-retry', 1) });
  await retryGateway.chat([], { ignoreGlobalSwitch: true, usage: usageContext('gw-outer-retry', 2) });
  const outerRows = await rows('gw-outer-retry');
  check('业务 JSON 解析重试按两次真实调用累加，不覆盖', outerRows.length === 2
    && outerRows.reduce((n, r) => n + r.total_tokens, 0) === 20
    && outerRows.map((r) => r.attempt_no).join(',') === '1,2', outerRows);

  let thinkingCalls = 0;
  mock.state.handler = (req, res) => {
    thinkingCalls++;
    const body = mock.state.requests.at(-1);
    if (body.thinking) return json(res, { error: 'unsupported thinking' }, 400);
    return json(res, completion('fallback', { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 }));
  };
  const fallback = await gateway().chat([], opts('gw-thinking-retry', { disableThinking: true }));
  const thinkingRows = await rows('gw-thinking-retry');
  check('thinking 去除后的内部 HTTP 重试也分别留痕', thinkingCalls === 2 && fallback.tokensUsed === 15
    && thinkingRows.length === 2 && thinkingRows[0].error_code === 'HTTP_400'
    && thinkingRows[0].internal_retry === 0 && thinkingRows[1].internal_retry === 1, thinkingRows);

  mock.state.handler = (_req, res) => json(res, completion('not-business-json', { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }));
  const invalidBusiness = await gateway().chat([], opts('gw-later-validation'));
  const validationRows = await rows('gw-later-validation');
  check('后续业务 JSON 校验失败前的成功调用已保存 Token', invalidBusiness.text === 'not-business-json'
    && validationRows.length === 1 && validationRows[0].total_tokens === 10 && validationRows[0].status === 'success', validationRows);

  mock.state.handler = (_req, res) => json(res, completion('derived-total', { prompt_tokens: 4, completion_tokens: 6 }));
  const derived = await gateway().chat([], opts('gw-derived-total'));
  const derivedRows = await rows('gw-derived-total');
  check('total_tokens 缺失时可由输入＋输出精确求和', derived.tokensUsed === 10 && derivedRows[0].total_tokens === 10, derivedRows);

  mock.state.handler = (_req, res) => json(res, completion('missing-usage'));
  const missing = await gateway().chat([], opts('gw-missing-usage'));
  const missingRows = await rows('gw-missing-usage');
  check('上游缺失 usage 保存 NULL/missing，不虚构为 0', missing.tokensUsed === 0 && missingRows[0].usage_status === 'missing'
    && missingRows[0].prompt_tokens === null && missingRows[0].total_tokens === null, missingRows);

  mock.state.handler = (_req, res) => json(res, { error: 'server' }, 500);
  await gateway().chat([], opts('gw-http-error')).catch(() => {});
  const httpRows = await rows('gw-http-error');
  check('HTTP 失败记录真实调用与错误码，Token 保持未知', httpRows.length === 1 && httpRows[0].status === 'error'
    && httpRows[0].error_code === 'HTTP_500' && httpRows[0].total_tokens === null, httpRows);

  mock.state.handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{broken'); };
  await gateway().chat([], opts('gw-invalid-json')).catch(() => {});
  const invalidRows = await rows('gw-invalid-json');
  check('响应体不可解析记录 INVALID_JSON', invalidRows.length === 1 && invalidRows[0].error_code === 'INVALID_JSON', invalidRows);

  await gateway().chat([], { ...opts('gw-network'), endpoint: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'mock-model' } }).catch(() => {});
  const networkRows = await rows('gw-network');
  check('网络失败记录 NETWORK 且不虚构 Token', networkRows.length === 1 && networkRows[0].error_code === 'NETWORK'
    && networkRows[0].total_tokens === null, networkRows);

  await exec("DELETE FROM t_ai_usage_event WHERE batch_id LIKE 'gw-%'");
}

async function insertEvent(id, batch, values = {}) {
  const v = {
    tenant: 'DEFAULT', feature: 'improvement_suggestion', user: 'u_admin', station: 'L01-ST01', line: 'L01',
    model: 'model-a', status: 'success', http: 200, prompt: 100, completion: 40, total: 140,
    cached: 20, usageStatus: 'reported', createdAt: new Date().toISOString().replace('T', ' ').replace('Z', ''), ...values,
  };
  await exec(`INSERT INTO t_ai_usage_event
    (usage_id,tenant_id,feature,purpose,batch_id,user_id,station_id,line_id,provider,model,attempt_no,internal_retry,
     request_id,status,http_status,latency_ms,error_code,prompt_tokens,completion_tokens,total_tokens,cached_tokens,usage_status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, v.tenant, v.feature, v.purpose ?? 'business', batch, v.user, v.station, v.line, 'openai_compatible', v.model,
    v.attempt ?? 1, v.retry ?? 0, null, v.status, v.http, 10, v.error ?? null,
    v.prompt, v.completion, v.total, v.cached, v.usageStatus, v.createdAt,
  ]);
}
async function insertSuggestionBatch(batch, station, user, tokens, createdAt) {
  await exec(`INSERT INTO t_ai_suggestion_batch
    (batch_id,tenant_id,station_id,version,user_id,element_source,is_unlimited,status,input_hash,cache_from,attempt,
     suggestion_count,tokens_used,model,prompt_version,error,created_at,completed_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    batch, station === 'L02-ST01' ? 'OTHER' : 'DEFAULT', station, 1, user, 'mixed', 0, 'done', `hash-${batch}`, null, 1,
    1, tokens, 'legacy-model', 'legacy', null, createdAt, createdAt, createdAt,
  ]);
}
async function insertWasteBatch(batch, station, user, tokens, createdAt) {
  await exec(`INSERT INTO t_ai_waste_batch
    (batch_id,tenant_id,station_id,version,user_id,status,element_source,element_count,finding_count,issue_count,
     tokens_used,model,prompt_version,error,created_at,completed_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    batch, 'DEFAULT', station, 1, user, 'done', 'ai_assisted', 1, 1, 1,
    tokens, 'legacy-model', 'legacy', null, createdAt, createdAt, createdAt,
  ]);
}
async function apiContract() {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  await insertEvent('e-live-1', 'b-live-1');
  await insertEvent('e-live-2', 'b-live-1', { prompt: 110, completion: 50, total: 160, cached: 0, attempt: 2 });
  await insertEvent('e-live-error', 'b-live-error', { feature: 'waste_analysis', user: 'u_ie1', model: 'model-b', status: 'error', http: 500, error: 'HTTP_500', prompt: null, completion: null, total: null, cached: null, usageStatus: 'missing' });
  await insertEvent('e-live-st02', 'b-legacy-st02', { user: 'u_ie1', station: 'L01-ST02', prompt: 10, completion: 5, total: 15, cached: 0 });
  await insertEvent('e-other', 'b-other', { tenant: 'OTHER', user: 'u_other1', station: 'L02-ST01', line: 'L02', total: 9999, prompt: 9000, completion: 999 });
  await insertEvent('e-selftest', 'b-legacy-selftest', { purpose: 'self_test', total: 8888, prompt: 8000, completion: 888 });
  await insertSuggestionBatch('b-legacy-1', 'L01-ST01', 'u_admin', 700, now);
  await insertSuggestionBatch('b-legacy-st02', 'L01-ST02', 'u_ie1', 80, now);
  await insertSuggestionBatch('b-legacy-selftest', 'L01-ST01', 'u_admin', 50, now);
  await insertSuggestionBatch('b-legacy-zero', 'L01-ST01', 'u_admin', 0, now);
  await insertWasteBatch('b-waste-legacy', 'L01-ST01', 'u_admin', 300, now);
  await insertEvent('e-before', 'b-before', { createdAt: '2025-12-31 15:59:59.999', total: 11, prompt: 6, completion: 5 });
  await insertEvent('e-at-start', 'b-at-start', { createdAt: '2025-12-31 16:00:00', total: 13, prompt: 7, completion: 6 });
  await insertEvent('e-at-end', 'b-at-end', { createdAt: '2026-01-01 16:00:00', total: 17, prompt: 9, completion: 8 });
  await insertEvent('e-cross-default', 'b-cross-tenant', { total: 5, prompt: 3, completion: 2 });
  await insertSuggestionBatch('b-cross-tenant', 'L02-ST01', 'u_other1', 777, now);

  const admin = await login('admin');
  const ie = await login('ie1');
  const viewer = await login('viewer1');
  const other = await login('other1');

  const denied = await summary(viewer);
  check('无 suggestion:generate 权限返回 403', denied.status === 403, denied);

  const all = await summary(admin);
  check('多分组时 KPI 是筛选范围全局总计而非第一行', all.status === 200 && all.body.rows.length === 4
    && all.body.totals.total_tokens === 1411 && all.body.totals.prompt_tokens === 245
    && all.body.totals.completion_tokens === 116 && all.body.totals.api_call_count === 8
    && all.body.totals.failed_call_count === 1 && all.body.totals.batch_count === 10
    && all.body.totals.legacy_batch_count === 3 && all.body.totals.usage_missing_count === 1, all.body);

  const st1 = await summary(admin, 'station_id=L01-ST01&group_by=line,station');
  const st1row = st1.body.rows?.[0];
  check('单工位总量：重试＋失败＋两功能历史＋跨边界事件精确汇总',
    st1.status === 200 && st1row?.total_tokens === 1396 && st1row?.prompt_tokens === 235
    && st1row?.completion_tokens === 111 && st1row?.api_call_count === 7 && st1row?.failed_call_count === 1,
    st1.body);
  check('同工位多批次去重：新事件存在的批次不再叠加历史 tokens_used', st1.body.totals.batch_count === 9
    && st1.body.totals.legacy_batch_count === 3 && st1.body.totals.usage_missing_count === 1
    && st1.body.totals.data_quality === 'partial', st1.body.totals);

  const st2 = await summary(admin, 'station_id=L01-ST02&group_by=line,station');
  check('同工位新事件与旧批次同号时只计新事件，15 而非 95', st2.body.totals.total_tokens === 15
    && st2.body.totals.legacy_batch_count === 0 && st2.body.totals.batch_count === 1, st2.body);

  const selftest = await summary(admin, 'group_by=station&station_id=L01-ST01&from=2099-01-01');
  check('未来空范围返回零且不报错', selftest.status === 200 && selftest.body.totals.total_tokens === 0 && selftest.body.rows.length === 0, selftest);
  const current = await summary(admin, 'station_id=L01-ST01&group_by=line,station&from=2026-11-01&to=2026-11-30');
  check('自测用途事件不计 Token，且不抑制同批历史 50', current.body.totals.total_tokens === 1355
    && current.body.totals.legacy_batch_count === 3 && current.body.totals.api_call_count === 4, current.body);

  const waste = await summary(admin, 'station_id=L01-ST01&feature=waste_analysis&group_by=feature');
  check('浪费清单与问题清单共享一个 waste_analysis 成本口径', waste.body.totals.total_tokens === 300
    && waste.body.totals.api_call_count === 1 && waste.body.totals.batch_count === 2, waste.body);

  const scoped = await summary(ie);
  check('普通用户只统计可见工位，不能看到他人工位 Token', scoped.status === 200 && scoped.body.totals.total_tokens === 15
    && scoped.body.rows.every((r) => r.station_id === 'L01-ST02'), scoped.body);
  const forced = await summary(ie, 'station_id=L01-ST01');
  check('客户端强制指定不可见工位仍为空', forced.status === 200 && forced.body.totals.total_tokens === 0 && forced.body.rows.length === 0, forced.body);
  const otherScoped = await summary(other);
  check('他租户普通用户无可见工位时不泄露统计', otherScoped.status === 200 && otherScoped.body.totals.total_tokens === 0, otherScoped.body);
  const crossTenant = await summary(admin, 'station_id=L02-ST01');
  check('DEFAULT 管理员不能跨租户查询 OTHER 工位', crossTenant.status === 200 && crossTenant.body.totals.total_tokens === 0, crossTenant.body);

  const { AiUsageService } = require('../dist/src/ai/ai-usage.service.js');
  const direct = new AiUsageService(fixtureDs, { visibleStationIds: async () => null });
  const otherAdmin = await direct.summary({ station_id: 'L02-ST01', group_by: 'station' }, {
    userId: 'u_other1', tenantId: 'OTHER', roles: ['sys_admin'], dataScope: 'tenant', permissions: [],
  });
  check('历史去重按 tenant+batch，OTHER 同号历史仍保留 777', otherAdmin.totals.total_tokens === 10776
    && otherAdmin.totals.legacy_batch_count === 1, otherAdmin.totals);

  const date = await summary(admin, 'from=2026-01-01&to=2026-01-01&group_by=station');
  check('Asia/Shanghai 日期左闭右开：起点计入、次日零点排除', date.body.totals.total_tokens === 13
    && date.body.totals.batch_count === 1 && date.body.rows.length === 1, date.body);
  const invalidDate = await summary(admin, 'from=2026-02-30&to=2026-02-30');
  check('不存在的日历日期返回 400', invalidDate.status === 400, invalidDate);
  const reversed = await summary(admin, 'from=2026-02-02&to=2026-02-01');
  check('开始日期晚于结束日期返回 400', reversed.status === 400, reversed);
  const badGroup = await summary(admin, 'group_by=station,station');
  check('重复/非法分组返回 400', badGroup.status === 400, badGroup);

  const page1 = await summary(admin, 'group_by=model&sort=total_tokens&order=desc&page=1&page_size=1');
  const page2 = await summary(admin, 'group_by=model&sort=total_tokens&order=desc&page=2&page_size=1');
  check('分组总数与分页稳定，页间不重复', page1.body.total_rows === 3 && page1.body.rows.length === 1
    && page2.body.rows.length === 1 && page1.body.rows[0].model !== page2.body.rows[0].model
    && page1.body.totals.total_tokens === page2.body.totals.total_tokens, { page1: page1.body, page2: page2.body });
  const userPage = await summary(admin, 'group_by=user&page_size=1');
  check('仅按用户分组可执行并保留全局 totals', userPage.status === 200 && userPage.body.rows.length === 1
    && userPage.body.rows[0].station_id === null && userPage.body.totals.total_tokens > 0, userPage.body);
}

async function apiCall(method, route, token, body) {
  const res = await fetch(BASE + route, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* error evidence */ }
  return { status: res.status, data, text };
}
async function setupBusinessStation(admin, stationId) {
  const created = await apiCall('POST', '/stations', admin, { station_id: stationId, line_id: 'L01', name: `AI 用量契约 ${stationId}`, tt: 40 });
  if (created.status !== 201 && created.status !== 200) throw new Error(`建立隔离工位失败: ${JSON.stringify(created)}`);
  const submitted = await apiCall('POST', `/stations/${stationId}/elements/submit`, admin, {
    cycle_count: 15, cv: 0.05,
    elements: [
      { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
      { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
      { seq: 3, start_ms: 6000, dur_s: 2.5, hand: 'R', type: '寻找', desc: '目视寻找料件', va_class: 'RNVA', rating: 1, allowance: 0.15 },
    ],
  });
  if (submitted.status !== 200 && submitted.status !== 201) throw new Error(`提交隔离要素失败: ${JSON.stringify(submitted)}`);
}
async function businessContract() {
  const admin = await login('admin');
  const ie = await login('ie1');
  await setupBusinessStation(admin, 'L01-ST91');
  mock.state.handler = (_req, res) => json(res, completion(JSON.stringify([
    { element_seqs: [1], waste_type: '持住', method: 'E', measure: '治具夹持替代手持扶住壳体', eliminate_basis: 'SOP规定双手装配无需人工持住', verif: 3 },
  ]), { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, prompt_tokens_details: { cached_tokens: 10 } }));

  const before = mock.state.requests.length;
  const first = await apiCall('POST', '/stations/L01-ST91/ai-suggestions/generate', admin);
  const firstUsage = await summary(admin, 'station_id=L01-ST91&group_by=station');
  check('正式生成链路实际写入用户/产线/工位归属与 200 Token', first.status === 200 && first.data?.status === 'done'
    && first.data?.idempotent_hit !== true && firstUsage.body.totals.total_tokens === 200
    && firstUsage.body.totals.prompt_tokens === 120 && firstUsage.body.totals.completion_tokens === 80
    && firstUsage.body.totals.api_call_count === 1 && firstUsage.body.rows[0]?.station_id === 'L01-ST91', { first, usage: firstUsage.body });

  const afterFirst = mock.state.requests.length;
  const again = await apiCall('POST', '/stations/L01-ST91/ai-suggestions/generate', admin);
  const afterAgain = await summary(admin, 'station_id=L01-ST91&group_by=station');
  check('幂等命中不发模型请求且不新增用量事件', again.status === 200 && again.data?.idempotent_hit === true
    && again.data?.batch_id === first.data?.batch_id && mock.state.requests.length === afterFirst
    && afterAgain.body.totals.api_call_count === 1 && afterAgain.body.totals.total_tokens === 200, { again, usage: afterAgain.body });

  await exec("UPDATE t_user SET ai_quota=5, ai_quota_used=0 WHERE user_id='u_ie1'");
  await exec("INSERT INTO t_station_collaborator (station_id,user_id,acl_role,granted_by,granted_at) VALUES ('L01-ST91','u_ie1','editor','isolated-test',CURRENT_TIMESTAMP)");
  const collabRows = await query("SELECT * FROM t_station_collaborator WHERE station_id='L01-ST91' AND user_id='u_ie1'");
  const cached = await apiCall('POST', '/stations/L01-ST91/ai-suggestions/generate', ie);
  const afterCache = await summary(admin, 'station_id=L01-ST91&group_by=station');
  const cacheBatch = cached.data?.batch_id ? await query('SELECT tokens_used,cache_from FROM t_ai_suggestion_batch WHERE batch_id=?', [cached.data.batch_id]) : [];
  check('缓存克隆新增数据库批次但 tokens_used=0、模型请求/事件/计量批次均不新增', collabRows.length === 1 && cached.status === 200
    && cached.data?.cache_from === first.data?.batch_id && mock.state.requests.length === afterFirst
    && afterCache.body.totals.api_call_count === 1 && afterCache.body.totals.total_tokens === 200
    && afterCache.body.totals.batch_count === 1 && cacheBatch[0]?.tokens_used === 0, { cached, usage: afterCache.body, cacheBatch });

  await setupBusinessStation(admin, 'L01-ST92');
  mock.state.handler = (_req, res) => json(res, completion('not-json', { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }));
  const failed = await apiCall('POST', '/stations/L01-ST92/ai-suggestions/generate', admin);
  const failedUsage = await summary(admin, 'station_id=L01-ST92&group_by=station');
  const failedEvents = await query('SELECT attempt_no,total_tokens,status FROM t_ai_usage_event WHERE station_id=? ORDER BY attempt_no', ['L01-ST92']);
  check('正式业务 JSON 两轮解析失败仍累计 400 Token，失败批次不抹消耗', failed.status === 503
    && failedUsage.body.totals.total_tokens === 400 && failedUsage.body.totals.api_call_count === 2
    && failedUsage.body.totals.batch_count === 1 && failedEvents.map((r) => r.attempt_no).join(',') === '1,2'
    && failedEvents.every((r) => r.total_tokens === 200 && r.status === 'success'), { failed, usage: failedUsage.body, failedEvents });
}

(async () => {
  try {
    const occupied = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false);
    if (occupied) throw new Error('3103 已被占用；为保护既有进程，隔离门禁不启动也不清理该进程');
    if (!fs.existsSync(path.join(API_DIR, 'dist/src/main.js'))) throw new Error('请先 npm run build');
    console.log(`隔离数据库: ${dbPath}`);
    const seeded = await runNode(path.join(API_DIR, 'dist/scripts/seed.js'));
    if (seeded.code !== 0) throw new Error(`隔离 seed 失败: ${JSON.stringify(seeded)}`);
    mock = await startMock();
    env.AI_ENABLED = 'true'; env.AI_SUGGEST_ENABLED = 'true';
    env.AI_LLM_BASE_URL = mock.baseUrl; env.AI_LLM_API_KEY = 'isolated-mock'; env.AI_LLM_MODEL = 'mock-model';
    const logFd = fs.openSync(logPath, 'a');
    server = spawn(process.execPath, [path.join(API_DIR, 'dist/src/main.js')], {
      cwd: API_DIR, env, stdio: ['ignore', logFd, logFd], windowsHide: true,
    });
    fs.closeSync(logFd);
    await waitHealthy();
    db = await openDb();
    console.log('\n[Phase A] 本机 mock LLM → 网关逐次调用留痕');
    await gatewayContract();
    console.log('\n[Phase B] 统计 SQL/API → 汇总、历史、日期、分页、权限');
    await apiContract();
    if (process.env.AI_USAGE_BROWSER === '1' || process.argv.includes('--browser')) {
      console.log('\n[Phase C] 真实 Chrome 页面验收');
      const browser = await runNode(path.join(__dirname, 'ai-usage-browser.cjs'));
      check('真实 Chrome 页面验收子进程通过', browser.code === 0, browser);
    }
    console.log('\n[Phase D] 正式生成链路：缓存/幂等零新增，业务重试逐次累计');
    await businessContract();
  } catch (e) {
    console.error(e);
    checks.push({ name: '测试执行无未捕获异常', passed: false, detail: String(e?.stack ?? e) });
  } finally {
    const report = {
      generated_at: new Date().toISOString(), base: BASE, database: 'temporary SQLite',
      llm: 'local mock HTTP only', passed: checks.length > 0 && checks.every((c) => c.passed), checks,
      not_verified: ['SQL Server 实际迁移与方言执行（本轮未连接生产库）', '真实上游模型计费一致性'],
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
    if (mock) await new Promise((resolve) => mock.instance.close(resolve));
    if (fixtureDs?.isInitialized) await fixtureDs.destroy();
    if (db) await new Promise((resolve) => db.close(resolve));
    await stopServer();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); console.log('隔离 API 已停止，临时数据库已删除'); }
    catch (e) { console.error(`临时目录清理失败，请人工删除 ${tempDir}: ${e.message}`); process.exitCode = 1; }
    console.log(`报告: ${OUT}; ${checks.filter((c) => c.passed).length}/${checks.length} 通过`);
  }
})();
