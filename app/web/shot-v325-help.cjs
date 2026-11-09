/** v3.25 补充：帮助浮层截图（不预置 wb-help-seen，首次进入自动弹出） */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const OUT = 'D:/Application/IE_Improvement_Platform/deliverables/v325';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();

  let sid = 'L01-ST01';
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    // 不预置 wb-help-seen → 首次进入自动弹帮助浮层
  }, login.refreshToken);

  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(1200);
  const help = await page.evaluate(() => {
    const el = document.querySelector('.shortcut-modal');
    return { visible: !!el, text: el ? el.textContent.replace(/\s+/g, ' ').slice(0, 400) : null };
  });
  console.log('help overlay:', JSON.stringify(help));
  if (help.visible) {
    await page.screenshot({ path: path.join(OUT, 'v325-03-help-jkl.png') });
    console.log('saved v325-03-help-jkl.png');
  } else {
    // 兜底：Ctrl+K 工具箱 → 快捷键帮助
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await sleep(600);
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('button, [class*="cmd"], [class*="palette"] [role="button"]'));
      const b = items.find((x) => /快捷键帮助/.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(800);
    const help2 = await page.evaluate(() => {
      const el = document.querySelector('.shortcut-modal');
      return { visible: !!el, text: el ? el.textContent.replace(/\s+/g, ' ').slice(0, 400) : null };
    });
    console.log('after Ctrl+K:', JSON.stringify(help2));
    if (help2.visible) {
      await page.screenshot({ path: path.join(OUT, 'v325-03-help-jkl.png') });
      console.log('saved v325-03-help-jkl.png (via Ctrl+K)');
    }
  }
  await browser.close();
  console.log('done');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
