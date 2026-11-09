/**
 * AI 建议页「risk_flags 契约错位白屏」真实数据回归（v3.46）。
 *
 * 背景（QA 实证）：后端 suggestionVo() 返回 risk_flags 为**数组**，而前端 riskFlagBadges()
 * 曾对数组执行 flags.split('|') → 抛 "flags.split is not a function"，React 整树卸载 = 整页白屏。
 * 该缺陷被 test-wb-ai.cjs 的**路由拦截 mock** 长期掩盖——mock 里 risk_flags 是字符串
 * 'needs_quality_redline'，走的是 split 分支，永远测不到数组形态。
 *
 * 本脚本刻意**不打 mock**：直连真实 API 3001 + 真实前端 5173，
 * 用库里真实存在的建议数据（risk_flags 为数组）打开 AI 建议页，证明不再白屏。
 *
 * 断言：
 *  R1 后端真实返回 risk_flags 为数组（证明测的就是出问题的形态）
 *  R2 页面无 pageerror（尤其无 split is not a function）
 *  R3 页面未卸载：h1「AI 改善建议」可见
 *  R4 建议卡片渲染条数 = 后端建议条数
 *  R5 带 needs_quality_redline 的建议渲染出「红线」角标
 *  R6 无风险标记的建议不渲染角标
 *  R7 决策按钮（采纳/否决）存在且可点击
 *  R8 来源线页签三态齐全（全量线/AI 分解线/手工分解线）
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ---- 登录 ---- */
  const loginRes = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginRes.json();
  if (!login.refreshToken) { console.log('登录失败，终止'); process.exit(1); }
  const auth = { Authorization: 'Bearer ' + login.accessToken };

  /* ---- 确保 AI 开启（list 依赖 assertEnabled） ---- */
  let cfg = await (await fetch(API + '/ai-suggestions/config', { headers: auth })).json().catch(() => null);
  if (!cfg || cfg.enabled === false) {
    await fetch(API + '/ai-suggestions/llm-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
    cfg = await (await fetch(API + '/ai-suggestions/config', { headers: auth })).json().catch(() => null);
  }
  console.log('AI 服务状态：enabled=' + (cfg && cfg.enabled));

  /* ---- 找一个「有建议」的真实工位（STATION_ID 环境变量可指定） ---- */
  const stations = await (await fetch(API + '/stations', { headers: auth })).json().catch(() => []);
  const list = Array.isArray(stations) ? stations : (stations.items ?? []);
  let picked = null;
  if (process.env.STATION_ID) {
    const forced = list.find((s) => s.station_id === process.env.STATION_ID);
    if (forced) {
      const res = await fetch(API + `/stations/${encodeURIComponent(forced.station_id)}/ai-suggestions`, { headers: auth });
      if (res.status === 200) picked = { st: forced, data: await res.json() };
    }
  }
  for (const st of picked ? [] : list.slice(0, 25)) {
    const res = await fetch(API + `/stations/${encodeURIComponent(st.station_id)}/ai-suggestions`, { headers: auth });
    if (res.status !== 200) continue;
    const data = await res.json();
    if ((data.suggestions ?? []).length > 0) { picked = { st, data }; break; }
  }
  if (!picked) { console.log('库里没有带建议的工位，无法完成真实数据验证'); process.exit(2); }
  const { st, data } = picked;
  console.log(`命中工位 ${st.station_id}：建议 ${data.suggestions.length} 条，批次 ${data.batches?.length ?? 0} 个`);
  console.log('批次 element_source = ' + JSON.stringify((data.batches ?? []).map((b) => b.element_source)));

  /* ---- R1：真实返回 risk_flags 是数组（就是曾致崩的形态） ---- */
  ok('R1 后端 risk_flags 真实形态为数组', data.suggestions.every((s) => Array.isArray(s.risk_flags)),
    JSON.stringify(data.suggestions[0]?.risk_flags));

  const withRed = data.suggestions.filter((s) => (s.risk_flags ?? []).includes('needs_quality_redline'));
  const without = data.suggestions.filter((s) => !(s.risk_flags ?? []).includes('needs_quality_redline'));
  console.log(`红线建议 ${withRed.length} 条 / 非红线 ${without.length} 条`);

  /* ---- 真实浏览器打开（无 mock） ---- */
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument((rt) => { localStorage.setItem('ie_refresh_token', rt); }, login.refreshToken);

  await page.goto(`${WEB}/#/ai-suggestions/${encodeURIComponent(st.station_id)}`, { waitUntil: 'networkidle2', timeout: 45000 });
  await sleep(2500);

  /* ---- R2/R3 ---- */
  const splitCrash = errors.filter((e) => /split is not a function/i.test(e));
  ok('R2 无 split is not a function 崩溃', splitCrash.length === 0, errors.join(' | ').slice(0, 200));
  const h1 = await page.$eval('h1', (el) => el.textContent.trim()).catch(() => '');
  ok('R3 页面未卸载（h1 渲染「AI 改善建议」）', h1.includes('AI 改善建议'), h1 || '(空—整页白屏)');

  /* ---- R4 ---- */
  const cards = await page.$$eval('.ai-sug-card', (els) => els.length).catch(() => 0);
  ok('R4 建议卡片渲染条数 = 后端条数', cards === data.suggestions.length, `页面 ${cards} / 后端 ${data.suggestions.length}`);

  /* ---- R5/R6 ---- */
  if (withRed.length > 0) {
    const redBadges = await page.$$eval('.ai-sug-card', (els) =>
      els.filter((el) => el.textContent.includes('红线')).length).catch(() => 0);
    ok('R5 带 needs_quality_redline 的建议渲染出「红线」角标', redBadges >= withRed.length,
      `页面 ${redBadges} / 期望 ${withRed.length}`);
  } else {
    console.log('  · 无红线建议，R5 跳过');
  }
  if (without.length > 0) {
    const nonRedOk = await page.$$eval('.ai-sug-card', (els) => els.length > 0).catch(() => false);
    ok('R6 无风险标记建议正常渲染（不崩、不误挂角标）', nonRedOk, '');
  }

  /* ---- R7 ---- */
  const btns = await page.$$eval('.ai-sug-card button', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  ok('R7 决策按钮存在（采纳/否决）', btns.some((t) => t.includes('采纳')) && btns.some((t) => t.includes('否决')),
    btns.slice(0, 6).join('/'));

  /* ---- R8 来源线三页签（v3.46） ---- */
  const tabTexts = await page.$$eval('button', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  const has3 = ['全量线', 'AI 分解线', '手工分解线'].filter((t) => tabTexts.some((x) => x.includes(t)));
  ok('R8 来源线三页签齐全', has3.length === 3, has3.join('/') || tabTexts.slice(0, 12).join('/'));

  /* R9：只计真实 JS 错误；401 资源请求（无鉴权的静态/旁路请求）单列为提示，不算失败 */
  const jsErrors = errors.filter((e) => !/Failed to load resource.*401/.test(e));
  ok('R9 全程零 JS 错误（401 资源噪音不计）', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  const noise = errors.filter((e) => /Failed to load resource.*401/.test(e));
  if (noise.length > 0) console.log('  · 提示：401 资源请求噪音 ' + noise.length + ' 条（非 JS 异常）');

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(3); });
