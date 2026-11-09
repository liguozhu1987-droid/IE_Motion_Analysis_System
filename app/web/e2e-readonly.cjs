/* 只读端到端验证：admin 登录 → 驾驶舱 → 工作台 → 分析/对比/建议/设置。不做任何写操作。 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe');
const WEB = 'http://127.0.0.1:5173';
const OUT = 'E:/Application/IE_Improvement_Platform/.screenshots';
const SID = 'L01-ST11';

const steps = [];
let cur = null;

function begin(name) {
  cur = { step: name, apiNon2xx: [], consoleErrors: [], pageErrors: [], notes: [] };
  steps.push(cur);
}
function end(extra) {
  if (extra) Object.assign(cur, extra);
  cur = null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  /* 抑制工作台首次进入的「工作流程与快捷键」浮层，避免遮挡截图（与既有脚本一致） */
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('wb-help-seen', '1'); } catch { /* ignore */ } });

  page.on('console', (m) => {
    if (m.type() === 'error' && cur) cur.consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => { if (cur) cur.pageErrors.push(String(e && e.message ? e.message : e).slice(0, 300)); });
  page.on('requestfailed', (r) => {
    if (cur && /^http:\/\/127\.0\.0\.1:5173\/api/.test(r.url())) cur.consoleErrors.push(`REQFAILED ${r.url()} ${r.failure() && r.failure().errorText}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (cur && /^http:\/\/127\.0\.0\.1:(5173|3001)\/api/.test(u) && r.status() >= 400) {
      cur.apiNon2xx.push(`${r.status()} ${r.request().method()} ${u.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
    }
  });

  const goto = async (hash) => {
    await page.goto(`${WEB}/?b=${Date.now()}${hash}`, { waitUntil: 'networkidle0', timeout: 60000 }).catch(async () => {
      await page.waitForSelector('body', { timeout: 10000 });
    });
    await sleep(1200);
  };
  const shot = async (name) => page.screenshot({ path: path.join(OUT, `ro-${name}.png`), fullPage: false });
  const visibleText = async () => (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ').slice(0, 500);
  const layout = async () => page.evaluate(() => {
    const de = document.documentElement;
    const overflowX = Math.max(0, de.scrollWidth - de.clientWidth);
    const boxes = {};
    for (const sel of ['.shell', '.container', '.wb-main', '.wb-inspector', '.wb-stage', '.wb-tlstrip', '.page-head', '.filter-bar']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      boxes[sel] = { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
    }
    const badBoxes = Object.entries(boxes).filter(([, b]) => b.right > window.innerWidth + 1 || b.left < -1).map(([k, b]) => `${k}:${b.left}..${b.right}`);
    return { overflowX, badBoxes, boxes };
  });
  const errorBanner = async () => page.evaluate(() => [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)));

  try {
    /* ---------- 1) 登录页 + 真实表单登录 ---------- */
    begin('login');
    await goto('#/login');
    await page.waitForSelector('.login-card', { timeout: 20000 });
    await shot('01-login');
    const loginPage = await page.evaluate(() => ({
      heading: document.querySelector('.login-card') ? document.querySelector('.login-card').innerText.replace(/\s+/g, ' ').slice(0, 160) : null,
      inputs: document.querySelectorAll('.login-card input').length,
      oidcHidden: !document.body.innerText.includes('统一身份登录'),
    }));
    const inputs = await page.$$('.login-card input');
    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type('admin');
    await inputs[1].click({ clickCount: 3 });
    await inputs[1].type('123456');
    await Promise.all([
      page.waitForFunction(() => window.location.hash === '#/dashboard' || window.location.hash === '#/stations', { timeout: 30000 }),
      page.click('.login-submit'),
    ]);
    await sleep(1500);
    const loginResult = await page.evaluate(() => ({
      hash: window.location.hash,
      hasRefreshToken: !!localStorage.getItem('ie_refresh_token'),
      navText: document.querySelector('.nav') ? document.querySelector('.nav').innerText.replace(/\s+/g, ' ').slice(0, 120) : null,
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
    }));
    end({ loginPage, loginResult, screenshot: 'ro-01-login.png' });

    /* ---------- 2) 驾驶舱 ---------- */
    begin('dashboard');
    await goto('#/dashboard');
    await page.waitForSelector('.filter-bar', { timeout: 30000 });
    await sleep(1800);
    const dash = await page.evaluate(() => ({
      kpis: [...document.querySelectorAll('.metrics .metric')].map((m) => m.innerText.replace(/\s+/g, ' ')),
      distLists: [...document.querySelectorAll('.dist-list')].length,
      distRows: [...document.querySelectorAll('.dist-row')].map((d) => d.innerText.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 8),
      tables: [...document.querySelectorAll('table.dash-table')].map((t) => ({ rows: t.querySelectorAll('tbody tr').length, head: t.querySelector('thead') ? t.querySelector('thead').innerText.replace(/\s+/g, ' ') : '' })),
      lineCardTitle: [...document.querySelectorAll('h3')].map((h) => h.innerText).find((t) => t.includes('产线汇总')) || null,
      filterItems: document.querySelectorAll('.filter-bar .filter-item').length,
      empty: !!document.querySelector('.card.empty'),
    }));
    await shot('02-dashboard');
    const dashLayout = await layout();

    /* 筛选交互（只读）：点「按大区」第一条，再重置 */
    let filterTest = null;
    const regionRow = await page.$('.dist-list .dist-row');
    if (regionRow) {
      await regionRow.click();
      await sleep(1200);
      filterTest = await page.evaluate(() => ({
        loading: !!document.querySelector('.filter-loading'),
        resetVisible: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('重置筛选')),
        kpiText: document.querySelector('.metrics') ? document.querySelector('.metrics').innerText.replace(/\s+/g, ' ').slice(0, 120) : null,
        empty: !!document.querySelector('.card.empty'),
      }));
      const reset = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('重置筛选')));
      if (reset.asElement()) { await reset.asElement().click(); await sleep(1000); }
    }
    end({ dash, filterTest, layout: dashLayout, errorBanner: await errorBanner(), screenshot: 'ro-02-dashboard.png' });

    /* ---------- 3) 工作台 ---------- */
    begin('workbench');
    await goto(`#/workbench/${SID}`);
    await page.waitForSelector('.wb-main', { timeout: 30000 });
    await sleep(2000);
    const wb = await page.evaluate(() => ({
      topbarStats: document.querySelector('.wb-stats') ? document.querySelector('.wb-stats').innerText.replace(/\s+/g, ' ').slice(0, 160) : null,
      stage: !!document.querySelector('.wb-stage'),
      video: !!document.querySelector('.wb-stage video'),
      dropPlaceholder: document.querySelector('.wb-drop') ? document.querySelector('.wb-drop').innerText.replace(/\s+/g, ' ').slice(0, 120) : null,
      inspector: document.querySelector('.wb-inspector') ? document.querySelector('.wb-inspector').innerText.replace(/\s+/g, ' ').slice(0, 120) : null,
      timelineStrip: !!document.querySelector('.wb-tlstrip'),
      tabs: [...document.querySelectorAll('.wb-tabs button')].map((b) => b.innerText.replace(/\s+/g, ' ')),
      timelineBlocks: document.querySelectorAll('.wb-tl .block').length,
      legend: document.querySelector('.wb-legend') ? document.querySelector('.wb-legend').innerText.replace(/\s+/g, ' ').slice(0, 120) : null,
      deliverBar: document.querySelector('.wb-deliver') ? document.querySelector('.wb-deliver').innerText.replace(/\s+/g, ' ').slice(0, 140) : null,
      errorBanner: [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)),
    }));
    await shot('03-workbench');
    const wbLayout = await layout();

    /* 切到「清单」页签（只读视图切换） */
    let listTab = null;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.wb-tabs button')].find((x) => x.textContent.includes('清单'));
      if (b) b.click();
    });
    await sleep(1200);
    listTab = await page.evaluate(() => ({
      active: [...document.querySelectorAll('.wb-tabs button.on')].map((b) => b.innerText.replace(/\s+/g, ' ')),
      rows: [...document.querySelectorAll('.wb-tlstrip-body table tbody tr')].length,
      firstRow: document.querySelector('.wb-tlstrip-body table tbody tr') ? document.querySelector('.wb-tlstrip-body table tbody tr').innerText.replace(/\s+/g, ' ').slice(0, 160) : null,
    }));
    await shot('04-workbench-list');
    end({ wb, listTab, layout: wbLayout, screenshot: 'ro-03-workbench.png / ro-04-workbench-list.png' });

    /* ---------- 4) 分析页 ---------- */
    begin('analysis');
    await goto(`#/analysis/${SID}`);
    await page.waitForSelector('.page-head', { timeout: 30000 });
    await sleep(1800);
    const analysis = await page.evaluate(() => ({
      title: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').innerText : null,
      cards: [...document.querySelectorAll('.card h3')].map((h) => h.innerText.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 14),
      empties: [...document.querySelectorAll('.card.empty')].map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 120)),
      errorBanner: [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)),
      tableRows: [...document.querySelectorAll('.card table')].map((t) => t.querySelectorAll('tbody tr').length).slice(0, 8),
    }));
    await shot('05-analysis');
    end({ analysis, layout: await layout(), screenshot: 'ro-05-analysis.png' });

    /* ---------- 5) 对比页 ---------- */
    begin('compare');
    await goto(`#/compare/${SID}`);
    await page.waitForSelector('.page-head', { timeout: 30000 });
    await sleep(1500);
    const compare = await page.evaluate(() => ({
      title: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').innerText : null,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
      empty: !!document.querySelector('.card.empty'),
      errorBanner: [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)),
    }));
    await shot('06-compare');
    end({ compare, screenshot: 'ro-06-compare.png' });

    /* ---------- 6) 建议页 ---------- */
    begin('suggestions');
    await goto(`#/ai-suggestions/${SID}`);
    await page.waitForSelector('.page-head', { timeout: 30000 });
    await sleep(1800);
    const suggest = await page.evaluate(() => ({
      title: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').innerText : null,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
      emptyCards: [...document.querySelectorAll('.card.empty')].map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 120)),
      errorBanner: [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)),
    }));
    await shot('07-ai-suggestions');
    end({ suggest, layout: await layout(), screenshot: 'ro-07-ai-suggestions.png' });

    /* ---------- 7) 设置中心 ---------- */
    begin('settings');
    await goto('#/settings');
    await page.waitForSelector('.page-head', { timeout: 30000 });
    await sleep(1800);
    const settings = await page.evaluate(() => ({
      title: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').innerText : null,
      tabs: [...document.querySelectorAll('.set-tab')].map((b) => b.innerText.replace(/\s+/g, ' ')),
      cards: [...document.querySelectorAll('.card h3')].map((h) => h.innerText.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 14),
      tables: [...document.querySelectorAll('table')].map((t) => t.querySelectorAll('tbody tr').length),
      errorBanner: [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)),
    }));
    await shot('08-settings');
    /* 只读切换「规则库」页签：确认生效规则集能加载 */
    let rulesTab = null;
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.set-tab')].find((x) => x.textContent.includes('规则库'));
      if (b) b.click();
    });
    await sleep(1500);
    rulesTab = await page.evaluate(() => ({
      heading: [...document.querySelectorAll('.card h3')].map((h) => h.innerText.replace(/\s+/g, ' ').slice(0, 80)),
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
      cards: document.querySelectorAll('.card').length,
      errorBanner: [...document.querySelectorAll('.error-banner')].map((e) => e.textContent.trim().slice(0, 200)),
    }));
    await shot('09-settings-rules');
    end({ settings, rulesTab, layout: await layout(), screenshot: 'ro-08-settings.png / ro-09-settings-rules.png' });

    fs.writeFileSync(path.join(OUT, 'ro-e2e-report.json'), JSON.stringify(steps, null, 2));
    console.log(JSON.stringify(steps, null, 2));
    await browser.close();
  } catch (e) {
    if (cur) { cur.fatal = String(e && e.stack ? e.stack : e).slice(0, 500); }
    fs.writeFileSync(path.join(OUT, 'ro-e2e-report.json'), JSON.stringify(steps, null, 2));
    console.error('FATAL', e);
    try { await shot('99-fatal'); } catch { /* ignore */ }
    await browser.close();
    process.exit(1);
  }
})();
