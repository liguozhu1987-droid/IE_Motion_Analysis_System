/** v3.44 截图验证：SOP 对齐面板 + ROI 功能区子区覆盖层（视觉核对 + DOM 边车） */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'L01-ST01';
const OUT = 'D:/Application/IE_Improvement_Platform/deliverables/ai-segment';

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();

  /* 布置：子区 + SOP 步骤 */
  await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roi_zones: JSON.stringify([
        { name: '扫码枪卡位', x: 0.05, y: 0.10, w: 0.30, h: 0.45 },
        { name: '料箱', x: 0.62, y: 0.45, w: 0.33, h: 0.50 },
      ]),
      sop_steps: JSON.stringify([{ verb: '拿取', object: '后横梁' }, { verb: '装配' }, { verb: '放置' }]),
    }),
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);
  await page.goto(`${WEB}/?b=${Date.now()}#/ai-segment/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.aip-head', { timeout: 30000 });
  await sleep2(1200);

  const fixture = path.join(__dirname, 'test-fixtures', 'aiseg-8s.mp4');
  const fileInput = await page.$('.aip-acts input[type=file]');
  await fileInput.uploadFile(fixture);
  await sleep2(2000);

  /* 截图1：ROI 面板 + 子区覆盖层 */
  await clickBtn('操作区');
  await page.waitForSelector('.aip-roi-panel');
  await sleep2(500);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'v344-roi-zones.png') });

  /* 截图2：SOP 对齐面板（含对齐结果） */
  await clickBtn('关闭');
  await sleep2(300);
  await clickBtn('SOP 对齐');
  await page.waitForSelector('.aip-sop');
  await sleep2(400);
  /* 分析后对齐（若无候选则仅面板本身） */
  const analyzeBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.aip-acts button')].find((b) => b.textContent === '开始分析'));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-sop button')].find((x) => x.textContent === '关闭');
    b.click();
  });
  await sleep2(300);
  await analyzeBtn.asElement().click();
  for (let i = 0; i < 120; i += 1) {
    await sleep2(2000);
    const running = (await page.$$eval('.ais-overlay', (e) => e.length)) > 0;
    if (!running) break;
  }
  await clickBtn('SOP 对齐');
  await page.waitForSelector('.aip-sop');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-sop button')].find((x) => /对齐候选/.test(x.textContent));
    if (b && !b.disabled) b.click();
  });
  await sleep2(1500);
  await page.screenshot({ path: path.join(OUT, 'v344-sop-align.png') });

  /* DOM 边车（机验） */
  const sidecar = {
    sopPanel: await page.$eval('.aip-sop', (e) => e.textContent.slice(0, 500)).catch(() => null),
    zoneRects: await page.$$eval('.aip-zone-rect span', (es) => es.map((e) => e.textContent)).catch(() => []),
    sopBadges: await page.$$eval('.ais-sop', (es) => es.slice(0, 5).map((e) => e.textContent)).catch(() => []),
    descSample: await page.$$eval('.ais-table input[aria-label$="描述"]', (es) => es.slice(0, 4).map((e) => e.value)).catch(() => []),
  };
  fs.writeFileSync(path.join(OUT, 'v344-sidecar.json'), JSON.stringify(sidecar, null, 2));
  console.log('screenshots saved');

  /* 还原 */
  await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roi_zones: null, sop_steps: null }),
  });
  await browser.close();
  process.exit(0);

  async function clickBtn(text) {
    await page.evaluate((t) => {
      const b = [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes(t));
      if (b) b.click();
    }, text);
  }
  function sleep2(ms) { return new Promise((r) => setTimeout(r, ms)); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
