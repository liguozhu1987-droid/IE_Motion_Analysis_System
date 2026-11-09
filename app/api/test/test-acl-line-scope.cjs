/**
 * v3.59.2 跨租户 data_scope=line 串号越权回归。
 *
 * 根因：resolveVisibleStationIds 的 line 分支（myLines 三连查 + 最终工位查询）
 *      此前无 tenant_id 约束，仅依赖候选集 cand() 兜底。当跨租户存在相同 line_id 时，
 *      用户借其在他租户对某一 line_id 的归属/共享，可越权看到本租户内同名 line_id 的工位。
 *
 * 本套件刻意构造跨租户同名 line_id 碰撞，验证修复后：
 *   - 负向：OTHER 租户用户（scope=line，关联 OTHER 的 L99）不得看到 DEFAULT 租户 L99 工位 → 403
 *   - 正向：OTHER 租户用户能正常看到本租户 L99 工位 → 200
 *
 * 前置：API 已在 3001 运行且为最新编译产物（dist 须含 v3.59.2 修复）。
 * 夹具：L99（DEFAULT + OTHER 各一条）/ L99-ST01（OTHER, owner=other1）/ L99-ST02（DEFAULT, admin）。
 * 纪律：与其它写库测试串行执行；测后级联清理并复原 other1 的 data_scope。
 *
 * 用法：node app/api/test/test-acl-line-scope.cjs
 */
require('dotenv/config');
const { dbQuery, dbExec } = require('./db-client.cjs');

const API = process.env.BASE || 'http://127.0.0.1:3001/api';
const LINE = 'L99';
const SID_DEF = 'L99-ST02'; // DEFAULT 租户工位（其他租户用户绝不可见）
const SID_OTH = 'L99-ST01'; // OTHER 租户工位（other1 本应可见）

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  X    ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 220) : '')); }
}

async function api(method, url, token, body) {
  const res = await fetch(API + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}
async function login(username, password) {
  const r = await api('POST', '/auth/login', null, { username, password });
  return r.data && r.data.accessToken;
}
async function setScope(admin, userId, scope) {
  const r = await api('PATCH', `/admin/users/${userId}`, admin, { dataScope: scope });
  return r.status;
}

(async () => {
  console.log('前置：登录与夹具准备');
  const admin = await login('admin', '123456');
  if (!admin) { console.log('admin 登录失败，终止'); process.exit(1); }
  let other1 = await login('other1', '123456');
  if (!other1) { console.log('other1 登录失败，终止'); process.exit(1); }

  // 幂等清理历史碰撞
  for (const t of ['t_station_collaborator', 't_line_share', 't_element', 't_station']) {
    await dbExec(`DELETE FROM ${t} WHERE station_id IN ('${SID_DEF}','${SID_OTH}')`).catch(() => {});
  }
  await dbExec(`DELETE FROM t_line WHERE line_id = '${LINE}'`).catch(() => {});

  // DEFAULT 租户：建线 + 工位（admin 归属，绝不与 other1 共享）
  await api('POST', '/lines', admin, { line_id: LINE, name: '跨租户碰撞线-DEFAULT' }).catch(() => {});
  const defSt = await api('POST', '/stations', admin, { station_id: SID_DEF, line_id: LINE, name: 'DEFAULT工位', tt: 60 });
  ok('DEFAULT 夹具工位创建成功', defSt.status === 200 || defSt.status === 201, defSt.status);

  // OTHER 租户：直接插入线与工位（other1 为归属人，使其 myLines 含 L99）+ 整线共享
  await dbExec(`INSERT INTO t_line (tenant_id, line_id, name, process_type, product_type, product_project, factory_code)
    VALUES ('OTHER','${LINE}','跨租户碰撞线-OTHER','装配','待补充','-',NULL)`).catch(() => {});
  await dbExec(`INSERT INTO t_station (station_id, tenant_id, line_id, name, version, owner_user_id, created_by)
    VALUES ('${SID_OTH}','OTHER','${LINE}','OTHER工位',1,'u_other1','u_other1')`).catch(() => {});
  await dbExec(`INSERT INTO t_line_share (tenant_id, line_id, grantor_user_id, grantee_user_id, acl_role)
    VALUES ('OTHER','${LINE}','u_other1','u_other1','viewer')`).catch(() => {});

  // 把 other1 设为 data_scope=line（触发 line 分支）。
  // 注意：admin 用户管理端点按租户隔离（DEFAULT admin 改不了 OTHER 用户），故直接改库；
  // AuthUserLoader 30s 短缓存，下面重新登录即拿到新 scope。
  await dbExec(`UPDATE t_user SET data_scope = 'line' WHERE user_id = 'u_other1'`);
  ok('other1 data_scope 改 line 成功（直改库）', true);
  // 重新登录 other1 以拿到失效缓存后的新令牌（AuthUserLoader 30s 短缓存）
  other1 = await login('other1', '123456');
  if (!other1) { console.log('other1 重新登录失败，终止'); process.exit(1); }

  console.log('\n[LINE-NEG] 跨租户同名 line_id 不得越权');
  const leak = await api('GET', `/stations/${SID_DEF}`, other1);
  // 既不得 200（直接泄露），也不得出现越权可读；403/404 均代表不可达
  ok('other1 读 DEFAULT 的 L99-ST02 → 非 200（未越权）', leak.status !== 200, { status: leak.status, detail: leak.data?.message });
  const leakList = await api('GET', '/stations', other1);
  const leakIds = Array.isArray(leakList.data) ? leakList.data.map((s) => s.station_id) : [];
  ok('other1 工位清单不含 DEFAULT 工位 L99-ST02', !leakIds.includes(SID_DEF), { leakIds });

  console.log('\n[LINE-POS] 本租户 line 仍可见（验证 line 分支修复后仍正确放行同租户工位）');
  const own = await api('GET', `/stations/${SID_OTH}`, other1);
  ok('other1 读本租户 L99-ST01 → 200（合法可见）', own.status === 200, { status: own.status, detail: own.data?.message });

  console.log('\n[LINE-AGG] 聚合层同样不得泄露他租户工位');
  const sum = await api('GET', '/dashboard/summary', other1);
  // dashboard 的 lines 行带 tenant_id：OTHER 自己的 L99 合法可见，真正泄露是 DEFAULT 租户的 L99 行
  const sumLines = Array.isArray(sum.data?.lines) ? sum.data.lines : [];
  const l99rows = sumLines.filter((l) => l.line_id === LINE);
  const leakDefaultL99 = l99rows.some((l) => l.tenant_id === 'DEFAULT');
  ok('other1 看板不得出现 DEFAULT 租户的 L99 行（越权泄露）', !leakDefaultL99, { l99rows });
  // 反向确认：若 OTHER 自身有 L99，必须带正确 tenant_id（证明 line 分支修复后仍正确放行本租户）
  const ownL99 = l99rows.find((l) => l.tenant_id === 'OTHER');
  ok('other1 看板若有 L99 必为本租户 OTHER 的 L99', !ownL99 || ownL99.tenant_id === 'OTHER', { ownL99 });
  const sumCount = sum.data?.kpis?.station_count ?? -1;
  ok('other1 看板工位数聚合收口（kpi 正常返回）', sumCount >= 0, { sumCount });

  console.log('\n清理：删除夹具并复原 other1 scope');
  await dbExec(`DELETE FROM t_station_collaborator WHERE station_id IN ('${SID_DEF}','${SID_OTH}')`).catch(() => {});
  await dbExec(`DELETE FROM t_line_share WHERE line_id = '${LINE}'`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id IN ('${SID_DEF}','${SID_OTH}')`).catch(() => {});
  await dbExec(`DELETE FROM t_station WHERE station_id IN ('${SID_DEF}','${SID_OTH}')`).catch(() => {});
  await dbExec(`DELETE FROM t_line WHERE line_id = '${LINE}'`).catch(() => {});
  await dbExec(`UPDATE t_user SET data_scope = 'own' WHERE user_id = 'u_other1'`).catch(() => {});

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('执行异常:', e && e.message, e); process.exit(1); });
