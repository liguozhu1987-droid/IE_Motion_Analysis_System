/** v3.25 截图：① 集团看板（China 大区/大区列头/公司名） ② 工作台 JKL 帮助浮层 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'deliverables', 'v325');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();

  // 找有要素的工位
  let sid = null;
  for (const line of await (await fetch(API + '/lines', { headers: { Authorization: 'Bearer ' + login.accessToken } })).json()) {
    for (const st of await (await fetch(API + '/stations?lineId=' + line.line_id, { headers: { Authorization: 'Bearer ' + login.accessToken } })).json()) {
      const els = await (await fetch(API + '/stations/' + st.station_id + '/elements', { headers: { Authorization: 'Bearer ' + login.accessToken } })).json();
      if (Array.isArray(els.elements) && els.elements.length > 0) { sid = st.station_id; break; }
    }
    if (sid) break;
  }

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  // ① 集团看板
  await page.goto(WEB + '/#/dashboard', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2000);
  await page.screenshot({ path: path.join(OUT, 'v325-01-dashboard-china-region.png'), fullPage: false });
  console.log('saved v325-01-dashboard-china-region.png');

  // ② 工作台 + 帮助浮层（JKL 说明）
  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'v325-02-workbench.png') });
  console.log('saved v325-02-workbench.png');

  // ③ 帮助浮层（含 v3.25 JKL 文案）
  await page.evaluate(() => { localStorage.removeItem('wb-help-seen'); });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(1000);
  const helpVisible = await page.evaluate(() => !!document.querySelector('.wb-help'));
  if (helpVisible) {
    await page.screenshot({ path: path.join(OUT, 'v325-03-help-jkl.png') });
    console.log('saved v325-03-help-jkl.png');
  } else {
    console.log('help overlay not shown (wb-help-seen pre-set), skip 03');
  }

  // DOM 边车 JSON（机验辅助）
  const domInfo = await page.evaluate(() => ({
    url: location.href,
    helpText: (document.querySelector('.wb-help') || {}).textContent || null,
    blocks: document.querySelectorAll('.wb-tl .block').length,
  }));
  fs.writeFileSync(path.join(OUT, 'v325-dom.json'), JSON.stringify(domInfo, null, 2));
  console.log('saved v325-dom.json');

  await browser.close();
  console.log('done');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
