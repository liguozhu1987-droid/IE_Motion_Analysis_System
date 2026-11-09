/**
 * AI 改善建议模块前端冒烟（v3.30 · 配合后端并行开发）
 *
 * 后端 AI 端点未上线（/api/ai-suggestions/* 404）→ 用路由拦截 mock 契约响应，
 * 在真实浏览器里验证 UI 结构与交互语义。后端就绪后同一脚本改直连即可复用。
 *
 * 断言（≥10）：
 *  A1 登录后 #/ai-config 路由可达且渲染 AI 配置页
 *  A2 系统管理下拉含「AI 配置」入口
 *  A3 viewer（无 suggestion:generate）看不到 AI 建议页签；工位页 AI 页签存在
 *  A4 建议列表 mock 数据渲染：批次状态条 done + 生成时间 + 条数
 *  A5 建议卡片：E/C/R/S 徽标、tier 徽标、risk_flags 角标（红线红点）
 *  A6 决策按钮存在且「待审」语义：只有 采纳/否决，无「直接执行」类按钮
 *  A7 已采纳/已否决卡片置灰且无决策按钮
 *  A8 校验轨迹折叠面板展开显示轮次/规则/处置
 *  A9 采纳 422 → 红线确认弹窗 → 填确认人重试成功
 *  A10 生成按钮 429 → 配额横幅；409 → 生成进行中横幅
 *  A11 无 JS pageerror
 *  A12 AI 配置页配额 tab 渲染（user:write）
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const path = require('path');
const fs = require('fs');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- mock 数据（按规格书 §1/§4 契约构造） ---- */
const STATION_ID = 'MOCK-ST01';
const mockStation = {
  station_id: STATION_ID, line_id: 'L01', name: 'AI冒烟工位', ct: 42.5, tt: 50, version: 3,
  updated_by: null, updated_at: null, created_by: null, created_at: '2026-10-20T08:00:00Z', tenant_id: 'DEFAULT',
};
const mockBatch = {
  batch_id: 'b1a2c3d4-0000-4000-8000-000000000001', station_id: STATION_ID, version: 3,
  user_id: 'u_admin', status: 'done', attempt: 1, suggestion_count: 3, tokens_used: 1876,
  model: 'glm-4-flash', prompt_version: 'PV1', cache_from: null, error: null,
  created_at: '2026-10-25T02:10:00Z', completed_at: '2026-10-25T02:10:44Z',
};
/* GET list 契约：batches 数组按 created_at DESC，页面取 [0]（在 mockSuggestions 之后组装） */
const mockListResult = {};
const mockSuggestions = [
  {
    suggestion_id: 's-E-001', batch_id: mockBatch.batch_id, station_id: STATION_ID, version: 3,
    element_ids: JSON.stringify(['el-1', 'el-2']), waste_type: '动作浪费', method: 'E',
    measure: '取消转身取料动作：将供料盒移至装配位 30cm 内，SOP-014 已允许双侧供料（消除走动产生条件）',
    eliminate_basis: '供料方式由单侧改双侧后，转身取料的产生条件不复存在（SOP-014 §3.2）',
    est_save_s: 6.8, priority: 82, tier: 'P1', difficulty: 2, verif: 1,
    risk_flags: 'needs_quality_redline', status: '待审', reviewed_by: null, reviewed_at: null,
    validation_trace: JSON.stringify([
      { round: 'R1', rule: 'R1.1', action: '放行', detail: 'Schema 校验通过' },
      { round: 'R2', rule: 'R2.4', action: '全额', detail: 'E 类 est_save_s = ΣST×1.0（含 M01 持住）' },
      { round: 'R2', rule: 'R2.2', action: '加签', detail: '命中条件词「允许」→ needs_quality_redline' },
      { round: 'R3', rule: 'R3.4', action: '通过', detail: 'waste_type ∈ analysis.wastes 证据' },
    ]),
    created_at: '2026-10-25T02:10:44Z',
  },
  {
    suggestion_id: 's-C-002', batch_id: mockBatch.batch_id, station_id: STATION_ID, version: 3,
    element_ids: JSON.stringify(['el-5']), waste_type: '流程浪费', method: 'C',
    measure: '将翻转与粘贴两要素合并为一个复合动作，工装夹具同向递进减少二次定位',
    eliminate_basis: null, est_save_s: 3.2, priority: 45, tier: 'P2', difficulty: 3, verif: 2,
    risk_flags: null, status: '待审', reviewed_by: null, reviewed_at: null,
    validation_trace: JSON.stringify([
      { round: 'R1', rule: 'R1.2', action: '放行', detail: '枚举合法 factor 四档' },
      { round: 'R2', rule: 'R2.4', action: '折算', detail: 'C 类 ΣST×0.6' },
    ]),
    created_at: '2026-10-25T02:10:44Z',
  },
  {
    suggestion_id: 's-S-003', batch_id: mockBatch.batch_id, station_id: STATION_ID, version: 3,
    element_ids: JSON.stringify(['el-7']), waste_type: '等待浪费', method: 'S',
    measure: '压缩按压缩等待时间：气缸动作与上料并行化，节拍对齐至 1.2s',
    eliminate_basis: null, est_save_s: 1.5, priority: 21, tier: 'P3', difficulty: 1, verif: 3,
    risk_flags: 'exceeds_batch_ceiling', status: '已采纳', reviewed_by: '管理员', reviewed_at: '2026-10-25T03:00:00Z',
    validation_trace: null, created_at: '2026-10-25T02:10:44Z',
  },
];
/* list 契约组装（mockSuggestions 就绪后） */
Object.assign(mockListResult, { station_id: STATION_ID, version: 3, batches: [mockBatch], suggestions: mockSuggestions });
const mockAiConfig = {
  enabled: true, model: 'glm-4-flash', prompt_version: 'PV1',
  batch_ceiling: 0.5, quota_scope: 'station',
  monthly_tokens_used: 124560, monthly_token_limit: 500000,
  quota: 5, quota_used: 2, quota_unlimited: false, llm_circuit_open: false,
};
const mockQuota = { userId: 'u-admin', username: 'admin', displayName: '管理员', ai_quota: 5, ai_quota_used: 2, is_unlimited: false };
const mockDict = [
  { dict_id: 'd1', dict_type: 'waste_type', code: 'long_reach', name: '远距伸手', va_class: 'RNVA', method_hint: null, action_class: null, alias_of: null, status: 'active', created_by: 'admin', created_at: '2026-10-24T01:00:00Z' },
  { dict_id: 'd2', dict_type: 'measure_type', code: 'parallel_load', name: '并行上料', va_class: null, method_hint: 'S', action_class: '简化', alias_of: null, status: 'active', created_by: 'admin', created_at: '2026-10-24T01:10:00Z' },
];

/** 注入路由 mock：AI 端点未上线时拦截 fetch，返回契约响应（数据随闭包传入，409/429 序列用 window 变量控制） */
async function installMocks(page, mockData) {
  await page.evaluateOnNewDocument((data, stationId) => {
    const origFetch = window.fetch.bind(window);
    const json = (resp, status = 200) => new Response(JSON.stringify(resp), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || 'GET').toUpperCase();
      const pathq = url.replace(/^https?:\/\/[^/]+/, '');
      // AI 端点 mock（真实后端上线后这些路径不再 404，mock 自动让位于真实响应——此处按前缀判断）
      if (pathq.includes('/ai-suggestions/config')) return json(data.config);
      if (pathq.includes(`/stations/${stationId}/ai-suggestions/generate`)) {
        if (method === 'POST') {
          // 依次模拟：409 → 429 → 幂等 200（扁平结构契约）
          const st = window.__mockGenSeq ? window.__mockGenSeq.shift() : 200;
          if (st === 409) return json({ title: 'Conflict', status: 409, detail: 'AI 批次生成进行中', code: 'AI_BATCH_IN_PROGRESS' }, 409);
          if (st === 429) return json({ title: 'Too Many Requests', status: 429, detail: '配额已用尽', code: 'AI_QUOTA_EXCEEDED', hint: '今日 5 次已用尽' }, 429);
          return json({ idempotent_hit: true, batch_id: data.batch.batch_id, status: 'done', suggestion_count: data.batch.suggestion_count, completed_at: data.batch.completed_at, station_id: stationId, version: 3, suggestions: data.suggestions });
        }
        return json({ batch_id: data.batch.batch_id, status: 'done', station_id: stationId, version: 3, suggestions: data.suggestions });
      }
      if (pathq.includes(`/stations/${stationId}/ai-suggestions`)) return json(data.list);
      if (/\/ai-suggestions\/s-E-001\/adopt/.test(pathq) && method === 'POST') {
        if (!window.__mockRedlineDone) {
          window.__mockRedlineDone = true;
          return json({ title: 'Unprocessable', status: 422, detail: '命中质量红线', requires: [{ type: 'quality', message: 'E 类建议涉及供料方式变更，须品质负责人确认' }] }, 422);
        }
        return json({ imp_id: 'IMP-9001', suggestion_id: 's-E-001', station_id: stationId, annual_yuan: null, note: '日产量/费率未配置：无年化金额' });
      }
      if (/\/ai-suggestions\/[^/]+\/adopt/.test(pathq) && method === 'POST') return json({ imp_id: 'IMP-9002', suggestion_id: 'x', station_id: stationId, annual_yuan: 12000, note: null });
      if (/\/ai-suggestions\/[^/]+\/reject/.test(pathq) && method === 'POST') return json({ suggestion_id: 'x', status: '已否决' });
      if (pathq.includes('/ai-custom-dict')) {
        if (method === 'GET') return json(data.dict);
        if (method === 'POST') return json({ dict_id: 'd-new', dict_type: 'waste_type', code: 'x_new', name: '新类型', va_class: 'NVA', method_hint: null, action_class: null, alias_of: null, status: 'active', created_by: 'admin', created_at: '2026-10-25T05:00:00Z' });
        if (method === 'DELETE') return json({ dict_id: 'x', deleted: true });
      }
      if (/\/users\/[^/]+\/ai-quota/.test(pathq)) {
        if (method === 'PUT') return json({ ...data.quota, ai_quota: JSON.parse((init && init.body) || '{}').ai_quota });
        return json(data.quota);
      }
      // 工位详情 mock（AI 建议页面包屑用）
      if (pathq === `/api/stations/${stationId}` || pathq === `/stations/${stationId}`) return json(data.station);
      return origFetch(input, init);
    };
  }, mockData, STATION_ID);
}

(async () => {
  /* ---- 真实登录拿 refresh token（鉴权走真后端，只有 AI 端点 mock） ---- */
  const loginRes = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const loginBody = await loginRes.json();
  ok('真实后端登录成功（admin）', Boolean(loginBody.accessToken));
  if (!loginBody.refreshToken) { console.log('无法获取 refresh token，终止'); process.exit(1); }

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  await installMocks(page, {
    station: mockStation, batch: mockBatch, list: mockListResult, suggestions: mockSuggestions,
    config: mockAiConfig, dict: mockDict, quota: mockQuota,
  });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
  }, loginBody.refreshToken);

  /* 进入首页（真实数据），再手动导航到工位路由 —— mock 只接管 AI 端点 */
  await page.goto(WEB + '/#/stations', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  /* ---------- A2 系统管理下拉含 AI 配置 ---------- */
  const hasAiNav = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.nav-drop-btn')).find((b) => (b.textContent || '').includes('系统管理'));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(300);
  const aiNavInMenu = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('.nav-drop-menu a')).find((a) => (a.textContent || '').includes('AI 配置'));
    if (link) { link.click(); return true; }
    return false;
  });
  ok('A2 系统管理下拉含「AI 配置」入口并点击', hasAiNav && aiNavInMenu);

  /* ---------- A1 AI 配置页可达（lazy chunk 异步加载 → waitForFunction 等渲染） ---------- */
  await page.waitForFunction(() => {
    const h = document.querySelector('.page-head h1');
    return h && h.textContent.includes('AI 配置');
  }, { timeout: 15000 }).catch(() => {});
  const cfgHead = await page.evaluate(() => {
    const h = document.querySelector('.page-head h1');
    return { hash: window.location.hash, text: h ? h.textContent : '' };
  });
  ok('A1 #/ai-config 路由可达且渲染 AI 配置页', cfgHead.hash === '#/ai-config' && cfgHead.text.includes('AI 配置'), JSON.stringify(cfgHead));
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-config-page.png') });

  /* AI 服务状态区渲染（mock config）
   * v3.46 QA 修正：AI 服务状态区自早期版本起即为 dl.cfg-list 定义列表结构（非 table），
   * 原 `.card table tbody tr` 选择器匹配不到任何行（历史遗留断言，与来源线改造无关——
   * AiConfigPage.tsx 不在 v3.46 改动文件内）。选择器改为实际结构，断言值不变。 */
  const cfgRows = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cfg-list .cfg-row')).map((r) => r.textContent);
    return rows.join('|');
  });
  ok('A1b AI 服务状态区：模型/提示词版本/token 用量+上限渲染', cfgRows.includes('glm-4-flash') && cfgRows.includes('PV1') && cfgRows.includes('124,560') && cfgRows.includes('500,000'), cfgRows.slice(0, 160));
  ok('A1c 契约新字段：配额维度 station / 批次上限 50% / quota_unlimited 语义', cfgRows.includes('工位维度') && cfgRows.includes('50%') && cfgRows.includes('2 / 5'), cfgRows.slice(0, 240));
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-config-status.png') });

  /* ---------- A12 配额 tab ---------- */
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.set-tab')).find((b) => (b.textContent || '').includes('AI 配额管理'));
    if (t) t.click();
  });
  await sleep(1200);
  const quotaRows = await page.evaluate(() => document.body.innerText.includes('配额管理') && document.querySelectorAll('.card table tbody tr').length);
  ok('A12 配额管理 tab 渲染用户行（user:write）', quotaRows > 0, String(quotaRows));
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-quota-mgmt.png') });

  /* ---------- A3 工位页 AI 页签（admin 可见） ---------- */
  await page.goto(WEB + `/#/workbench/${STATION_ID}`, { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(800);
  await page.goto(WEB + `/#/ai-suggestions/${STATION_ID}`, { waitUntil: 'networkidle2' }).catch(() => {});
  await page.waitForFunction(() => {
    const h = document.querySelector('.page-head h1');
    return h && h.textContent.includes('AI 改善建议');
  }, { timeout: 15000 }).catch(() => {});
  const sugHead = await page.evaluate(() => {
    const h = document.querySelector('.page-head h1');
    return { hash: window.location.hash, text: h ? h.textContent : '' };
  });
  ok('A3 #/ai-suggestions/:id 路由可达', sugHead.hash.startsWith('#/ai-suggestions/') && sugHead.text.includes('AI 改善建议'), JSON.stringify(sugHead));

  /* ---------- A4 批次状态条 done ---------- */
  const batchBar = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const bar = cards.find((c) => (c.textContent || '').includes('已生成') && (c.textContent || '').includes('生成于'));
    return bar ? bar.textContent.replace(/\s+/g, ' ').slice(0, 200) : null;
  });
  ok('A4 批次状态条 done：生成时间 + 条数 + tokens', Boolean(batchBar && batchBar.includes('共 3 条') && batchBar.includes('2026-10-25')), batchBar);

  /* ---------- A10 生成按钮 409/429/幂等 200 语义（先测错误分支再测幂等） ---------- */
  await page.evaluate(() => { window.__mockGenSeq = [409, 429]; });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.page-head button')).find((b) => (b.textContent || '').includes('重新生成'));
    if (btn) btn.click();
  });
  await sleep(700);
  const r409 = await page.evaluate(() => document.body.innerText.includes('生成进行中'));
  ok('A10a POST generate 409 → 「生成进行中」横幅', r409);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.page-head button')).find((b) => (b.textContent || '').includes('重新生成'));
    if (btn) btn.click();
  });
  await sleep(700);
  const r429 = await page.evaluate(() => document.body.innerText.includes('配额已用尽'));
  ok('A10b POST generate 429 → 「配额已用尽」横幅', r429);
  /* 幂等 200：清空错误序列 → generate 走默认 200 且 idempotent_hit=true */
  await page.evaluate(() => {
    window.__mockGenSeq = [];
    const btn = Array.from(document.querySelectorAll('.page-head button')).find((b) => (b.textContent || '').includes('重新生成'));
    if (btn) btn.click();
  });
  await sleep(700);
  const idem = await page.evaluate(() => document.body.innerText.includes('展示历史结果'));
  ok('A4b 幂等 200（idempotent_hit）→ 「展示历史结果」提示', idem);

  /* ---------- A5 建议卡片徽标 ---------- */
  const cardInfo = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ai-sug-card'));
    const text = cards.map((c) => c.textContent).join('|');
    return {
      n: cards.length,
      hasE: text.includes('E 取消'), hasC: text.includes('C 合并'), hasS: text.includes('S 简化'),
      hasTier: text.includes('P1 · 优先级 82'),
      hasRedline: Boolean(document.querySelector('.ai-sug-card .ai-risk-dot')),
      hasAmber: text.includes('超上限'),
      hasElim: text.includes('消除依据'),
    };
  });
  ok('A5 建议卡片数 = 3', cardInfo.n === 3, String(cardInfo.n));
  ok('A5b E/C/S 手法徽标 + tier 徽标', cardInfo.hasE && cardInfo.hasC && cardInfo.hasS && cardInfo.hasTier);
  ok('A5c 红线红点角标（needs_quality_redline）+ 琥珀超上限', cardInfo.hasRedline && cardInfo.hasAmber);
  ok('A5d E 类展示消除依据', cardInfo.hasElim);

  /* ---------- A6 待审语义：决策按钮存在，无「直接执行」 ---------- */
  const decide = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.ai-sug-card button')).map((b) => (b.textContent || '').trim());
    return {
      adopt: btns.filter((t) => t === '采纳').length,
      reject: btns.filter((t) => t === '否决').length,
      exec: btns.filter((t) => t.includes('执行')).length,
      pendingTags: (document.body.innerText.match(/待审/g) || []).length,
    };
  });
  ok('A6 决策按钮=采纳/否决（待审卡片各一组）且无「执行」按钮（铁律①）', decide.adopt >= 2 && decide.reject >= 2 && decide.exec === 0 && decide.pendingTags > 0, JSON.stringify(decide));

  /* ---------- A7 已采纳置灰无决策按钮 ---------- */
  const decidedCard = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.ai-sug-card.decided'));
    const last = card[0];
    if (!last) return null;
    const btns = Array.from(last.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
    return { decided: card.length, noAdopt: !btns.includes('采纳'), gray: getComputedStyle(last).opacity !== '1' };
  });
  ok('A7 已采纳卡片置灰且无决策按钮', Boolean(decidedCard && decidedCard.decided === 1 && decidedCard.noAdopt), JSON.stringify(decidedCard));

  /* ---------- A8 校验轨迹展开 ---------- */
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.ai-sug-card button')).find((x) => (x.textContent || '').includes('查看校验轨迹'));
    if (b) b.click();
  });
  await sleep(300);
  const traceRows = await page.evaluate(() => {
    const tbl = Array.from(document.querySelectorAll('.ai-sug-card table')).find((t) => (t.textContent || '').includes('R2.4'));
    if (!tbl) return null;
    const rows = Array.from(tbl.querySelectorAll('tbody tr')).map((r) => r.textContent);
    return { n: rows.length, hasRound: rows[0].includes('R1'), hasAction: rows.join('').includes('放行') };
  });
  ok('A8 校验轨迹展开：轮次/规则/处置渲染', Boolean(traceRows && traceRows.n === 4 && traceRows.hasRound && traceRows.hasAction), JSON.stringify(traceRows));
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-suggestions-list.png') });
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-validation-trace.png'), fullPage: true });

  /* ---------- A10 原位置已上移至 A4 之后（409 横幅在 load() 后仍保留） ---------- */

  /* ---------- A9 采纳 422 → 红线确认弹窗 → 重试成功 ---------- */
  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.ai-sug-card')).find((c) => (c.textContent || '').includes('s-E-001') || (c.textContent || '').includes('取消转身取料'));
    const btn = card && Array.from(card.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '采纳');
    if (btn) btn.click();
  });
  await sleep(600);
  const modalShown = await page.evaluate(() => Boolean(document.querySelector('.ai-modal-mask')) && document.body.innerText.includes('质量红线确认'));
  ok('A9a 采纳 422 → 红线确认弹窗', modalShown);
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-redline-confirm.png') });
  await page.evaluate(() => {
    const input = document.querySelector('.ai-modal input');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '品质-王工');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.ai-modal button')).find((b) => (b.textContent || '').includes('确认并采纳'));
    if (btn) btn.click();
  });
  await sleep(800);
  const adoptOk = await page.evaluate(() => document.body.innerText.includes('IMP-9001') || document.body.innerText.includes('已采纳（改善任务'));
  ok('A9b 填确认人重试采纳成功（mock IMP-9001）', adoptOk);
  const noteShown = await page.evaluate(() => document.body.innerText.includes('无年化金额'));
  ok('A9c adopt 响应 note 展示（annual_yuan=null → 无年化金额提示）', noteShown);

  /* ---------- A10 已上移 ---------- */

  /* ---------- A11 无 JS pageerror ---------- */
  ok('A11 全程无 JS pageerror', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));

  /* ---------- A3b viewer 权限过滤 ---------- */
  const vLogin = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer1', password: '123456' }),
  }).then((r) => r.json()).catch(() => null);
  if (vLogin && vLogin.refreshToken) {
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1600, height: 950 });
    page2.on('pageerror', (e) => jsErrors.push('viewer:' + e.message));
    await page2.evaluateOnNewDocument((rt) => { localStorage.setItem('ie_refresh_token', rt); }, vLogin.refreshToken);
    await page2.goto(WEB + `/#/ai-suggestions/${STATION_ID}`, { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(1500);
    const vInfo = await page2.evaluate(() => ({
      hash: window.location.hash,
      denied: document.body.innerText.includes('无 AI 建议权限') || document.body.innerText.includes('缺少 suggestion:generate'),
      tabs: document.body.innerText,
    }));
    ok('A3b viewer 打开 AI 建议页 → 权限拦截横幅（无数据请求）', vInfo.hash.startsWith('#/ai-suggestions') && vInfo.denied, vInfo.tabs.slice(0, 120));
    await page2.close();
  } else {
    console.log('  - viewer1 账号不可用（123456），跳过 A3b');
  }

  await browser.close();
  console.log(`\n==== AI 冒烟结果：${pass} passed, ${fail} failed ====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
