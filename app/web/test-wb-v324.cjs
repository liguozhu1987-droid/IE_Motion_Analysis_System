/**
 * v3.24 顶栏信息架构重整专项验证：
 *  A. 三分区导航：业务区（集团看板/产线总览/改善任务）｜配置区（主数据/动作标准库）｜系统区（系统管理▾）
 *  B. 「系统管理」下拉：设置中心/用户管理/修改密码 归口；点外关闭/Esc 关闭；条目可跳转
 *  C. 命名同步：产线总览 h1、面包屑、集团看板 h1
 *  D. userchip：改密入口收进下拉，仅留 退出
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SHOT_DIR = 'D:/Application/IE_Improvement_Platform/deliverables/v324';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 200) : '')); }
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
  }, loginJson.refreshToken);

  // ========== A. 产线总览页顶栏 ==========
  await page.goto(WEB + '/#/stations', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.topbar .nav', { timeout: 20000 }).catch(() => {});
  await sleep(800);

  const nav = await page.evaluate(() => {
    const el = document.querySelector('.topbar .nav');
    if (!el) return null;
    const links = Array.from(el.querySelectorAll(':scope > a')).map((a) => ({ text: a.textContent.trim(), active: a.classList.contains('active') }));
    const seps = el.querySelectorAll('.nav-sep').length;
    const btn = el.querySelector('.nav-drop-btn');
    const brand = (document.querySelector('.brand') || {}).textContent || '';
    const chip = (document.querySelector('.userchip') || {}).textContent || '';
    return { links, seps, hasDrop: !!btn, dropText: btn ? btn.textContent.trim() : null, brand, chip };
  });
  if (!nav) {
    const diag = await page.evaluate(() => ({
      topbar: !!document.querySelector('.topbar'),
      body: document.body.textContent.slice(0, 200),
    }));
    console.log('  诊断:', JSON.stringify(diag));
  }
  ok('A1 导航三分区（2 条分隔线）', nav && nav.seps === 2, nav && nav.seps);
  ok('A2 业务区前三项：集团看板/产线总览/改善任务',
    JSON.stringify(nav.links.slice(0, 3).map((l) => l.text)) === JSON.stringify(['集团看板', '产线总览', '改善任务']), JSON.stringify(nav.links));
  ok('A3 产线总览当前高亮', nav.links.find((l) => l.text === '产线总览')?.active === true);
  ok('A4 配置区：主数据/动作标准库',
    JSON.stringify(nav.links.slice(-2).map((l) => l.text)) === JSON.stringify(['主数据', '动作标准库']), JSON.stringify(nav.links.slice(-2)));
  ok('A5 「系统管理」下拉按钮存在', nav.hasDrop && /系统管理/.test(nav.dropText || ''), nav.dropText);
  ok('A6 brand 过时副标题已移除', !/v3\.10|AI赋能|RBAC/.test(nav.brand || ''), nav.brand);
  ok('A7 userchip 已收掉「改密」（归口系统管理）', !/改密/.test(nav.chip || ''), nav.chip);

  const h1 = await page.evaluate(() => (document.querySelector('.page-head h1') || {}).textContent || '');
  ok('C1 产线总览页 h1 同步改名', h1 === '产线总览', h1);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v324-01-topbar-stations.png') });

  // ========== B. 系统管理下拉 ==========
  await page.click('.nav-drop-btn');
  await sleep(300);
  let menu = await page.evaluate(() => {
    const m = document.querySelector('.nav-drop-menu');
    if (!m) return null;
    const items = Array.from(m.querySelectorAll('a')).map((a) => a.textContent.trim().split('\n')[0]);
    const r = m.getBoundingClientRect();
    return { items, inViewport: r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight, hrefs: Array.from(m.querySelectorAll('a')).map((a) => a.getAttribute('href')) };
  });
  ok('B1 下拉打开且含设置中心/用户管理/修改密码',
    !!menu && /设置中心/.test(menu.items.join()) && /用户管理/.test(menu.items.join()) && /修改密码/.test(menu.items.join()), JSON.stringify(menu && menu.items));
  ok('B2 下拉完全在视口内（不漂移）', menu && menu.inViewport);
  domSnap('sys-menu', menu);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v324-02-sysmenu-open.png') });

  /* 点外部关闭 */
  await page.mouse.click(400, 400);
  await sleep(250);
  let gone = await page.evaluate(() => !document.querySelector('.nav-drop-menu'));
  ok('B3 点击外部关闭下拉', gone);

  /* Esc 关闭 */
  await page.click('.nav-drop-btn');
  await sleep(200);
  await page.keyboard.press('Escape');
  await sleep(250);
  gone = await page.evaluate(() => !document.querySelector('.nav-drop-menu'));
  ok('B4 Esc 关闭下拉', gone);

  /* 下拉项跳转 → 设置中心 */
  await page.click('.nav-drop-btn');
  await sleep(250);
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('.nav-drop-menu a')).find((x) => /设置中心/.test(x.textContent));
    a && a.click();
  });
  await sleep(800);
  const settingsState = await page.evaluate(() => ({
    hash: window.location.hash,
    h1: (document.querySelector('.page-head h1') || {}).textContent || '',
    dropActive: document.querySelector('.nav-drop-btn.active') != null,
  }));
  ok('B5 下拉项跳转设置中心成功', settingsState.hash === '#/settings' && /设置中心/.test(settingsState.h1), JSON.stringify(settingsState));
  ok('B6 系统管理按钮高亮（子页激活态）', settingsState.dropActive);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v324-03-settings-via-menu.png') });

  // ========== C. 集团看板页 ==========
  await page.goto(WEB + '/#/dashboard', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1200);
  const dash = await page.evaluate(() => ({
    h1: (document.querySelector('.page-head h1') || {}).textContent || '',
    crumb: (document.querySelector('.crumb') || {}).textContent || '',
    dashActive: Array.from(document.querySelectorAll('.topbar .nav > a')).some((a) => a.textContent.trim() === '集团看板' && a.classList.contains('active')),
  }));
  ok('C2 集团看板 h1 同步改名', /集团看板/.test(dash.h1), dash.h1);
  ok('C3 面包屑根为「集团看板」', /集团看板/.test(dash.crumb), dash.crumb);
  ok('C4 集团看板导航高亮', dash.dashActive);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v324-04-dashboard.png') });

  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
  fs.writeFileSync(path.join(SHOT_DIR, 'v324-dom.json'), JSON.stringify(domLog, null, 2));
  console.log('\n===== v324 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
