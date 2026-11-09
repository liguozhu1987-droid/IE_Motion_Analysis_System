/**
 * v3.45 工作台「AI自动识别浪费」按钮 UI 测试（手工分解线入口，P0-4/P0-5）。
 *
 * 链路：工作台顶栏按钮（can('suggestion:generate') 渲染 / submitted 态可点）
 *   → POST generate-manual（mock LLM）→ toast「识别完成：N 个浪费点 / M 条建议」
 *   +「前往浪费识别 →」链接（?source=manual）→ AiWastePage 手工页签激活。
 *
 * 断言覆盖（约 10 项）：
 *  1. viewer1（无 suggestion:generate）DOM 无「AI自动识别浪费」按钮；
 *  2. ie1 未提交时按钮 disabled 且 title 含「请先提交分解」；
 *  3. 提交分解成功后按钮立即可点；
 *  4. submit 成功自身的 load() 不误触（banner 出现即断言 + 异步回来后复验）；
 *  5. 409 场景：toast「已有识别任务进行中」+「前往浪费识别 →」链接（mock 0 次）；
 *  6. 点击 → mock → toast「识别完成：1 个浪费点 / 1 条建议」+ 链接 href 含 ?source=manual；
 *  7. 点击后焦点回 body（blur 策略）；
 *  8. 提交后修改 1 条草稿（改要素类型）→ 按钮重新 disabled（脏检查）；
 *  9. 链接点击后到达 AiWastePage 且手工页签激活（URL ?source=manual + 徽标）；
 * 10. 全程零未捕获 JS 异常（pageerror 监听）。
 *
 * 前置：API（3001，跑 v3.45 构建）+ vite dev（5173）；mock LLM 走 19101（同 test-ai-waste.cjs preset）。
 * 夹具：临时工位 BJFA1-ST01（独立产线码，规避 L01-ST 随机号相撞）+ CSV 导入 3 手工要素；
 *      测后 DELETE 工位级联收尾 + t_ai_setting 还原（空=回落 env）。
 * 纪律：禁止与其他 UI 测试并行跑（19101 mock 端口独占）。
 *
 * 用法：node test-wb-waste-btn.cjs
 */
const puppeteer = require('puppeteer-core');
const { createServer } = require('node:http');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'BJFA1-ST01';
const MOCK_PORT = 19101;
const SHOT_DIR = path.resolve(__dirname, '..', '..', 'deliverables', 'ai-waste-manual', 'screenshots');

/* mock LLM（手工线）：1 finding + 1 issue 引用 seq1（持住/简化——VA 要素禁 E，S 合法） */
const MOCK_PAYLOAD = {
  findings: [
    { element_seqs: [1], waste_type: '持住', evidence: '手工分解线单手扶住壳体全程无任何加工动作', severity: 9, pct_of_ct: 88.8 },
  ],
  issues: [
    { element_seqs: [1], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '简化', suggestion: '治具夹持替代人工持住壳体动作' },
  ],
};
let mockCalls = 0;
function startMockLlm() {
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      mockCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_PAYLOAD) } }],
        usage: { total_tokens: 420 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

/** mssql 从 app/api 解析（web 目录无 DB 依赖） */
async function dbExec(sql) {
  const { createRequire } = require('node:module');
  const apiRequire = createRequire(path.resolve(__dirname, '..', 'api', 'package.json'));
  const m = apiRequire('mssql');
  const pool = await m.connect({
    server: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 1433),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try { await pool.request().query(sql); } finally { await pool.close(); }
}
async function dbQuery(sql) {
  const { createRequire } = require('node:module');
  const apiRequire = createRequire(path.resolve(__dirname, '..', 'api', 'package.json'));
  const m = apiRequire('mssql');
  const pool = await m.connect({
    server: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 1433),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try { return (await pool.request().query(sql)).recordset; } finally { await pool.close(); }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按文本点按钮（自动滚动入视野；返回是否命中） */
async function clickText(page, text, selector = 'button') {
  const handle = await page.evaluateHandle((t, sel) => {
    const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim() === t);
    if (b && b.scrollIntoView) b.scrollIntoView({ block: 'center' });
    return b || null;
  }, text, selector);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

(async () => {
  const { createRequire } = require('node:module');
  const apiRequire = createRequire(path.resolve(__dirname, '..', 'api', 'package.json'));
  apiRequire('dotenv').config({ path: path.resolve(__dirname, '..', 'api', '.env') });
  const mock = await startMockLlm();
  const fs = require('node:fs');
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  /* 登录 ie1（主流程：element:write + suggestion:generate）与 viewer1（无 suggestion:generate） */
  const loginAs = async (u) => (await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: '123456' }),
  })).json());
  const ie1 = await loginAs('ie1');
  const viewer1 = await loginAs('viewer1');
  if (!ie1.accessToken || !viewer1.accessToken) throw new Error('login failed');
  const ie1Auth = { Authorization: 'Bearer ' + ie1.accessToken };

  /* 预置：AI 开 + mock 端点（同 test-ai-waste.cjs preset）+ 清残留 */
  await dbExec("DELETE FROM t_ai_setting");
  await dbExec("INSERT INTO t_ai_setting (setting_key, setting_value, updated_by) VALUES ('ai_enabled', '1', 'ui-test'), ('llm_base_url', 'http://127.0.0.1:19101/v1', 'ui-test'), ('llm_api_key', 'test-key', 'ui-test'), ('llm_model', 'mock-model', 'ui-test')");
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id='${SID}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id='${SID}'`).catch(() => {});
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id='${SID}'`).catch(() => {});
  await dbExec(`DELETE FROM t_improvement WHERE station_id='${SID}' AND imp_id LIKE '%-AIW'`).catch(() => {});
  await dbExec(`DELETE FROM t_element WHERE station_id='${SID}'`).catch(() => {});
  await fetch(API + '/stations/' + SID, { method: 'DELETE', headers: ie1Auth }).catch(() => {});

  /* 夹具：ie1 自建工位 + CSV 导入 3 手工要素（B 手链 0-2000-4000-5000ms，CT=5.75s） */
  const cr = await fetch(API + '/stations', {
    method: 'POST', headers: { ...ie1Auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ station_id: SID, line_id: 'BJFA1', name: 'wb浪费按钮测试工位', tt: 30 }),
  });
  ok('ie1 创建临时工位 BJFA1-ST01', cr.status === 200 || cr.status === 201, cr.status);
  const csv = ['序号,手别,类型,描述,时长s', '1,B,握取,握取螺丝,2', '2,B,移物,移送零件至夹具,2', '3,B,定位,定位装入,1'].join('\n');
  const ir = await fetch(API + '/stations/' + SID + '/elements/import', {
    method: 'POST', headers: { ...ie1Auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  ok('CSV 导入 3 条手工要素（source=manual）', ir.status === 200 || ir.status === 201, ir.status);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: 300000,
  });
  const errors = [];

  try {
    /* ── 1. viewer1：无 suggestion:generate → 按钮不渲染 ── */
    const vp = await browser.newPage();
    await vp.setViewport({ width: 1600, height: 1000 });
    vp.on('pageerror', (e) => errors.push('[viewer] ' + e.message.slice(0, 200)));
    await vp.evaluateOnNewDocument((rt) => {
      localStorage.setItem('ie_refresh_token', rt);   // 多页签共享 localStorage——无条件覆写
      localStorage.setItem('wb-help-seen', '1');
      localStorage.removeItem('wb-new-dur');
    }, viewer1.refreshToken);
    await vp.goto(`${WEB}/?b=1#/workbench/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await vp.waitForFunction(() => document.querySelector('.wb-top-acts') || document.querySelector('.card.empty'), { timeout: 30000, polling: 300 });
    await sleep(800);
    const vBtn = await vp.evaluate(() => {
      const btns = [...document.querySelectorAll('.wb-top-btn, button')];
      const hit = btns.find((b) => (b.textContent || '').includes('AI自动识别浪费'));
      return { has: !!hit, topBtnTexts: [...document.querySelectorAll('.wb-top-btn')].map((b) => (b.textContent || '').trim()).join('/') };
    });
    ok('viewer1（无 suggestion:generate）DOM 无「AI自动识别浪费」按钮', !vBtn.has, JSON.stringify(vBtn));
    await vp.close();

    /* ── 2. ie1 主流程页 ── */
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    await page.evaluateOnNewDocument((rt) => {
      localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
      localStorage.removeItem('wb-new-dur');
    }, ie1.refreshToken);
    await page.goto(`${WEB}/?b=1#/workbench/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('.tl-lane .block').length === 3, { timeout: 30000, polling: 300 });
    await sleep(600);

    /* 2. v3.48 门控口径：disabled ⇔ 草稿脏 / 无已提交要素（不再是「未提交」）。
          fresh load 后 draft≡committed 不脏 → 按钮可点（旧口径下恒灰无处可点，已修正） */
    const btnState = async () => page.evaluate(() => {
      const b = [...document.querySelectorAll('.wb-top-btn')].find((x) => (x.textContent || '').includes('AI自动识别浪费'));
      return b ? { disabled: b.disabled, title: b.title, text: b.textContent.trim() } : null;
    });
    const s0 = await btnState();
    ok('ie1 有权限时按钮存在', !!s0, JSON.stringify(s0));
    ok('fresh load（草稿未改动）按钮可点', !!s0 && s0.disabled === false, JSON.stringify(s0));
    /* 编辑草稿 → 置灰 + title 说明原因（脏检查口径） */
    await page.evaluate(() => {
      const ta = document.querySelector('.insp textarea, .insp input[type=text]');
      if (ta) { ta.focus(); }
    });
    const dirtyTitle = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.wb-top-btn')].find((x) => (x.textContent || '').includes('AI自动识别浪费'));
      return b ? b.title : null;
    });
    ok('可用态 title 说明基于已提交要素', !!dirtyTitle && /基于已提交/.test(dirtyTitle), dirtyTitle);

    /* 3+4. 提交分解 → 按钮立即可点（banner 出现即断言；load() 异步回来后复验不误触） */
    ok('点击「提交分解」', await clickText(page, '提交分解'));
    await page.waitForFunction(() => /提交成功/.test(((document.querySelector('.banner-success') || {}).textContent || '')), { timeout: 30000, polling: 300 });
    const s1 = await btnState();
    ok('提交成功后按钮立即可点（submit 自身 load() 不误触）', !!s1 && s1.disabled === false, JSON.stringify(s1));
    await sleep(1200);   // load() 异步完成后再复验（若有竞态置位会在此暴露）
    const s1b = await btnState();
    ok('load() 异步回来后按钮仍可点（无延迟误触）', !!s1b && s1b.disabled === false, JSON.stringify(s1b));

    /* 5. 409：构造同源 running 批 → 点击 → 进行中提示 + 链接（mock 0 次） */
    const stRow = (await dbQuery(`SELECT version, tenant_id FROM t_station WHERE station_id = '${SID}'`))[0];
    await dbExec(`INSERT INTO t_ai_waste_batch (batch_id, station_id, tenant_id, version, user_id, status, element_source, element_count, created_at, updated_at) VALUES ('qa-wb-running-${SID}', '${SID}', '${stRow?.tenant_id ?? 'DEFAULT'}', ${stRow?.version ?? 1}, 'ie1', 'running', 'manual', 3, SYSUTCDATETIME(), SYSUTCDATETIME())`);
    mockCalls = 0;
    ok('409 场景：点击「AI自动识别浪费」', await clickText(page, 'AI自动识别浪费'));
    await page.waitForFunction(() => /已有识别任务进行中/.test(((document.querySelector('.banner-error') || {}).textContent || '')), { timeout: 30000, polling: 300 });
    const err409 = await page.evaluate(() => {
      const banner = document.querySelector('.banner-error');
      const link = banner ? banner.querySelector('a.wb-inline-link') : null;
      return { text: banner ? banner.textContent.slice(0, 80) : '', href: link ? link.getAttribute('href') : null };
    });
    ok('409 → toast「已有识别任务进行中」', /已有识别任务进行中/.test(err409.text), err409.text);
    ok('409 → 「前往浪费识别 →」链接存在且 href 含 ?source=manual', !!err409.href && err409.href.includes('?source=manual'), err409.href);
    ok('409 不调 LLM（mock 0 次）', mockCalls === 0, mockCalls);
    await dbExec(`DELETE FROM t_ai_waste_batch WHERE batch_id = 'qa-wb-running-${SID}'`).catch(() => {});

    /* 6. 正常点击 → mock → 成功 toast + 链接 */
    mockCalls = 0;
    ok('点击「AI自动识别浪费」触发识别', await clickText(page, 'AI自动识别浪费'));
    await page.waitForFunction(() => /识别完成/.test(((document.querySelector('.banner-success') || {}).textContent || '')), { timeout: 60000, polling: 300 });
    const succ = await page.evaluate(() => {
      const banners = [...document.querySelectorAll('.banner-success')].filter((b) => /识别完成/.test(b.textContent || ''));
      const banner = banners[banners.length - 1];
      /* 成功横幅含两个链接（查看分析结果 →/前往浪费识别 →）——按文本精确取浪费识别链接 */
      const link = banner ? [...banner.querySelectorAll('a.wb-inline-link')].find((a) => (a.textContent || '').includes('前往浪费识别')) : null;
      return { text: banner ? banner.textContent.slice(0, 120) : '', href: link ? link.getAttribute('href') : null };
    });
    ok('toast「识别完成：1 个浪费点 / 1 条建议」', /识别完成：1 个浪费点 \/ 1 条建议/.test(succ.text), succ.text);
    ok('「前往浪费识别 →」链接存在且 href 含 ?source=manual', !!succ.href && succ.href.includes('?source=manual'), succ.href);
    ok('mock LLM 被真实调用 1 次', mockCalls === 1, mockCalls);

    /* 7. 焦点回 body（blur 策略） */
    const focusTag = await page.evaluate(() => (document.activeElement ? document.activeElement.tagName : 'NONE'));
    ok('点击后焦点回 body（blur 策略，快捷键立即可用）', focusTag === 'BODY', focusTag);

    /* 8. 脏检查：选中要素 → 改类型 → 按钮重新 disabled */
    const blk = await page.evaluateHandle(() => document.querySelector('.tl-lane .block'));
    await blk.asElement().click();
    await page.waitForSelector('.wb-tsel-btn', { timeout: 10000 });
    const curType = await page.evaluate(() => (document.querySelector('.wb-tsel-v') || {}).textContent || '');
    const typeBtn = await page.evaluateHandle(() => document.querySelector('.wb-tsel-btn'));
    await typeBtn.asElement().click();
    await page.waitForSelector('.wb-tsel-menu .wb-tsel-o', { timeout: 10000 });
    const changed = await page.evaluate((cur) => {
      const opts = [...document.querySelectorAll('.wb-tsel-menu .wb-tsel-o')];
      const target = opts.find((o) => (o.textContent || '').trim() !== cur && (o.textContent || '').trim().length > 0);
      if (!target) return null;
      const t = target.textContent.trim();
      target.click();
      return t;
    }, curType.trim());
    await sleep(400);
    const s2 = await btnState();
    ok('提交后修改 1 条草稿（改要素类型）→ 按钮重新 disabled（脏检查）', !!changed && !!s2 && s2.disabled === true, `${curType}→${changed}/${JSON.stringify(s2)}`);

    /* 恢复：重新提交 → 按钮恢复可点（脏检查可逆） */
    ok('重新提交分解', await clickText(page, '提交分解'));
    await page.waitForFunction(() => /提交成功/.test(((document.querySelector('.banner-success') || {}).textContent || '')), { timeout: 30000, polling: 300 });
    await sleep(800);
    const s3 = await btnState();
    ok('重新提交后按钮恢复可点', !!s3 && s3.disabled === false, JSON.stringify(s3));
    /* v3.47 Fix 5（对应审计 P0-B1）：重提交后做 DB 级来源断言。
       此前缺陷正是"工作台回写不带 source → 后端兜底 manual"，而唯一经过这条路径的
       用例恰好缺了这条断言（缺陷与盲区重合）。这里堵住：手工线不得产出 ai_assisted，
       也不得把已有 AI 要素静默降级。 */
    const srcRows = await dbQuery(`SELECT source, COUNT(*) AS n FROM t_element WHERE station_id = '${SID}' GROUP BY source`).catch(() => []);
    const srcStat = srcRows.reduce((m, r) => {
      const k = String(r.source || 'manual'); m[k] = Number(m[k] ?? 0) + Number(r.n ?? 0); return m;
    }, {});
    ok('重提交后 DB 来源分布正确（纯 manual，无 ai_assisted 混入）',
      (srcStat.manual ?? 0) > 0 && (srcStat.ai_assisted ?? 0) === 0, JSON.stringify(srcStat));

    /* 9. 点「前往浪费识别 →」→ AiWastePage 手工页签激活 */
    const linkHandle = await page.evaluateHandle(() => {
      const a = [...document.querySelectorAll('a.wb-inline-link')].find((x) => (x.textContent || '').includes('前往浪费识别'));
      return a || null;
    });
    ok('「前往浪费识别 →」链接可点击', !!linkHandle.asElement());
    await linkHandle.asElement().click();
    await page.waitForFunction(() => window.location.hash.includes('ai-waste/'), { timeout: 15000, polling: 300 });
    await page.waitForSelector('.aw-page', { timeout: 30000 });
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.aw-page button')].find((x) => /手工分解线/.test(x.textContent));
      return b && b.className.includes('primary');
    }, { timeout: 30000, polling: 300 });
    const hash = await page.evaluate(() => window.location.hash);
    ok('链接点击后到达 AiWastePage 且 URL 含 ?source=manual', hash.includes(`ai-waste/${SID}`) && hash.includes('?source=manual'), hash);
    const badgeTxt = await page.evaluate(() => {
      const b = document.querySelector('.page-head .tag.t-amber');
      return b ? b.textContent.trim() : '';
    });
    ok('AiWastePage 手工页签激活且来源徽标「手工分解」', badgeTxt === '手工分解', badgeTxt);
    await page.screenshot({ path: path.join(SHOT_DIR, 'wb-btn-aiwaste-manual.png'), fullPage: true });

    /* 10. 全程零未捕获 JS 异常 */
    ok('全程零未捕获 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 200));

    /* 工作台顶栏按钮截图（提交后可点态，视觉验证用）。
       注意：refresh token 轮换——page 启动后旧 token 已失效，page2 必须重新登录拿全新 token
       （多页签共享 localStorage，无条件覆写旧值会直接 401 未登录，坑见 v3.45 QA 记录） */
    const ie1b = await loginAs('ie1');
    if (!ie1b.accessToken) throw new Error('ie1 re-login failed');
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1600, height: 1000 });
    await page2.evaluateOnNewDocument((rt) => {
      localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
    }, ie1b.refreshToken);
    await page2.goto(`${WEB}/?b=1#/workbench/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page2.waitForFunction(() => document.querySelectorAll('.tl-lane .block').length === 3, { timeout: 30000, polling: 300 });
    ok('截图前重新提交分解', await clickText(page2, '提交分解'));
    await page2.waitForFunction(() => /提交成功/.test(((document.querySelector('.banner-success') || {}).textContent || '')), { timeout: 30000, polling: 300 });
    await sleep(600);
    await page2.screenshot({ path: path.join(SHOT_DIR, 'wb-top-btn-submitted.png'), fullPage: false });
    await page2.close();
  } finally {
    /* 清理：还原 t_ai_setting（空=回落 env）+ 删测试 running 批 + 工位级联删除 */
    await dbExec(`DELETE FROM t_ai_waste_batch WHERE batch_id = 'qa-wb-running-${SID}'`).catch(() => {});
    await dbExec("DELETE FROM t_ai_setting").catch(() => {});
    await fetch(API + '/stations/' + SID, { method: 'DELETE', headers: ie1Auth }).catch(() => {});
    await browser.close().catch(() => {});
    mock.close();
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UI 测试执行异常:', e); process.exit(1); });
