/**
 * W3：真实桌面 Chrome + 固定 8 秒 MP4 + 20 要素，脚本化拖拽右边界 5 秒。
 * 采集 rAF 帧间隔、Long Tasks、CDP 原始 trace；不调用提交接口，视频只作为浏览器本地 Blob。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const puppeteer = require(path.resolve(__dirname, '../../node_modules/puppeteer-core'));

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const BASE = process.env.BASE || 'http://127.0.0.1:3102/api';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3102';
const OUT_DIR = path.resolve(__dirname, '../../../deliverables');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIDEO = path.resolve(__dirname, '../../web/test-fixtures/aiseg-8s.mp4');
const TRACE = path.join(OUT_DIR, 'PST-workbench-drag-trace.json');
const DRAG_MS = 5000;

function guard() {
  const u = new URL(BASE);
  const w = new URL(WEB);
  if (process.env.PERF_ISOLATED !== '1' || u.hostname !== '127.0.0.1' || u.port !== '3102' || w.hostname !== '127.0.0.1' || w.port !== '3102') {
    throw new Error('时间线性能回归只允许隔离 3102 服务');
  }
  if (!fs.existsSync(VIDEO)) throw new Error(`固定视频不存在: ${VIDEO}`);
}
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;

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
    userDataDir: path.join(path.dirname(process.env.PERF_DB_PATH), 'chrome-timeline'),
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
    args: ['--no-first-run', '--window-size=1640,1040'],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
    await page.evaluateOnNewDocument((refreshToken) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', refreshToken);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);
    await page.goto(`${WEB}/?perf=timeline#/workbench/PF-ST001`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.tl-lane .block .grip.r', { timeout: 60000 });
    const fileInput = await page.$('.wb-top-acts input[type="file"]');
    if (!fileInput) throw new Error('未找到工作台视频文件输入框');
    await fileInput.uploadFile(VIDEO);
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0;
    }, { timeout: 30000 });
    const video = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { duration_s: v.duration, width: v.videoWidth, height: v.videoHeight, ready_state: v.readyState, error: v.error?.message || null };
    });
    const grip = await page.$('.tl-lane .block .grip.r');
    const rect = await grip.boundingBox();
    if (!rect) throw new Error('右拖拽手柄不可见');
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const before = await page.$eval('.tl-lane .block', (el) => ({ width: el.style.width, left: el.style.left }));

    await page.evaluate(() => {
      const state = window.__dragPerf = { frames: [], longtasks: [], done: false };
      const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) state.longtasks.push({ start: e.startTime, duration: e.duration });
      });
      observer.observe({ type: 'longtask', buffered: false });
      state.observer = observer;
      const tick = (t) => {
        state.frames.push(t);
        if (!state.done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.bringToFront();
    await page.tracing.start({
      path: TRACE, screenshots: false,
      categories: ['devtools.timeline', 'blink.user_timing', 'latencyInfo', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame'],
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    const started = Date.now();
    let step = 0;
    while (Date.now() - started < DRAG_MS) {
      // 在 0~36px 间反复拖动，覆盖真实 pointermove → setDraft → React 渲染链路。
      const offset = step % 60 <= 30 ? (step % 60) * 1.2 : (60 - (step % 60)) * 1.2;
      await page.mouse.move(x + offset, y);
      step++;
    }
    await page.mouse.move(x + 30, y);
    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await page.evaluate(() => {
      window.__dragPerf.done = true;
      window.__dragPerf.observer.disconnect();
    });
    await page.tracing.stop();

    const sampled = await page.evaluate(() => ({
      frames: window.__dragPerf.frames, longtasks: window.__dragPerf.longtasks,
      visibility: document.visibilityState, focused: document.hasFocus(),
    }));
    const after = await page.$eval('.tl-lane .block', (el) => ({ width: el.style.width, left: el.style.left }));
    const intervals = sampled.frames.slice(1).map((t, i) => t - sampled.frames[i]);
    const durationMs = sampled.frames.length > 1 ? sampled.frames[sampled.frames.length - 1] - sampled.frames[0] : 0;
    const rafFps = durationMs > 0 ? (sampled.frames.length - 1) * 1000 / durationMs : 0;
    const trace = JSON.parse(fs.readFileSync(TRACE, 'utf8'));
    const events = Array.isArray(trace) ? trace : trace.traceEvents || [];
    const runTasks = events.filter((e) => e.name === 'RunTask' && Number.isFinite(e.dur)).map((e) => e.dur / 1000);
    const drawFrames = events.filter((e) => e.name === 'DrawFrame' && Number.isFinite(e.ts));
    const droppedFrames = events.filter((e) => e.name === 'DroppedFrame').length;
    const drawDuration = drawFrames.length > 1 ? (drawFrames[drawFrames.length - 1].ts - drawFrames[0].ts) / 1000 : 0;
    const drawFps = drawDuration > 0 ? (drawFrames.length - 1) * 1000 / drawDuration : 0;
    const observerMax = Math.max(0, ...sampled.longtasks.map((t) => t.duration));
    const traceMax = Math.max(0, ...runTasks);
    const moved = before.width !== after.width;
    const visible = sampled.visibility === 'visible' && sampled.focused;
    // rAF 只表示回调机会；门禁同时要求 trace 中实际 DrawFrame ≥50fps，防止空转 60fps 虚报。
    const passed = moved && visible && rafFps >= 50 && drawFps >= 50 && observerMax < 100 && traceMax < 100 && pageErrors.length === 0;
    const report = {
      generated_at: new Date().toISOString(), mode: 'headed system Chrome / real CDP mouse events / local Blob video',
      headless: false, viewport: { width: 1600, height: 1000, device_scale_factor: 1 },
      station: 'PF-ST001', elements: 20, requested_drag_ms: DRAG_MS, actual_mouse_moves: step,
      video: { fixture: path.basename(VIDEO), sha256: crypto.createHash('sha256').update(fs.readFileSync(VIDEO)).digest('hex'), ...video },
      drag_changed_width: moved, before, after, visibility: sampled.visibility, focused: sampled.focused,
      raf: {
        frames: sampled.frames.length, duration_ms: durationMs, fps: rafFps,
        interval_p50_ms: percentile(intervals, 0.5), interval_p95_ms: percentile(intervals, 0.95),
        interval_max_ms: Math.max(0, ...intervals), intervals_over_20ms: intervals.filter((n) => n > 20).length,
      },
      longtasks: {
        observer_count: sampled.longtasks.length, observer_max_ms: observerMax,
        observer_over_100ms: sampled.longtasks.filter((t) => t.duration >= 100).length,
        trace_run_task_count: runTasks.length, trace_run_task_max_ms: traceMax,
        trace_run_task_over_100ms: runTasks.filter((n) => n >= 100).length,
      },
      trace_draw_frames: { count: drawFrames.length, dropped_count: droppedFrames, fps: drawFps },
      thresholds: { raf_fps: '>=50', trace_draw_frame_fps: '>=50', single_long_task_ms: '<100' }, page_errors: pageErrors,
      raw_trace: path.basename(TRACE), passed,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'PST-workbench-drag-summary.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: path.join(OUT_DIR, 'PST-workbench-drag.png'), fullPage: true });
    console.log(`真实桌面拖拽: DrawFrame=${drawFps.toFixed(1)}fps rAF=${rafFps.toFixed(1)}fps p95=${report.raf.interval_p95_ms?.toFixed(1)}ms maxLongTask=${Math.max(observerMax, traceMax).toFixed(1)}ms；${passed ? 'PASS' : 'FAIL'}`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
