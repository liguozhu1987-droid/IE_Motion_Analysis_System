/**
 * P3-9 浪费识别 UI 测试（真实浏览器 + mock LLM 网关）。
 *
 * 链路：页面「开始识别」→ POST /ai-waste/generate → 后端 LLM(mock) → W1-W3 校验
 *       → 数字服务端算 → 落库待处理 → 页面渲染浪费点表 + 问题卡片 → 确认 → 改善任务。
 *
 * 前置：
 *  1. API 已重启且加载 ai-waste 模块（3001）；
 *  2. vite dev server 已启动（5173）；
 *  3. t_ai_setting 已预置 ai_enabled=1 + llm_base_url=http://127.0.0.1:19101/v1（本脚本自动预置）；
 *  4. L01-ST33 有 4 条 source='ai_assisted' 要素（v1）。
 *
 * 用法：node test-ai-waste.cjs
 */
const puppeteer = require('puppeteer-core');
const { createServer } = require('node:http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const SID = 'L01-ST33';
const MOCK_PORT = 19101;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* mock LLM：合法 2 findings + 2 issues（持住 E + 寻找选择 S），故意带数字字段验证剥除 */
const MOCK_PAYLOAD_AI = {
  findings: [
    { element_seqs: [1], waste_type: '持住', evidence: '全程单手扶住壳体无任何加工动作', severity: 9, pct_of_ct: 55.5 },
    { element_seqs: [3], waste_type: '寻找选择', evidence: '目视扫描料盒反复确认料件位置', involved_s: 88 },
  ],
  issues: [
    { element_seqs: [1], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '取消', suggestion: '治具夹持替代人工持住壳体动作' },
    { element_seqs: [3], waste_type: '寻找选择', problem: '目视寻找料件位置不确定', ecrs: '简化', suggestion: '供料定位唯一化一穴一件取放' },
  ],
};
/* v3.45 手工分解线 mock：只引用手工要素 seq 5/6（seq 1-4 为 AI 要素——手工线 ctx 引用即被 W1.3 剔除）。
 * seq5 持住 E → est 3.68；seq6 搬运 S → est 1.61；manual 子集 CT=6.90 → 总节省 5.29 / 76.67% */
const MOCK_PAYLOAD_MANUAL = {
  findings: [
    { element_seqs: [5], waste_type: '持住', evidence: '手工分解线单手扶住壳体全程无任何加工', severity: 9, pct_of_ct: 88.8 },
  ],
  issues: [
    { element_seqs: [5], waste_type: '持住', problem: '单手长时间持住壳体易疲劳', ecrs: '取消', suggestion: '治具夹持替代人工持住壳体动作' },
    { element_seqs: [6], waste_type: '搬运', problem: '移物取前壳路径可优化缩短距离', ecrs: '简化', suggestion: '供料定位唯一化一穴一件取放' },
  ],
};
let mockPayload = MOCK_PAYLOAD_AI;
let mockCalls = 0;
function startMockLlm() {
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      mockCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(mockPayload) } }],
        usage: { total_tokens: 420 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function dbExec(sql) {
  /* mssql/dotenv 只装在 app/api——从那里解析（web 目录无 DB 依赖，坑 #㊵） */
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

(async () => {
  /* mssql 从 app/api node_modules 解析 + 预载 .env（首调 dbExec 前须生效） */
  const { createRequire } = require('node:module');
  const apiRequire = createRequire(require('path').resolve(__dirname, '..', 'api', 'package.json'));
  apiRequire('dotenv').config({ path: require('path').resolve(__dirname, '..', 'api', '.env') });
  const mock = await startMockLlm();

  /* 预置：AI 开 + mock 端点 + 清残留批次 */
  await dbExec("DELETE FROM t_ai_setting");
  await dbExec("INSERT INTO t_ai_setting (setting_key, setting_value, updated_by) VALUES ('ai_enabled', '1', 'ui-test'), ('llm_base_url', 'http://127.0.0.1:19101/v1', 'ui-test'), ('llm_api_key', 'test-key', 'ui-test'), ('llm_model', 'mock-model', 'ui-test')");
  await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id='${SID}'`);
  await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id='${SID}'`);
  await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id='${SID}'`);
  /* v3.45 QA：前置清理补 t_improvement 的 AIW 行（自足性——历史会话/他人自验残留会让
   *  「确认落库」计数断言失真；与 finally 的同款清理对称） */
  await dbExec(`DELETE FROM t_improvement WHERE station_id='${SID}' AND imp_id LIKE '%-AIW'`);

  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  /* v3.42 适配：L01-ST33 工位行原为更早会话残留（seed 不含，v3.42 清库后消失）——缺则自建，测后 finally 级联删除 */
  let stCreated = false;
  {
    const g = await fetch(API + '/stations/' + SID, { headers: { authorization: 'Bearer ' + login.accessToken } });
    if (g.status !== 200) {
      const c = await fetch(API + '/stations', {
        method: 'POST', headers: { authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ station_id: SID, line_id: 'L01', name: '浪费识别UI工位', tt: 40 }),
      });
      if (!c.ok) throw new Error('L01-ST33 自建失败: ' + c.status);
      stCreated = true;
      console.log('预置：L01-ST33 工位行不存在，已自建（测后删除）');
    }
  }

  /* v3.41 自足性修正：ST33 的 4 条 AI 要素原来是会话残留，seed 后消失导致识别 400。
     改为测试自建——AI 要素 INSERT 到新开版本 vN+1（复测推进版本，不与 seed 手工 v1 撞
     UQ_element_tenant_ver_seq 唯一键）；ai-waste 只认「当前版本 + source=ai_assisted」；
     测后 finally 删该版本要素并把工位 version 还原。mock payload 引 seq 1/3。 */
  {
    const { createRequire } = require('node:module');
    const apiRequire = createRequire(require('path').resolve(__dirname, '..', 'api', 'package.json'));
    const m = apiRequire('mssql');
    const pool = await m.connect({
      server: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 1433),
      user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
      options: { encrypt: false, trustServerCertificate: true },
    });
    const ver = await pool.request().query(`SELECT version FROM t_station WHERE station_id='${SID}'`);
    const v0 = ver.recordset[0].version;
    const v = v0 + 1;   // 新开版本（独立 seq 空间，不撞手工 v1 的 seq 1-4）
    await pool.request().query(`DELETE FROM t_element WHERE station_id='${SID}' AND bol_version=${v}`);
    await pool.request().query(`UPDATE t_station SET version = ${v}, updated_by='ui-test' WHERE station_id='${SID}'`);
    const mkAi = (seq, start_ms, dur_s, hand, type, desc, va_class) =>
      `('EL-${SID}-${v}-AI${seq}', '${SID}', 'DEFAULT', ${seq}, ${start_ms}, ${dur_s}, '${hand}', '${type}', '${desc}', '${va_class}', 0, NULL, 'ai-segment', 1, 0.15, ${dur_s * 1.15}, ${v}, 'ai_assisted')`;
    const rows = [
      mkAi(1, 0, 3.2, 'R', '持住', '手持住扶壳体', 'NVA'),
      mkAi(2, 3200, 2.8, 'R', '移物', '取前壳', 'VA'),
      mkAi(3, 6000, 2.5, 'R', '寻找选择', '目视寻找料件', 'RNVA'),
      mkAi(4, 8500, 2.0, 'L', '可避免延迟', '等上件', 'NVA'),
    ];
    await pool.request().query(`INSERT INTO t_element (element_id, station_id, tenant_id, seq, start_ms, dur_s, hand, type, [desc], va_class, outlier_flag, outlier_reason, video_id, rating, allowance, std_time, bol_version, source) VALUES ${rows.join(',')}`);
    // ai-waste CT 按 AI 子集重算（ΣST=3.68+3.22+2.88=9.78），工位 CT 同步保持真实
    await pool.request().query(`UPDATE t_station SET ct = 9.78, updated_by = 'ui-test' WHERE station_id='${SID}'`);
    // v3.45 手工分解线预置：同版本插入 2 条 source=manual 要素（seq 5/6，不撞 AI seq 1-4 的 UQ）
    // seq5 持住(NVA) 3.2→ST3.68 ｜ seq6 移物(VA) 2.8→ST3.22 → manual 子集 CT=6.90（loadBySource 复算）
    const mkManual = (seq, start_ms, dur_s, hand, type, desc, va_class) =>
      `('EL-${SID}-${v}-MN${seq}', '${SID}', 'DEFAULT', ${seq}, ${start_ms}, ${dur_s}, '${hand}', '${type}', '${desc}', '${va_class}', 0, NULL, 'manual', 1, 0.15, ${dur_s * 1.15}, ${v}, 'manual')`;
    const manualRows = [
      mkManual(5, 11000, 3.2, 'R', '持住', '手工分解手持住扶壳体', 'NVA'),
      mkManual(6, 14200, 2.8, 'R', '移物', '手工分解取前壳', 'VA'),
    ];
    await pool.request().query(`INSERT INTO t_element (element_id, station_id, tenant_id, seq, start_ms, dur_s, hand, type, [desc], va_class, outlier_flag, outlier_reason, video_id, rating, allowance, std_time, bol_version, source) VALUES ${manualRows.join(',')}`);
    await pool.close();
    console.log(`预置：${SID} v${v} 追加 2 条手工分解要素（seq 5/6，manual 子集 ST=6.90）`);
    console.log(`预置：${SID} 新开 v${v}（v${v0} 手工封存）自建 4 条 AI 要素（AI 子集 ST=9.78）`);
  }

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

    /* 确定性引导（v3.39 模式）：token 首文档前注入 */
    await page.evaluateOnNewDocument((rt) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);

    await page.goto(`${WEB}/?b=1#/ai-waste/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.aw-page', { timeout: 30000 });
    ok('页面加载：浪费识别页渲染', true);

    /* v3.45：默认页签=AI 分解线（primary 类名即激活态；保 22/22 既有行为） */
    const tabInit = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.aw-page button')].filter((b) => /分解线/.test(b.textContent));
      const ai = btns.find((b) => /AI 分解线/.test(b.textContent));
      const mn = btns.find((b) => /手工分解线/.test(b.textContent));
      return { aiOn: !!ai && ai.className.includes('primary'), mnOn: !!mn && mn.className.includes('primary') };
    });
    ok('默认页签=AI 分解线（手工页签未激活）', tabInit.aiOn && !tabInit.mnOn, JSON.stringify(tabInit));

    /* 空态（等 empty 卡片真正渲染，load() 完成前不出现） */
    await page.waitForSelector('.card.empty', { timeout: 15000 });
    const emptyText = await page.evaluate(() => (document.querySelector('.card.empty') || {}).textContent || '');
    ok('空态提示说明只处理 AI 分解要素', /AI 自动分解|ai_assisted/.test(emptyText), emptyText.slice(0, 100));

    /* 页签存在（StationTabs 第 6 项） */
    const tabCount = await page.evaluate(() => [...document.querySelectorAll('.station-tabs a')].map((a) => a.textContent.trim()));
    ok('StationTabs 含「浪费识别」页签', tabCount.includes('浪费识别'), tabCount.join('/'));

    /* 点开始识别 */
    mockCalls = 0;
    const genBtn = await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.page-head button')].find((x) => /开始识别|重新识别/.test(x.textContent));
      return b && !b.disabled ? b : null;
    }, { timeout: 15000 });
    await genBtn.asElement().click();
    ok('「开始识别」可点击', true);

    /* 等完成（success-banner 或 batch bar done） */
    await page.waitForFunction(() => {
      const s = (document.querySelector('.success-banner') || {}).textContent || '';
      return /浪费识别完成|已识别过/.test(s);
    }, { timeout: 60000 });
    const banner = await page.evaluate(() => (document.querySelector('.success-banner') || {}).textContent || '');
    ok('生成完成提示（2 浪费点 + 2 问题）', /2 个浪费点/.test(banner) && /2 条问题清单/.test(banner), banner.slice(0, 120));
    ok('mock LLM 被真实调用 1 次', mockCalls === 1, mockCalls);

    /* 浪费点表 */
    await page.waitForSelector('.aw-section table tbody tr', { timeout: 15000 });
    const findingRows = await page.evaluate(() => [...document.querySelectorAll('.aw-section table tbody tr')].map((tr) => {
      const td = tr.querySelectorAll('td');
      return {
        waste: td[0].textContent.trim(), sev: td[1].textContent.trim(),
        involved: td[2].textContent.trim(), pct: td[3].textContent.trim(),
      };
    }));
    ok('浪费点表 2 行', findingRows.length === 2, findingRows.length);
    const hold = findingRows.find((f) => f.waste === '持住');
    ok('LLM 数字被剥：持住 involved=3.68s（非 88/55.5）', hold && hold.involved.startsWith('3.68'), JSON.stringify(findingRows));
    ok('severity 服务端算：持住 pct=30.46% → 严重', hold && hold.sev === '严重', hold && hold.sev);

    /* 问题卡片 */
    const issueCards = await page.evaluate(() => [...document.querySelectorAll('.aw-issue-card')].map((c) => ({
      head: c.querySelector('.row').textContent,
      status: [...c.querySelectorAll('.tag')].map((t) => t.textContent.trim()).find((t) => t === '待处理' || t === '已确认' || t === '已忽略'),
    })));
    ok('问题卡片 2 张', issueCards.length === 2, issueCards.length);
    ok('状态初始=待处理（铁律①）', issueCards.every((c) => c.status === '待处理'), JSON.stringify(issueCards.map((c) => c.status)));
    const p1card = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.aw-issue-card')];
      for (const c of cards) if (/P1/.test(c.textContent)) return { found: true, est: /3\.68/.test(c.textContent) };
      return { found: false, est: false };
    });
    ok('P1 卡片存在且 est_save_s=3.68（服务端算）', p1card.found && p1card.est, JSON.stringify(p1card));

    /* 确认 P1 条目 → dialog confirm → 改善任务 */
    page.once('dialog', (d) => d.accept());
    const confirmBtn = await page.evaluateHandle(() => {
      const cards = [...document.querySelectorAll('.aw-issue-card')];
      for (const c of cards) {
        if (/P1/.test(c.textContent)) {
          const b = [...c.querySelectorAll('button')].find((x) => x.textContent.trim() === '确认');
          if (b) return b;
        }
      }
      return null;
    });
    await confirmBtn.asElement().click();
    /* 等卡片 tag 真正翻转（banner 先于 load() 出现，等 banner 会踩竞态拿到旧状态） */
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.aw-issue-card')];
      return cards.some((c) => [...c.querySelectorAll('.tag')].some((t) => t.textContent.trim() === '已确认'));
    }, { timeout: 30000 });
    ok('确认流转：状态翻转已确认', true);
    /* 卡片状态翻转为已确认 */
    const afterConfirm = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.aw-issue-card')];
      return cards.map((c) => ([...c.querySelectorAll('.tag')].map((t) => t.textContent.trim()).find((t) => t === '待处理' || t === '已确认' || t === '已忽略')));
    });
    ok('确认后卡片状态=已确认', afterConfirm.filter((s) => s === '已确认').length === 1, JSON.stringify(afterConfirm));

    /* 忽略另一条 */
    const ignoreBtn = await page.evaluateHandle(() => {
      const cards = [...document.querySelectorAll('.aw-issue-card')];
      for (const c of cards) {
        const b = [...c.querySelectorAll('button')].find((x) => x.textContent.trim() === '忽略');
        if (b) return b;
      }
      return null;
    });
    if (ignoreBtn.asElement()) {
      await ignoreBtn.asElement().click();
      /* 等卡片 tag 翻转已忽略（同确认竞态规避：不等 banner） */
      await page.waitForFunction(() => {
        const cards = [...document.querySelectorAll('.aw-issue-card')];
        return cards.some((c) => [...c.querySelectorAll('.tag')].some((t) => t.textContent.trim() === '已忽略'));
      }, { timeout: 30000 });
      ok('忽略流转：终态', true);
    } else {
      ok('忽略流转：终态', false, '未找到忽略按钮');
    }

    /* DB 回读：t_improvement source=ai + ai_suggestion_id=issue_id */
    const { createRequire: cr2 } = require('node:module');
    const apiReq2 = cr2(require('path').resolve(__dirname, '..', 'api', 'package.json'));
    const m = apiReq2('mssql');
    const pool = await m.connect({
      server: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 1433),
      user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
      options: { encrypt: false, trustServerCertificate: true },
    });
    const imp = await pool.request().query(`SELECT imp_id, source, status, est_save_s FROM t_improvement WHERE station_id='${SID}' AND source='ai' AND imp_id LIKE '%-AIW'`);
    ok('确认落库 t_improvement source=ai（AIW 尾缀）', imp.recordset.length === 1, imp.recordset.length);
    ok('改善任务 est_save_s=3.68（非 LLM 数字）', imp.recordset.length === 1 && Math.abs(Number(imp.recordset[0].est_save_s) - 3.68) < 0.01, imp.recordset[0] && imp.recordset[0].est_save_s);
    /* 批次状态 */
    const batch = await pool.request().query(`SELECT TOP 1 status, finding_count, issue_count FROM t_ai_waste_batch WHERE station_id='${SID}' ORDER BY created_at DESC`);
    ok('批次 done 且 counts=2/2', batch.recordset.length === 1 && batch.recordset[0].status === 'done' && batch.recordset[0].finding_count === 2 && batch.recordset[0].issue_count === 2, JSON.stringify(batch.recordset));
    await pool.close();

    /* 批次历史展开 */
    const histBtn = await page.evaluateHandle(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /查看批次历史/.test(x.textContent));
      return b || null;
    });
    if (histBtn.asElement()) {
      await histBtn.asElement().click();
      await sleep(500);
      const histRows = await page.evaluate(() => [...document.querySelectorAll('.aw-page .table-scroll table tbody tr')].length);
      ok('批次历史展开含记录', histRows >= 1, histRows);
    }

    /* 截图存档 */
    await page.screenshot({ path: require('path').resolve(__dirname, '..', '..', 'deliverables', 'ai-waste', 'ui-test-result.png'), fullPage: true });

    /* 幂等重生成不新增批 */
    mockCalls = 0;
    const reBtn = await page.evaluateHandle(() => {
      const b = [...document.querySelectorAll('.page-head button')].find((x) => /重新识别/.test(x.textContent));
      return b || null;
    });
    if (reBtn.asElement()) {
      await reBtn.asElement().click();
      await page.waitForFunction(() => /已识别过/.test(((document.querySelector('.success-banner') || {}).textContent || '')), { timeout: 30000 });
      ok('重复生成 → 幂等命中提示', true);
      ok('幂等命中不调 LLM', mockCalls === 0, mockCalls);
    }

    /* ── v3.45 手工分解线页签：切换 → 空态 → 识别 → 徽标/摘要卡（latest?source=manual） ── */
    mockPayload = MOCK_PAYLOAD_MANUAL;
    const manualTab = await page.evaluateHandle(() => {
      const b = [...document.querySelectorAll('.aw-page button')].find((x) => /手工分解线/.test(x.textContent));
      return b || null;
    });
    await manualTab.asElement().click();
    await page.waitForSelector('.card.empty', { timeout: 15000 });
    const manualEmpty = await page.evaluate(() => (document.querySelector('.card.empty') || {}).textContent || '');
    ok('切到手工页签：空态提示手工分解线无批次', /手工分解线的识别批次/.test(manualEmpty), manualEmpty.slice(0, 80));

    mockCalls = 0;
    const genManualBtn = await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.page-head button')].find((x) => /开始识别|重新识别/.test(x.textContent));
      return b && !b.disabled ? b : null;
    }, { timeout: 15000 });
    await genManualBtn.asElement().click();
    await page.waitForFunction(() => /浪费识别完成/.test(((document.querySelector('.success-banner') || {}).textContent || '')), { timeout: 60000 });
    const manualBanner = await page.evaluate(() => (document.querySelector('.success-banner') || {}).textContent || '');
    ok('手工线生成完成（1 浪费点 + 2 问题清单）', /1 个浪费点/.test(manualBanner) && /2 条问题清单/.test(manualBanner), manualBanner.slice(0, 120));
    ok('手工线 mock LLM 被真实调用 1 次', mockCalls === 1, mockCalls);

    /* 浪费点表（手工线服务端口径：seq5 / involved=3.68s / pct=53.33%） */
    await page.waitForSelector('.aw-section table tbody tr', { timeout: 15000 });
    const manualFinding = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('.aw-section table tbody tr')].find((x) => /持住/.test(x.textContent));
      if (!tr) return null;
      const td = tr.querySelectorAll('td');
      return { involved: td[2].textContent.trim(), pct: td[3].textContent.trim(), seq: td[5].textContent.trim() };
    });
    ok('手工线浪费点渲染：seq5 / 3.68s / 53.33%（服务端口径）',
      !!manualFinding && manualFinding.involved.startsWith('3.68') && manualFinding.pct.startsWith('53.33') && manualFinding.seq === '5',
      JSON.stringify(manualFinding));

    /* 来源徽标 = 手工分解（t-amber） */
    const badge = await page.evaluate(() => {
      const b = document.querySelector('.page-head .tag.t-amber');
      return b ? b.textContent.trim() : '';
    });
    ok('来源徽标显示「手工分解」', badge === '手工分解', badge);

    /* 摘要卡数字与接口一致（前端零计算，直接渲染服务端 summary 字段） */
    const summaryDom = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.aw-section')].find((x) => /识别摘要/.test(x.textContent));
      if (!c) return null;
      const t = c.textContent;
      return {
        byType: /持住 × 1/.test(t),
        total: (/预计总节省\s*([\d.]+)\s*s/.exec(t) || [])[1] ?? null,
        pct: (/占 CT\s*([\d.]+)%/.exec(t) || [])[1] ?? null,
      };
    });
    const latManualRes = await fetch(`${API}/stations/${SID}/ai-waste/latest?source=manual`, { headers: { authorization: 'Bearer ' + login.accessToken } });
    const latManual = await latManualRes.json();
    ok('摘要卡与接口一致：by_type 持住×1 / 总节省 5.29s / 占 CT 76.67%',
      !!summaryDom && summaryDom.byType
        && summaryDom.total === String(latManual.summary?.total_est_save_s)
        && summaryDom.pct === String(latManual.summary?.est_pct_of_ct)
        && Math.abs(Number(summaryDom.total) - 5.29) < 0.01 && Math.abs(Number(summaryDom.pct) - 76.67) < 0.05,
      JSON.stringify({ dom: summaryDom, api: latManual.summary }));

    /* 手工线页签截图存档（QA 视觉验证用） */
    await page.screenshot({ path: require('path').resolve(__dirname, '..', '..', 'deliverables', 'ai-waste-manual', 'screenshots', 'ui-manual-tab.png'), fullPage: true });

    /* 页面零异常 */
    ok('页面零 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally {
    /* 清理：还原 t_ai_setting（空=DB 回落 env=false）+ 清测试批次/改善/自建 AI 要素 + 还原 seed CT */
    await dbExec("DELETE FROM t_ai_setting").catch(() => {});
    await dbExec(`DELETE FROM t_ai_waste_issue WHERE station_id='${SID}'`).catch(() => {});
    await dbExec(`DELETE FROM t_ai_waste_finding WHERE station_id='${SID}'`).catch(() => {});
    await dbExec(`DELETE FROM t_ai_waste_batch WHERE station_id='${SID}'`).catch(() => {});
    await dbExec(`DELETE FROM t_improvement WHERE station_id='${SID}' AND imp_id LIKE '%-AIW'`).catch(() => {});
    await dbExec(`DELETE FROM t_element WHERE station_id='${SID}' AND source='ai_assisted'`).catch(() => {});
    await dbExec(`DELETE FROM t_element WHERE station_id='${SID}' AND source='manual' AND bol_version >= 2`).catch(() => {});
    if (stCreated) {
      /* 自建工位整站级联删除（v3.42 清库后不留残留） */
      await fetch(API + '/stations/' + SID, { method: 'DELETE', headers: { authorization: 'Bearer ' + login.accessToken } }).catch(() => {});
    }
    await dbExec(`UPDATE t_station SET version = 1, ct = (SELECT COALESCE(SUM(std_time),0) FROM t_element WHERE station_id='${SID}' AND bol_version=1 AND outlier_flag=0), updated_by='seed' WHERE station_id='${SID}'`).catch(() => {});    await browser.close().catch(() => {});
    mock.close();
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UI 测试执行异常:', e); process.exit(1); });
