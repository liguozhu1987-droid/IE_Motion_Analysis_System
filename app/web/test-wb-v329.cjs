/**
 * v3.29 「要素时间重叠」误报修复 · 浏览器级验证（缺陷修复④收尾）
 *
 * 背景：新增要素起点由程序自动连续生成，用户未手动调整起止点，校验按钮却误报
 * "要素时间重叠"。根因=时间量纲不交换（round(start+dur×1000) ≠ round(start)+round(dur×1000)
 * ≠ round2(dur) 落库值），帧量化分数播放头（30fps 33.33ms 步进）与 10ms 存储网格叠加
 * 产生 1~5ms 幻影重叠。修复口径（三恒等）：
 *   ① 播放头/起点一律整数毫秒（与 start_ms INT 列一致）；
 *   ② 时长一律 durToGrid 10ms 网格（与 dur_s DECIMAL(10,2) 一致）；
 *   ③ 要素止点恒等后端 V2 公式 start_ms + round(量化后 dur_s × 1000)。
 * 附带修复（验证中发现）：窄块（分割半块 <18px≈0.3s）左右拖拽握把 9px 重叠，
 *   左缘抓取误命中右缘（后者居上）→ 把块右缘拖进下一要素成**真**重叠；
 *   握把宽度改 min(9px, 45%) 后永不重叠（styles.css .block .grip）。
 *
 * 本测试在真实浏览器复现用户现场回路，并对 /validate 请求体与响应做机验：
 *   A. L 松开停（帧对齐整数播放头）→ N 新增连续生成 → 校验零 V2
 *   B. 播放头定位 2283ms（非 10ms 网格）→ S 分割 → 两半逐毫秒无缝 → 校验零 V2
 *   B2. I/O 设起点 600ms（网格值，链保持无缝）→ 校验零 V2
 *   C. 拖拽左缘（帧量化+磁吸候选）→ 校验零 V2
 *   D. 提交 → 重载 → 校验零 V2（落库 round-trip 闭环，DB 值直查）
 *   E. 真重叠仍拦截（拖出 667ms 重叠 → V2 error，确认未过度放宽）
 *
 * 测试侧口径（v3.29 实锤）：
 *   · 块几何=块自身矩形；播放头定位=**车道**矩形+偏移（块 left 是车道相对，双击块/空白道都走车道 rect 换算）
 *   · 双击块=单击选中→再单击取消（toggle）+双击定位；要"I/O 设边界"须：双击定位→**再单击选中**→按 I/O
 *   · 拖拽前必须 elementFromPoint 验证落点命中目标握把（窄块两侧握把曾重叠，误拖右缘会造出真重叠）
 * 夹具：临时工位 L01-ST97（CSV 导入 3 要素，全 B 手链 0-2000-4000-5000ms），
 *       MediaRecorder 现场录 10s webm 注入文件输入框；结束 DELETE 工位收尾。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'v329');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 时间序块几何快照（DOM 顺序≠时间序，一律按 left 排序） */
async function snap(page) {
  return page.evaluate(() => {
    const lane = document.querySelector('.tl-lane');
    const lr = lane ? lane.getBoundingClientRect() : null;
    const blocks = Array.from(document.querySelectorAll('.tl-lane .block')).map((b) => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 24), l: Math.round(r.left - (lr ? lr.left : 0)), r: Math.round(r.right - (lr ? lr.left : 0)), w: Math.round(r.width) };
    }).sort((a, b) => a.l - b.l);
    return { blocks, n: blocks.length };
  });
}
/** 有块的车道矩形（L/R 空车道在前，定位/拖拽都要取它） */
const blockLaneBox = (page) => page.evaluate(() => {
  const blk = document.querySelector('.tl-lane .block');
  const lane = blk ? blk.closest('.tl-lane') : document.querySelector('.tl-lane');
  const r = lane.getBoundingClientRect();
  return { left: r.left, top: r.top, height: r.height, width: r.width };
});
const clickText = async (page, text) => {
  const box = await page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === t);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
};
/** 关闭所有横幅（避免上轮校验的 success 横幅被下一轮等待误命中） */
const closeBanners = (page) => page.evaluate(() => {
  document.querySelectorAll('.wb-toast-banners .wb-banner-x').forEach((x) => x.click());
});
/** 显式 clickCount 递进才能让 Chromium 合成原生 dblclick（mouse.click({clickCount:2}) 只出 click detail=1） */
async function dblClickAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
}
/** MediaRecorder 现场录 10s webm（覆盖要素区间 0~6s）并注入文件输入框 */
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
      // onstop 必须先挂再 stop（stop 后挂有竞争，onstop 永不触发 → evaluate 挂死）
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const draw = () => {
          const el = performance.now() - t0;
          ctx.fillStyle = `hsl(${el / 8}, 60%, 50%)`;
          ctx.fillRect(0, 0, 320, 180);
          if (el < 10000) requestAnimationFrame(draw); else resolve();
        };
        requestAnimationFrame(draw);
      });
      rec.stop();
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]); // 兜底防挂死
      const blob = new Blob(chunks, { type: 'video/webm' });
      const file = new File([blob], 'v329-sample.webm', { type: 'video/webm' });
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
/** 抓取某个块的拖拽握把屏幕坐标，并验证落点确实命中该握把（防窄块握把重叠误拖） */
async function gripPoint(page, seqNo, side) {
  const pt = await page.evaluate(({ seqNo, side }) => {
    const wrap = document.querySelector('.wb-tl');
    if (wrap) wrap.scrollLeft = 0;
    const blk = Array.from(document.querySelectorAll('.tl-lane .block'))
      .find((b) => (b.querySelector('.blk-seq')?.textContent || '').trim() === '#' + seqNo);
    if (!blk) return null;
    const g = blk.querySelector('.grip.' + side);
    if (!g) return null;
    const r = g.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const hitGrip = hit && hit.closest ? hit.closest('.grip') : null;
    const hitBlk = hit && hit.closest ? hit.closest('.block') : null;
    return {
      x, y,
      // 落点必须命中目标块的同侧握把（v3.29 前窄块 grip.l 中心会误命中 grip.r）
      hitOk: !!hitGrip && hitGrip === g && !!hitBlk && hitBlk === blk,
      hitCls: hit ? String(hit.className) : null,
    };
  }, { seqNo, side });
  return pt;
}

/** payload 不变量：起点整数毫秒 + 时长 10ms 网格 + 同手链无重叠（恒等后端 V2 止点公式）。
 *  seamless=true 时 additionally 要求逐毫秒无缝（自动生成链场景）；
 *  seamless=false 允许间隙（用户主动拖左缘右移等合法操作留空档，由 W2 间隙警告负责，不是 V2 错误） */
function checkChain(payload, seamless = true) {
  const els = (payload && payload.elements) || [];
  const problems = [];
  for (const e of els) {
    if (!Number.isInteger(e.start_ms)) problems.push(`#${e.seq} start_ms=${e.start_ms} 非整数`);
    const dec = (String(e.dur_s).split('.')[1] || '').length;
    if (dec > 2) problems.push(`#${e.seq} dur_s=${e.dur_s} 超出 10ms 网格`);
  }
  const byHand = {};
  for (const e of els) { (byHand[e.hand] = byHand[e.hand] || []).push(e); }
  for (const [hand, list] of Object.entries(byHand)) {
    list.sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const prevEnd = prev.start_ms + Math.round(prev.dur_s * 1000);
      if (seamless && list[i].start_ms !== prevEnd) {
        problems.push(`${hand}链 #${prev.seq}止点${prevEnd} ≠ #${list[i].seq}起点${list[i].start_ms}（差 ${list[i].start_ms - prevEnd}ms）`);
      } else if (!seamless && list[i].start_ms < prevEnd) {
        problems.push(`${hand}链 #${prev.seq}止点${prevEnd} > #${list[i].seq}起点${list[i].start_ms}（重叠 ${prevEnd - list[i].start_ms}ms）`);
      }
    }
  }
  return problems;
}

(async () => {
  // ==================== 0. 夹具：临时工位 + CSV 导入 3 要素 ====================
  console.log('== 0. 夹具：临时工位 L01-ST97 ==');
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();
  const auth = { Authorization: 'Bearer ' + login.accessToken };
  const SID = 'L01-ST97';
  await fetch(API + '/stations/' + SID, { method: 'DELETE', headers: auth }).catch(() => {}); // 防重名残留
  const cr = await fetch(API + '/stations', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ station_id: SID, line_id: 'L01', name: 'v329重叠修复验证', tt: 30 }),
  });
  ok('创建临时工位 L01-ST97', cr.status === 200 || cr.status === 201, cr.status);
  const csv = ['序号,手别,类型,描述,时长s', '1,B,握取,握取螺丝,2', '2,B,移物,移送零件至夹具,2', '3,B,定位,定位装入,1'].join('\n');
  const ir = await fetch(API + '/stations/' + SID + '/elements/import', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  const ij = await ir.json().catch(() => ({}));
  ok('CSV 导入 3 要素（B 手链 0-2000-4000-5000ms）', ir.status === 200 || ir.status === 201, `${ir.status} ${JSON.stringify(ij).slice(0, 160)}`);

  // ==================== 1. 浏览器 ====================
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, protocolTimeout: 240000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  // 捕获 /elements/validate 的请求体与响应（UI 校验按钮的线上口径）
  await page.evaluateOnNewDocument(() => {
    window.__valReq = [];
    window.__valResp = [];
    const orig = window.fetch;
    window.fetch = async function (...args) {
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (String(u).includes('/elements/validate')) {
          const body = args[1] && args[1].body;
          if (typeof body === 'string') { try { window.__valReq.push(JSON.parse(body)); } catch { /* 忽略 */ } }
          const res = await orig.apply(this, args);
          try { window.__valResp.push({ status: res.status, json: await res.clone().json() }); } catch { /* 忽略 */ }
          return res;
        }
      } catch { /* 忽略 */ }
      return orig.apply(this, args);
    };
  });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
    localStorage.removeItem('wb-new-dur');
  }, login.refreshToken);
  await page.goto(WEB + '/#/workbench/' + SID, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.tl-lane .block').length === 3, { timeout: 20000 });
  await sleep(600);
  const s0 = await snap(page);
  ok('工作台载入 3 个种子要素', s0.n === 3, s0.n);
  ok('注入 10s 录制视频', await injectVideo(page));
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, { timeout: 15000 });

  /** 点校验 → 等 /validate 响应到达 → 返回最后一次请求体与响应 */
  async function validateOnce(label) {
    await closeBanners(page);
    const before = await page.evaluate(() => (window.__valResp || []).length);
    ok(label + '：点击「校验」', await clickText(page, '校验'));
    // 注意签名：waitForFunction(fn, options, ...args)——options 必须在前，否则实参被吞
    await page.waitForFunction((n) => (window.__valResp || []).length > n, { timeout: 20000, polling: 100 }, before);
    await sleep(200);
    return page.evaluate(() => {
      const reqs = window.__valReq || [];
      const resps = window.__valResp || [];
      return { req: reqs[reqs.length - 1] || null, resp: resps[resps.length - 1] || null };
    });
  }
  const assertNoV2 = (label, r, seamless = true) => {
    const errs = (r.resp && r.resp.json && r.resp.json.errors) || [];
    const v2 = errs.filter((e) => e.code === 'V2');
    ok(label + '：/validate 零错误', errs.length === 0, JSON.stringify(errs).slice(0, 200));
    ok(label + '：无 V2 重叠误报', v2.length === 0, JSON.stringify(v2).slice(0, 200));
    const probs = checkChain(r.req, seamless);
    ok(label + (seamless ? '：payload 网格/无缝不变量' : '：payload 网格/不重叠不变量（允许间隙）'), probs.length === 0, probs.join('；').slice(0, 260));
    return v2.length === 0 && errs.length === 0 && probs.length === 0;
  };

  // ==================== A. L 松开停 → N 新增 → 校验零 V2 ====================
  console.log('== A. L 松开停（帧对齐）→ N 新增连续生成 ==');
  await page.evaluate(() => document.body.focus());
  await page.keyboard.down('KeyL');
  await sleep(750);
  await page.keyboard.up('KeyL'); // 松开即停（帧对齐 + v3.29 整数化）
  await sleep(200);
  const phA = await page.evaluate(() => {
    const b = document.querySelector('.wb-tp-time b');
    return b ? b.textContent.trim() : null;
  });
  ok('L 松开后播放头有值（K/松开均帧对齐落整数毫秒）', !!phA, phA);
  const nBefore = (await snap(page)).n;
  await page.keyboard.press('KeyN'); // ＋新增：起点=全部要素最大止点
  await sleep(450);
  const sA = await snap(page);
  ok('N 新增 +1', sA.n === nBefore + 1, `${nBefore} → ${sA.n}`);
  const a1 = sA.blocks[sA.blocks.length - 2];
  const a2 = sA.blocks[sA.blocks.length - 1];
  ok('新片段与前一止点重合（gap≈0px @60px/s）', Math.abs(a2.l - a1.r) <= 2, `gap=${a2.l - a1.r}px`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v329-01-kstop-add.png') });
  console.log('saved v329-01-kstop-add.png');
  const rA = await validateOnce('A');
  assertNoV2('A', rA);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v329-02-validate-ok.png') });
  console.log('saved v329-02-validate-ok.png');

  // ==================== B. 播放头定位（非网格值）→ S 分割 → 零 V2 ====================
  console.log('== B. 播放头定位 2283ms → S 分割 ==');
  // 车道矩形 + 137px → 2283ms（非 10ms 网格，专打网格舍入错位）；
  // 落点在 #2 块内（120~238px），双击块=定位播放头（块/空白道的 seek 都按车道 rect 换算）
  const lane = await blockLaneBox(page);
  const dblX = lane.left + 137;
  const dblY = lane.top + lane.height / 2;
  await dblClickAt(page, dblX, dblY);
  await sleep(300);
  const phB = await page.evaluate(() => {
    const b = document.querySelector('.wb-tp-time b');
    return b ? b.textContent.trim() : null;
  });
  ok('双击定位播放头 2283ms（非网格值）', !!phB && /02\.283|2\.283/.test(phB), phB);
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('KeyS'); // 分割
  await sleep(450);
  const sB = await snap(page);
  ok('S 分割后块数 +1', sB.n === sA.n + 1, `${sA.n} → ${sB.n}`);
  const halves = sB.blocks.filter((b) => /移送零件至夹具/.test(b.t)); // 两半同描述
  ok('分割出两半（同描述两块）', halves.length === 2, JSON.stringify(halves));
  if (halves.length === 2) {
    ok('两半落在原 #2 区间（120~238px）', halves[0].l >= 115 && halves[1].r <= 243, JSON.stringify(halves));
    ok('分割两半逐毫秒无缝（gap≈0px）', Math.abs(halves[1].l - halves[0].r) <= 2, `gap=${halves[1].l - halves[0].r}px`);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'v329-03-split.png') });
  console.log('saved v329-03-split.png');
  const rB = await validateOnce('B');
  assertNoV2('B', rB);

  // ==================== B2. I/O 设起点（网格值 600ms）→ 零 V2 ====================
  console.log('== B2. I/O 设起点 ==');
  // 双击块=选中→再点取消（toggle）+定位；I/O 须"再单击选中"后才生效（v3.22 语义）
  await dblClickAt(page, lane.left + 36, dblY); // 600ms（10ms 网格值，链保持无缝）
  await sleep(300);
  const phB2 = await page.evaluate(() => (document.querySelector('.wb-tp-time b') || {}).textContent?.trim() || null);
  ok('双击定位播放头 600ms', !!phB2 && /00\.600|0\.600/.test(phB2), phB2);
  const selAfterDbl = await page.evaluate(() => (document.querySelector('.block.selected .blk-seq') || {}).textContent || null);
  ok('双击后取消选中（toggle 语义，符合 v3.22 设计）', selAfterDbl === null, selAfterDbl);
  const c1 = await page.evaluate(() => {
    const blk = Array.from(document.querySelectorAll('.tl-lane .block'))
      .find((b) => (b.querySelector('.blk-seq')?.textContent || '').trim() === '#1');
    if (!blk) return null;
    const r = blk.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(c1.x, c1.y); // 再单击选中 #1
  await sleep(300);
  const selBeforeI = await page.evaluate(() => (document.querySelector('.block.selected .blk-seq') || {}).textContent || null);
  ok('再单击选中 #1', selBeforeI === '#1', selBeforeI);
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('KeyI');
  await sleep(350);
  const sB2 = await snap(page);
  ok('I 设起点后 #1 左缘移到 36px（600ms）', sB2.blocks[0] && Math.abs(sB2.blocks[0].l - 36) <= 2, JSON.stringify(sB2.blocks[0]));
  const flashTxt = await page.evaluate(() => (document.querySelector('.wb-toast-flash') || {}).textContent || '');
  ok('I 生效有 flash 反馈（#1 起点 → 00:00.600）', /起点/.test(flashTxt), flashTxt.slice(0, 60));
  const rB2 = await validateOnce('B2');
  assertNoV2('B2', rB2);

  // ==================== C. 拖拽左缘（帧量化+磁吸）→ 零 V2 ====================
  console.log('== C. 拖拽左缘 ==');
  const gC = await gripPoint(page, 4, 'l'); // #4 拿取（宽块，握把不重叠）
  ok('抓取 #4 左缘握把且落点命中 grip.l（窄块重叠已修）', !!gC && gC.hitOk, gC ? `hit=${gC.hitCls}` : 'no grip');
  if (gC && gC.hitOk) {
    await page.mouse.move(gC.x, gC.y);
    await page.mouse.down();
    await page.mouse.move(gC.x + 45, gC.y, { steps: 6 }); // 右移 45px=750ms → 帧量化落点（无磁吸命中）
    await sleep(150);
    await page.mouse.up();
    await sleep(300);
  }
  const sC = await snap(page);
  const blk4 = sC.blocks.find((b) => /拿取/.test(b.t));
  ok('拖拽后 #4 起点右移（≈5750ms 帧量化，左缘 >330px）', !!blk4 && blk4.l > 330, JSON.stringify(blk4));
  await page.screenshot({ path: path.join(SHOT_DIR, 'v329-04-drag.png') });
  console.log('saved v329-04-drag.png');
  // C 主动把 #4 左缘右移 767ms：合法操作产生间隙（W2 警告范畴，不是 V2 错误）→ 允许间隙
  const rC = await validateOnce('C');
  assertNoV2('C', rC, false);

  // ==================== D. 提交 → 重载 → 校验零 V2（round-trip） ====================
  console.log('== D. 提交 → 重载 round-trip ==');
  await page.evaluate(() => {
    const wrap = Array.from(document.querySelectorAll('.wb-ab-field')).find((w) => w.querySelector('span')?.textContent === '循环');
    const inp = wrap?.querySelector('input');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '15');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(300);
  await closeBanners(page);
  ok('点击「提交分解」', await clickText(page, '提交分解'));
  await page.waitForFunction(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '提交分解');
    return b && !b.disabled;
  }, { timeout: 20000, polling: 100 });
  await sleep(400);
  const submitBanner = await page.evaluate(() => {
    const b = document.querySelector('.wb-toast-banners .banner-success');
    return b ? (b.textContent || '').trim() : null;
  });
  ok('提交成功横幅（v2）', !!submitBanner && /提交成功/.test(submitBanner), submitBanner);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v329-05-submitted.png') });
  console.log('saved v329-05-submitted.png');
  // DB 直查：落库值也必须满足同一组不变量（INT/DECIMAL(10,2) 存储契约）；C 的间隙为合法操作，允许间隙
  const dbEls = await (await fetch(API + '/stations/' + SID + '/elements', { headers: auth })).json();
  const dbList = (dbEls && dbEls.elements) || dbEls || [];
  const dbProbs = checkChain({ elements: dbList.map((e) => ({ seq: e.seq, start_ms: Number(e.start_ms), dur_s: Number(e.dur_s), hand: e.hand })) }, false);
  ok('DB 落库值：起点整数 + 10ms 网格 + 无重叠', dbProbs.length === 0 && dbList.length > 0, `${dbList.length} 条 ${dbProbs.join('；').slice(0, 240)}`);
  // 重载后（load() 已刷新 draft）再校验——round-trip 闭环
  const rD = await validateOnce('D');
  assertNoV2('D', rD, false);

  // ==================== E. 真重叠仍拦截（未过度放宽） ====================
  console.log('== E. 真重叠仍拦截 ==');
  const gE = await gripPoint(page, 2, 'l'); // 提交后 seq 重排：#2=2000-2280（16px 窄半块）
  ok('抓取 #2 左缘握把且落点命中 grip.l（窄块握把修复验证）', !!gE && gE.hitOk, gE ? `hit=${gE.hitCls}` : 'no grip');
  if (gE && gE.hitOk) {
    await page.mouse.move(gE.x, gE.y);
    await page.mouse.down();
    await page.mouse.move(gE.x - 40, gE.y, { steps: 6 }); // 左移 40px=667ms → 1333ms，压进 #1（600-2000）
    await sleep(150);
    await page.mouse.up();
    await sleep(300);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'v329-06-true-overlap.png') });
  console.log('saved v329-06-true-overlap.png');
  const rE = await validateOnce('E');
  const eErrs = (rE.resp && rE.resp.json && rE.resp.json.errors) || [];
  ok('E：真重叠被 V2 拦截（未过度放宽）', eErrs.some((e) => e.code === 'V2' && /重叠/.test(e.message || '')), JSON.stringify(eErrs).slice(0, 200));
  const eBanner = await page.evaluate(() => {
    const b = document.querySelector('.wb-toast-banners .banner-error');
    return b ? (b.textContent || '').trim().slice(0, 90) : null;
  });
  ok('E：错误横幅可见（[V2] 重叠）', !!eBanner && /V2|重叠/.test(eBanner), eBanner);

  // ==================== 收尾 ====================
  ok('全程无 JS pageerror', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
  await browser.close();
  const del = await fetch(API + '/stations/' + SID, { method: 'DELETE', headers: auth });
  ok('清理临时工位 L01-ST97', del.status === 200 || del.status === 204, del.status);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
