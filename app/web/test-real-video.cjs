/**
 * 真实工位视频 · AI 自动分解端到端测试
 *
 * 走真实产品 UI（#/ai-segment/:stationId），不使用任何内部模块直调：
 *   载入视频 → 开始分析 → 等待完成 → 读取候选表 → 截图
 *
 * 用法：node test-real-video.cjs <视频绝对路径> <标签>
 * 产出：deliverables/ai-segment/real/<标签>-*.png + <标签>-result.json
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'PA10';
const OUT = path.resolve(__dirname, '..', '..', 'deliverables', 'ai-segment', 'real');

const VIDEO = path.resolve(process.argv[2] || '');
const TAG = process.argv[3] || 'run';
/** 分析总超时：默认 40 分钟（全片 391s × 10Hz 在集显上约 15–25 分钟） */
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 40 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(VIDEO)) throw new Error('视频不存在: ' + VIDEO);
  fs.mkdirSync(OUT, { recursive: true });

  const lr = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: MAX_WAIT_MS + 120000,
  });

  const report = { video: VIDEO, tag: TAG, startedAt: new Date().toISOString(), steps: [] };
  const log = (m) => { console.log(m); report.steps.push(m); };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => log('[pageerror] ' + e.message.slice(0, 300)));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !t.includes('favicon')) log('[console] ' + t.slice(0, 200));
    });

    /* v3.39 确定性引导（彻底替换旧的双 goto + reload 模式）：
       旧模式「goto(WEB)→setItem→goto(?b=N#/target)→reload」有跨文档竞态——
       doc0 的 React 若在导航前已挂载，会用旧 token 刷新一次，doc1 再刷新一次，
       同一 refresh token 被两个文档实例并发使用 → 服务端重放检测吊销全部会话
       → 页面「无故」退回登录页（单航班只能防同一模块实例，防不了跨文档）。
       新模式：token 在首个文档任何脚本之前注入（evaluateOnNewDocument），
       且仅在 localStorage 无 token 时才注入——重引导时沿用已轮换的当前值，
       绝不重复注入原始 token（那会触发重放检测）。?b=1 保证完整文档加载。 */
    await page.evaluateOnNewDocument((rt) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);
    await page.goto(`${WEB}/?b=1#/ai-segment/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.aip-head', { timeout: 30000 });
    log('页面就绪：' + (await page.$eval('.aip-meta', (e) => e.textContent.trim())));

    // 注入视频（不上传，走本地 object URL）
    const input = await page.$('input[type=file]');
    await input.uploadFile(VIDEO);
    await page.waitForFunction(() => {
      const v = document.querySelector('.aip-video video');
      return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    }, { timeout: 120000 });
    const meta = await page.evaluate(() => {
      const v = document.querySelector('.aip-video video');
      return { duration: +v.duration.toFixed(2), w: v.videoWidth, h: v.videoHeight };
    });
    log(`视频载入：${meta.w}x${meta.h} · ${meta.duration}s`);
    report.videoMeta = meta;

    // 开始分析（按钮此时不应再 disabled）
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析'));
      return b && !b.disabled;
    }, { timeout: 30000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析')).click();
    });
    const t0 = Date.now();
    log('已点击「开始分析」，等待完成…');

    // 进度采样（每 15s 记一次，便于观察是否卡住）
    let lastReport = 0;
    let done = false;
    while (Date.now() - t0 < MAX_WAIT_MS) {
      const st = await page.evaluate(() => {
        const running = !!document.querySelector('.aip-acts button')
          && [...document.querySelectorAll('.aip-acts button')].some((x) => x.textContent.includes('停止分析'));
        const count = document.querySelector('.ais-count');
        const err = document.querySelector('.aip-error');
        const empty = document.querySelector('.ais-empty');
        const rows = document.querySelectorAll('.ais-table tbody tr').length;
        return {
          running,
          count: count ? count.textContent.trim() : '',
          err: err ? err.textContent.trim() : '',
          empty: empty ? empty.textContent.trim().slice(0, 80) : '',
          rows,
        };
      });
      if (st.err) { report.error = st.err; log('分析报错：' + st.err); break; }
      if (!st.running) { done = true; report.countText = st.count; report.rows = st.rows; report.emptyText = st.empty; break; }
      if (Date.now() - lastReport > 15000) {
        lastReport = Date.now();
        log(`  ${Math.round((Date.now() - t0) / 1000)}s · ${st.count}`);
      }
      await sleep(1000);
    }

    report.elapsedSec = Math.round((Date.now() - t0) / 1000);
    log(`分析结束：耗时 ${report.elapsedSec}s，候选 ${report.rows ?? 0} 条`);

    // 抓候选明细
    const detail = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.ais-table tbody tr')];
      return rows.map((tr) => {
        const td = tr.querySelectorAll('td');
        const sel = tr.querySelector('select');
        const conf = td[5] ? td[5].textContent.trim() : '';
        return {
          id: td[1] ? td[1].textContent.trim() : '',
          hand: sel ? sel.value : '',
          span: td[3] ? td[3].textContent.trim() : '',
          dur: td[4] ? td[4].textContent.trim() : '',
          conf,
          // v3.38b 修：原来 /低/.test(conf) 会把分类依据里的「低幅」误判成 low
          // （实测 11 条全是 0.90·高，统计成 高6/低5）。必须取「· 」后的档位词。
          tier: (conf.match(/·\s*([高中低])/) || [])[1] === '低' ? 'low'
            : (conf.match(/·\s*([高中低])/) || [])[1] === '中' ? 'mid' : 'high',
          include: tr.querySelector('input[type=checkbox]').checked,
          // v3.38 补抓：类型/描述在 td[6]/td[7] 的 input 里（曾漏抓=端到端零验证）
          type: td[6]?.querySelector('input')?.value ?? '',
          desc: td[7]?.querySelector('input')?.value ?? '',
        };
      });
    });
    report.candidates = detail;

    const tiers = { high: 0, mid: 0, low: 0 };
    const hands = { L: 0, R: 0, B: 0 };
    let inclDur = 0;
    detail.forEach((d) => {
      tiers[d.tier] += 1;
      hands[d.hand] = (hands[d.hand] || 0) + 1;
      if (d.include) inclDur += parseFloat(d.dur) || 0;
    });
    report.tiers = tiers;
    report.hands = hands;
    report.includedDuration = +inclDur.toFixed(1);
    report.coveragePct = +(inclDur / (meta.duration || 1) * 100).toFixed(1);
    log(`分层 高${tiers.high}/中${tiers.mid}/低${tiers.low} · 手别 L${hands.L}/R${hands.R}/B${hands.B} · 覆盖 ${report.includedDuration}s (${report.coveragePct}%)`);

    await page.evaluate(() => {
      document.querySelector('.aip-body')?.scrollIntoView({ block: 'start' });
    });
    await page.screenshot({ path: path.join(OUT, `${TAG}-result.png`) });
    // 表头区域单独截一张，便于人工核对
    const head = await page.$('.aip-side-head');
    if (head) await head.screenshot({ path: path.join(OUT, `${TAG}-head.png`) }).catch(() => undefined);

    if (!done) log('警告：等待超时或已报错，结果可能不完整');
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, `${TAG}-result.json`), JSON.stringify(report, null, 2));
    console.log('\n结果已写入 ' + path.join(OUT, `${TAG}-result.json`));
  }
})().catch((e) => { console.error('TEST FAIL', e.message); process.exit(1); });
