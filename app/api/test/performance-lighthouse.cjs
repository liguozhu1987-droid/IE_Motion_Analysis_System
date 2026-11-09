/** W3：复用已登录的有界面 Chrome，对 200 工位综合看板执行 Lighthouse desktop。 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require(path.resolve(__dirname, '../../node_modules/puppeteer-core'));

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const BASE = process.env.BASE || 'http://127.0.0.1:3102/api';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3102';
const OUT_DIR = path.resolve(__dirname, '../../../deliverables');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_PORT = Number(process.env.PERF_CHROME_PORT || 9223);

function guard() {
  const u = new URL(BASE);
  const w = new URL(WEB);
  if (process.env.PERF_ISOLATED !== '1' || u.hostname !== '127.0.0.1' || u.port !== '3102' || w.hostname !== '127.0.0.1' || w.port !== '3102') {
    throw new Error('Lighthouse 只允许隔离 3102 服务');
  }
}

(async () => {
  guard();
  const loginRes = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginRes.json();
  if (!login.refreshToken) throw new Error(`隔离登录失败: HTTP ${loginRes.status}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    userDataDir: path.join(path.dirname(process.env.PERF_DB_PATH), 'chrome-lighthouse'),
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    args: ['--no-first-run', `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=1500,960'],
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((refreshToken) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', refreshToken);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);
    await page.goto(`${WEB}/?perf=warm#/dashboard`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.metric')].some((m) =>
      m.querySelector('.l')?.textContent?.trim() === '工位' && m.querySelector('.v')?.textContent?.trim() === '200',
    ), { timeout: 60000 });

    const lighthouseEntry = require.resolve('lighthouse', { paths: [path.resolve(__dirname, '../../web')] });
    const lighthouse = (await import(pathToFileURL(lighthouseEntry).href)).default;
    const target = `${WEB}/?perf=lighthouse#/dashboard`;
    const result = await lighthouse(target, {
      port: DEBUG_PORT, preset: 'desktop', output: 'json', logLevel: 'error',
      onlyCategories: ['performance'], disableStorageReset: true, maxWaitForLoad: 60000,
    });
    const lhr = result.lhr;
    fs.writeFileSync(path.join(OUT_DIR, 'PST-lighthouse-report.json'), JSON.stringify(lhr, null, 2));

    const network = lhr.audits['network-requests']?.details?.items || [];
    const dashboardResponses = network.filter((r) => new URL(r.url).pathname === '/api/dashboard/summary' && r.statusCode === 200 && r.resourceSize > 0);
    const stationResponse = network.find((r) => new URL(r.url).pathname === '/api/stations' && r.statusCode === 200 && r.resourceSize > 50000);
    // Lighthouse 结束后会整理/关闭目标 tab，不能靠事后 DOM 判断；预热 DOM 已确认 200，
    // 再以审计本身的 API 网络记录证明本次加载确实经过认证并取回 200 工位页面数据。
    const authenticatedDataset = {
      prewarm_dashboard_200: true,
      dashboard_api_200: dashboardResponses.length > 0,
      stations_api_200_over_50kb: Boolean(stationResponse),
      stations_resource_bytes: stationResponse?.resourceSize || 0,
      final_screenshot_present: Boolean(lhr.audits['final-screenshot']?.details),
    };
    const value = (id) => lhr.audits[id]?.numericValue ?? null;
    const lcp = value('largest-contentful-paint');
    const cls = value('cumulative-layout-shift');
    const runtimeOk = !lhr.runtimeError || lhr.runtimeError.code === 'NO_ERROR';
    const passed = runtimeOk && Object.values(authenticatedDataset).every(Boolean) && lcp < 2500 && cls < 0.1;
    const summary = {
      generated_at: new Date().toISOString(), target, mode: 'Lighthouse desktop / simulated throttling / local HTTP',
      lighthouse_version: lhr.lighthouseVersion, chrome_version: lhr.userAgent,
      authenticated_dataset: authenticatedDataset,
      metrics: {
        lcp_ms: lcp, cls, tbt_ms: value('total-blocking-time'), fcp_ms: value('first-contentful-paint'),
        speed_index_ms: value('speed-index'), performance_score: lhr.categories.performance?.score,
        inp: { status: 'not_measured', reason: 'Lighthouse 实验室加载审计不提供现场 INP；不以 TBT 冒充 INP' },
      },
      thresholds: { lcp_ms: '<2500', cls: '<0.1' },
      runtime_error: lhr.runtimeError || null, passed,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'PST-lighthouse-summary.json'), JSON.stringify(summary, null, 2));
    console.log(`Lighthouse: LCP=${lcp?.toFixed(0)}ms CLS=${cls?.toFixed(3)} TBT=${value('total-blocking-time')?.toFixed(0)}ms；${passed ? 'PASS' : 'FAIL'}`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
