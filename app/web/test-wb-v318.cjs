/**
 * v3.18 分解工作台布局与行程专项验证（用户反馈 4 项）：
 *  ① 动作要素移入结构化描述区首位（对象录入框之前，更紧凑）
 *  ② 「完成·下一个」按钮移到原预览位置；预览取消，组合结果只显示在标题（描述框）
 *  ③ 行程部位化：拿取=对象/位置/距离(选填)+部位分段；转身=角度；弯腰=程度；走动=步数
 *  ④ 下拉漂移修复：自定义下拉 position:fixed 锚定，滚动检查器时跟随按钮不漂移
 * 另验证弯腰新类型可选、VA 自动判定、Ctrl+Enter 快捷键不回归。
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在自定义下拉中选择指定类型（菜单可能需内部滚动） */
async function pickType(page, type) {
  await page.click('.wb-tsel-btn');
  await sleep(280);
  await page.evaluate((t) => {
    const o = Array.from(document.querySelectorAll('.wb-tsel-o')).find((x) => x.textContent.trim() === t);
    o?.scrollIntoView({ block: 'nearest' });
  }, type);
  await sleep(140);
  await page.evaluate((t) => {
    const o = Array.from(document.querySelectorAll('.wb-tsel-o')).find((x) => x.textContent.trim() === t);
    o?.click();
  }, type);
  await sleep(420);
}

/** 聚焦结构化字段输入框并键入 */
async function fillField(page, fieldName, text) {
  await page.evaluate((fn) => {
    const labels = Array.from(document.querySelectorAll('.wb-sec .wb-sd label.wb-field'));
    const l = labels.find((x) => (x.querySelector('span') || {}).firstChild?.textContent?.trim() === fn);
    l?.querySelector('input')?.focus();
  }, fieldName);
  await page.keyboard.type(text);
  await sleep(120);
}

/** 清空描述框：既有要素带手写描述时自动写入不覆盖（手改优先），清空后才走自动组合 */
async function clearDesc(page) {
  await page.click('.wb-desc');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(200);
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
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, refreshToken);
  await page.goto(WEB + '/#/workbench/' + sid, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.wb-tl .block', { timeout: 20000 });
  await sleep(500);
  (await page.$('.wb-tl .block')).click();
  await page.waitForSelector('.wb-insp-head', { timeout: 15000 });
  await sleep(500);
  // 先选「拿取」：保证有标准格式字段（对象/位置/距离），布局断言才完整
  await pickType(page, '拿取');

  // ========== ① 布局：动作要素置首于结构化描述区 ==========
  const r1 = await page.evaluate(() => {
    const insp = document.querySelector('.wb-inspector');
    const head = insp.querySelector('.wb-insp-head');
    const sd = insp.querySelector('.wb-sec');
    const typeCell = sd.querySelector('.wb-sd-type');
    const objLabel = Array.from(sd.querySelectorAll('label.wb-field')).find((l) => (l.textContent || '').includes('对象'));
    return {
      headHasSelect: !!head.querySelector('select'),
      nativeSelAnywhere: !!document.querySelector('.wb-type-sel'),
      typeCellFirst: !!typeCell && Array.from(sd.querySelector('.wb-sd').children).indexOf(typeCell) === 0,
      typeBeforeObj: !!typeCell && !!objLabel && (typeCell.compareDocumentPosition(objLabel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      typeLabel: (typeCell.querySelector('span') || {}).textContent || '',
      tselBtn: !!sd.querySelector('.wb-tsel-btn'),
      previewGone: !document.querySelector('.wb-sd-preview'),
      foot: !!sd.querySelector('.wb-insp-foot.sd'),
      footText: (sd.querySelector('.wb-insp-foot.sd') || {}).textContent || '',
      footAfterFields: (() => {
        const foot = sd.querySelector('.wb-insp-foot.sd');
        const fields = sd.querySelector('.wb-sd');
        return !!foot && !!fields && (fields.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      })(),
    };
  });
  ok('1a 头部行已无类型下拉（类型移出）', !r1.headHasSelect && !r1.nativeSelAnywhere);
  ok('1b 动作要素位于结构化描述区开头首位', r1.typeCellFirst);
  ok('1c 动作要素在「对象」录入框之前', r1.typeBeforeObj);
  ok('1d 字段标签为「动作要素」', r1.typeLabel.trim() === '动作要素');
  ok('1e 类型控件为自定义下拉按钮', r1.tselBtn);
  ok('2a 预览行已取消（同内容不多处显示）', r1.previewGone);
  ok('2b 「完成·下一个」按钮在结构化描述区下方（原预览位）', r1.foot && r1.footAfterFields && r1.footText.includes('完成·下一个'));

  // ========== ③ 自定义下拉：展开 / 分组 / 选项 ==========
  await page.click('.wb-tsel-btn');
  await sleep(300);
  const r2 = await page.evaluate(() => {
    const menu = document.querySelector('.wb-tsel-menu');
    return {
      open: !!menu,
      fixed: menu ? getComputedStyle(menu).position === 'fixed' : false,
      groups: Array.from(document.querySelectorAll('.wb-tsel-h')).map((h) => h.textContent.trim()),
      optionCount: document.querySelectorAll('.wb-tsel-o').length,
      hasBend: Array.from(document.querySelectorAll('.wb-tsel-o')).some((o) => o.textContent.trim() === '弯腰'),
      currentOn: ((document.querySelector('.wb-tsel-o.on') || {}).textContent || '').trim(),
    };
  });
  ok('3a 点击展开自定义下拉', r2.open);
  ok('3b 弹窗 position:fixed 锚定（不随文档流漂移）', r2.fixed);
  // v3.19 起：分组头只属于"有二级"的分组（消除"两个拿取、有一个选不了"）；无二级的一级直接作为选项
  ok('3c 分组头只属于有二级的分组；经典动素兼容组仍在', r2.groups.includes('移动') && !r2.groups.includes('拿取') && r2.groups.some((g) => g.includes('经典动素')), r2.groups.join(','));
  ok('3d 选项 ≥40 类且含新类型「弯腰」', r2.optionCount >= 40 && r2.hasBend);
  ok('3e 当前类型高亮', r2.currentOn.length > 0);

  // ========== ④ 漂移修复：滚动检查器，弹窗跟随按钮 ==========
  const rel0 = await page.evaluate(() => {
    const b = document.querySelector('.wb-tsel-btn').getBoundingClientRect();
    const m = document.querySelector('.wb-tsel-menu').getBoundingClientRect();
    return { dx: m.left - b.left, dy: m.top - b.bottom };
  });
  await page.evaluate(() => {
    const insp = document.querySelector('.wb-inspector');
    insp.scrollTop = Math.min(60, insp.scrollHeight - insp.clientHeight);
  });
  await sleep(280);
  const rel1 = await page.evaluate(() => {
    const b = document.querySelector('.wb-tsel-btn').getBoundingClientRect();
    const m = document.querySelector('.wb-tsel-menu') ? document.querySelector('.wb-tsel-menu').getBoundingClientRect() : null;
    return m ? { dx: m.left - b.left, dy: m.top - b.bottom } : null;
  });
  ok('4a 滚动检查器时弹窗仍展开且跟随按钮（不漂移）', !!rel1 && Math.abs(rel1.dx - rel0.dx) <= 1 && Math.abs(rel1.dy - rel0.dy) <= 1);
  await page.keyboard.press('Escape');
  await sleep(250);
  const esc = await page.evaluate(() => ({
    menuGone: !document.querySelector('.wb-tsel-menu'),
    stillSelected: !!document.querySelector('.wb-insp-head'),
  }));
  ok('4b Esc 只关下拉、不取消要素选中', esc.menuGone && esc.stillSelected);

  // ========== ⑤ 弯腰：程度分段 + VA 自动判定 + 自动写入 ==========
  await pickType(page, '弯腰');
  const r5 = await page.evaluate(() => {
    const sd = document.querySelector('.wb-sec');
    const spans = Array.from(sd.querySelectorAll('.wb-sd .wb-field > span')).map((s) => (s.firstChild || {}).textContent?.trim());
    const segs = Array.from(sd.querySelectorAll('.wb-sd .wb-seg')).map((sg) => Array.from(sg.querySelectorAll('button')).map((b) => b.textContent.trim()));
    const vaOn = ((document.querySelector('.wb-seg.va button.on') || {}).textContent || '').trim();
    return {
      value: ((document.querySelector('.wb-tsel-btn .wb-tsel-v') || {}).textContent || '').trim(),
      spans, segs, vaOn,
      reachRow: !!sd.querySelector('.wb-sd-reach'),
    };
  });
  ok('5a 下拉可选中新类型「弯腰」', r5.value === '弯腰');
  ok('5b 弯腰字段 = 对象 + 程度', r5.spans.includes('对象') && r5.spans.includes('程度'));
  ok('5c 程度分段 = 浅弯/深弯/蹲起', r5.segs.some((s) => s.includes('浅弯') && s.includes('深弯') && s.includes('蹲起')));
  ok('5d 弯腰不使用部位行程行', !r5.reachRow);
  ok('5e 弯腰 VA 自动判定 RNVA', r5.vaOn === 'RNVA');
  await clearDesc(page);
  await fillField(page, '对象', '料箱');
  await page.evaluate(() => {
    const seg = Array.from(document.querySelectorAll('.wb-sec .wb-sd .wb-seg')).find((sg) => Array.from(sg.querySelectorAll('button')).some((b) => b.textContent === '深弯'));
    Array.from(seg.querySelectorAll('button')).find((b) => b.textContent === '深弯')?.click();
  });
  await sleep(420);
  const r5d = await page.evaluate(() => ({ desc: document.querySelector('.wb-desc').value }));
  ok('5f 弯腰描述自动写入标题处「弯腰 料箱 深弯」', r5d.desc === '弯腰 料箱 深弯');

  // ========== ⑥ 拿取：部位行程 + 距离选填 + 组合描述 ==========
  await pickType(page, '拿取');
  const r6 = await page.evaluate(() => {
    const sd = document.querySelector('.wb-sec');
    const spans = Array.from(sd.querySelectorAll('.wb-sd .wb-field > span')).map((s) => (s.firstChild || {}).textContent?.trim());
    const reach = Array.from(sd.querySelectorAll('.wb-sd-reach .wb-seg button')).map((b) => b.textContent.trim());
    return {
      spans, reach,
      optTag: !!sd.querySelector('.wb-sd-opt'),
      distFixed: Array.from(sd.querySelectorAll('label.wb-field')).some((l) => l.className.includes('wb-sd-dist')),
      prepTag: Array.from(sd.querySelectorAll('.wb-sd-prep-tag')).map((t) => t.textContent),
    };
  });
  ok('6a 拿取字段 = 对象/位置/距离', r6.spans.includes('对象') && r6.spans.includes('位置') && r6.spans.includes('距离'));
  ok('6b 位置带介词角标「于」', r6.prepTag.includes('于'));
  ok('6c 距离为选填（角标提示，不强制量）', r6.optTag && r6.distFixed);
  ok('6d 部位行程 = 手指/手腕/小臂/大臂/肩', r6.reach.length === 5 && r6.reach.includes('手腕') && r6.reach.includes('小臂') && r6.reach.includes('大臂'));
  await clearDesc(page);
  await fillField(page, '对象', '后横梁');
  await fillField(page, '位置', '料箱');
  await fillField(page, '距离', '150');
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.wb-sd-reach .wb-seg button')).find((b) => b.textContent === '手腕')?.click();
  });
  await sleep(420);
  const r6d = await page.evaluate(() => ({ desc: document.querySelector('.wb-desc').value }));
  ok('6e 拿取描述 = 「拿取 后横梁 于 料箱 150（手腕）」', r6d.desc === '拿取 后横梁 于 料箱 150（手腕）');

  // ========== ⑦ 转身 = 角度分段；走动 = 步数分段 ==========
  await pickType(page, '转身');
  const r7 = await page.evaluate(() => {
    const sd = document.querySelector('.wb-sec');
    const segs = Array.from(sd.querySelectorAll('.wb-sd .wb-seg')).map((sg) => Array.from(sg.querySelectorAll('button')).map((b) => b.textContent.trim()));
    return { segs, reachRow: !!sd.querySelector('.wb-sd-reach'), vaOn: ((document.querySelector('.wb-seg.va button.on') || {}).textContent || '').trim() };
  });
  ok('7a 转身角度分段 = 90°/180°/360°/多圈', r7.segs.some((s) => s.includes('90°') && s.includes('180°') && s.includes('360°')));
  ok('7b 转身无部位行程行', !r7.reachRow);
  ok('7c 转身 VA 自动判定 NVA', r7.vaOn === 'NVA');

  await pickType(page, '走动');
  const r7b = await page.evaluate(() => {
    const sd = document.querySelector('.wb-sec');
    const segs = Array.from(sd.querySelectorAll('.wb-sd .wb-seg')).map((sg) => Array.from(sg.querySelectorAll('button')).map((b) => b.textContent.trim()));
    return { segs };
  });
  ok('7d 走动步数分段 = 1步/2步/3步以上', r7b.segs.some((s) => s.includes('1步') && s.includes('2步') && s.includes('3步以上')));

  // ========== ⑧ 快捷键不回归：Ctrl+Enter ==========
  await page.click('.wb-desc');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await sleep(400);
  const r8 = await page.evaluate(() => ({ flash: ((document.querySelector('.wb-toast-flash') || {}).textContent || '') }));
  ok('8 Ctrl+Enter = 完成·下一个仍生效', r8.flash.includes('已记录'));

  ok('9 无 JS 错误', jsErrors.length === 0);
  await page.screenshot({ path: 'D:/Application/IE_Improvement_Platform/deliverables/screenshots/v318-sd-type-first.png' });
  ok('10 截图已保存 v318-sd-type-first.png', true);

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
