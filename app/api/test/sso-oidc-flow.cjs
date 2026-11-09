/**
 * 统一身份认证（OIDC 双轨开关）隔离套件。
 *
 * 由 `test/sso-oidc-isolated.cjs` 拉起：
 *  - 本套件通过 HTTP 驱动隔离 API（env BASE）；
 *  - 由本地假 OIDC 提供方（env FAKE_OIDC_CONTROL）提供 discovery / authorize / token；
 *  - SSO 中央表夹具由基座 extraSql 写入临时 SQLite，套件可直接查库核对自动建档与离职回写。
 *
 * 三种运行模式（env SSO_MODE）：
 *   dual    = OIDC 开 + 本地登录开（双轨并存）
 *   off     = OIDC 关（四端点 404，本地登录与改造前完全一致）
 *   nolocal = OIDC 开 + 本地登录关（本地入口 403，SSO 仍可用）
 *
 * 输出严格按 `结果：N 通过 / M 失败` 供基座解析。不连接 CN_AME、不写正式库。
 */
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const BASE = (process.env.BASE ?? 'http://127.0.0.1:3001/api').replace(/\/+$/, '');
const API_ORIGIN = BASE.replace(/\/api$/, '');
const MODE = process.env.SSO_MODE ?? 'dual';
const CONTROL_URL = process.env.FAKE_OIDC_CONTROL ?? '';

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 3000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

let dbHandle = null;
function db() {
  if (!dbHandle) dbHandle = new DatabaseSync(process.env.DB_PATH);
  return dbHandle;
}
function dbRow(sql, ...params) {
  const stmt = db().prepare(sql);
  return stmt.get(...params);
}
function dbCount(sql, ...params) {
  const row = dbRow(sql, ...params);
  return row ? Number(row.n) : 0;
}

async function control(patch) {
  const res = await fetch(CONTROL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  assert(res.ok, `假 IdP __control 失败 HTTP ${res.status}`);
  return (await res.json()).scenario;
}

function hashParams(location) {
  const i = location.indexOf('?');
  return new URLSearchParams(i >= 0 ? location.slice(i + 1) : '');
}

async function beginSso() {
  const res = await fetch(`${BASE}/auth/oidc/login`, { redirect: 'manual' });
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    location: res.headers.get('location') ?? '',
    body: res.headers.get('location') ? '' : await res.text(),
  };
}

/** 完整走一遍「发起 → IdP 授权 → 回调」，返回 otk 或错误码（不兑换令牌） */
async function ssoHandshake(patch) {
  if (patch) await control(patch);
  const started = await beginSso();
  assert(started.status === 302, `发起登录期望 302，实际 ${started.status}`);
  assert(started.location.startsWith('http'), '发起登录的 Location 不是绝对授权地址');
  const authorizeUrl = new URL(started.location);
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  assert(authorized.status === 302, `IdP 授权期望 302，实际 ${authorized.status}`);
  const callbackUrl = authorized.headers.get('location') ?? '';
  const cb = await fetch(callbackUrl, { redirect: 'manual' });
  const location = cb.headers.get('location') ?? '';
  const params = hashParams(location);
  return {
    authorizeUrl,
    callbackUrl,
    callbackStatus: cb.status,
    location,
    otk: params.get('otk'),
    error: params.get('error'),
  };
}

/** 完整 SSO 登录并兑换本地令牌 */
async function ssoLogin(patch) {
  const hs = await ssoHandshake(patch);
  assert(!hs.error, `SSO 登录被拒绝: ${hs.error ?? 'unknown'}`);
  assert(hs.otk, '回调未返回一次性登录码 otk');
  const res = await fetch(`${BASE}/auth/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ otk: hs.otk }),
  });
  assert(res.status === 200, `OTK 兑换期望 200，实际 ${res.status}`);
  const tokens = await res.json();
  assert(tokens.accessToken && tokens.refreshToken, 'OTK 兑换未返回令牌对');
  assert(tokens.mustChangePwd === false, 'D7：SSO 用户 mustChangePwd 必须为 false');
  const meRes = await fetch(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  assert(meRes.status === 200, `/auth/me 期望 200，实际 ${meRes.status}`);
  return { tokens, me: await meRes.json(), otk: hs.otk };
}

async function localLogin(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function meOf(accessToken) {
  const res = await fetch(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* ------------------------------------------------------------------ */
/* 双轨（OIDC 开 + 本地开）                                            */
/* ------------------------------------------------------------------ */
async function runDual() {
  await step('GET /auth/config：双轨开关均为开启', async () => {
    const res = await fetch(`${BASE}/auth/config`);
    assert(res.status === 200, `期望 200，实际 ${res.status}`);
    const cfg = await res.json();
    assert(cfg.oidcEnabled === true, 'oidcEnabled 应为 true');
    assert(cfg.localLoginEnabled === true, 'localLoginEnabled 应为 true');
    assert(cfg.registrationEnabled === false, 'D9：自助注册默认应关闭（本套件显式注入 false）');
    assert(cfg.oidcLoginPath === '/auth/oidc/login', 'oidcLoginPath 约定不符');
  });

  await step('GET /auth/oidc/login：302 到 IdP 且带 PKCE S256 / state / nonce', async () => {
    const started = await beginSso();
    assert(started.status === 302, `期望 302，实际 ${started.status}`);
    const url = new URL(started.location);
    assert(url.pathname === '/authorize', `授权端点路径异常: ${url.pathname}`);
    assert(url.searchParams.get('client_id') === 'ie-platform', 'D8：client_id 应为 ie-platform');
    assert(url.searchParams.get('response_type') === 'code', 'response_type 应为 code');
    assert((url.searchParams.get('scope') ?? '').includes('openid'), 'scope 应含 openid');
    assert(url.searchParams.get('code_challenge_method') === 'S256', 'PKCE 方法应为 S256');
    assert((url.searchParams.get('code_challenge') ?? '').length === 43, 'S256 challenge 长度应为 43');
    assert((url.searchParams.get('state') ?? '').length >= 20, 'state 缺失或过短');
    assert((url.searchParams.get('nonce') ?? '').length >= 20, 'nonce 缺失或过短');
    assert(
      url.searchParams.get('redirect_uri') === `${API_ORIGIN}/api/auth/oidc/callback`,
      `redirect_uri 推导不符: ${url.searchParams.get('redirect_uri')}`,
    );
  });

  await step('完整 SSO 登录（UserMap 命中 ie1）→ 本地令牌 + /auth/me', async () => {
    const { me, tokens } = await ssoLogin({
      mode: 'ok', loginName: 'ie1', employeeNo: 'E001',
      displayName: 'IE 工程师 王工', email: 'ie1@example.com',
    });
    assert(me.username === 'ie1', `用户名应为 ie1，实际 ${me.username}`);
    assert(me.authSource === 'oidc', `authSource 应为 oidc，实际 ${me.authSource}`);
    assert(me.ssoEmployeeNo === 'E001', `ssoEmployeeNo 应为 E001，实际 ${me.ssoEmployeeNo}`);
    assert(Array.isArray(me.permissions) && me.permissions.length > 0, 'SSO 会话未解析到本地权限');
    assert(tokens.expiresIn === 900 && tokens.tokenType === 'Bearer', '本地令牌应答字段不符');
  });

  await step('首次 SSO 登录绑定工号与来源，D4 不回写角色', async () => {
    const row = dbRow("SELECT auth_source, employee_no FROM t_user WHERE user_id = 'u_ie1'");
    assert(row && row.auth_source === 'oidc', 't_user.auth_source 未标记 oidc');
    assert(row.employee_no === 'E001', 't_user.employee_no 未绑定工号');
    const roles = db().prepare("SELECT role_id FROM t_user_role WHERE user_id = 'u_ie1'").all();
    assert(roles.length === 1 && roles[0].role_id === 'r_DEFAULT_ie_engineer',
      `D4：本地角色被改写（${roles.map((r) => r.role_id).join(',')}）`);
  });

  await step('OTK 单次消费：重复兑换 401', async () => {
    const hs = await ssoHandshake({
      mode: 'ok', loginName: 'ie1', employeeNo: 'E001', groups: ['app-ie'],
    });
    const first = await fetch(`${BASE}/auth/oidc/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ otk: hs.otk }),
    });
    assert(first.status === 200, `首次兑换期望 200，实际 ${first.status}`);
    const again = await fetch(`${BASE}/auth/oidc/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ otk: hs.otk }),
    });
    assert(again.status === 401, `重复兑换期望 401，实际 ${again.status}`);
  });

  await step('state 单次消费：重放回调返回 state_invalid', async () => {
    const hs = await ssoHandshake({
      mode: 'ok', loginName: 'ie1', employeeNo: 'E001', groups: ['app-ie'],
    });
    const replay = await fetch(hs.callbackUrl, { redirect: 'manual' });
    assert(replay.status === 302, `重放回调期望 302，实际 ${replay.status}`);
    const loc = replay.headers.get('location') ?? '';
    assert(hashParams(loc).get('error') === 'state_invalid', `期望 state_invalid，实际 ${loc}`);
  });

  await step('自动建档（中央有 / 本地无）：viewer 角色 + sso.provision 审计', async () => {
    const { me } = await ssoLogin({
      mode: 'ok', loginName: 'newie1', employeeNo: 'E003', displayName: '新同事', email: 'newie1@example.com',
    });
    assert(me.username === 'ie_new', `UserMap 应解析为 ie_new，实际 ${me.username}`);
    assert(me.ssoEmployeeNo === 'E003', '自动建档未绑定工号 E003');
    const row = dbRow("SELECT auth_source, status, must_change_pwd FROM t_user WHERE username = 'ie_new'");
    assert(row && row.auth_source === 'oidc' && row.status === 'active', '自动建档本地行状态不符');
    assert(Number(row.must_change_pwd) === 0, 'D7：自动建档不应要求改密');
    const roles = db().prepare(
      "SELECT role_id FROM t_user_role WHERE user_id = (SELECT user_id FROM t_user WHERE username = 'ie_new')",
    ).all();
    assert(roles.length === 1 && roles[0].role_id === 'r_DEFAULT_viewer',
      `D3：默认角色应为 viewer，实际 ${roles.map((r) => r.role_id).join(',')}`);
    const audited = await waitFor(() => dbCount(
      "SELECT COUNT(*) AS n FROM t_audit_log WHERE action = 'sso.provision'",
    ) >= 1);
    assert(audited, '缺少 sso.provision 审计');
  });

  await step('无 UserMap 映射时回落 preferred_username（viewer1）', async () => {
    const { me } = await ssoLogin({ mode: 'ok', loginName: 'viewer1', employeeNo: 'E002' });
    assert(me.username === 'viewer1', `应回落为 viewer1，实际 ${me.username}`);
    assert(me.authSource === 'oidc', 'viewer1 会话来源应为 oidc');
  });

  await step('D10：中央表查无此人 → 拒绝并写审计', async () => {
    const hs = await ssoHandshake({ mode: 'ok', loginName: 'ghost1', employeeNo: 'E777' });
    assert(hs.error === 'central_not_found', `期望 central_not_found，实际 ${hs.error}`);
    /* 审计 after_json 里的 code 字段被全局脱敏为 [REDACTED]，故按 entity_id（login_name）定位 */
    const audited = await waitFor(() => dbCount(
      "SELECT COUNT(*) AS n FROM t_audit_log WHERE action = 'sso.login_rejected' AND entity_id = 'ghost1'",
    ) >= 1);
    assert(audited, '拒绝未知用户未写审计');
  });

  await step('中央 status=0 → account_disabled', async () => {
    const hs = await ssoHandshake({ mode: 'ok', loginName: 'leave1', employeeNo: 'E004' });
    assert(hs.error === 'account_disabled', `期望 account_disabled，实际 ${hs.error}`);
  });

  await step('准入组缺失 → group_denied', async () => {
    const hs = await ssoHandshake({ mode: 'no_group', loginName: 'ie1', employeeNo: 'E001' });
    assert(hs.error === 'group_denied', `期望 group_denied，实际 ${hs.error}`);
  });

  for (const [label, mode] of [
    ['nonce 不匹配', 'bad_nonce'],
    ['aud 不匹配', 'bad_aud'],
    ['iss 不匹配', 'bad_iss'],
    ['签名无效', 'bad_signature'],
    ['已过期', 'expired'],
  ]) {
    await step(`id_token 校验失败（${label}）→ id_token_invalid`, async () => {
      const hs = await ssoHandshake({ mode, loginName: 'ie1', employeeNo: 'E001' });
      assert(hs.error === 'id_token_invalid', `期望 id_token_invalid，实际 ${hs.error}`);
    });
  }

  await step('IdP 返回 error → sso_denied', async () => {
    const hs = await ssoHandshake({ mode: 'idp_error', loginName: 'ie1', employeeNo: 'E001' });
    assert(hs.error === 'sso_denied', `期望 sso_denied，实际 ${hs.error}`);
  });

  await step('回调缺 code → code_missing', async () => {
    await control({ mode: 'ok', loginName: 'ie1', employeeNo: 'E001', groups: ['app-ie'] });
    const started = await beginSso();
    const authorized = await fetch(new URL(started.location), { redirect: 'manual' });
    const cbUrl = new URL(authorized.headers.get('location') ?? '');
    cbUrl.searchParams.delete('code');
    const cb = await fetch(cbUrl, { redirect: 'manual' });
    const loc = cb.headers.get('location') ?? '';
    assert(hashParams(loc).get('error') === 'code_missing', `期望 code_missing，实际 ${loc}`);
  });

  await step('令牌端点故障 → id_token_invalid（不泄露 IdP 细节）', async () => {
    const hs = await ssoHandshake({ mode: 'token_error', loginName: 'ie1', employeeNo: 'E001' });
    assert(hs.error === 'id_token_invalid', `期望 id_token_invalid，实际 ${hs.error}`);
  });

  await step('SSO 自动建档账号拒绝本地口令登录', async () => {
    const res = await localLogin('ie_new', 'Whatever123');
    assert(res.status === 401, `期望 401，实际 ${res.status}`);
    assert(String(res.body?.detail ?? '').includes('统一身份'), '未提示走统一身份入口');
  });

  await step('D5：双轨期本地账号登录不退化', async () => {
    const res = await localLogin('admin', '123456');
    assert(res.status === 200, `本地登录期望 200，实际 ${res.status}`);
    assert(res.body?.accessToken && res.body?.refreshToken, '本地登录未返回令牌');
    const me = await meOf(res.body.accessToken);
    assert(me.status === 200 && me.body.authSource === 'local', '本地会话 authSource 应为 local');
    assert(me.body.ssoEmployeeNo === null, '本地会话 ssoEmployeeNo 应为 null');
  });

  await step('SSO 会话刷新后来源仍为 oidc', async () => {
    const { tokens } = await ssoLogin({ mode: 'ok', loginName: 'ie1', employeeNo: 'E001' });
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert(res.status === 200, `刷新期望 200，实际 ${res.status}`);
    const next = await res.json();
    const me = await meOf(next.accessToken);
    assert(me.body.authSource === 'oidc', `刷新后 authSource 应为 oidc，实际 ${me.body.authSource}`);
    const row = dbRow('SELECT source FROM t_refresh_token WHERE token_hash = ?', sha256(next.refreshToken));
    assert(row && row.source === 'oidc', '刷新令牌行的 source 未保持 oidc');
  });

  await step('D6：登出只吊销本地 refresh（登出后可刷新失败）', async () => {
    const { tokens } = await ssoLogin({ mode: 'ok', loginName: 'ie1', employeeNo: 'E001' });
    const out = await fetch(`${BASE}/auth/logout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert(out.status === 200, `登出期望 200，实际 ${out.status}`);
    const again = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert(again.status === 401, `登出后刷新期望 401，实际 ${again.status}`);
  });

  await step('D9：自助注册默认关闭（403）', async () => {
    const res = await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sso_register_probe', password: 'Probe12345' }),
    });
    assert(res.status === 403, `期望 403，实际 ${res.status}`);
  });

  await step('D11：启动同步按中央 status=0 停用本地账号并吊销 refresh', async () => {
    const row = dbRow("SELECT status, auth_source FROM t_user WHERE user_id = 'u_sso_leave'");
    assert(row && row.status === 'disabled', `离职账号应已 disabled，实际 ${row && row.status}`);
    const rt = dbRow("SELECT revoked FROM t_refresh_token WHERE token_id = 'rt_sso_leave'");
    assert(rt && Number(rt.revoked) === 1, '离职账号的刷新令牌未吊销');
    const audited = await waitFor(() => dbCount(
      "SELECT COUNT(*) AS n FROM t_audit_log WHERE action = 'sso.status_sync'",
    ) >= 1);
    assert(audited, '离职回写缺少 sso.status_sync 审计');
    assert(dbCount("SELECT COUNT(*) AS n FROM t_user WHERE user_id = 'u_sso_leave'") === 1,
      '离职回写不应物理删除账号');
  });
}

/* ------------------------------------------------------------------ */
/* OIDC 关闭（降级为改造前行为）                                        */
/* ------------------------------------------------------------------ */
async function runOff() {
  await step('GET /auth/config：OIDC 关闭、本地登录开启', async () => {
    const res = await fetch(`${BASE}/auth/config`);
    assert(res.status === 200, `期望 200，实际 ${res.status}`);
    const cfg = await res.json();
    assert(cfg.oidcEnabled === false, 'oidcEnabled 应为 false');
    assert(cfg.localLoginEnabled === true, 'localLoginEnabled 应为 true');
  });

  for (const [label, path, method] of [
    ['发起登录', '/auth/oidc/login', 'GET'],
    ['回调', '/auth/oidc/callback?code=x&state=y', 'GET'],
    /* 带合法请求体：否则会被全局 ValidationPipe 提前拦成 400，测不到「关闭即 404」 */
    ['OTK 兑换', '/auth/oidc/token', 'POST'],
  ]) {
    await step(`OIDC 关闭时四端点 404（${label}）`, async () => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        redirect: 'manual',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify({ otk: 'not-a-real-otk' }) : undefined,
      });
      assert(res.status === 404, `期望 404，实际 ${res.status}`);
    });
  }

  await step('本地登录与 /auth/me 完全不变', async () => {
    const res = await localLogin('admin', '123456');
    assert(res.status === 200, `本地登录期望 200，实际 ${res.status}`);
    const me = await meOf(res.body.accessToken);
    assert(me.status === 200, `/auth/me 期望 200，实际 ${me.status}`);
    assert(me.body.authSource === 'local', 'OIDC 关闭时 authSource 仍应为 local');
    assert(me.body.ssoEmployeeNo === null, 'OIDC 关闭时 ssoEmployeeNo 应为 null');
  });

  await step('OIDC 关闭时零副作用：不绑定工号、不执行离职回写', async () => {
    const row = dbRow("SELECT auth_source, employee_no FROM t_user WHERE user_id = 'u_ie1'");
    assert(row && row.auth_source === 'local' && row.employee_no === null,
      `关闭时本地账号被 SSO 改动: ${JSON.stringify(row)}`);
    const leave = dbRow("SELECT status FROM t_user WHERE user_id = 'u_sso_leave'");
    assert(leave && leave.status === 'active', `关闭时不应执行离职回写，实际 ${leave && leave.status}`);
  });
}

/* ------------------------------------------------------------------ */
/* OIDC 开 + 本地登录关                                                */
/* ------------------------------------------------------------------ */
async function runNoLocal() {
  await step('GET /auth/config：本地登录关闭、OIDC 开启', async () => {
    const res = await fetch(`${BASE}/auth/config`);
    const cfg = await res.json();
    assert(cfg.oidcEnabled === true, 'oidcEnabled 应为 true');
    assert(cfg.localLoginEnabled === false, 'localLoginEnabled 应为 false');
  });

  await step('本地口令登录被 403 拒绝，但既有刷新不受影响', async () => {
    const res = await localLogin('admin', '123456');
    assert(res.status === 403, `期望 403，实际 ${res.status}`);
    assert(String(res.body?.detail ?? '').includes('统一身份'), '403 文案未指向统一身份入口');
  });

  await step('本地登录关闭时 SSO 仍可完成登录', async () => {
    const { me } = await ssoLogin({ mode: 'ok', loginName: 'ie1', employeeNo: 'E001' });
    assert(me.username === 'ie1' && me.authSource === 'oidc', 'SSO 会话未建立');
  });

  await step('SSO 会话刷新可用（本地入口关闭不影响 refresh）', async () => {
    const { tokens } = await ssoLogin({ mode: 'ok', loginName: 'ie1', employeeNo: 'E001' });
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    assert(res.status === 200, `刷新期望 200，实际 ${res.status}`);
  });
}

(async () => {
  console.log(`\nSSO 隔离套件：mode=${MODE} base=${BASE}`);
  try {
    if (MODE === 'off') await runOff();
    else if (MODE === 'nolocal') await runNoLocal();
    else await runDual();
  } catch (e) {
    failed += 1;
    console.log(`  FAIL 套件异常 — ${e.message}`);
  } finally {
    if (dbHandle) dbHandle.close();
  }
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
