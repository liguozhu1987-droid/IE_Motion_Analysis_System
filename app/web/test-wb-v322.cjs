/**
 * v3.22 分解工作台交互重整专项验证：
 *  A. 时间线交互（#76）：单击块 = 选中不移动播放头；再点一次 = 取消选中；
 *     双击块/空白 = 定位播放头；单击空白 = 无操作
 *  B. K 停止帧对齐（#77）：暂停后播放头 = 帧量化后的真实停点
 *  C. J/L 传输（#78，用户定稿：无加速档）：按住 L 正放、松开即停（帧对齐）
 *  D. 片段播放（#79）：选中要素播放默认单次（到止点即停）；「↻ 循环」开关与倍率同行；
 *     开循环后回到起点反复播
 *  E. 回归护栏：旧「点块跳播放头」不再发生（I/O 精修回路不再被打断）
 *
 * 视频源：运行时 MediaRecorder 生成 6s 60fps webm（覆盖要素区间，参照既有测试基线）。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SHOT_DIR = 'D:/Application/IE_Improvement_Platform/deliverables/v322';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 220) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
const domLog = [];
const domSnap = (label, data) => { domLog.push({ label, data }); };

(async () => {
  const loginRes = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const loginJson = await loginRes.json();
  const token = loginJson.accessToken;
  const refreshToken = loginJson.refreshToken;
  ok('登录成功', !!token);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  page.on('dialog', async (d) => { await d.dismiss(); });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);

  // ========== 打开 L01-ST01 工作台 ==========
  await page.goto(WEB + '/#/workbench/L01-ST01', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2000);

  /* 注入 6 秒测试视频（canvas 递增计数 + MediaRecorder，60fps） */
  const videoReady = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise((res) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= 12) { res(); return; } /* 12s：须覆盖 L01-ST01 要素区间（坑㉝，太短→片段 seek 钳尾静默 ended） */
        ctx.fillStyle = '#123';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff';
        ctx.font = '80px monospace';
        ctx.fillText(t.toFixed(2) + 's', 200, 190);
        requestAnimationFrame(draw);
      };
      draw();
    });
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const file = new File([blob], 'v322-test.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = Array.from(document.querySelectorAll('input[type="file"]'))[0];
    if (!input) return { ok: false, why: 'no file input' };
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  });
  ok('测试视频注入成功', videoReady.ok !== false, JSON.stringify(videoReady));
  /* 等 video 元素出现并元数据就绪 */
  await page.waitForFunction(() => {
    const v = document.querySelector('.wb-screen video');
    return v && v.readyState >= 1;
  }, { timeout: 30000 }).catch(() => {});
  await sleep(800);

  /* 建草稿：3 个要素（0.5~1.5s / 2~3s / 4~5s），为时间线交互提供块 */
  const hasDraft = await page.evaluate(() => document.querySelectorAll('.tl-lane .block').length);
  if (hasDraft === 0) {
    for (const ms of [500, 2000, 4000]) {
      await page.evaluate((startMs) => {
        const lane = document.querySelector('.tl-lane');
        const rect = lane.getBoundingClientRect();
        const ev = new MouseEvent('dblclick', { bubbles: true, clientX: rect.left + startMs / 1000 * 60, clientY: rect.top + 10 });
        lane.dispatchEvent(ev);
      }, ms);
      await sleep(150);
      /* 快捷键 N 新增要素 */
      await page.keyboard.press('n');
      await sleep(250);
      /* 设起点/止点：选中后 I=当前播放头, 用 , . [ ] 太慢——直接落 I/O 需要 playhead 在位。
         简化：靠 dblclick 定位后 N 新增(默认 dur=1s)，符合 0.5/2/4s 起点意图。 */
      await page.keyboard.press('Escape');
      await sleep(150);
    }
  }
  const draftCount = await page.evaluate(() => document.querySelectorAll('.tl-lane .block').length);
  ok('草稿要素就绪（≥3 块）', draftCount >= 3, draftCount);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v322-01-workbench.png') });

  // ========== A. 单击/双击语义（#76） ==========
  const laneBox = await (await page.$('.tl-lane')).boundingBox();
  const pxOf = (ms) => laneBox.x + (ms / 1000) * 60; /* PX_PER_SEC=60（src/constants.ts） */
  /* 显式 clickCount 递进才能让 Chromium 产生原生 dblclick（mouse.click({clickCount:2}) 只出
     单次 click detail=1，React onDoubleClick 收不到——坑㊷，v322 实测） */
  const dblClick = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
  };
  /* 找第一块的几何中心 */
  const blockInfo = await page.evaluate(() => {
    const b = document.querySelector('.tl-lane .block');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, width: r.width };
  });

  /* A1: 双击时间线 3.0s 处 → 播放头应到 ~3.0s */
  await page.mouse.click(pxOf(3000), laneBox.y + laneBox.height / 2, { clickCount: 1 }); /* 先单击（应无操作） */
  await sleep(200);
  let ph1 = await page.evaluate(() => Number((document.querySelector('.wb-tp-time b') || {}).textContent?.replace(/:/g, '')) );
  const phBeforeDbl = await page.evaluate(() => document.querySelector('.wb-tp-time b')?.textContent);
  await dblClick(pxOf(3000), laneBox.y + laneBox.height / 2);
  await sleep(300);
  const phAfterDbl = await page.evaluate(() => document.querySelector('.wb-tp-time b')?.textContent);
  ok('A1 双击空白道定位播放头（3s 附近）', /00:0[23]\./.test(phAfterDbl || ''), phAfterDbl);

  /* A2: 单击块 = 选中，但播放头不动 */
  const phBeforeBlockClick = await page.evaluate(() => document.querySelector('.wb-tp-time b')?.textContent);
  await page.mouse.click(blockInfo.x, blockInfo.y);
  await sleep(250);
  const afterBlockClick = await page.evaluate(() => ({
    sel: !!document.querySelector('.wb-panel-sel'),
    ph: document.querySelector('.wb-tp-time b')?.textContent,
    inspHead: document.querySelector('.wb-insp-head')?.textContent || '',
  }));
  ok('A2 单击块选中（检查器出现）', afterBlockClick.sel, afterBlockClick.inspHead);
  ok('A3 单击块不移动播放头', afterBlockClick.ph === phBeforeBlockClick, `${phBeforeBlockClick} → ${afterBlockClick.ph}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v322-02-click-select.png') });

  /* A4: 再点一次选中块 = 取消选中 */
  await page.mouse.click(blockInfo.x, blockInfo.y);
  await sleep(250);
  const afterToggle = await page.evaluate(() => !!document.querySelector('.wb-panel-sel'));
  ok('A4 再点一次取消选中', !afterToggle);

  /* A5: 双击块 = 定位播放头（不再触发分割） */
  const blocksBefore = await page.evaluate(() => document.querySelectorAll('.tl-lane .block').length);
  await dblClick(blockInfo.x, blockInfo.y);
  await sleep(300);
  const blocksAfter = await page.evaluate(() => document.querySelectorAll('.tl-lane .block').length);
  ok('A5 双击块 = 定位而非分割（块数不变）', blocksAfter === blocksBefore, `${blocksBefore}→${blocksAfter}`);

  // ========== B. K 停止帧对齐（#77） ==========
  await page.keyboard.press(' '); /* 播放 */
  await sleep(900);
  await page.keyboard.press('k'); /* K 停止 */
  await sleep(300);
  const kState = await page.evaluate(() => {
    const v = document.querySelector('.wb-screen video');
    return { videoTime: v.currentTime, paused: v.paused, ph: document.querySelector('.wb-tp-time b')?.textContent };
  });
  ok('B1 K 后视频确已暂停', kState.paused);
  /* 播放头与 video.currentTime 差应在 1 帧内（30fps≈33ms） */
  const [mm, ss] = (kState.ph || '00:00.000').split(':');
  const phMs = (Number(mm) * 60 + Number(ss)) * 1000;
  const drift = Math.abs(phMs - kState.videoTime * 1000);
  ok('B2 K 停止后播放头与视频停点差 ≤ 1 帧（33ms）', drift <= 34, `drift=${drift.toFixed(1)}ms ph=${kState.ph} video=${kState.videoTime.toFixed(3)}s`);

  // ========== C. 按住 L 松开即停（#78，无加速档） ==========
  await page.keyboard.down('l');
  await sleep(700);
  const duringL = await page.evaluate(() => {
    const v = document.querySelector('.wb-screen video');
    return { paused: v.paused, rate: v.playbackRate };
  });
  ok('C1 按住 L 期间在播且速率=1×（无加速档）', !duringL.paused && duringL.rate === 1, `rate=${duringL.rate}`);
  await page.keyboard.up('l');
  await sleep(300);
  const afterL = await page.evaluate(() => {
    const v = document.querySelector('.wb-screen video');
    return { paused: v.paused, videoTime: v.currentTime, ph: document.querySelector('.wb-tp-time b')?.textContent };
  });
  ok('C2 松开 L 立即暂停', afterL.paused);
  const [mm2, ss2] = (afterL.ph || '00:00.000').split(':');
  const phMs2 = (Number(mm2) * 60 + Number(ss2)) * 1000;
  const drift2 = Math.abs(phMs2 - afterL.videoTime * 1000);
  ok('C3 松开 L 后播放头帧对齐（≤1 帧）', drift2 <= 34, `drift=${drift2.toFixed(1)}ms`);

  // ========== D. 片段单次 + 循环开关（#79） ==========
  /* 选中第一块（单击）→ 空格 → 应播到止点自动停（单次） */
  await page.mouse.click(blockInfo.x, blockInfo.y);
  await sleep(200);
  const loopBtn = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.wb-tp-speed button')).find((x) => /循环/.test(x.textContent));
    return { exists: !!b, text: b?.textContent, inSpeedRow: b ? !!b.closest('.wb-tp-speed') : false };
  });
  ok('D1 「↻ 循环」开关存在且在倍率行', loopBtn.exists && loopBtn.inSpeedRow, loopBtn.text);
  ok('D2 默认循环=关（单次）', /关/.test(loopBtn.text || ''), loopBtn.text);

  await page.keyboard.press(' '); /* 片段播放 */
  await sleep(400);
  const segPlaying = await page.evaluate(() => {
    const v = document.querySelector('.wb-screen video');
    return { paused: v.paused, chip: document.querySelector('.wb-seg-chip')?.textContent || '' };
  });
  ok('D3 片段播放中（浮标显示单次）', !segPlaying.paused && /单次/.test(segPlaying.chip), segPlaying.chip);
  /* 等待播完（要素约 1s + 预卷 0.4s；给 4s 余量） */
  await sleep(4000);
  const segDone = await page.evaluate(() => {
    const v = document.querySelector('.wb-screen video');
    return { paused: v.paused };
  });
  ok('D4 单次模式播到止点自动停', segDone.paused);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v322-03-seg-once.png') });

  /* 开循环 → 空格 → 应持续在播（>1.2 个片段周期后仍未停） */
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.wb-tp-speed button')).find((x) => /循环/.test(x.textContent));
    b.click();
  });
  await sleep(200);
  await page.keyboard.press(' ');
  await sleep(3500);
  const loopPlaying = await page.evaluate(() => {
    const v = document.querySelector('.wb-screen video');
    return { paused: v.paused, chip: document.querySelector('.wb-seg-chip')?.textContent || '' };
  });
  ok('D5 循环模式播过止点仍在播', !loopPlaying.paused && /循环/.test(loopPlaying.chip), loopPlaying.chip);
  /* 关循环复位 */
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.wb-tp-speed button')).find((x) => /循环/.test(x.textContent));
    if (b && /开/.test(b.textContent)) b.click();
  });

  domSnap('v322-summary', { draftCount, loopBtn });
  await page.screenshot({ path: path.join(SHOT_DIR, 'v322-04-final.png') });

  /* JS 异常守门 */
  ok('全程无 JS 异常', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  fs.writeFileSync(path.join(SHOT_DIR, 'dom-sidecar.json'), JSON.stringify(domLog, null, 2));
  console.log(`\n==== v322 UI 测试：${pass} passed, ${fail} failed ====`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
