/**
 * v3.27 焦点策略专项验证（用户实测反馈）：
 *  点击「完成·下一个」后焦点**不再落进描述框**——现场习惯是「填完本条 → 紧接按 L 播视频
 *  → 用 I/O 定下一要素起止点」；焦点在输入框会把 L 吃成文本，还要多点一次鼠标。
 *  断言四条触发路径（按钮真实点击 / 描述框回车 / Ctrl+Enter）提交后 activeElement 均非 INPUT，
 *  且 L 真的播视频（不被吃成文本）、I 真的设起点；「编辑」按钮仍聚焦描述框（显式编辑意图不回归）。
 * 注意：DOM 块序≠时间序；真实点击保 pointerdown 选中（synthetic click 不触发）。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'v327');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 220) : '')); }
};

/** 现场录制 10s webm 并注入文件输入框（覆盖要素区间 0~8.5s） */
async function injectVideo(page) {
  return page.evaluate(async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const draw = () => {
          const el = performance.now() - t0;
          ctx.fillStyle = `hsl(${el / 8}, 60%, 50%)`;
          ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif';
          ctx.fillText((el / 1000).toFixed(1) + 's', 20, 100);
          if (el < 10000) requestAnimationFrame(draw); else resolve();
        };
        requestAnimationFrame(draw);
      });
      rec.stop();
      await new Promise((r) => { rec.onstop = r; });
      const blob = new Blob(chunks, { type: 'video/webm' });
      const file = new File([blob], 'v327-sample.webm', { type: 'video/webm' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('.wb-top-acts input[type=file]');
      if (!input) return false;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  });
}

/** 当前选中要素编号（检查器标题 #n；未选中为 null） */
const selSeq = (page) => page.evaluate(() => (document.querySelector('.wb-insp-seq') || {}).textContent?.trim() ?? null);
/** activeElement 速写（tag + 是否描述框） */
const focusInfo = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a ? a.tagName : null, isDesc: !!a && a.classList && a.classList.contains('wb-desc'), cls: a ? String(a.className).slice(0, 40) : null };
});
/** 视频状态 */
const videoState = (page) => page.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { paused: v.paused, t: v.currentTime, ended: v.ended, ready: v.readyState } : null;
});
/** 真实点击某个块（elementFromPoint 验证命中，跨轨不点偏） */
async function clickBlock(page, seq) {
  const target = await page.evaluate((sq) => {
    const wrap = document.querySelector('.wb-tl');
    if (wrap) wrap.scrollLeft = 0;
    const blk = Array.from(document.querySelectorAll('.tl-lane .block'))
      .find((b) => (b.querySelector('.blk-seq')?.textContent || '').trim() === sq);
    if (!blk) return null;
    const r = blk.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && (hit === blk || blk.contains(hit)) };
  }, seq);
  if (!target || !target.ok) return false;
  await page.mouse.click(target.x, target.y);
  await sleep(350);
  return true;
}

(async () => {
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
    localStorage.removeItem('wb-new-dur');
  }, login.refreshToken);
  await page.goto(WEB + '/#/workbench/L01-ST01', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.tl-lane .block', { timeout: 20000 });
  await sleep(800);

  console.log('== ① 注入视频 + 选中 #2 ==');
  ok('合成视频注入成功', await injectVideo(page));
  await page.waitForSelector('video', { timeout: 8000 });
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 1; }, { timeout: 8000 });
  await sleep(400);
  if ((await selSeq(page)) !== '#2') ok('真实点击选中 #2 块', await clickBlock(page, '#2'));
  ok('当前选中 #2', (await selSeq(page)) === '#2', await selSeq(page));

  // ========== ② 按钮触发：焦点不落描述框 ==========
  console.log('== ② 按钮点击「完成·下一个」后焦点策略 ==');
  // 先聚焦描述框（模拟刚填完描述），再真实点击按钮——真实点击会把焦点带到按钮上
  await page.click('input.wb-desc');
  await sleep(200);
  ok('点击前焦点在描述框', (await focusInfo(page)).isDesc);
  const btn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find((b) => /完成·下一个/.test(b.textContent || '')));
  const btnBox = await btn.asElement().boundingBox();
  await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
  await sleep(500);
  const fi1 = await focusInfo(page);
  ok('提交后焦点不在描述框（核心修复）', !fi1.isDesc && fi1.tag !== 'INPUT', JSON.stringify(fi1));
  ok('提交后焦点也不留在按钮上（避免空格/回车重复触发）', fi1.tag !== 'BUTTON', JSON.stringify(fi1));
  ok('已跳到下一要素 #3', (await selSeq(page)) === '#3', await selSeq(page));
  const vs0 = await videoState(page);
  ok('播放头已带到 #3 起点（≈6.0s）', vs0 && Math.abs(vs0.t - 6.0) < 0.6, JSON.stringify(vs0));
  await page.screenshot({ path: path.join(SHOT_DIR, 'v327-02-after-commit.png') });
  console.log('saved v327-02-after-commit.png');

  // ========== ③ 提交后按 L 直接播视频（不被吃成文本） ==========
  console.log('== ③ 提交后 L 键即时生效 ==');
  const descBefore = await page.evaluate(() => (document.querySelector('input.wb-desc') || {}).value ?? null);
  const beforeL = await videoState(page);
  await page.keyboard.down('KeyL');
  await sleep(500);
  const duringL = await videoState(page);
  await page.keyboard.up('KeyL');
  await sleep(150);
  ok('按住 L = 视频真的在播（currentTime 前进）', duringL && duringL.paused === false && duringL.t > beforeL.t + 0.15, `${beforeL.t} → ${duringL.t}`);
  ok('松开 L 即停', (await videoState(page)).paused === true);
  const descAfterL = await page.evaluate(() => (document.querySelector('input.wb-desc') || {}).value ?? null);
  ok('L 没被吃成文本（描述值不变）', descBefore === descAfterL, `${descBefore} → ${descAfterL}`);

  // ========== ④ 提交后按 I 直接设起点 ==========
  console.log('== ④ 提交后 I 键设起点 ==');
  await page.keyboard.press('KeyI');
  await sleep(300);
  const flashI = await page.evaluate(() => (document.querySelector('.wb-toast-flash') || {}).textContent?.trim() ?? '');
  ok('按 I 弹出起点确认（快捷键链路完整）', /起点/.test(flashI), flashI);

  // ========== ⑤ 描述框内回车提交也失焦 ==========
  console.log('== ⑤ 描述框回车提交后焦点策略 ==');
  await page.click('input.wb-desc');
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(500);
  const fi2 = await focusInfo(page);
  ok('回车提交后焦点不在描述框', !fi2.isDesc && fi2.tag !== 'INPUT', JSON.stringify(fi2));
  ok('末要素提交后按连续生成新建了 #4', (await selSeq(page)) === '#4', await selSeq(page));
  const beforeL2 = await videoState(page);
  await page.keyboard.down('KeyL');
  await sleep(500);
  const duringL2 = await videoState(page);
  await page.keyboard.up('KeyL');
  ok('新建后再按 L 照样播（8.5s 起）', duringL2 && duringL2.paused === false && duringL2.t > beforeL2.t + 0.15, `${beforeL2.t} → ${duringL2.t}`);

  // ========== ⑥ Ctrl+Enter（焦点在结构化字段）也失焦 ==========
  console.log('== ⑥ Ctrl+Enter 提交后焦点策略 ==');
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('.wb-sd .wb-field input'));
    const obj = inputs.find((i) => /对象/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || ''));
    obj?.focus();
  });
  await sleep(200);
  ok('提交前焦点在结构化字段', (await focusInfo(page)).tag === 'INPUT');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  const fi3 = await focusInfo(page);
  ok('Ctrl+Enter 提交后焦点不在任何输入框', fi3.tag !== 'INPUT', JSON.stringify(fi3));
  ok('再次新建 #5', (await selSeq(page)) === '#5', await selSeq(page));

  // ========== ⑦ 「编辑」按钮仍聚焦描述框（显式编辑意图不回归） ==========
  console.log('== ⑦ 「编辑」按钮聚焦不回归 ==');
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.wb-tlstrip-head .wb-tabs button'));
    tabs.find((b) => /清单/.test(b.textContent || ''))?.click();
  });
  await sleep(400);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.wb-row-acts button')).find((b) => /编辑/.test(b.textContent || ''));
    btn?.click();
  });
  await sleep(400);
  const fi4 = await focusInfo(page);
  ok('「编辑」按钮仍聚焦描述框（显式编辑意图）', fi4.isDesc, JSON.stringify(fi4));

  await page.screenshot({ path: path.join(SHOT_DIR, 'v327-01-focus-blur.png') });
  console.log('saved v327-01-focus-blur.png');
  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
