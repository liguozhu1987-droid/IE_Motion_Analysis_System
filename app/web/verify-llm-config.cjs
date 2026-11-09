/**
 * v3.31 LLM 网关配置 UI 一次性验证（真连后端，无 mock）：
 *  L1 #/ai-config 渲染「LLM 网关配置」卡片（user:write 可编辑）
 *  L2 服务开关 checkbox 与 DB 配置一致（enabled=true）
 *  L3 API Key 保存后脱敏显示（保存带 key → masked 回显）
 *  L4 服务状态表「已启用」tag（DB 开关生效）
 *  L5 viewer1 调 GET llm-config → 403（权限拦截）
 *  L6 无 JS pageerror
 * 收尾：清掉验证写入的 API Key（回落 .env na）
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const path = require('path');
const fs = require('fs');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const loginRes = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginRes.json();
  ok('admin 登录', Boolean(login.accessToken));

  /* 前置（自洽）：契约测试 Phase 0 会清 t_ai_setting、本脚本 L3 保存会固化表单态——
     显式恢复服务开启（ai_enabled=1 DB 行），L2/L4 不再依赖外部 DB 状态 */
  const prep = await fetch(API + '/ai-suggestions/llm-config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.accessToken },
    body: JSON.stringify({ enabled: true }),
  });
  ok('前置：恢复服务开启（enabled=true）', prep.ok, prep.status);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.evaluateOnNewDocument((rt) => localStorage.setItem('ie_refresh_token', rt), login.refreshToken);

  await page.goto(WEB + '/#/ai-config', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  /* L1 卡片渲染 */
  const card = await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll('.card h3')).find((x) => (x.textContent || '').includes('LLM 网关配置'));
    return Boolean(h);
  });
  ok('L1 「LLM 网关配置」卡片渲染', card);

  /* L2 开关 checkbox 状态 = DB enabled */
  const chk = await page.evaluate(() => {
    const card2 = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const box = card2 && card2.querySelector('input[type=checkbox]');
    return box ? box.checked : null;
  });
  ok('L2 服务开关 checkbox = true（DB 配置生效）', chk === true, chk);

  /* L3 保存 API Key → 脱敏回显 */
  await page.type('.card input[type=password]', 'sk-verify-key-abcdef123456');
  const saveClicked = await page.evaluate(() => {
    const card2 = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const btn = Array.from(card2.querySelectorAll('button')).find((b) => (b.textContent || '').includes('保存 LLM 配置'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1200);
  const masked = await page.evaluate(() => {
    const card2 = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    return card2 ? (card2.textContent || '').match(/sk-\*{4}\w{4}/) : null;
  });
  ok('L3 保存后 API Key 脱敏回显', saveClicked && Boolean(masked), masked && masked[0]);

  /* L4 服务状态 已启用（v3.37：状态 table → dl.cfg-list 描述列表） */
  const enabledTag = await page.evaluate(() => {
    const dl = Array.from(document.querySelectorAll('.card dl, .card table')).find((t) => (t.textContent || '').includes('服务开关'));
    return dl ? (dl.textContent || '').includes('已启用') : false;
  });
  ok('L4 服务状态表显示「已启用」', enabledTag);

  await page.screenshot({ path: path.join(SHOT_DIR, 'llm-config-v331.png'), fullPage: true });
  console.log('  截图: deliverables/part2/ui/llm-config-v331.png');

  /* L5 viewer1 权限拦截（API 级） */
  const vLogin = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer1', password: '123456' }),
  });
  const v = await vLogin.json();
  const vRes = await fetch(API + '/ai-suggestions/llm-config', { headers: { Authorization: 'Bearer ' + v.accessToken } });
  ok('L5 viewer1 GET llm-config → 403', vRes.status === 403, vRes.status);

  ok('L6 无 JS pageerror', jsErrors.length === 0, jsErrors[0]);

  await browser.close();

  /* 收尾：清验证 Key（v3.40 语义：清空启用 profile 的 key——断言「测试 Key 不再回显」，
     来源可能回落 legacy 行/env，不再要求 ==='env'） */
  const del = await fetch(API + '/ai-suggestions/llm-config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.accessToken },
    body: JSON.stringify({ api_key: '' }),
  });
  const delBody = await del.json();
  ok('收尾：验证 Key 已清除（测试 Key 不再回显）', del.ok && delBody.api_key_masked !== 'sk-****3456', delBody.api_key_masked || '(空)');

  console.log(`\n==== LLM 配置 UI 验证：${pass} passed, ${fail} failed ====`);
  process.exit(fail > 0 ? 1 : 0);
})();
