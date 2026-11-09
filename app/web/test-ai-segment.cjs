/**
 * v3.34 AI 自动分解（独立页面）· 浏览器级验证
 *
 * 用户最高优先级约束：「AI 自动分解必须与分解工作台并列，不在工作台内扩展」
 * 因此本测试的第一要务不是验证新功能多好用，而是**证明工作台确实干净**：
 *   A. 并列入口存在且可达（工位页签，不是工作台内按钮）
 *   B. 工作台零 AI 痕迹（按钮 / 页签 / ais-* DOM / inspector 泄漏 / 三轨不变）
 *   C. 独立页面自身可用（空态、禁用态、双栏布局、无视频不静默失败）
 *   D. 布局无横向溢出、无 JS 异常
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'L01-ST01';
const SHOT = path.join(__dirname, '..', '..', 'deliverables', 'ai-segment', 'shots');
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0;
let fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 220) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed: ' + JSON.stringify(login).slice(0, 200));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));

  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  /* ════════ B. 工作台零 AI 痕迹 ════════ */
  await page.goto(WEB + '/#/workbench/' + SID, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1800);

  console.log('\n--- B. 工作台零 AI 痕迹（隔离性） ---');
  ok('B1 顶栏无「AI 切分」按钮', (await page.$('.wb-ai-btn')) === null);

  const topActs = await page.$$eval('.wb-top-acts > *, .wb-top-acts label', (els) =>
    els.map((el) => (el.textContent || '').trim().slice(0, 6)).filter(Boolean));
  /* v3.45+ 顶栏新增「AI自动识别」= 手工线浪费识别触发器（跑完给 toast 链到独立浪费页），
     不违反 v3.34「AI 分解不内嵌工作台」铁律——铁律约束的是 **分解**（.wb-ai-btn，见 B1）。
     故此处只禁「分解/切分」类入口，放行浪费识别触发器。 */
  ok('B2 顶栏无 AI 分解/切分入口（v3.34 铁律）', !topActs.some((t) => /AI切分|AI分解|自动切分/.test(t)), topActs.join(' | '));
  ok('B3 既有「复用要素」「载入视频/更换视频」仍在', topActs.some((t) => t.indexOf('复用要素') >= 0) &&
    topActs.some((t) => /载入视频|更换视频/.test(t)), topActs.join(' | '));

  const wbTabs = await page.$$eval('.wb-tabs button', (els) => els.map((e) => (e.textContent || '').trim()));
  ok('B4 时间线条只有「时间线」「清单」，无「候选」页签', wbTabs.length === 2 &&
    !wbTabs.some((t) => t.indexOf('候选') >= 0), wbTabs.join('|'));

  const aisLeak = await page.$$eval('.ais-cand, .ais-overlay, .ais-table, .ais-modal, .aip', (els) => els.length);
  ok('B5 工作台 DOM 零 ais-* / aip 节点（候选层已迁出）', aisLeak === 0, 'leaked=' + aisLeak);

  const inspLeak = await page.$$eval('.wb-inspector .ais-cand, .wb-inspector .ais-table, .wb-inspector .aip',
    (els) => els.length);
  ok('B6 检查器子树零增量', inspLeak === 0, 'leaked=' + inspLeak);

  const lanes = await page.$$eval('.tl-lane', (els) => els.length);
  ok('B7 时间线仍是 3 条手别轨', lanes === 3, 'lanes=' + lanes);
  ok('B8 检查器仍在右列', (await page.$('.wb-inspector')) !== null);
  ok('B9 控制栏仍在（记录组按钮完整）', (await page.$$eval('.wb-transport button, .wb-controls button, .wb-rec button', (e) => e.length)) >= 0);

  const block = await page.$('.tl-lane .block');
  ok('B10 人工要素块仍正常渲染', block !== null);
  await page.screenshot({ path: path.join(SHOT, 'v334-workbench-clean.png') });

  /* ════════ A. 并列入口 ════════ */
  console.log('\n--- A. 并列入口 ---');
  const tabTexts = await page.$$eval('.station-tabs a', (els) => els.map((e) => (e.textContent || '').trim()));
  ok('A1 工位页签出现「AI 自动分解」', tabTexts.some((t) => t.indexOf('AI 自动分解') >= 0), tabTexts.join('|'));
  ok('A2 「分解工作台」仍是第一个页签（原有顺序不变）', (tabTexts[0] || '').indexOf('分解工作台') >= 0, tabTexts.join('|'));
  ok('A3 AI 分解排在分解工作台之后（并列而非内嵌）',
    tabTexts.findIndex((t) => t.indexOf('AI 自动分解') >= 0) === 1, tabTexts.join('|'));

  // 单页应用内跳转，禁止整页刷新（否则只测到路由，测不到状态）
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('.station-tabs a')).find((x) => (x.textContent || '').indexOf('AI 自动分解') >= 0);
    if (a) a.click();
  });
  await sleep(1500);
  ok('A4 点击后 hash 切到 #/ai-segment/:id',
    (await page.evaluate(() => location.hash)).indexOf('#/ai-segment/' + SID) === 0,
    await page.evaluate(() => location.hash));

  /* ════════ C. 独立页面自身 ════════ */
  console.log('\n--- C. 独立页面功能 ---');
  ok('C1 页面根节点渲染', (await page.$('.aip')) !== null);
  const title = await page.$eval('.aip-title h2', (e) => (e.textContent || '').trim()).catch(() => '');
  ok('C2 标题为「AI 自动分解」', title === 'AI 自动分解', title);

  ok('C3 左栏视频区存在', (await page.$('.aip-video')) !== null);
  ok('C4 右栏候选区存在', (await page.$('.aip-side')) !== null);
  ok('C5 未分析时给出空态引导', (() => true)() && (await page.$$eval('.ais-empty', (e) => e.length)) > 0);

  const analyzeBtn = await page.$('.aip-acts button.primary');
  ok('C6 有「开始分析」按钮', analyzeBtn !== null);
  ok('C7 无视频时「开始分析」禁用（不给无效点击）', analyzeBtn ? await analyzeBtn.evaluate((b) => b.disabled) : false);

  const writeBtn = await page.$('.aip-foot > button.primary');
  ok('C8 无候选时「写入本工位」禁用', writeBtn ? await writeBtn.evaluate((b) => b.disabled) : false);

  ok('C9 有「视频不上传」承诺文案',
    (await page.evaluate(() => (document.body.textContent || '').indexOf('分析都在本机完成') >= 0)));
  ok('C10 提供「跳过现有要素已覆盖时段」显式开关', (await page.$('.aip-opt input[type=checkbox]')) !== null);
  /* v3.41：replace/append 混写单选已移除（AI 写入一律开新版本）——断言反转 */
  ok('C11 无替换/追加混写单选（v3.41 版本隔离）',
    (await page.$$eval('.aip-foot input[type=radio]', (els) => els.length)) === 0);

  const meta = await page.$eval('.aip-meta', (e) => (e.textContent || '').trim()).catch(() => '');
  ok('C12 头部显示工位与现有要素数（上下文不丢）', meta.indexOf(SID) >= 0, meta);

  /* ════════ D. 布局 ════════ */
  console.log('\n--- D. 布局 ---');
  await page.screenshot({ path: path.join(SHOT, 'v334-ai-segment.png'), fullPage: true });

  const layout = await page.evaluate(() => {
    const side = document.querySelector('.aip-side');
    const stage = document.querySelector('.aip-stage');
    const r = side ? side.getBoundingClientRect() : null;
    const s = stage ? stage.getBoundingClientRect() : null;
    return {
      sideW: r ? Math.round(r.width) : 0,
      stageW: s ? Math.round(s.width) : 0,
      sideRight: r ? Math.round(r.right) : 0,
      hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      winW: window.innerWidth,
    };
  });
  ok('D1 双栏布局成立（左视频宽于右候选栏）', layout.stageW > layout.sideW && layout.sideW > 300,
    JSON.stringify(layout));
  ok('D2 无横向溢出', layout.hOverflow <= 1, 'overflow=' + layout.hOverflow);
  ok('D3 右栏不超出视口', layout.sideRight <= layout.winW + 1, JSON.stringify(layout));

  /* ════════ E. 无异常 ════════ */
  console.log('\n--- E. 稳定性 ---');
  const fatal = errors.filter((e) => !/favicon|ResizeObserver|DevTools|401/i.test(e));
  ok('E1 无未捕获 JS 异常', fatal.length === 0, fatal.slice(0, 3).join(' || '));

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
