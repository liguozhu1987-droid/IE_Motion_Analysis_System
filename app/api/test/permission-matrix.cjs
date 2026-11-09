/**
 * W3 权限矩阵门禁：25 个已绑定权限点 × 5 个隔离种子账号 = 125 格。
 * 仅在 SECURITY_ISOLATED=1 且 BASE 指向 127.0.0.1:3101 时运行，防止误打正式服务。
 * 期望来自 /auth/me 的实际生效权限，而非复制 seed 中的角色表。
 * 有权限分支只使用只读 GET、无效资源或非法 DTO；允许 400/404/409/422，不允许 5xx。
 */
const fs = require('node:fs');
const path = require('node:path');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const BASE = process.env.BASE || 'http://127.0.0.1:3101/api';
const OUT = process.env.ISOLATED_ARTIFACT_DIR
  ? path.join(process.env.ISOLATED_ARTIFACT_DIR, 'PST-permission-matrix.json')
  : path.resolve(__dirname, '../../../deliverables/PST-permission-matrix.json');
const MISSING = '__gate_nonexistent__';
const ACCOUNTS = ['admin', 'ie1', 'leader1', 'viewer1', 'other1'];

// 每个权限点选一个稳定代表路由；写路由均在 RBAC 后被 400/404 截停。
const ROUTES = [
  ['station:read', 'GET', '/stations'],
  ['station:write', 'POST', '/stations', {}],
  ['station:retest', 'POST', `/stations/${MISSING}/retest`, {}],
  ['element:read', 'GET', `/stations/${MISSING}/elements`],
  ['element:write', 'POST', `/stations/${MISSING}/elements/validate`, {}],
  ['element:va-override', 'PATCH', `/stations/${MISSING}/elements/${MISSING}/va-class`, {}],
  ['analysis:read', 'GET', `/stations/${MISSING}/analysis`],
  ['suggestion:generate', 'GET', '/improvements'],
  ['suggestion:adopt', 'POST', `/stations/${MISSING}/suggestions/adopt`, {}],
  ['suggestion:status', 'PATCH', `/improvements/${MISSING}/status`, {}],
  ['compare:read', 'GET', `/stations/${MISSING}/compare`],
  ['compare:export', 'GET', `/stations/${MISSING}/compare/report`],
  ['settings:benefit-read', 'GET', '/config/benefit-params'],
  ['settings:benefit-write', 'PATCH', '/tenant', { name: 123 }],
  ['rule:read', 'GET', '/rules'],
  ['rule:write', 'POST', `/rules/${MISSING}/publish`, { content: null }],
  ['user:read', 'GET', '/admin/users'],
  ['user:write', 'POST', '/admin/users', {}],
  ['role:read', 'GET', '/admin/roles'],
  ['role:write', 'POST', '/admin/roles', {}],
  ['audit:read', 'GET', '/admin/audit?limit=1'],
  ['auth:self', 'GET', '/auth/me'],
  ['ai:use', 'GET', '/ai/tasks'],
  ['ai:governance', 'GET', '/ai-custom-dict'],
  ['group:read', 'GET', '/dashboard/summary'],
];

function isolatedGuard() {
  const u = new URL(BASE);
  // 隔离来源二选一：security-isolated.cjs 固定 3101；isolated-harness.cjs 分配随机空闲端口。
  const isolated = process.env.SECURITY_ISOLATED === '1' || process.env.ISOLATED_HARNESS === '1';
  if (!isolated || u.hostname !== '127.0.0.1') {
    throw new Error('权限矩阵只允许隔离环境（SECURITY_ISOLATED=1 或 ISOLATED_HARNESS=1）+ 127.0.0.1');
  }
}

async function request(route, token) {
  const [code, method, routePath, body] = route;
  const res = await fetch(BASE + routePath, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  return { code, method, path: routePath, status: res.status, body: text.slice(0, 240) };
}

function controllerPermissions() {
  const src = path.resolve(__dirname, '../src');
  const used = new Set();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.controller.ts')) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/@RequirePermission\('([^']+)'\)/g)) used.add(m[1]);
      }
    }
  };
  walk(src);
  return [...used].sort();
}

(async () => {
  isolatedGuard();
  const routed = controllerPermissions();
  const represented = ROUTES.map(([code]) => code).sort();
  const routeMapExact = JSON.stringify(routed) === JSON.stringify([...represented].sort());
  if (!routeMapExact) throw new Error(`路由表与控制器权限点不一致: ${JSON.stringify({ routed, represented })}`);

  const users = [];
  for (const username of ACCOUNTS) {
    const loginRes = await fetch(BASE + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: '123456' }), signal: AbortSignal.timeout(15000),
    });
    const login = await loginRes.json();
    if (!loginRes.ok || !login.accessToken) throw new Error(`${username} 登录失败: HTTP ${loginRes.status}`);
    const meRes = await fetch(BASE + '/auth/me', { headers: { authorization: `Bearer ${login.accessToken}` } });
    const me = await meRes.json();
    if (!meRes.ok) throw new Error(`${username} /auth/me 失败: HTTP ${meRes.status}`);
    users.push({ username, token: login.accessToken, roles: me.roles, permissions: me.permissions });
  }

  const cells = [];
  for (const user of users) {
    for (const route of ROUTES) {
      const expected = user.permissions.includes(route[0]);
      const result = await request(route, user.token);
      // 拒绝态必须准确为 403；有 RBAC 权限后，资源 ACL/参数校验可继续拒绝，但不能 401/403 或 5xx。
      const pass = expected
        ? ![401, 403].includes(result.status) && result.status < 500
        : result.status === 403;
      cells.push({ username: user.username, permission: route[0], expected: expected ? 'allow-rbac' : 'deny', ...result, pass });
    }
  }

  const failed = cells.filter((c) => !c.pass);
  const seed = fs.readFileSync(path.resolve(__dirname, '../scripts/seed.ts'), 'utf8');
  const dictionary = [...new Set([...seed.matchAll(/\['([a-z]+:[a-z-]+)',\s*'[^']+',\s*'[^']+'\]/g)].map((m) => m[1]))].sort();
  const unbound = dictionary.filter((code) => !routed.includes(code));
  const undocumented = routed.filter((code) => !dictionary.includes(code));
  const knownDriftOnly = JSON.stringify(unbound) === JSON.stringify(['analysis:run']) && undocumented.length === 0;
  const report = {
    generated_at: new Date().toISOString(), base: BASE, isolation: 'temporary SQLite; five seed accounts',
    dictionary_count: dictionary.length, routed_permission_count: routed.length,
    account_count: users.length, cell_count: cells.length, passed: cells.length - failed.length, failed: failed.length,
    route_map_exact: routeMapExact, unbound_permissions: unbound, undocumented_permissions: undocumented,
    known_drift_only: knownDriftOnly,
    note: '原文档 24×5=120 已漂移；当前字典 26 项，analysis:run 无控制器路由，实际矩阵 25×5=125。ie_admin 无独立种子账号，不伪造五角色等同一说。',
    users: users.map(({ token, ...u }) => u), failures: failed, cells,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`权限矩阵: ${report.passed}/${cells.length} 通过；未绑定权限点: ${unbound.join(', ') || '无'}`);
  for (const f of failed) console.error(`FAIL ${f.username} ${f.permission} ${f.method} ${f.path} -> ${f.status} ${f.body}`);
  console.log(`报告: ${OUT}`);
  process.exit(failed.length || !knownDriftOnly ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
