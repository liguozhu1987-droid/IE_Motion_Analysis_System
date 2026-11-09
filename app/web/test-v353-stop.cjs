/**
 * v3.53-stop · 时间线片段播放停止点精确停靠验证（用户需求：停止点对齐止点线）
 *
 * 根因（已修复）：起播时 segEndRef = 止点 + 2 帧，rAF 停止判定用该阈值触发 pause，
 *   且暂停后把播放头回写成「止点+2帧」而非止点本身 → 播放头与视频双双越过止点约 +66ms。
 *   修复：segEndRef 仅作「触发阈值」（吸收 rAF 采样误差防漏停），真正停靠位置精确回落到 elEndMs(sel)。
 *
 * 断言：
 *  A1 载入 8s 固件，单击 seq4 块（start=4880ms，止点=6120ms）→ 播放头跳到 4880ms
 *  A2 播放（空格）→ 片段模式从预卷 4480ms 起播
 *  A3 等片段播完自动停止：video.currentTime 精确 ≈ 6.12s（止点），而非旧行为 6.19s（止点+2帧）
 *  A4 播放头 left 精确 = 6120/1000*60 = 367.2px（止点线），而非 371.2px（止点+2帧）
 *  A5 停止后视频处于 paused 状态
 *  A6 无 JS pageerror
 *
 * 只读：不写任何业务端点。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const SID = 'ST010';
const PX_PER_SEC = 60;
const SEQ4_START = 4880;   // ms
const SEQ4_END = 6120;     // ms（止点 = start + round(dur_s*1000) = 4880 + 1240）

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
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
  if (!fs.existsSync(fixture)) { console.log('SKIP 缺少固件 aiseg-8s.mp4'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const jsErrs = [];
  page.on('pageerror', (e) => jsErrs.push(String(e.message).slice(0, 200)));
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  console.log('\n--- v3.53-stop 片段播放停止点精确停靠验证 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/workbench/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.timeline .block', { timeout: 30000 });
  await sleep(1200);

  // 载入固件
  const fileInput = await page.$('input[type=file][accept*="video"]');
  ok('A0 找到视频载入输入框', Boolean(fileInput));
  await fileInput.uploadFile(fixture);
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2 && v.duration > 0;
  }, { timeout: 30000, polling: 300 });
  await sleep(600);

  // 单击 seq4 块 → 选中 + 跳到 4880ms
  const seq4 = await page.evaluateHandle(() => {
    const blks = [...document.querySelectorAll('.timeline .block')];
    return blks.find((b) => /^#4(\s|$)/.test((b.querySelector('.blk-seq')?.textContent ?? ''))) ?? null;
  });
  const seq4El = seq4.asElement();
  ok('A1 找到 seq=4 要素块', Boolean(seq4El));

  // 先把视频归零，避免初始位置干扰
  await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.currentTime = 0; });
  await sleep(300);
  await seq4El.click();
  await sleep(500);
  const ctClick = await page.evaluate(() => document.querySelector('video').currentTime);
  ok('A1 单击 seq4 → video.currentTime 跳到 4.88s', Math.abs(ctClick - SEQ4_START / 1000) < 0.3, ctClick);

  // 播放：进入片段模式（从预卷 4480ms 起播到止点 6120ms）
  const selNow = await page.$('.timeline .block.selected');
  if (!selNow) { await seq4El.click(); await sleep(300); }
  await page.keyboard.press('Space');
  await sleep(400);
  const playingEarly = await page.evaluate(() => !document.querySelector('video').paused);
  ok('A2 播放启动（片段模式）', playingEarly === true);

  // 等片段播完自动停止：止点 6120ms，预卷起播 4480ms，实际播放 1640ms，留足余量
  await sleep(2600);
  const stopState = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { ct: v.currentTime, paused: v.paused };
  });
  const playheadLeft = await page.$eval('.timeline .playhead', (n) => parseFloat(n.style.left));

  const endSec = SEQ4_END / 1000;           // 6.12
  const endPx = (SEQ4_END / 1000) * PX_PER_SEC;  // 367.2

  ok('A3 video.currentTime 精确停在止点 6.12s（误差 < 1 帧 33ms）',
    Math.abs(stopState.ct - endSec) < 0.034,
    `ct=${stopState.ct.toFixed(3)} expect=${endSec.toFixed(3)} (旧行为≈6.187)`);
  ok('A3 未越过止点+2帧（修复前会停 6.19s 附近）',
    stopState.ct < endSec + 0.05,
    `ct=${stopState.ct.toFixed(3)}`);
  ok('A4 播放头 left 精确停在止点线 367.2px（误差 < 2px）',
    Math.abs(playheadLeft - endPx) < 2,
    `left=${playheadLeft} expect=${endPx} (旧行为≈371.2)`);
  ok('A5 停止后视频处于 paused', stopState.paused === true, stopState.paused);
  ok('A6 无 JS pageerror', jsErrs.length === 0, jsErrs.join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('异常：', e);
  process.exit(1);
});
