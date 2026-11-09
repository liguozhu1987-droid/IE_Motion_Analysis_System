/**
 * v3.46 AI 建议双来源线隔离契约测试（ai-suggest element_source 三值分流）。
 *
 * 被测契约（工程师实现版，逐条独立验证）：
 *  - POST /stations/:id/ai-suggestions/generate?source=manual|ai_assisted（无参=mixed legacy 口径）
 *  - GET  /stations/:id/ai-suggestions?source=...（无参=legacy 全量不过滤；带 source 时批次+建议都按该线过滤）
 *  - 批次 VO 新增 element_source；幂等/缓存命中 payload 亦含该字段
 *  - 幂等 200 / 409 / single-flight / failed 重开 / 缓存命中 全部按 source 隔离
 *  - DTO：source ∈ {mixed, manual, ai_assisted}，非法值 400
 *
 * 前置：npm run build（dist 为准）；DB_TYPE=mssql 直连 CN_AME；npm run seed 后有 admin/123456。
 * 运行：node test/ai-suggest-source-contract.cjs
 *
 * 设计（确定性，不依赖真实 LLM）：
 *  - AI 开关走 t_ai_setting.ai_enabled 行（DB 优先于 env；本测试进程 env 引导为 true，
 *    行 '0'=关 / '1'=开 / 删行=回落 env）；LLM 端点置 bogus（127.0.0.1:9 拒连）→ 制造 failed 批；
 *  - done/running 槽位一律 DB 直插（避免依赖 LLM 成功路径——那是 legacy 契约测试的职责）；
 *  - 环境净化：t_ai_llm_profile 启用行会覆盖 t_ai_setting/env 的 base_url（v3.40 优先级），
 *    测试启动时临时熄灭、结束时还原（不删行，最小侵入）；
 *  - 与 ai-suggest-contract.cjs（legacy 契约回归）互不修改——本文件独立成篇；
 *  - 固定工位名 + setupStation 按名 purge（项目重名护栏纪律）；工位 ID 会话内唯一分配。
 */
process.env.DB_TYPE = process.env.DB_TYPE || 'mssql';
require('dotenv').config();
require('reflect-metadata');
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

function check(name, cond, detail) {
  if (cond) { ok++; console.log(`  ${PASS} ${name}`); }
  else {
    fail++;
    const d = detail === undefined ? '' : ` \u2192 ${JSON.stringify(detail).slice(0, 300)}`;
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

// ───────────────────────── DB 直连 helper（复用既有契约测试写法） ─────────────────────────

const cfg = loadConfig();

/** sqlite 方言降级：命名参数 → 位置参数；GETDATE() → datetime('now')（仅测试夹具用）。 */
function sqliteSql(sql) {
  return sql.replace(/GETDATE\(\)/gi, "datetime('now')").replace(/@p(\d+)/g, '?');
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
  try { return raw.prepare(sqliteSql(sql)).all(...params); } finally { raw.close(); }
}

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
  try { raw.prepare(sqliteSql(sql)).run(...params); } finally { raw.close(); }
}

/** v3.42 重名护栏适配：按名清历史残留（固定工位名跨轮次累积，同名会让 create 400） */
async function purgeByName(name) {
  const rows = await dbQuery("SELECT station_id FROM t_station WHERE name = @p0", [name]).catch(() => []);
  const ids = rows.map((r) => r.station_id);
  if (ids.length === 0) return;
  const inIds = ids.map((i) => `'${i}'`).join(',');
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE batch_id IN (SELECT batch_id FROM t_ai_waste_batch WHERE station_id IN (${inIds}))`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_suggestion WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_suggestion_batch WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_station_collaborator WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id IN (${inIds})`).catch(() => {});
}

/** 同会话工位 ID 防相撞（随机 ST 序号跨轮次/同会话多工位有碰撞概率） */
const usedStationIds = new Set();
function nextStationId() {
  for (let i = 0; i < 500; i++) {
    const id = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
    if (!usedStationIds.has(id)) { usedStationIds.add(id); return id; }
  }
  throw new Error('nextStationId: 500 次未分配到唯一工位 ID');
}

/** 建测试工位 + 提交要素（走 API，保证口径一致；要素不带 source → 默认 manual） */
async function setupStation(base, token, stationId, name) {
  await purgeByName(name);
  await dbExec("DELETE FROM t_ai_suggestion WHERE station_id = @p0", [stationId]).catch(() => {});
  await dbExec("DELETE FROM t_ai_suggestion_batch WHERE station_id = @p0", [stationId]).catch(() => {});
  await dbExec("DELETE FROM t_improvement WHERE station_id = @p0", [stationId]).catch(() => {});
  await dbExec("DELETE FROM t_element WHERE station_id = @p0", [stationId]).catch(() => {});
  await dbExec("DELETE FROM t_station WHERE station_id = @p0", [stationId]).catch(() => {});
  await api(base, 'POST', '/api/stations', { token, body: { station_id: stationId, line_id: 'L01', name, tt: 40 } });
  const elements = [
    { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
    { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
    { seq: 3, start_ms: 6000, dur_s: 2.5, hand: 'R', type: '寻找', desc: '目视寻找料件', va_class: 'RNVA', rating: 1, allowance: 0.15 },
    { seq: 4, start_ms: 8500, dur_s: 2.0, hand: 'L', type: '可避免延迟', desc: '等上件', va_class: 'NVA', rating: 1, allowance: 0.15 },
  ];
  await api(base, 'POST', `/api/stations/${stationId}/elements/submit`, { token, body: { cycle_count: 15, cv: 0.05, elements } });
}

// ───────────────────────── 场景控制 helper ─────────────────────────

/** AI 总开关（t_ai_setting 行优先于 env；'1'=开 '0'=关） */
async function setAi(onoff) {
  const exist = await dbQuery("SELECT setting_key FROM t_ai_setting WHERE setting_key = 'ai_enabled'");
  if (exist.length > 0) await dbExec("UPDATE t_ai_setting SET setting_value = @p0 WHERE setting_key = 'ai_enabled'", [onoff]);
  else await dbExec("INSERT INTO t_ai_setting (setting_key, setting_value) VALUES ('ai_enabled', @p0)", [onoff]);
}

/** bogus LLM 端点（127.0.0.1:9 拒连，毫秒级失败）→ generate 走 LLM 失败 → failed 批 */
async function setBogusLlm() {
  const upsert = async (k, v) => {
    const exist = await dbQuery("SELECT setting_key FROM t_ai_setting WHERE setting_key = @p0", [k]);
    if (exist.length > 0) await dbExec("UPDATE t_ai_setting SET setting_value = @p0 WHERE setting_key = @p1", [v, k]);
    else await dbExec("INSERT INTO t_ai_setting (setting_key, setting_value) VALUES (@p0, @p1)", [k, v]);
  };
  await upsert('llm_base_url', 'http://127.0.0.1:9/v1');
  await upsert('llm_model', 'qa-bogus-model');
  await upsert('llm_api_key', 'na');
}

/** DB 直插批次（is_unlimited=1 绕开 UQ_ai_batch_slot 过滤唯一索引，避免同键撞插） */
async function insertBatch(row) {
  await dbExec(`INSERT INTO t_ai_suggestion_batch
    (batch_id, tenant_id, station_id, version, user_id, element_source, is_unlimited, status, input_hash, attempt, suggestion_count, tokens_used, created_at, completed_at)
    VALUES (@p0, @p1, @p2, @p3, @p4, @p5, 1, @p6, @p7, @p8, @p9, 0, GETDATE(), @p10)`,
    [row.batch_id, row.tenant_id, row.station_id, row.version, row.user_id, row.element_source,
      row.status, row.input_hash ?? 'qa-hash-' + row.batch_id.slice(0, 8), row.attempt ?? 1,
      row.suggestion_count ?? 0, row.completed_at ?? null]);
}

/** DB 直插建议行（t_ai_suggestion 无默认值列全部显式给） */
async function insertSuggestion(row) {
  await dbExec(`INSERT INTO t_ai_suggestion
    (suggestion_id, batch_id, tenant_id, station_id, version, element_ids, waste_type, method, action_class, measure, est_save_s, priority, tier, difficulty, verif, status, created_at)
    VALUES (@p0, @p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11, @p12, @p13, @p14, @p15, GETDATE())`,
    [row.suggestion_id, row.batch_id, row.tenant_id, row.station_id, row.version,
      row.element_ids ?? 'el-1', row.waste_type ?? '持住', row.method ?? 'E', row.action_class ?? '自动化',
      row.measure ?? '治具夹持替代人工持住壳体动作', row.est_save_s ?? 3.2, row.priority ?? 80,
      row.tier ?? 'P1', row.difficulty ?? 2, row.verif ?? 2, row.status ?? '待审']);
}

/** 查工位批次（按 source 线） */
async function batchesOf(stationId, userId) {
  return dbQuery(
    "SELECT batch_id, element_source, status, attempt, cache_from, suggestion_count, input_hash FROM t_ai_suggestion_batch WHERE station_id = @p0 AND user_id = @p1 ORDER BY created_at",
    [stationId, userId]);
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  // ── Phase 0：环境净化 ──
  // v3.40 优先级：启用的 llm profile 会盖掉 t_ai_setting/env 的 base_url——临时熄灭保确定性，结束时还原
  const profileRows = await dbQuery("SELECT profile_id, enabled FROM t_ai_llm_profile WHERE enabled = 1").catch(() => []);
  if (profileRows.length > 0) await dbExec("UPDATE t_ai_llm_profile SET enabled = 0 WHERE enabled = 1");
  await dbExec("DELETE FROM t_ai_setting").catch(() => {});
  // 固定名历史残留（上一轮契约测试留下的 AI 工位不干扰本测试——按名 purge 由 setupStation 负责）

  // ── 起进程内应用（env 引导 AI 开；t_ai_setting 行负责场景内开关） ──
  process.env.AI_SUGGEST_ENABLED = 'true';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  // 全局 pipe 与 main.ts 一致——否则 DTO 校验（source IsIn）在测试环境整体失效
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  const admin = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const adminToken = admin.data.accessToken;
  const adminId = 'u_admin';
  check('登录 admin（user:write 豁免配额，槽位语义不受配额干扰）', !!adminToken, admin.status);

  try {
    // ═════════════════ S1 legacy 不变（无参 generate/list 契约） ═════════════════
    console.log('\n[S1] legacy 无参契约不变（generate 幂等 payload 字段 + list 无参不过滤）');
    const stLegacy = nextStationId();
    await setupStation(base, adminToken, stLegacy, 'AI来源线legacy工位');
    const legacyTenant = (await dbQuery("SELECT tenant_id FROM t_station WHERE station_id = @p0", [stLegacy]))[0].tenant_id;
    const legacyVersion = (await dbQuery("SELECT version FROM t_station WHERE station_id = @p0", [stLegacy]))[0].version;
    // 三线各一批（DB 直插 done/failed），用于验证「无参 list 不过滤」与「element_source 字段」
    await insertBatch({ batch_id: 'qa-s1-mixed', tenant_id: legacyTenant, station_id: stLegacy, version: legacyVersion, user_id: adminId, element_source: 'mixed', status: 'done', suggestion_count: 2 });
    await insertBatch({ batch_id: 'qa-s1-manual', tenant_id: legacyTenant, station_id: stLegacy, version: legacyVersion, user_id: adminId, element_source: 'manual', status: 'done', suggestion_count: 1 });
    await insertBatch({ batch_id: 'qa-s1-ai', tenant_id: legacyTenant, station_id: stLegacy, version: legacyVersion, user_id: adminId, element_source: 'ai_assisted', status: 'failed', suggestion_count: 0 });
    await insertSuggestion({ suggestion_id: 'qa-s1-sug-m1', batch_id: 'qa-s1-mixed', tenant_id: legacyTenant, station_id: stLegacy, version: legacyVersion });
    await insertSuggestion({ suggestion_id: 'qa-s1-sug-m2', batch_id: 'qa-s1-mixed', tenant_id: legacyTenant, station_id: stLegacy, version: legacyVersion, waste_type: '搬运', method: 'R' });
    await insertSuggestion({ suggestion_id: 'qa-s1-sug-man', batch_id: 'qa-s1-manual', tenant_id: legacyTenant, station_id: stLegacy, version: legacyVersion });

    await setAi('1'); await setBogusLlm();
    // 无参 generate → 命中 mixed done 槽位 → 200 幂等（legacy 语义）
    const genLegacy = await api(base, 'POST', `/api/stations/${stLegacy}/ai-suggestions/generate`, { token: adminToken });
    check('S1.1 无参 generate 命中 mixed done 槽位 → 200 幂等', genLegacy.status === 200 && genLegacy.data?.idempotent_hit === true, genLegacy.status);
    check('S1.2 幂等 payload 字段集 = legacy 字段 + element_source（契约逐字段）',
      JSON.stringify(Object.keys(genLegacy.data ?? {}).sort()) === JSON.stringify(
        ['batch_id', 'completed_at', 'element_source', 'idempotent_hit', 'suggestions', 'station_id', 'status', 'suggestion_count', 'version'].sort()),
      Object.keys(genLegacy.data ?? {}));
    check('S1.3 幂等 payload element_source=mixed 且 batch_id 为 mixed 批',
      genLegacy.data?.element_source === 'mixed' && genLegacy.data?.batch_id === 'qa-s1-mixed', genLegacy.data?.element_source);
    check('S1.4 幂等 payload 建议数=2（mixed 批的建议）', (genLegacy.data?.suggestions ?? []).length === 2, (genLegacy.data?.suggestions ?? []).length);
    // 无参 list → 不过滤：三线批次全回（legacy 全量语义）
    const listLegacy = await api(base, 'GET', `/api/stations/${stLegacy}/ai-suggestions`, { token: adminToken });
    const lb = listLegacy.data?.batches ?? [];
    check('S1.5 无参 list → 200 且三线批次全不过滤（legacy 全量）', listLegacy.status === 200 && lb.length === 3, lb.map((b) => b.element_source));
    check('S1.6 list batches[].element_source 字段值正确（mixed/manual/ai_assisted）',
      lb.map((b) => b.element_source).sort().join(',') === 'ai_assisted,manual,mixed', lb.map((b) => b.element_source));
    check('S1.7 无参 list 建议=三线合计 3 条（legacy 不过滤建议）', (listLegacy.data?.suggestions ?? []).length === 3, (listLegacy.data?.suggestions ?? []).length);
    const lbFirst = lb[0] ?? {};
    check('S1.8 list 批次 VO 保留全部 legacy 字段（status/version/user_id/attempt/cache_from/error/created_at/completed_at）',
      ['batch_id', 'status', 'version', 'user_id', 'attempt', 'suggestion_count', 'tokens_used', 'model', 'prompt_version', 'cache_from', 'error', 'created_at', 'completed_at', 'element_source']
        .every((k) => k in lbFirst), Object.keys(lbFirst));

    // ═════════════════ S2 三线批次隔离（DB 级） ═════════════════
    console.log('\n[S2] 三线批次隔离（同工位分别 generate 三线 → 三条 batch 互不覆盖）');
    const stIso = nextStationId();
    await setupStation(base, adminToken, stIso, 'AI来源线三线隔离工位');
    const g1 = await api(base, 'POST', `/api/stations/${stIso}/ai-suggestions/generate`, { token: adminToken });
    const g2 = await api(base, 'POST', `/api/stations/${stIso}/ai-suggestions/generate?source=manual`, { token: adminToken });
    const g3 = await api(base, 'POST', `/api/stations/${stIso}/ai-suggestions/generate?source=ai_assisted`, { token: adminToken });
    check('S2.1 bogus 端点下三线 generate 均 503（LLM 失败→failed 批，不依赖真实 LLM）',
      g1.status === 503 && g2.status === 503 && g3.status === 503, [g1.status, g2.status, g3.status]);
    const isoBatches = await batchesOf(stIso, adminId);
    check('S2.2 DB 三线各一条 batch（element_source=mixed/manual/ai_assisted，互不覆盖）',
      isoBatches.length === 3 && isoBatches.map((b) => b.element_source).sort().join(',') === 'ai_assisted,manual,mixed',
      isoBatches.map((b) => b.element_source));
    check('S2.3 三线 batch_id 互不相同且均 failed', new Set(isoBatches.map((b) => b.batch_id)).size === 3 && isoBatches.every((b) => b.status === 'failed'),
      isoBatches.map((b) => b.status));

    // ═════════════════ S3 幂等不跨线 ═════════════════
    console.log('\n[S3] 幂等不跨线（manual 线不命中 mixed 线 done 槽位，反之亦然）');
    // S3a：mixed done 槽位存在
    const stIdemA = nextStationId();
    await setupStation(base, adminToken, stIdemA, 'AI来源线幂等A工位');
    const tenantA = (await dbQuery("SELECT tenant_id FROM t_station WHERE station_id = @p0", [stIdemA]))[0].tenant_id;
    const verA = (await dbQuery("SELECT version FROM t_station WHERE station_id = @p0", [stIdemA]))[0].version;
    await insertBatch({ batch_id: 'qa-s3a-mixed-done', tenant_id: tenantA, station_id: stIdemA, version: verA, user_id: adminId, element_source: 'mixed', status: 'done', suggestion_count: 1 });
    await insertSuggestion({ suggestion_id: 'qa-s3a-sug', batch_id: 'qa-s3a-mixed-done', tenant_id: tenantA, station_id: stIdemA, version: verA });
    // AI 关 → manual 线 503（任务字面步骤：开关关时任何线都 503）
    await setAi('0');
    const offManual = await api(base, 'POST', `/api/stations/${stIdemA}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S3.1 AI 关（ai_enabled=0）：generate?source=manual → 503', offManual.status === 503, offManual.status);
    // AI 开 → manual 线不得命中 mixed done 槽位（严谨隔离证据：新建 manual failed 批）
    await setAi('1');
    const onManual = await api(base, 'POST', `/api/stations/${stIdemA}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S3.2 AI 开：manual 线不命中 mixed done 槽位（503 LLM 失败，非 200 幂等）',
      onManual.status === 503 && onManual.data?.idempotent_hit !== true, onManual.status);
    const idemABatches = await batchesOf(stIdemA, adminId);
    const idemAManual = idemABatches.find((b) => b.element_source === 'manual');
    check('S3.3 manual 线生成新建了 manual failed 批（未复用/未冒充 mixed 槽位）', !!idemAManual && idemAManual.status === 'failed', idemABatches);
    // mixed 线（无参）正常幂等
    const onMixed = await api(base, 'POST', `/api/stations/${stIdemA}/ai-suggestions/generate`, { token: adminToken });
    check('S3.4 无参 generate 命中 mixed done 槽位 → 200 幂等（mixed 线自身幂等不受影响）',
      onMixed.status === 200 && onMixed.data?.idempotent_hit === true && onMixed.data?.batch_id === 'qa-s3a-mixed-done', onMixed.data?.batch_id);
    // S3b：manual done 槽位存在（反向）
    const stIdemB = nextStationId();
    await setupStation(base, adminToken, stIdemB, 'AI来源线幂等B工位');
    const tenantB = (await dbQuery("SELECT tenant_id FROM t_station WHERE station_id = @p0", [stIdemB]))[0].tenant_id;
    const verB = (await dbQuery("SELECT version FROM t_station WHERE station_id = @p0", [stIdemB]))[0].version;
    await insertBatch({ batch_id: 'qa-s3b-manual-done', tenant_id: tenantB, station_id: stIdemB, version: verB, user_id: adminId, element_source: 'manual', status: 'done', suggestion_count: 1 });
    await insertSuggestion({ suggestion_id: 'qa-s3b-sug', batch_id: 'qa-s3b-manual-done', tenant_id: tenantB, station_id: stIdemB, version: verB });
    const mixedVsManual = await api(base, 'POST', `/api/stations/${stIdemB}/ai-suggestions/generate`, { token: adminToken });
    check('S3.5 反向：manual done 槽位下无参（mixed）生成不命中（503，非 200 幂等）',
      mixedVsManual.status === 503 && mixedVsManual.data?.idempotent_hit !== true, mixedVsManual.status);
    const idemBBatches = await batchesOf(stIdemB, adminId);
    check('S3.6 反向：mixed 线新建 mixed failed 批（未命中 manual 槽位）',
      idemBBatches.some((b) => b.element_source === 'mixed' && b.status === 'failed'), idemBBatches.map((b) => [b.element_source, b.status]));
    const manualVsManual = await api(base, 'POST', `/api/stations/${stIdemB}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S3.7 反向：?source=manual 命中 manual done 槽位 → 200 幂等',
      manualVsManual.status === 200 && manualVsManual.data?.idempotent_hit === true && manualVsManual.data?.batch_id === 'qa-s3b-manual-done', manualVsManual.data?.batch_id);

    // ═════════════════ S4 409 不跨线 ═════════════════
    console.log('\n[S4] 409 不跨线（mixed running 槽位不拦 manual 线）');
    const stConflict = nextStationId();
    await setupStation(base, adminToken, stConflict, 'AI来源线409工位');
    const tenantC = (await dbQuery("SELECT tenant_id FROM t_station WHERE station_id = @p0", [stConflict]))[0].tenant_id;
    const verC = (await dbQuery("SELECT version FROM t_station WHERE station_id = @p0", [stConflict]))[0].version;
    await insertBatch({ batch_id: 'qa-s4-mixed-running', tenant_id: tenantC, station_id: stConflict, version: verC, user_id: adminId, element_source: 'mixed', status: 'running', suggestion_count: 0 });
    const confMixed = await api(base, 'POST', `/api/stations/${stConflict}/ai-suggestions/generate`, { token: adminToken });
    check('S4.1 mixed running 槽位：无参 generate → 409 AI_BATCH_IN_PROGRESS',
      confMixed.status === 409 && confMixed.data?.code === 'AI_BATCH_IN_PROGRESS', [confMixed.status, confMixed.data?.code]);
    const confManual = await api(base, 'POST', `/api/stations/${stConflict}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S4.2 同状态下 ?source=manual → 不 409（走到 LLM 失败 503，证明隔离）',
      confManual.status !== 409 && confManual.status === 503, confManual.status);
    const confBatches = await batchesOf(stConflict, adminId);
    check('S4.3 manual 线新建 manual failed 批（未撞 mixed running 槽位）',
      confBatches.some((b) => b.element_source === 'manual' && b.status === 'failed'), confBatches.map((b) => [b.element_source, b.status]));

    // ═════════════════ S5 failed 重开不跨线 ═════════════════
    console.log('\n[S5] failed 重开不跨线（manual 线不复用 mixed 的 failed 批）');
    const stReopen = nextStationId();
    await setupStation(base, adminToken, stReopen, 'AI来源线重开工位');
    const genReopenMixed = await api(base, 'POST', `/api/stations/${stReopen}/ai-suggestions/generate`, { token: adminToken });
    check('S5.1 mixed 线 generate → 503 制造 mixed failed 批', genReopenMixed.status === 503, genReopenMixed.status);
    const reopenBefore = await batchesOf(stReopen, adminId);
    const mixedFailed = reopenBefore.find((b) => b.element_source === 'mixed' && b.status === 'failed');
    check('S5.2 DB 存在 mixed failed 批', !!mixedFailed, reopenBefore.map((b) => [b.element_source, b.status]));
    const genReopenManual = await api(base, 'POST', `/api/stations/${stReopen}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S5.3 ?source=manual → 503（新建 manual 批而非复用 mixed failed 批）', genReopenManual.status === 503, genReopenManual.status);
    const reopenAfter = await batchesOf(stReopen, adminId);
    const manualNew = reopenAfter.find((b) => b.element_source === 'manual');
    check('S5.4 manual 新批 batch_id ≠ mixed failed 批（两条批次并存，来源不串）',
      !!manualNew && manualNew.batch_id !== mixedFailed?.batch_id, { manual: manualNew?.batch_id, mixed: mixedFailed?.batch_id });
    check('S5.5 manual 新批 attempt=1（全新槽位，非 mixed failed 重开 attempt 续接）', manualNew?.attempt === 1, manualNew?.attempt);
    check('S5.6 mixed failed 批原样保留（element_source=mixed、未被改写）',
      reopenAfter.some((b) => b.batch_id === mixedFailed?.batch_id && b.element_source === 'mixed' && b.status === 'failed'),
      reopenAfter.map((b) => [b.element_source, b.status]));
    // 线内重开语义仍在（manual 再生成 → 复用同一 manual failed 批，attempt+1）
    const genReopenManual2 = await api(base, 'POST', `/api/stations/${stReopen}/ai-suggestions/generate?source=manual`, { token: adminToken });
    const reopenFinal = await batchesOf(stReopen, adminId);
    const manualReopened = reopenFinal.filter((b) => b.element_source === 'manual');
    check('S5.7 manual 线内重开语义保持（同 batch_id，attempt=2）',
      genReopenManual2.status === 503 && manualReopened.length === 1 && manualReopened[0].attempt === 2, manualReopened.map((b) => b.attempt));

    // ═════════════════ S6 list 过滤 ═════════════════
    console.log('\n[S6] list 过滤（?source=manual 只回 manual 批与 manual 批建议；无参回全部）');
    const stList = nextStationId();
    await setupStation(base, adminToken, stList, 'AI来源线列表过滤工位');
    const tenantL = (await dbQuery("SELECT tenant_id FROM t_station WHERE station_id = @p0", [stList]))[0].tenant_id;
    const verL = (await dbQuery("SELECT version FROM t_station WHERE station_id = @p0", [stList]))[0].version;
    await insertBatch({ batch_id: 'qa-s6-mixed', tenant_id: tenantL, station_id: stList, version: verL, user_id: adminId, element_source: 'mixed', status: 'done', suggestion_count: 2 });
    await insertBatch({ batch_id: 'qa-s6-manual', tenant_id: tenantL, station_id: stList, version: verL, user_id: adminId, element_source: 'manual', status: 'done', suggestion_count: 1 });
    await insertSuggestion({ suggestion_id: 'qa-s6-sug-m1', batch_id: 'qa-s6-mixed', tenant_id: tenantL, station_id: stList, version: verL });
    await insertSuggestion({ suggestion_id: 'qa-s6-sug-m2', batch_id: 'qa-s6-mixed', tenant_id: tenantL, station_id: stList, version: verL, waste_type: '搬运', method: 'R' });
    await insertSuggestion({ suggestion_id: 'qa-s6-sug-man', batch_id: 'qa-s6-manual', tenant_id: tenantL, station_id: stList, version: verL });
    const listManual = await api(base, 'GET', `/api/stations/${stList}/ai-suggestions?source=manual`, { token: adminToken });
    check('S6.1 list?source=manual → 只回 manual 批（1 条）',
      listManual.status === 200 && (listManual.data?.batches ?? []).length === 1
        && (listManual.data?.batches ?? [])[0].element_source === 'manual', (listManual.data?.batches ?? []).map((b) => b.element_source));
    const manSugs = listManual.data?.suggestions ?? [];
    check('S6.2 list?source=manual 建议只来自 manual 批（1 条且 batch_id 正确）',
      manSugs.length === 1 && manSugs[0].batch_id === 'qa-s6-manual', manSugs.map((s) => s.batch_id));
    const listAll = await api(base, 'GET', `/api/stations/${stList}/ai-suggestions`, { token: adminToken });
    check('S6.3 无参 list → 全部批次（mixed+manual）与全部建议（3 条，legacy 行为）',
      (listAll.data?.batches ?? []).length === 2 && (listAll.data?.suggestions ?? []).length === 3,
      [(listAll.data?.batches ?? []).length, (listAll.data?.suggestions ?? []).length]);
    const listAi = await api(base, 'GET', `/api/stations/${stList}/ai-suggestions?source=ai_assisted`, { token: adminToken });
    check('S6.4 list?source=ai_assisted（无该线批次）→ 空批次空建议',
      listAi.status === 200 && (listAi.data?.batches ?? []).length === 0 && (listAi.data?.suggestions ?? []).length === 0, listAi.data);

    // ═════════════════ S7 缓存不跨线 ═════════════════
    console.log('\n[S7] 缓存不跨线（manual 线不克隆 mixed 批结果，cache_from 保持 NULL）');
    const stCache = nextStationId();
    await setupStation(base, adminToken, stCache, 'AI来源线缓存工位');
    // 要素全部 manual 来源（setupStation 默认）→ mixed 线与 manual 线输入集相同 → input_hash 相同（构造跨线克隆的诱惑）
    const cacheGen1 = await api(base, 'POST', `/api/stations/${stCache}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S7.1 manual 线首次 generate → 503（failed 批落库，input_hash 记录）', cacheGen1.status === 503, cacheGen1.status);
    const cacheF = (await batchesOf(stCache, adminId)).find((b) => b.element_source === 'manual');
    const manualHash = cacheF?.input_hash;
    check('S7.2 manual failed 批已记录 input_hash', !!manualHash, manualHash);
    // 插入 mixed done 批，input_hash 刻意=manual 线哈希（若无 source 过滤就会被克隆）
    const tenantCa = (await dbQuery("SELECT tenant_id FROM t_station WHERE station_id = @p0", [stCache]))[0].tenant_id;
    const verCa = (await dbQuery("SELECT version FROM t_station WHERE station_id = @p0", [stCache]))[0].version;
    await insertBatch({ batch_id: 'qa-s7-mixed-done', tenant_id: tenantCa, station_id: stCache, version: verCa, user_id: adminId, element_source: 'mixed', status: 'done', input_hash: manualHash, suggestion_count: 1 });
    await insertSuggestion({ suggestion_id: 'qa-s7-sug', batch_id: 'qa-s7-mixed-done', tenant_id: tenantCa, station_id: stCache, version: verCa });
    const cacheGen2 = await api(base, 'POST', `/api/stations/${stCache}/ai-suggestions/generate?source=manual`, { token: adminToken });
    check('S7.3 manual 线再生成 → 503（未因 mixed 同 hash done 批而缓存命中 200）', cacheGen2.status === 503, cacheGen2.status);
    const cacheFinal = (await batchesOf(stCache, adminId)).find((b) => b.element_source === 'manual');
    check('S7.4 manual 批 cache_from 为 NULL（未克隆 mixed 批结果）', cacheFinal?.cache_from == null, cacheFinal?.cache_from);
    check('S7.5 manual 批 suggestion_count=0（无跨线建议混入）', Number(cacheFinal?.suggestion_count ?? -1) === 0, cacheFinal?.suggestion_count);
    const manSugRows = await dbQuery("SELECT COUNT(*) AS n FROM t_ai_suggestion WHERE batch_id = @p0", [cacheFinal?.batch_id ?? '']);
    check('S7.6 DB 层 manual 批无建议行（克隆未发生）', Number(manSugRows[0]?.n ?? -1) === 0, manSugRows[0]);

    // ═════════════════ S8 DTO 校验 ═════════════════
    console.log('\n[S8] DTO 校验（source 白名单 IsIn + whitelist pipe）');
    const stDto = nextStationId();
    await setupStation(base, adminToken, stDto, 'AI来源线DTO工位');
    const dtoBad = await api(base, 'POST', `/api/stations/${stDto}/ai-suggestions/generate?source=bogus`, { token: adminToken });
    check('S8.1 generate?source=bogus → 400（IsIn 生效）', dtoBad.status === 400, dtoBad.status);
    const dtoBadList = await api(base, 'GET', `/api/stations/${stDto}/ai-suggestions?source=bogus`, { token: adminToken });
    check('S8.2 list?source=bogus → 400（IsIn 生效）', dtoBadList.status === 400, dtoBadList.status);
    const dtoExplicitMixed = await api(base, 'POST', `/api/stations/${stDto}/ai-suggestions/generate?source=mixed`, { token: adminToken });
    check('S8.3 generate?source=mixed 显式合法（非 400；bogus 端点下 503）', dtoExplicitMixed.status !== 400, dtoExplicitMixed.status);
    const dtoEmpty = await api(base, 'POST', `/api/stations/${stDto}/ai-suggestions/generate?source=MIXED`, { token: adminToken });
    check('S8.4 generate?source=MIXED（大写，枚举大小写敏感）→ 400', dtoEmpty.status === 400, dtoEmpty.status);

    // ── 汇总 ──
    console.log(`\n结果: ${ok} 通过 / ${fail} 失败\n`);
    if (fail > 0) {
      console.log('失败项:');
      failures.forEach((f) => console.log('  - ' + f));
    }
  } finally {
    // 环境还原：清本测试写入的 t_ai_setting；还原 llm profile 启用态
    await dbExec("DELETE FROM t_ai_setting WHERE setting_key IN ('ai_enabled','llm_base_url','llm_model','llm_api_key')").catch(() => {});
    if (profileRows.length > 0) await dbExec("UPDATE t_ai_llm_profile SET enabled = 1 WHERE profile_id = @p0", [profileRows[0].profile_id]).catch(() => {});
    await app.close();
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('来源线契约测试执行异常:', e); process.exit(1); });
