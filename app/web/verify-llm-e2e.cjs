/**
 * v3.35 AI 功能端到端自测验证（真连后端 + 可产出合法建议的 mock LLM 网关）
 *
 * mock 网关（127.0.0.1:8899）升级：
 *   POST /v1/chat/completions  Key=good-key 且 model=test-model 时：
 *     prompt 含「E2E-TEST」→ 返回符合 PV1 规格的合法建议 JSON（持住 E 类 + 寻找 S 类 0.5）
 *     否则单字回复 hi
 *   加 /badjson 路径：返回非 JSON 文本（parse 失败场景）
 *
 * 断言：
 *  E1 全链通过：ok=true + accepted≥1 + 数字字段服务端重算（est_save_s=2.0 E 全额）
 *  E2 剥数字实证：mock 故意在建议里塞 est_save_s:999 → 响应中必须是 2.0（重算值）而非 999
 *  E3 parse 失败：/badjson → stage=parse + 建议提示换模型
 *  E4 llm_call 失败：401 端点 → stage=llm_call + 建议先跑连接测试
 *  E5 校验剔除：mock 返回 waste_type 不在白名单 → stage=validation + accepted=0
 *  E6 不落库：t_ai_suggestion_batch / t_ai_suggestion 行数前后一致（直查 DB）
 *  E7 UI：「AI 功能自测」按钮 → 成功横幅含「AI 功能自测通过」+ 截图
 *  E8 viewer1 调 e2e-test → 403
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
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEGAL = JSON.stringify([
  { element_seqs: [1], waste_type: '持住', method: 'E', measure: '用气动治具替代 L 手扶住壳体，释放双手完成双侧同步装配（消除持住的产生条件）', eliminate_basis: '治具代手后持住动作的产生条件不复存在，SOP-014 §3.2 允许取消人工扶持', est_save_s: 999, priority: 99, tier: 'P0' },
  { element_seqs: [2], waste_type: '寻找', method: 'S', factor: 0.5, measure: '料盒按螺丝规格分格并加透明盖标识，缩短寻找时间至一半（压缩寻找范围）' },
]);
const ILLEGAL = JSON.stringify([
  { element_seqs: [3], waste_type: '玄学浪费', method: 'S', factor: 0.5, measure: '这条浪费类型不在白名单里应当被 R1.2 剔除掉' },
]);

const seen = { chat: 0, lastChatBody: null };
let server;
function startMock() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || '');
      const good = auth === 'Bearer good-key';
      const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

      if (req.url === '/v1/models') return good ? send(200, { data: [{ id: 'test-model' }] }) : send(401, { error: { message: 'invalid api key' } });
      if (req.url === '/badjson/v1/chat/completions') return send(200, '这是纯文本，不是 JSON');
      if (req.url === '/v1/chat/completions') {
        seen.chat += 1;
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
          seen.lastChatBody = body;
          if (!good) return send(401, { error: { message: 'invalid api key' } });
          if (!['test-model', 'BADJSON-MODE'].includes(body.model)) return send(400, { error: { message: 'model not found' } });
          const prompt = JSON.stringify(body.messages || []);
          const content = prompt.includes('E2E-TEST')
            ? (body.model === 'BADJSON-MODE' ? ILLEGAL : LEGAL)  // 模型名在 body.model 不在 prompt 里
            : 'hi';
          return send(200, { id: 'cmpl-2', choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: prompt.includes('E2E-TEST') ? 420 : 3 } });
        });
        return;
      }
      return send(404, { error: 'not found' });
    });
    server.listen(8899, '127.0.0.1', resolve);
  });
}

async function apiTest(token, payload, extra = '') {
  const r = await fetch(API + '/ai-suggestions/llm-config/e2e-test' + extra, {
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

  /* DB 行数基线（E6 不落库实证）——mssql 直连（包在 app/api/node_modules） */
  const countRows = async () => {
    const mssql = require('D:/Application/IE_Improvement_Platform/app/api/node_modules/mssql');
    const envText = fs.readFileSync('D:/Application/IE_Improvement_Platform/app/api/.env', 'utf8');
    const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    const pool = await new mssql.ConnectionPool({
      server: env.DB_HOST, database: env.DB_NAME,
      user: env.DB_USER, password: env.DB_PASS,
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    try {
      const b = (await pool.request().query('SELECT COUNT(*) n FROM t_ai_suggestion_batch')).recordset[0].n;
      const s = (await pool.request().query('SELECT COUNT(*) n FROM t_ai_suggestion')).recordset[0].n;
      return { b, s };
    } finally { await pool.close(); }
  };
  const before = await countRows();

  /* E1 全链通过 */
  const e1 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/v1', api_key: 'good-key', model: 'test-model' });
  ok('E1 全链通过 ok=true stage=done', e1.status === 200 && e1.body.ok === true && e1.body.stage === 'done', JSON.stringify({ stage: e1.body?.stage, err: e1.body?.error }));
  ok('E1 accepted=2（持住E+寻找S）', e1.body?.accepted_count === 2, e1.body?.accepted_count);
  ok('E1 数字重算：E 类 est_save_s=2.0 全额', e1.body?.suggestions?.some((s) => s.method === 'E' && Number(s.est_save_s) === 2), JSON.stringify(e1.body?.suggestions?.map((s) => ({ m: s.method, s: s.est_save_s }))));

  /* E2 剥数字实证：LLM 塞的 999/99/P0 必须被剥除重算 */
  const eSugg = e1.body?.suggestions?.find((s) => s.method === 'E');
  ok('E2 LLM 假数字 999 被剥除（est_save_s≠999）', eSugg && Number(eSugg.est_save_s) !== 999, eSugg?.est_save_s);
  ok('E2 tier 由服务端重算（非 LLM 的 P0）', eSugg && eSugg.tier !== 'P0' && ['P1', 'P2', 'P3'].includes(eSugg.tier), eSugg?.tier);

  /* E3 parse 失败（200 + 响应体非 JSON → res.json() 抛 SyntaxError → 归类 parse） */
  const e3 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/badjson/v1', api_key: 'good-key', model: 'test-model' });
  ok('E3 非 JSON 输出 → stage=parse + 端点诊断建议', e3.body?.stage === 'parse' && /OpenAI|端点|测试连接/.test(String(e3.body?.suggestion)), e3.body?.stage + ' ' + e3.body?.suggestion);

  /* E4 llm_call 失败（401） */
  const e4 = await apiTest(token, { base_url: 'http://127.0.0.1:8899/v1', api_key: 'wrong-key', model: 'test-model' });
  ok('E4 401 → stage=llm_call + 建议先跑连接测试', e4.body?.stage === 'llm_call' && /测试连接/.test(String(e4.body?.suggestion)), e4.body?.stage + ' ' + e4.body?.suggestion);

  /* E5 校验剔除（非法 waste_type）：model=BADJSON-MODE → mock 返回单条「玄学浪费」（不在白名单） */
  const e5b = await apiTest(token, { base_url: 'http://127.0.0.1:8899/v1', api_key: 'good-key', model: 'BADJSON-MODE' });
  ok('E5 非法 waste_type → stage=validation + accepted=0', e5b.body?.stage === 'validation' && e5b.body?.accepted_count === 0, e5b.body?.stage + ' acc=' + e5b.body?.accepted_count);

  /* E6 不落库 */
  const after = await countRows();
  ok('E6 不落库（批次/建议行数前后一致）', before.b === after.b && before.s === after.s, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  /* E7 UI 按钮 */
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
  const clicked = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const btn = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').includes('AI 功能自测'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(3500);
  const banner = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('h3') || {}).textContent?.includes('LLM 网关配置'));
    const b = card && card.querySelector('.banner-success, .banner-error');
    return b ? { cls: b.className, text: (b.textContent || '').slice(0, 260) } : null;
  });
  ok('E7 UI 自测按钮 → 成功横幅', clicked && banner && /banner-success/.test(banner.cls) && banner.text.includes('AI 功能自测通过'), banner && banner.text);
  ok('E7b 横幅含候选数统计', banner && /三轮校验通过/.test(banner.text), banner && banner.text);
  await page.screenshot({ path: path.join(SHOT_DIR, 'llm-e2e-v335.png'), fullPage: true });
  console.log('  截图: deliverables/part2/ui/llm-e2e-v335.png');
  ok('E7c 无 JS pageerror', jsErrors.length === 0, jsErrors[0]);
  await browser.close();

  /* E8 权限 */
  const v = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer1', password: '123456' }),
  })).json();
  const vr = await fetch(API + '/ai-suggestions/llm-config/e2e-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.accessToken },
    body: JSON.stringify({ base_url: 'http://127.0.0.1:8899/v1', model: 'test-model' }),
  });
  ok('E8 viewer1 调 e2e-test → 403', vr.status === 403, vr.status);

  server.close();
  console.log(`\n==== AI 功能自测验证：${pass} passed, ${fail} failed ====`);
  process.exit(fail > 0 ? 1 : 0);
})();
