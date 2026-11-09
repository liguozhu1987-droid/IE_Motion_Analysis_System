/**
 * v3.20 截图脚本（4 场景目检）：
 *  ① 类型检索：常用区（频次排序）+ 输入「转身」收敛高亮
 *  ② 手动录入：「转身180」→ 识别为转身 + 残留回填行
 *  ③ 快捷工具箱：Ctrl+K 命令面板
 *  ④ 校验横幅：错误提示带 × 关闭钮（不常驻遮挡）
 * 前后处理 admin.must_change_pwd（截图不会被改密页挡住；结束还原）。
 * 注：DB 直连仅允许在 app/api 目录内进行（本脚本不碰库，must_change_pwd 已确认为 0）。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const OUT = 'D:/Application/IE_Improvement_Platform/deliverables/screenshots/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const { refreshToken } = await login.json();

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('dialog', async (d) => { await d.dismiss(); });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);

  // 找有要素工位 + 造频次历史（转身×3 / 拿取×2，常用区才有内容）
  await page.goto(WEB + '/#/workbench/L01-ST01', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(600);
  const seedFreq = await page.evaluate(() => {
    localStorage.setItem('wb-type-freq-v1', JSON.stringify({
      转身: { n: 3, t: Date.now() }, 拿取: { n: 2, t: Date.now() - 86400000 }, 移物: { n: 1, t: Date.now() - 172800000 },
    }));
    return true;
  });
  await sleep(200);
  await (await page.$('.wb-tl .block')).click();
  await page.waitForSelector('.wb-tsel-btn', { timeout: 10000 });
  await sleep(300);

  // ① 类型检索：常用区 + 「转身」收敛高亮
  await page.click('.wb-tsel-btn');
  await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
  await sleep(300);
  await page.screenshot({ path: OUT + 'v320-type-search-open.png' });
  fs.writeFileSync(OUT + '_state-open.json', JSON.stringify(await page.evaluate(() => ({
    q: (document.querySelector('.wb-tsel-q') || {}).value,
    firstHeader: (document.querySelector('.wb-tsel-menu .wb-tsel-h') || {}).textContent,
    opts: Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim()).slice(0, 8),
  }))));
  await page.evaluate(() => {
    const el = document.querySelector('.wb-tsel-q');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '转身');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  await page.screenshot({ path: OUT + 'v320-type-search-hit.png' });
  fs.writeFileSync(OUT + '_state-hit.json', JSON.stringify(await page.evaluate(() => ({
    q: (document.querySelector('.wb-tsel-q') || {}).value,
    opts: Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim()),
    mark: (document.querySelector('.wb-tsel-mark') || {}).textContent,
  }))));
  await page.keyboard.press('Escape');
  await sleep(200);

  // ② 手动录入：「转身180」→ 识别 + 残留回填
  await page.click('.wb-tsel-btn');
  await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
  await sleep(200);
  await page.evaluate(() => {
    const el = document.querySelector('.wb-tsel-q');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '转身180');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  await page.screenshot({ path: OUT + 'v320-manual-entry.png' });
  fs.writeFileSync(OUT + '_state-manual.json', JSON.stringify(await page.evaluate(() => ({
    q: (document.querySelector('.wb-tsel-q') || {}).value,
    manual: (document.querySelector('.wb-tsel-manual') || {}).textContent,
    opts: Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim()),
  }))));
  await page.keyboard.press('Escape');
  await sleep(200);

  // ③ 快捷工具箱 Ctrl+K
  await page.evaluate(() => document.body.focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(400);
  await page.screenshot({ path: OUT + 'v320-toolbox.png' });
  fs.writeFileSync(OUT + '_state-toolbox.json', JSON.stringify(await page.evaluate(() => ({
    groups: Array.from(document.querySelectorAll('.wb-tbx-gh')).map((g) => g.textContent.trim()),
    firstItems: Array.from(document.querySelectorAll('.wb-tbx-i')).slice(0, 4).map((i) => i.textContent.trim()),
  }))));
  await page.keyboard.press('Escape');
  await sleep(200);

  // ④ 校验横幅（L01-ST02 空版本复测 → 前端护栏错误提示 + × 关闭钮）
  await page.goto(WEB + '/#/workbench/L01-ST02', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-more', { timeout: 20000 });
  await sleep(500);
  await page.click('.wb-more summary');
  await sleep(250);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.wb-more-menu button'));
    btns.find((x) => x.textContent.includes('开始复测'))?.click();
  });
  await sleep(600);
  await page.screenshot({ path: OUT + 'v320-banner-close.png' });
  fs.writeFileSync(OUT + '_state-banner.json', JSON.stringify(await page.evaluate(() => ({
    banner: (document.querySelector('.wb-banner') || {}).textContent,
    closeBtn: !!document.querySelector('.wb-banner-x'),
  }))));

  await browser.close();
  console.log('v3.20 截图完成（4 张）');
})().catch((e) => {
  console.error('截图异常:', e);
  process.exit(1);
});
