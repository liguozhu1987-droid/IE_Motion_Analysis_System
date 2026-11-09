/**
 * v3.28 IE 专家视角实操实录：在临时工位 L01-ST90 上完整走一遍动作分解流程
 *  载视频 → N 新增 + I/O 定界 + 手别快捷键 + 类型选择 +（结构化）描述 → 校验 → 提交 → 分析结果
 * 记录每步耗时与系统反馈（自动描述、校验结论、分析数字），作为 IE 评估报告的一手材料。
 * 收尾：DELETE /api/stations/L01-ST90（级联删要素/改善，种子数据零影响）。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'v328');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const note = (s) => { log.push(s); console.log('  · ' + s); };
const T = [];

(async () => {
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();
  const auth = { Authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' };

  // 幂等：先删后建
  await fetch(API + '/stations/L01-ST90', { method: 'DELETE', headers: auth });
  const cr = await fetch(API + '/stations', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ station_id: 'L01-ST90', line_id: 'L01', name: 'IE评估·上装配合节拍', tt: 10 }),
  });
  note(`建临时工位 L01-ST90: ${cr.status === 201 || cr.status === 200 ? 'OK' : await cr.text()}`);

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
  await page.goto(WEB + '/#/workbench/L01-ST90', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-drop', { timeout: 20000 });
  await sleep(600);

  // ---- 步骤 1：新片段默认时长 0.6s（快速动作分解的典型设定） ----
  let t0 = Date.now();
  await page.evaluate(() => {
    const wrap = Array.from(document.querySelectorAll('.wb-ab-field')).find((w) => w.querySelector('span')?.textContent === '新片段');
    const inp = wrap?.querySelector('input');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '0.6');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(250);
  note(`[1] 设新片段默认时长 0.6s（快动作分解典型设定）: ${Date.now() - t0}ms`);

  // ---- 步骤 2：载入视频（MediaRecorder 录 8s webm） ----
  t0 = Date.now();
  await page.evaluate(async () => {
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
        if (el < 8000) requestAnimationFrame(draw); else resolve();
      };
      requestAnimationFrame(draw);
    });
    rec.stop();
    await new Promise((r) => { rec.onstop = r; });
    const file = new File([new Blob(chunks, { type: 'video/webm' })], 'ie-walkthrough.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('.wb-top-acts input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, { timeout: 15000 });
  const loadMs = Date.now() - t0;
  note(`[2] 载入 8s 视频并就绪: ${loadMs}ms`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-06-walkthrough-01-loaded.png') });

  // ---- 步骤 3：逐要素分解 ----
  const PLAN = [
    { end: 1.3, hand: '2', type: '伸手', desc: '伸手取料盒' },
    { end: 2.2, hand: null, type: '握取', desc: '握取电容' },
    { end: 3.4, hand: null, type: '移物', desc: '移物至工装位' },
    { end: 4.4, hand: '1', type: '握取', desc: '握取工装盖板' },
    { end: 5.8, hand: '3', type: '定位', desc: '盖板对位' },
    { end: 7.0, hand: '2', type: '检查', desc: '检查引脚平整' },
    { end: 8.0, hand: null, type: '放手', desc: '放手成品入箱' },
  ];
  const dblclickAt = async (x, y) => {
    // 坑㊷：puppeteer 不会自动合成 dblclick——第二次 down 必须显式 clickCount:2
    await page.mouse.move(x, y);
    await page.mouse.down({ clickCount: 1 }); await page.mouse.up();
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up();
  };
  const blur = () => page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });

  for (let i = 0; i < PLAN.length; i += 1) {
    const p = PLAN[i];
    const te = Date.now();
    // 3.1 N 新增（快捷键，设计上的快速路径）
    await page.keyboard.press('KeyN');
    await sleep(180);
    // 3.2 手别（1=左 2=右 3=双；选定后沿用）
    if (p.hand) { await page.keyboard.press('Digit' + p.hand); await sleep(120); }
    // 3.3 双击右手道空白处定位播放头到止点 → O 落止点
    const pt = await page.evaluate(() => {
      const wrap = document.querySelector('.wb-tl');
      if (wrap) wrap.scrollLeft = 0;
      const row = Array.from(document.querySelectorAll('.tl-row')).find((r) => (r.querySelector('.tl-label')?.textContent || '').includes('右手'));
      const lane = row?.querySelector('.tl-lane');
      if (!lane) return null;
      const r = lane.getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2 };
    });
    if (pt) await dblclickAt(pt.x + p.end * 60, pt.y);
    await sleep(220);
    const headMs = await page.evaluate(() => Math.round((document.querySelector('video')?.currentTime ?? 0) * 1000));
    if (Math.abs(headMs - p.end * 1000) > 120) {
      note(`!! #${i + 1} 播放头定位失败：期望 ${(p.end * 1000).toFixed(0)}ms 实测 ${headMs}ms——终止实录，数据不采信`);
      await browser.close();
      process.exit(2);
    }
    await page.keyboard.press('KeyO');
    await sleep(150);
    // 3.4 类型（自绘下拉）
    await page.evaluate(() => { document.querySelector('.wb-tsel-btn')?.click(); });
    await sleep(220);
    const picked = await page.evaluate((t) => {
      const o = Array.from(document.querySelectorAll('.wb-tsel-o')).find((x) => (x.textContent || '').trim() === t);
      if (!o) return false;
      o.click();
      return true;
    }, p.type);
    await sleep(250);
    // 3.5 描述：先读系统自动写入；为空则手填（手改优先）
    const autoDesc = await page.evaluate(() => (document.querySelector('input.wb-desc') || {}).value ?? '');
    let descSrc = 'auto';
    if (!String(autoDesc).trim()) {
      descSrc = 'manual';
      await page.click('input.wb-desc');
      await page.keyboard.type(p.desc);
      await blur();
      await sleep(150);
    } else {
      await blur();
    }
    const done = Date.now() - te;
    note(`[3.${i + 1}] #${i + 1} ${p.type} 止点${(p.end * 1000).toFixed(0)}ms(实测${headMs}) 描述来源=${descSrc}「${autoDesc || p.desc}」 用时${done}ms 选型${picked ? 'OK' : 'FAIL'}`);
    T.push(done);
  }
  const totalDec = T.reduce((a, b) => a + b, 0);
  note(`[3] 7 要素分解总用时 ${totalDec}ms（均值 ${Math.round(totalDec / 7)}ms/要素）`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-07-walkthrough-02-decomposed.png') });

  // ---- 步骤 4：校验 ----
  t0 = Date.now();
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '校验');
    b?.click();
  });
  await page.waitForSelector('.wb-toast-banners .wb-banner', { timeout: 8000 });
  await sleep(400);
  const vres = await page.evaluate(() => {
    const bs = Array.from(document.querySelectorAll('.wb-toast-banners .wb-banner'));
    return bs.map((b) => ({ cls: b.className.replace('wb-banner', '').trim(), text: (b.textContent || '').slice(0, 100) }));
  });
  note(`[4] 校验（${Date.now() - t0}ms）: ${JSON.stringify(vres)}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-08-walkthrough-03-validate.png') });

  // ---- 步骤 5：提交分解 ----
  t0 = Date.now();
  await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '提交分解');
    b?.click();
  });
  await page.waitForFunction(() => {
    const bs = Array.from(document.querySelectorAll('.wb-toast-banners .banner-success'));
    return bs.some((b) => /提交成功/.test(b.textContent || ''));
  }, { timeout: 10000 });
  await sleep(500);
  note(`[5] 提交分解（${Date.now() - t0}ms）: 生成新版本`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-09-walkthrough-04-submitted.png') });

  // ---- 步骤 6：分析结果 ----
  t0 = Date.now();
  await page.goto(WEB + '/#/analysis/L01-ST90', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(1500);
  const ana = await page.evaluate(() => {
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    const pick = (re) => { const m = txt.match(re); return m ? m[0] : null; };
    return {
      ct: pick(/CT[^ ]{0,12}/), va: pick(/VA 占比[^ ]{0,10}/), balance: pick(/平衡率[^ ]{0,10}/),
      title: (document.querySelector('h1,h2,.an-title') || {}).textContent?.slice(0, 40) ?? null,
    };
  });
  note(`[6] 打开分析页（${Date.now() - t0}ms）: ${JSON.stringify(ana)}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-10-walkthrough-05-analysis.png'), fullPage: false });

  note(`JS 错误: ${jsErrors.length === 0 ? '无' : jsErrors.slice(0, 3).join(' | ')}`);
  await browser.close();

  // ---- 收尾：删除临时工位（级联） ----
  const del = await fetch(API + '/stations/L01-ST90', { method: 'DELETE', headers: auth });
  note(`清理临时工位: ${del.status} ${(await del.text()).slice(0, 80)}`);
  fs.writeFileSync(path.join(SHOT_DIR, 'walkthrough-log.json'), JSON.stringify(log, null, 2), 'utf8');
  console.log('\n=== 实录日志 ===');
  log.forEach((l) => console.log(l));
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
