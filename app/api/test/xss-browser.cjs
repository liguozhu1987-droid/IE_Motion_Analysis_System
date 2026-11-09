/**
 * W4 存储型 XSS 隔离浏览器回归 + 描述联想页面级验收。
 * 只修改 SECURITY_DB_PATH 指向的临时 SQLite；工位列表与分解清单必须原样显示 payload，不得执行。
 */
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const puppeteer = require(path.resolve(__dirname, '../../node_modules/puppeteer-core'));

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const BASE = process.env.BASE || 'http://127.0.0.1:3101/api';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3101';
const DB_PATH = process.env.SECURITY_DB_PATH || '';
const OUT_DIR = path.resolve(__dirname, '../../../deliverables');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STATION_PAYLOAD = '<img src=x onerror=window.__xss=1>工位';
const ELEMENT_PAYLOAD = '<svg onload=window.__xss=2>要素';
const STANDARD_HINT = '拿取 对象 于 位置 距离';
const HISTORY_HINT = '装前壳到位';

function guard() {
  const u = new URL(BASE);
  const w = new URL(WEB);
  if (process.env.SECURITY_ISOLATED !== '1' || u.hostname !== '127.0.0.1' || u.port !== '3101' || w.hostname !== '127.0.0.1' || w.port !== '3101') {
    throw new Error('XSS 回归只允许隔离 3101 服务');
  }
  if (!DB_PATH || !path.basename(DB_PATH).startsWith('gate-') || !fs.existsSync(DB_PATH)) {
    throw new Error('SECURITY_DB_PATH 必须指向隔离启动器创建的 gate-*.db');
  }
}

function update(pathname, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(pathname, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      db.run(sql, params, function (runErr) {
        const changes = this?.changes;
        db.close((closeErr) => runErr || closeErr ? reject(runErr || closeErr) : resolve(changes));
      });
    });
  });
}

(async () => {
  guard();
  const changed = [];
  changed.push(await update(DB_PATH, 'UPDATE t_station SET name=? WHERE station_id=?', [STATION_PAYLOAD, 'L01-ST01']));
  changed.push(await update(DB_PATH, 'UPDATE t_element SET desc=? WHERE element_id=?', [ELEMENT_PAYLOAD, 'L01-ST01-V1-001']));
  changed.push(await update(DB_PATH, 'UPDATE t_user SET must_change_pwd=0 WHERE username=?', ['admin']));
  if (changed.some((n) => n !== 1)) throw new Error(`隔离数据准备失败: ${JSON.stringify(changed)}`);

  const loginRes = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginRes.json();
  if (!login.refreshToken) throw new Error(`隔离登录失败: HTTP ${loginRes.status}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const checks = [];
  const pageErrors = [];
  const dialogs = [];
  const ok = (name, pass, evidence) => checks.push({ name, pass: Boolean(pass), evidence });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await page.evaluateOnNewDocument((refreshToken) => {
      window.__xss = 0;
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', refreshToken);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);

    await page.goto(`${WEB}/?gate=${Date.now()}#/stations`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction((payload) => document.body.innerText.includes(payload), { timeout: 30000 }, STATION_PAYLOAD);
    const stationDom = await page.evaluate(() => ({ injectedImg: document.querySelectorAll('img[src="x"]').length, xss: window.__xss }));
    ok('工位列表原样显示存储 payload', true, STATION_PAYLOAD);
    ok('工位 payload 未形成 img 元素', stationDom.injectedImg === 0, stationDom);
    await page.screenshot({ path: path.join(OUT_DIR, 'PST-xss-stations.png'), fullPage: true });

    await page.goto(`${WEB}/?gate=${Date.now()}#/workbench/L01-ST01`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.wb-tabs', { timeout: 30000 });
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.wb-tabs button')].find((b) => b.textContent.includes('清单'));
      if (!tab) throw new Error('未找到清单页签');
      tab.click();
    });
    await page.waitForFunction((payload) => document.body.innerText.includes(payload), { timeout: 30000 }, ELEMENT_PAYLOAD);
    await page.click('.wb-list tbody tr');
    await page.waitForSelector('.wb-desc[list="wb-desc-hints"]', { timeout: 5000 });
    const workbench = await page.evaluate(() => ({
      injectedSvg: document.querySelectorAll('svg[onload]').length,
      xss: window.__xss,
      options: [...document.querySelectorAll('#wb-desc-hints option')].map((o) => o.value),
      descInputLinked: document.querySelector('.wb-desc')?.getAttribute('list') === 'wb-desc-hints',
    }));
    ok('分解清单原样显示存储 payload', true, ELEMENT_PAYLOAD);
    ok('要素 payload 未形成 onload SVG', workbench.injectedSvg === 0, workbench.injectedSvg);
    ok('公司标准骨架进入 datalist', workbench.options.includes(STANDARD_HINT), { optionCount: workbench.options.length });
    ok('同线历史真实短语仍保留', workbench.options.includes(HISTORY_HINT), { optionCount: workbench.options.length });
    ok('历史短语排在标准骨架之前', workbench.options.indexOf(HISTORY_HINT) < workbench.options.indexOf(STANDARD_HINT));
    ok('描述输入框已连接 datalist', workbench.descInputLinked);
    ok('window 执行标记始终为 0', workbench.xss === 0 && stationDom.xss === 0, { station: stationDom.xss, workbench: workbench.xss });
    ok('无 alert/confirm 弹窗', dialogs.length === 0, dialogs);
    ok('无 JavaScript pageerror', pageErrors.length === 0, pageErrors);
    await page.screenshot({ path: path.join(OUT_DIR, 'PST-xss-workbench.png'), fullPage: true });

    const report = {
      generated_at: new Date().toISOString(), base: BASE, isolation_db: path.basename(DB_PATH),
      payloads: { station: STATION_PAYLOAD, element: ELEMENT_PAYLOAD },
      datalist: { standard: STANDARD_HINT, history: HISTORY_HINT, options: workbench.options },
      passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length,
      checks, pageErrors, dialogs,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'PST-xss-report.json'), JSON.stringify(report, null, 2));
    for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
    console.log(`XSS + datalist 浏览器验收: ${report.passed}/${checks.length} 通过`);
    process.exitCode = report.failed ? 1 : 0;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
