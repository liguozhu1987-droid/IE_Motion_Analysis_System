/**
 * v3.20 录入加速与提示治理专项验证（IE 动作经济落地）：
 *  A. 动作要素下拉：模糊检索（中文子串/拼音首字母/口语别名）+ 命中高亮 + 分组语义不回退
 *  B. 手动录入自动归类：「转身180」→ 转身+角度180°；「搬运料箱到工位」→ 移物+对象回填
 *  C. 频次智能排序：选过的类型进「常用」区，高频置顶（localStorage 记频）
 *  D. typeahead 零点击：聚焦类型框直接敲字母即打开检索；全局单键快捷键让位（按 n 不加要素）
 *  E. 校验横幅：× 手动关闭 + 10s 自动消失 + 容器点击穿透（不遮挡操作区）
 *  F. 快捷工具箱：Ctrl+K 唤起 → 输入过滤 → 回车执行（删除 → 撤销删除闭环）
 *  G. 布局不回退：下拉/工具箱弹出不改变监看区尺寸
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

/** React 受控输入框赋值（native setter + input 事件，绕过合成事件合成值跟踪） */
async function setInputValue(page, selector, value) {
  return page.evaluate((sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, selector, value);
}

/** 读取下拉当前可见选项标签（含手动录入行） */
async function ddLabels(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim()));
}

/** 首个要素块句柄（实时重查） */
const firstBlock = (page) => page.$('.wb-tl .block');

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
  page.on('dialog', async (d) => { await d.dismiss(); });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);
  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(600);

  // ========== A. 模糊检索（首个下拉打开时无频次历史，顺带验分组语义不回退） ==========
  await (await firstBlock(page)).click();
  await page.waitForSelector('.wb-tsel-btn', { timeout: 10000 });
  await sleep(300);
  await page.click('.wb-tsel-btn');
  await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
  await sleep(250);
  const ddOpen = await page.evaluate(() => ({
    qFocused: document.activeElement === document.querySelector('.wb-tsel-q'),
    headers: Array.from(document.querySelectorAll('.wb-tsel-h')).map((h) => h.textContent.trim()),
    labels: Array.from(document.querySelectorAll('.wb-tsel-o')).map((o) => o.textContent.trim()),
  }));
  ok('下拉打开即聚焦检索框（打开即可打字）', ddOpen.qFocused);
  ok('分组语义不回退：无二级的一级不出分组头', !ddOpen.headers.includes('拿取') && !ddOpen.headers.includes('转身'));
  ok('有二级的分组保留分组头（移动/装配/操作/检查+经典动素）',
    ['移动', '装配', '操作', '检查'].every((h) => ddOpen.headers.includes(h)) && ddOpen.headers.length === 5, ddOpen.headers.join(','));
  ok('「拿取」仍只出现一次（常用区未污染首开）', ddOpen.labels.filter((l) => l === '拿取').length === 1);

  // 中文子串：「转身」→ 仅剩转身；「转」→ 转身（前缀）优先于翻转（子串）
  await setInputValue(page, '.wb-tsel-q', '转身');
  await sleep(200);
  const hit1 = await page.evaluate(() => ({
    labels: Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim()),
    mark: (document.querySelector('.wb-tsel-mark') || {}).textContent || '',
    manual: !!document.querySelector('.wb-tsel-manual'),
  }));
  ok('输入「转身」→ 选项收敛为 1 项', hit1.labels.length === 1 && hit1.labels[0] === '转身', hit1.labels.join(','));
  ok('命中子串高亮（mark=转身）', hit1.mark === '转身', hit1.mark);
  ok('精确同名不出现手动录入行', !hit1.manual);
  await setInputValue(page, '.wb-tsel-q', '转');
  await sleep(200);
  const hit2 = await ddLabels(page);
  ok('输入「转」→ 转身（前缀）排在翻转（子串）前', hit2[0] === '转身' && hit2.includes('翻转'), hit2.join(','));
  // 拼音首字母
  await setInputValue(page, '.wb-tsel-q', 'zs');
  await sleep(200);
  const hit3 = await ddLabels(page);
  ok('拼音首字母「zs」→ 直达转身', hit3.length === 1 && hit3[0] === '转身', hit3.join(','));
  // 车间口语别名
  await setInputValue(page, '.wb-tsel-q', '拧');
  await sleep(200);
  const hit4 = await ddLabels(page);
  ok('口语别名「拧」→ 直达装配', hit4.length === 1 && hit4[0] === '装配', hit4.join(','));
  // 回车选中（filtered 态 Enter 走 pick）
  await page.keyboard.press('Enter');
  await sleep(300);
  const pickedA = await page.evaluate(() => ({
    type: (document.querySelector('.wb-tsel-v') || {}).textContent || '',
    menuGone: !document.querySelector('.wb-tsel-menu'),
  }));
  ok('回车选中当前过滤项（装配）', pickedA.type === '装配' && pickedA.menuGone, pickedA.type);

  // ========== B. 手动录入自动归类 ==========
  await page.click('.wb-tsel-btn');
  await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
  await sleep(200);
  await setInputValue(page, '.wb-tsel-q', '转身180');
  await sleep(250);
  const manRow = await page.evaluate(() => {
    const el = document.querySelector('.wb-tsel-manual');
    const opts = Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim());
    return { text: el ? el.textContent.trim() : '', exists: !!el, verbOpt: opts.includes('转身'), first: opts[0] || '' };
  });
  ok('「转身180」给出录入行且识别动词为转身', manRow.exists && /识别为.{0,3}转身/.test(manRow.text), manRow.text);
  ok('录入行置顶 + 动词「转身」仍作为普通选项露出', manRow.first.includes('录入') && manRow.verbOpt, manRow.text.slice(0, 60));
  await page.click('.wb-tsel-manual');
  await sleep(400);
  const manRes1 = await page.evaluate(() => {
    const angleOn = Array.from(document.querySelectorAll('.wb-seg button')).find((b) => b.textContent.trim() === '180°' && b.classList.contains('on'));
    return {
      type: (document.querySelector('.wb-tsel-v') || {}).textContent || '',
      desc: (document.querySelector('.wb-desc') || {}).value || '',
      angleOn: !!angleOn,
    };
  });
  ok('录入「转身180」→ 类型=转身', manRes1.type === '转身', manRes1.type);
  ok('残留「180」回填角度字段（180° 选中）', manRes1.angleOn);
  ok('描述自动写入「转身 180°」', manRes1.desc.includes('180°'), manRes1.desc);

  await page.click('.wb-tsel-btn');
  await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
  await sleep(200);
  await setInputValue(page, '.wb-tsel-q', '搬运料箱到工位');
  await sleep(250);
  const manRow2 = await page.evaluate(() => {
    const el = document.querySelector('.wb-tsel-manual');
    return { text: el ? el.textContent.trim() : '', exists: !!el };
  });
  ok('「搬运…」经别名识别为移物', manRow2.exists && /移物/.test(manRow2.text), manRow2.text);
  await page.click('.wb-tsel-manual');
  await sleep(400);
  const manRes2 = await page.evaluate(() => ({
    type: (document.querySelector('.wb-tsel-v') || {}).textContent || '',
    desc: (document.querySelector('.wb-desc') || {}).value || '',
  }));
  ok('录入「搬运料箱到工位」→ 类型=移物', manRes2.type === '移物', manRes2.type);
  ok('残留「料箱到工位」回填对象字段并写入描述', manRes2.desc.includes('料箱到工位'), manRes2.desc);

  // ========== C. 频次智能排序 ==========
  // 当前历史：装配×1（A 回车）、转身×1（B 录入）、移物×1（B 录入）→ 再选 等待×1、转身×2
  await page.click('.wb-tsel-btn');
  await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
  await sleep(200);
  await setInputValue(page, '.wb-tsel-q', '等待');
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(300);
  for (let i = 0; i < 2; i++) {
    await page.click('.wb-tsel-btn');
    await page.waitForSelector('.wb-tsel-q', { timeout: 5000 });
    await sleep(150);
    await setInputValue(page, '.wb-tsel-q', '转身');
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(300);
  }
  await page.click('.wb-tsel-btn'); // 重开（空查询）看常用区
  await page.waitForSelector('.wb-tsel-menu', { timeout: 5000 });
  await sleep(250);
  const freqView = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('.wb-tsel-h')).map((h) => h.textContent.trim());
    const nav = Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim());
    const freq = JSON.parse(localStorage.getItem('wb-type-freq-v1') || '{}');
    return { headers, firstTwo: nav.slice(0, 2), zs: (freq['转身'] || {}).n ?? 0, dd: (freq['等待'] || {}).n ?? 0 };
  });
  ok('出现「常用 · 按你的使用频次」区', freqView.headers.some((h) => h.includes('常用')), freqView.headers.join(','));
  ok('常用区高频置顶（转身 3 次居首）', freqView.firstTwo[0] === '转身', freqView.firstTwo.join(','));
  ok('频次已入 localStorage（转身×3，含同值重选）', freqView.zs === 3, JSON.stringify(freqView));
  await page.keyboard.press('Escape');
  await sleep(200);

  // ========== D. typeahead 零点击 + 全局快捷键让位 ==========
  // 注意：要素可能仍处于选中态（前段操件未取消）——再点一次块 = 取消选中，先探再点
  const selBeforeD = await page.evaluate(() => !!document.querySelector('.wb-panel-sel'));
  if (!selBeforeD) await (await firstBlock(page)).click();
  await sleep(300);
  const draftBefore = await page.evaluate(() => document.querySelectorAll('.wb-tl .block').length);
  await page.evaluate(() => document.querySelector('.wb-tsel-btn')?.focus());
  await page.keyboard.press('KeyZ'); // 不点开，直接敲字母
  await sleep(300);
  const ta = await page.evaluate(() => ({
    open: !!document.querySelector('.wb-tsel-menu'),
    q: (document.querySelector('.wb-tsel-q') || {}).value || '',
    labels: Array.from(document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')).map((o) => o.textContent.trim()),
  }));
  ok('聚焦类型框敲「z」即打开检索（零点击）', ta.open && ta.q === 'z' && ta.labels.includes('转身'), JSON.stringify(ta));
  await page.keyboard.press('KeyN'); // 焦点仍在类型框：n 应进检索词，不触发"新增要素"
  await sleep(300);
  const ta2 = await page.evaluate(() => ({
    q: (document.querySelector('.wb-tsel-q') || {}).value || '',
    draft: document.querySelectorAll('.wb-tl .block').length,
  }));
  ok('类型检索期全局单键让位（按 n 不新增要素，只进检索词）', ta2.q === 'zn' && ta2.draft === draftBefore, `q=${ta2.q} draft=${ta2.draft}/${draftBefore}`);
  await page.keyboard.press('Escape'); // 关菜单，焦点回到类型按钮
  await sleep(200);
  const taAfterEsc = await page.evaluate(() => ({
    menuGone: !document.querySelector('.wb-tsel-menu'),
    selKept: !!document.querySelector('.wb-panel-sel'),
  }));
  ok('Esc 只关检索菜单（选中不丢）', taAfterEsc.menuGone && taAfterEsc.selKept, JSON.stringify(taAfterEsc));

  // ========== F. 快捷工具箱 ==========
  const draftBeforeTb = await page.evaluate(() => document.querySelectorAll('.wb-tl .block').length);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(350);
  const tbOpen = await page.evaluate(() => ({
    open: !!document.querySelector('.wb-tbx'),
    focused: document.activeElement === document.querySelector('.wb-tbx-q'),
    groups: Array.from(document.querySelectorAll('.wb-tbx-gh')).map((g) => g.textContent.trim()),
  }));
  ok('Ctrl+K 唤起工具箱且检索框聚焦', tbOpen.open && tbOpen.focused);
  ok('工具箱分组齐全（录入加速/播放与帧/要素结构/评定与交付）',
    ['录入加速', '播放与帧', '要素结构', '评定与交付'].every((g) => tbOpen.groups.includes(g)), tbOpen.groups.join(','));
  await setInputValue(page, '.wb-tbx-q', '删除');
  await sleep(250);
  const tbFiltered = await page.evaluate(() => Array.from(document.querySelectorAll('.wb-tbx-i')).map((i) => (i.querySelector('.wb-tbx-label') || {}).textContent || ''));
  ok('输入「删除」→ 过滤出删除选中要素（首位）/撤销删除', tbFiltered[0] === '删除选中要素' && tbFiltered.includes('撤销删除'), tbFiltered.join(','));
  await page.keyboard.press('Enter'); // 执行首位 = 删除选中要素
  await sleep(400);
  const afterDel = await page.evaluate(() => ({
    tbGone: !document.querySelector('.wb-tbx'),
    undoToast: !!document.querySelector('.wb-toast-undo'),
    draft: document.querySelectorAll('.wb-tl .block').length,
  }));
  ok('回车执行删除（工具箱关闭 + 出现撤销提示）', afterDel.tbGone && afterDel.undoToast);
  ok('删除生效（草稿 −1）', afterDel.draft === draftBeforeTb - 1, `${draftBeforeTb} → ${afterDel.draft}`);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(300);
  await setInputValue(page, '.wb-tbx-q', '撤销删除'); // 精确到标签（"撤销"会命中删除项的提示文案）
  await sleep(200);
  await page.keyboard.press('Enter');
  await sleep(400);
  const afterUndo = await page.evaluate(() => document.querySelectorAll('.wb-tl .block').length);
  ok('工具箱内「撤销删除」还原要素', afterUndo === draftBeforeTb, `${draftBeforeTb} vs ${afterUndo}`);
  await page.keyboard.press('Escape');
  await sleep(200);

  // ========== G. 布局不回退 ==========
  const selBeforeG = await page.evaluate(() => !!document.querySelector('.wb-panel-sel'));
  if (!selBeforeG) await (await firstBlock(page)).click();
  await sleep(300);
  const rectBefore = await page.evaluate(() => {
    const r = document.querySelector('.wb-screen').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  await page.click('.wb-tsel-btn');
  await sleep(300);
  const rectDropdown = await page.evaluate(() => {
    const r = document.querySelector('.wb-screen').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(300);
  const rectTb = await page.evaluate(() => {
    const r = document.querySelector('.wb-screen').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  await page.keyboard.press('Escape');
  await sleep(200);
  ok('下拉/工具箱弹出不改变监看区尺寸（视频不跳）',
    rectDropdown.w === rectBefore.w && rectDropdown.h === rectBefore.h && rectTb.w === rectBefore.w && rectTb.h === rectBefore.h,
    `${JSON.stringify(rectBefore)} dd=${JSON.stringify(rectDropdown)} tb=${JSON.stringify(rectTb)}`);

  // ========== E. 校验横幅：关闭 + 自动消失 + 点击穿透 ==========
  await page.goto(WEB + '/#/workbench/L01-ST02', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-more', { timeout: 20000 });
  await sleep(500);
  await page.click('.wb-more summary');
  await sleep(250);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.wb-more-menu button'));
    btns.find((x) => x.textContent.includes('开始复测'))?.click();
  });
  await sleep(500);
  const ban1 = await page.evaluate(() => {
    const b = document.querySelector('.wb-banner');
    const c = document.querySelector('.wb-toast-banners');
    return {
      visible: !!b && b.offsetParent !== null,
      text: b ? b.textContent.replace('×', '').trim() : '',
      closeBtn: !!document.querySelector('.wb-banner-x'),
      containerPE: c ? getComputedStyle(c).pointerEvents : '',
      bannerPE: b ? getComputedStyle(b).pointerEvents : '',
    };
  });
  ok('空版本复测被前端护栏拦截并出错误横幅', ban1.visible && /还没有任何要素/.test(ban1.text), ban1.text.slice(0, 60));
  ok('横幅带 × 关闭按钮', ban1.closeBtn);
  ok('容器点击穿透（pointer-events:none，横幅本体 auto）', ban1.containerPE === 'none' && ban1.bannerPE === 'auto', `${ban1.containerPE}/${ban1.bannerPE}`);
  await page.click('.wb-banner-x');
  await sleep(300);
  const banClosed = await page.evaluate(() => !document.querySelector('.wb-banner'));
  ok('点 × 手动关闭横幅', banClosed);
  // 自动消失（error ms=10000）
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.wb-more-menu button'));
    btns.find((x) => x.textContent.includes('开始复测'))?.click();
  });
  await sleep(400);
  const ban2Visible = await page.evaluate(() => !!document.querySelector('.wb-banner'));
  ok('重试后横幅重新出现', ban2Visible);
  await sleep(10600); // 等 10s 自动消失
  const banAuto = await page.evaluate(() => !document.querySelector('.wb-banner'));
  ok('10 秒后横幅自动消失（不常驻遮挡）', banAuto);

  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
