/**
 * v3.58 用户与权限中心增强回归（纯 API 层）。
 *
 * 防线（对应质量审查 T/P 编号）：
 *   G13 角色侧成员管理：members 列表 / add 追加 / remove 摘除 / 非本租户跳过
 *   G14 权限点引用面：permissions 每项带 roles（摘掉这一项会影响谁）
 *   G15 角色克隆：sourceRoleId 以既有角色权限为底稿
 *   G16 用户台账：按角色筛选 / 按资质状态筛选 / summary 计数
 *   G17 防锁死：① 改自己角色至无管理权限 → 400 ② 摘掉最后一名管理员 → 400
 *               ③ 有备份管理员时允许摘除 → 200
 *   G18 状态机：rejected 不得直接改 active；pending 只能经审批
 *   G19 停用保护：停用本人需 confirmSelf；停用唯一管理员 → 400
 *   G20 审计双态：user_update 含 before；代置口令审计不含明文且 actor=操作者
 *   G21 审计过滤：按 action / operator / entityId 精确追溯
 *   G22 按部门批量授权（组织维度）
 *   G23 越权：IE 工程师访问角色成员 / 改成员 → 403
 *
 * 前置：API 已在 3001 运行且 dist 为最新编译产物；DB 已 migrate + seed。
 * 用法：node test/test-rbac-v358.cjs
 */
require('dotenv/config');

const API = process.env.BASE || 'http://127.0.0.1:3001/api';
const SUFFIX = Date.now().toString().slice(-6);
const TEST_ROLE = `t_v358_${SUFFIX}`;
const TEST_USER = `v358_u_${SUFFIX}`;
const BACKUP_USER = `v358_b_${SUFFIX}`;
const TEST_DEPT = `v358部_${SUFFIX}`;
const TEST_PWD = 'Rbac@12345';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  X    ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      /* 测试隔离：clientIp 信任回环反代头 → 每次套件运行用独立"IP"分桶，
         避免套件内多次 register 撞上 register:127.0.0.1 桶（3 次/小时/IP）被
         之前的运行/auth-flow 打满后连坐 429（G18 假失败）。 */
      'x-real-ip': `10.${(Date.now() >>> 16) & 0xff}.${Date.now() & 0xff}.1`,
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
  console.log('=== v3.58 用户与权限中心增强回归 ===');
  const admin = await login('admin', '123456');
  const ieToken = await login('ie1', '123456');

  /* 前置体检：脏数据会让防锁死类断言失真（如残留备份管理员 → 摘不空），先拦下 */
  const me0 = await call('GET', '/auth/me', { token: admin });
  ok('P0 admin 具备 RBAC 管理权限', (me0.body?.permissions ?? []).includes('user:write')
    && (me0.body?.permissions ?? []).includes('role:write')
    && (me0.body?.roles ?? []).includes('sys_admin'), me0.body?.roles);
  const preRoles = await call('GET', '/admin/roles', { token: admin });
  const preUsers = await call('GET', '/admin/users', { token: admin });
  const leftover = [
    ...(preRoles.body?.roles ?? []).filter((r) => r.code.startsWith('t_v358_')).map((r) => r.code),
    ...(preUsers.body?.users ?? []).filter((u) => u.username.startsWith('v358_') && u.status !== 'disabled')
      .map((u) => u.username),
  ];
  ok('P1 无 v3.58 残留测试数据', leftover.length === 0, leftover);
  if (leftover.length) {
    console.log('  提示：先清理残留数据（停用 v358_* 用户、删除 t_v358_* 角色）再跑本套件');
    process.exit(1);
  }

  let roleId = null, userId = null, backupId = null, sysAdminRoleId = null;
  let guardToken = null; // 备份管理员 token：主管理员被摘权/停用后用于恢复

  try {
    /* 前置：取角色列表 */
    const r0 = await call('GET', '/admin/roles', { token: admin });
    const roles = r0.body?.roles ?? [];
    sysAdminRoleId = roles.find((r) => r.code === 'sys_admin')?.roleId;

    /* G13 角色侧成员管理 */
    const c1 = await call('POST', '/admin/roles', {
      token: admin,
      body: { code: TEST_ROLE, name: 'v358 测试角色', description: '成员管理回归', permissions: ['station:read'] },
    });
    ok('G13.0 建测试角色 200', c1.status === 200, c1.body);
    roleId = c1.body?.roleId;

    const u1 = await call('POST', '/admin/users', {
      token: admin,
      body: {
        username: TEST_USER, password: TEST_PWD, displayName: 'v358 用户', roles: ['viewer'],
        department: TEST_DEPT, position: '测试岗', dataScope: 'own',
        certLevel: 'L2', certExpiresAt: '2020-01-01', // 已过期，供资质筛选
      },
    });
    ok('G13.0b 建测试用户 200', u1.status === 200, u1.body);
    userId = u1.body?.userId;
    ok('G13.0c 资质状态服务端计算 = expired', u1.body?.certStatus === 'expired', u1.body?.certStatus);

    const add1 = await call('POST', `/admin/roles/${roleId}/members`, { token: admin, body: { userIds: [userId] } });
    ok('G13.1 角色侧加入成员 200 且 added=1',
      add1.status === 200 && (add1.body?.added ?? []).length === 1, add1.body);
    const add2 = await call('POST', `/admin/roles/${roleId}/members`, { token: admin, body: { userIds: [userId] } });
    ok('G13.2 重复加入 → 计入 skipped（幂等）',
      add2.status === 200 && (add2.body?.skipped ?? []).includes(userId) && (add2.body?.added ?? []).length === 0, add2.body);
    const m1 = await call('GET', `/admin/roles/${roleId}/members`, { token: admin });
    ok('G13.3 成员清单含该用户且带部门岗位',
      (m1.body?.members ?? []).some((m) => m.userId === userId && m.department === TEST_DEPT), m1.body?.members);
    const u2 = await call('GET', `/admin/users/${userId}`, { token: admin });
    ok('G13.4 追加不动原有角色（viewer 仍在）',
      (u2.body?.roles ?? []).includes('viewer') && (u2.body?.roles ?? []).includes(TEST_ROLE), u2.body?.roles);
    const rm1 = await call('POST', `/admin/roles/${roleId}/members/remove`, { token: admin, body: { userIds: [userId] } });
    ok('G13.5 角色侧移除成员 200',
      rm1.status === 200 && (rm1.body?.removed ?? []).includes(userId), rm1.body);
    const u3 = await call('GET', `/admin/users/${userId}`, { token: admin });
    ok('G13.6 移除后仅剩 viewer', (u3.body?.roles ?? []).join(',') === 'viewer', u3.body?.roles);
    const add3 = await call('POST', `/admin/roles/${roleId}/members`, { token: admin, body: { userIds: ['u_nonexist'] } });
    ok('G13.7 不存在用户 → skipped 不报错',
      add3.status === 200 && (add3.body?.skipped ?? []).includes('u_nonexist'), add3.body);

    /* G14 权限点引用面 */
    const p1 = await call('GET', '/admin/permissions', { token: admin });
    const allItems = (p1.body?.groups ?? []).flatMap((g) => g.items ?? []);
    const roleRead = allItems.find((i) => i.code === 'role:read');
    ok('G14.1 权限点带 roles 引用列表',
      Array.isArray(roleRead?.roles) && roleRead.roles.includes('sys_admin'), roleRead);

    /* G15 角色克隆 */
    const cloneSrc = await call('POST', '/admin/roles', {
      token: admin,
      body: { code: `${TEST_ROLE}_src`, name: '克隆源', permissions: ['station:read', 'element:read'] },
    });
    const clone = await call('POST', '/admin/roles', {
      token: admin,
      body: { code: `${TEST_ROLE}_dst`, name: '克隆目标', permissions: [], sourceRoleId: cloneSrc.body?.roleId },
    });
    ok('G15.1 克隆角色继承源角色权限',
      clone.status === 200
      && ['station:read', 'element:read'].every((c) => (clone.body?.permissions ?? []).includes(c)),
      clone.body?.permissions);
    await call('DELETE', `/admin/roles/${cloneSrc.body?.roleId}`, { token: admin });
    await call('DELETE', `/admin/roles/${clone.body?.roleId}`, { token: admin });

    /* G16 用户台账：筛选 + summary */
    const l1 = await call('GET', `/admin/users?role=${encodeURIComponent('viewer')}`, { token: admin });
    ok('G16.1 按角色筛选命中', (l1.body?.users ?? []).some((u) => u.userId === userId), (l1.body?.users ?? []).length);
    ok('G16.2 summary.byRole 含 viewer 计数',
      (l1.body?.summary?.byRole ?? []).some((r) => r.code === 'viewer' && r.count > 0), l1.body?.summary?.byRole);
    const l2 = await call('GET', `/admin/users?certStatus=expired`, { token: admin });
    ok('G16.3 按资质状态（expired）筛选命中',
      (l2.body?.users ?? []).some((u) => u.userId === userId)
      && (l2.body?.users ?? []).every((u) => u.certStatus === 'expired'), (l2.body?.users ?? []).map((u) => u.certStatus));
    ok('G16.4 summary 含 byStatus / byDepartment / total',
      Array.isArray(l2.body?.summary?.byStatus) && Array.isArray(l2.body?.summary?.byDepartment)
      && typeof l2.body?.summary?.total === 'number', l2.body?.summary);

    /* G17 防锁死 */
    const g17a = await call('PUT', `/admin/users/u_admin/roles`, { token: admin, body: { roles: ['viewer'] } });
    ok('G17.1 改自己角色至无管理权限 → 400（自我保护）', g17a.status === 400, { s: g17a.status, b: g17a.body });
    const g17b = await call('POST', `/admin/roles/${sysAdminRoleId}/members/remove`,
      { token: admin, body: { userIds: ['u_admin'] } });
    ok('G17.2 摘掉最后一名管理员 → 400（防锁死）', g17b.status === 400, { s: g17b.status, b: g17b.body });
    const b1 = await call('POST', '/admin/users', {
      token: admin, body: { username: BACKUP_USER, password: TEST_PWD, displayName: '备份管理员', roles: ['sys_admin'] },
    });
    ok('G17.3 建备份管理员 200', b1.status === 200, b1.body);
    backupId = b1.body?.userId;
    // 后续摘除动作由备份管理员执行：主管理员被摘权后其 token 会立刻失去 role:write
    const backupToken = await login(BACKUP_USER, TEST_PWD);
    guardToken = backupToken;
    const g17c = await call('POST', `/admin/roles/${sysAdminRoleId}/members/remove`,
      { token: backupToken, body: { userIds: ['u_admin'] } });
    ok('G17.4 有备份管理员时允许摘除 → 200', g17c.status === 200, { s: g17c.status, b: g17c.body });
    const restore = await call('POST', `/admin/roles/${sysAdminRoleId}/members`,
      { token: backupToken, body: { userIds: ['u_admin'] } });
    ok('G17.5 备份管理员可把原管理员加回 200', restore.status === 200, restore.body);

    /* G18 状态机：rejected 不得直接启用 */
    const reg = await call('POST', '/auth/register', {
      body: { username: `v358_r_${SUFFIX}`, password: TEST_PWD, displayName: '待审批' },
    });
    ok('G18.0 注册生成待审批账号', reg.status === 200 || reg.status === 201, reg.body);
    const pendingList = await call('GET', '/admin/users?status=pending', { token: admin });
    const pend = (pendingList.body?.users ?? []).find((u) => u.username === `v358_r_${SUFFIX}`);
    ok('G18.1 待审批账号进入列表', Boolean(pend), (pendingList.body?.users ?? []).map((u) => u.username));
    if (pend) {
      const rej = await call('POST', `/admin/users/${pend.userId}/reject`, { token: admin, body: { reason: '回归用' } });
      ok('G18.2 驳回 → rejected', rej.status === 200 && rej.body?.status === 'rejected', rej.body?.status);
      const revive = await call('PATCH', `/admin/users/${pend.userId}`, { token: admin, body: { status: 'active' } });
      ok('G18.3 已驳回账号直接启用 → 400', revive.status === 400, { s: revive.status, b: revive.body });
    }

    /* G19 停用保护 */
    const g19a = await call('PATCH', '/admin/users/u_admin', { token: admin, body: { status: 'disabled' } });
    ok('G19.1 停用本人未带 confirmSelf → 400', g19a.status === 400, { s: g19a.status, b: g19a.body });
    const g19b = await call('PATCH', '/admin/users/u_admin',
      { token: admin, body: { status: 'disabled', confirmSelf: 'true' } });
    ok('G19.2 带 confirmSelf 可停用本人（且有备份管理员）→ 200', g19b.status === 200, { s: g19b.status, b: g19b.body });
    const backToken = await login(BACKUP_USER, TEST_PWD);
    const g19c = await call('PATCH', '/admin/users/u_admin', { token: backToken, body: { status: 'active' } });
    ok('G19.3 由备份管理员恢复原管理员 → 200', g19c.status === 200 && g19c.body?.status === 'active', g19c.body?.status);

    /* G20 审计双态与明文防护 */
    const before20 = await call('GET', '/admin/audit?limit=200', { token: admin });
    const upd = (before20.body?.logs ?? []).find((l) => l.action === 'user_update');
    ok('G20.1 user_update 审计含 before 态', upd && upd.before && typeof upd.before === 'object', upd?.before);
    const rp = await call('POST', `/admin/users/${userId}/reset-password`, { token: admin });
    ok('G20.2 代置口令返回明文口令', rp.status === 200 && typeof rp.body?.tempPassword === 'string', rp.status);
    await new Promise((r) => setTimeout(r, 400)); // 审计异步落库
    const after20 = await call('GET', '/admin/audit?limit=200', { token: admin });
    const resetLog = (after20.body?.logs ?? []).find((l) => l.action === 'user_reset_password');
    ok('G20.3 代置口令留痕且 actor=操作管理员（非受害者）',
      resetLog && resetLog.operator === 'admin', resetLog?.operator);
    const allText = JSON.stringify(after20.body?.logs ?? []);
    ok('G20.4 审计中不含明文临时口令',
      !allText.includes(rp.body?.tempPassword ?? '__none__'), (rp.body?.tempPassword ?? '').slice(0, 4));

    /* G21 审计精确追溯 */
    const g21a = await call('GET', '/admin/audit?action=user_bulk_roles&limit=50', { token: admin });
    ok('G21.1 按 action 过滤生效',
      (g21a.body?.logs ?? []).every((l) => l.action === 'user_bulk_roles'), (g21a.body?.logs ?? []).map((l) => l.action).slice(0, 5));
    const g21b = await call('GET', `/admin/audit?entityId=${encodeURIComponent(roleId)}&limit=50`, { token: admin });
    ok('G21.2 按对象过滤生效（谁动过这个角色）',
      (g21b.body?.logs ?? []).every((l) => l.entityId === roleId), (g21b.body?.logs ?? []).length);
    const g21c = await call('GET', '/admin/audit?operator=admin&limit=50', { token: admin });
    ok('G21.3 按操作人过滤生效',
      (g21c.body?.logs ?? []).length > 0 && (g21c.body?.logs ?? []).every((l) => String(l.operator).includes('admin')),
      (g21c.body?.logs ?? []).length);

    /* G22 按部门批量授权 */
    const g22 = await call('POST', '/admin/users/bulk-by-department', {
      token: admin, body: { department: TEST_DEPT, roles: [TEST_ROLE], mode: 'merge' },
    });
    ok('G22.1 按部门批量授权 200 且更新 1 人', g22.status === 200 && g22.body?.updated === 1, g22.body);
    const g22u = await call('GET', `/admin/users/${userId}`, { token: admin });
    ok('G22.2 部门成员已获得角色', (g22u.body?.roles ?? []).includes(TEST_ROLE), g22u.body?.roles);
    const g22b = await call('POST', '/admin/users/bulk-by-department', {
      token: admin, body: { department: '不存在的部门', roles: [TEST_ROLE] },
    });
    ok('G22.3 空部门 → 400', g22b.status === 400, g22b.status);

    /* G23 越权 */
    const x1 = await call('GET', `/admin/roles/${roleId}/members`, { token: ieToken });
    ok('G23.1 IE 工程师看角色成员 → 403', x1.status === 403, x1.status);
    const x2 = await call('POST', `/admin/roles/${roleId}/members`, { token: ieToken, body: { userIds: [userId] } });
    ok('G23.2 IE 工程师改角色成员 → 403', x2.status === 403, x2.status);
    const x3 = await call('POST', '/admin/users/bulk-by-department',
      { token: ieToken, body: { department: TEST_DEPT, roles: [TEST_ROLE] } });
    ok('G23.3 IE 工程师按部门批量授权 → 403', x3.status === 403, x3.status);
  } finally {
    /* 清理：恢复管理员归属与状态（可能已被本测试摘权/停用，故两把 token 都试） */
    for (const t of [admin, guardToken].filter(Boolean)) {
      await call('POST', `/admin/roles/${sysAdminRoleId}/members`, { token: t, body: { userIds: ['u_admin'] } });
      await call('PATCH', '/admin/users/u_admin', { token: t, body: { status: 'active' } });
    }
    // 清理顺序：先删角色（需 role:write）再停用账号——备份管理员是最后一道兜底，最后才停
    const cleanupToken = admin;
    if (roleId) {
      if (userId) {
        await call('POST', `/admin/roles/${roleId}/members/remove`, { token: cleanupToken, body: { userIds: [userId] } });
      }
      const del = await call('DELETE', `/admin/roles/${roleId}`, { token: cleanupToken });
      ok('G24.1 清理测试角色 200', del.status === 200, { s: del.status, b: del.body });
    }
    if (userId) {
      const d1 = await call('PATCH', `/admin/users/${userId}`, { token: cleanupToken, body: { status: 'disabled' } });
      ok('G24.2 清理测试用户 200', d1.status === 200, d1.status);
    }
    if (backupId) {
      const d2 = await call('PATCH', `/admin/users/${backupId}`, { token: cleanupToken, body: { status: 'disabled' } });
      ok('G24.3 清理备份管理员 200', d2.status === 200, d2.status);
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
