/**
 * v3.61+v3.62+Phase2 · 批量导出真人功能验证
 * （入口 → 弹窗 → 勾选 → 真实下载 → 文件读回 → 留档历史 → 复下载
 *   → 任务下拉/兼容模式 → 新建任务+基线复制 → 按任务导出 → 留档带任务号）
 * ------------------------------------------------------------
 * 前置：API(3001 生产 mssql) + Vite dev(5173)。
 * 断言：按钮可见 / 弹窗无原生 select / 工位可多选 / 无 JS 报错 / 导出阶段零写请求 /
 *       导出文件真实落盘且为 6 张 sheet / 顶部成功提示带服务端统计 /
 *       v3.62：留档历史列出本次导出 / 复下载真实落盘且内容完整 /
 *       Phase2：文件名+封面+各表信息区带任务号与时间段、任务锁定版本、基线复制不串源、
 *               新建任务只允许 POST /tasks 与 /clone-elements，跑完按名清理测试任务。
 *
 *   node test-batch-export-ui.cjs
 */
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
process.env.NO_PROXY = '127.0.0.1,localhost';

const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const path = require('node:path');
// exceljs 装在 app/api/node_modules（服务端生成库），web 侧不重复安装
const ExcelJS = require(require.resolve('exceljs', { paths: [path.join(__dirname, '..', 'api')] }));

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://127.0.0.1:3001/api';
const WEB = 'http://127.0.0.1:5173';
const SHOT = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
const DOWNLOAD = path.join(__dirname, '..', 'deliverables', 'part2', 'ui', 'downloads');
fs.mkdirSync(SHOT, { recursive: true });
fs.mkdirSync(DOWNLOAD, { recursive: true });
for (const f of fs.readdirSync(DOWNLOAD)) {
  if (f.endsWith('.xlsx') || f.endsWith('.crdownload')) fs.rmSync(path.join(DOWNLOAD, f), { force: true });
}

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickByText = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t);
  if (!b) return false;
  b.click();
  return true;
}, text);

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
  await sleep(350);
  return hit;
};

/** 受控 input 赋值：必须走原型 value setter + input 事件，否则 React 不认 */
const setInputs = (page, values) => page.evaluate((vals) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const set = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const ins = [...document.querySelectorAll('.be-create .be-input')];
  const text = ins.find((i) => i.type !== 'date');
  const dates = ins.filter((i) => i.type === 'date');
  if (text) set(text, vals.name);
  if (dates[0]) set(dates[0], vals.start);
  if (dates[1]) set(dates[1], vals.end);
  return true;
}, values);

/** UI 套件会在生产库创建一条测试任务，跑完按名清理（留档快照属审计资产，保留） */
const cleanupUiTask = async (name) => {
  try {
    require(require.resolve('dotenv', { paths: [path.join(__dirname, '..', 'api')] }))
      .config({ path: path.join(__dirname, '..', 'api', '.env') });
    const sql = require(require.resolve('mssql', { paths: [path.join(__dirname, '..', 'api')] }));
    const pool = await sql.connect({
      user: process.env.DB_USER, password: process.env.DB_PASS,
      server: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 1433),
      database: process.env.DB_NAME || 'CN_AME',
      options: { encrypt: false, trustServerCertificate: true },
    });
    const sub = `SELECT task_id FROM t_decomposition_task WHERE name LIKE @name`;
    await pool.request().input('name', sql.NVarChar, `${name}%`).query(`
      DELETE FROM t_element WHERE task_id IN (${sub});
      DELETE FROM t_task_station WHERE task_id IN (${sub});
      DELETE FROM t_decomposition_task WHERE name LIKE @name;`);
    await pool.close();
    console.log('    已清理 UI 测试任务及其要素快照');
  } catch (e) {
    console.log('    清理 UI 测试任务失败（需人工清理）：' + e.message);
  }
};

(async () => {
  const lr = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('admin 登录失败：' + JSON.stringify(login));

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1366,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));
  const writes = [];
  page.on('request', (req) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method()) && /\/api\//.test(req.url()) && !/\/api\/auth\//.test(req.url())) {
      writes.push(`${req.method()} ${req.url()}`);
    }
  });
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD });

  // token 条件注入（refresh 一次性轮换，无条件覆写会让第二文档 401 退登录）
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  console.log('\n--- 产线总览：批量导出入口 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/stations`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.page-head', { timeout: 30000 });
  await sleep(1200);

  const btn = await page.evaluate(() =>
    [...document.querySelectorAll('.page-head button')].some((b) => (b.textContent || '').trim() === '批量导出'));
  ok('T1 顶部工具条出现「批量导出」按钮', btn);

  ok('T2 点击后弹窗打开、显示固定 6 张 sheet 说明', await clickByText(page, '批量导出') && await (async () => {
    await page.waitForSelector('.be-dlg', { timeout: 10000 });
    await sleep(300);
    const txt = await page.$eval('.be-dlg', (n) => n.textContent || '');
    return txt.includes('批量导出') && txt.includes('封面') && txt.includes('增值非增值分析') && txt.includes('动作分析');
  })());

  const dialog = await page.evaluate(() => {
    const d = document.querySelector('.be-dlg');
    return {
      nativeSelects: d.querySelectorAll('select').length,
      rows: d.querySelectorAll('.be-row').length,
      checkboxes: d.querySelectorAll('input[type=checkbox]').length,
      selectMenu: d.querySelectorAll('.sm-trigger').length,
      text: d.textContent || '',
    };
  });
  ok('T3 弹窗内零原生 <select>（下拉走自绘 SelectMenu）', dialog.nativeSelects === 0, JSON.stringify(dialog));
  ok('T4 工位清单可见且可勾选', dialog.rows > 0 && dialog.checkboxes >= 3, JSON.stringify(dialog));
  ok('T5 焦点上限为自绘 SelectMenu', dialog.selectMenu >= 1);
  ok('T6 内容开关与预计行数齐备', /预计\s*6\s*个 sheet/.test(dialog.text) && dialog.text.includes('含异常要素'));

  /* ── Phase 2：任务模式（自绘任务下拉 / 任务信息 / 锁定版本） ── */
  const taskUi = await page.evaluate(() => {
    const d = document.querySelector('.be-dlg');
    const pick = d.querySelector('.be-task-pick');
    return {
      hasPick: !!pick,
      triggers: [...(pick?.querySelectorAll('.sm-trigger') ?? [])].map((n) => n.getAttribute('aria-label')),
      pickText: pick?.textContent ?? '',
      info: d.querySelector('.be-task-info')?.textContent ?? '',
      rowText: d.querySelector('.be-row')?.textContent ?? '',
      metaBold: d.querySelector('.be-meta b')?.textContent ?? '',
    };
  });
  ok('P1 导出范围出现「分解任务」自绘下拉且默认选中历史归集任务',
    taskUi.hasPick && taskUi.triggers.includes('分解任务') && /DT-LEGACY/.test(taskUi.pickText), JSON.stringify(taskUi));
  ok('P2 任务信息含轮次 / 状态 / 锁定工位数',
    /legacy/.test(taskUi.info) && /archived/.test(taskUi.info) && /锁定\s*\d+\s*工位/.test(taskUi.info), taskUi.info);
  ok('P3 工位行显示「锁定 vN」（任务锁定 bol_version）', /锁定\s*v\d+/.test(taskUi.rowText), taskUi.rowText);

  await page.screenshot({ path: path.join(SHOT, 'batch-export-dialog.png'), fullPage: false });
  console.log('    截图：' + path.join(SHOT, 'batch-export-dialog.png'));

  // 反选 → 全选，验证多选交互（同时避免空选导致导出按钮禁用）
  await clickByText(page, '反选');
  await sleep(150);
  const noneSelected = await page.$$eval('.be-row input[type=checkbox]', (ns) => ns.every((n) => !n.checked));
  ok('T7 「反选」清空选择且导出按钮禁用', noneSelected && await page.evaluate(() =>
    [...document.querySelectorAll('.be-foot button')].some((b) => b.textContent.includes('开始导出') && b.disabled)));
  await clickByText(page, '全选');
  await sleep(150);
  const allSelected = await page.$$eval('.be-row input[type=checkbox]', (ns) => ns.every((n) => n.checked));
  ok('T8 「全选」恢复全部工位', allSelected);

  console.log('\n--- 真实下载 ---');
  const exported = await clickByText(page, '开始导出');
  ok('T9 点击「开始导出」', exported);
  let file = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    const f = fs.readdirSync(DOWNLOAD).find((x) => x.endsWith('.xlsx'));
    if (f) { file = f; break; }
  }
  ok('T10 浏览器真实下载到 XLSX 文件', !!file, file || '超时未发现 .xlsx');
  if (file) {
    const p = path.join(DOWNLOAD, file);
    const buf = fs.readFileSync(p);
    ok('T11 文件名中文不乱码且为 ZIP(XLSX)', file.includes('VA分析') && buf.subarray(0, 2).toString('latin1') === 'PK', file);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    ok('T12 下载文件恰好 6 张 sheet', wb.worksheets.length === 6, wb.worksheets.map((w) => w.name).join(','));
    ok('T13 03 表四类时间独立成列', String(wb.getWorksheet('03_增值非增值分析').getRow(4).getCell(5).value) === '手作业(s)');
    // Phase 2：文件名 / 封面 / 各表信息区三处同现任务号与时间段（脱离系统仍可归档）
    ok('P4 浏览器下载文件名带任务号与时间段（服务端文件名未被前端覆盖）',
      /DT-LEGACY/.test(file) && /20261026/.test(file), file);
    const cover = wb.getWorksheet('00_封面');
    const cover7 = String(cover.getRow(7).getCell(2).value ?? '');
    const cover8 = String(cover.getRow(8).getCell(2).value ?? '');
    ok('P5 封面第 7/8 行标注任务号与轮次时间段',
      cover7.includes('DT-LEGACY') && cover8.includes('2026-10-26'), `${cover7} | ${cover8}`);
    const infoRows = ['01_工位汇总', '02_动作分解', '03_增值非增值分析', '04_动作分析']
      .map((n) => String(wb.getWorksheet(n).getRow(2).getCell(1).value ?? ''));
    ok('P6 四张数据表信息区均带任务号', infoRows.every((s) => s.includes('DT-LEGACY')), infoRows.map((s) => s.slice(0, 40)).join(' | '));
    console.log(`    文件：${p}（${buf.length} 字节）`);
  }

  await page.waitForSelector('.success-banner', { timeout: 10000 }).catch(() => {});
  const banner = await page.evaluate(() => document.querySelector('.success-banner')?.textContent ?? '');
  ok('T14 顶部提示带服务端统计（sheet/工位/要素/焦点）',
    /已导出\s*6\s*张 sheet/.test(banner) && banner.includes('工位') && banner.includes('焦点'), banner);

  ok('T15 无 JS pageerror（导出阶段）', errors.length === 0, errors.join(' | '));
  ok('T16 浏览器端零写请求（留档写库由服务端内部完成，不经前端）', writes.length === 0, writes.join(' | '));

  console.log('\n--- 留档历史与复下载（v3.62） ---');
  ok('T17 重开弹窗，留档历史列出本次导出（含统计）', await clickByText(page, '批量导出') && await (async () => {
    await page.waitForSelector('.be-dlg', { timeout: 10000 });
    await page.waitForSelector('.be-hist-row', { timeout: 15000 });
    await sleep(500);
    const rows = await page.$$eval('.be-hist-row', (ns) => ns.map((n) => n.textContent || ''));
    return rows.length > 0 && rows[0].includes('工位') && rows[0].includes('sheet');
  })());

  await page.screenshot({ path: path.join(SHOT, 'batch-export-history.png'), fullPage: false });
  console.log('    截图：' + path.join(SHOT, 'batch-export-history.png'));

  const reDl = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.be-hist-row button')]
      .filter((b) => (b.textContent || '').includes('复下载') && !b.disabled);
    if (!btns.length) return false;
    btns[0].click();
    return true;
  });
  ok('T18 点击「复下载」按钮', reDl);

  let reFile = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(400);
    const f = fs.readdirSync(DOWNLOAD).find((x) => x.startsWith('VA分析_复下载') && x.endsWith('.xlsx'));
    if (f) { reFile = f; break; }
  }
  ok('T19 复下载真实落盘（复下载_ 前缀文件名）', !!reFile, reFile || '超时未发现复下载文件');
  if (reFile) {
    const buf = fs.readFileSync(path.join(DOWNLOAD, reFile));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    ok('T20 复下载文件完整：ZIP + 6 张 sheet（快照语义）',
      buf.subarray(0, 2).toString('latin1') === 'PK' && wb.worksheets.length === 6,
      `${reFile} ${buf.length}B`);
    console.log(`    复下载文件：${path.join(DOWNLOAD, reFile)}（${buf.length} 字节）`);
  } else {
    ok('T20 复下载文件完整：ZIP + 6 张 sheet（快照语义）', false, '无文件');
  }

  ok('T21 全程无 JS pageerror', errors.length === 0, errors.join(' | '));
  ok('T22 全程浏览器端零写请求', writes.length === 0, writes.join(' | '));

  /* ═════════ Phase 2：任务切换 / 新建任务 / 基线复制 / 按任务导出 ═════════ */
  console.log('\n--- Phase 2：分解任务 UI 全链路 ---');
  const writesBefore = writes.length;
  const uiTaskName = `Phase2-UI测试-${Date.now()}`;
  let newTaskNo = '';
  try {
    ok('P7 切到「按产线兼容模式」出现风险提示且工位不再锁定任务版本',
      await pickSelect(page, '分解任务', '按产线兼容模式') && await (async () => {
        await sleep(400);
        const r = await page.evaluate(() => ({
          bold: document.querySelector('.be-meta b')?.textContent ?? '',
          row: document.querySelector('.be-row')?.textContent ?? '',
        }));
        return r.bold.includes('不区分任务') && !/锁定\s*v\d+/.test(r.row);
      })(), '切换后提示/工位行');

    ok('P8 切回历史归集任务后锁定版本恢复',
      await pickSelect(page, '分解任务', 'DT-LEGACY') && await (async () => {
        await sleep(400);
        const row = await page.evaluate(() => document.querySelector('.be-row')?.textContent ?? '');
        return /锁定\s*v\d+/.test(row);
      })(), '切回后工位行');

    ok('P9 「新建分解任务」展开表单：零原生 select、轮次/基线均自绘、含日期输入',
      await clickByText(page, '新建分解任务') && await (async () => {
        await page.waitForSelector('.be-create', { timeout: 5000 });
        return await page.evaluate(() => ({
          selects: document.querySelectorAll('.be-dlg select').length,
          labels: [...document.querySelectorAll('.be-create .sm-trigger')].map((n) => n.getAttribute('aria-label')),
          inputs: document.querySelectorAll('.be-create .be-input').length,
        })).then((s) => s.selects === 0 && s.labels.includes('轮次')
          && s.labels.includes('基线任务') && s.inputs >= 3);
      })(), '新建表单');

    await setInputs(page, { name: uiTaskName, start: '2026-11-01', end: '2026-11-30' });
    await sleep(250);
    ok('P10 表单正确填入任务名称与时间段', await page.evaluate((name) => {
      const ins = [...document.querySelectorAll('.be-create .be-input')];
      return ins.find((i) => i.type !== 'date')?.value === name
        && ins.filter((i) => i.type === 'date').every((i) => !!i.value);
    }, uiTaskName));

    ok('P11 基线任务选历史归集（自绘下拉）', await pickSelect(page, '基线任务', 'DT-LEGACY'));
    await page.screenshot({ path: path.join(SHOT, 'batch-export-task-create.png'), fullPage: false });
    console.log('    截图：' + path.join(SHOT, 'batch-export-task-create.png'));

    ok('P12 点击「创建并选中」：表单收起、新任务自动选中',
      await clickByText(page, '创建并选中') && await (async () => {
        for (let i = 0; i < 40; i += 1) {
          await sleep(300);
          const st = await page.evaluate(() => ({
            form: !!document.querySelector('.be-create'),
            text: document.querySelector('.be-task-pick')?.textContent ?? '',
          }));
          if (!st.form && /DT-\d{4}-\d{3}/.test(st.text)) return true;
        }
        return false;
      })(), '创建超时');

    newTaskNo = await page.evaluate(() =>
      (document.querySelector('.be-task-pick')?.textContent ?? '').match(/DT-\d{4}-\d{3}/)?.[0] ?? '');
    ok('P13 新任务号符合 DT-{YYYY}-{NNN}', /^DT-\d{4}-\d{3}$/.test(newTaskNo), newTaskNo || '未取到任务号');
    await page.screenshot({ path: path.join(SHOT, 'batch-export-task-mode.png'), fullPage: false });
    console.log('    截图：' + path.join(SHOT, 'batch-export-task-mode.png'));

    ok('P14 新任务工位显示锁定版本且基线要素已复制', await (async () => {
      await sleep(500);
      const row = await page.evaluate(() => document.querySelector('.be-row')?.textContent ?? '');
      return /锁定\s*v\d+/.test(row) && /[1-9]\d*\s*要素/.test(row);
    })(), '新任务工位行');

    ok('P15 按新任务执行导出', await clickByText(page, '开始导出'));
    let taskFile = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      const f = fs.readdirSync(DOWNLOAD).find((x) => newTaskNo && x.includes(newTaskNo) && x.endsWith('.xlsx'));
      if (f) { taskFile = f; break; }
    }
    ok('P16 任务模式导出文件名含新任务号', !!taskFile, taskFile || '超时未发现任务文件');
    if (taskFile) {
      const buf = fs.readFileSync(path.join(DOWNLOAD, taskFile));
      const wbt = new ExcelJS.Workbook();
      await wbt.xlsx.load(buf);
      const c7 = String(wbt.getWorksheet('00_封面').getRow(7).getCell(2).value ?? '');
      const c8 = String(wbt.getWorksheet('00_封面').getRow(8).getCell(2).value ?? '');
      ok('P17 新任务封面带任务号与填写的时间段',
        c7.includes(newTaskNo) && c8.includes('2026-11-01') && c8.includes('2026-11-30'), `${c7} | ${c8}`);
      ok('P18 新任务工作簿 6 sheet 且 02 表有要素行（基线复制生效）',
        wbt.worksheets.length === 6
        && String(wbt.getWorksheet('02_动作分解').getRow(5).getCell(1).value ?? '').includes('ST010'),
        wbt.worksheets.map((w) => w.name).join(','));
      console.log(`    任务模式文件：${path.join(DOWNLOAD, taskFile)}（${buf.length} 字节）`);
    } else {
      ok('P17 新任务封面带任务号与填写的时间段', false, '无文件');
      ok('P18 新任务工作簿 6 sheet 且 02 表有要素行（基线复制生效）', false, '无文件');
    }

    ok('P19 留档历史首行带新任务号', await clickByText(page, '批量导出') && await (async () => {
      await page.waitForSelector('.be-hist-row', { timeout: 15000 });
      await sleep(600);
      const rows = await page.$$eval('.be-hist-row', (ns) => ns.map((n) => n.textContent || ''));
      return rows.length > 0 && rows[0].includes(newTaskNo);
    })(), '留档首行');

    const newWrites = writes.slice(writesBefore);
    ok('P20 写请求仅来自新建任务与基线复制（导出/复下载仍为 GET）',
      newWrites.length === 2
      && newWrites.some((w) => w.startsWith('POST ') && /\/api\/tasks(\?|$)/.test(w))
      && newWrites.some((w) => w.includes('/clone-elements')),
      newWrites.join(' | '));
    ok('P21 Phase 2 全程无 JS pageerror', errors.length === 0, errors.join(' | '));
  } finally {
    await cleanupUiTask(uiTaskName);
  }

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => { console.error('UI 验证异常：', e); process.exitCode = 1; });
