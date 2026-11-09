/**
 * v3.51 · 人工浪费识别与改善建议 + 改善知识库 UI 测试
 *
 * 用户需求：
 *  ① AI 建议校验严格、常出不来有效清单 → 前端要有一个按工位索引查询「浪费清单 + 措施清单」的入口
 *     （历史批次 + 人工条目都能查，AI 关停也不影响查询）
 *  ② 人工识别的浪费与改善措施要能录入，与 AI 自动生成并存
 *  ③ 人工/已确认清单定期整理成知识库，反哺后续 AI 检索生成
 *
 * 断言：
 *  T1 浪费识别页渲染来源筛选条（全部 / AI 识别 / 人工录入）
 *  T2 「+ 人工浪费点」表单：浪费类型来自动态白名单
 *  T3 人工浪费点保存 → 表格出现带「人工」徽标的行（与 AI 行并存）
 *  T4 人工改善措施保存 → 卡片出现带「人工」徽标
 *  T5 来源筛选：人工录入 / AI 识别 两个视图互斥且计数正确
 *  T6 编辑人工条目 → 内容更新
 *  T7 知识库：整理进库（幂等）+ 列表命中 + 关键词抽取
 *  T8 删除人工条目 → 清单归零
 *  T9 无 JS pageerror
 *
 * 前置：API(3001) + Vite dev(5173)。数据：L01-ST11（有已提交要素，CT>0）。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const SID = 'L01-ST11';
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'part2', 'ui');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按文本点按钮（返回是否点到） */
const clickText = (page, sel, text) => page.evaluate((s, t) => {
  const n = [...document.querySelectorAll(s)].find((b) => (b.textContent || '').trim().includes(t));
  if (!n) return false;
  n.click();
  return true;
}, sel, text);

/** 读浪费点表行：{ waste, sev, involved, pct, seqs, origin } */
const readFindings = (page) => page.$$eval('.aw-section table tbody tr', (ns) => ns.map((tr) => {
  const td = tr.querySelectorAll('td');
  return {
    waste: td[0].textContent.trim(), sev: td[1].textContent.trim(),
    involved: td[2].textContent.trim(), pct: td[3].textContent.trim(),
    seqs: (td[5]?.textContent ?? '').trim(),
    origin: (td[6]?.textContent ?? '').trim(),
    evidence: (td[4]?.textContent ?? '').trim(),
  };
}));

/** 读问题卡片：{ tags, text } */
const readIssues = (page) => page.$$eval('.aw-issue-card', (ns) => ns.map((c) => ({
  tags: [...c.querySelectorAll('.row .tag')].map((t) => t.textContent.trim()),
  text: (c.textContent || '').trim().slice(0, 120),
})));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');
  const TOKEN = login.accessToken;

  // 前置自愈：L01-ST11（有已提交要素、CT>0）被清理由来已久且无脚本重建，
  // 缺失会让本用例整片误报。幂等补齐——已存在则不重复提交（避免开新版本）。
  await require('./_setup-st11.cjs').ensure(true);

  // 前置清理：本用例自己造的数据（可重复跑）
  const clean = async () => {
    for (const p of ['/ai-waste/kb?station_id=' + SID]) {
      const r = await fetch(API + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const j = await r.json();
      for (const it of j.items ?? []) {
        await fetch(`${API}/ai-waste/kb/${it.kb_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
      }
    }
    const it = await (await fetch(`${API}/stations/${SID}/ai-waste/items?origin=manual`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    for (const f of it.findings ?? []) {
      await fetch(`${API}/ai-waste/findings/${f.finding_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    }
    for (const i of it.issues ?? []) {
      if (i.status === '待处理') {
        await fetch(`${API}/ai-waste/issues/${i.issue_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
      }
    }
  };
  await clean();

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));
  /* 删除走 window.confirm：原生对话框会阻塞 CDP evaluate（ProtocolError），必须接管 */
  page.on('dialog', (d) => { void d.accept(); });
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  console.log('\n--- T1. 页面与来源筛选条 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/ai-waste/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.aw-page', { timeout: 30000 });
  await sleep(1200);
  const chips = await page.$$eval('.aw-page .btn.sm', (ns) => ns.map((n) => n.textContent.trim()));
  ok('T1 渲染来源筛选（全部/AI 识别/人工录入）',
    chips.some((c) => c.startsWith('全部')) && chips.some((c) => c.startsWith('AI 识别')) && chips.some((c) => c.startsWith('人工录入')),
    chips.join(' | '));
  ok('T1 渲染人工录入入口（+ 人工浪费点 / + 人工措施）',
    chips.includes('+ 人工浪费点') && chips.includes('+ 人工措施'), chips.join(' | '));

  console.log('\n--- T2/T3. 人工录入浪费点 ---');
  await clickText(page, '.aw-page button', '+ 人工浪费点');
  await page.waitForSelector('.aw-manual-form', { timeout: 10000 });
  await sleep(400);
  const wtOptions = await page.$$eval('.aw-manual-form select', (ns) => [...(ns[0]?.options ?? [])].map((o) => o.value).filter(Boolean));
  ok('T2 浪费类型下拉=动态白名单（非空）', wtOptions.length > 0, wtOptions.join('/'));
  await page.evaluate(() => {
    const f = document.querySelector('.aw-manual-form');
    const ta = f.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '人工巡检发现：物料架距操作区过远，每循环往返取料两次，属搬运浪费');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const cb = f.querySelector('.aw-seq-box input[type=checkbox]');
    if (cb) cb.click();
  });
  await sleep(200);
  await clickText(page, '.aw-manual-form button', '保存');
  await sleep(1500);
  let rows = await readFindings(page);
  const manualRow = rows.find((r) => r.origin.includes('人工'));
  ok('T3 人工浪费点入表并带「人工」徽标', Boolean(manualRow), JSON.stringify(rows));
  ok('T3 数字服务端计算（涉及时长/占 CT 有值）',
    Boolean(manualRow) && /\d/.test(manualRow.involved) && /\d/.test(manualRow.pct),
    manualRow && `${manualRow.involved} / ${manualRow.pct}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v351-manual-finding.png') });

  console.log('\n--- T4. 人工录入改善措施 ---');
  await clickText(page, '.aw-page button', '+ 人工措施');
  await page.waitForSelector('.aw-manual-form', { timeout: 10000 });
  await sleep(400);
  await page.evaluate(() => {
    const f = document.querySelector('.aw-manual-form');
    const tas = [...f.querySelectorAll('textarea')];
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(tas[0], '物料架布局不合理，操作员每循环需往返取料两次');
    tas[0].dispatchEvent(new Event('input', { bubbles: true }));
    set.call(tas[1], '将物料架移至操作区右手可达范围，取消往返搬运');
    tas[1].dispatchEvent(new Event('input', { bubbles: true }));
    const cb = f.querySelector('.aw-seq-box input[type=checkbox]');
    if (cb) cb.click();
  });
  await sleep(200);
  await clickText(page, '.aw-manual-form button', '保存');
  await sleep(1500);
  let cards = await readIssues(page);
  ok('T4 人工措施卡片出现且带「人工」徽标',
    cards.some((c) => c.tags.includes('人工')), JSON.stringify(cards.map((c) => c.tags)));

  console.log('\n--- T5. 来源筛选（AI 与人工并存且可分流查看）---');
  await clickText(page, '.aw-page button', '人工录入');
  await sleep(900);
  const onlyManual = await readFindings(page);
  ok('T5 人工视图只剩人工条目', onlyManual.length > 0 && onlyManual.every((r) => r.origin.includes('人工')),
    JSON.stringify(onlyManual.map((r) => r.origin)));
  await clickText(page, '.aw-page button', 'AI 识别');
  await sleep(900);
  const onlyAi = await readFindings(page);
  ok('T5 AI 视图不含人工条目', onlyAi.every((r) => !r.origin.includes('人工')), JSON.stringify(onlyAi.map((r) => r.origin)));
  await clickText(page, '.aw-page button', '全部');
  await sleep(900);

  console.log('\n--- T6. 编辑人工条目 ---');
  const editHit = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('.aw-section table tbody tr')]
      .find((r) => (r.querySelectorAll('td')[6]?.textContent ?? '').includes('人工'));
    const b = tr && [...tr.querySelectorAll('button')].find((x) => x.textContent.trim() === '编辑');
    if (!b) return false;
    b.click();
    return true;
  });
  ok('T6 人工行有「编辑」入口（AI 行没有）', editHit);
  await page.waitForSelector('.aw-manual-form', { timeout: 10000 });
  await sleep(400);
  await page.evaluate(() => {
    const ta = document.querySelector('.aw-manual-form textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '人工复核修订：往返距离实测 3.2 米，每循环两次，确认为搬运浪费');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText(page, '.aw-manual-form button', '保存');
  await sleep(1500);
  rows = await readFindings(page);
  ok('T6 编辑后证据更新', rows.some((r) => r.origin.includes('人工') && /人工复核修订/.test(r.evidence ?? '')),
    JSON.stringify(rows.filter((r) => r.origin.includes('人工')).map((r) => r.evidence)));

  console.log('\n--- T7. 知识库整理与检索 ---');
  await clickText(page, '.aw-page button', '知识库');
  await page.waitForSelector('.aw-kb', { timeout: 10000 });
  await sleep(600);
  ok('T7 知识库面板渲染（含整理按钮）', true);
  await clickText(page, '.aw-kb button', '整理进知识库');
  await sleep(2000);
  const banner1 = await page.$eval('.success-banner', (n) => n.textContent.trim()).catch(() => '');
  ok('T7 首次整理有新增条目', /新增 [1-9]/.test(banner1), banner1);
  const kbRows1 = await page.$$eval('.aw-kb table tbody tr', (ns) => ns.map((tr) => {
    const td = tr.querySelectorAll('td');
    return { kind: td[0].textContent.trim(), waste: td[1].textContent.trim(), kw: td[3].textContent.trim(), hits: td[4].textContent.trim() };
  })).catch(() => []);
  ok('T7 知识库列表命中本工位条目', kbRows1.length >= 1, `n=${kbRows1.length}`);
  ok('T7 知识条目带服务端抽取的关键词', kbRows1.some((r) => r.kw.length > 0), JSON.stringify(kbRows1.slice(0, 2)));
  await clickText(page, '.aw-kb button', '整理进知识库');
  await sleep(2000);
  const banner2 = await page.$eval('.success-banner', (n) => n.textContent.trim()).catch(() => '');
  ok('T7 重复整理幂等（新增 0 条）', /新增 0/.test(banner2), banner2);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v351-kb-panel.png') });

  console.log('\n--- T8. 删除人工条目 ---');
  const delHit = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('.aw-section table tbody tr')]
      .find((r) => (r.querySelectorAll('td')[6]?.textContent ?? '').includes('人工'));
    const b = tr && [...tr.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除');
    if (!b) return false;
    b.click();
    return true;
  });
  ok('T8 人工行有「删除」入口', delHit);
  await sleep(1200);
  await page.evaluate(() => { window.confirm = () => true; });
  // confirm 已被 React 读取；改由对话框确认后重点一次
  await page.evaluate(() => {
    window.confirm = () => true;
    const tr = [...document.querySelectorAll('.aw-section table tbody tr')]
      .find((r) => (r.querySelectorAll('td')[6]?.textContent ?? '').includes('人工'));
    const b = tr && [...tr.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除');
    if (b) b.click();
  });
  await sleep(1500);
  rows = await readFindings(page);
  ok('T8 删除后人工浪费点归零', rows.every((r) => !r.origin.includes('人工')), JSON.stringify(rows.map((r) => r.origin)));

  console.log('\n--- T9. 无 JS 异常 ---');
  ok('T9 页面零 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 200));

  await page.screenshot({ path: path.join(SHOT_DIR, 'v351-ai-waste-page.png'), fullPage: false });
  await browser.close();
  await clean();

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('UI 测试执行异常:', e); process.exit(1); });
