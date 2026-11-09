/**
 * AI 分解写入链路真实规模压测（v3.39 P0-1）
 *
 * 走真实产品 UI 全链路：全片分析 → 全选 → UI 写入 → API 回读校验 →
 * 后端纯 submit 计时与响应大小 → 工作台 UI 回读。
 * 覆盖 V1/V2/V3 校验、整版删除重插事务、136 条规模的耗时与响应。
 *
 * 用法：node test-ai-segment-write-stress.cjs [videoPath]
 * 环境变量：MAX_WAIT_MS（分析等待上限，默认 1500000）
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SID = 'PA10';
const CMC_LINE = 392;
const VIDEO = process.argv[2] || path.resolve(__dirname, '..', '..', 'SH-FA9-A12-PA10-1.mp4');
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 1500000); // 全片分析约 11–12 分钟
const OUT = path.resolve(__dirname, '..', '..', 'deliverables', 'ai-segment', 'real');

let ok = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { ok += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + '  ' + extra); }
}

async function call(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, bytes: Buffer.byteLength(text) };
}

(async () => {
  const login = await call('POST', '/auth/login', { username: 'admin', password: '123456' });
  const token = login.body && login.body.accessToken;
  check('登录成功', !!token, `status=${login.status}`);
  if (!token) process.exit(1);

  // ── 重置工位：删掉重建，保证 v1 零要素的确定性起点 ──
  await call('DELETE', '/stations/' + SID, undefined, token);
  const made = await call('POST', '/stations/from-cmc', {
    cmc_line_id: CMC_LINE, station_id: SID, name: 'PA10 装配工位（真实视频验证）', tt: 60,
  }, token);
  check('重建 PA10 工位（v1 零要素）', (made.status === 200 || made.status === 201) && made.body && made.body.version === 1,
    `status=${made.status} ${JSON.stringify(made.body).slice(0, 120)}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: MAX_WAIT_MS + 300000,
  });

  const report = { video: VIDEO, startedAt: new Date().toISOString(), steps: [] };
  const log = (m) => { console.log(m); report.steps.push(m); };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    const pageErrors = [];
    page.on('pageerror', (e) => { pageErrors.push(e.message.slice(0, 200)); log('[pageerror] ' + e.message.slice(0, 200)); });

    // 引导（v3.39 确定性模式）：token 在首个文档脚本前注入，杜绝跨文档刷新重放。
    // 条件注入：仅当 localStorage 无 token 时才写——万一次级文档导航发生，
    // 沿用已轮换的当前值，绝不重写原始 token（那会触发重放检测吊销全部会话）。
    await page.evaluateOnNewDocument((rt) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
      localStorage.removeItem('ai-seg-detector');
    }, login.body.refreshToken);
    await page.goto(`${WEB}/#/ai-segment/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction((rt) => localStorage.getItem('ie_refresh_token') !== rt,
      login.body.refreshToken, { timeout: 30000 });
    await page.waitForSelector('.aip-head', { timeout: 30000 });
    log('页面就绪：' + (await page.$eval('.aip-meta', (e) => e.textContent.trim())));

    // ── 载入全片视频（本地文件，零上传）──
    const input = await page.$('input[aria-label="选择本地视频文件"]');
    await input.uploadFile(VIDEO);
    await page.waitForFunction(() => {
      const v = document.querySelector('.aip-video video');
      return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    }, { timeout: 180000, polling: 500 });
    const meta = await page.evaluate(() => {
      const v = document.querySelector('.aip-video video');
      return { duration: +v.duration.toFixed(2), w: v.videoWidth, h: v.videoHeight };
    });
    log(`视频载入：${meta.w}x${meta.h} · ${meta.duration}s`);
    report.videoMeta = meta;

    // ── 全片分析 ──
    await page.evaluate(() => {
      [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析')).click();
    });
    const tAnalyze = Date.now();
    log('已点击「开始分析」，等待完成（全片约 11–12 分钟）…');
    await page.waitForFunction(() => document.querySelectorAll('.ais-table tbody tr').length > 0,
      { timeout: MAX_WAIT_MS, polling: 2000 });
    const analyzeSec = Math.round((Date.now() - tAnalyze) / 1000);
    log(`分析完成：${analyzeSec}s（${(analyzeSec / meta.duration).toFixed(2)}× 实时）`);
    report.analyzeSec = analyzeSec;

    const rows = await page.evaluate(() => [...document.querySelectorAll('.ais-table tbody tr')].map((tr) => {
      const td = tr.querySelectorAll('td');
      const inp = tr.querySelectorAll('input');
      const confTxt = td[5] ? td[5].textContent.trim() : '';
      const tierM = /·\s*(高|中|低)/.exec(confTxt);
      return {
        id: td[1] ? td[1].textContent.trim() : '',
        hand: tr.querySelector('select').value,
        span: td[3] ? td[3].textContent.trim() : '',
        dur: parseFloat(td[4].textContent),
        tier: tierM ? (tierM[1] === '高' ? 'high' : tierM[1] === '中' ? 'mid' : 'low') : '?',
        include: inp[0] ? inp[0].checked : false,
        type: inp[1] ? inp[1].value : '',
        desc: inp[2] ? inp[2].value : '',
      };
    }));
    report.candidates = rows;
    const durs = rows.map((r) => r.dur).sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)];
    const midPct = (durs.filter((d) => d >= 1 && d < 2).length / durs.length * 100).toFixed(1);
    log(`候选 ${rows.length} 条 | 中位 ${med}s | 1.0–1.9s 占比 ${midPct}% | 分层 高${rows.filter((r) => r.tier === 'high').length}/中${rows.filter((r) => r.tier === 'mid').length}/低${rows.filter((r) => r.tier === 'low').length}`);
    check('全片候选 ≥ 100 条（v3.38b 预期 ~136）', rows.length >= 100, rows.length);
    check('中位时长 ≥ 2.0s（微停顿过切已修复）', med >= 2.0, med + 's');
    check('1.0–1.9s 占比 < 35%（v3.37 为 51.9%）', parseFloat(midPct) < 35, midPct + '%');
    check('类型 100% 有值（不再恒「其他」）', rows.every((r) => r.type && r.type.trim()), rows.filter((r) => !r.type).length + ' 条为空');
    check('描述 100% 为标准库骨架', rows.every((r) => r.desc && r.desc.trim() && !/^AI 候选/.test(r.desc)),
      rows.filter((r) => !r.desc || /^AI 候选/.test(r.desc)).length + ' 条不合格');

    // ── 全选 → UI 写入（计时）──
    const allChk = await page.$('input[aria-label="全选"]');
    if (!(await page.evaluate(() => document.querySelector('input[aria-label="全选"]').checked))) {
      await allChk.click();
    }
    const included = await page.evaluate(() => document.querySelectorAll('.ais-table tbody input[type=checkbox]:checked').length);
    log(`全选后纳入 ${included} 条`);
    check('全选生效（纳入 = 全部候选）', included === rows.length, `${included}/${rows.length}`);

    // 真实鼠标点击（v3.39 #92 实锤：evaluate 里 el.click() 对 React 受控组件不可靠）
    const clickByText = async (sel, text) => {
      const h = await page.evaluateHandle((s, t) =>
        [...document.querySelectorAll(s + ' button')].find((b) => b.textContent.includes(t)) || null, sel, text);
      const el = h.asElement();
      if (!el) throw new Error('找不到按钮: ' + text);
      await el.click();
      await h.dispose();
    };
    await clickByText('.aip-foot', '写入本工位');
    await page.waitForSelector('.aip-confirm', { timeout: 15000 });
    const tWrite = Date.now();
    await clickByText('.aip-confirm', '确认写入');
    await page.waitForFunction(() => /已写入 v\d+：要素 \d+ 条/.test(document.body.innerText),
      { timeout: 180000, polling: 500 });
    const writeMs = Date.now() - tWrite;
    const savedTxt = await page.evaluate(() => {
      const m = document.body.innerText.match(/已写入 v\d+：要素 \d+ 条，CT [\d.]+s[^。]*。/);
      return m ? m[0] : '';
    });
    log(`UI 写入完成：${writeMs}ms — ${savedTxt}`);
    report.writeMs = writeMs;
    check('UI 写入成功且条数一致', new RegExp(`要素 ${included} 条`).test(savedTxt), savedTxt);
    check('写入耗时 < 60s（136 条规模）', writeMs < 60000, writeMs + 'ms');
    await page.screenshot({ path: path.join(OUT, 'stress-write-done.png') });

    // ── API 回读校验 ──
    const back = await call('GET', `/stations/${SID}/elements`, undefined, token);
    const els = (back.body && back.body.elements) || [];
    check('回读条数 = 纳入条数', els.length === included, `${els.length}/${included}`);
    check('source 全部落库 ai_assisted', els.length > 0 && els.every((e) => e.source === 'ai_assisted'),
      JSON.stringify([...new Set(els.map((e) => e.source))]));
    check('video_id 全部为 ai-segment', els.length > 0 && els.every((e) => e.video_id === 'ai-segment'));
    check('V1：描述全部非空', els.every((e) => e.desc && e.desc.trim()));
    check('V1：类型全部非空', els.every((e) => e.type && e.type.trim()));
    const sorted = [...els].sort((a, b) => a.seq - b.seq);
    let overlap = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_ms + 1 < sorted[i - 1].start_ms + Math.round(sorted[i - 1].dur_s * 1000)) overlap++;
    }
    check('V2：时间链无重叠（累加光标生效）', overlap === 0, overlap + ' 处重叠');

    // ── 后端纯 submit 计时（同一 payload 再写一次，隔离 UI 开销）──
    const elements = [];
    let cursor = 0;
    for (const el of sorted) {
      const dur = Math.max(0.1, Math.round(el.dur_s * 100) / 100);
      elements.push({
        seq: elements.length + 1, start_ms: cursor, dur_s: dur, hand: el.hand, type: el.type, desc: el.desc,
        va_class: el.va_class, outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15, source: 'ai_assisted',
      });
      cursor += Math.round(dur * 1000);
    }
    const tApi = Date.now();
    const sub = await call('POST', `/stations/${SID}/elements/submit`,
      { bol_version: 1, cycle_count: 15, cv: 0, video_id: 'ai-segment', elements }, token);
    const apiMs = Date.now() - tApi;
    log(`后端纯 submit：${apiMs}ms · 响应 ${sub.bytes}B · ${JSON.stringify(sub.body).slice(0, 100)}`);
    report.apiSubmit = { ms: apiMs, bytes: sub.bytes, status: sub.status };
    check('后端 submit 成功', sub.status === 200 || sub.status === 201, `status=${sub.status}`);
    check('后端 element_count 一致', sub.body && sub.body.element_count === included, JSON.stringify(sub.body));
    check('后端 submit < 30s', apiMs < 30000, apiMs + 'ms');
    // CT 在 submit 响应里（GET elements 不含 ct），必须等 sub 声明之后断言
    check('CT 已计算（submit 响应）', sub.body && Number(sub.body.ct) > 0, JSON.stringify({ ct: sub.body && sub.body.ct }));
    report.readBack = { count: els.length, ct: sub.body && sub.body.ct, bytes: back.bytes };

    const back2 = await call('GET', `/stations/${SID}/elements`, undefined, token);
    check('二次写入后回读仍一致', (back2.body && back2.body.elements || []).length === included,
      (back2.body && back2.body.elements || []).length + '');

    // ── 工作台 UI 回读：时间线上的要素块数 ──
    // 注意：evaluate 回调运行在浏览器上下文，外部常量必须显式传参（坑：SID is not defined）
    await page.evaluate((sid) => { window.location.hash = '#/workbench/' + sid; }, SID);
    await page.waitForFunction(() => document.querySelector('.wb-tlstrip'), { timeout: 30000 });
    // 时间线默认展开；若折叠则点开
    const opened = await page.evaluate(() => {
      if (document.querySelector('.wb-tlstrip .timeline')) return true;
      const btn = document.querySelector('.wb-tlstrip-toggle');
      if (btn) { btn.click(); return true; }
      return false;
    });
    await page.waitForFunction(() => document.querySelectorAll('.tl-lane .block').length > 0,
      { timeout: 60000, polling: 500 });
    const blocks = await page.evaluate(() => document.querySelectorAll('.tl-lane .block').length);
    log(`工作台时间线要素块：${blocks}`);
    check('工作台回读全部要素（块数一致）', blocks === included, `${blocks}/${included}`);
    const wbStats = await page.evaluate(() => {
      const s = document.querySelector('.wb-stats');
      return s ? s.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    });
    log('工作台统计：' + wbStats);
    await page.screenshot({ path: path.join(OUT, 'stress-workbench.png') });

    check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));
    report.finishedAt = new Date().toISOString();
    require('fs').writeFileSync(path.join(OUT, 'stress-write-result.json'), JSON.stringify(report, null, 1));
    log('报告 → deliverables/ai-segment/real/stress-write-result.json');
    log('PA10 工位保留 ' + included + ' 条 AI 要素（真实数据，可作演示）');
  } finally {
    await browser.close();
  }

  console.log('\n结果: ' + ok + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
