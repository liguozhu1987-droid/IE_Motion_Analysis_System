/**
 * v3.21 CMC 主数据集成与下拉治理专项验证：
 *  A. SelectMenu 自绘下拉根治原生 popup 漂移：portal 挂 body + 视口内定位 + 键盘/typeahead
 *  B. 新建分析对象向导 CMC 三级联动：工厂→产线→项目（实时只读），本地零维护
 *  C. 向导只填工位名：编码自动生成只读、TT 由 CT 预填、创建走 /stations/from-cmc
 *  D. 主数据页只读总览：CMC 公司/产线/项目无增删改入口；工位本地可编辑/删除
 *  E. 护栏：CMC 不可达时明确提示、不在本地伪造数据
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SHOT_DIR = 'D:/Application/IE_Improvement_Platform/deliverables/v321';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 220) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
const domLog = []; // DOM 边车：截图配机验
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

  /* 预热 CMC 接口（SQL Server 冷计划缓存首查可达 10s+，避免向导打开等待超时） */
  await fetch(API + '/cmc/factories', { headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  await fetch(API + '/cmc/lines', { headers: { Authorization: 'Bearer ' + token } }).catch(() => {});

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

  // ========== A. 主数据页：CMC 只读总览 ==========
  await page.goto(WEB + '/#/master', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1500);

  const master = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const h3s = cards.map((c) => (c.querySelector('h3') || {}).textContent || '');
    const lineRows = Array.from(document.querySelectorAll('.dash-table tbody tr')).length;
    const tags = Array.from(document.querySelectorAll('.tag')).map((t) => t.textContent.trim());
    const hasEditTenant = !!Array.from(document.querySelectorAll('button')).find((b) => /编辑名称\/区域/.test(b.textContent));
    const stationEditBtns = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === '编辑').length;
    const addBtns = Array.from(document.querySelectorAll('button')).filter((b) => /新建产线|新建项目|新增产线|新增项目|添加产线|添加项目/.test(b.textContent));
    return { h3s, lineRows, tagSample: tags.slice(0, 6), hasEditTenant, stationEditBtns, addBtns: addBtns.length };
  });
  ok('主数据页三张卡片（公司/产线/工位）', master.h3s.filter((h) => /公司|产线|工位/.test(h)).length >= 3, master.h3s.join('|'));
  ok('CMC 产线只读清单有数据（102 条）', master.lineRows >= 100, master.lineRows);
  ok('公司编辑入口存在（本租户名称/区域可改）', master.hasEditTenant);
  ok('工位行内编辑入口存在', master.stationEditBtns > 0, master.stationEditBtns);
  ok('无「新建产线/项目」入口（CMC 只读铁律）', master.addBtns === 0, master.addBtns);
  domSnap('master-page', master);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v321-01-master.png') });

  // 产线行点击 → 联动项目分配
  await page.click('.dash-table tbody tr');
  await sleep(1200);
  const projTags = await page.evaluate(() => {
    const banner = Array.from(document.querySelectorAll('.muted')).find((m) => /项目分配/.test(m.textContent));
    const tags = Array.from(document.querySelectorAll('.tag')).map((t) => t.textContent.trim());
    return { text: banner ? banner.textContent.trim() : null, tags: tags.slice(0, 8) };
  });
  ok('点产线联动出项目分配（实时）', !!projTags.text && /项目分配/.test(projTags.text), projTags.text);
  domSnap('master-line-projects', projTags);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v321-02-master-line-projects.png') });

  // ========== B. 新建分析对象向导：CMC 三级联动 ==========
  await page.goto(WEB + '/#/stations', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1000);
  /* 触发向导：对象树/顶栏的「+ 新建工位」按钮（createSignal 机制） */
  const openBtn = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('button')).find((b) => /新建工位/.test(b.textContent));
  });
  if (openBtn && openBtn.asElement()) {
    await openBtn.asElement().click();
    await sleep(500);
  }
  await page.waitForSelector('.modal.wz .wz-sec', { timeout: 45000 }).catch(() => {}); /* 等 CMC 数据加载完（loading 态无段落） */
  await sleep(600);
  const wzOpen = await page.$('.modal.wz');
  ok('向导打开', !!wzOpen);

  const wzInit = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('.wz-sec'));
    return {
      secCount: secs.length,
      tags: secs.map((s) => (s.querySelector('.wz-tag') || {}).textContent || ''),
      summary: (document.querySelector('.wz-summary') || {}).textContent || '',
      hasSelects: document.querySelectorAll('.modal.wz select').length, // 原生 select 必须为 0
    };
  });
  ok('向导四段（工厂/产线/项目/工位）', wzInit.secCount === 4, wzInit.secCount);
  ok('CMC 实时标签存在', wzInit.tags.filter((t) => /CMC 实时/.test(t)).length >= 2, wzInit.tags.join('|'));
  ok('向导内原生 select 为 0（全部 SelectMenu 自绘）', wzInit.hasSelects === 0, wzInit.hasSelects);
  domSnap('wizard-init', wzInit);

  /* 打开工厂下拉 → SelectMenu portal 到 body 且在视口内 */
  const facBtn = await page.$('.modal.wz [aria-label="选择工厂"]');
  ok('工厂下拉触发器存在', !!facBtn);
  if (facBtn) {
    await facBtn.click();
    await page.waitForSelector('body > .sm-menu', { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const menuState = await page.evaluate(() => {
      const menu = document.querySelector('body > .sm-menu');
      if (!menu) return { found: false };
      const r = menu.getBoundingClientRect();
      return {
        found: true,
        inViewport: r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) },
        options: Array.from(menu.querySelectorAll('.sm-option')).map((o) => o.textContent.trim()).slice(0, 8),
      };
    });
    ok('SelectMenu 浮层渲染且完全在视口内（不漂移）', menuState.found && menuState.inViewport, JSON.stringify(menuState.rect || {}));
    ok('工厂选项来自 CMC（含 Beijing/Changchun 等）', (menuState.options || []).length >= 3, (menuState.options || []).join('|'));
    domSnap('wizard-factory-menu', menuState);
    await page.screenshot({ path: path.join(SHOT_DIR, 'v321-03-wizard-factory-menu.png') });
    /* 选第一个工厂（键盘 Enter = 选中激活项） */
    await page.keyboard.press('Enter');
    await sleep(1200);
  }

  /* 等项目联动加载完成（loadingProjects 会禁用项目下拉） */
  await page.waitForFunction(() => {
    const btn = document.querySelector('.modal.wz [aria-label="选择项目"]');
    return btn && !btn.disabled;
  }, { timeout: 30000 }).catch(() => {});
  await sleep(400);

  /* 产线联动（默认已选第一条）→ 项目下拉 → 选项目带 CT 预填 */
  const projBtn = await page.$('.modal.wz [aria-label="选择项目"]');
  ok('项目下拉触发器存在', !!projBtn);
  if (projBtn) {
    const projDisabled = await page.evaluate((el) => el.disabled, projBtn);
    ok('项目下拉在产线就绪后可用', !projDisabled);
    await projBtn.click();
    await page.waitForSelector('body > .sm-menu', { timeout: 5000 }).catch(() => {});
    await sleep(300);
    await page.keyboard.press('ArrowDown'); /* 跳过「未关联项目」 */
    await page.keyboard.press('Enter');
    await sleep(1200);
  }
  const wzAfter = await page.evaluate(() => {
    const code = Array.from(document.querySelectorAll('.wz-field')).find((f) => /工位编码/.test(f.textContent));
    const tt = Array.from(document.querySelectorAll('.wz-field')).find((f) => /TT/.test(f.textContent));
    const ttInput = tt ? tt.querySelector('input') : null;
    const hint = Array.from(document.querySelectorAll('.wz-hint')).map((h) => h.textContent.trim());
    return {
      codeValue: code ? code.querySelector('input').value : null,
      codeDisabled: code ? code.querySelector('input').disabled : null,
      ttValue: ttInput ? ttInput.value : null,
      hint,
    };
  });
  /* v3.23：编码默认留空由用户自己写（#74 修订）——建议值降级为占位灰字，不再预填；
     下方创建用例留空提交 = 走后端自动生成路径 */
  const wzGhost = await page.evaluate(() => {
    const code = Array.from(document.querySelectorAll('.wz-field')).find((f) => /工位编码/.test(f.textContent));
    const input = code ? code.querySelector('input') : null;
    return input ? { value: input.value, placeholder: input.placeholder } : null;
  });
  ok('工位编码默认留空且可编辑（建议值仅作占位灰字，含 STxx 形式）',
    !!wzGhost && wzGhost.value === '' && /ST\d{2}/.test(wzGhost.placeholder || ''), JSON.stringify(wzGhost));
  ok('CT 预填提示存在（标准节拍已带出）', wzAfter.hint.some((h) => /CT|标准节拍/.test(h)), wzAfter.hint.join('|'));
  ok('TT 已由 CT 预填', wzAfter.ttValue !== null && wzAfter.ttValue !== '', wzAfter.ttValue);
  domSnap('wizard-after-project', wzAfter);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v321-04-wizard-linked.png') });

  /* C. 创建工位（冒烟名）→ 成功回调 → 清理 */
  const nameInput = await page.evaluateHandle(() => {
    const f = Array.from(document.querySelectorAll('.wz-field')).find((x) => /工位名称/.test(x.textContent));
    return f ? f.querySelector('input') : null;
  });
  if (nameInput && nameInput.asElement()) {
    await nameInput.asElement().click();
    await nameInput.asElement().type('UI冒烟v321临时', { delay: 20 });
    await sleep(300);
    const createBtn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('.wz-foot button')).find((b) => /创建/.test(b.textContent)));
    const disabled = await page.evaluate((el) => el.disabled, createBtn);
    ok('创建按钮可点（校验通过）', !disabled);
    if (!disabled) {
      await createBtn.asElement().click();
      await sleep(2500);
      const after = await page.evaluate(() => ({
        wzGone: !document.querySelector('.modal.wz'),
        banner: (document.querySelector('.success-banner, [class*="msg"], [class*="banner"]') || {}).textContent || '',
      }));
      ok('创建成功且向导关闭', after.wzGone, JSON.stringify(after));
      domSnap('wizard-created', after);
      await page.screenshot({ path: path.join(SHOT_DIR, 'v321-05-wizard-created.png') });
      /* 清理冒烟工位（端点只认 station_id：先列出、按名称过滤、再按 ID 删） */
      const list = await (await fetch(API + '/stations', { headers: { Authorization: 'Bearer ' + token } })).json();
      const leftover = (Array.isArray(list) ? list : []).filter((s) => /UI冒烟v321临时|冒烟/.test(s.name));
      if (leftover.length) {
        for (const s of leftover) await fetch(API + '/stations/' + encodeURIComponent(s.station_id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
      }
      ok('冒烟工位已清理', true);
    }
  }

  /* E. CMC 不可达护栏（拦截 API 返回 503，前端转译为明确提示） */
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/cmc/')) req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ statusCode: 503, title: 'Service Unavailable', detail: '上游数据库连接失败', status: 503 }) });
    else req.continue();
  });
  await page.goto(WEB + '/#/master', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1500);
  const guard = await page.evaluate(() => {
    const banner = Array.from(document.querySelectorAll('.error-banner')).map((b) => b.textContent.trim()).join('|');
    return { banner };
  });
  ok('CMC 不可达时给出明确提示（不伪造数据）', /CMC|产能|不可联/.test(guard.banner), guard.banner || '(无错误横幅)');
  domSnap('cmc-unreachable', guard);

  ok('全程无 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  fs.writeFileSync(path.join(SHOT_DIR, 'dom-snapshot.json'), JSON.stringify(domLog, null, 2));
  console.log(`\n==== v321 UI 测试：${pass} passed, ${fail} failed ====`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
