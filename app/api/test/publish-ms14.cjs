/**
 * Phase 2 · 发布 motion_standard MS1.4（time_bucket 配置化）到生产规则库。
 * ------------------------------------------------------------
 * 走正式 POST /api/rules/motion_standard/publish 端点（rule:write），不直接改 DB。
 * 幂等：当前生效版本已是 MS1.4 或内容已含 time_bucket 时跳过发布。
 *
 *   cd app/api && node test/publish-ms14.cjs
 */
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
process.env.NO_PROXY = '127.0.0.1,localhost';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BATCH_EXPORT_BASE || 'http://127.0.0.1:3001';
const FILE = path.resolve(__dirname, '..', '..', 'config', 'rules', 'motion_standard.json');

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const authData = await login.json();
  assert.ok(login.ok, `admin 登录失败 ${login.status}: ${JSON.stringify(authData)}`);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authData.accessToken}` };

  const current = await (await fetch(`${BASE}/api/rules/motion_standard`, { headers })).json();
  const activeVersion = current.version ?? current.rv;
  const activeContent = current.content ?? current;
  const hasBucket = (activeContent?.groups ?? []).some((g) => g.time_bucket !== undefined);
  console.log(`当前生效：${activeVersion} · 已含 time_bucket=${hasBucket}`);
  if (activeVersion === 'MS1.4' && hasBucket) {
    console.log('已发布 MS1.4，跳过（幂等）');
    return;
  }

  const content = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(content.rv, 'MS1.4', '规则文件版本不是 MS1.4');
  const nodes = content.groups.reduce((n, g) => n + 1 + (g.subs?.length ?? 0), 0);
  const configured = content.groups.reduce((n, g) => n + (g.time_bucket ? 1 : 0)
    + (g.subs ?? []).filter((s) => s.time_bucket).length, 0);
  assert.equal(configured, nodes, `time_bucket 配置不完整 ${configured}/${nodes}`);
  console.log(`发布内容：${nodes} 个类型节点，全部带 time_bucket`);

  const res = await fetch(`${BASE}/api/rules/motion_standard/publish`, {
    method: 'POST', headers,
    body: JSON.stringify({ content, operator: 'phase2-migration' }),
  });
  const out = await res.json().catch(() => ({}));
  assert.ok(res.ok, `发布失败 ${res.status}: ${JSON.stringify(out)}`);
  console.log(`发布成功：${JSON.stringify(out)}`);

  const after = await (await fetch(`${BASE}/api/rules/motion_standard`, { headers })).json();
  const c = after.content ?? after;
  assert.equal(after.version ?? after.rv, out.version, '回读版本与发布响应不一致');
  assert.ok((c.groups ?? []).some((g) => g.time_bucket), '回读内容缺 time_bucket');
  console.log(`回读确认：${after.version ?? after.rv} · ${(c.groups ?? []).length} 个分组`);
})().catch((e) => { console.error('MS1.4 发布失败：', e.message); process.exitCode = 1; });
