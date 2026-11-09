/**
 * P3-9 浪费识别 + 改善问题清单契约测试（AI 自动分解线专用；≥40 断言）。
 *
 * 边界铁律：本模块与分解工作台 AI 建议模块（ai-suggest）相互独立——
 * 本测试只打 /ai-waste 端点，不与 /ai-suggestions 交叉验证。
 *
 * 前置：npm run build（dist 为准）；DB_TYPE=mssql 直连 CN_AME。
 * 运行：node test/ai-waste-contract.cjs
 *
 * 设计：
 *  - 不依赖真实 LLM：内置 http mock 端点（OpenAI /chat/completions 协议），
 *    按场景返回合法/非法 findings+issues JSON，验证 W1-W3 校验与落库闭环；
 *  - AI 开关两阶段：AI_SUGGEST_ENABLED=false 验证 503/403，
 *    再动态 AppModule 开启验证完整闭环（与 ai-suggest 契约测试同模式）；
 *  - W1-W3 规则抽测直接调用编译产物 dist/modules/ai-waste/validator.js 纯函数；
 *  - 造数：走 API submit 带 source='ai_assisted'（与生产链口径一致）。
 */
process.env.DB_TYPE = process.env.DB_TYPE || 'mssql';
require('dotenv').config();
require('reflect-metadata');
const { createServer } = require('node:http');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module.js');
const { AllExceptionsFilter } = require('../dist/src/core/all-exceptions.filter.js');
const { loadConfig } = require('../dist/src/core/config/configuration.js');

const PASS = '\x1b[32m\u2713\x1b[0m';
const FAIL = '\x1b[31m\u2717\x1b[0m';
let ok = 0;
let fail = 0;
const failures = [];

/** v3.45 QA：同会话工位 ID 防相撞（随机 ST10-99 多工位有碰撞概率；相撞会致后建的
 *  purgeByName 误删先建同会话工位数据 → 级联失败。既有基线沿用随机，此处收敛为唯一分配） */
const usedStationIds = new Set();
function nextStationId() {
  for (let i = 0; i < 500; i++) {
    const id = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
    if (!usedStationIds.has(id)) { usedStationIds.add(id); return id; }
  }
  throw new Error('nextStationId: 500 次未分配到唯一工位 ID');
}

function check(name, cond, detail) {
  if (cond) { ok++; console.log(`  ${PASS} ${name}`); }
  else {
    fail++;
    const d = detail === undefined ? '' : ` \u2192 ${JSON.stringify(detail).slice(0, 260)}`;
    failures.push(name + d);
    console.log(`  ${FAIL} ${name}${d}`);
  }
}

async function api(base, method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, data: json, text };
}

// ───────────────────────── mock LLM 端点 ─────────────────────────

let mockScene = () => ({ findings: [], issues: [] });
let mockCallCount = 0;
/** v3.45 QA：捕获最后一次 LLM 请求体（OpenAI {messages:[...]}——WV2 prompt 内容断言用） */
let lastLlmRequest = null;

/** OpenAI /chat/completions 协议 mock：按场景返回预置 findings+issues JSON 对象 */
function startMockLlm(port) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mockCallCount++;
      try { lastLlmRequest = JSON.parse(body); } catch { lastLlmRequest = { _raw: body }; }
      const payload = mockScene();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) } }],
        usage: { total_tokens: 420 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ───────────────────────── 测试数据准备（直连 DB） ─────────────────────────

const cfg = loadConfig();

async function dbExec(sql, params = []) {
  if (cfg.dbType === 'mssql') {
    const sqlmod = require('mssql');
    const pool = await sqlmod.connect({
      server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
      options: { encrypt: false, trustServerCertificate: true },
    });
    try {
      const req = pool.request();
      params.forEach((p, i) => req.input(`p${i}`, p));
      await req.query(sql);
      return;
    } finally { await pool.close(); }
  }
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(cfg.dbPath);
  try { raw.prepare(sql).run(...params); } finally { raw.close(); }
}

async function dbQuery(sql, params = []) {
  if (cfg.dbType === 'mssql') {
    const sqlmod = require('mssql');
    const pool = await sqlmod.connect({
      server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
      options: { encrypt: false, trustServerCertificate: true },
    });
    try {
      const req = pool.request();
      params.forEach((p, i) => req.input(`p${i}`, p));
      const r = await req.query(sql);
      return r.recordset;
    } finally { await pool.close(); }
  }
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(cfg.dbPath);
  try { return raw.prepare(sql).all(...params); } finally { raw.close(); }
}

/** v3.42 重名护栏适配：按名清历史残留（随机 ST 序号跨轮次累积，同名会让 create 400） */
async function purgeByName(name) {
  const rows = await dbQuery("SELECT station_id FROM t_station WHERE name = '" + name + "'").catch(() => []);
  const ids = rows.map((r) => r.station_id);
  if (ids.length === 0) return;
  const inIds = ids.map((i) => "'" + i + "'").join(',');
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_suggestion WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_suggestion_batch WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_station_collaborator WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id IN (${inIds})`).catch(() => {});
}

/**
 * 建测试工位 + 提交 AI 分解要素（source='ai_assisted'，走 API 与生产链口径一致）。
 * v1 四要素（rating 1 / allowance 0.15 → ST=dur×1.15）：
 *  seq1 持住(NVA) 3.2→ST3.68 ｜ seq2 移物(VA) 2.8→ST3.22 ｜ seq3 寻找(RNVA) 2.5→ST2.88 ｜ seq4 可避免延迟(NVA) 2.0→ST2.30
 * AI 子集 CT = 3.68+3.22+2.88+2.30 = 12.08
 */
async function setupAiStation(base, token, stationId, name) {
  await purgeByName(name);
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id = '${stationId}'`).catch(() => {});
  await api(base, 'POST', '/api/stations', { token, body: { station_id: stationId, line_id: 'L01', name, tt: 40 } });
  const mk = (seq, start_ms, dur_s, hand, type, desc, va_class) => ({
    seq, start_ms, dur_s, hand, type, desc, va_class, source: 'ai_assisted', rating: 1, allowance: 0.15,
  });
  const elements = [
    mk(1, 0, 3.2, 'R', '持住', '手持住扶壳体', 'NVA'),
    mk(2, 3200, 2.8, 'R', '移物', '取前壳', 'VA'),
    mk(3, 6000, 2.5, 'R', '寻找', '目视寻找料件', 'RNVA'),
    mk(4, 8500, 2.0, 'L', '可避免延迟', '等上件', 'NVA'),
  ];
  await api(base, 'POST', `/api/stations/${stationId}/elements/submit`, { token, body: { cycle_count: 15, cv: 0.05, elements } });
}

/** 造手工分解工位（source=manual）——v3.45：AI 线拒绝（400）/ 手工线闭环（generate-manual） */
async function setupManualStation(base, token, stationId, name) {
  await purgeByName(name);
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id = '${stationId}'`).catch(() => {});
  await api(base, 'POST', '/api/stations', { token, body: { station_id: stationId, line_id: 'L01', name, tt: 40 } });
  const elements = [
    { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
    { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
  ];
  await api(base, 'POST', `/api/stations/${stationId}/elements/submit`, { token, body: { cycle_count: 15, cv: 0.05, elements } });
}

/**
 * 造手工分解工位（含 1 个异常点要素 outlier_flag=1）——v3.45 QA B7 专用。
 * 三要素（rating 1 / allowance 0.15 → ST=dur×1.15，均 source=manual 提交默认值）：
 *  seq1 持住(NVA) 3.2→ST3.68 ｜ seq2 移物(VA) 2.8→ST3.22 ｜ seq3 寻找(RNVA) 2.5→ST2.88【异常点】
 * manual 子集 CT = 3.68+3.22 = 6.90（异常点 2.88 不入 CT、不进 ctx.elements）
 */
async function setupManualStationOutlier(base, token, stationId, name) {
  await purgeByName(name);
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id = '${stationId}'`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id = '${stationId}'`).catch(() => {});
  await api(base, 'POST', '/api/stations', { token, body: { station_id: stationId, line_id: 'L01', name, tt: 40 } });
  const elements = [
    { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
    { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
    { seq: 3, start_ms: 6000, dur_s: 2.5, hand: 'R', type: '寻找', desc: '目视寻找料件', va_class: 'RNVA', rating: 1, allowance: 0.15, outlier_flag: 1, outlier_reason: '秒表停顿记为异常点' },
  ];
  await api(base, 'POST', `/api/stations/${stationId}/elements/submit`, { token, body: { cycle_count: 15, cv: 0.05, elements } });
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  // Phase 0：清理（t_ai_setting 清空使 env 回落生效；残留批次清理）
  // v3.48：ai-waste effectiveAi 与 ai-suggest 对齐三级优先（启用 profile → t_ai_setting → env），
  // 启用的真实端点（方舟）会覆盖 env 的 mock 地址——启动时临时熄灭、结束时还原（不删行，最小侵入）。
  const profileRows = await dbQuery("SELECT profile_id FROM t_ai_llm_profile WHERE enabled = 1").catch(() => []);
  if (profileRows.length > 0) await dbExec("UPDATE t_ai_llm_profile SET enabled = 0 WHERE enabled = 1");
  await dbExec('DELETE FROM t_ai_setting').catch(() => {});
  await dbExec("DELETE FROM t_ai_waste_issue WHERE station_id LIKE 'L01-ST%' OR station_id = 'L02-ST01'").catch(() => {});
  await dbExec("DELETE FROM t_ai_waste_finding WHERE station_id LIKE 'L01-ST%' OR station_id = 'L02-ST01'").catch(() => {});
  await dbExec("DELETE FROM t_ai_waste_batch WHERE station_id LIKE 'L01-ST%' OR station_id = 'L02-ST01'").catch(() => {});

  // ── Phase A：AI_SUGGEST_ENABLED=false → 503/403 ──
  process.env.AI_SUGGEST_ENABLED = 'false';
  const appOff = await NestFactory.create(AppModule, { logger: false });
  appOff.setGlobalPrefix('api');
  appOff.useGlobalFilters(new AllExceptionsFilter());
  appOff.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await appOff.listen(0);
  const baseOff = `http://127.0.0.1:${appOff.getHttpServer().address().port}`;

  console.log('\n[Phase A] AI_SUGGEST_ENABLED=false（服务关）');
  const adminOff = await api(baseOff, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const adminTokenOff = adminOff.data.accessToken;
  const stOff = nextStationId();
  await setupAiStation(baseOff, adminTokenOff, stOff, '浪费契约关闭态工位');

  const genOff = await api(baseOff, 'POST', `/api/stations/${stOff}/ai-waste/generate`, { token: adminTokenOff });
  check('服务关：generate → 503', genOff.status === 503, genOff.status);
  const latOff = await api(baseOff, 'GET', `/api/stations/${stOff}/ai-waste/latest`, { token: adminTokenOff });
  check('服务关：latest → 503', latOff.status === 503, latOff.status);
  const viewerOff = await api(baseOff, 'POST', '/api/auth/login', { body: { username: 'viewer1', password: '123456' } });
  const viewerGen = await api(baseOff, 'POST', `/api/stations/${stOff}/ai-waste/generate`, { token: viewerOff.data.accessToken });
  check('无权限 viewer：generate → 403（权限先于开关）', viewerGen.status === 403, viewerGen.status);

  await appOff.close();

  // ── Phase B：AI_SUGGEST_ENABLED=true + mock LLM 完整闭环 ──
  process.env.AI_SUGGEST_ENABLED = 'true';
  process.env.AI_LLM_BASE_URL = 'http://127.0.0.1:19101/v1';
  const mock = await startMockLlm(19101);

  const appOn = await NestFactory.create(AppModule, { logger: false });
  appOn.setGlobalPrefix('api');
  appOn.useGlobalFilters(new AllExceptionsFilter());
  appOn.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await appOn.listen(0);
  const base = `http://127.0.0.1:${appOn.getHttpServer().address().port}`;

  const admin = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const adminToken = admin.data.accessToken;
  const viewer = await api(base, 'POST', '/api/auth/login', { body: { username: 'viewer1', password: '123456' } });

  // ── 边界：手工分解工位拒绝 ──
  console.log('\n[Phase B1] 分解方式边界（source=ai_assisted 专属）');
  const stManual = nextStationId();
  await setupManualStation(base, adminToken, stManual, '手工分解工位');
  mockScene = () => ({ findings: [], issues: [] });
  mockCallCount = 0;
  const genManual = await api(base, 'POST', `/api/stations/${stManual}/ai-waste/generate`, { token: adminToken });
  check('手工分解工位 generate（AI 线）→ 400（两线按 source 隔离）', genManual.status === 400, genManual.status);
  check('边界拒绝发生在 LLM 调用之前（mock 0 次）', mockCallCount === 0, mockCallCount);

  // ── v3.45 手工分解线闭环（generate-manual）+ 跨线隔离 ──
  console.log('\n[Phase B1b] 手工分解线 generate-manual（v3.45 双来源线）');
  mockScene = () => ({
    findings: [{ element_seqs: [1], waste_type: '持住', evidence: '手工分解线单手扶住壳体全程无任何加工' }],
    issues: [{ element_seqs: [1], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '取消', suggestion: '治具夹持替代人工持住壳体动作' }],
  });
  mockCallCount = 0;
  const genManualOk = await api(base, 'POST', `/api/stations/${stManual}/ai-waste/generate-manual`, { token: adminToken });
  check('手工分解工位 generate-manual → 200 done', genManualOk.status === 200 && genManualOk.data?.status === 'done', `${genManualOk.status}/${genManualOk.data?.status}`);
  check('手工线批次 element_source=manual', genManualOk.data?.element_source === 'manual', genManualOk.data?.element_source);
  check('手工线确实调用了 LLM（mock ≥1 次）', mockCallCount >= 1, mockCallCount);
  const latManual = await api(base, 'GET', `/api/stations/${stManual}/ai-waste/latest?source=manual`, { token: adminToken });
  check('latest?source=manual → 命中手工线批次（findings 1 条）',
    latManual.status === 200 && (latManual.data?.findings ?? []).length === 1 && latManual.data?.batch_id, latManual.data?.batch_id);
  const latCross = await api(base, 'GET', `/api/stations/${stManual}/ai-waste/latest?source=ai_assisted`, { token: adminToken });
  check('跨线隔离：latest?source=ai_assisted 不返回手工线批次（batch=null）',
    latCross.status === 200 && latCross.data?.batch_id == null, latCross.data?.batch_id);
  mockCallCount = 0;
  const genManualAgain = await api(base, 'POST', `/api/stations/${stManual}/ai-waste/generate-manual`, { token: adminToken });
  check('手工线重复生成 → 200 幂等命中且不调 LLM',
    genManualAgain.status === 200 && genManualAgain.data?.idempotent_hit === true && mockCallCount === 0,
    `${genManualAgain.data?.idempotent_hit}/${mockCallCount}`);
  const batsManual = await api(base, 'GET', `/api/stations/${stManual}/ai-waste/batches?source=manual`, { token: adminToken });
  check('batches?source=manual → 只含手工线批次',
    batsManual.status === 200 && (batsManual.data?.batches ?? []).length === 1 && batsManual.data.batches[0].element_source === 'manual',
    batsManual.data?.batches?.length);

  // ── 正常生成闭环 ──
  console.log('\n[Phase B2] 生成闭环（合法 findings+issues → W 校验 → 数字服务端算 → 落库）');
  const stId = nextStationId();
  await setupAiStation(base, adminToken, stId, '浪费契约主工位');
  // 场景1：合法 + 故意带数字字段（服务端须剥除重算）+ 一条编造 waste_type（白名单剔除）
  // 白名单实际词表（DB active 规则）：持住/重复取放/搬运/等待/寻找选择/检验冗余/预对
  mockScene = () => ({
    findings: [
      { element_seqs: [1], waste_type: '持住', evidence: '全程单手扶住壳体无任何加工', severity: 9, pct_of_ct: 55.5 },
      { element_seqs: [3], waste_type: '寻找选择', evidence: '目视扫描料盒反复确认位置', involved_s: 88 },
      { element_seqs: [99], waste_type: '搬运', evidence: '引用不存在的seq99防幻觉', },
      { element_seqs: [2], waste_type: '魔法浪费', evidence: '编造的浪费类型应被剔除', },
    ],
    issues: [
      { element_seqs: [1], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '取消', suggestion: '治具夹持替代人工持住壳体动作' },
      { element_seqs: [3], waste_type: '寻找选择', problem: '目视寻找料件位置不确定', ecrs: '简化', suggestion: '供料定位唯一化一穴一件取放' },
      { element_seqs: [2], waste_type: '搬运', problem: '对增值移物动作提出取消要求', ecrs: '取消', suggestion: '取消取前壳的增值移物动作行为' },
    ],
  });
  mockCallCount = 0;
  const gen1 = await api(base, 'POST', `/api/stations/${stId}/ai-waste/generate`, { token: adminToken });
  check('生成 → 200 且非幂等命中', gen1.status === 200 && gen1.data?.idempotent_hit !== true, gen1.status);
  check('批次状态=done 且 tokens_used>0', gen1.data?.status === 'done' && Number(gen1.data?.tokens_used) > 0, gen1.data?.status);
  const fs1 = gen1.data?.findings ?? [];
  const is1 = gen1.data?.issues ?? [];
  check('浪费点 2 条落库（seq99 防幻觉剔除 + 编造词剔除）', fs1.length === 2, fs1.length);
  check('问题清单 2 条落库（VA+E 第 3 条被 W2.1 拦截）', is1.length === 2, is1.length);
  const holdF = fs1.find((f) => f.waste_type === '持住');
  const seekF = fs1.find((f) => f.waste_type === '寻找选择');
  check('浪费点 element_refs 回传 seq 数组', holdF && Array.isArray(holdF.element_seqs) && holdF.element_seqs[0] === 1, holdF?.element_seqs);
  check('LLM 数字被剥：severity/involved_s/pct_of_ct 全服务端算（持住 ST=3.68）', holdF && Math.abs(holdF.involved_s - 3.68) < 0.01 && Math.abs(holdF.pct_of_ct - 30.46) < 0.5 && holdF.severity === 3, holdF);
  check('pct_of_ct ≥15% → severity=3（严重档）', holdF?.severity === 3, holdF?.severity);
  check('寻找 ST=2.88 → pct=23.8% ≥15% → severity=3', seekF && Math.abs(seekF.involved_s - 2.88) < 0.01 && seekF.severity === 3, seekF);
  const holdI = is1.find((i) => i.ecrs === 'E');
  const seekI = is1.find((i) => i.ecrs === 'S');
  check('ECRS 语义解析：「取消」→ E', holdI?.ecrs === 'E', holdI?.ecrs);
  check('ECRS 语义解析：「简化」→ S', seekI?.ecrs === 'S', seekI?.ecrs);
  check('E 全额 est_save_s=3.68（ΣST×1.0）', holdI && Math.abs(holdI.est_save_s - 3.68) < 0.01, holdI?.est_save_s);
  check('S 保守折算 est_save_s=1.44（ΣST×0.5）', seekI && Math.abs(seekI.est_save_s - 1.44) < 0.01, seekI?.est_save_s);
  check('priority 归一化：最高=100 且 tier=P1', is1[0]?.priority === 100 && is1[0]?.tier === 'P1', is1[0]);
  check('priority 次档按占比降档（1.44/3.68≈39<40 → 非P1）', is1[1] && is1[1].priority < 100 && is1[1].tier !== 'P1', is1[1]);
  check('状态初始=待处理（铁律①永远待审）', is1.every((i) => i.status === '待处理'), is1.map((i) => i.status));
  check('校验轨迹落库（validation_trace 可解析）', is1.every((i) => Array.isArray(i.validation_trace) && i.validation_trace.length > 0), 'trace');
  check('mock LLM 被真实调用 1 次', mockCallCount === 1, mockCallCount);

  // ── 幂等 + latest + batches ──
  console.log('\n[Phase B3] 幂等 / latest / batches');
  mockCallCount = 0;
  const genAgain = await api(base, 'POST', `/api/stations/${stId}/ai-waste/generate`, { token: adminToken });
  check('同工位重复生成 → 200 幂等命中 idempotent_hit=true', genAgain.status === 200 && genAgain.data?.idempotent_hit === true, genAgain.data?.idempotent_hit);
  check('幂等命中不调 LLM', mockCallCount === 0, mockCallCount);
  const lat = await api(base, 'GET', `/api/stations/${stId}/ai-waste/latest`, { token: adminToken });
  check('latest → 200 且批次/findings/issues 齐全', lat.status === 200 && lat.data?.batch_id && (lat.data?.findings ?? []).length === 2 && (lat.data?.issues ?? []).length === 2, lat.data?.batch_id);
  const bats = await api(base, 'GET', `/api/stations/${stId}/ai-waste/batches`, { token: adminToken });
  check('batches → 200 且含 done 批次', bats.status === 200 && (bats.data?.batches ?? []).some((b) => b.status === 'done'), bats.data?.batches?.length);
  mockCallCount = 0;
  const genManualOnAi = await api(base, 'POST', `/api/stations/${stId}/ai-waste/generate-manual`, { token: adminToken });
  check('AI 分解工位 generate-manual → 400（无 source=manual 要素，不调 LLM）',
    genManualOnAi.status === 400 && mockCallCount === 0, `${genManualOnAi.status}/${mockCallCount}`);

  // ── 状态流转：确认 → t_improvement；忽略 → 终态 ──
  console.log('\n[Phase B4] 状态流转（确认→t_improvement source=ai；忽略→终态）');
  const impBefore = await dbQuery(`SELECT COUNT(*) AS n FROM t_improvement WHERE station_id = '${stId}'`);
  check('确认前无改善记录', Number(impBefore[0]?.n ?? 0) === 0, impBefore[0]);
  const settle1 = await api(base, 'POST', `/api/ai-waste/issues/${is1[0].issue_id}/settle`, { token: adminToken, body: { status: '已确认' } });
  check('确认 P1 条目 → 200 且 imp_id 回写', settle1.status === 200 && /^IMP-/.test(settle1.data?.imp_id ?? ''), settle1.data?.imp_id);
  const impRows = await dbQuery(`SELECT * FROM t_improvement WHERE ai_suggestion_id = '${is1[0].issue_id}'`);
  check('t_improvement 复制：source=ai + status=待实施 + 溯源 ai_suggestion_id=issue_id',
    impRows.length === 1 && impRows[0].source === 'ai' && impRows[0].status === '待实施', impRows[0]?.source);
  check('measure 组装「问题｜改善建议：…」', /改善建议：/.test(impRows[0]?.measure ?? ''), impRows[0]?.measure);
  const settleRepeat = await api(base, 'POST', `/api/ai-waste/issues/${is1[0].issue_id}/settle`, { token: adminToken, body: { status: '已忽略' } });
  check('重复流转（已确认再流转）→ 409', settleRepeat.status === 409, settleRepeat.status);
  const settleMissing = await api(base, 'POST', '/api/ai-waste/issues/NO-SUCH-ID/settle', { token: adminToken, body: { status: '已确认' } });
  check('流转不存在条目 → 404', settleMissing.status === 404, settleMissing.status);
  const settleBad = await api(base, 'POST', `/api/ai-waste/issues/${is1[1].issue_id}/settle`, { token: adminToken, body: { status: '随便' } });
  check('非法 status → 400（DTO IsIn 拦截）', settleBad.status === 400, settleBad.status);
  const ignore1 = await api(base, 'POST', `/api/ai-waste/issues/${is1[1].issue_id}/settle`, { token: adminToken, body: { status: '已忽略' } });
  check('忽略 → 200 且 status=已忽略 reviewed_by=admin', ignore1.status === 200 && ignore1.data?.status === '已忽略' && ignore1.data?.reviewed_by === 'admin', ignore1.data);
  const ignoreRepeat = await api(base, 'POST', `/api/ai-waste/issues/${is1[1].issue_id}/settle`, { token: adminToken, body: { status: '已确认' } });
  check('已忽略再流转 → 409（终态）', ignoreRepeat.status === 409, ignoreRepeat.status);

  // ── done_empty（LLM 返回空）+ failed 场景 ──
  console.log('\n[Phase B5] done_empty / failed / 重开');
  const stEmpty = nextStationId();
  await setupAiStation(base, adminToken, stEmpty, '空结果工位');
  mockScene = () => ({ findings: [], issues: [] });
  const genEmpty = await api(base, 'POST', `/api/stations/${stEmpty}/ai-waste/generate`, { token: adminToken });
  check('LLM 返回空 → done_empty', genEmpty.status === 200 && genEmpty.data?.status === 'done_empty', genEmpty.data?.status);
  // failed：LLM 返回不可解析文本
  const stFail = nextStationId();
  await setupAiStation(base, adminToken, stFail, '失败重开工位');
  // mock LLM 返回不可解析文本（重试 1 次后仍失败 → 503 failed 批落库）
  mockScene = () => '抱歉，我无法以 JSON 格式回答这个问题。';
  const genFail = await api(base, 'POST', `/api/stations/${stFail}/ai-waste/generate`, { token: adminToken });
  check('LLM 返回不可解析 → 503 failed', genFail.status === 503, genFail.status);
  const failRow = await dbQuery(`SELECT status, error FROM t_ai_waste_batch WHERE station_id = '${stFail}'`);
  check('失败批次落库 status=failed 且 error 有值', failRow.length >= 1 && failRow[0].status === 'failed' && !!failRow[0].error, failRow[0]);
  // 重开（复用 failed 批）：恢复正常输出
  mockScene = () => ({
    findings: [{ element_seqs: [1], waste_type: '持住', evidence: '复用失败批次后重新识别成功' }],
    issues: [{ element_seqs: [1], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '取消', suggestion: '治具夹持替代人工持住壳体动作' }],
  });
  const genRetry = await api(base, 'POST', `/api/stations/${stFail}/ai-waste/generate`, { token: adminToken });
  check('failed 批重开 → 200 done', genRetry.status === 200 && genRetry.data?.status === 'done', genRetry.data?.status);
  const retryBatch = await dbQuery(`SELECT batch_id FROM t_ai_waste_batch WHERE station_id = '${stFail}'`);
  check('重开复用 failed 批（不新增批）', retryBatch.length === 1, retryBatch.length);

  // ── W1-W3 规则抽测（纯函数直调编译产物） ──
  console.log('\n[Phase B6] W1-W3 规则抽测（validator 纯函数）');
  const { checkWastePayload, parseEcrs, severityOf } = require('../dist/src/modules/ai-waste/validator.js');
  const els = [
    { seq: 1, type: '持住', va_class: 'NVA', dur_s: 3.2, std_time: 3.68, desc: '扶住' },
    { seq: 2, type: '移物', va_class: 'VA', dur_s: 2.8, std_time: 3.22, desc: '取件' },
    { seq: 3, type: '寻找', va_class: 'RNVA', dur_s: 2.5, std_time: 2.88, desc: '寻找' },
  ];
  const mkCtx = (elements, whitelist) => ({ elements, ct: elements.reduce((a, e) => a + e.std_time, 0), wasteWhitelist: whitelist, issueCeiling: 12 });
  const WL = ['持住', '寻找选择', '搬运'];

  // W3.0 CT<=0 整批阻断
  const rCt = checkWastePayload([{ element_seqs: [1], waste_type: '持住', evidence: '任何条目都不该通过' }], [], mkCtx([], WL));
  check('W3.0 无要素/CT<=0 → 整批阻断', !!rCt.batchBlocked, rCt.batchBlocked);
  // W1.2 白名单
  const rWl = checkWastePayload([{ element_seqs: [1], waste_type: '魔法浪费', evidence: '编造浪费类型应被剔除' }], [], mkCtx(els, WL));
  check('W1.2 白名单外 waste_type → 剔除', rWl.findings.length === 0 && rWl.trace.some((t) => t.rule === 'W1.2' && t.hit), rWl.trace.length);
  // W1.3 防幻觉
  const rPh = checkWastePayload([{ element_seqs: [88], waste_type: '持住', evidence: '引用不存在的要素序列号' }], [], mkCtx(els, WL));
  check('W1.3 引用不存在 seq → 剔除', rPh.findings.length === 0 && rPh.trace.some((t) => t.rule === 'W1.3' && t.hit), rPh.findings.length);
  // W1.3 部分无效裁剪保留
  const rPh2 = checkWastePayload([{ element_seqs: [1, 99], waste_type: '持住', evidence: '部分引用无效仍保留有效部分' }], [], mkCtx(els, WL));
  check('W1.3 部分无效 → 裁剪保留有效 seq[1]', rPh2.findings.length === 1 && rPh2.findings[0].seqs[0] === 1, rPh2.findings[0]?.seqs);
  // W1.4 evidence 过短
  const rLen = checkWastePayload([{ element_seqs: [1], waste_type: '持住', evidence: '太短' }], [], mkCtx(els, WL));
  check('W1.4 evidence<6 字 → 剔除', rLen.findings.length === 0 && rLen.trace.some((t) => t.rule === 'W1.4' && t.hit), rLen.findings.length);
  // W1.5 去重
  const dupF = () => [{ element_seqs: [1], waste_type: '持住', evidence: '完全相同的第一条证据内容' }, { element_seqs: [1], waste_type: '持住', evidence: '完全相同的第一条证据内容' }];
  const rDup = checkWastePayload(dupF(), [], mkCtx(els, WL));
  check('W1.5 同要素集+同类型 → 去重留 1', rDup.findings.length === 1, rDup.findings.length);
  // W2.1 VA 禁 E
  const rVa = checkWastePayload([], [{ element_seqs: [2], waste_type: '搬运', problem: '对增值移物提出取消的要求', ecrs: '取消', suggestion: '取消这个增值的移物动作行为' }], mkCtx(els, WL));
  check('W2.1 VA+E → 剔除（改善建议不得取消增值动作）', rVa.issues.length === 0 && rVa.trace.some((t) => t.rule === 'W2.1' && t.hit), rVa.issues.length);
  // W2.2 语义解析
  check('W2.2 parseEcrs：「合并」→ C', parseEcrs('两步合并为一次抓取') === 'C', parseEcrs('两步合并为一次抓取'));
  check('W2.2 parseEcrs：「重排」→ R', parseEcrs('重排工位布局缩短距离') === 'R', parseEcrs('重排工位布局缩短距离'));
  check('W2.2 parseEcrs：默认兜底 S', parseEcrs('改善动作描述文本') === 'S', parseEcrs('改善动作描述文本'));
  // W3.1 单要素 ≤2 条
  const three = (n) => ({ element_seqs: [1], waste_type: '持住', problem: `同要素第${n}条问题描述文本`, ecrs: '简化', suggestion: '对应的改善建议描述文本内容' });
  const r31 = checkWastePayload([], [three(1), three(2), three(3)], mkCtx(els, WL));
  check('W3.1 单要素引用 ≤2 条 → 第 3 条裁剪', r31.issues.length === 2 && r31.trace.some((t) => t.rule === 'W3.1' && t.hit), r31.issues.length);
  // W3.2 问题清单上界（13 要素单 seq 轮转：循环内 distinct seq 恰好 12 不触发 W2.3 早截，
  // 13 条全过 W3.1（每 seq 仅 1 条）→ 撞 12 上界 → W3.2 裁到 12）
  const els13 = Array.from({ length: 13 }, (_, i) => ({ seq: i + 1, type: '持住', va_class: 'NVA', dur_s: 2, std_time: 2.3, desc: `e${i}` }));
  const many = [];
  for (let i = 0; i < 16; i++) many.push({ element_seqs: [(i % 13) + 1], waste_type: '持住', problem: `批量上界测试问题条目${i}号`, ecrs: '简化', suggestion: `对应的改善建议描述内容第${i}条` });
  const r32 = checkWastePayload([], many, mkCtx(els13, WL));
  check('W3.2 问题清单超上界 12 → 裁剪', r32.issues.length === 12 && r32.trace.some((t) => t.rule === 'W3.2' && t.hit), r32.issues.length);
  // severity 分档
  check('severityOf：≥15→3 / ≥8→2 / <8→1', severityOf(16) === 3 && severityOf(10) === 2 && severityOf(5) === 1, 'severityOf');

  // ── Phase B7：手工分解线缺口断言（v3.45 QA 扩充：WV2 落库 / outlier 拦截 / ct+summary /
  //    409 running / settle / 403+503 / 双向隔离最强反证 / WV2 prompt 内容） ──
  console.log('\n[Phase B7] 手工分解线缺口断言（v3.45 QA 扩充）');
  const stOut = nextStationId();
  await setupManualStationOutlier(base, adminToken, stOut, '手工分解异常点工位');
  const stOutVer = (await dbQuery(`SELECT version FROM t_station WHERE station_id = '${stOut}'`))[0]?.version;

  // B7-1 409：构造同源 running 批 → generate-manual → 409 AI_WASTE_IN_PROGRESS（先于 LLM）
  await dbExec(`INSERT INTO t_ai_waste_batch (batch_id, station_id, tenant_id, version, user_id, status, element_source, element_count, created_at, updated_at) VALUES ('qa-b7-running-${stOut}', '${stOut}', 'DEFAULT', ${stOutVer}, 'admin', 'running', 'manual', 2, SYSUTCDATETIME(), SYSUTCDATETIME())`);
  mockCallCount = 0;
  const gen409 = await api(base, 'POST', `/api/stations/${stOut}/ai-waste/generate-manual`, { token: adminToken });
  check('手工线 running 中二次 generate-manual → 409 AI_WASTE_IN_PROGRESS',
    gen409.status === 409 && gen409.data?.code === 'AI_WASTE_IN_PROGRESS',
    `${gen409.status}/${JSON.stringify(gen409.data).slice(0, 120)}`);
  check('409 发生在 LLM 调用之前（mock 0 次）', mockCallCount === 0, mockCallCount);
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE batch_id = 'qa-b7-running-${stOut}'`).catch(() => {});

  // B7-2 WV2 prompt + outlier 引用拦截 + ct/summary 服务端口径
  mockScene = () => ({
    findings: [
      { element_seqs: [1], waste_type: '持住', evidence: '手工分解线单手扶住壳体全程无任何加工', severity: 9, pct_of_ct: 88.8, involved_s: 66.6 },
      { element_seqs: [3], waste_type: '持住', evidence: '引用异常点seq3的浪费点应被W1.3整条剔除' },
    ],
    issues: [
      { element_seqs: [1], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '取消', suggestion: '治具夹持替代人工持住壳体动作', priority: 999, est_save_s: 66.6 },
      { element_seqs: [2], waste_type: '搬运', problem: '移物取前壳路径可优化缩短距离', ecrs: '简化', suggestion: '供料定位唯一化一穴一件取放' },
    ],
  });
  mockCallCount = 0;
  lastLlmRequest = null;
  const genB7 = await api(base, 'POST', `/api/stations/${stOut}/ai-waste/generate-manual`, { token: adminToken });
  check('手工线 generate-manual → 200 done', genB7.status === 200 && genB7.data?.status === 'done', `${genB7.status}/${genB7.data?.status}`);
  check('manual 批 prompt_version=WV2（响应载荷）', genB7.data?.prompt_version === 'WV2', genB7.data?.prompt_version);
  const b7BatchRow = await dbQuery(`SELECT prompt_version, element_source FROM t_ai_waste_batch WHERE batch_id = '${genB7.data?.batch_id}'`);
  check('manual 批 prompt_version=WV2 落库（DB 实证）', b7BatchRow[0]?.prompt_version === 'WV2' && b7BatchRow[0]?.element_source === 'manual', b7BatchRow[0]);
  const fB7 = genB7.data?.findings ?? [];
  const iB7 = genB7.data?.issues ?? [];
  check('outlier seq 引用被 W1.3 整条剔除（findings 仅剩 1 条）', fB7.length === 1, fB7.length);
  check('outlier 的 ST 不计入任何数字（finding involved_s=3.68 不含 2.88）',
    fB7[0] && Math.abs(fB7[0].involved_s - 3.68) < 0.01, fB7[0]?.involved_s);
  check('ct=6.90（manual 子集 ΣST；异常点 2.88 不入 CT）', Math.abs(genB7.data?.ct - 6.9) < 0.01, genB7.data?.ct);
  check('finding 数字全服务端算（pct_of_ct=53.33 / severity=3，LLM 的 88.8/9/66.6 被剥）',
    fB7[0] && Math.abs(fB7[0].pct_of_ct - 53.33) < 0.05 && fB7[0].severity === 3, fB7[0]);
  check('issues 2 条落库（E 全额 3.68 / S 折算 1.61；LLM 的 999/66.6 被剥）',
    iB7.length === 2 && Math.abs((iB7.find((x) => x.ecrs === 'E')?.est_save_s ?? -1) - 3.68) < 0.01 && Math.abs((iB7.find((x) => x.ecrs === 'S')?.est_save_s ?? -1) - 1.61) < 0.01,
    iB7.map((x) => `${x.ecrs}:${x.est_save_s}`));
  const sumB7 = genB7.data?.summary ?? {};
  check('summary.by_type={持住:1}（异常点引用条目不计入分布）',
    sumB7.by_type && sumB7.by_type['持住'] === 1 && Object.keys(sumB7.by_type).length === 1, sumB7.by_type);
  check('summary.total_est_save_s=5.29（3.68+1.61）', Math.abs((sumB7.total_est_save_s ?? -1) - 5.29) < 0.01, sumB7.total_est_save_s);
  check('summary.est_pct_of_ct=76.67（5.29/6.90）', Math.abs((sumB7.est_pct_of_ct ?? -1) - 76.67) < 0.05, sumB7.est_pct_of_ct);

  // B7-3 WV2 prompt 内容（mock 捕获请求体）
  const userMsg = (lastLlmRequest?.messages ?? []).find((m) => m.role === 'user');
  const promptText = String(userMsg?.content ?? '');
  check('WV2 prompt 首行含「手工分解写入」（decomposition_source 措辞）',
    promptText.split('\n')[0].includes('手工分解写入'), promptText.split('\n')[0].slice(0, 80));
  check('WV2 prompt 含「操作异常点」段且明示不计 CT/禁引用',
    promptText.includes('操作异常点') && promptText.includes('不计入 CT') && promptText.includes('不得在 element_seqs 中引用'),
    promptText.includes('操作异常点'));

  // B7-4 manual 线 settle：确认→t_improvement / 忽略→终态 / 重复流转 409
  const mIssueE = iB7.find((x) => x.ecrs === 'E');
  const mIssueS = iB7.find((x) => x.ecrs === 'S');
  const settleB7 = await api(base, 'POST', `/api/ai-waste/issues/${mIssueE.issue_id}/settle`, { token: adminToken, body: { status: '已确认' } });
  check('手工线确认 → 200 且 imp_id 回写', settleB7.status === 200 && /^IMP-/.test(settleB7.data?.imp_id ?? ''), settleB7.data?.imp_id);
  const impB7 = await dbQuery(`SELECT source, status, ai_suggestion_id FROM t_improvement WHERE ai_suggestion_id = '${mIssueE.issue_id}'`);
  check('手工线 t_improvement：source=ai / status=待实施 / 溯源 ai_suggestion_id=issue_id',
    impB7.length === 1 && impB7[0].source === 'ai' && impB7[0].status === '待实施', impB7[0]);
  const settleB7Repeat = await api(base, 'POST', `/api/ai-waste/issues/${mIssueE.issue_id}/settle`, { token: adminToken, body: { status: '已忽略' } });
  check('手工线已确认再流转 → 409', settleB7Repeat.status === 409, settleB7Repeat.status);
  const settleB7Ignore = await api(base, 'POST', `/api/ai-waste/issues/${mIssueS.issue_id}/settle`, { token: adminToken, body: { status: '已忽略' } });
  check('手工线忽略 → 200 且 status=已忽略', settleB7Ignore.status === 200 && settleB7Ignore.data?.status === '已忽略', settleB7Ignore.data?.status);
  const settleB7IgnoreRepeat = await api(base, 'POST', `/api/ai-waste/issues/${mIssueS.issue_id}/settle`, { token: adminToken, body: { status: '已确认' } });
  check('手工线已忽略再流转 → 409（终态）', settleB7IgnoreRepeat.status === 409, settleB7IgnoreRepeat.status);

  // B7-5 无权限 403（viewer1）+ 服务关 503（手工线）
  const viewerGenManual = await api(base, 'POST', `/api/stations/${stOut}/ai-waste/generate-manual`, { token: viewer.data.accessToken });
  check('手工线无权限 viewer1 → 403（权限先于开关）', viewerGenManual.status === 403, viewerGenManual.status);
  process.env.AI_SUGGEST_ENABLED = 'false';
  const appOff2 = await NestFactory.create(AppModule, { logger: false });
  appOff2.setGlobalPrefix('api');
  appOff2.useGlobalFilters(new AllExceptionsFilter());
  appOff2.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await appOff2.listen(0);
  const baseOff2 = `http://127.0.0.1:${appOff2.getHttpServer().address().port}`;
  const genOff2 = await api(baseOff2, 'POST', `/api/stations/${stOut}/ai-waste/generate-manual`, { token: adminToken });
  check('手工线服务关 → 503', genOff2.status === 503, genOff2.status);
  await appOff2.close();
  process.env.AI_SUGGEST_ENABLED = 'true';

  // B7-6 双向隔离最强反证：manual 批已存在时，AI 线 generate 仍 400（而非幂等命中 manual 批）
  mockCallCount = 0;
  const genAiOnDoneManual = await api(base, 'POST', `/api/stations/${stOut}/ai-waste/generate`, { token: adminToken });
  check('最强反证：已有 manual done 批的工位跑 AI 线 generate → 400（不跨线幂等）',
    genAiOnDoneManual.status === 400, genAiOnDoneManual.status);
  check('最强反证不调 LLM（mock 0 次）', mockCallCount === 0, mockCallCount);

  // ── 汇总 ──
  mock.close();
  await appOn.close();
  // v3.48：还原 Phase 0 熄灭的 LLM 连接配置（生产依赖启用中的方舟端点）
  if (profileRows.length > 0) await dbExec("UPDATE t_ai_llm_profile SET enabled = 1 WHERE profile_id = @p0", [profileRows[0].profile_id]).catch(() => {});
  console.log(`\n结果: ${ok} 通过 / ${fail} 失败\n`);
  if (fail > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((e) => { console.error('契约测试执行异常:', e); process.exit(1); });
