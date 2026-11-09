/**
 * v3.26 分解工作台两项交互优化专项验证（用户反馈）：
 *  ① 时间片段连续生成：＋新增 / 完成·下一个 → 新片段编号=最大编号+1、起点=前一要素止点（无缝拼接）、
 *     默认时长=交付参数「新片段」设定（可改、localStorage 持久化）
 *  ② 动作对象智能预填（IE 专家团映射表落地）：新增要素不整体复制上一要素；
 *     组合动作（拿取→放置）自动预填对象字段；conditional 级（放置→目检）预填+「请确认」标注；
 *     新循环断点（目检→拿取）不预填且给轻提示
 *  ③ 顺带修复验证：焦点在类型按钮上时 Ctrl+Enter 仍可「完成·下一个」（v3.26 前被 TypeSelect 吞掉）
 * 注意：DOM 块顺序≠时间序（按 key 插入序渲染）——几何断言一律先按 left 排序。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'v326');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 220) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 时间序块几何 + 选中/结构化字段/描述/flash 快照 */
async function snap(page) {
  return page.evaluate(() => {
    const lane = document.querySelector('.tl-lane');
    const lr = lane ? lane.getBoundingClientRect() : null;
    const blocks = Array.from(document.querySelectorAll('.tl-lane .block')).map((b) => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 22), l: Math.round(r.left - (lr ? lr.left : 0)), r: Math.round(r.right - (lr ? lr.left : 0)), w: Math.round(r.width) };
    }).sort((a, b) => a.l - b.l);
    const sdVals = {};
    document.querySelectorAll('.wb-sd .wb-field input').forEach((i) => {
      const span = i.closest('.wb-field')?.querySelector('span');
      let label = '';
      if (span) {
        // 坑：label span 内混有 <em class="wb-sd-confirm">请确认</em>/<i>于</i> 角标——
        // 克隆后剔除 em/i，只取字段名本身，否则 key 变成「对象请确认」
        const c = span.cloneNode(true);
        c.querySelectorAll('em,i').forEach((e) => e.remove());
        label = (c.textContent || '').replace(/[（(].*$/, '').replace(/(于|至)$/, '').trim();
      }
      if (label) sdVals[label] = i.value;
    });
    return {
      blocks, n: blocks.length,
      sel: (document.querySelector('.wb-panel-sel') || {}).textContent?.trim() ?? null,
      sdVals,
      desc: (document.querySelector('input[placeholder*="动作描述"]') || {}).value ?? null,
    };
  });
}
const flashText = (page) => page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('div,span,em,p')).find((x) => x.children.length === 0 && /新对象|已记录|新循环/.test(x.textContent || ''));
  return el ? el.textContent.trim() : '';
});

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

  // ========== ① 连续生成 ==========
  console.log('== ① 时间片段连续生成 ==');
  const s0 = await snap(page);
  ok('初始 3 块（种子要素）', s0.n === 3, s0.n);

  // 交付参数「新片段」设 2s
  await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll('.wb-ab-field')).find((l) => /新片段/.test(l.textContent || ''));
    const input = f?.querySelector('input');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(300);
  ok('「新片段」可改且 localStorage 持久化', (await page.evaluate(() => localStorage.getItem('wb-new-dur'))) === '2');

  // N 新增（焦点在 body）
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('KeyN');
  await sleep(400);
  const s1 = await snap(page);
  ok('N 新增 +1', s1.n === s0.n + 1, `${s0.n} → ${s1.n}`);
  const a = s1.blocks[s1.blocks.length - 2];
  const b = s1.blocks[s1.blocks.length - 1];
  ok('新片段与前一止点重合（时间序最后两块 gap≈0）', Math.abs(b.l - a.r) <= 2, `gap=${b.l - a.r}px`);
  ok('新片段时长=设定 2s（宽≈120px @60px/s）', Math.abs(b.w - 120) <= 3, `w=${b.w}`);
  ok('新片段被自动选中（可直接接着录）', /#\d+/.test(s1.sel || ''), s1.sel);

  // 编号=最大+1：真实点击「#1」块 + Del（synthetic click 不触发 pointerdown 选中）
  // 坑（v3.26 实锤）：块按手别分布在多条轨道，左缘块不一定在首条轨道——
  // 必须按目标块自身矩形取点击点，并用 elementFromPoint 验证命中目标块，
  // 否则点到轨道空白只触发「定位」（v3.17 语义），不选中，Del 会误删自动选中的新块。
  const target = await page.evaluate(() => {
    const wrap = document.querySelector('.wb-tl');
    if (wrap) wrap.scrollLeft = 0;
    const blk = Array.from(document.querySelectorAll('.tl-lane .block'))
      .find((b) => (b.querySelector('.blk-seq')?.textContent || '').trim() === '#1');
    if (!blk) return null;
    const r = blk.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && (hit === blk || blk.contains(hit)), hitCls: hit ? String(hit.className) : null, text: (blk.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18) };
  });
  ok('定位「#1」块点击点（elementFromPoint 命中目标块）', !!target && target.ok, target ? `${target.text} hit=${target.hitCls}` : 'no #1 block');
  await page.mouse.click(target.x, target.y);
  await sleep(350);
  const selBeforeDel = (await snap(page)).sel;
  ok('点击真实选中「#1」', /^#1\b/.test(selBeforeDel || ''), selBeforeDel);
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Delete');
  await sleep(400);
  const s2 = await snap(page);
  ok('Del 删除选中块（#1 已不在）', s2.n === s1.n - 1 && !s2.blocks.some((b) => /^#1\b/.test(b.t)), `${s1.n} → ${s2.n} sel=${selBeforeDel}`);
  await page.keyboard.press('KeyN');
  await sleep(400);
  const s3 = await snap(page);
  const seqOf = (t) => { const m = /#(\d+)/.exec(t || ''); return m ? Number(m[1]) : null; };
  const seqs = s3.blocks.map((x) => seqOf(x.t)).filter((s) => s != null);
  ok('新增编号=当前最大编号+1（删块后不跳号）', seqs.length > 0 && Math.max(...seqs) === 5 && new Set(seqs).size === seqs.length, JSON.stringify(seqs));
  const a2 = s3.blocks[s3.blocks.length - 2];
  const b2 = s3.blocks[s3.blocks.length - 1];
  ok('删块后再新增仍拼接连续（gap≈0）', Math.abs(b2.l - a2.r) <= 2, `gap=${b2.l - a2.r}px`);

  // 还原新片段=1s
  await page.evaluate(() => {
    const f = Array.from(document.querySelectorAll('.wb-ab-field')).find((l) => /新片段/.test(l.textContent || ''));
    const input = f?.querySelector('input');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(250);

  // ========== ② 对象继承预填 ==========
  console.log('== ② 动作对象智能预填 ==');
  // 当前选中块（N 刚建的）默认拿取——填对象/位置构造「拿取 导轨 于 物料箱」
  await page.evaluate(() => {
    const set = (el, v) => { const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; st.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const inputs = Array.from(document.querySelectorAll('.wb-sd .wb-field input'));
    set(inputs.find((i) => /对象/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || '')) || inputs[0], '导轨');
    set(inputs.find((i) => /位置/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || '')) || inputs[1], '物料箱');
  });
  await sleep(400);
  const s4 = await snap(page);
  ok('构造上一要素：拿取 导轨 于 物料箱', /拿取/.test(s4.desc || '') && /导轨/.test(s4.desc || '') && /物料箱/.test(s4.desc || ''), s4.desc);

  // 完成·下一个（Ctrl+Enter，焦点此时在结构化 input 之外的 body）
  await page.evaluate(() => document.body.focus());
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  const s5 = await snap(page);
  ok('完成·下一个生成新块', s5.n === s4.n + 1, `${s4.n} → ${s5.n}`);
  ok('新块不整体复制（描述无“导轨/物料箱”残留）', !/导轨|物料箱/.test(s5.desc || ''), s5.desc);
  ok('新块对象字段空（等选类型再判定）', !s5.sdVals['对象'], JSON.stringify(s5.sdVals));

  // 选「放置」→ yes 级预填对象
  await page.click('.wb-tsel-btn');
  await sleep(400);
  await page.evaluate(() => { Array.from(document.querySelectorAll('.wb-tsel-o')).find((o) => o.textContent.trim() === '放置')?.click(); });
  await sleep(500);
  const s6 = await snap(page);
  ok('拿取→放置：自动预填对象=导轨（在手链 yes 级）', s6.sdVals['对象'] === '导轨', JSON.stringify(s6.sdVals));
  ok('位置不预填（参数不可复用）', !s6.sdVals['位置'], JSON.stringify(s6.sdVals));
  ok('描述自动写入（放置 导轨）', /放置/.test(s6.desc || '') && /导轨/.test(s6.desc || '') && !/物料箱/.test(s6.desc || ''), s6.desc);
  const badge1 = await page.evaluate(() => { const e = document.querySelector('.wb-sd-confirm'); return !!e && e.offsetParent !== null; });
  ok('yes 级静默预填（无「请确认」标注）', !badge1);

  // 完成·下一个 → 选「目检」→ conditional 级预填+请确认（焦点故意留在类型按钮上，验证 ③）
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  const s7 = await snap(page);
  ok('焦点在类型按钮时 Ctrl+Enter 仍生效（v3.26 修复验证）', s7.n === s6.n + 1, `${s6.n} → ${s7.n}`);
  await page.click('.wb-tsel-btn');
  await sleep(400);
  await page.evaluate(() => { Array.from(document.querySelectorAll('.wb-tsel-o')).find((o) => o.textContent.trim() === '目检')?.click(); });
  await sleep(500);
  const s8 = await snap(page);
  ok('放置→目检：conditional 预填对象=导轨', s8.sdVals['对象'] === '导轨', JSON.stringify(s8.sdVals));
  const badge2 = await page.evaluate(() => { const e = document.querySelector('.wb-sd-confirm'); return !!e && e.offsetParent !== null && /请确认/.test(e.textContent || ''); });
  ok('conditional 级挂「请确认」标注', badge2);

  // 改写对象 → 标注消失
  await page.evaluate(() => {
    const obj = Array.from(document.querySelectorAll('.wb-sd .wb-field input')).find((i) => /对象/.test(i.closest('.wb-field')?.querySelector('span')?.textContent || ''));
    if (obj) { const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; st.call(obj, '后横梁'); obj.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await sleep(300);
  const badge3 = await page.evaluate(() => { const e = document.querySelector('.wb-sd-confirm'); return !!e && e.offsetParent !== null; });
  ok('改写对象后「请确认」消失（视为已确认）', !badge3);

  // 完成·下一个 → 选「拿取」→ 新循环断点：不预填 + flash 提示
  // 坑：新要素默认类型即「拿取」，同值重选不触发 onChange（TypeSelect：t!==value 才回调）——
  // 先选「放置」再选「拿取」，保证最后一次类型变更走完整判定链路（含新循环断点 flash）。
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  await sleep(500);
  const s9 = await snap(page);
  ok('再次完成·下一个', s9.n === s8.n + 1, `${s8.n} → ${s9.n}`);
  await page.click('.wb-tsel-btn');
  await sleep(400);
  await page.evaluate(() => { Array.from(document.querySelectorAll('.wb-tsel-o')).find((o) => o.textContent.trim() === '放置')?.click(); });
  await sleep(450);
  await page.click('.wb-tsel-btn');
  await sleep(400);
  await page.evaluate(() => { Array.from(document.querySelectorAll('.wb-tsel-o')).find((o) => o.textContent.trim() === '拿取')?.click(); });
  await sleep(350);
  const s10 = await snap(page);
  ok('目检→拿取（新循环断点）不预填对象', !s10.sdVals['对象'], JSON.stringify(s10.sdVals));
  const flash = await flashText(page);
  ok('新循环断点轻提示（新对象/新循环？）', /新对象\/新循环/.test(flash), flash);

  await page.screenshot({ path: path.join(SHOT_DIR, 'v326-01-workbench.png') });
  console.log('saved v326-01-workbench.png');
  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
