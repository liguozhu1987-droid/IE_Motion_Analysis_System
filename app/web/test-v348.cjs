/**
 * v3.48 · 工作台时间线点击联动 + AI 分析结果完整展示 UI 测试
 *
 * 背景（用户两项需求）：
 *  需求1 时间线点击联动跳转：点击时间线动作要素片段时，若视频已加载，
 *        播放点自动跳到该片段计时起点（无论视频是否为该片段真实视频）。
 *  需求2 AI 分析结果完整展示：浪费清单 / VA 动作分析明细 / 改善建议在
 *        页面完整渲染且支持用户决策（采纳/否决/确认/忽略）。
 *
 * 断言：
 *  T1 时间线渲染：ST010 当前版本 20 个要素块
 *  T2 无视频单击联动：点 seq4 块 → 播放头 left = start_ms/1000*PX_PER_SEC(60)，块选中
 *  T3 再点同块 → 取消选中（selected 移除）
 *  T4 有视频单击跳转（需求1核心）：载入 8s 固件 → 点 seq4 块(4880ms) → video.currentTime≈4.88
 *  T5 有视频跳转后播放头与视频双向一致（playhead left 同步）
 *  T6 AI自动识别浪费按钮门控（v3.48）：fresh load（草稿干净+有已提交要素）→ enabled；
 *     改手别制造草稿脏 → disabled（title 提示先提交）
 *  T7 分析页「动作分析明细」卡片：20 行，列含 ST/作业内容/分类/浪费类型/改善方向
 *  T8 浪费识别页（manual 线）：批次状态条 + 浪费点表 6 行 + 问题清单卡片 6 张
 *  T9 AI 建议页：3 条建议卡片 + 决策按钮（采纳/否决，无直接执行）
 *  T10 无 JS pageerror
 *
 * 前置：API(3001) + Vite dev(5173)；固件 test-fixtures/aiseg-8s.mp4。
 * 数据：BJFA1/ST010 生产演示工位（20 手工要素 v1 + 6 浪费点 + 6 问题清单 + 3 建议；2026-10-28 凌晨 CMC 数据
 *       重导入后为 20 条，此前 18 条——本期望值随数据同步更新，非功能回归）——
 *       本测试只读不改，不写任何 PATCH/POST（T6 的手别改动仅本地草稿，不提交）。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const SID = 'ST010';
const PX_PER_SEC = 60;
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  const fixture = path.join(__dirname, 'test-fixtures', 'aiseg-8s.mp4');
  if (!fs.existsSync(fixture)) { console.log('  SKIP 缺少固件 aiseg-8s.mp4'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));
  /* 只读保证：记录任何业务写方法（/auth/ 轮换刷新属会话机制，不算业务写入） */
  const writes = [];
  page.on('request', (req) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method()) && /\/api\//.test(req.url()) && !/\/api\/auth\//.test(req.url())) {
      writes.push(req.method() + ' ' + req.url().replace(/^https?:\/\/[^/]+/, ''));
    }
  });

  /* v3.48 测试修复：refresh token 轮换 + 无条件覆写会互相打死——
     每次全文档加载应用都会轮换 RT（accessToken 仅存内存），若每个新文档都
     覆写为初始 RT，第二个文档起 refresh 必然 401 → 退登录页。
     故条件注入：localStorage 无 token 才写（保留应用轮换出的最新 RT）。 */
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  console.log('\n--- T1-T3. 时间线渲染 + 无视频单击联动 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/workbench/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.timeline .block', { timeout: 30000 });
  await sleep(1200);

  const blockCount = await page.$$eval('.timeline .block', (ns) => ns.length);
  ok('T1 时间线渲染 20 个要素块', blockCount === 20, blockCount);

  /* 取 seq=4 的块（start_ms=4880，在 8s 固件时长内） */
  const seq4 = await page.evaluateHandle(() => {
    const blks = [...document.querySelectorAll('.timeline .block')];
    return blks.find((b) => /^#4(\s|$)/.test((b.querySelector('.blk-seq')?.textContent ?? ''))) ?? null;
  });
  const seq4El = seq4.asElement();
  ok('T2 找到 seq=4 要素块', Boolean(seq4El));

  const playheadLeft = () => page.$eval('.timeline .playhead', (n) => parseFloat(n.style.left));
  const beforeLeft = await playheadLeft();

  await seq4El.click();
  await sleep(400);
  const afterLeft = await playheadLeft();
  const expectLeft = (4880 / 1000) * PX_PER_SEC;
  ok('T2 无视频单击 → 播放头跳到 4880ms', Math.abs(afterLeft - expectLeft) < 2, `left=${afterLeft} expect=${expectLeft} (before=${beforeLeft})`);
  const selAfterClick = await page.$eval('.timeline .block.selected', (n) => n.querySelector('.blk-seq')?.textContent ?? '').catch(() => '');
  ok('T2 单击后块呈选中态', selAfterClick.trim() === '#4', selAfterClick);

  await seq4El.click();
  await sleep(300);
  const selAfterSecond = await page.$('.timeline .block.selected');
  ok('T3 再点同块 → 取消选中', selAfterSecond === null);

  console.log('\n--- T4-T5. 视频已加载时单击跳转（需求1核心） ---');
  const fileInput = await page.$('input[type=file][accept*="video"]');
  ok('T4 找到视频载入输入框', Boolean(fileInput));
  await fileInput.uploadFile(fixture);
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2 && v.duration > 0;
  }, { timeout: 30000, polling: 300 });
  await sleep(600);

  /* 先把播放头挪到 0，避免初始位置恰好命中 4.88 造成假通过 */
  await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.currentTime = 0; });
  await sleep(300);
  const ctBefore = await page.evaluate(() => document.querySelector('video').currentTime);

  await seq4El.click();
  await sleep(700);
  const ctAfter = await page.evaluate(() => document.querySelector('video').currentTime);
  ok('T4 有视频单击 → video.currentTime 跳到 4.88s', Math.abs(ctAfter - 4.88) < 0.3, `before=${ctBefore} after=${ctAfter}`);
  const phAfterVideo = await playheadLeft();
  ok('T5 播放头与视频同步（left≈4.88*60）', Math.abs(phAfterVideo - expectLeft) < 2, phAfterVideo);

  console.log('\n--- T6. AI自动识别浪费按钮门控（v3.48 草稿脏派生） ---');
  const wasteBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'AI自动识别浪费'));
  const wbEl = wasteBtn.asElement();
  ok('T6 顶栏「AI自动识别浪费」按钮存在', Boolean(wbEl));
  const disabledFresh = await page.evaluate((b) => b.disabled, wbEl);
  ok('T6 fresh load（草稿干净+有已提交要素）→ 按钮可点', disabledFresh === false, disabledFresh);
  const titleFresh = await page.evaluate((b) => b.title, wbEl);
  ok('T6 fresh 态 title 为识别文案（非门控提示）', /基于已提交的手工分解要素/.test(titleFresh), titleFresh);

  /* 制造草稿脏：确保 seq=4 块处于选中态后改手别（本地草稿，不提交）。
     注意 T4 已选中过 seq4——先查选中态，已选中则不再点（再点=取消选中）。 */
  const seq4Selected = await page.$('.timeline .block.selected');
  if (!seq4Selected) { await seq4El.click(); await sleep(300); }
  const handChanged = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.wb-inspector .wb-sec')];
    const handSec = secs.find((s) => s.querySelector('.wb-sec-t')?.textContent === '手别');
    if (!handSec) return 'no-hand-sec';
    const btns = [...handSec.querySelectorAll('.wb-seg button')];
    const on = btns.find((b) => b.classList.contains('on'));
    const other = btns.find((b) => b !== on);
    if (!other) return 'no-other';
    other.click();
    return 'clicked:' + other.textContent;
  });
  await sleep(400);
  const disabledDirty = await page.evaluate((b) => b.disabled, wbEl);
  ok('T6 草稿脏（改手别）→ 按钮置灰', disabledDirty === true, `handChanged=${handChanged} disabled=${disabledDirty}`);
  const titleDirty = await page.evaluate((b) => b.title, wbEl);
  ok('T6 脏态 title 提示先提交分解', /先「提交分解」/.test(titleDirty), titleDirty);

  console.log('\n--- T7. 分析页动作分析明细（需求2 · VA 分析展示） ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/analysis/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.card h3', { timeout: 30000 });
  await sleep(1000);
  const detailInfo = await page.evaluate(() => {
    const h3s = [...document.querySelectorAll('.card h3')];
    const h3 = h3s.find((x) => /动作分析明细/.test(x.textContent));
    if (!h3) return null;
    const card = h3.closest('.card');
    const rows = [...card.querySelectorAll('tbody tr')];
    return {
      title: h3.textContent,
      rowCount: rows.length,
      heads: [...card.querySelectorAll('thead th')].map((t) => t.textContent.trim()),
      firstRow: rows[0] ? [...rows[0].querySelectorAll('td')].map((t) => t.textContent.trim()) : null,
    };
  });
  ok('T7 动作分析明细卡片存在', Boolean(detailInfo), detailInfo && detailInfo.title);
  ok('T7 明细 20 行（=生效要素数）', detailInfo && detailInfo.rowCount === 20, detailInfo && detailInfo.rowCount);
  ok('T7 表头含 ST/作业内容/分类/浪费类型/改善方向',
    detailInfo && ['#', 'ST(s)', '作业内容', '分类', '浪费类型', '改善方向'].every((h) => detailInfo.heads.includes(h)),
    detailInfo && JSON.stringify(detailInfo.heads));
  ok('T7 首行含拿取描述与 NVA 分类', detailInfo && /拿取/.test(detailInfo.firstRow[2]) && detailInfo.firstRow[3] === 'NVA',
    detailInfo && JSON.stringify(detailInfo.firstRow));
  await page.screenshot({ path: path.join(SHOT_DIR, 'v348-analysis-detail.png') });

  console.log('\n--- T8. 浪费识别页 manual 线（需求2 · 浪费清单展示） ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/ai-waste/${SID}?source=manual`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.aw-page', { timeout: 30000 });
  await sleep(1200);
  const wasteInfo = await page.evaluate(() => {
    const page1 = document.querySelector('.aw-page');
    const tables = [...page1.querySelectorAll('table.dash-table')];
    const findingRows = tables[0] ? tables[0].querySelectorAll('tbody tr').length : 0;
    const issueCards = page1.querySelectorAll('.aw-issue-card').length;
    const issueText = page1.querySelector('.aw-issues')?.textContent ?? '';
    const decisionBtns = [...page1.querySelectorAll('.aw-issues button')].filter((b) => /^(确认|忽略)$/.test(b.textContent.trim())).length;
    return { findingRows, issueCards, hasDone: /完成|done/.test(page1.textContent), issueText: issueText.slice(0, 120), decisionBtns };
  });
  ok('T8 浪费点表 6 行', wasteInfo.findingRows === 6, wasteInfo.findingRows);
  ok('T8 问题清单卡片渲染（6 张）', wasteInfo.issueCards === 6, wasteInfo.issueCards);
  ok('T8 问题清单含 ECRS/tier 语义', /E|C|R|S/.test(wasteInfo.issueText), wasteInfo.issueText);
  ok('T8 问题清单支持用户决策（5 待处理 × 确认/忽略）', wasteInfo.decisionBtns === 10, wasteInfo.decisionBtns);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v348-ai-waste-manual.png') });

  console.log('\n--- T9. AI 建议页（需求2 · 改善建议与决策） ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/ai-suggestions/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1500);
  const suggInfo = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ai-sug-card')];
    const allBtns = [...document.querySelectorAll('button')];
    return {
      cards: cards.length,
      adoptBtns: allBtns.filter((b) => b.textContent.trim() === '采纳').length,
      rejectBtns: allBtns.filter((b) => b.textContent.trim() === '否决').length,
      pendingTags: (document.body.textContent.match(/待审/g) ?? []).length,
      hasExecute: allBtns.some((b) => /直接执行|立即执行/.test(b.textContent)),
    };
  });
  ok('T9 建议卡片渲染（3 张）', suggInfo.cards === 3, suggInfo.cards);
  ok('T9 采纳/否决决策按钮各 3（三铁律：永远待审）', suggInfo.adoptBtns === 3 && suggInfo.rejectBtns === 3, JSON.stringify(suggInfo));
  ok('T9 无「直接执行」类按钮（三铁律：永远待审）', suggInfo.hasExecute === false);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v348-ai-suggest.png') });

  console.log('\n--- T10. 收尾 ---');
  ok('T10 无 JS pageerror', errors.length === 0, errors.join(' | '));
  ok('T10 测试全程零写入（只读演示工位）', writes.length === 0, writes.join(' | '));

  await browser.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
