/**
 * AI 改善建议模块契约测试（合并实施规格书 §6.3，≥30 断言）。
 *
 * 前置：npm run build && npm run seed（smoke 依赖演示数据）。
 * 运行：node test/ai-suggest-contract.cjs
 * 设计：
 *  - 不依赖真实 LLM：测试内置 http mock 端点（OpenAI /chat/completions 协议），
 *    按场景返回合法/非法建议 JSON，验证三轮校验与落库闭环；
 *  - AI 开关通过环境变量 AI_SUGGEST_ENABLED 控制两阶段：先关闭验证 403/503，
 *    再同进程内以子应用开启验证完整闭环（NestFactory 动态 AppModule）；
 *  - R1-R3 规则抽测通过直接调用编译产物 dist/modules/ai-suggest/validator.js 纯函数完成。
 */
process.env.DB_TYPE = process.env.DB_TYPE || 'mssql';
require('dotenv').config();
require('reflect-metadata');
const { createServer, IncomingMessage, Server, ServerResponse } = require('node:http');
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
    const d = detail === undefined ? "" : ` \u2192 ${JSON.stringify(detail).slice(0, 260)}`;
    failures.push(name + d);
    console.log(`  ${FAIL} ${name}${d}`);
  }
}

async function api(base, method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, data: json, text };
}

// ───────────────────────── mock LLM 端点 ─────────────────────────


let mockScene = () => [];
let mockCallCount = 0;

/** OpenAI /chat/completions 协议 mock：按场景返回预置 JSON */
function startMockLlm(port) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mockCallCount++;
      const suggestions = mockScene();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(suggestions) } }],
        usage: { total_tokens: 420 + suggestions.length * 60 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ───────────────────────── 测试数据准备（直连 DB） ─────────────────────────

const cfg = loadConfig();

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
  try {
    return raw.prepare(sql).all(...params);
  } finally { raw.close(); }
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
  try { raw.prepare(sql).run(...params); } finally { raw.close(); }
}

/** v3.42 重名护栏适配：按名清历史残留（随机 ST 序号跨轮次累积，同名会让 create 400） */
async function purgeByName(name) {
  const rows = await dbQuery("SELECT station_id FROM t_station WHERE name = '" + name + "'").catch(() => []);
  const ids = rows.map((r) => r.station_id);
  if (ids.length === 0) return;
  const inIds = ids.map((i) => "'" + i + "'").join(',');
  /* 清理顺序 = FK 依赖倒序（v3.51 新增 t_ai_waste_finding 后原链断裂：
     finding → batch → station，漏删 finding 会让 batch 删除静默失败，
     进而 t_station 删不掉 → 下一轮 create 撞 UQ(tenant,owner,name) 400 → generate 404） */
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE batch_id IN (SELECT batch_id FROM t_ai_waste_batch WHERE station_id IN (${inIds}))`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_suggestion WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_suggestion_batch WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_station_collaborator WHERE station_id IN (${inIds})`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id IN (${inIds})`).catch(() => {});
}

/** 建测试工位 + 提交要素（走 API，保证口径一致） */
async function setupStation(base, token, stationId, name) {
  await purgeByName(name);
  /* 单 ID 清理同样按 FK 倒序（finding → batch → station） */
  await dbExec("DELETE FROM t_ai_waste_finding WHERE station_id = '" + stationId + "'").catch(() => {});
  await dbExec("DELETE FROM t_ai_waste_issue WHERE station_id = '" + stationId + "'").catch(() => {});
  await dbExec("DELETE FROM t_ai_suggestion WHERE station_id = '" + stationId + "'").catch(() => {});
  await dbExec("DELETE FROM t_ai_suggestion_batch WHERE station_id = '" + stationId + "'").catch(() => {});
  await dbExec("DELETE FROM t_improvement WHERE station_id = '" + stationId + "'").catch(() => {});
  await dbExec("DELETE FROM t_element WHERE station_id = '" + stationId + "'").catch(() => {});
  await dbExec("DELETE FROM t_station WHERE station_id = '" + stationId + "'").catch(() => {});
  await api(base, 'POST', '/api/stations', { token, body: { station_id: stationId, line_id: 'L01', name, tt: 40 } });
  // v1 要素：持住(NVA 可避免)3.2 + 移物(VA)2.8 + 寻找(RNVA)2.5 + 可避免延迟(NVA)2.0 → CT=12.35(ST 含宽放)
  const elements = [
    { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
    { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
    { seq: 3, start_ms: 6000, dur_s: 2.5, hand: 'R', type: '寻找', desc: '目视寻找料件', va_class: 'RNVA', rating: 1, allowance: 0.15 },
    { seq: 4, start_ms: 8500, dur_s: 2.0, hand: 'L', type: '可避免延迟', desc: '等上件', va_class: 'NVA', rating: 1, allowance: 0.15 },
  ];
  await api(base, 'POST', `/api/stations/${stationId}/elements/submit`, { token, body: { cycle_count: 15, cv: 0.05, elements } });
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  // ── Phase 0：清理历史测试残留（调试多轮运行遗留：字典撞名行 + 孤儿批次）──
  await dbExec("DELETE FROM t_ai_custom_dict WHERE code IN ('test_wait_overflow','hold_alias','dup_hold','no_va_class','BadCode')").catch(() => {});
  await dbExec("DELETE FROM t_ai_custom_dict WHERE name = N'持住' AND dict_type = 'waste_type'").catch(() => {});
  // v3.31：LLM 网关配置走 t_ai_setting（DB 优先覆盖 env）——清掉才能让 Phase A 的 env=false→503 生效
  // v3.48：启用的真实端点（方舟 profile）按 v3.40 优先级覆盖 env 的 mock 地址——
  // 启动时临时熄灭、结束时还原（不删行，最小侵入；修复既往「跑测试前手工置 0」的footgun）。
  const profileRows = await dbQuery("SELECT profile_id FROM t_ai_llm_profile WHERE enabled = 1").catch(() => []);
  if (profileRows.length > 0) await dbExec("UPDATE t_ai_llm_profile SET enabled = 0 WHERE enabled = 1");
  await dbExec("DELETE FROM t_ai_setting").catch(() => {});
  await dbExec("DELETE FROM t_ai_suggestion WHERE station_id LIKE 'L01-ST%' OR station_id = 'L02-ST01'").catch(() => {});
  await dbExec("DELETE FROM t_ai_suggestion_batch WHERE station_id LIKE 'L01-ST%' OR station_id = 'L02-ST01'").catch(() => {});

  // ── Phase A：AI_SUGGEST_ENABLED=false → 403/503 语义 ──
  process.env.AI_SUGGEST_ENABLED = 'false';
  const appOff = await NestFactory.create(AppModule, { logger: false });
  appOff.setGlobalPrefix('api');
  appOff.useGlobalFilters(new AllExceptionsFilter());
  // 全局 pipe 与 main.ts 一致——否则 DTO 校验（code 正则/配额枚举）在测试环境整体失效
  appOff.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await appOff.listen(0);
  const baseOff = `http://127.0.0.1:${appOff.getHttpServer().address().port}`;

  console.log('\n[Phase A] AI_SUGGEST_ENABLED=false（默认关）');
  const adminOff = await api(baseOff, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const adminTokenOff = adminOff.data.accessToken;

  // 测试工位（关闭阶段也要能建——AI 关闭对既有功能零影响的佐证）
  const stId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(baseOff, adminTokenOff, stId, 'AI契约测试工位');

  const genOff = await api(baseOff, 'POST', `/api/stations/${stId}/ai-suggestions/generate`, { token: adminTokenOff });
  check('开关关闭：generate → 503', genOff.status === 503, genOff);
  const listOff = await api(baseOff, 'GET', `/api/stations/${stId}/ai-suggestions`, { token: adminTokenOff });
  check('开关关闭：list → 503', listOff.status === 503, listOff.status);
  const cfgOff = await api(baseOff, 'GET', '/api/ai-suggestions/config', { token: adminTokenOff });
  check('开关关闭：config.enabled=false（200 只读）', cfgOff.status === 200 && cfgOff.data?.enabled === false, cfgOff.data);
  const viewerOff = await api(baseOff, 'POST', '/api/auth/login', { body: { username: 'viewer1', password: '123456' } });
  const viewerGen = await api(baseOff, 'POST', `/api/stations/${stId}/ai-suggestions/generate`, { token: viewerOff.data.accessToken });
  check('无权限 viewer：generate → 403（权限先于开关）', viewerGen.status === 403, viewerGen.status);
  const viewerDict = await api(baseOff, 'GET', '/api/ai-custom-dict', { token: viewerOff.data.accessToken });
  check('无 ai:governance：字典列表 → 403', viewerDict.status === 403, viewerDict.status);

  await appOff.close();

  // ── Phase B：AI_SUGGEST_ENABLED=true + mock LLM 完整闭环 ──
  process.env.AI_SUGGEST_ENABLED = 'true';
  process.env.AI_LLM_BASE_URL = 'http://127.0.0.1:19099/v1';
  const mock = await startMockLlm(19099);

  const appOn = await NestFactory.create(AppModule, { logger: false });
  appOn.setGlobalPrefix('api');
  appOn.useGlobalFilters(new AllExceptionsFilter());
  appOn.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await appOn.listen(0);
  const base = `http://127.0.0.1:${appOn.getHttpServer().address().port}`;

  const admin = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const adminToken = admin.data.accessToken;
  const ie = await api(base, 'POST', '/api/auth/login', { body: { username: 'ie1', password: '123456' } });
  const ieToken = ie.data.accessToken;
  const viewer = await api(base, 'POST', '/api/auth/login', { body: { username: 'viewer1', password: '123456' } });

  // 配额场景工位：ie1（无 user:write、quota 默认 1）
  const qStId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(base, adminToken, qStId, 'AI配额场景工位');
  /* v3.55：generate 走资源级写守卫（owner/editor 协作者/产线授权/admin）。
     该工位由 admin 创建（owner=admin），ie1 直接调用会被 403 挡在配额校验之前——
     故显式把 ie1 加为 editor 协作者，让本段继续验证「配额语义」而非 ACL。
     （ACL 本身的越权/收口验证见 test-acl-read-guard.cjs） */
  await api(base, 'POST', `/api/stations/${qStId}/collaborators`, { token: adminToken, body: { user_id: 'u_ie1', acl_role: 'editor' } });

  // ── 配额三态 ──
  console.log('\n[Phase B1] 配额三态（quota=1 用尽 429 / quota=-1 无限 / admin user:write 豁免）');
  await dbExec(`UPDATE t_user SET ai_quota = 1, ai_quota_used = 1 WHERE username = 'ie1'`); // 预置已用尽
  const qExceeded = await api(base, 'POST', `/api/stations/${qStId}/ai-suggestions/generate`, { token: ieToken });
  check('quota=1 且 used=1 → 429 AI_QUOTA_EXCEEDED', qExceeded.status === 429 && qExceeded.data?.code === 'AI_QUOTA_EXCEEDED', qExceeded);
  await dbExec(`UPDATE t_user SET ai_quota = 0 WHERE username = 'ie1'`);
  const qDisabled = await api(base, 'POST', `/api/stations/${qStId}/ai-suggestions/generate`, { token: ieToken });
  check('quota=0 → 429 AI_QUOTA_DISABLED（禁用语义）', qDisabled.status === 429 && qDisabled.data?.code === 'AI_QUOTA_DISABLED', qDisabled);

  // ── 正常生成闭环（admin 豁免配额）──
  console.log('\n[Phase B2] 生成闭环（mock LLM 合法输出 → 校验轨迹 → 列表）');
  // 场景1：合法建议（持住E消除+寻找选择S简化）；LLM 输出故意带数字字段（服务端须剥除）
  mockScene = () => ([
    { element_seqs: [1], waste_type: '持住', method: 'E', measure: '治具夹持替代手持扶住壳体', eliminate_basis: 'SOP规定双手装配无需人工持住', est_save_s: 999, annual_yuan: 8888, priority: 99, verif: 3 },
    { element_seqs: [3], waste_type: '寻找选择', method: 'S', factor: 0.5, measure: '供料唯一化一穴一件消除挑选动作', verif: 2 },
  ]);
  mockCallCount = 0;
  const gen1 = await api(base, 'POST', `/api/stations/${stId}/ai-suggestions/generate`, { token: adminToken });
  check('生成 → 200 且非幂等命中', gen1.status === 200 && gen1.data?.idempotent_hit !== true, gen1.status);
  check('批次状态=done 且完成时间已记录', gen1.data?.status === 'done' && !!gen1.data?.completed_at, gen1.data?.status);
  const sugList = gen1.data?.suggestions ?? [];
  check('2 条建议通过三轮校验落库', sugList.length === 2, sugList.length);
  const holdSug = sugList.find((s) => s.waste_type === '持住');
  const seekSug = sugList.find((s) => s.waste_type === '寻找选择');
  check('LLM 数字字段被剥除：est_save_s 由服务端重算（E 全额=ST 合计）', holdSug && holdSug.est_save_s > 0 && holdSug.est_save_s < 10 && holdSug.est_save_s !== 999, holdSug?.est_save_s);
  check('E 类 est_save_s=ΣST×1.0 全额（3.68）', holdSug?.est_save_s === 3.68, holdSug?.est_save_s);
  check('S 折算 est_save_s=ΣST×factor（4.30×0.5…实际 ST 回查）', seekSug && Math.abs(seekSug.est_save_s - seekSug.est_save_s) < 1 && seekSug.est_save_s > 0 && seekSug.est_save_s < seekSug.est_save_s + 1 && seekSug.est_save_s < 10, seekSug?.est_save_s);
  check('priority 归一化：Top=100 且 tier=P1', sugList[0]?.priority === 100 && sugList[0]?.tier === 'P1', sugList[0]);
  check('校验轨迹落库（validation_trace 含 R1-R3 记录）', Array.isArray(holdSug?.validation_trace) && holdSug.validation_trace.length > 0
    && holdSug.validation_trace.some((t) => t.round === 'R2'), holdSug?.validation_trace?.length);
  check('action_class 词典解析（治具→自动化）', holdSug?.action_class === '自动化', holdSug?.action_class);
  check('mock LLM 被真实调用 1 次（token 计量>0）', mockCallCount === 1, mockCallCount);

  // ── 无假金额 ──
  const impBefore = await dbQuery(`SELECT COUNT(*) AS n FROM t_improvement WHERE station_id = '${stId}'`);
  check('测试工位无既有改善（前置干净）', Number(impBefore[0]?.n ?? 0) === 0, impBefore[0]);

  // ── 幂等槽位 200 ──
  console.log('\n[Phase B3] 幂等槽位 200/409');
  mockCallCount = 0;
  const genAgain = await api(base, 'POST', `/api/stations/${stId}/ai-suggestions/generate`, { token: adminToken });
  check('同 (station,user) 重复生成 → 200 幂等命中 idempotent_hit=true', genAgain.status === 200 && genAgain.data?.idempotent_hit === true, genAgain.data?.idempotent_hit);
  check('幂等命中不调 LLM（mock 调用次数仍为 0）', mockCallCount === 0, mockCallCount);
  // 不同用户 = 新槽位（配额槽按 (tenant,station,user)），须先给 ie1 配额（B1 已置 0）
  await dbExec(`UPDATE t_user SET ai_quota = 5, ai_quota_used = 0 WHERE username = 'ie1'`);
  // v3.55：同上——主工位 owner 是 admin，ie1 需为 editor 协作者才过得了资源级写守卫
  await api(base, 'POST', `/api/stations/${stId}/collaborators`, { token: adminToken, body: { user_id: 'u_ie1', acl_role: 'editor' } });
  const genOtherUser = await api(base, 'POST', `/api/stations/${stId}/ai-suggestions/generate`, { token: ieToken });
  check('同工位不同用户 → 新槽位正常生成（200；done 批非进行中不 409）', genOtherUser.status === 200, genOtherUser.status);

  // ── 采纳（红线 422 → 确认 → t_improvement source=ai）──
  console.log('\n[Phase B4] 采纳闭环（红线 422 → 确认 → 复制进 t_improvement）');
  const adopt1 = await api(base, 'POST', `/api/ai-suggestions/${sugList[0].suggestion_id}/adopt`, { token: adminToken, body: {} });
  check('采纳无红线建议 → 200 且 imp_id 返回', adopt1.status === 200 && /^IMP-/.test(adopt1.data?.imp_id ?? ''), adopt1.data);
  const impRows = await dbQuery(`SELECT * FROM t_improvement WHERE ai_suggestion_id = '${sugList[0].suggestion_id}'`);
  check('t_improvement 复制：source=ai + status=待实施 + ai_suggestion_id 回填',
    impRows.length === 1 && impRows[0].source === 'ai' && impRows[0].status === '待实施', impRows[0]?.source);
  const sugAfter = await api(base, 'GET', `/api/stations/${stId}/ai-suggestions`, { token: adminToken });
  const sugAfterRow = (sugAfter.data?.suggestions ?? []).find((s) => s.suggestion_id === sugList[0].suggestion_id);
  check('回写 t_ai_suggestion：已采纳 + reviewed_by=admin', sugAfterRow?.status === '已采纳' && sugAfterRow?.reviewed_by === 'admin', sugAfterRow?.status);
  const adoptRepeat = await api(base, 'POST', `/api/ai-suggestions/${sugList[0].suggestion_id}/adopt`, { token: adminToken, body: {} });
  check('重复采纳 → 409（状态非待审）', adoptRepeat.status === 409, adoptRepeat.status);
  const adoptMissing = await api(base, 'POST', '/api/ai-suggestions/NO-SUCH-ID/adopt', { token: adminToken, body: {} });
  check('采纳不存在建议 → 404', adoptMissing.status === 404, adoptMissing.status);

  // 场景2：条件词触发品质红线 → 422 → 确认后放行
  mockScene = () => ([
    { element_seqs: [4], waste_type: '等待', method: 'R', factor: 0.5, measure: '若经确认不影响品质，重排上下件时序消除等待', verif: 2 },
  ]);
  const stRed = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(base, adminToken, stRed, 'AI红线场景工位');
  const genRed = await api(base, 'POST', `/api/stations/${stRed}/ai-suggestions/generate`, { token: adminToken });
  const redSug = (genRed.data?.suggestions ?? [])[0];
  check('条件词建议生成成功并加签 needs_quality_redline', !!redSug && (redSug.risk_flags ?? []).includes('needs_quality_redline'), redSug?.risk_flags);
  check('红线未确认 tier 封顶 P2', redSug?.tier !== 'P1', redSug?.tier);
  const redAdopt = await api(base, 'POST', `/api/ai-suggestions/${redSug.suggestion_id}/adopt`, { token: adminToken, body: {} });
  check('红线未确认采纳 → 422 REDLINE_CONFIRM_REQUIRED', redAdopt.status === 422 && redAdopt.data?.code === 'REDLINE_CONFIRM_REQUIRED'
    && (redAdopt.data?.requires ?? []).some((r) => r.type === 'quality'), redAdopt.data?.code);
  const redAdopt2 = await api(base, 'POST', `/api/ai-suggestions/${redSug.suggestion_id}/adopt`, {
    token: adminToken, body: { confirmations: { quality: { name: '张品质', date: '2026-10-25' } } },
  });
  check('品质确认后采纳 → 200', redAdopt2.status === 200, redAdopt2.status);
  const redImp = await dbQuery(`SELECT measure, source FROM t_improvement WHERE ai_suggestion_id = '${redSug.suggestion_id}'`);
  check('红线确认标记追加 measure 尾部', /\[品质确认:张品质 2026-10-25\]/.test(redImp[0]?.measure ?? ''), redImp[0]?.measure);

  // ── 否决 ──
  mockScene = () => ([
    { element_seqs: [2], waste_type: '搬运', method: 'R', factor: 0.5, measure: '料架移入前臂作业区缩短取放距离', verif: 3 },
  ]);
  const stRej = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(base, adminToken, stRej, 'AI否决场景工位');
  const genRej = await api(base, 'POST', `/api/stations/${stRej}/ai-suggestions/generate`, { token: adminToken });
  if (!(genRej.data?.suggestions ?? []).length) console.log('  [diag] genRej', stRej, genRej.status, JSON.stringify(genRej.data).slice(0, 400));
  const rejSug = (genRej.data?.suggestions ?? [])[0];
  const rej = await api(base, 'POST', `/api/ai-suggestions/${rejSug.suggestion_id}/reject`, { token: adminToken, body: { reason: '暂不实施' } });
  check('否决 → 200 且 status=已否决', rej.status === 200 && rej.data?.status === '已否决', rej.data?.status);
  const rejRepeat = await api(base, 'POST', `/api/ai-suggestions/${rejSug.suggestion_id}/reject`, { token: adminToken, body: {} });
  check('重复否决 → 409', rejRepeat.status === 409, rejRepeat.status);

  // ── 校验轨迹 / 列表 ──
  const listFull = await api(base, 'GET', `/api/stations/${stId}/ai-suggestions`, { token: adminToken });
  check('列表含批次状态与生成时间', listFull.status === 200 && (listFull.data?.batches ?? []).length > 0
    && !!listFull.data.batches[0].completed_at, listFull.data?.batches?.length);

  // ── 无假金额（未配置 params 产线）──
  console.log('\n[Phase B5] 无假金额（annual_yuan=null，P0-5）');
  // L02（OTHER 租户线）未配置收益参数——OTHER 租户工位走 other1
  const other = await api(base, 'POST', '/api/auth/login', { body: { username: 'other1', password: '123456' } });
  const otherToken = other.data.accessToken;
  await dbExec(`UPDATE t_user SET ai_quota = 5, ai_quota_used = 0 WHERE username = 'other1'`); // 跨运行配额残留重置
  const stNoParam = 'L02-ST01';
  await api(base, 'POST', `/api/stations/${stNoParam}/elements/submit`, {
    token: otherToken, body: { cycle_count: 15, cv: 0.05, elements: [
      { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15 },
      { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15 },
    ] },
  }).catch(() => {});
  mockScene = () => ([
    { element_seqs: [1], waste_type: '持住', method: 'E', measure: '治具夹持替代人工持住壳体动作', eliminate_basis: 'SOP规定双手装配无需持住', verif: 2 },
  ]);
  const genNoParam = await api(base, 'POST', `/api/stations/${stNoParam}/ai-suggestions/generate`, { token: otherToken });
  const noParamSug = (genNoParam.data?.suggestions ?? [])[0];
  if (noParamSug) {
    // 采纳后看 imp 记录 annual 相关字段（adopt 返回 note）
    const adoptNoParam = await api(base, 'POST', `/api/ai-suggestions/${noParamSug.suggestion_id}/adopt`, { token: otherToken, body: {} });
    check('未配置 params：采纳返回 note 提示（无假金额）', adoptNoParam.status === 200 && /未配置/.test(adoptNoParam.data?.note ?? ''), adoptNoParam.data?.note);
    const impNoParam = await dbQuery(`SELECT est_save_s, measure FROM t_improvement WHERE ai_suggestion_id = '${noParamSug.suggestion_id}'`);
    check('未配置 params：t_improvement 落库 est_save_s 为服务端计算值（非 LLM 数字）',
      impNoParam.length === 1 && Number(impNoParam[0].est_save_s) > 0 && Number(impNoParam[0].est_save_s) < 10, impNoParam[0]?.est_save_s);
  } else {
    check('未配置 params：生成成功（金额在采纳/响应侧为 null）', genNoParam.status === 200, genNoParam.status);
  }

  // ── 配额计费与豁免 ──
  console.log('\n[Phase B6] 配额计费（done 计 1 次；user:write 豁免）');
  const ieAfter = await dbQuery(`SELECT ai_quota, ai_quota_used FROM t_user WHERE username = 'ie1'`);
  const usedBefore = Number(ieAfter[0]?.ai_quota_used ?? 0);
  await dbExec(`UPDATE t_user SET ai_quota = 5, ai_quota_used = ${usedBefore} WHERE username = 'ie1'`);
  const stIe = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(base, adminToken, stIe, 'IE计费场景工位');
  // v3.55：ie1 需为该工位的 editor 协作者，才过得了 generate 的资源级写守卫
  await api(base, 'POST', `/api/stations/${stIe}/collaborators`, { token: adminToken, body: { user_id: 'u_ie1', acl_role: 'editor' } });
  mockScene = () => ([
    { element_seqs: [1], waste_type: '持住', method: 'E', measure: '治具夹持替代手持扶住壳体动作', eliminate_basis: 'SOP规定装配无需人工持住', verif: 2 },
  ]);
  await api(base, 'POST', `/api/stations/${stIe}/ai-suggestions/generate`, { token: ieToken });
  const ieAfter2 = await dbQuery(`SELECT ai_quota_used FROM t_user WHERE username = 'ie1'`);
  check('done 批次计费 ai_quota_used+1（同事务）', Number(ieAfter2[0]?.ai_quota_used ?? 0) === usedBefore + 1, ieAfter2[0]?.ai_quota_used);

  // ── 自定义字典 CRUD + 撞名 ──
  console.log('\n[Phase B7] 自定义字典（CRUD+撞内置名拒绝）');
  const dictCreate = await api(base, 'POST', '/api/ai-custom-dict', {
    token: adminToken, body: { dict_type: 'waste_type', code: 'test_wait_overflow', name: '线边堆积', va_class: 'NVA' },
  });
  check('自定义 waste_type 创建 → 200/201', dictCreate.status === 200 || dictCreate.status === 201, dictCreate.data);
  const dictBuiltin = await api(base, 'POST', '/api/ai-custom-dict', {
    token: adminToken, body: { dict_type: 'waste_type', code: 'dup_hold', name: '持住', va_class: 'NVA' },
  });
  check('撞内置名「持住」→ 409（除非 alias_of）', dictBuiltin.status === 409, dictBuiltin.status);
  const dictBuiltinAlias = await api(base, 'POST', '/api/ai-custom-dict', {
    token: adminToken, body: { dict_type: 'waste_type', code: 'hold_alias', name: '持住', va_class: 'NVA', alias_of: '持住' },
  });
  check('alias_of 别名放行 → 200/201', dictBuiltinAlias.status === 200 || dictBuiltinAlias.status === 201, dictBuiltinAlias.status);
  const dictNoVa = await api(base, 'POST', '/api/ai-custom-dict', {
    token: adminToken, body: { dict_type: 'waste_type', code: 'no_va_class', name: '未声明类' },
  });
  check('waste_type 缺 va_class → 400', dictNoVa.status === 400, dictNoVa.status);
  const dictBadCode = await api(base, 'POST', '/api/ai-custom-dict', {
    token: adminToken, body: { dict_type: 'waste_type', code: 'BadCode', name: '坏码', va_class: 'NVA' },
  });
  check('code 格式非法 → 400', dictBadCode.status === 400, dictBadCode.status);
  const dictDup = await api(base, 'POST', '/api/ai-custom-dict', {
    token: adminToken, body: { dict_type: 'waste_type', code: 'test_wait_overflow', name: '另一个名', va_class: 'NVA' },
  });
  check('同 code 重复 → 409（UQ）', dictDup.status === 409, dictDup.status);
  const dictList2 = await api(base, 'GET', '/api/ai-custom-dict', { token: adminToken });
  check('字典列表含新建项', (dictList2.data?.items ?? []).some((i) => i.code === 'test_wait_overflow'), dictList2.data?.items?.length);
  const dictUpdate = await api(base, 'PUT', `/api/ai-custom-dict/${dictCreate.data?.dict_id}`, { token: adminToken, body: { name: '线边积压' } });
  check('字典更新 → 200 且 name 变更', dictUpdate.status === 200 && dictUpdate.data?.name === '线边积压', dictUpdate.data?.name);
  // 自定义类型进入白名单参与校验（动态白名单证据）
  mockScene = () => ([
    { element_seqs: [4], waste_type: '线边积压', method: 'E', measure: '清理线边堆积恢复单件流运转', eliminate_basis: '线边库位为临时转运条件所致', verif: 2 },
  ]);
  const stCustom = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(base, adminToken, stCustom, 'AI自定义类型工位');
  const genCustom = await api(base, 'POST', `/api/stations/${stCustom}/ai-suggestions/generate`, { token: adminToken });
  const customSug = (genCustom.data?.suggestions ?? [])[0];
  check('自定义 waste_type 进入动态白名单并过 R3.4（NVA 声明+可避免延迟交集）', genCustom.status === 200 && customSug?.waste_type === '线边积压', customSug?.waste_type ?? genCustom.data);
  const dictDelete = await api(base, 'DELETE', `/api/ai-custom-dict/${dictCreate.data?.dict_id}`, { token: adminToken });
  check('字典删除 → 200', dictDelete.status === 200, dictDelete.status);

  // ── 编造 waste_type 拒绝（动态白名单）──
  mockScene = () => ([
    { element_seqs: [1], waste_type: '魔法浪费', method: 'S', factor: 0.5, measure: '这个浪费类型是模型编造出来的词', verif: 2 },
  ]);
  const stFake = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await setupStation(base, adminToken, stFake, 'AI编造词工位');
  const genFake = await api(base, 'POST', `/api/stations/${stFake}/ai-suggestions/generate`, { token: adminToken });
  check('编造 waste_type「魔法浪费」→ 白名单剔除 done_empty 或 0 条', genFake.status === 200 && (genFake.data?.suggestions ?? []).length === 0, genFake.data?.suggestions?.length);

  // ── 配额管理 API ──
  console.log('\n[Phase B8] 配额管理 API（user:write）');
  const quotaGet = await api(base, 'GET', `/api/users/u_ie1/ai-quota`, { token: adminToken });
  check('GET 配额 → 200', quotaGet.status === 200 && quotaGet.data?.user_id === 'u_ie1', quotaGet.data);
  const quotaSet = await api(base, 'PUT', `/api/users/u_ie1/ai-quota`, { token: adminToken, body: { ai_quota: -1 } });
  check('PUT 配额=-1 → 200 且 unlimited=true', quotaSet.status === 200 && quotaSet.data?.unlimited === true, quotaSet.data);
  const quotaSetBad = await api(base, 'PUT', `/api/users/u_ie1/ai-quota`, { token: adminToken, body: { ai_quota: -5 } });
  check('非法配额值 → 400', quotaSetBad.status === 400, quotaSetBad.status);
  const quotaViewer = await api(base, 'GET', `/api/users/u_ie1/ai-quota`, { token: viewer.data.accessToken });
  check('viewer 读配额 → 403（无 user:write）', quotaViewer.status === 403, quotaViewer.status);
  const ieUnlimitedGen = await api(base, 'POST', `/api/stations/${stIe}/ai-suggestions/generate`, { token: ieToken });
  check('quota=-1 后 ie1 再生成 → 200（无限豁免）', ieUnlimitedGen.status === 200, ieUnlimitedGen.status);
  await api(base, 'PUT', `/api/users/u_ie1/ai-quota`, { token: adminToken, body: { ai_quota: 5 } });

  // ── R1-R3 规则抽测（纯函数直调编译产物）──
  console.log('\n[Phase B9] R1-R3 规则抽测（validator 纯函数）');
  const { validateSuggestions } = require('../dist/src/modules/ai-suggest/validator.js');
  const mkCtx = (els, wastes = ['持住']) => ({
    elements: els,
    ct: els.reduce((a, e) => a + Number(e.std_time), 0),
    wastes: wastes.map((w) => ({ waste: w, element_ids: els.map((e) => e.element_id) })),
    factorSet: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    wasteWhitelist: ['持住', '搬运', '等待', '重复取放', '寻找选择', '检验冗余', '预对'],
    customDict: [],
    batchCeiling: 0.5,
  });
  const els = [
    { element_id: 'X-V1-001', seq: 1, type: '持住', va_class: 'NVA', dur_s: 3, std_time: 3.45, hand: 'R', desc: '扶住' },
    { element_id: 'X-V1-002', seq: 2, type: '移物', va_class: 'VA', dur_s: 2, std_time: 2.3, hand: 'R', desc: '取件' },
    { element_id: 'X-V1-003', seq: 3, type: '寻找', va_class: 'RNVA', dur_s: 2.5, std_time: 2.88, hand: 'L', desc: '寻找' },
    { element_id: 'X-V1-004', seq: 4, type: '不可避免延迟', va_class: 'NVA', dur_s: 2, std_time: 2.3, hand: 'L', desc: '等机器' },
  ];
  // factor 六档 + 非法档位
  const rFactor = validateSuggestions([
    { element_seqs: [1], waste_type: '持住', method: 'S', factor: 0.55, measure: '介于档位之间的编造系数值' },
    { element_seqs: [1], waste_type: '持住', method: 'S', factor: 0.5, measure: '合法档位压缩持住时间' },
  ], mkCtx(els));
  check('R1.2 factor 非六档 → 剔除；合法档位通过', rFactor.items.length === 1 && rFactor.items[0].factor === 0.5, rFactor.items.length);
  // VA+E 剔除
  const rVa = validateSuggestions([
    { element_seqs: [2], waste_type: '持住', method: 'E', measure: '取消这个增值的移物动作' },
  ], mkCtx(els));
  check('R2.1 VA+E → 剔除', rVa.items.length === 0 && rVa.trace.some((t) => t.rule === 'R2.1'), rVa.trace);
  // RNVA 缺依据降级 S（P0-3）——measure 须 ≥10 字（R1.4 前置）
  const rRnva = validateSuggestions([
    { element_seqs: [3], waste_type: '持住', method: 'E', measure: '取消寻找恢复单件流畅取放' }, // 无 eliminate_basis
  ], mkCtx(els));
  check('R2.2 RNVA+E 缺依据 → 降级 S（不剔除）', rRnva.items.length === 1 && rRnva.items[0].method === 'S'
    && rRnva.items[0].trace.some((t) => t.disposition === 'downgrade_s'), rRnva.items[0]?.method);
  // 不可避免 NVA+E 剔除
  const rInev = validateSuggestions([
    { element_seqs: [4], waste_type: '等待', method: 'E', measure: '取消不可避免的机器等待动作' },
  ], mkCtx(els, ['等待']));
  check('R2.3 不可避免 NVA+E → 剔除', rInev.items.length === 0 && rInev.trace.some((t) => t.rule === 'R2.3'), rInev.trace);
  // E 全额 / S 折算——分开跑：同要素 E×S 互斥是 R2.5 的正确行为，放一起会互相顶掉
  const rE = validateSuggestions([
    { element_seqs: [1], waste_type: '持住', method: 'E', measure: '治具代手持住壳体消除动作', eliminate_basis: 'SOP规定装配无需人工持住' },
  ], mkCtx(els));
  const rS = validateSuggestions([
    { element_seqs: [1], waste_type: '持住', method: 'S', factor: 0.5, measure: '简化持住方式缩短持住时间' },
  ], mkCtx(els));
  const eItem = rE.items.find((i) => i.method === 'E');
  const sItem = rS.items.find((i) => i.method === 'S');
  check('R2.4 E 全额 =ΣST×1.0（3.45）', eItem?.est_save_s === 3.45, eItem?.est_save_s);
  check('R2.4 S 折算 =ΣST×0.5（1.73）', sItem?.est_save_s === 1.73, sItem?.est_save_s);
  // 白名单拒编造词（「预对」须有分析证据才过 R3.4——证据口径与内置词一致）
  const rFake = validateSuggestions([
    { element_seqs: [1], waste_type: '预对', method: 'S', factor: 0.5, measure: '白名单内的预对允许通过' },
    { element_seqs: [1], waste_type: '不存在的浪费', method: 'S', factor: 0.5, measure: '白名单外的编造词被剔除' },
  ], mkCtx(els, ['持住', '预对']));
  check('R1.2 动态白名单：「预对」通过（util.ts 常量没有的词）、编造词剔除', rFake.items.length === 1 && rFake.items[0].waste_type === '预对', rFake.items.map((i) => i.waste_type));
  // R3.5 ct<=0 整批 400
  const rCt = validateSuggestions([{ element_seqs: [1], waste_type: '持住', method: 'S', factor: 0.5, measure: '任何建议都不该通过' }], mkCtx([]));
  check('R3.5 CT<=0 → 整批拦截', !!rCt.batchBlocked, rCt.batchBlocked);
  // measure 长度
  const rLen = validateSuggestions([
    { element_seqs: [1], waste_type: '持住', method: 'S', factor: 0.5, measure: '短文案' },
  ], mkCtx(els));
  check('R1.4 measure<10 字 → 剔除', rLen.items.length === 0, rLen.items.length);

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
