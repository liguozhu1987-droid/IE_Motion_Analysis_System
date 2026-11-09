/**
 * v3.50 用户与权限中心回归（纯 API 层）。
 *
 * 防线：
 *   G1  角色列表：内置 5 系统角色 + 自定义角色，成员数正确
 *   G2  权限字典：按模块分组，含新增 role:read
 *   G3  新建角色：code 小写/唯一校验（大写 400、重复 400、合法 200）
 *   G4  权限分配：PUT 全量替换生效，非法权限点 400
 *   G5  防锁死：sys_admin 的 user:read/user:write/role:read/role:write 强制保留
 *   G6  删除保护：系统角色 400 / 有成员角色 400 / 空自定义角色 200
 *   G7  人员档案：建号带部门岗位工号数据范围资质；非法 dataScope 400
 *   G8  批量授权：replace 与 merge 语义正确，自我保护跳过操作者本人
 *   G9  生效权限：按角色展开 + 并集
 *   G10 缓存即时失效：改角色权限后 /auth/me 立即反映（不等 30s）
 *   G11 审计留痕：/admin/audit 返回 role_create / role_permissions
 *   G12 越权拦截：IE 工程师（无 role:read）访问 /admin/roles → 403
 *
 * 前置：API 已在 3001 运行且 dist 为最新编译产物；DB 已 migrate + seed。
 * 用法：node test/test-rbac-admin.cjs
 */
require('dotenv/config');

const API = 'http://127.0.0.1:3001/api';
const SUFFIX = Date.now().toString().slice(-6);
const TEST_ROLE_CODE = `t_role_${SUFFIX}`;
const TEST_USER = `rbac_u_${SUFFIX}`;
const TEST_PWD = 'Rbac@12345';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  X    ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 260) : '')); }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function login(username, password) {
  const r = await call('POST', '/auth/login', { body: { username, password } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`登录失败 ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

(async () => {
  console.log('=== v3.50 用户与权限中心回归 ===');
  const admin = await login('admin', '123456');
  const ieToken = await login('ie1', '123456');

  let testRoleId = null;
  let testUserId = null;

  try {
    /* G1 角色列表 */
    const r1 = await call('GET', '/admin/roles', { token: admin });
    ok('G1.1 角色列表 200', r1.status === 200, r1.status);
    const roles = r1.body?.roles ?? [];
    ok('G1.2 含 5 个系统角色', ['sys_admin', 'ie_admin', 'ie_engineer', 'line_leader', 'viewer']
      .every((c) => roles.some((r) => r.code === c && r.isSystem === true)), roles.map((r) => r.code));
    ok('G1.3 含自定义角色 quality_auditor（isSystem=false）',
      roles.some((r) => r.code === 'quality_auditor' && r.isSystem === false), roles.map((r) => `${r.code}:${r.isSystem}`));
    const sysAdmin = roles.find((r) => r.code === 'sys_admin');
    ok('G1.4 sys_admin 成员数 >= 1', (sysAdmin?.memberCount ?? 0) >= 1, sysAdmin);
    ok('G1.5 角色返回权限点数组', Array.isArray(sysAdmin?.permissions) && sysAdmin.permissions.includes('user:write'), sysAdmin?.permissions);

    /* G2 权限字典 */
    const r2 = await call('GET', '/admin/permissions', { token: admin });
    const groups = r2.body?.groups ?? [];
    ok('G2.1 权限字典 200 且按模块分组', r2.status === 200 && groups.length > 0, r2.status);
    ok('G2.2 含 rbac 模块且含 role:read',
      groups.some((g) => g.module === 'rbac' && g.items.some((i) => i.code === 'role:read')), groups.map((g) => g.module));

    /* G3 新建角色 */
    const bad1 = await call('POST', '/admin/roles', { token: admin, body: { code: 'Bad_Code', name: '大写拒绝', permissions: [] } });
    ok('G3.1 大写 code → 400', bad1.status === 400, bad1.status);
    const bad2 = await call('POST', '/admin/roles', { token: admin, body: { code: 'viewer', name: '重复', permissions: [] } });
    ok('G3.2 重复 code → 400', bad2.status === 400, bad2.status);
    const c1 = await call('POST', '/admin/roles', {
      token: admin,
      body: { code: TEST_ROLE_CODE, name: '回归测试角色', description: 'v3.50 回归用', permissions: ['station:read'] },
    });
    ok('G3.3 合法新建 → 200', c1.status === 200, c1.body);
    testRoleId = c1.body?.roleId;
    ok('G3.4 新角色权限正确落库', JSON.stringify(c1.body?.permissions) === JSON.stringify(['station:read']), c1.body?.permissions);

    /* G4 权限分配 */
    const bad3 = await call('PUT', `/admin/roles/${testRoleId}/permissions`, { token: admin, body: { permissions: ['not:exist'] } });
    ok('G4.1 非法权限点 → 400', bad3.status === 400, bad3.status);
    const p1 = await call('PUT', `/admin/roles/${testRoleId}/permissions`, {
      token: admin, body: { permissions: ['station:read', 'element:read', 'analysis:read', 'auth:self'] },
    });
    ok('G4.2 全量替换 → 200 且为 4 项', p1.status === 200 && p1.body?.permissions?.length === 4, p1.body?.permissions);

    /* G5 防锁死 */
    const saId = roles.find((r) => r.code === 'sys_admin')?.roleId;
    const lock = await call('PUT', `/admin/roles/${saId}/permissions`, { token: admin, body: { permissions: [] } });
    ok('G5.1 sys_admin 清空权限仍保留 4 项 rbac 权限',
      lock.status === 200 && ['user:read', 'user:write', 'role:read', 'role:write']
        .every((c) => (lock.body?.permissions ?? []).includes(c)), lock.body?.permissions);
    // 复原 sys_admin 全量权限
    await call('PUT', `/admin/roles/${saId}/permissions`, { token: admin, body: { permissions: sysAdmin.permissions } });

    /* G6 删除保护（系统角色） */
    const d1 = await call('DELETE', `/admin/roles/${saId}`, { token: admin });
    ok('G6.1 系统角色 → 400', d1.status === 400, d1.status);

    /* G7 人员档案 */
    const bad4 = await call('POST', '/admin/users', {
      token: admin,
      body: { username: TEST_USER, password: TEST_PWD, roles: ['viewer'], dataScope: 'universe' },
    });
    ok('G7.1 非法 dataScope → 400', bad4.status === 400, bad4.status);
    const u1 = await call('POST', '/admin/users', {
      token: admin,
      body: {
        username: TEST_USER, password: TEST_PWD, displayName: '回归测试用户', roles: [TEST_ROLE_CODE],
        department: 'IE 部', position: '测试工程师', employeeNo: `E${SUFFIX}`,
        dataScope: 'tenant', certLevel: 'L2', certExpiresAt: '2027-12-31',
      },
    });
    ok('G7.2 带档案建号 → 200', u1.status === 200, u1.body);
    testUserId = u1.body?.userId;
    ok('G7.3 档案字段回显正确',
      u1.body?.department === 'IE 部' && u1.body?.position === '测试工程师' && u1.body?.employeeNo === `E${SUFFIX}`
      && u1.body?.dataScope === 'tenant' && u1.body?.certLevel === 'L2' && String(u1.body?.certExpiresAt).startsWith('2027'),
      u1.body);
    const l1 = await call('GET', `/admin/users?department=${encodeURIComponent('IE 部')}`, { token: admin });
    ok('G7.4 按部门筛选命中', (l1.body?.users ?? []).some((u) => u.userId === testUserId), (l1.body?.users ?? []).length);
    ok('G7.5 部门字典返回', Array.isArray(l1.body?.departments) && l1.body.departments.includes('IE 部'), l1.body?.departments);

    /* G6.2 有成员角色 → 400（测试用户已持有该角色） */
    const d2 = await call('DELETE', `/admin/roles/${testRoleId}`, { token: admin });
    ok('G6.2 有成员角色 → 400', d2.status === 400, { status: d2.status, body: d2.body });

    /* G9 生效权限（先于 G8，因 G8 会改角色） */
    const e1 = await call('GET', `/admin/users/${testUserId}/permissions`, { token: admin });
    ok('G9.1 生效权限 200', e1.status === 200, e1.status);
    ok('G9.2 并集 = 该角色 4 项', (e1.body?.permissions ?? []).length === 4, e1.body?.permissions);
    ok('G9.3 byRole 展开含角色名', (e1.body?.byRole ?? []).length === 1 && e1.body.byRole[0].code === TEST_ROLE_CODE, e1.body?.byRole);

    /* G10 缓存即时失效：改角色权限后 /auth/me 立即反映 */
    const userToken = await login(TEST_USER, TEST_PWD);
    const me1 = await call('GET', '/auth/me', { token: userToken });
    ok('G10.1 改前 me 权限 4 项', (me1.body?.permissions ?? []).length === 4, me1.body);
    await call('PUT', `/admin/roles/${testRoleId}/permissions`, {
      token: admin, body: { permissions: ['station:read', 'element:read', 'analysis:read', 'auth:self', 'compare:read'] },
    });
    const me2 = await call('GET', '/auth/me', { token: userToken });
    ok('G10.2 改后 me 权限立即变 5 项（缓存已失效）',
      (me2.body?.permissions ?? []).length === 5 && me2.body.permissions.includes('compare:read'), me2.body?.permissions);

    /* G8 批量授权 */
    const b1 = await call('POST', '/admin/users/bulk-roles', {
      token: admin, body: { userIds: [testUserId], roles: ['viewer'], mode: 'merge' },
    });
    ok('G8.1 merge 后用户含 viewer', b1.status === 200, b1.body);
    const u2 = await call('GET', `/admin/users/${testUserId}`, { token: admin });
    ok('G8.2 merge 保留原角色', (u2.body?.roles ?? []).sort().join(',') === [TEST_ROLE_CODE, 'viewer'].sort().join(','), u2.body?.roles);
    const b2 = await call('POST', '/admin/users/bulk-roles', {
      token: admin, body: { userIds: [testUserId, 'u_admin'], roles: ['viewer'], mode: 'replace' },
    });
    ok('G8.3 replace 生效且自我保护跳过 admin 本人',
      b2.status === 200 && b2.body?.updated === 1 && (b2.body?.skipped ?? []).includes('u_admin'), b2.body);
    const b3 = await call('POST', '/admin/users/bulk-roles', { token: admin, body: { userIds: [], roles: ['viewer'] } });
    ok('G8.4 空用户列表 → 400', b3.status === 400, b3.status);

    /* G11 审计 */
    const a1 = await call('GET', '/admin/audit?entity=rbac&limit=50', { token: admin });
    const actions = (a1.body?.logs ?? []).map((l) => l.action);
    ok('G11.1 审计 200', a1.status === 200, a1.status);
    ok('G11.2 含 role_create 与 role_permissions', actions.includes('role_create') && actions.includes('role_permissions'), actions.slice(0, 8));
    const a2 = await call('GET', '/admin/audit?entity=user&limit=50', { token: admin });
    const uActions = (a2.body?.logs ?? []).map((l) => l.action);
    ok('G11.3 含 user_create 与 user_bulk_roles', uActions.includes('user_create') && uActions.includes('user_bulk_roles'), uActions.slice(0, 8));

    /* G12 越权 */
    const x1 = await call('GET', '/admin/roles', { token: ieToken });
    ok('G12.1 IE 工程师访问角色列表 → 403', x1.status === 403, x1.status);
    const x2 = await call('PUT', `/admin/roles/${testRoleId}/permissions`, { token: ieToken, body: { permissions: ['station:read'] } });
    ok('G12.2 IE 工程师改权限 → 403', x2.status === 403, x2.status);
  } finally {
    /* 清理 */
    if (testUserId) {
      await call('PATCH', `/admin/users/${testUserId}`, { token: admin, body: { status: 'disabled' } });
    }
    if (testRoleId) {
      const del = await call('DELETE', `/admin/roles/${testRoleId}`, { token: admin });
      ok('G6.3 无成员自定义角色 → 200 可删', del.status === 200, { status: del.status, body: del.body });
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
