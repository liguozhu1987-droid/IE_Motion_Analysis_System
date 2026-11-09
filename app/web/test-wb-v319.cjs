/**
 * v3.19 分解工作台四项优化专项验证（用户反馈）：
 *  ① 收起检查器后常驻展开入口（折叠态悬浮按钮，两态各只有一个可见入口）
 *  ② 动作要素下拉一级/二级分组去重：无二级的分组不渲染分组头（消除"两个拿取、有一个选不了"）；
 *     有二级的分组头 + 缩进二级选项
 *  ③ 版本区治理：只列有效版本（空壳版本不平铺）、顶栏有效版本计数、
 *     开始复测确认框带要素数（空版本护栏的后端部分由 smoke 覆盖）
 *  ④ 片段循环取消：再点一次块 / 点时间线空白 / Esc / 「↻ 循环中·取消」按钮 / 视频浮标点击
 *     帧级精修：, . [ ] Trim 键（Shift=10 帧）改起/止点；J/K/L 穿梭（含倒退）
 * 播放相关用例用 MediaRecorder 现场录 4s webm 注入文件输入框（无现成视频资产）。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 160) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取时间线条头部选中信息（#seq desc · start→end ms） */
async function panelSel(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.wb-panel-sel');
    return el ? el.textContent.replace('↻ 循环中 · 取消', '').trim() : null;
  });
}

/** 现场录制 10s webm 并注入文件输入框（须覆盖要素区间 0~8.5s，否则 seek 越界钳到末尾 play 静默结束） */
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
      const file = new File([blob], 'v319-sample.webm', { type: 'video/webm' });
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

(async () => {
  const login = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const { refreshToken } = await login.json();
  const token = (await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json()).accessToken;

  let sid = null;
  for (const line of await (await fetch(API + '/lines', { headers: { Authorization: 'Bearer ' + token } })).json()) {
    for (const st of await (await fetch(API + '/stations?lineId=' + line.line_id, { headers: { Authorization: 'Bearer ' + token } })).json()) {
      const els = await (await fetch(API + '/stations/' + st.station_id + '/elements', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (Array.isArray(els.elements) && els.elements.length > 0) { sid = st.station_id; break; }
    }
    if (sid) break;
  }
  ok('定位有要素的工位 ' + sid, !!sid);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  // 确认框拦截（开始复测）：记录文案后一律取消，不真正改数据
  let dialogText = '';
  page.on('dialog', async (d) => { dialogText = d.message(); await d.dismiss(); });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);
  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(600);

  // ========== ② 动作要素下拉一级/二级分组 ==========
  await (await page.$('.wb-tl .block')).click(); // 先选中要素，检查器才显示类型下拉
  await page.waitForSelector('.wb-tsel-btn', { timeout: 10000 });
  await sleep(300);
  await page.click('.wb-tsel-btn');
  await sleep(350);
  const dd = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('.wb-tsel-h')).map((h) => h.textContent.trim());
    const opts = Array.from(document.querySelectorAll('.wb-tsel-o'));
    const labels = opts.map((o) => o.textContent.trim());
    const subs = Array.from(document.querySelectorAll('.wb-tsel-o.sub')).map((o) => o.textContent.trim());
    const counts = {};
    for (const l of labels) counts[l] = (counts[l] || 0) + 1;
    return { headers, labels, subs, dupLabels: Object.entries(counts).filter(([, c]) => c > 1).map(([l]) => l) };
  });
  await page.keyboard.press('Escape');
  await sleep(200);
  const LEVEL1_ONLY = ['拿取', '放置', '清洁', '扫描', '翻转', '拆', '转身', '弯腰', '等待', '机器自动'];
  ok('无二级的一级（拿取/放置…）不再出现同名分组头', LEVEL1_ONLY.every((t) => !dd.headers.includes(t)));
  ok('「拿取」在下拉中只出现一次', dd.labels.filter((l) => l === '拿取').length === 1);
  ok('无任何重复标签选项', dd.dupLabels.length === 0, dd.dupLabels.join(','));
  ok('有二级的分组保留分组头（移动/装配/操作/检查）', ['移动', '装配', '操作', '检查'].every((h) => dd.headers.includes(h)));
  ok('二级选项带缩进标记（└）', dd.subs.includes('走动') && dd.subs.includes('按') && dd.subs.length >= 10, dd.subs.join(','));

  // ========== ① 收起检查器 → 常驻展开入口 ==========
  await page.click('.wb-insp-toggle-btn');
  await sleep(300);
  const collapsed = await page.evaluate(() => ({
    inspHidden: getComputedStyle(document.querySelector('.wb-inspector')).display === 'none',
    showBtn: !!document.querySelector('.wb-insp-show'),
    showBtnText: (document.querySelector('.wb-insp-show') || {}).textContent || '',
    stageWide: !!document.querySelector('.wb-main.inspector-collapsed'),
  }));
  ok('收起后面板隐藏（视频全宽）', collapsed.inspHidden && collapsed.stageWide);
  ok('折叠态出现常驻悬浮展开按钮「◀ 显示检查器」', collapsed.showBtn && collapsed.showBtnText.includes('显示检查器'));
  await page.click('.wb-insp-show');
  await sleep(300);
  const reexpanded = await page.evaluate(() => ({
    inspVisible: getComputedStyle(document.querySelector('.wb-inspector')).display !== 'none',
    showBtnGone: !document.querySelector('.wb-insp-show'),
    toggleBtnBack: !!document.querySelector('.wb-insp-toggle-btn'),
  }));
  ok('点击悬浮按钮后面板恢复', reexpanded.inspVisible && reexpanded.toggleBtnBack);
  ok('两态各只有一个入口（恢复后悬浮按钮消失）', reexpanded.showBtnGone);

  // ========== ③ 版本区治理 ==========
  // 先取消选中进入 idle 态看版本区
  await page.keyboard.press('Escape');
  await sleep(250);
  const verSec = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('.wb-insp-idle .wb-sec'));
    const vsec = secs.find((s) => (s.querySelector('.wb-sec-t') || {}).textContent?.includes('版本'));
    const rows = vsec ? Array.from(vsec.querySelectorAll('.wb-ver')).map((r) => r.textContent.trim()) : [];
    return { rows, meta: (document.querySelector('.wb-meta') || {}).textContent || '' };
  });
  ok('idle 版本区只列有效版本（本例 1 行，不再 45 行平铺）', verSec.rows.length === 1, verSec.rows.join(' | '));
  ok('版本行含 CT/要素数信息', /要素/.test(verSec.rows[0] || ''));
  ok('顶栏显示有效版本口径（首个版本，不再"45 版本"）', /首个版本/.test(verSec.meta), verSec.meta.replace(/\s+/g, ' ').slice(0, 80));

  // 开始复测确认框带当前版本要素数（dialog 已拦截为取消）
  await page.click('.wb-more summary'); // 展开「版本」菜单
  await sleep(250);
  const retestTitle = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.wb-more-menu button'));
    const b = btns.find((x) => x.textContent.includes('开始复测'));
    return b ? b.title : '';
  });
  ok('版本菜单「开始复测」按钮带要素数上下文 title', /封存/.test(retestTitle), retestTitle);
  dialogText = '';
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.wb-more-menu button'));
    btns.find((x) => x.textContent.includes('开始复测'))?.click();
  });
  await sleep(400);
  ok('开始复测确认框明示当前版本要素数', /要素/.test(dialogText) && /封存/.test(dialogText), dialogText.slice(0, 90));
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.body.click());
  await sleep(200);

  // ========== ④ 片段循环取消（toggle / 空白 / Esc / 按钮） ==========
  const firstBlock = async () => (await page.$('.wb-tl .block')); // 实时重查：长流程后旧句柄会 detached
  await (await firstBlock()).click();
  await sleep(350);
  const sel1 = await page.evaluate(() => !!document.querySelector('.wb-panel-sel') && !!document.querySelector('.wb-inspector .wb-insp-head'));
  ok('点块选中要素', sel1);
  const playTitle1 = await page.evaluate(() => (document.querySelector('.wb-play') || {}).title || '');
  ok('播放按钮提示片段（v3.22 默认单次语义）', /片段/.test(playTitle1), playTitle1);
  const segCancelVisible = await page.evaluate(() => {
    const b = document.querySelector('.wb-seg-cancel');
    return !!b && b.offsetParent !== null;
  });
  ok('单次模式下不显示「循环中 · 取消」（v3.22 循环开启才出现）', !segCancelVisible);

  // 方式一：再点一次同一块 = 取消
  await (await firstBlock()).click();
  await sleep(300);
  const off1 = await page.evaluate(() => !document.querySelector('.wb-panel-sel') && !!document.querySelector('.wb-insp-idle'));
  ok('再点一次已选中块 = 取消片段循环', off1);

  // 方式二（v3.19 迭代决策）：点时间线空白 = 只定位播放头，选中/循环**不**取消——
  // 曾做成"点空白=取消"，但它打断 I/O 精修回路（定位后按 I/O 时选中已丢，v317 回归实证），故回滚
  await (await firstBlock()).click();
  await sleep(300);
  await page.evaluate(() => {
    const lane = document.querySelector('.tl-lane');
    const r = lane.getBoundingClientRect();
    lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.right - 6, clientY: r.top + r.height / 2 }));
  });
  await sleep(300);
  const keepSel = await page.evaluate(() => !!document.querySelector('.wb-panel-sel'));
  ok('点时间线空白 = 只定位播放头，选中不丢失（保护 I/O 精修回路）', keepSel);

  // 方式三：Esc
  await (await firstBlock()).click();
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(300);
  const off3 = await page.evaluate(() => !document.querySelector('.wb-panel-sel'));
  ok('Esc = 取消选中', off3);

  // 方式四（v3.22）：循环开关开启 → 「循环中 · 取消」按钮出现 → 点击 = 取消选中；随后关回单次
  await (await firstBlock()).click();
  await sleep(300);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.wb-tp-speed button')).find((x) => /循环/.test(x.textContent))?.click();
  });
  await sleep(250);
  const cancelShown = await page.evaluate(() => {
    const b = document.querySelector('.wb-seg-cancel');
    return !!b && b.offsetParent !== null;
  });
  await page.evaluate(() => document.querySelector('.wb-seg-cancel')?.click());
  await sleep(300);
  const off4 = await page.evaluate(() => !document.querySelector('.wb-panel-sel'));
  ok('循环开启后「循环中 · 取消」出现，点击 = 取消片段循环', cancelShown && off4);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.wb-tp-speed button')).find((x) => /循环/.test(x.textContent))?.click(); /* 关回单次，还原默认态 */
  });
  await sleep(200);

  // ========== ④ 帧级精修：, . [ ] Trim 键 ==========
  await (await firstBlock()).click();
  await sleep(300);
  await page.evaluate(() => document.body.focus());
  const before = await panelSel(page);
  await page.keyboard.press('Comma');
  await sleep(250);
  const afterMinus = await panelSel(page);
  await page.keyboard.press('Period');
  await sleep(250);
  const afterPlus = await panelSel(page);
  ok('`,` 起点 −1 帧（约 33ms）', !!before && !!afterMinus && afterMinus !== before, `${before} → ${afterMinus}`);
  ok('`.` 起点 +1 帧（回到原位）', !!afterPlus && afterPlus === before, `${afterMinus} → ${afterPlus}`);
  await page.keyboard.press('BracketRight');
  await sleep(250);
  const afterEnd = await panelSel(page);
  await page.keyboard.press('BracketLeft');
  await sleep(250);
  const afterEndBack = await panelSel(page);
  ok('`]` 止点 +1 帧（时长变长）', !!afterEnd && afterEnd !== afterPlus, `${afterPlus} → ${afterEnd}`);
  ok('`[` 止点 −1 帧（时长还原）', !!afterEndBack && afterEndBack === afterPlus, `${afterEnd} → ${afterEndBack}`);
  // Shift = 10 帧（美式键盘 Shift+, = '<'，handler 两侧都认）
  await page.keyboard.down('Shift');
  await page.keyboard.press('Comma');
  await page.keyboard.up('Shift');
  await sleep(250);
  const afterShift = await panelSel(page);
  const ms = (s) => Number(/(\d+)→(\d+)ms/.exec(s || '')?.[1] ?? NaN);
  const startDelta = Math.abs(ms(afterShift) - ms(before));
  ok('Shift+, 起点 −10 帧（约 333ms，误差 <60ms）', startDelta > 250 && startDelta < 420, `Δ=${startDelta}ms`);
  // 还原起点
  await page.keyboard.down('Shift');
  await page.keyboard.press('Period');
  await page.keyboard.up('Shift');
  await sleep(250);
  ok('Shift+. 起点 +10 帧还原', ms(await panelSel(page)) === ms(before), `${ms(await panelSel(page))} vs ${ms(before)}`);

  // ========== ④ J/K/L 穿梭（注入 webm 后） ==========
  const injected = await injectVideo(page);
  ok('MediaRecorder 现场录制 webm 注入文件框', injected);
  await page.waitForSelector('video', { timeout: 8000 });
  await sleep(1200); // 等 metadata + 帧率采样
  await page.evaluate(() => document.body.focus());
  // 探针：确认按键到达 window 且焦点不在输入框
  await page.evaluate(() => { window.__probe = []; window.addEventListener('keydown', (e) => window.__probe.push(e.key + '/' + (e.target || {}).tagName)); });
  await page.keyboard.press('KeyL');
  await sleep(500);
  const afterL = await page.evaluate(() => ({ probe: (window.__probe || []).slice(-2), focus: document.activeElement?.tagName, rate: document.querySelector('video')?.playbackRate, paused: document.querySelector('video')?.paused }));
  /* v3.22 按住式：点按(down+up 立即) → keyup 即停；断言改为按住 500ms 期间在播 */
  await page.keyboard.down('KeyL');
  await sleep(500);
  const duringL = await page.evaluate(() => ({ rate: document.querySelector('video')?.playbackRate, paused: document.querySelector('video')?.paused }));
  ok('按住 L = 正放 1×（按住式，无加速档）', duringL.rate === 1 && duringL.paused === false, JSON.stringify({ afterL, duringL }));
  await page.keyboard.up('KeyL');
  await sleep(300);
  const afterLUp = await page.evaluate(() => document.querySelector('video')?.paused);
  ok('松开 L = 立即暂停', afterLUp === true);
  /* v3.25：J = 按帧回退倒放（定时器步进，与 L 对称）——按住 500ms 期望回退多帧（30fps 下 ~15 帧 ≈ 0.5s），
     且重按逐步递减（倒放连续性），Shift+J = 一步 10 帧（约 333ms @30fps） */
  await page.keyboard.press('End'); /* 先到片尾，保证回退有余量 */
  await sleep(300);
  const beforeJ = await page.evaluate(() => document.querySelector('video')?.currentTime);
  await page.keyboard.down('KeyJ');
  await sleep(500);
  const duringJ = await page.evaluate(() => ({ t: document.querySelector('video')?.currentTime, paused: document.querySelector('video')?.paused }));
  await page.keyboard.up('KeyJ');
  await sleep(300);
  const afterJ = duringJ.t;
  ok('按住 J = 按帧回退（退幅 >5 帧且 <1s，暂停态倒放）',
    typeof afterJ === 'number' && duringJ.paused === true && beforeJ - afterJ > 5 * 0.02 && beforeJ - afterJ < 1.0,
    `${Number(beforeJ).toFixed(2)} → ${Number(afterJ).toFixed(2)}`);
  const beforeShiftJ = await page.evaluate(() => document.querySelector('video')?.currentTime);
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyJ');
  await page.keyboard.up('Shift');
  await sleep(300);
  const afterShiftJ = await page.evaluate(() => document.querySelector('video')?.currentTime);
  ok('Shift+J = 一步退 10 帧（约 333ms @30fps）', beforeShiftJ - afterShiftJ > 0.25 && beforeShiftJ - afterShiftJ < 0.42, `Δ=${(beforeShiftJ - afterShiftJ).toFixed(3)}s`);
  await page.keyboard.down('KeyL');
  await sleep(400);
  const afterL3 = await page.evaluate(() => ({ rate: document.querySelector('video')?.playbackRate, paused: document.querySelector('video')?.paused }));
  ok('J 倒放后按住 L = 重新前进播放（按住式）', afterL3.rate === 1 && afterL3.paused === false, JSON.stringify(afterL3));
  await page.keyboard.up('KeyL');
  await sleep(300);
  await page.keyboard.press('KeyK');
  await sleep(300);
  const afterK = await page.evaluate(() => document.querySelector('video')?.paused);
  ok('K = 暂停', afterK === true);
  await page.keyboard.press('Space');
  await sleep(400);
  const afterSpace = await page.evaluate(() => ({ rate: document.querySelector('video')?.playbackRate, paused: document.querySelector('video')?.paused }));
  ok('Space = 正向播放', afterSpace.rate === 1 && afterSpace.paused === false, JSON.stringify(afterSpace));
  await page.keyboard.press('KeyK');
  await sleep(200);

  // 片段循环 + 视频浮标点击取消
  await page.keyboard.press('Escape'); // 先取消遗留选中（否则再点同一块 = 取消而非选中）
  await sleep(200);
  await page.evaluate(() => { document.querySelector('video')?.pause(); });
  await (await firstBlock()).click();
  await sleep(300);
  const selRange = await panelSel(page); // 读取选中要素实际区间，断言按它来
  await page.keyboard.press('Home'); /* v3.22 单次语义：归零后空格 → 从预卷起点播，900ms 时必在区间内 */
  await sleep(250);
  await page.keyboard.press('Space');
  await sleep(900);
  const segPlay = await page.evaluate(() => {
    const v = document.querySelector('video');
    const chip = document.querySelector('.wb-seg-chip');
    return { playing: v && !v.paused, t: v ? v.currentTime : -1, chipText: chip ? chip.textContent.trim() : '' };
  });
  const m = /(\d+)→(\d+)ms/.exec(selRange || '');
  const lo = m ? Number(m[1]) / 1000 - 0.6 : -1;
  const hi = m ? Number(m[2]) / 1000 + 0.6 : 1e9;
  ok('选中要素播放 = 片段模式（播放中且进度在片段区间内）', segPlay.playing && segPlay.t >= lo && segPlay.t <= hi, `${JSON.stringify(segPlay)} range=[${lo},${hi}]`);
  ok('视频上显示片段浮标（单次/循环）', /循环|单次/.test(segPlay.chipText), segPlay.chipText);
  await page.evaluate(() => document.querySelector('.wb-seg-chip')?.click());
  await sleep(300);
  const chipOff = await page.evaluate(() => !document.querySelector('.wb-panel-sel'));
  ok('点击视频循环浮标 = 取消片段循环', chipOff);

  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
