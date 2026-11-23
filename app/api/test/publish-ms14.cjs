/**
 * 发布 motion_standard 规则集到规则库（当前文件版本：MS1.5）。
 * ------------------------------------------------------------
 * 走正式 POST /api/rules/motion_standard/publish 端点（rule:write），不直接改 DB。
 * 幂等：当前生效版本与文件 rv 相同，且 移动/检查/机器自动 三类已带描述格式时跳过发布。
 * 账号可用环境变量覆盖（默认种子账号）：
 *
 *   cd app/api && PUBLISH_USER=xxx PUBLISH_PASS=yyy node test/publish-ms14.cjs
 *
 * 历史：MS1.4（2026-11-09）引入 time_bucket；MS1.5（2026-11-23）补齐
 * 移动/检查/机器自动 的描述格式。文件名保留 ms14 以免改既有文档引用。
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
const USER = process.env.PUBLISH_USER || 'admin';
const PASS = process.env.PUBLISH_PASS || '123456';

const REQUIRED_FORMATS = {
  移动: '移动 +对象 +距离', 检查: '检查 +对象 +属性 +工具', 机器自动: '机器自动 +设备动作',
  操作: '操作 +对象 +数量', 清洁: '清洁 +对象 +范围', 翻转: '翻转 +对象 +正反',
  拆: '拆 +对象 +包装方式', 等待: '等待 +设备动作 +原因',
};

/** 三类关键格式是否已就位（幂等判据：不只看版本号，防同版本号内容不同） */
function hasRequiredFormats(content) {
  const byLevel1 = Object.fromEntries((content?.groups ?? []).map((g) => [g.level1, g]));
  return Object.entries(REQUIRED_FORMATS).every(([type, fmt]) => byLevel1[type]?.format === fmt);
}

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const authData = await login.json();
  assert.ok(login.ok, `登录失败 ${login.status}: ${JSON.stringify(authData)}（可用 PUBLISH_USER/PUBLISH_PASS 覆盖）`);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authData.accessToken}` };

  const content = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.match(String(content.rv), /^MS\d+\.\d+$/, '规则文件版本号格式应为 MSx.y');
  const targetVersion = content.rv;
  assert.ok(hasRequiredFormats(content), '规则文件缺少 移动/检查/机器自动 的新描述格式');

  const current = await (await fetch(`${BASE}/api/rules/motion_standard`, { headers })).json();
  const activeVersion = current.version ?? current.rv;
  const activeContent = current.content ?? current;
  console.log(`当前生效：${activeVersion} · 目标：${targetVersion}`);
  if (activeVersion === targetVersion && hasRequiredFormats(activeContent)) {
    console.log(`已发布 ${targetVersion} 且三类格式齐全，跳过（幂等）`);
    return;
  }

  const nodes = content.groups.reduce((n, g) => n + 1 + (g.subs?.length ?? 0), 0);
  const configured = content.groups.reduce((n, g) => n + (g.time_bucket ? 1 : 0)
    + (g.subs ?? []).filter((s) => s.time_bucket).length, 0);
  assert.equal(configured, nodes, `time_bucket 配置不完整 ${configured}/${nodes}`);
  console.log(`发布内容：${targetVersion} · ${nodes} 个类型节点，全部带 time_bucket`);

  const res = await fetch(`${BASE}/api/rules/motion_standard/publish`, {
    method: 'POST', headers,
    body: JSON.stringify({ content, operator: 'ms-publish' }),
  });
  const out = await res.json().catch(() => ({}));
  assert.ok(res.ok, `发布失败 ${res.status}: ${JSON.stringify(out)}`);
  console.log(`发布成功：${JSON.stringify(out)}`);

  const after = await (await fetch(`${BASE}/api/rules/motion_standard`, { headers })).json();
  const c = after.content ?? after;
  assert.equal(after.version ?? after.rv, out.version, '回读版本与发布响应不一致');
  assert.ok(hasRequiredFormats(c), '回读内容缺少 移动/检查/机器自动 的新描述格式');
  console.log(`回读确认：${after.version ?? after.rv} · ${(c.groups ?? []).length} 个分组`);
})().catch((e) => { console.error('motion_standard 发布失败：', e.message); process.exitCode = 1; });