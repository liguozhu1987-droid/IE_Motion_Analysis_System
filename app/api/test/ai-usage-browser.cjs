/** AI 用量页真实 Chrome 验收；只连接 3103 隔离启动器与其临时 SQLite。 */
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const puppeteer = require(path.resolve(__dirname, '../../node_modules/puppeteer-core'));

const BASE = process.env.BASE || '';
const WEB = process.env.WEB_URL || '';
const DB_PATH = process.env.AI_USAGE_DB_PATH || '';
const OUT_DIR = path.resolve(__dirname, '../../../deliverables');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
function guard() {
  const u = new URL(BASE); const w = new URL(WEB);
  if (process.env.AI_USAGE_ISOLATED !== '1' || u.hostname !== '127.0.0.1' || u.port !== '3103'
    || w.hostname !== '127.0.0.1' || w.port !== '3103') throw new Error('只允许 AI 用量隔离 3103 服务');
  if (!path.basename(DB_PATH).startsWith('gate-ai-usage') || !fs.existsSync(DB_PATH)) throw new Error('必须提供隔离 AI 用量数据库');
}
function update(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (e) => {
      if (e) return reject(e);
      db.run(sql, params, function (runErr) { db.close((closeErr) => runErr || closeErr ? reject(runErr || closeErr) : resolve(this.changes)); });
    });
  });
}
async function choose(page, ariaLabel, text) {
  await page.click(`button[aria-label="${ariaLabel}"]`);
  await page.waitForSelector('.sm-menu [role="option"]');
  await page.evaluate((label) => {
    const option = [...document.querySelectorAll('.sm-menu [role="option"]')].find((el) => el.textContent.includes(label));
    if (!option) throw new Error(`下拉选项不存在: ${label}`);
    option.click();
  }, text);
}
async function submit(page) {
  const response = page.waitForResponse((r) => r.url().includes('/api/ai/usage/summary') && r.request().method() === 'GET', { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll('form.filter-bar button')].find((b) => b.textContent === '查询').click());
  const res = await response;
  if (!res.ok()) throw new Error(`用量查询 HTTP ${res.status()}`);
  await page.waitForFunction(() => ![...document.querySelectorAll('form.filter-bar button')].some((b) => b.textContent === '查询' && b.disabled));
}
async function setDate(page, index, value) {
  await page.evaluate(({ index, value }) => {
    const input = document.querySelectorAll('.usage-date input')[index];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { index, value });
}
async function metricValues(page) {
  return page.$$eval('.usage-metrics .metric .v', (els) => els.map((e) => e.textContent.trim()));
}

(async () => {
  guard();
  await update('UPDATE t_user SET must_change_pwd=0 WHERE username IN (?,?)', ['admin', 'ie1']);
  const loginRes = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginRes.json();
  if (!login.refreshToken) throw new Error('隔离登录失败');
  const ieLoginRes = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ie1', password: '123456' }),
  });
  const ieLogin = await ieLoginRes.json();
  if (!ieLogin.refreshToken) throw new Error('隔离 IE 用户登录失败');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const checks = []; const pageErrors = []; const failedResponses = [];
  const check = (name, pass, evidence) => { checks.push({ name, pass: Boolean(pass), evidence }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) failedResponses.push({ url: r.url(), status: r.status() }); });
    await page.evaluateOnNewDocument((refreshToken) => localStorage.setItem('ie_refresh_token', refreshToken), login.refreshToken);
    await page.goto(`${WEB}/?ai-usage-gate=${Date.now()}#/ai-usage`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.usage-metrics', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.usage-metrics .metric').length === 5);

    const initial = await page.evaluate(() => ({
      title: document.querySelector('h1')?.textContent,
      metrics: [...document.querySelectorAll('.usage-metrics .metric .v')].map((e) => e.textContent.trim()),
      rows: document.querySelectorAll('.card tbody tr').length,
      warning: document.querySelector('.warning-banner')?.textContent ?? '',
      quality: [...document.querySelectorAll('.card tbody .tag')].map((e) => e.textContent.trim()),
      nativeSelects: document.querySelectorAll('select').length,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      nextDisabled: [...document.querySelectorAll('.usage-table-foot button')].find((b) => b.textContent === '下一页')?.disabled,
      topLevelUsage: document.querySelectorAll('.nav > a[href="#/ai-usage"]').length,
      systemActive: document.querySelector('.nav-drop-btn')?.classList.contains('active'),
    }));
    check('导航路由直达 AI 用量统计页', initial.title === 'AI 用量统计', initial.title);
    check('AI 用量不再占用首层菜单且系统管理父项激活', initial.topLevelUsage === 0 && initial.systemActive === true,
      { topLevelUsage: initial.topLevelUsage, systemActive: initial.systemActive });
    check('5 个 KPI 与隔离事实精确一致', JSON.stringify(initial.metrics) === JSON.stringify(['1,411', '245', '116', '8', '10']), initial.metrics);
    check('默认按用户＋产线＋工位＋功能显示 4 个分组', initial.rows === 4, initial.rows);
    check('缺失 usage 明示警告，不按 0 静默处理', initial.warning.includes('1 次调用') && initial.warning.includes('不按 0'), initial.warning);
    check('历史/缺失/完整数据口径标签可见', initial.quality.includes('历史总 Token') && initial.quality.includes('部分明细') && initial.quality.includes('逐次明细'), initial.quality);
    check('筛选使用 FilterSelect，无原生 select', initial.nativeSelects === 0, initial.nativeSelects);
    check('1440px 无页面横向溢出', !initial.overflow, initial.overflow);
    check('单页结果禁用下一页', initial.nextDisabled === true, initial.nextDisabled);
    await page.screenshot({ path: path.join(OUT_DIR, 'AI-usage-page-1440.png'), fullPage: true });

    await page.click('.nav-drop-btn');
    await page.waitForSelector('.nav-drop-menu');
    const adminMenu = await page.evaluate(() => ({
      usage: document.querySelectorAll('.nav-drop-menu a[href="#/ai-usage"]').length,
      config: document.querySelectorAll('.nav-drop-menu a[href="#/ai-config"]').length,
    }));
    check('管理员系统管理菜单同时包含 AI 配置与 AI 用量统计', adminMenu.usage === 1 && adminMenu.config === 1, adminMenu);
    await page.screenshot({ path: path.join(OUT_DIR, 'AI-usage-system-menu.png'), fullPage: true });
    await page.click('.nav-drop-btn');

    await choose(page, '按工位筛选', 'L01-ST02');
    await submit(page);
    const stationMetrics = await metricValues(page);
    const stationText = await page.$eval('.card tbody', (e) => e.innerText);
    check('工位筛选只显示该工位 15 Token，不叠加历史 80', stationMetrics[0] === '15' && stationText.includes('L01-ST02') && !stationText.includes('L01-ST01'), { stationMetrics, stationText });

    await page.evaluate(() => [...document.querySelectorAll('form.filter-bar button')].find((b) => b.textContent === '重置').click());
    await page.waitForFunction(() => document.querySelector('.usage-metrics .metric .v')?.textContent === '1,411');
    await choose(page, '按功能筛选', '浪费＋问题清单');
    await submit(page);
    const wasteMetrics = await metricValues(page);
    check('功能筛选验证浪费/问题共享生成只计 300 历史 Token', wasteMetrics[0] === '300', wasteMetrics);

    await setDate(page, 0, '2099-01-01');
    await submit(page);
    const empty = await page.evaluate(() => ({ metrics: [...document.querySelectorAll('.usage-metrics .metric .v')].map((e) => e.textContent.trim()), empty: document.querySelector('.empty-cell')?.textContent ?? '' }));
    check('空范围 KPI 为 0/未知且表格显示明确空态', empty.metrics[0] === '0' && empty.empty.includes('没有正式 AI 调用'), empty);
    await page.screenshot({ path: path.join(OUT_DIR, 'AI-usage-page-empty.png'), fullPage: true });

    await page.evaluate(() => [...document.querySelectorAll('form.filter-bar button')].find((b) => b.textContent === '重置').click());
    await page.waitForFunction(() => document.querySelector('.usage-metrics .metric .v')?.textContent === '1,411');
    await page.setViewport({ width: 1280, height: 720 });
    const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth, filters: document.querySelectorAll('form.filter-bar .filter-item').length }));
    check('1280px 筛选换行且页面无横向溢出', !narrow.overflow && narrow.filters === 7, narrow);
    await page.screenshot({ path: path.join(OUT_DIR, 'AI-usage-page-1280.png'), fullPage: true });

    const iePage = await browser.newPage();
    await iePage.setViewport({ width: 1440, height: 900 });
    iePage.on('pageerror', (e) => pageErrors.push(e.message));
    await iePage.evaluateOnNewDocument((refreshToken) => localStorage.setItem('ie_refresh_token', refreshToken), ieLogin.refreshToken);
    await iePage.goto(`${WEB}/?ai-usage-ie-gate=${Date.now()}#/ai-usage`, { waitUntil: 'networkidle0', timeout: 60000 });
    await iePage.waitForSelector('.usage-metrics', { timeout: 30000 });
    await iePage.click('.nav-drop-btn');
    await iePage.waitForSelector('.nav-drop-menu');
    const ieMenu = await iePage.evaluate(() => ({
      usage: document.querySelectorAll('.nav-drop-menu a[href="#/ai-usage"]').length,
      config: document.querySelectorAll('.nav-drop-menu a[href="#/ai-config"]').length,
      topLevelUsage: document.querySelectorAll('.nav > a[href="#/ai-usage"]').length,
      total: document.querySelector('.usage-metrics .metric .v')?.textContent.trim(),
    }));
    check('普通 IE 工程师保留 AI 用量入口但不显示 AI 配置', ieMenu.usage === 1 && ieMenu.config === 0
      && ieMenu.topLevelUsage === 0 && ieMenu.total === '15', ieMenu);
    await iePage.close();
    check('无 JavaScript pageerror', pageErrors.length === 0, pageErrors);
    check('无 API 5xx 响应', failedResponses.length === 0, failedResponses);

    const report = {
      generated_at: new Date().toISOString(), base: BASE, browser: 'real Chrome via puppeteer-core',
      passed: checks.every((c) => c.pass), checks, pageErrors, failedResponses,
      screenshots: ['AI-usage-page-1440.png', 'AI-usage-system-menu.png', 'AI-usage-page-empty.png', 'AI-usage-page-1280.png'],
    };
    fs.writeFileSync(path.join(OUT_DIR, 'AI-usage-browser-report.json'), JSON.stringify(report, null, 2));
    console.log(`AI 用量浏览器验收: ${checks.filter((c) => c.pass).length}/${checks.length} 通过`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (e) {
    console.error(e);
    fs.writeFileSync(path.join(OUT_DIR, 'AI-usage-browser-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), passed: false, error: String(e?.stack ?? e), checks, pageErrors, failedResponses }, null, 2));
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
