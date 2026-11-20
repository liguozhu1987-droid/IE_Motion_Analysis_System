/**
 * 真值标注器烟测（0c 支撑工具）
 *
 * 被测对象：`app/web/tools/label-ai-segment.html`（单文件离线标注器）。
 * 只验证「工具本身不会产出坏真值」这一件事，不评价标注内容：
 *   1. 能在真实 Chrome 下从本地加载 sample60.mp4（file://，无服务端）
 *   2. 切分对齐帧、新段强制未标注、类型只能取 6 类
 *   3. 键盘路径（N 切分 / 数字赋类型）与 API 路径一致
 *   4. 未填标注人、存在未标注段时拒绝导出
 *   5. 导出 payload 符合 eval-ai-segment.cjs 的 ground-truth 契约
 *
 * 用法（无需起 API / 前端服务）：
 *   node app/web/test-labeler.cjs
 *
 * 前置：本机安装 Chrome（默认 C:/Program Files/Google/Chrome/Application/chrome.exe），
 *       视频 `deliverables/ai-segment/real/sample60.mp4` 存在（*.mp4 不入库，需本地保留）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core'));

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.join(__dirname, 'tools', 'label-ai-segment.html').replace(/\\/g, '/');
const VIDEO = path.join(ROOT, 'deliverables', 'ai-segment', 'real', 'sample60.mp4');
const SHOT = path.join(ROOT, 'deliverables', 'ai-segment', 'shots');
const TYPES = ['等待', '移物', '目检', '拿取', '装配', '其他'];

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error('CHROME_NOT_FOUND=' + CHROME);
    process.exit(2);
  }
  if (!fs.existsSync(VIDEO)) {
    console.error('VIDEO_NOT_FOUND=' + VIDEO);
    console.error('sample60.mp4 被 .gitignore 排除，请从留档处恢复后再跑本测试');
    process.exit(2);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 300)); });

  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__labeler && window.__labeler.state.durationMs > 0,
    { timeout: 30000 }
  ).catch(() => {});

  const meta = await page.evaluate(() => ({
    durationMs: window.__labeler.state.durationMs,
    videoName: window.__labeler.state.videoName,
    segs: window.__labeler.state.segments.length,
    readyState: document.getElementById('video').readyState
  }));
  console.log('META=' + JSON.stringify(meta));
  ok('本地视频元数据已加载（duration≈60067ms）', Math.abs(meta.durationMs - 60067) < 1500, meta.durationMs);
  ok('初始为 1 个未标注整段', meta.segs === 1, meta.segs);
  ok('video readyState >= 1', meta.readyState >= 1, meta.readyState);

  // 键盘路径：定位 5000ms → 按 N 切分
  await page.evaluate(() => window.__labeler.seekMs(5000));
  await page.keyboard.press('n');
  let st = await page.evaluate(() => ({
    segs: window.__labeler.state.segments,
    miss: window.__labeler.unlabeledCount()
  }));
  ok('按 N 在播放头切分 → 2 段', st.segs.length === 2, JSON.stringify(st.segs));
  ok('切点对齐帧（左段 end == 右段 start）', st.segs[0].end_ms === st.segs[1].start_ms, st.segs[0].end_ms);
  ok('切点数值接近 5000ms（±1 帧）', Math.abs(st.segs[1].start_ms - 5000) <= 34, st.segs[1].start_ms);
  ok('新段强制未标注（不得继承类型）', st.segs[1].type === null, st.segs[1].type);

  // 键盘路径：播放头在右段按 4 → 拿取；再跳 2000ms 按 3 → 目检
  await page.keyboard.press('4');
  await page.evaluate(() => window.__labeler.seekMs(2000));
  await page.keyboard.press('3');
  st = await page.evaluate(() => ({
    segs: window.__labeler.state.segments,
    miss: window.__labeler.unlabeledCount()
  }));
  ok('数字键赋值后无未标注段', st.miss === 0, st.miss);
  ok('键盘赋类型写入正确（拿取/目检）',
    st.segs[0].type === '目检' && st.segs[1].type === '拿取',
    st.segs.map((s) => s.type).join(','));

  // 未填标注人 → 拒绝导出
  let v = await page.evaluate(() => window.__labeler.validateForExport());
  ok('未填标注人时导出被拒绝', typeof v === 'string' && v.indexOf('标注人') >= 0, v);

  // 填标注人 → 校验通过
  await page.evaluate(() => {
    const el = document.getElementById('labeler');
    el.value = '测试标注员';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  v = await page.evaluate(() => window.__labeler.validateForExport());
  ok('填写标注人后校验通过', v === null, v);

  // 导出契约
  const payload = await page.evaluate(() => window.__labeler.buildPayload());
  console.log('PAYLOAD=' + JSON.stringify(payload));
  ok('payload 具备必需字段', ['station_id', 'video_name', 'labeler', 'labeled_at', 'segments']
    .every((k) => payload[k] !== undefined && payload[k] !== ''));
  ok('segments 数值型且起止有序', payload.segments.every((s) =>
    Number.isFinite(s.start_ms) && Number.isFinite(s.end_ms) && s.end_ms > s.start_ms));
  ok('类型均属于 6 类之一', payload.segments.every((s) => TYPES.includes(s.type)));
  ok('labeled_at 为 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(payload.labeled_at), payload.labeled_at);

  // 撤销 / 合并
  await page.evaluate(() => window.__labeler.undo());
  st = await page.evaluate(() => ({ n: window.__labeler.state.segments.length }));
  ok('Ctrl+Z 撤销后可回退', st.n === 2, st.n);
  await page.evaluate(() => window.__labeler.mergeWithNext(0));
  st = await page.evaluate(() => ({
    n: window.__labeler.state.segments.length,
    type: window.__labeler.state.segments[0].type
  }));
  ok('合并后回到 1 段', st.n === 1, st.n);
  ok('合并两段异类型后清空类型（强制重标）', st.type === null, st.type);

  // 占位提示不得遮挡视频
  const overlay = await page.evaluate(() => {
    const el = document.getElementById('videoEmpty');
    return { hidden: el.hidden, display: getComputedStyle(el).display };
  });
  ok('视频就绪后占位提示不遮挡画面', overlay.hidden === true && overlay.display === 'none', JSON.stringify(overlay));
  ok('时长时钟格式正确（01:00.067）',
    (await page.evaluate(() => document.getElementById('durClock').textContent)) === '01:00.067');

  fs.mkdirSync(SHOT, { recursive: true });
  await page.screenshot({ path: path.join(SHOT, 'labeler.png'), fullPage: false });
  console.log('SHOT=' + path.join(SHOT, 'labeler.png'));

  ok('无页面 JS 错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(`SUMMARY pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});