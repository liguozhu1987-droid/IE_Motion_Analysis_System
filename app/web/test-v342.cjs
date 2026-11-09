/**
 * v3.42 UI 测试：工位 CRUD 入口 + 个人工作台视角 + 共享协作 + 综合看板改名。
 *
 * 链路：
 *  A. viewer1（无 station:write）：默认「我的」视角、无「全部」页签、卡片无编辑/删除/共享按钮、顶栏含「综合看板」；
 *  B. ie1（L01-ST02 editor 协作者）：共享给我可见锁螺丝 + 共享来源标记、无删除/共享按钮；
 *  C. admin：三页签齐全（我的/共享给我/全部）、删除一次性工位全链（弹窗→确认→列表消失）、
 *     共享弹窗授权 viewer1（API 回验协作者落库）、编辑弹窗打开。
 *
 * 前置：API(3001) + vite dev(5173)；seed 态（L01-ST01/02 owner=u_admin，ST02 协作者 u_ie1）。
 * 用法：node test-v342.cjs
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(username) {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' }),
  });
  const j = await r.json();
  if (!j.accessToken) throw new Error(username + ' login failed: ' + r.status);
  return j;
}

const pageText = (page) => page.evaluate(() => document.body.innerText);
const clickBtnByText = (page, re, scope = 'button') => page.evaluate((reSrc, scope) => {
  const rx = new RegExp(reSrc);
  const root = scope === 'all' ? document : document.querySelectorAll(scope)[0]?.parentElement || document;
  const els = [...document.querySelectorAll('button')].filter((b) => rx.test(b.textContent.trim()));
  if (els.length === 0) return false;
  els[0].click();
  return true;
}, re.source || String(re), scope);

(async () => {
  /* 前置 API 登录（拿 refreshToken 注入）+ 造一次性删除工位（先清上轮残留保证幂等） */
  const admin = await apiLogin('admin');
  const viewer = await apiLogin('viewer1');
  const ie = await apiLogin('ie1');

  await fetch(API + '/stations/L01-ST77', { method: 'DELETE', headers: { authorization: 'Bearer ' + admin.accessToken } }).catch(() => {});
  // 一次性删除工位（admin 建，测后删除全链验证）
  const st77 = await fetch(API + '/stations', {
    method: 'POST', headers: { authorization: 'Bearer ' + admin.accessToken, 'content-type': 'application/json' },
    body: JSON.stringify({ station_id: 'L01-ST77', line_id: 'L01', name: 'v342一次性工位', tt: 40 }),
  });
  ok('前置：L01-ST77 创建成功', st77.status === 200 || st77.status === 201, st77.status);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: 300000,
  });
  const errors = [];

  const newPage = async (refreshToken) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    page.on('response', (r) => { if (/collaborators/.test(r.url())) console.log('  [net]', r.status(), r.request().method(), r.url().replace(WEB, '')); });
    await page.evaluateOnNewDocument((rt) => {
      // 无条件覆写：同浏览器多页签共享 localStorage，必须覆盖前一账号的 token
      localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
    }, refreshToken);
    // 就绪信号：App 在 user 就绪后才拉 /api/stations → 先挂监听再导航（warm cache 下请求可能先于 goto 完成）
    const respP = page.waitForResponse((r) => /\/api\/stations(\?|$)/.test(r.url()) && r.status() === 200, { timeout: 30000 });
    await page.goto(`${WEB}/?b=${Date.now()}#/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await respP;
    await page.waitForSelector('.row.tight', { timeout: 15000 });
    await sleep(1000);
    return page;
  };

  try {
    /* ── A. viewer1：只读视角 ── */
    console.log('\n[A] viewer1 只读视角');
    const pv = await newPage(viewer.refreshToken);
    const navV = await pv.evaluate(() => [...document.querySelectorAll('nav a, .nav a')].map((a) => a.textContent.trim()));
    ok('顶栏含「综合看板」（改名+全角色开放）', navV.includes('综合看板'), navV.join('/'));
    ok('旧名「集团看板」已消失', !navV.includes('集团看板'), navV.join('/'));
    const tabsV = await pv.evaluate(() => [...document.querySelectorAll('.row.tight button')].map((b) => b.textContent.trim()).filter((t) => /^我的|^共享给我|^全部/.test(t)));
    ok('普通用户仅两个视角页签（无全部）', tabsV.length === 2 && tabsV.some((t) => t.startsWith('我的')) && tabsV.some((t) => t.startsWith('共享给我')), tabsV.join('/'));
    const btnsV = await pv.evaluate(() => [...document.querySelectorAll('.card button')].map((b) => b.textContent.trim()));
    ok('viewer 卡片无编辑/删除/共享按钮', !btnsV.includes('删除') && !btnsV.includes('编辑') && !btnsV.includes('共享'), JSON.stringify(btnsV.slice(0, 6)));
    await pv.close();

    /* ── B. ie1：协作者视角 ── */
    console.log('\n[B] ie1 协作者视角');
    const pi = await newPage(ie.refreshToken);
    // 默认「我的」：ie1 名下无工位
    const h1Mine = await pi.evaluate(() => (document.querySelector('.page-head h1') || {}).textContent || '');
    ok('ie1 默认「我的工作台」视角', h1Mine === '我的工作台', h1Mine);
    // 切共享给我
    await pi.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('共享给我'));
      b && b.click();
    });
    await pi.waitForFunction(() => [...document.querySelectorAll('.page-head h1')].some((h) => h.textContent === '共享给我')
      && [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('锁螺丝')), { timeout: 15000 });
    const h1Shared = '共享给我';
    ok('切「共享给我」视角', h1Shared === '共享给我', h1Shared);
    const cardTexts = await pi.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.textContent.slice(0, 60)));
    ok('共享给我含「锁螺丝」（L01-ST02 editor 授权）', cardTexts.some((t) => t.includes('锁螺丝')), JSON.stringify(cardTexts));
    const hasSharedTag = await pi.evaluate(() => !!document.querySelector('.card .tag[title="共享给我的工位"]'));
    ok('共享来源标记存在', hasSharedTag, '');
    const btnsI = await pi.evaluate(() => [...document.querySelectorAll('.card button')].map((b) => b.textContent.trim()));
    ok('editor 协作者无删除/共享按钮（仅 owner/admin）', !btnsI.includes('删除') && !btnsI.includes('共享'), JSON.stringify(btnsI));
    await pi.close();

    /* ── C. admin：全量视角 + 删除/共享/编辑全链 ── */
    console.log('\n[C] admin 全量视角 + CRUD 全链');
    const pa = await newPage(admin.refreshToken);
    const tabsA = await pa.evaluate(() => [...document.querySelectorAll('.row.tight button')].map((b) => b.textContent.trim()).filter((t) => /^我的|^共享给我|^全部/.test(t)));
    ok('admin 三页签（我的/共享给我/全部）', tabsA.length === 3, tabsA.join('/'));
    const h1A = await pa.evaluate(() => (document.querySelector('.page-head h1') || {}).textContent || '');
    ok('admin 默认「产线总览」（全部视角）', h1A === '产线总览', h1A);

    // 切到 L01 产线（下拉选 L01）——如果当前线不是 L01
    await pa.evaluate(() => {
      const sel = [...document.querySelectorAll('.page-head select')][0];
      if (sel && ![...sel.options].some((o) => o.selected && o.value === 'L01')) {
        const opt = [...sel.options].find((o) => o.value === 'L01');
        if (opt) { sel.value = 'L01'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
    await sleep(600);

    const st77Card = await pa.waitForFunction(() => {
      const c = [...document.querySelectorAll('.card')].find((x) => x.textContent.includes('v342一次性工位'));
      return c || null;
    }, { timeout: 10000 }).then((h) => h.asElement());
    ok('全部视角含一次性工位卡片', !!st77Card, '');

    // 删除全链：点删除 → 弹窗 → 确认
    await pa.evaluate(() => {
      const card = [...document.querySelectorAll('.card')].find((x) => x.textContent.includes('v342一次性工位'));
      const del = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除');
      del.click();
    });
    await pa.waitForFunction(() => document.body.innerText.includes('确认删除工位？'), { timeout: 5000 });
    ok('删除确认弹窗（级联影响清单）', true);
    await pa.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '确认删除');
      b.click();
    });
    await pa.waitForFunction(() => {
      const s = (document.querySelector('.success-banner') || {}).textContent || '';
      return /已删除工位/.test(s);
    }, { timeout: 15000 });
    // 列表经 stations:changed 异步刷新 → 条件等卡片元素消失（banner 文案含工位名，不能用 body 文本判）
    await pa.waitForFunction(() => ![...document.querySelectorAll('.card')].some((c) => c.textContent.includes('v342一次性工位')), { timeout: 15000 });
    ok('删除成功：banner + 卡片消失', true);

    // 共享全链：L01-ST01 共享给 viewer1 → API 回验
    await pa.evaluate(() => {
      const card = [...document.querySelectorAll('.card')].find((x) => x.textContent.includes('上壳装配'));
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '共享');
      btn.click();
    });
    await pa.waitForSelector('.share-dlg', { timeout: 5000 });
    ok('共享弹窗打开（共享与协作）', true);
    // 选 viewer1 + viewer 角色 → 授权（React select 须用原型 setter 绕过值追踪器，否则 onChange 被抑制）
    // 用户列表为异步拉取：必须先等目标 option 出现，否则赋值落到空 select 上被静默忽略（竞态）
    const setSelect = async (aria, val) => {
      await pa.waitForFunction((aria, val) => {
        const sel = document.querySelector('.share-dlg')?.querySelector(`select[aria-label="${aria}"]`);
        return !!sel && [...sel.options].some((o) => o.value === val);
      }, { timeout: 10000, polling: 200 }, aria, val);
      await pa.evaluate((aria, val) => {
        const dlg = document.querySelector('.share-dlg');
        const sel = dlg.querySelector(`select[aria-label="${aria}"]`);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, val);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, aria, val);
    };
    await setSelect('选择用户', 'u_viewer1');
    await setSelect('选择角色', 'viewer');
    await sleep(200);
    await pa.evaluate(() => {
      const dlg = document.querySelector('.share-dlg');
      const b = [...dlg.querySelectorAll('button')].find((x) => /授权/.test(x.textContent));
      b.click();
    });
    await sleep(1200);
    // API 回验协作者落库
    const colR = await fetch(API + '/stations/L01-ST01/collaborators', { headers: { authorization: 'Bearer ' + admin.accessToken } });
    const colJ = await colR.json();
    const hasViewer = (colJ ?? []).some((c) => c.user_id === 'u_viewer1' && c.acl_role === 'viewer');
    if (!hasViewer) console.log('  [diag] 弹窗现场:', await pa.evaluate(() => (document.querySelector('.share-dlg') || { textContent: '(已关)' }).textContent.slice(0, 200)));
    ok('UI 授权 → t_station_collaborator 落库（u_viewer1/viewer）', hasViewer, JSON.stringify(colJ).slice(0, 200));
    // 清理：移除授权（恢复 seed 态）
    await fetch(API + '/stations/L01-ST01/collaborators/u_viewer1', { method: 'DELETE', headers: { authorization: 'Bearer ' + admin.accessToken } });

    // 编辑弹窗：向导编辑模式
    await pa.evaluate(() => {
      const dlgX = document.querySelector('.share-dlg')?.parentElement?.querySelector('[aria-label="关闭"]');
      dlgX && dlgX.click();
    });
    await sleep(400);
    await pa.evaluate(() => {
      const card = [...document.querySelectorAll('.card')].find((x) => x.textContent.includes('上壳装配'));
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '编辑');
      btn.click();
    });
    await pa.waitForFunction(() => document.body.innerText.includes('编辑工位 · L01-ST01'), { timeout: 5000 });
    ok('编辑弹窗打开（向导编辑模式，标题含工位编码）', true);
    await pa.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '取消');
      b && b.click();
    });
    await pa.close();

    /* pageerror 汇总 */
    ok('无页面 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('执行异常:', e.message); process.exit(1); });
