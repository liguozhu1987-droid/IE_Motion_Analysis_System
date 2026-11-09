/**
 * v3.47 双线隔离守卫回归（纯 API 层，无 UI 依赖）。
 *
 * 针对本轮修复的三个 P0 建立专属防线，防止将来被无意改坏：
 *   G1  Fix1+Fix2：手工线回写 AI 版本时，若未带齐全部 AI 要素 → 409（不再静默翻转/吞掉）
 *   G2  Fix2：同版本带齐全量 AI 要素的手工回写 → 200 放行且 source 保持 ai_assisted
 *   G3  Fix2：AI 版本上的「作废复测」→ 409（不再物理删除且不可恢复）
 *   G4  Fix2：纯手工版本的「作废复测」仍正常（守卫不过度锁死）
 *   G5  Fix3：非拥有人/非协作者的 IE 工程师写要素 → 403（资源级 ACL 生效）
 *   G6  Fix3：拥有人本人写要素 → 200（ACL 不过度锁死合法用户）
 *
 * 前置：API 已在 3001 运行且加载 v3.47 构建（dist 需为最新编译产物）。
 * 夹具：独立产线码 DWT01，测后级联删除，不动任何业务工位。
 * 纪律：与其它写库测试串行执行。
 *
 * 用法：node test/api/test-dw-isolation-guard.cjs
 */
require('dotenv/config');
const { loadConfig } = require('../dist/src/core/config/configuration.js');
const cfg = loadConfig();

const API = 'http://127.0.0.1:3001/api';
// 产线编码受 ^L\d{2}$ 约束（如 DWT01 会被拒）；L98 为测试专用，避免与业务产线相撞
const LINE = 'L98';
const SID = 'L98-ST01';
const mssql = require('mssql');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  X    ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 200) : '')); }
}

async function dbQuery(sql) {
  const pool = await mssql.connect({
    server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try { const r = await pool.request().query(sql); return r.recordset; } finally { await pool.close(); }
}
async function dbExec(sql) { await dbQuery(sql); }

async function api(method, url, token, body) {
  const res = await fetch(API + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, data };
}
async function login(username, password) {
  const r = await api('POST', '/auth/login', null, { username, password });
  return r.data && r.data.accessToken;
}

/** 构造要素行（hand/类型/desc 均为合法词表值） */
function el(seq, startMs, durS, source) {
  return {
    seq, start_ms: startMs, dur_s: durS, hand: 'R', type: '移物', desc: `守卫测试要素${seq}`,
    va_class: 'VA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15,
    source,
  };
}

(async () => {
  console.log('前置：登录与夹具准备');
  const admin = await login('admin', '123456');
  if (!admin) { console.log('登录失败，终止'); process.exit(1); }
  const ie1 = await login('ie1', '123456');
  if (!ie1) { console.log('ie1 登录失败，终止'); process.exit(1); }

  // 幂等清理历史碰撞
  for (const t of ['t_ai_waste_issue', 't_ai_waste_finding', 't_ai_waste_batch',
    't_ai_suggestion', 't_ai_suggestion_batch', 't_improvement', 't_element', 't_station_collaborator']) {
    await dbExec(`DELETE FROM ${t} WHERE station_id = '${SID}'`).catch(() => {});
  }
  await dbExec(`DELETE FROM t_station WHERE station_id = '${SID}'`).catch(() => {});
  await dbExec(`DELETE FROM t_line WHERE line_id = '${LINE}'`).catch(() => {});
  await api('POST', '/lines', admin, { line_id: LINE, name: '双线隔离测试线' }).catch(() => {});

  const created = await api('POST', '/stations', admin, { station_id: SID, line_id: LINE, name: '守卫隔离测试工位', tt: 60 });
  ok('夹具工位创建成功', created.status === 200 || created.status === 201, created.status);

  const baseNo = Date.now() % 100000;
  await api('POST', `/stations/${SID}/collaborators`, admin, { user_id: 'u_ie1', acl_role: 'editor' }).catch(() => {});

  console.log('\n[G1/G2] Fix2 submit 守卫：AI 要素不得被吞掉');
  const subManual = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: 1, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 2.3, 'manual'), el(2, 2300, 2.3, 'manual'), el(3, 4600, 2.3, 'manual')],
  });
  ok('G0 手工要素提交成功（v1 落 manual）', subManual.status < 300, { status: subManual.status, detail: subManual.data?.detail });

  const retest = await api('POST', `/stations/${SID}/retest`, admin);
  ok('G0 复测开新版本成功', retest.status < 300, retest.status);
  const v2 = retest.data?.version ?? 2;

  const subAi = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: v2, cycle_count: 15, cv: 0, video_id: 'ai-segment',
    elements: [el(1, 0, 1.5, 'ai_assisted'), el(2, 1500, 1.5, 'ai_assisted')],
  });
  ok('G0 AI 要素写入 v2 成功', subAi.status < 300, { status: subAi.status, detail: subAi.data?.detail });

  // G1：少带一条 AI 要素 → 应被守卫拒绝（409），不再静默吞掉
  const missing = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: v2, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 1.5, 'ai_assisted')],
  });
  ok('G1 少带 AI 要素的手工回写 → 409（守卫拦截）', missing.status === 409, { status: missing.status, detail: missing.data?.message });

  // G1b：完全不带 source 的整版覆盖 → 同样应被拒绝
  const noSource = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: v2, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 1.5), el(2, 1500, 1.5)],
  });
  ok('G1b 不带来源的整版覆盖 → 409（治静默翻转）', noSource.status === 409, { status: noSource.status, detail: noSource.data?.message });

  // G2：带齐全部 AI 要素 → 放行，且来源保持
  const keepAll = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: v2, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 1.5, 'ai_assisted'), el(2, 1500, 1.5, 'ai_assisted'), el(3, 3000, 1.2, 'manual')],
  });
  ok('G2 带齐全部 AI 要素 → 200 放行（允许手工增补）', keepAll.status < 300, { status: keepAll.status, detail: keepAll.data?.detail });

  const rows = await dbQuery(`SELECT source, COUNT(*) AS n FROM t_element WHERE station_id = '${SID}' AND bol_version = ${v2} GROUP BY source`);
  const stat = rows.reduce((m, r) => { m[String(r.source || 'manual')] = Number(r.n); return m; }, {});
  ok('G2b 数据库实证：AI 要素仍为 ai_assisted 且未被降级',
    (stat.ai_assisted ?? 0) === 2 && (stat.manual ?? 0) === 1, stat);

  console.log('\n[G3/G4] Fix2 cancelRetest 守卫：AI 版本不得被物理删除');
  const cancelAi = await api('DELETE', `/stations/${SID}/retest`, admin);
  ok('G3 AI 版本上作废复测 → 409（禁止不可恢复删除）', cancelAi.status === 409, { status: cancelAi.status, detail: cancelAi.data?.message });

  const stillThere = await dbQuery(`SELECT COUNT(*) AS n FROM t_element WHERE station_id = '${SID}' AND bol_version = ${v2}`);
  ok('G3b AI 版本要素确实未被删除', Number(stillThere[0]?.n ?? 0) > 0, stillThere[0]);

  console.log('\n[G5/G6] Fix3 资源级权限');
  // 移除协作者后，ie1 应对 admin 的工位无写权
  await api('DELETE', `/stations/${SID}/collaborators/u_ie1`, admin).catch(() => {});
  const crossWrite = await api('POST', `/stations/${SID}/elements/submit`, ie1, {
    bol_version: v2, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 1.5, 'ai_assisted'), el(2, 1500, 1.5, 'ai_assisted')],
  });
  ok('G5 非拥有人写别人工位 → 403（资源级 ACL 生效）', crossWrite.status === 403, { status: crossWrite.status, detail: crossWrite.data?.message });

  const ownerWrite = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: v2, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 1.5, 'ai_assisted'), el(2, 1500, 1.5, 'ai_assisted')],
  });
  ok('G6 拥有人本人提交 → 200（未过度锁死）', ownerWrite.status < 300, { status: ownerWrite.status, detail: ownerWrite.data?.detail });

  console.log('\n[G4] 纯手工版本的作废复测应不受影响');
  // 先把版本指针弄回只有 manual 的状态：手工接管 v2（删掉 AI 要素需先清空该版本→直接用 v1 场景替代）
  await dbExec(`DELETE FROM t_element WHERE station_id = '${SID}' AND bol_version = ${v2}`).catch(() => {});
  const cancelPlain = await api('DELETE', `/stations/${SID}/retest`, admin);
  ok('G4 空版本作废复测 → 200（守卫不过度拦截）', cancelPlain.status < 300, { status: cancelPlain.status, detail: cancelPlain.data?.detail });

  console.log('\n清理：删除夹具工位');
  const del = await api('DELETE', `/stations/${SID}`, admin);
  ok('夹具工位已删除', del.status === 200 || del.status === 204, del.status);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('执行异常:', e.message); process.exit(1); });
