/**
 * v3.32 LLM 连接测试验证（真连后端 + 本地 mock LLM 网关，无需真实 Key）
 *
 * mock 网关（127.0.0.1:8899）行为：
 *   GET  /v1/models            Key=good-key → 200 {data:[{id:'test-model'}]}；否则 401
 *   POST /v1/chat/completions  Key 无效 → 401；model≠test-model → 400；否则 200 {choices, usage:{total_tokens:3}}（并记录 max_tokens）
 *   GET  /html/v1/models       200 text/html（模拟 Base URL 指到网页）
 *
 * 断言：
 *  C1 正常：ok=true + 零 token 探活通过 + 最小 token 通过 + 实测 token 记录
 *  C2 最小代价：mock 收到的 chat 请求 max_tokens=1、temperature=0、单字 prompt
 *  C3 错误 Key → ok=false + 诊断含 401/Key
 *  C4 错误路径（404）→ 诊断含 404/路径 且建议提到 /v1
 *  C5 连接被拒绝（关闭端口）→ 诊断含 连接被拒绝/端口
 *  C6 HTML 假 200 → ok=false（非 chat JSON）
 *  C7 测试不落库（GET llm-config 前后一致）
 *  C8 UI：测试连接按钮 → 成功横幅（连接正常）+ 截图
 *  C9 viewer1 调 test → 403
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = { models: 0, chat: 0, lastChatBody: null };
let server;

function startMock() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || '');
      const good = auth === 'Bearer good-key';
      const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

      if (req.url === '/html/v1/models') return send(200, '<!doctype html><html>login page</html>', 'text/html');
      if (req.url === '/html/v1/chat/completions') return send(200, '<!doctype html><html>login page</html>', 'text/html');

      if (req.url === '/v1/models') {
        seen.models += 1;
        return good ? send(200, { data: [{ id: 'test-model' }] }) : send(401, { error: { message: 'invalid api key' } });
      }
      if (req.url === '/v1/chat/completions') {
        seen.chat += 1;
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
          seen.lastChatBody = body;
          if (!good) return send(401, { error: { message: 'invalid api key' } });
          if (body.model !== 'test-model') return send(400, { error: { message: 'model not found' } });
          return send(200, { id: 'cmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { total_tokens: 3 } });
        });
        return;
      }
      return send(404, { error: 'not found' });
    });
    server.listen(8899, '127.0.0.1', resolve);
  });
}

async function apiTest(token, payload) {
  const r = await fetch(API + '/ai-suggestions/llm-config/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() };
}

(async () => {
  await startMock();
  console.log('  mock LLM 网关已启动 127.0.0.1:8899');

  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();
  const token = login.accessToken;
  ok('admin 登录', Boolean(token));

  const before = await (await fetch(API + '/ai-suggestions/llm-config', { headers: { Authorization: 'Bearer ' + token } })).json();

  /* C1 正常链路 */
  const c1 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/v1', api_key: 'good-key', model: 'test-model' });
  ok('C1 正常连通 ok=true', c1.status === 200 && c1.body.ok === true, JSON.stringify(c1.body?.diagnosis));
  ok('C1 零 token 探活通过', c1.body?.checks?.models?.ok === true, c1.body?.checks?.models?.reason);
  ok('C1 模型在清单中', c1.body?.model_listed === true, c1.body?.model_listed);
  ok('C1 最小 token 调用记录 token 用量', c1.body?.tokens_used === 3, c1.body?.tokens_used);

  /* C2 最小代价实证 */
  const cb = seen.lastChatBody || {};
  ok('C2 max_tokens=1', cb.max_tokens === 1, cb.max_tokens);
  ok('C2 temperature=0', cb.temperature === 0, cb.temperature);
  ok('C2 prompt 为单字 hi', cb.messages?.[0]?.content === 'hi', JSON.stringify(cb.messages).slice(0, 60));

  /* C3 错误 Key */
  const c3 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/v1', api_key: 'bad-key', model: 'test-model' });
  ok('C3 错误 Key → ok=false + 401 诊断', c3.body?.ok === false && /401|Key/.test(String(c3.body?.diagnosis)), c3.body?.diagnosis);
  ok('C3 给出修复建议', Boolean(c3.body?.suggestion), c3.body?.suggestion);

  /* C4 路径错误 404 */
  const c4 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/nope', api_key: 'good-key', model: 'test-model' });
  ok('C4 404 → 诊断含路径且建议提 /v1', c4.body?.ok === false && /404|路径/.test(String(c4.body?.diagnosis)) && /\/v1/.test(String(c4.body?.suggestion)), c4.body?.diagnosis);

  /* C5 连接被拒绝 */
  const c5 = await apiTest(token, { base_url: 'http://127.0.0.1:8898/v1', api_key: 'good-key', model: 'test-model' });
  ok('C5 端口无服务 → 连接被拒绝诊断', c5.body?.ok === false && /连接被拒绝|端口/.test(String(c5.body?.diagnosis)), c5.body?.diagnosis);

  /* C6 HTML 假 200 */
  const c6 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/html/v1', api_key: 'good-key', model: 'test-model' });
  ok('C6 HTML 200 → 判失败（非 chat JSON）', c6.body?.ok === false && /不是 chat|JSON/.test(String(c6.body?.diagnosis)), c6.body?.diagnosis);

  /* C7 探测不落库 */
  const after = await (await fetch(API + '/ai-suggestions/llm-config', { headers: { Authorization: 'Bearer ' + token } })).json();
  ok('C7 测试不写配置（前后一致）', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after).slice(0, 160));

  /* C8 UI 按钮 + 成功横幅 */
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.evaluateOnNewDocument((rt) => localStorage.setItem('ie_refresh_token', rt), login.refreshToken);
  await page.goto(WEB + '/#/ai-config', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1200);

  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const texts = card.querySelectorAll('input:not([type=checkbox]):not([type=password])');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(texts[0], 'http://127.0.0.1:8899/v1');
    texts[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(texts[1], 'test-model');
    texts[1].dispatchEvent(new Event('input', { bubbles: true }));
    const k = card.querySelector('input[type=password]');
    setter.call(k, 'good-key');
    k.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(200);
  const clicked = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const btn = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('测试连接'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(2500);
  const banner = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const b = card && card.querySelector('.banner-success, .banner-error');
    return b ? { cls: b.className, text: (b.textContent || '').slice(0, 200) } : null;
  });
  ok('C8 UI 测试按钮 → 成功横幅（连接正常）', clicked && banner && /banner-success/.test(banner.cls) && banner.text.includes('连接正常'), banner && banner.text);
  ok('C8b 横幅含最小 token 实证', banner && /token/.test(banner.text), banner && banner.text);
  await page.screenshot({ path: path.join(SHOT_DIR, 'llm-test-v332.png'), fullPage: true });
  console.log('  截图: deliverables/part2/ui/llm-test-v332.png');
  ok('C8c 无 JS pageerror', jsErrors.length === 0, jsErrors[0]);
  await browser.close();

  /* C9 权限 */
  const v = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer1', password: '123456' }),
  })).json();
  const vr = await fetch(API + '/ai-suggestions/llm-config/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.accessToken },
    body: JSON.stringify({ base_url: 'http://127.0.0.1:8899/v1', model: 'test-model' }),
  });
  ok('C9 viewer1 调 test → 403', vr.status === 403, vr.status);

  server.close();
  console.log(`\n==== LLM 连接测试验证：${pass} passed, ${fail} failed ====`);
  process.exit(fail > 0 ? 1 : 0);
})();
