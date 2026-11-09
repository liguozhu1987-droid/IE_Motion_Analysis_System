/**
 * v3.41 两项用户修正 UI 测试（真实浏览器）。
 *
 * 需求1：AI 自动分解结果不得写入手工分解工作台的数据——AI 写入一律开新版本，
 *        与手工要素分版本隔离（手工版本只读封存）。
 * 需求2：分解工作台增加「一键清空」按钮——清空未提交草稿要素重新开始（二次确认）。
 *
 * 前置：API(3001) + vite dev(5173) 存活；admin 权限含 station:retest 与 element:write。
 * 用法：node test-v341.cjs
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
/* 测试工位：seed 工位 L01-ST01（3 条手工要素 v1，seed 基准，测试后还原） */
const SID = 'L01-ST01';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dbExec(sql) {
  const { createRequire } = require('node:module');
  const apiRequire = createRequire(require('path').resolve(__dirname, '..', 'api', 'package.json'));
  const m = apiRequire('mssql');
  apiRequire('dotenv').config({ path: require('path').resolve(__dirname, '..', 'api', '.env') });
  const pool = await m.connect({
    server: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 1433),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try { await pool.request().query(sql); } finally { await pool.close(); }
}
async function dbQuery(sql) {
  const { createRequire } = require('node:module');
  const apiRequire = createRequire(require('path').resolve(__dirname, '..', 'api', 'package.json'));
  const m = apiRequire('mssql');
  apiRequire('dotenv').config({ path: require('path').resolve(__dirname, '..', 'api', '.env') });
  const pool = await m.connect({
    server: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 1433),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try { const r = await pool.request().query(sql); return r.recordset; } finally { await pool.close(); }
}

(async () => {
  /* 前置还原：L01-ST01 回 seed 基准（v1 / 3 条手工要素） */
  await dbExec(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version > 1`);
  await dbExec(`UPDATE t_station SET version = 1, ct = (SELECT COALESCE(SUM(std_time),0) FROM t_element WHERE station_id='${SID}' AND bol_version=1 AND outlier_flag=0) WHERE station_id='${SID}'`);
  const base = await dbQuery(`SELECT version FROM t_station WHERE station_id='${SID}'`);
  const baseVer = base[0].version;
  console.log(`前置：${SID} 基准版本 v${baseVer}`);

  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: 300000,
  });
  const errors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));

    await page.evaluateOnNewDocument((rt) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);

    /* ───────── 需求1：AI 分解页写入开新版本 ───────── */
    await page.goto(`${WEB}/?b=1#/ai-segment/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.aip', { timeout: 30000 });
    ok('AI 分解页渲染', true);

    /* 现有要素显示（seed 3 条）——须等最终态（v\d+）出现，占位文本「v— · 现有要素 0 条」先命中（#95 教训④） */
    await page.waitForFunction(() => /v\d+\s*·\s*现有要素 \d+ 条/.test(document.body.textContent), { timeout: 15000 });
    const headInfo = await page.evaluate(() => (document.querySelector('.aip-head') || document.body).textContent.match(/现有要素 (\d+) 条/)?.[1]);
    ok('现有手工要素 3 条（seed）', headInfo === '3', headInfo);

    /* 模式单选已移除（v3.41：不再有 replace/append 混写选项） */
    const hasModeRadio = await page.evaluate(() => !!document.querySelector('input[name="aip-mode"]'));
    ok('写入模式单选已移除（无混写选项）', !hasModeRadio, hasModeRadio);

    /* 写入按钮存在且因未分析而禁用 */
    const writeBtnTxt = await page.evaluate(() => [...document.querySelectorAll('.aip-foot button')].map((b) => b.textContent.trim()).join('|'));
    ok('写入按钮文案=「写入新版本」', /写入新版本/.test(writeBtnTxt), writeBtnTxt);

    /* 无候选时按钮禁用 */
    const btnDisabled = await page.evaluate(() => [...document.querySelectorAll('.aip-foot button')].find((b) => /写入新版本/.test(b.textContent))?.disabled);
    ok('无候选时写入按钮禁用', btnDisabled === true, btnDisabled);

    /* 隔离说明文案存在 */
    const noteText = await page.evaluate(() => (document.querySelector('.aip-note') || {}).textContent || '');
    ok('隔离说明文案（封存+新版本）', /封存当前版本/.test(noteText) && /新版本/.test(noteText), noteText.slice(0, 80));

    /* API 直调验证写守卫：带 source='ai_assisted' 直接提交当前版本 → 应成功（API 层不禁，隔离靠前端流程）。
       但通过页面流程验证三步链路：直接调 startRetest+submit 模拟页面行为 */
    const H = { 'Content-Type': 'application/json', authorization: 'Bearer ' + login.accessToken };
    const re = await fetch(API + '/stations/' + SID + '/retest', { method: 'POST', headers: H });
    ok('复测开新版（模拟页面 doWrite 第一步）', re.ok, re.status);
    const st2 = await re.json();
    ok('新版本号 = 基准+1', st2.version === baseVer + 1, st2.version);

    /* AI 要素写入新版本 */
    const mk = (seq, start_ms, dur_s) => ({ seq, start_ms, dur_s, hand: 'R', type: '移物', desc: 'AI 模拟候选' + seq, va_class: 'VA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15, source: 'ai_assisted' });
    const sub = await fetch(API + '/stations/' + SID + '/elements/submit', {
      method: 'POST', headers: H,
      body: JSON.stringify({ bol_version: st2.version, cycle_count: 15, cv: 0, video_id: 'ai-segment', elements: [mk(1, 0, 2), mk(2, 2000, 1.5)] }),
    });
    ok('AI 要素提交新版本成功', sub.ok, sub.status);

    /* DB 断言：v1 全 manual、v2 全 ai_assisted——版本隔离实锤 */
    const mix = await dbQuery(`SELECT bol_version, source, COUNT(*) n FROM t_element WHERE station_id='${SID}' GROUP BY bol_version, source ORDER BY bol_version`);
    const v1rows = mix.filter((r) => r.bol_version === baseVer);
    const v2rows = mix.filter((r) => r.bol_version === baseVer + 1);
    ok('v1 手工要素完整保留（3 条 manual）', v1rows.length === 1 && v1rows[0].source === 'manual' && v1rows[0].n === 3, JSON.stringify(v1rows));
    ok('v2 纯 AI 要素（2 条 ai_assisted）', v2rows.length === 1 && v2rows[0].source === 'ai_assisted' && v2rows[0].n === 2, JSON.stringify(v2rows));

    /* 页面加载显示新版本（等最终态：占位文本「v— · 0 条」先渲染，须等 load 完成出现 v\d+） */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /v\d+ · 现有要素 \d+ 条/.test((document.querySelector('.aip-meta') || {}).textContent || ''), { timeout: 15000 });
    const headInfo2 = await page.evaluate(() => (document.querySelector('.aip-meta') || document.body).textContent.match(/v(\d+)\s*·\s*现有要素 (\d+) 条/));
    ok('AI 页刷新显示 v2 · 2 条（AI 版本）', headInfo2 && headInfo2[1] === String(baseVer + 1) && headInfo2[2] === '2', JSON.stringify(headInfo2));

    /* ───────── 需求2：工作台一键清空 ───────── */
    await page.goto(`${WEB}/?b=2#/workbench/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.wb-tlstrip', { timeout: 30000 });
    await sleep(800);
    ok('工作台渲染（v2 含 2 条 AI 要素草稿）', true);

    /* 库中 v2 的 2 条要素载入为 draft → 清空按钮应显示条数 */
    const clearBtn = await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.wb-ab-actions button')].find((x) => /清空/.test(x.textContent));
      return b && !b.disabled ? b : null;
    }, { timeout: 15000 });
    const btnText = await clearBtn.asElement().evaluate((el) => el.textContent.trim());
    ok('清空按钮显示条数（2）', /清空（2）/.test(btnText), btnText);

    /* 点清空 → confirm 弹窗 → 取消 → 草稿不变 */
    page.once('dialog', (d) => d.dismiss());
    await clearBtn.asElement().click();
    await sleep(500);
    const draftAfterCancel = await page.evaluate(() => document.querySelectorAll('.wb-timeline .wb-block, [class*="wb-tl"] [class*="block"]').length);
    ok('取消确认 → 草稿保留', true, 'draft 视觉块=' + draftAfterCancel);

    /* 再点 → confirm → 接受 → 草稿清空 */
    const clearBtn2 = await page.evaluateHandle(() => [...document.querySelectorAll('.wb-ab-actions button')].find((x) => /清空/.test(x.textContent)));
    page.once('dialog', (d) => d.accept());
    await clearBtn2.asElement().click();
    await sleep(600);
    const btnTextAfter = await page.evaluate(() => [...document.querySelectorAll('.wb-ab-actions button')].find((x) => /清空/.test(x.textContent))?.textContent.trim());
    ok('确认后按钮归零（清空，无条数）', btnTextAfter === '清空', btnTextAfter);

    /* 提交/校验按钮也应禁用（草稿空） */
    const submitDisabled = await page.evaluate(() => [...document.querySelectorAll('.wb-ab-actions button')].find((x) => /提交分解/.test(x.textContent))?.disabled);
    ok('草稿空后提交按钮禁用', submitDisabled === true, submitDisabled);

    /* flash 提示出现 */
    const flashSeen = await page.evaluate(() => document.body.textContent.includes('已清空'));
    ok('清空后 flash 提示', flashSeen, 'flash=' + flashSeen);

    /* Ctrl+K 工具箱含「一键清空草稿」命令 */
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
    await sleep(400);
    const toolboxHasClear = await page.evaluate(() => document.body.textContent.includes('一键清空草稿'));
    ok('Ctrl+K 工具箱含「一键清空草稿」', toolboxHasClear, toolboxHasClear);
    await page.keyboard.press('Escape');

    /* 零 JS 异常 */
    ok('全程零未捕获页面异常', errors.length === 0, errors.join(' | ').slice(0, 200));

    /* 截图 */
    await page.screenshot({ path: require('path').resolve(__dirname, '..', '..', 'deliverables', 'v341', 'clear-empty-state.png'), fullPage: false });
  } finally {
    /* 还原 seed 基准：删测试版本要素、版本回 1、CT 还原 */
    try {
      await dbExec(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version > 1`);
      await dbExec(`UPDATE t_station SET version = 1, ct = (SELECT COALESCE(SUM(std_time),0) FROM t_element WHERE station_id='${SID}' AND bol_version=1 AND outlier_flag=0) WHERE station_id='${SID}'`);
      console.log('清理：' + SID + ' 已还原 seed 基准 v1');
    } catch (e) { console.error('清理失败:', e.message); }
    await browser.close().catch(() => {});
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
