/**
 * v3.26 交付截图：对象智能预填两个关键状态
 *  ① yes 级静默预填（拿取→放置：对象自动带入，无标注）
 *  ② conditional 级（放置→目检：预填+「请确认」琥珀标注）
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'v326');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
    localStorage.removeItem('wb-new-dur');
  }, login.refreshToken);
  await page.goto(WEB + '/#/workbench/L01-ST01', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.tl-lane .block', { timeout: 20000 });
  await sleep(800);

  // 新片段设 1s（与现场默认一致）
  await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll('.wb-ab-field')).find((l) => /新片段/.test(l.textContent || ''));
    const input = f?.querySelector('input');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(300);

  // N 新增 → 构造上一要素「拿取 导轨 于 物料箱」
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('KeyN');
  await sleep(400);
  await page.evaluate(() => {
    const set = (el, v) => { const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; st.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const inputs = Array.from(document.querySelectorAll('.wb-sd .wb-field input'));
    set(inputs.find((i) => /对象/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || '')) || inputs[0], '导轨');
    set(inputs.find((i) => /位置/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || '')) || inputs[1], '物料箱');
  });
  await sleep(500);

  // 完成·下一个 → 选「放置」→ yes 级静默预填
  await page.evaluate(() => document.body.focus());
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  await page.click('.wb-tsel-btn');
  await sleep(400);
  await page.evaluate(() => { Array.from(document.querySelectorAll('.wb-tsel-o')).find((o) => o.textContent.trim() === '放置')?.click(); });
  await sleep(600);
  const yes = await page.evaluate(() => {
    const obj = Array.from(document.querySelectorAll('.wb-sd .wb-field input')).find((i) => /对象/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || ''));
    return { val: obj?.value, badge: !!document.querySelector('.wb-sd-confirm') };
  });
  await page.screenshot({ path: path.join(SHOT_DIR, 'v326-02-carry-yes.png') });
  console.log('yes 级预填:', JSON.stringify(yes));

  // 完成·下一个 → 选「目检」→ conditional 级预填+请确认
  await page.evaluate(() => document.body.focus());
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  await page.click('.wb-tsel-btn');
  await sleep(400);
  await page.evaluate(() => { Array.from(document.querySelectorAll('.wb-tsel-o')).find((o) => o.textContent.trim() === '目检')?.click(); });
  await sleep(600);
  const cond = await page.evaluate(() => {
    const obj = Array.from(document.querySelectorAll('.wb-sd .wb-field input')).find((i) => /对象/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || ''));
    const badge = document.querySelector('.wb-sd-confirm');
    return { val: obj?.value, badge: badge ? badge.textContent : null, visible: badge ? badge.offsetParent !== null : false };
  });
  await page.screenshot({ path: path.join(SHOT_DIR, 'v326-03-carry-conditional.png') });
  console.log('conditional 预填:', JSON.stringify(cond));

  await browser.close();
  process.exit(yes.val === '导轨' && !yes.badge && cond.val === '导轨' && cond.visible ? 0 : 1);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
