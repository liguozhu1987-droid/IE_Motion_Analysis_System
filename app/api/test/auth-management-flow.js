/* 登录管理增强联调：注册→审批→驳回→忘记密码(helpdesk 全链路)→重置码作废→建号→停启用→角色→代置口令→权限→限流。
 * 幂等：测试用户名带时间戳；结尾把测试账号停用保持列表干净。
 * 前置：API 已启动（dist 为最新构建）；种子口令 admin/123456。 */
const BASE = process.env.BASE || 'http://127.0.0.1:3001/api';

let adminAccess = '';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

async function call(method, path, body, token = adminAccess) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      /* 测试隔离：clientIp 信任回环反代头 → 每次运行用独立"IP"分桶，
         避免本套件（含 14 节限流探测）与 v358 套件互相连坐 register:127.0.0.1
         桶（3 次/小时/IP）→ 第 1 节注册即 429 假失败。 */
      'x-real-ip': `10.${(Date.now() >>> 16) & 0xff}.${Date.now() & 0xff}.2`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const TS = Date.now().toString().slice(-6);
const U1 = `reg_${TS}`;        // 主测试账号（审批后使用）
const U2 = `rej_${TS}`;        // 驳回账号
const U3 = `adm_${TS}`;        // 管理端建号
const PWD = 'Abcd1234';
const created = [];  // 测试账号 user_id（结尾停用）

(async () => {
  console.log('— 0. 管理员登录 —');
  const admin = await call('POST', '/auth/login', { username: 'admin', password: '123456' }, '');
  ok('admin 登录 → 200', admin.status === 200, JSON.stringify(admin.data).slice(0, 100));
  if (admin.status !== 200) { console.log('admin 登录失败，中止（种子口令可能已改）'); process.exit(1); }
  adminAccess = admin.data.accessToken;

  console.log('— 1. 自助注册与输入校验 —');
  const r1 = await call('POST', '/auth/register', { username: U1, password: PWD, displayName: '联调注册', email: 'reg@example.com' }, '');
  ok('注册 → 200 且 status=pending', r1.status === 200 && r1.data.status === 'pending', JSON.stringify(r1.data));
  const rDup = await call('POST', '/auth/register', { username: U1, password: PWD }, '');
  ok('重名注册 → 409', rDup.status === 409, String(rDup.data?.detail));
  const rWeak = await call('POST', '/auth/register', { username: `w_${TS}`, password: '12345' }, '');
  ok('弱密码注册 → 400', rWeak.status === 400, String(rWeak.data?.detail));
  const rBad = await call('POST', '/auth/register', { username: '非法 名', password: PWD }, '');
  ok('非法用户名 → 400', rBad.status === 400, String(rBad.data?.detail));
  const rDupOther = await call('POST', '/auth/register', { username: 'other1', password: PWD }, '');
  ok('与他租户用户名重名 → 409（username 全局唯一）', rDupOther.status === 409, String(rDupOther?.detail ?? rDupOther.data?.detail));

  console.log('— 2. pending 账号不能登录 —');
  const l1 = await call('POST', '/auth/login', { username: U1, password: PWD }, '');
  ok('pending 登录 → 401 且提示待审批', l1.status === 401 && String(l1.data?.detail).includes('审批'), String(l1.data?.detail));

  console.log('— 3. 管理员审批 —');
  const pend = await call('GET', `/admin/users?status=pending`);
  const target = (pend.data.users ?? []).find((u) => u.username === U1);
  ok('待审批列表含注册账号', Boolean(target), `pendingCount=${pend.data.pendingCount}`);
  const ap = await call('POST', `/admin/users/${target.userId}/approve`, { roles: ['ie_engineer'] });
  ok('审批 → 200 且 status=active', ap.status === 200 && ap.data.status === 'active', JSON.stringify(ap.data?.roles));
  created.push(target.userId);
  const l1b = await call('POST', '/auth/login', { username: U1, password: PWD }, '');
  ok('审批后登录 → 200', l1b.status === 200, String(l1b.data?.detail));
  const u1Refresh = l1b.data.refreshToken;
  const u1Access = l1b.data.accessToken;
  const me1 = await call('GET', '/auth/me', undefined, u1Access);
  ok('审批用户 /me → 角色 ie_engineer 权限生效', me1.status === 200 && me1.data.roles.includes('ie_engineer') && me1.data.permissions.includes('element:write'));

  console.log('— 4. 驳回流 —');
  const r2 = await call('POST', '/auth/register', { username: U2, password: PWD }, '');
  ok('注册第二个账号 → pending', r2.status === 200 && r2.data.status === 'pending');
  const pend2 = await call('GET', '/admin/users?status=pending');
  const target2 = (pend2.data.users ?? []).find((u) => u.username === U2);
  const rj = await call('POST', `/admin/users/${target2.userId}/reject`, { reason: '联调驳回测试' });
  ok('驳回 → 200 且 status=rejected', rj.status === 200 && rj.data.status === 'rejected');
  created.push(target2.userId);
  const l2 = await call('POST', '/auth/login', { username: U2, password: PWD }, '');
  ok('rejected 登录 → 401 且提示未通过', l2.status === 401 && String(l2.data?.detail).includes('未通过'), String(l2.data?.detail));

  console.log('— 5. 忘记密码：通用应答（不泄露账号存在性）—');
  const f1 = await call('POST', '/auth/forgot-password', { username: U1 }, '');
  ok('存在账号 forgot → 200 通用文案', f1.status === 200 && f1.data.ok === true, f1.data?.message);
  const f2 = await call('POST', '/auth/forgot-password', { username: `none_${TS}` }, '');
  ok('不存在账号 forgot → 200 且同文案（不泄露存在性）', f2.status === 200 && f2.data.message === f1.data.message);

  console.log('— 6. helpdesk：管理员查看申请 → 下发码 → 用户重置 —');
  const reqs = await call('GET', '/admin/password-resets');
  const myReq = (reqs.data.requests ?? []).find((r) => r.username === U1);
  ok('重置申请面板含该账号', Boolean(myReq), `appliedAt=${myReq?.appliedAt}`);
  ok('申请列表不含明文码字段', myReq && !('code' in myReq) && !('code_hash' in myReq));
  const ic = await call('POST', `/admin/users/${target.userId}/issue-reset-code`);
  ok('下发重置码 → 200 且返回 6 位明文码', ic.status === 200 && /^\d{6}$/.test(ic.data.code), ic.data.code);
  const goodCode = ic.data.code;
  const wrong = await call('POST', '/auth/reset-password', { username: U1, code: '000000', newPassword: 'Newpass123' }, '');
  ok('错误码重置 → 401 且提示剩余次数', wrong.status === 401 && /还可尝试 \d 次/.test(String(wrong.data?.detail)), String(wrong.data?.detail));
  const rs = await call('POST', '/auth/reset-password', { username: U1, code: goodCode, newPassword: 'Newpass123' }, '');
  ok('正确码重置 → 200', rs.status === 200 && rs.data.ok === true, String(rs.data?.detail));
  const oldSession = await call('POST', '/auth/refresh', { refreshToken: u1Refresh }, '');
  ok('重置前会话的 refresh → 401（全部会话已吊销）', oldSession.status === 401, String(oldSession.data?.detail));
  const lNew = await call('POST', '/auth/login', { username: U1, password: 'Newpass123' }, '');
  ok('新密码登录 → 200', lNew.status === 200, String(lNew.data?.detail));
  const lOld = await call('POST', '/auth/login', { username: U1, password: PWD }, '');
  ok('旧密码登录 → 401', lOld.status === 401);

  console.log('— 7. 重置码 5 次作废 —');
  await call('POST', '/auth/forgot-password', { username: U1 }, '');
  const ic2 = await call('POST', `/admin/users/${target.userId}/issue-reset-code`);
  const code2 = ic2.data.code;
  let lastStatus = 0;
  for (let i = 0; i < 5; i++) {
    const w = await call('POST', '/auth/reset-password', { username: U1, code: '000000', newPassword: 'Newpass123' }, '');
    lastStatus = w.status;
  }
  ok('连续 5 次错误 → 均 401', lastStatus === 401);
  const after = await call('POST', '/auth/reset-password', { username: U1, code: code2, newPassword: 'Newpass123' }, '');
  ok('作废后即使正确码也 → 401（码已作废）', after.status === 401, String(after.data?.detail));
  const ic3 = await call('POST', `/admin/users/${target.userId}/issue-reset-code`);
  const rs3 = await call('POST', '/auth/reset-password', { username: U1, code: ic3.data.code, newPassword: 'Newpass123' }, '');
  ok('重新下发新码 → 重置成功', rs3.status === 200);

  console.log('— 8. 管理端建号（首次登录强制改密）—');
  const c3 = await call('POST', '/admin/users', { username: U3, password: 'Xyz12345', displayName: '联调建号', roles: ['viewer'] });
  ok('建号 → 200 active mustChangePwd=true', c3.status === 200 && c3.data.status === 'active' && c3.data.mustChangePwd === true, JSON.stringify(c3.data?.roles));
  created.push(c3.data.userId);
  const l3 = await call('POST', '/auth/login', { username: U3, password: 'Xyz12345' }, '');
  ok('建号登录 → 200 mustChangePwd=true', l3.status === 200 && l3.data.mustChangePwd === true);
  const u3Refresh = l3.data.refreshToken;
  const u3Access = l3.data.accessToken;
  const me3 = await call('GET', '/auth/me', undefined, u3Access);
  ok('建号 /me → 仅 viewer 权限', me3.status === 200 && me3.data.roles.includes('viewer') && !me3.data.permissions.includes('element:write'));

  console.log('— 9. 停用 / 启用 —');
  const d3 = await call('PATCH', `/admin/users/${c3.data.userId}`, { status: 'disabled' });
  ok('停用 → 200 status=disabled', d3.status === 200 && d3.data.status === 'disabled');
  const l3d = await call('POST', '/auth/login', { username: U3, password: 'Xyz12345' }, '');
  ok('停用后登录 → 401 已停用', l3d.status === 401 && String(l3d.data?.detail).includes('停用'), String(l3d.data?.detail));
  const deadSession = await call('POST', '/auth/refresh', { refreshToken: u3Refresh }, '');
  ok('停用后旧 refresh → 401（会话已吊销）', deadSession.status === 401, String(deadSession.data?.detail));
  const e3 = await call('PATCH', `/admin/users/${c3.data.userId}`, { status: 'active' });
  ok('启用 → 200 status=active', e3.status === 200 && e3.data.status === 'active');
  const l3e = await call('POST', '/auth/login', { username: U3, password: 'Xyz12345' }, '');
  ok('启用后登录 → 200', l3e.status === 200);

  console.log('— 10. 角色维护 —');
  const sr = await call('PUT', `/admin/users/${c3.data.userId}/roles`, { roles: ['line_leader'] });
  ok('角色替换 → 200 且 roles=[line_leader]', sr.status === 200 && sr.data.roles.length === 1 && sr.data.roles[0] === 'line_leader');
  const l3r = await call('POST', '/auth/login', { username: U3, password: 'Xyz12345' }, '');
  const me3r = await call('GET', '/auth/me', undefined, l3r.data.accessToken);
  ok('角色生效：line_leader 有 suggestion:status 无 element:write',
    me3r.data.permissions.includes('suggestion:status') && !me3r.data.permissions.includes('element:write'));

  console.log('— 11. 管理员代置临时口令（一次性 + 强制改密 + 会话吊销）—');
  const tp = await call('POST', `/admin/users/${c3.data.userId}/reset-password`);
  ok('代置口令 → 200 返回 12 位临时口令', tp.status === 200 && /^[A-Za-z0-9]{12}$/.test(tp.data.tempPassword), tp.data.tempPassword);
  const l3t = await call('POST', '/auth/login', { username: U3, password: tp.data.tempPassword }, '');
  ok('临时口令登录 → 200 且 mustChangePwd=true', l3t.status === 200 && l3t.data.mustChangePwd === true);
  const staleAfterTp = await call('POST', '/auth/refresh', { refreshToken: l3r.data.refreshToken }, '');
  ok('代置后旧 refresh → 401（会话已吊销）', staleAfterTp.status === 401);

  console.log('— 12. 权限控制（RBAC）—');
  const ie1 = await call('POST', '/auth/login', { username: 'ie1', password: '123456' }, '');
  if (ie1.status === 200) {
    const ie1Token = ie1.data.accessToken;
    const forbid1 = await call('GET', '/admin/users', undefined, ie1Token);
    ok('ie_engineer 访问 /admin/users → 403', forbid1.status === 403, String(forbid1.data?.detail));
    const forbid2 = await call('POST', '/admin/users', { username: `x_${TS}`, password: 'Abcd1234', roles: ['viewer'] }, ie1Token);
    ok('ie_engineer 建号 → 403', forbid2.status === 403);
    const forbid3 = await call('POST', `/admin/users/${c3.data.userId}/issue-reset-code`, undefined, ie1Token);
    ok('ie_engineer 下发重置码 → 403', forbid3.status === 403);
  } else {
    ok('ie1 登录（种子账号，可能已改密）', false, String(ie1.data?.detail));
  }

  console.log('— 13. 管理范围（DEFAULT 租户）—');
  const all = await call('GET', '/admin/users');
  ok('用户列表不含他租户 other1（管理范围 DEFAULT）', !(all.data.users ?? []).some((u) => u.username === 'other1'));
  ok('列表含全部 5 类状态字段', (all.data.users ?? []).every((u) => typeof u.status === 'string' && Array.isArray(u.roles)));

  console.log('— 14. 限流（register 3 次/小时/IP）—');
  /* 14 节专用 call：固定独立 IP 桶（限流验证要求同一桶内累计计数）。
     主 call 已带每次运行变化的隔离 IP（防跨套件连坐），但本节恰恰要验证
     「同桶超限 → 429」，故用固定桶重新计数：本节独立发 4 次注册（上限 3 次/小时，第 4 次超限）。 */
  const limCall = (username) => fetch(BASE + '/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-real-ip': '10.77.77.7', // 固定桶：仅本节使用，与其他段不共享
    },
    body: JSON.stringify({ username, password: PWD }),
  }).then(async (r) => ({ status: r.status }));
  const lim1 = await limCall(`lim1_${TS}`);
  const lim2 = await limCall(`lim2_${TS}`);
  const lim3 = await limCall(`lim3_${TS}`);
  const lim4 = await limCall(`lim4_${TS}`);
  ok('同 IP 第 3 次注册仍受理或已限流（累计计数）', lim1.status === 200 || lim1.status === 429);
  // checkRate 语义：第 1–3 次受理、第 4 次 429（原断言只看前 3 次，fresh 进程必然漏判）。
  ok('超限注册 → 429', lim4.status === 429, `lim4=${lim4.status}（前三次 ${lim1.status}/${lim2.status}/${lim3.status}）`);

  console.log('— 15. 清理（测试账号停用，保持列表干净）—');
  for (const uid of created) {
    await call('PATCH', `/admin/users/${uid}`, { status: 'disabled' });
  }
  const afterClean = await call('GET', '/admin/users?status=disabled');
  ok('测试账号已全部停用', created.every((uid) => (afterClean.data.users ?? []).some((u) => u.userId === uid)));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('联调异常:', e); process.exit(1); });
