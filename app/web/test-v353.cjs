/**
 * v3.53 · AI 洞察 + 场景切分 UI 测试（Analysis / Compare / AiSegment 三页新入口）。
 *
 * 断言：
 *  T1 分析页渲染「AI 诊断」按钮；点击 → 待审卡片（AI 关 → 系统模板降级文案）
 *  T2 对比页渲染「AI 解读差异」按钮；点击 → 解读卡片 + 倒退预警（规则引擎，v2 CT 恶化）
 *  T3 AI 分解页：服务器视频载入前无「检测场景切分」；上传后按钮出现；点击 → 候选列表 ≥2 段
 *  T4 无 JS pageerror
 *
 * 前置：API(3001，AI_ENABLED 未开) + Vite dev(5173)。数据：L01-ST11（有已提交要素，CT>0）。
 *  对比页需 2 个版本：脚本自建 v2 要素（std_time ×1.2 → CT 恶化），结束删除。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const sql = require('../api/node_modules/mssql');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const SID = 'L01-ST11';
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
const VIDEO_DIR = path.join(__dirname, '..', 'api', 'storage', 'videos');
const VIDEO_FILE = 'C:/Users/Administrator/AppData/Local/Temp/workbuddy-update-x64-workbuddy/v353-scene-test.mp4';
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}
const DB = { server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS, options: { encrypt: false, trustServerCertificate: true } };
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');
  const TOKEN = login.accessToken;

  /* 前置自愈：L01-ST11（有已提交要素、CT>0）缺失会让本用例整片误报，幂等补齐 */
  await require('./_setup-st11.cjs').ensure(true);

  /* 前置：注入 v2 版本要素（CT 恶化 20% → 规则引擎应出「CT 增加」倒退预警） */
  const pool = await sql.connect(DB);
  await pool.request().query(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version=2`);
  const mk = await pool.request().input('sid', SID).query(`
    INSERT INTO t_element (element_id, tenant_id, station_id, seq, start_ms, dur_s, hand, type, [desc], va_class,
      outlier_flag, outlier_reason, video_id, source, rating, allowance, std_time, bol_version)
    SELECT LEFT(element_id,40)+'_v2', tenant_id, station_id, seq+100, start_ms, ROUND(dur_s*1.2,2), hand, type, [desc], va_class,
      outlier_flag, outlier_reason, video_id, source, rating, allowance, ROUND(std_time*1.2,2), 2
    FROM t_element WHERE station_id=@sid AND bol_version=1`);
  ok('前置：v2 版本要素注入（CT 恶化）', mk.rowsAffected[0] > 0, `rows=${mk.rowsAffected[0]}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));
  page.on('dialog', (d) => { void d.accept(); });
  /* v3.48 教训：token 注入必须条件化（refresh 一次性轮换） */
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  /* ── T1. 分析页：AI 诊断 ── */
  console.log('\n--- T1. 分析页 · AI 诊断 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/analysis/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2500);
  const hasDiagBtn = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'AI 诊断'));
  ok('T1.1 渲染「AI 诊断」按钮', hasDiagBtn);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'AI 诊断');
    if (b) b.click();
  });
  await sleep(2500);
  const diagCard = await page.evaluate(() => {
    const h3 = [...document.querySelectorAll('h3')].find((n) => /AI 诊断/.test(n.textContent || ''));
    if (!h3) return null;
    const card = h3.closest('div');
    return { title: (h3.textContent || '').trim(), text: (card?.textContent || '').slice(0, 300) };
  });
  ok('T1.2 点击后出现诊断卡片', Boolean(diagCard), JSON.stringify(diagCard)?.slice(0, 120));
  ok('T1.3 卡片标注「待审」', Boolean(diagCard?.title.includes('待审')), diagCard?.title);
  ok('T1.4 AI 关 → 系统模板降级文案', Boolean(diagCard?.text.includes('系统模板诊断')), diagCard?.text?.slice(0, 80));
  await page.screenshot({ path: path.join(SHOT_DIR, 'v353-ai-diagnose.png') });

  /* ── T2. 对比页：AI 解读差异 ── */
  console.log('\n--- T2. 对比页 · AI 解读差异 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/compare/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2500);
  const hasInterpBtn = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'AI 解读差异'));
  ok('T2.1 渲染「AI 解读差异」按钮', hasInterpBtn);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'AI 解读差异');
    if (b) b.click();
  });
  await sleep(2500);
  const interpCard = await page.evaluate(() => {
    const body = document.body.textContent || '';
    const hasWarn = body.includes('倒退预警');
    const note = [...document.querySelectorAll('.note')].map((n) => (n.textContent || '').trim()).find((t) => t.includes('倒退预警'));
    return { hasWarn, warn: note ?? null, hasTemplate: body.includes('系统模板解读') };
  });
  ok('T2.2 点击后出现解读卡片（模板降级）', interpCard.hasTemplate, JSON.stringify(interpCard).slice(0, 120));
  ok('T2.3 渲染倒退预警（规则引擎：v2 CT 恶化）', interpCard.hasWarn, interpCard.warn);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v353-ai-interpret.png') });

  /* ── T3. AI 分解页：场景切分 ── */
  console.log('\n--- T3. AI 分解页 · 检测场景切分 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/ai-segment/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2500);
  const btnBefore = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '检测场景切分'));
  ok('T3.1 未载入服务器视频时不显示「检测场景切分」', !btnBefore);

  const input = await page.$('input[aria-label="选择服务器上传视频"]');
  ok('T3.2 存在服务器上传入口', Boolean(input));
  if (input) {
    await input.uploadFile(VIDEO_FILE);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '检测场景切分'),
      { timeout: 60000, polling: 300 });
    await sleep(500);
    const btnAfter = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '检测场景切分'));
    ok('T3.3 服务器视频载入后按钮出现', btnAfter);

    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '检测场景切分');
      if (b) b.click();
    });
    await page.waitForSelector('.aip-scenes', { timeout: 60000 });
    await sleep(500);
    const scenes = await page.$$eval('.aip-scene', (ns) => ns.map((n) => (n.textContent || '').trim()));
    ok('T3.4 检出场景候选（3 段视频 ≥2 段）', scenes.length >= 2, scenes.join(' | '));
    ok('T3.5 候选为起止时间（s）', scenes.every((s) => /\d+\.\d–\d+\.\ds/.test(s)), scenes.join(' | '));
    await page.screenshot({ path: path.join(SHOT_DIR, 'v353-scene-detect.png') });
  }

  ok('T4 无 JS pageerror', errors.length === 0, errors.join(' ; ').slice(0, 200));

  await browser.close();
  await pool.request().query(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version=2`);
  await pool.close();
  /* 清理测试上传的视频文件 */
  try {
    for (const f of fs.readdirSync(VIDEO_DIR)) {
      if (f.endsWith('.mp4') && fs.statSync(path.join(VIDEO_DIR, f)).size < 100_000) fs.unlinkSync(path.join(VIDEO_DIR, f));
    }
  } catch { /* ignore */ }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('异常：', e);
  try {
    const p = await sql.connect(DB);
    await p.request().query(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version=2`);
    await p.close();
  } catch { /* ignore */ }
  process.exit(1);
});
