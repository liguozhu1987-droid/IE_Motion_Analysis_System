/**
 * v3.49 · 分解工作台两项交互优化 UI 测试
 *
 * 用户需求：
 *  需求1 动作要素选择框：一级要素（装配/操作/移动/检查）此前只能选其下二级，现一级本身可选；
 *         选择一级生成的标准化描述，与选择其下二级走同一标准链路（字段结构一致）。
 *  需求2 时间线显示区域自动滚动：片段增多出现横向滚动条时，滚动条自动右移，
 *         使最右侧片段止点保持可见，并在右侧至少预留 1/5 片段宽度的空白。
 *
 * 断言：
 *  T1 打开类型下拉：一级行（.wb-tsel-o.top）为正经可选项，含 装配/操作/移动/检查
 *  T2 选一级「装配」→ 类型按钮=装配，结构化字段=对象/位置/距离（与二级 粘贴/涂 同构）
 *  T3 选二级「粘贴」→ 字段同为 对象/位置/距离（名称序列逐字相同，介词沿用标准库各自定义）
 *  T4 选一级「操作」→ 字段=对象（与二级 按/压 同构）
 *  T5 新要素选一级「装配」后填对象 → 描述自动生成为「装配 <对象>」（标准化描述链路生效）
 *  T6 载入基线：fresh load 后 scrollLeft=0（存量灌入不跳到最右端）
 *  T7 连续新增片段 → 横向滚动条自动右移（scrollLeft 单调不减且 >0）
 *  T8 每次新增后最右侧片段完整可见，且右侧空白 ≥ 1/5 片段宽度
 *  T9 无 JS pageerror
 *
 * 前置：API(3001) + Vite dev(5173)。数据：ST010（18 手工要素）——新增仅改本地草稿，不提交落库。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'ST010';
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读类型下拉里的行：{ text, top, sub } */
const readRows = (page) => page.$$eval('.wb-tsel-menu .wb-tsel-o', (ns) =>
  ns.map((n) => ({ text: (n.textContent || '').trim(), top: n.classList.contains('top'), sub: n.classList.contains('sub') })));

/** 结构化字段名称序列（剥掉介词 <i> 与「选填/请确认」角标；
 *  排除「动作要素」类型行与「动作行程」部位行——它们不是描述格式字段） */
const readFields = (page) => page.$$eval('.wb-sd .wb-field', (ns) =>
  ns.filter((n) => !n.classList.contains('wb-sd-type') && !n.classList.contains('wb-sd-reach'))
    .map((n) => {
      const s = n.querySelector('span');
      return (s && s.firstChild && s.firstChild.nodeValue ? s.firstChild.nodeValue : (s?.textContent ?? '')).trim();
    }));

/** 点开下拉并选中指定文本的行 */
async function pickType(page, label) {
  await page.evaluate(() => document.querySelector('.wb-sd-type .wb-tsel-btn').click());
  await page.waitForSelector('.wb-tsel-menu', { timeout: 5000 });
  await sleep(200);
  const hit = await page.evaluate((lb) => {
    const rows = [...document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')];
    const t = rows.find((r) => (r.textContent || '').trim() === lb);
    if (t) { t.click(); return true; }
    return false;
  }, label);
  await sleep(350);
  return hit;
}

/** 时间线状态：滚动位置 + 最右块可见性/右侧留白 */
const tlState = (page) => page.evaluate(() => {
  const wrap = document.querySelector('.timeline-wrap');
  const blocks = [...document.querySelectorAll('.timeline .block')];
  if (!wrap || blocks.length === 0) return null;
  const wr = wrap.getBoundingClientRect();
  let last = blocks[0];
  for (const b of blocks) if (b.getBoundingClientRect().right > last.getBoundingClientRect().right) last = b;
  const br = last.getBoundingClientRect();
  return {
    scrollLeft: Math.round(wrap.scrollLeft),
    clientWidth: Math.round(wrap.clientWidth),
    scrollWidth: Math.round(wrap.scrollWidth),
    blockW: Math.round(br.width),
    gapRight: Math.round(wr.right - br.right),
    visible: br.right <= wr.right + 0.5,
    seq: (last.querySelector('.blk-seq')?.textContent || '').trim(),
  };
});

const clickAdd = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button.wb-rec-btn')].find((x) => /新增要素/.test(x.title || ''));
  if (!b) return false;
  b.click();
  return true;
});

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));
  /* 只读保证：本用例任何 POST/PATCH/DELETE 业务写入都算失败（新增仅改本地草稿） */
  const writes = [];
  page.on('request', (req) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method()) && /\/api\//.test(req.url()) && !/\/api\/auth\//.test(req.url())) {
      writes.push(req.method() + ' ' + req.url().replace(/^https?:\/\/[^/]+/, ''));
    }
  });

  /* v3.48 教训：token 必须条件注入（refresh 一次性轮换，无条件覆写会让第二文档起 401 退登录） */
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  console.log('\n--- T1-T5. 动作要素选择框：一级要素可选 + 标准化描述同构 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/workbench/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.timeline .block', { timeout: 30000 });
  await sleep(1200);

  /* T6 基线：存量灌入不应把滚动条推到最右 */
  const base = await tlState(page);
  ok('T6 载入后 scrollLeft=0（存量灌入不跳最右）', base && base.scrollLeft === 0, JSON.stringify(base));
  ok('T6 时间线存在横向滚动（scrollWidth>clientWidth）', base && base.scrollWidth > base.clientWidth,
    base && `${base.scrollWidth}>${base.clientWidth}`);

  /* 选中首个要素 → 属性检查器出现类型下拉。
     必须用真实鼠标点击：块的选中挂在 onPointerDown 上，DOM .click() 不触发指针事件 */
  const firstBlock = await page.$('.timeline .block');
  await firstBlock.click();
  await page.waitForSelector('.wb-sd-type .wb-tsel-btn', { timeout: 10000 });
  await sleep(300);

  await page.evaluate(() => document.querySelector('.wb-sd-type .wb-tsel-btn').click());
  await page.waitForSelector('.wb-tsel-menu', { timeout: 5000 });
  await sleep(250);
  const rows = await readRows(page);
  const tops = rows.filter((r) => r.top).map((r) => r.text);
  ok('T1 一级要素行渲染为可选项（.top）', tops.length >= 14, tops.join('/'));
  ok('T1 一级含 装配/操作/移动/检查（此前不可选）',
    ['装配', '操作', '移动', '检查'].every((t) => tops.includes(t)), tops.join('/'));
  ok('T1 二级行仍缩进存在（如 粘贴/目检）',
    rows.some((r) => r.sub && r.text === '粘贴') && rows.some((r) => r.sub && r.text === '目检'),
    JSON.stringify(rows.filter((r) => r.sub).map((r) => r.text)));
  await page.screenshot({ path: path.join(SHOT_DIR, 'v349-typemenu.png') });
  await page.keyboard.press('Escape');
  await sleep(200);

  ok('T2 选中一级「装配」', await pickType(page, '装配'));
  const typeVal = await page.$eval('.wb-sd-type .wb-tsel-v', (n) => (n.textContent || '').trim());
  const fAsm = await readFields(page);
  ok('T2 类型按钮=装配', typeVal === '装配', typeVal);
  ok('T2 装配字段=对象/位置/距离', fAsm.join('/') === '对象/位置/距离', fAsm.join('/'));

  ok('T3 选中二级「粘贴」', await pickType(page, '粘贴'));
  const fPaste = await readFields(page);
  ok('T3 粘贴字段=对象/位置/距离（与一级装配同构）', fPaste.join('/') === '对象/位置/距离', fPaste.join('/'));

  ok('T4 选中一级「操作」', await pickType(page, '操作'));
  const fOp = await readFields(page);
  ok('T4 操作字段=对象（与二级 按/压 同构）', fOp.join('/') === '对象', fOp.join('/'));
  ok('T4 操作显示动作行程（部位档，与二级一致）', await page.$('.wb-sd-reach') !== null);

  /* T5：新建要素（描述=新要素，属"机器可写"态）→ 选一级装配 → 填对象 → 描述自动生成 */
  await clickAdd(page);
  await sleep(400);
  const addOk = await page.$('.wb-sd-type .wb-tsel-btn') !== null;
  ok('T5 ＋新增 后检查器就位', addOk);
  ok('T5 新要素选一级「装配」', await pickType(page, '装配'));
  await page.evaluate(() => {
    const inp = [...document.querySelectorAll('.wb-sd .wb-field')].find((f) => /^对象/.test((f.textContent || '')))?.querySelector('input');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '毛毡');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(400);
  const desc = await page.$eval('input.wb-desc', (n) => n.value).catch(() => '');
  ok('T5 描述自动生成「装配 毛毡」', desc.trim() === '装配 毛毡', desc);

  console.log('\n--- T7-T8. 时间线自动跟随（新增片段不被右缘遮挡） ---');
  const states = [];
  for (let i = 0; i < 8; i += 1) {
    await clickAdd(page);
    await sleep(320);
    states.push(await tlState(page));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, 'v349-timeline-scroll.png') });

  const nonDecreasing = states.every((s, i) => i === 0 || s.scrollLeft >= states[i - 1].scrollLeft);
  ok('T7 scrollLeft 单调不减（自动右移，不回弹）', nonDecreasing,
    states.map((s) => s.scrollLeft).join('→'));
  ok('T7 新增后滚动条确已右移（scrollLeft>0）', states[states.length - 1].scrollLeft > 0,
    states.map((s) => s.scrollLeft).join('→'));
  const allVisible = states.every((s) => s.visible);
  ok('T8 每次新增后最右侧片段完整可见', allVisible,
    JSON.stringify(states.map((s) => ({ sl: s.scrollLeft, gap: s.gapRight, w: s.blockW }))));
  const reserve = states.every((s) => s.gapRight >= Math.max(0, s.blockW / 5 - 2));
  ok('T8 右侧留白 ≥ 1/5 片段宽度', reserve,
    JSON.stringify(states.map((s) => ({ gap: s.gapRight, need: Math.round(s.blockW / 5) }))));

  console.log('\n--- T9. 无脚本错误 / 无业务写入 ---');
  ok('T9 无 JS pageerror', errors.length === 0, errors.join(' | '));
  ok('T9 无业务写入（新增仅改本地草稿）', writes.length === 0, writes.join(' | '));

  await browser.close();
  console.log(`\n=== v3.49 UI: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
