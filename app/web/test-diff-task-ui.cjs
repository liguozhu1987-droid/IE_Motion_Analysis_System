/**
 * Phase 3 / Wave 3 · #107 `#/diff` 跨任务对比 真人 Chrome UI 验证（A-107-3）
 * ------------------------------------------------------------
 * 前置：API(3001 生产 mssql) + Vite dev(5173)。
 * 夹具：新建工位 {line}-ST96 + T1(baseline, active, v1/v2 各一套要素)
 *       + T2(kaizen_after, archived, baseline_task_id=T1, 无要素)。
 * 断言：任务下拉为自绘 SelectMenu（零原生 select）/ B 侧选带基准任务自动带上 A 侧基准 /
 *       切换任务后 DOM 差异表真实刷新 / 基准提示出现与消失 / 无 JS pageerror。
 *       跑完按名清理测试任务与工位（FK 倒序）。
 *
 *   node test-diff-task-ui.cjs
 */
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
process.env.NO_PROXY = '127.0.0.1,localhost';

const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://127.0.0.1:3001/api';
const WEB = 'http://127.0.0.1:5173';
const SHOT = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 自绘 SelectMenu：按 aria-label 打开触发器，再点 portal 浮层里匹配文本的选项 */
const pickSelect = async (page, ariaLabel, text) => {
  const opened = await page.evaluate((label) => {
    const t = [...document.querySelectorAll('.sm-trigger')]
      .find((n) => n.getAttribute('aria-label') === label && !n.disabled);
    if (!t) return false;
    t.click();
    return true;
  }, ariaLabel);
  if (!opened) return false;
  await sleep(250);
  const hit = await page.evaluate((needle) => {
    const o = [...document.querySelectorAll('.sm-menu .sm-option')]
      .find((n) => (n.textContent || '').includes(needle));
    if (!o) return false;
    o.click();
    return true;
  }, text);
  await sleep(900);
  return hit;
};

/** 受控 API 调用（夹具） */
const apiCall = async (method, p, token, body) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

const BASE_ELEMENTS = [
  { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA', rating: 1, allowance: 0.15, outlier_flag: 0, outlier_reason: '' },
  { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA', rating: 1, allowance: 0.15, outlier_flag: 0, outlier_reason: '' },
  { seq: 3, start_ms: 6000, dur_s: 2.5, hand: 'R', type: '寻找', desc: '目视寻找料件', va_class: 'RNVA', rating: 1, allowance: 0.15, outlier_flag: 0, outlier_reason: '' },
  { seq: 4, start_ms: 8500, dur_s: 2.0, hand: 'L', type: '可避免延迟', desc: '等上件', va_class: 'NVA', rating: 1, allowance: 0.15, outlier_flag: 0, outlier_reason: '' },
];

/** 清理：按 station_id 级联 + 按任务名前缀（FK 倒序） */
const cleanupAll = async (stationId) => {
  require(require.resolve('dotenv', { paths: [path.join(__dirname, '..', 'api')] }))
    .config({ path: path.join(__dirname, '..', 'api', '.env') });
  const sql = require(require.resolve('mssql', { paths: [path.join(__dirname, '..', 'api')] }));
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });
  const tables = [
    't_ai_waste_finding', 't_ai_waste_issue', 't_ai_suggestion', 't_ai_suggestion_batch',
    't_ai_waste_batch', 't_improvement', 't_element', 't_station_collaborator',
    't_task_station', 't_station',
  ];
  for (const t of tables) {
    await pool.request().input('sid', sql.NVarChar, stationId).query(`DELETE FROM ${t} WHERE station_id = @sid`).catch(() => {});
  }
  await pool.request().input('name', sql.NVarChar, 'Phase3UI-Diff%').query(`
    DELETE FROM t_element WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE name LIKE @name);
    DELETE FROM t_task_station WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE name LIKE @name);
    DELETE FROM t_decomposition_task WHERE name LIKE @name;`).catch(() => {});
  await pool.close();
};

(async () => {
  const lr = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('admin 登录失败：' + JSON.stringify(login));
  const token = login.accessToken;

  /* ── 夹具 ── */
  const stList = (await apiCall('GET', '/stations', token)).data;
  const lineId = String(stList[0].line_id);
  const stationId = `${lineId}-ST96`;
  await cleanupAll(stationId);
  const st = await apiCall('POST', '/stations', token, { station_id: stationId, line_id: lineId, name: 'Phase3UI-Diff工位', tt: 40 });
  if (st.status !== 201) throw new Error('建工位失败：' + JSON.stringify(st.data));
  const t1r = await apiCall('POST', '/tasks', token, { line_id: lineId, name: 'Phase3UI-Diff基准', round_type: 'baseline', station_ids: [stationId] });
  const t2r = await apiCall('POST', '/tasks', token, { line_id: lineId, name: 'Phase3UI-Diff改善后', round_type: 'kaizen_after', station_ids: [stationId] });
  if (t1r.status !== 201 || t2r.status !== 201) throw new Error('建任务失败');
  const t1 = t1r.data.task_id, t1no = t1r.data.task_no, t2 = t2r.data.task_id;
  /* T2 归档：默认模式（自动继承）只能看到唯一生效任务 T1，否则 409 */
  require(require.resolve('dotenv', { paths: [path.join(__dirname, '..', 'api')] }))
    .config({ path: path.join(__dirname, '..', 'api', '.env') });
  const sql0 = require(require.resolve('mssql', { paths: [path.join(__dirname, '..', 'api')] }));
  const pool0 = await sql0.connect({
    user: process.env.DB_USER, password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });
  await pool0.request().input('tid', sql0.NVarChar, t2).input('bid', sql0.NVarChar, t1)
    .query(`UPDATE t_decomposition_task SET status = 'archived', baseline_task_id = @bid WHERE task_id = @tid`);
  await pool0.close();
  const v1 = await apiCall('POST', `/stations/${stationId}/elements/submit`, token, { task_id: t1, cycle_count: 15, cv: 0.05, elements: BASE_ELEMENTS });
  const re = await apiCall('POST', `/stations/${stationId}/retest`, token, {});
  const v2els = BASE_ELEMENTS.slice(0, 3).map((e, i) => ({ ...e, dur_s: 2.0 + i * 0.5 }));
  const v2 = await apiCall('POST', `/stations/${stationId}/elements/submit`, token, { task_id: t1, cycle_count: 15, cv: 0.05, elements: v2els });
  if (v1.status !== 201 || re.status !== 201 || v2.status !== 201) throw new Error(`夹具要素失败 ${v1.status}/${re.status}/${v2.status}`);
  console.log(`夹具：${stationId} · T1=${t1no}(${t1}) · T2=${t2}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1366,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));

  try {
    await page.evaluateOnNewDocument((rt) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);

    await page.goto(`${WEB}/?b=${Date.now()}#/diff/${encodeURIComponent(stationId)}/1/2`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.diffp', { timeout: 30000 });
    await sleep(1200);

    ok('U1 页面加载：版本 Diff 打开且任务下拉（自绘 SelectMenu）出现', await page.evaluate(() => {
      const labels = ['A 侧任务', 'B 侧任务'];
      return labels.every((l) => [...document.querySelectorAll('.sm-trigger')].some((n) => n.getAttribute('aria-label') === l));
    }));

    ok('U2 全页零原生 <select>（铁律）', await page.evaluate(() => document.querySelectorAll('select').length === 0,
    ));

    const snap = () => page.evaluate(() => ({
      body: document.querySelector('.diffp-table tbody')?.textContent || '',
      rows: document.querySelectorAll('.diffp-table tbody tr').length,
      del: document.querySelectorAll('.dp-state.del').length,
      add: document.querySelectorAll('.dp-state.add').length,
      mod: document.querySelectorAll('.dp-state.mod-n').length,
      ct: (document.querySelector('.diffp-ct')?.textContent || ''),
    }));

    const d0 = await snap();
    ok('U3 兼容模式自动继承唯一生效任务 T1（D1 旧行为不变）：差异表 4 行（3 改数值 + 1 删除）',
      d0.rows === 4 && d0.mod === 3 && d0.del === 1 && d0.body.includes('手持住扶壳体'), JSON.stringify(d0).slice(0, 200));

    /* B 侧选带基准的任务 T2（无要素）→ A 侧自动带基准 T1 + 基准提示 + DOM 刷新为全删除态 */
    ok('U4 B 侧选「改善后」任务成功（自绘下拉交互）',
      await pickSelect(page, 'B 侧任务', 'Diff改善后'));
    const d1 = await snap();
    ok('U5 切换任务后 DOM 差异表真实刷新（B 侧清空 → 全部为删除态）',
      d1.body !== d0.body && d1.del === 4 && d1.mod === 0 && d1.rows === 4, JSON.stringify(d1).slice(0, 200));
    ok('U6 baseline_task_id 复用：A 侧自动带上基准任务', await page.evaluate((no) => {
      const a = [...document.querySelectorAll('.sm-trigger')]
        .find((n) => n.getAttribute('aria-label') === 'A 侧任务');
      return a && (a.textContent || '').includes(no);
    }, t1no));
    ok('U7 基准提示出现（B 侧基准）', await page.evaluate(() =>
      (document.querySelector('.diffp-versions')?.textContent || '').includes('B 侧基准')));

    /* B 侧改选 T1（有 v1/v2 两版）→ 完整差异表 */
    ok('U8 B 侧改选基准任务 T1 成功', await pickSelect(page, 'B 侧任务', 'Diff基准'));
    const d2 = await snap();
    ok('U9 两任务上下文齐备：差异表恢复 4 行（3 改数值 + 1 删除）',
      d2.rows === 4 && d2.del === 1 && d2.add === 0 && d2.mod === 3,
      JSON.stringify(d2).slice(0, 200));
    ok('U10 CT 汇总头呈现 v1→v2 与 ΔCT', /12\.08s.*8\.63s|→/.test(d2.ct), d2.ct.slice(0, 120));
    ok('U11 选回 T1 后基准提示消失（B 侧无 baseline_task_id）', await page.evaluate(() =>
      !(document.querySelector('.diffp-versions')?.textContent || '').includes('B 侧基准')));

    await page.screenshot({ path: path.join(SHOT, 'diff-task-mode.png') });

    ok('U12 全程无 JS pageerror', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
    await cleanupAll(stationId).catch((e) => console.log('    清理失败（需人工）: ' + e.message));
  }

  console.log(`\nDiff 任务 UI（A-107-3）：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
})();
