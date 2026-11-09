/**
 * v3.34 AI 自动分解 · 真实分析链路验证
 *
 * 只验证「链路是否真实跑通」这一件事，不承诺精度：
 *   1. 注入一段视频（MediaRecorder 现录，不出本机）→ 开始分析按钮可用
 *   2. MediaPipe 模型真实加载（public/models 离线资产）
 *   3. 分析能跑完并给出确定结论（候选 或 明确的"未检出"），绝不静默
 *   4. 全程零视频内容出站（视频不上传，这是用户硬约束）
 *
 * 合成视频里没有真手 → 期望 0 候选，故不校验候选数量与精度。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'L01-ST01';
const SHOT = path.join(__dirname, '..', '..', 'deliverables', 'ai-segment', 'shots');
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0;
let fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));

  /* 出站流量审计：视频不上传是硬约束，任何 >=1MB 的 POST/PUT 都算违规 */
  const bigUploads = [];
  page.on('request', (req) => {
    const m = req.method();
    if (m !== 'POST' && m !== 'PUT') return;
    const len = Number(req.headers()['content-length'] || 0);
    const size = len || (req.postData() ? Buffer.byteLength(req.postData()) : 0);
    if (size >= 1024 * 1024) bigUploads.push(m + ' ' + req.url() + ' ' + size);
  });

  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  await page.goto(WEB + '/#/ai-segment/' + SID, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1500);

  console.log('\n--- R1. 视频注入 ---');
  /* 用真实 MP4（test-fixtures/aiseg-8s.mp4，8s/720p）：MediaRecorder 的 WebM 无时长元数据，
     不适合验主路径；真实工位录像绝大多数是 MP4，这才是主场景。
     走 puppeteer 原生 uploadFile，测试固件无需进 public（不进构建产物）。 */
  const fixture = path.join(__dirname, 'test-fixtures', 'aiseg-8s.mp4');
  if (!fs.existsSync(fixture)) {
    console.log('  SKIP 缺少测试固件 test-fixtures/aiseg-8s.mp4，跳过真实分析链路验证');
    await browser.close();
    process.exit(0);
  }
  const fileInput = await page.$('.aip-acts input[type=file]');
  await fileInput.uploadFile(fixture);
  await sleep(1200);
  /* 注意：页面 onChange 里按惯例清空 input.value（同工作台 pickVideo），
     所以不能用 input.files.length 判断；改用界面状态：按钮文案转成「更换视频」即已载入。 */
  const injected = await page.$eval('.aip-acts label', (el) => (el.textContent || '').trim()).catch(() => '');
  ok('R1 测试视频注入成功（按钮转为「更换视频」）', injected.indexOf('更换视频') >= 0, injected);
  await sleep(2500);

  const canRun = await page.$eval('.aip-acts button.primary', (b) => !b.disabled).catch(() => false);
  ok('R2 载入视频后「开始分析」可用', canRun);

  console.log('\n--- R2. 真实分析（模型加载 + 抽帧 + 分割） ---');
  await page.click('.aip-acts button.primary');
  await sleep(2500);

  const overlayShown = (await page.$$eval('.ais-overlay', (e) => e.length)) > 0;
  ok('R3 分析中显示进度层（不静默）', overlayShown);

  // 等待分析结束：覆盖层消失且候选区给出结论（最长 200s，headless 软渲染约慢 10 倍）
  let finished = false;
  for (let i = 0; i < 100; i += 1) {
    await sleep(2000);
    const running = (await page.$$eval('.ais-overlay', (e) => e.length)) > 0;
    const stuck = (await page.$('.aip-error')) !== null;
    if (!running || stuck) { finished = true; break; }
  }
  ok('R4 分析在合理时间内结束（未挂死）', finished);

  const errText = await page.$eval('.aip-error', (e) => (e.textContent || '').trim()).catch(() => '');
  ok('R5 未出现分析失败', errText === '', errText);

  const sideText = await page.$eval('.aip-side', (e) => (e.textContent || '').trim()).catch(() => '');
  const concluded = sideText.indexOf('尚未分析') < 0;
  ok('R6 候选区给出确定结论（候选列表 或 明确「未检出」）', concluded, sideText.slice(0, 120));
  const notDetected = sideText.indexOf('未检出') >= 0;
  const hasCands = (await page.$$eval('.ais-table tbody tr', (e) => e.length)) > 0;
  ok('R7 结论形态合法（合成视频无真手 → 期望未检出）', notDetected || hasCands,
    `notDetected=${notDetected} rows=${await page.$$eval('.ais-table tbody tr', (e) => e.length)}`);

  await page.screenshot({ path: path.join(SHOT, 'v334-analyzed.png'), fullPage: true });

  console.log('\n--- R3. 隐私与稳定性 ---');
  ok('R8 零 >=1MB 视频内容出站（视频不上传）', bigUploads.length === 0, bigUploads.join(' | '));
  const fatal = errors.filter((e) => !/favicon|ResizeObserver|DevTools|401/i.test(e));
  ok('R9 无未捕获 JS 异常（React 树未被掀翻）', fatal.length === 0, fatal.slice(0, 3).join(' || '));

  await browser.close();
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
