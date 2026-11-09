/**
 * v3.17 工作台操作效率优化验证：
 *  1. 「完成·下一个」按钮组置顶（检查器 head 之后、结构化描述之前）+ 吸顶类
 *  2. 视频下方控制栏有 设起点(I)/设止点(O) 按钮
 *  3. I 键设起点 / O 键设止点（播放头落边界，flash 确认 + 输入框值变化）
 *  4. Ctrl+Enter = 完成·下一个（flash「已记录」）
 *  5. 时间线区块直角边（border-radius = 0）
 *  6. 截图
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const WEB = 'http://localhost:5173';
const API = 'http://localhost:3001/api';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const { refreshToken } = await login.json();
  ok('登录取得 refreshToken', !!refreshToken);

  const token = (await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) })).json()).accessToken;
  const H = { Authorization: 'Bearer ' + token };
  let sid = null;
  for (const line of await (await fetch(API + '/lines', { headers: H })).json()) {
    for (const st of await (await fetch(API + '/stations?lineId=' + line.line_id, { headers: H })).json()) {
      const els = await (await fetch(API + '/stations/' + st.station_id + '/elements', { headers: H })).json();
      if (Array.isArray(els.elements) && els.elements.length > 0) { sid = st.station_id; break; }
    }
    if (sid) break;
  }
  ok('定位有要素的工位 ' + sid, !!sid);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);
  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(500);
  (await page.$('.wb-tl .block')).click();
  await page.waitForSelector('.wb-insp-head', { timeout: 15000 });
  await sleep(400);

  // 1. 完成·下一个按钮组：v3.18 起移到结构化描述区下方（原预览位置），仍需无滚动够到
  const order = await page.evaluate(() => {
    const insp = document.querySelector('.wb-inspector');
    const head = insp.querySelector('.wb-insp-head');
    const sd = insp.querySelector('.wb-sec'); // 第一个 wb-sec = 结构化描述
    const foot = sd ? sd.querySelector('.wb-insp-foot.sd') : null;
    const posHead = head.compareDocumentPosition(foot);
    const posSd = sd.compareDocumentPosition(foot);
    return {
      footExists: !!foot,
      afterHead: (posHead & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, // foot 在 head 之后
      afterSd: (posSd & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, // foot 在结构化描述之后（原预览位）
      footBtns: foot ? Array.from(foot.querySelectorAll('button')).map((b) => b.textContent.trim()) : [],
    };
  });
  ok('1a 完成·下一个按钮组存在（结构化描述区下方）', order.footExists);
  ok('1b 按钮组位于检查器头部之后', order.afterHead);
  ok('1c 按钮组位于结构化描述区末尾（原预览位置）', order.afterSd);
  ok('1d 按钮含 完成·下一个 + 删除', order.footBtns.join('|').includes('完成·下一个') && order.footBtns.join('|').includes('删除'));

  // 2. 控制栏 I/O 按钮
  const io = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.wb-controls .wb-rec-btn.io'));
    return {
      count: btns.length,
      texts: btns.map((b) => b.textContent.trim()),
      inControls: btns.every((b) => !!b.closest('.wb-controls')),
    };
  });
  ok('2a 控制栏有 2 个 I/O 按钮', io.count === 2 && io.inControls);
  ok('2b 按钮文本含 I起点 / O止点', io.texts.join('|').includes('I起点') || (io.texts[0].includes('I') && io.texts[1].includes('O')));

  // 3. 直角边
  const br = await page.evaluate(() => {
    const b = document.querySelector('.wb-tl .block');
    return b ? getComputedStyle(b).borderRadius : 'none';
  });
  ok('3 时间线区块直角边（border-radius=0）', br === '0px');

  // 4. I 键设起点：点轨道空白定位播放头 → 按 i
  const beforeStart = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('.wb-inspector .wb-field')).find((l) => (l.querySelector('span') || {}).textContent?.includes('起点'));
    return lab?.querySelector('input')?.value ?? null;
  });
  const lane = await page.evaluate(() => {
    const el = document.querySelector('.tl-lane');
    const rect = el.getBoundingClientRect();
    const blocks = Array.from(el.querySelectorAll('.block')).map((b) => b.getBoundingClientRect()).filter((r) => r.left < rect.right && r.right > rect.left);
    const maxRight = blocks.length ? Math.max(...blocks.map((r) => r.right - rect.left)) : 0;
    const x = Math.min(rect.width - 14, Math.max(60, maxRight + 40));
    return { x: rect.left + x, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(lane.x, lane.y);
  await sleep(250);
  await page.keyboard.press('i');
  await sleep(300);
  const afterI = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('.wb-inspector .wb-field')).find((l) => (l.querySelector('span') || {}).textContent?.includes('起点'));
    const flash = document.querySelector('.wb-toast-flash');
    return { start: lab?.querySelector('input')?.value ?? null, flash: flash ? flash.textContent : '' };
  });
  ok('4a I 键设起点：flash 提示「起点 →」', afterI.flash.includes('起点'));
  ok('4b I 键设起点：起点输入框值已更新', beforeStart !== null && afterI.start !== null && afterI.start !== beforeStart);

  // 5. O 键设止点
  const beforeDur = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('.wb-inspector .wb-field')).find((l) => (l.querySelector('span') || {}).textContent?.includes('时长'));
    return lab?.querySelector('input')?.value ?? null;
  });
  await page.mouse.click(lane.x + 80, lane.y); // 再往右 80px 定位播放头
  await sleep(250);
  await page.keyboard.press('o');
  await sleep(300);
  const afterO = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('.wb-inspector .wb-field')).find((l) => (l.querySelector('span') || {}).textContent?.includes('时长'));
    const flash = document.querySelector('.wb-toast-flash');
    return { dur: lab?.querySelector('input')?.value ?? null, flash: flash ? flash.textContent : '' };
  });
  ok('5a O 键设止点：flash 提示「止点 →」', afterO.flash.includes('止点'));
  ok('5b O 键设止点：时长输入框值已更新', beforeDur !== null && afterO.dur !== null && afterO.dur !== beforeDur);

  // 6. Ctrl+Enter = 完成·下一个
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await sleep(300);
  const afterCE = await page.evaluate(() => {
    const flash = document.querySelector('.wb-toast-flash');
    return flash ? flash.textContent : '';
  });
  ok('6 Ctrl+Enter = 完成·下一个（flash「已记录」）', afterCE.includes('已记录'));

  await page.screenshot({ path: 'D:/Application/IE_Improvement_Platform/deliverables/screenshots/v317-io-points.png' });
  ok('7 截图已保存 v317-io-points.png', true);

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
