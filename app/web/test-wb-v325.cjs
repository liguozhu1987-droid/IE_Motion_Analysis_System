/**
 * v3.25 专项验证（用户反馈两批）：
 *  A. JKL 穿梭三键定稿：
 *   A1. L 连续正放：选中要素 → 播到片段止点停 → 按 L 从当前进度继续播放过止点（修复「超过一定进度无法继续播放」）
 *   A2. J 按住 = 按帧回退倒放（受倍率控制）；Shift+J = 后退 10 帧；触底钳 0
 *   A3. K 暂停、按住 L 正放语义保持
 *  B. 集团看板层级配置化：
 *   B1. 大区显示 CMC factories.region（China，非硬编码"华东"）
 *   B2. 树头「大区」字样、无硬编码区域残留
 *   B3. 公司筛选传公司名可命中
 * 播放相关用例用 MediaRecorder 现场录 10s webm 注入文件输入框。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 200) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function panelSel(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.wb-panel-sel');
    return el ? el.textContent.replace('↻ 循环中 · 取消', '').trim() : null;
  });
}

/** 现场录制 10s webm 并注入文件输入框（覆盖要素区间 0~8.5s，太短 seek 越界钳尾 play() 静默 ended） */
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
      const file = new File([blob], 'v325-sample.webm', { type: 'video/webm' });
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
  const loginRes = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const loginBody = await loginRes.json();
  const token = loginBody.accessToken;
  const refreshToken = loginBody.refreshToken;

  let sid = null;
  for (const line of await (await fetch(API + '/lines', { headers: { Authorization: 'Bearer ' + token } })).json()) {
    for (const st of await (await fetch(API + '/stations?lineId=' + line.line_id, { headers: { Authorization: 'Bearer ' + token } })).json()) {
      const els = await (await fetch(API + '/stations/' + st.station_id + '/elements', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (Array.isArray(els.elements) && els.elements.length > 0) { sid = st.station_id; break; }
    }
    if (sid) break;
  }
  ok('定位有要素的工位 ' + sid, !!sid);
  if (!sid) { console.log('无可用工位，终止'); process.exit(1); }

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);

  // ========== B. 集团看板层级配置化 ==========
  console.log('== B. 集团看板层级配置化 ==');
  await page.goto(WEB + '/#/dashboard', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('h1', { timeout: 20000 });
  await sleep(1500);
  const treeInfo = await page.evaluate(() => {
    const h1 = (document.querySelector('h1') || {}).textContent || '';
    const allText = document.body.textContent || '';
    const heads = Array.from(document.querySelectorAll('th')).map((x) => x.textContent.trim());
    const rows = Array.from(document.querySelectorAll('tr')).slice(0, 10).map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    return { h1, allText, heads, rows };
  });
  ok('看板 h1 = 集团看板', /集团看板/.test(treeInfo.h1), treeInfo.h1);
  ok('列头含「大区」字样', /大区/.test(treeInfo.heads.join('|')), treeInfo.heads.join('|'));
  ok('大区值显示 China（CMC 派生，非硬编码华东）', /China/.test(treeInfo.allText), (treeInfo.allText.match(/China/g) || []).length + ' 处');
  ok('页面无硬编码「华东」残留', !/华东/.test(treeInfo.allText), (treeInfo.allText.match(/华东/g) || []).length + ' 处');
  ok('页面无硬编码「华北」残留', !/华北/.test(treeInfo.allText));
  ok('页面无硬编码「华南」残留', !/华南/.test(treeInfo.allText));
  ok('页面无硬编码「测试区」残留', !/测试区/.test(treeInfo.allText));

  // B3. 公司筛选传公司名可命中（API 层验证，浏览器 token 不在 localStorage 明文，直接用 Node 侧 token）
  // 公司名数据自适应：不硬编码 Shanghai——种子态公司名随租户/CMC 派生变化
  // （v3.27 实锤：曾依赖 PA10 演示工位隐式提供的 Shanghai 公司，清理后断言失去数据基础），
  // 改为取全量响应里第一个有数据的公司名再筛选，语义不变（传公司名→只回该公司）。
  const fullBody = await (await fetch(API + '/dashboard/summary', { headers: { Authorization: 'Bearer ' + token } })).json();
  const companies = Array.isArray(fullBody.by_company) ? fullBody.by_company : [];
  ok('by_company 非空（有种子公司可筛）', companies.length > 0, JSON.stringify(companies.map((c) => c.company)));
  const pick = companies.find((c) => c.station_count > 0) ?? companies[0];
  const companyKeys = pick;
  ok('by_company 元素含 company/region 字段且无 tenant_id', !!companyKeys && 'company' in companyKeys && 'region' in companyKeys && !('tenant_id' in companyKeys), JSON.stringify(companyKeys ? Object.keys(companyKeys) : null));
  if (pick) {
    const filterRes = await fetch(API + '/dashboard/summary?company=' + encodeURIComponent(pick.company), {
      headers: { Authorization: 'Bearer ' + token },
    });
    const filterBody = await filterRes.json();
    ok('公司筛选传公司名 ' + pick.company + ' 可命中', filterRes.status === 200 && filterBody.kpis && filterBody.kpis.line_count >= 1
      && filterBody.lines.every((l) => l.company === pick.company), JSON.stringify(filterBody.kpis || filterRes.status));
  }

  // ========== A. JKL 穿梭三键 ==========
  console.log('== A. JKL 穿梭三键（v3.25 定稿） ==');
  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(600);

  // --- A1. L 连续正放（核心修复：播到止点停后按 L 继续播过止点） ---
  const injected = await injectVideo(page);
  ok('MediaRecorder 现场录制 webm 注入文件框', injected);
  await page.waitForSelector('video', { timeout: 8000 });
  await sleep(1500); // 等 metadata + 帧率采样
  await page.evaluate(() => document.body.focus());

  await (await page.$('.wb-tl .block')).click();
  await sleep(350);
  const selInfo = await panelSel(page);
  ok('选中要素显示区间', !!selInfo && /ms/.test(selInfo), selInfo);
  await page.keyboard.press('Home');
  await sleep(250);
  // 选中要素 + 空格 = 片段模式（单次）：预卷起播 → 止点+2帧停
  await page.keyboard.press('Space');
  await sleep(3500);
  const segStopped = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { paused: v ? v.paused : null, t: v ? v.currentTime : -1 };
  });
  ok('片段模式播到止点自动停（单次）', segStopped.paused === true, JSON.stringify(segStopped));
  const tAtStop = segStopped.t;
  // 按 L：从当前进度继续播放过止点（v3.25：L 清 segEndRef 哨兵，不回卷）
  await page.keyboard.down('KeyL');
  await sleep(800);
  const duringL1 = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { paused: v.paused, t: v.currentTime, rate: v.playbackRate };
  });
  await page.keyboard.up('KeyL');
  ok('按 L = 从止点继续正放（未回卷，播放中）',
    duringL1.paused === false && duringL1.t > tAtStop,
    `停点 ${tAtStop.toFixed(2)}s → 按 L 后 ${duringL1.t.toFixed(2)}s`);
  // 再按住 L 越过止点 1s 后仍在播（连续正放到片尾；10s 测试视频可能在 9.95s 处自然 ended，属正常播放到底）
  await page.keyboard.down('KeyL');
  await sleep(1200);
  const later = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { paused: v.paused, t: v.currentTime, ended: v.ended };
  });
  await page.keyboard.up('KeyL');
  ok('播放越过原止点（L 连续正放，不被片段止点拦截；到片尾自然 ended 亦算）',
    later.t > tAtStop + 0.8 && (later.paused === false || later.ended === true || later.t >= 9.9),
    `t=${later.t.toFixed(2)}s vs 原止点 ${tAtStop.toFixed(2)}s paused=${later.paused} ended=${later.ended}`);
  await page.keyboard.press('KeyK'); // 暂停
  await sleep(200);

  // --- A2. J 按帧回退 ---
  await page.keyboard.press('End');
  await sleep(300);
  const beforeJ = await page.evaluate(() => document.querySelector('video')?.currentTime);
  await page.keyboard.down('KeyJ');
  await sleep(500);
  const duringJ = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { t: v ? v.currentTime : -1, paused: v ? v.paused : null };
  });
  await page.keyboard.up('KeyJ');
  await sleep(300);
  ok('按住 J 500ms = 按帧回退（退幅 >5 帧且 <1s，暂停态倒放）',
    beforeJ - duringJ.t > 5 * 0.02 && beforeJ - duringJ.t < 1.0 && duringJ.paused === true,
    `${beforeJ.toFixed(2)} → ${duringJ.t.toFixed(2)}`);
  // Shift+J = 后退 10 帧
  const beforeShiftJ = await page.evaluate(() => document.querySelector('video')?.currentTime);
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyJ');
  await page.keyboard.up('Shift');
  await sleep(300);
  const afterShiftJ = await page.evaluate(() => document.querySelector('video')?.currentTime);
  ok('Shift+J = 一步退 10 帧（约 333ms @30fps）',
    beforeShiftJ - afterShiftJ > 0.25 && beforeShiftJ - afterShiftJ < 0.42,
    `Δ=${(beforeShiftJ - afterShiftJ).toFixed(3)}s`);
  // 触底钳 0
  await page.keyboard.press('Home');
  await sleep(250);
  await page.keyboard.down('KeyJ');
  await sleep(400);
  const atZero = await page.evaluate(() => document.querySelector('video')?.currentTime);
  await page.keyboard.up('KeyJ');
  await sleep(200);
  ok('J 触底钳 0（不产生负时间）', atZero >= 0 && atZero < 0.2, `t=${atZero}`);

  // --- A3. 按住 L 正放语义保持 ---
  await page.keyboard.down('KeyL');
  await sleep(400);
  const duringL2 = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { rate: v ? v.playbackRate : null, paused: v ? v.paused : null };
  });
  await page.keyboard.up('KeyL');
  await sleep(300);
  const afterLUp = await page.evaluate(() => document.querySelector('video')?.paused);
  ok('按住 L = 正放 1×（按住式）', duringL2.rate === 1 && duringL2.paused === false, JSON.stringify(duringL2));
  ok('松开 L = 立即暂停', afterLUp === true);
  const beforeK = await page.evaluate(() => document.querySelector('video')?.currentTime);
  await page.keyboard.press('KeyK');
  await sleep(400);
  const afterK = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { t: v ? v.currentTime : -1, paused: v ? v.paused : null };
  });
  ok('暂停时按 K = 从当前播放头正向播放', afterK.paused === false && afterK.t > beforeK,
    `${beforeK.toFixed(2)} → ${afterK.t.toFixed(2)}`);
  await page.keyboard.press('KeyK');
  await sleep(100);
  ok('播放时按 K = 暂停', await page.evaluate(() => document.querySelector('video')?.paused === true));

  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
