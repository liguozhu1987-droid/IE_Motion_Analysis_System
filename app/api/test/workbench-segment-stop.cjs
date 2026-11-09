/**
 * 分解工作台片段停止回归：固定 MP4 + 真实 Chrome，记录 currentTime 写入与实际呈现帧。
 * 只操作隔离 3102 的 PF-ST001；视频走本地 Blob，不提交任何业务修改。
 */
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require(path.resolve(__dirname, '../../node_modules/puppeteer-core'));

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const BASE = process.env.BASE || 'http://127.0.0.1:3102/api';
const WEB = process.env.WEB_URL || 'http://127.0.0.1:3102';
const OUT = process.env.ISOLATED_ARTIFACT_DIR
  ? path.join(process.env.ISOLATED_ARTIFACT_DIR, 'WB-segment-stop-report.json')
  : path.resolve(__dirname, '../../../deliverables/WB-segment-stop-report.json');
const VIDEO = path.resolve(__dirname, '../../web/test-fixtures/aiseg-8s.mp4');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const START_MS = 1800; // PF-ST001 seq2：start=1.8s，dur_s=2.05s
const END_MS = 3850;
const PREROLL_MS = START_MS - 400;

function guard() {
  const base = new URL(BASE);
  const web = new URL(WEB);
  // 隔离来源：performance-isolated.cjs（PERF_ISOLATED=1 + 3102）或 isolated-harness.cjs（随机端口）。
  const isolated = process.env.PERF_ISOLATED === '1' || process.env.ISOLATED_HARNESS === '1';
  if (!isolated || base.hostname !== '127.0.0.1' || web.hostname !== '127.0.0.1' || base.port !== web.port) {
    throw new Error('片段停止回归只允许隔离服务（PERF_ISOLATED=1 或 ISOLATED_HARNESS=1，API 与 Web 同端口）');
  }
}

(async () => {
  guard();
  const loginResponse = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await loginResponse.json();
  if (!login.refreshToken) throw new Error(`隔离登录失败: HTTP ${loginResponse.status}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    userDataDir: process.env.PERF_DB_PATH
      ? path.join(path.dirname(process.env.PERF_DB_PATH), 'chrome-segment-stop')
      : path.join(require('node:os').tmpdir(), 'chrome-segment-stop'),
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    args: ['--no-first-run', '--window-size=1480,940'],
  });
  const pageErrors = [];
  let report;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
    await page.evaluateOnNewDocument((refreshToken) => {
      if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', refreshToken);
      localStorage.setItem('wb-help-seen', '1');
    }, login.refreshToken);
    await page.goto(`${WEB}/?segment-stop=${Date.now()}#/workbench/PF-ST001`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.tl-lane .block', { timeout: 60000 });
    const input = await page.$('.wb-top-acts input[type="file"]');
    if (!input) throw new Error('未找到视频文件输入框');
    await input.uploadFile(VIDEO);
    await page.waitForFunction(() => {
      const v = document.querySelector('.wb-screen video');
      return v && v.readyState >= 2 && v.duration >= 2;
    }, { timeout: 30000 });

    const secondHandle = await page.evaluateHandle(() => [...document.querySelectorAll('.tl-lane .block')]
      .find((b) => b.querySelector('.blk-seq')?.textContent?.trim() === '#2'));
    const second = secondHandle.asElement();
    if (!second) throw new Error('未找到 seq2 要素块');
    await second.click();
    await page.waitForFunction(() => document.querySelector('.tl-lane .block.selected .blk-seq')?.textContent?.trim() === '#2');
    await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      const probe = window.__segmentStopProbe = { seeks: [], frames: [], pauses: [], active: true };
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(v, 'currentTime', {
        configurable: true,
        get() { return descriptor.get.call(this); },
        set(value) {
          probe.seeks.push({ from_ms: this.currentTime * 1000, to_ms: value * 1000, paused: this.paused, at: performance.now() });
          descriptor.set.call(this, value);
        },
      });
      v.addEventListener('pause', () => probe.pauses.push({ current_time_ms: v.currentTime * 1000, at: performance.now() }));
      const onFrame = (_now, metadata) => {
        probe.frames.push({ media_time_ms: metadata.mediaTime * 1000, current_time_ms: v.currentTime * 1000, at: performance.now() });
        if (probe.active) v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    });

    await page.click('.wb-play');
    await page.waitForFunction(() => {
      const v = document.querySelector('.wb-screen video');
      return v && v.paused && v.currentTime >= 3.5;
    }, { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      const p = window.__segmentStopProbe;
      p.active = false;
      return {
        seeks: p.seeks, frames: p.frames, pauses: p.pauses,
        final_time_ms: v.currentTime * 1000, paused: v.paused,
        playhead_ms: (() => {
          const text = document.querySelector('.wb-tp-time b')?.textContent || '00:00.000';
          const [minutes, seconds] = text.split(':');
          return (Number(minutes) * 60 + Number(seconds)) * 1000;
        })(),
      };
    });
    const backwardSeeks = result.seeks.filter((s) => s.to_ms < s.from_ms - 1);
    const backwardFrames = result.frames.slice(1).filter((f, i) => f.media_time_ms < result.frames[i].media_time_ms - 1);
    const finalTimeMs = result.final_time_ms;
    // 度量基准（v3.61 修复）：产品在 requestVideoFrameCallback 里用 metadata.mediaTime 判定停点，
    // 停在「第一条 mediaTime >= 止点」的呈现帧；而 video.currentTime 是时钟位置，
    // 播放中可领先已呈现帧至多 1 帧（30fps ≈ 33.3ms），用它去比 40ms 容差天然会偶发超限。
    // 故该断言以最后一条呈现帧的 mediaTime 为准；final_time_ms 仅作观测值留在报告里。
    const lastPresented = result.frames[result.frames.length - 1];
    const lastPresentedMs = lastPresented ? lastPresented.media_time_ms : NaN;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const settledTimeMs = await page.evaluate(() => document.querySelector('.wb-screen video').currentTime * 1000);

    // K 在片段单次停点恢复连续正放：松键后仍播放，不回卷，也不再被原止点拦截。
    await page.evaluate(() => {
      window.__segmentStopProbe.seeks = [];
      document.activeElement?.blur();
    });
    await page.keyboard.press('KeyK');
    await new Promise((resolve) => setTimeout(resolve, 650));
    const kResume = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      return {
        paused: v.paused, current_time_ms: v.currentTime * 1000,
        seeks: window.__segmentStopProbe.seeks,
      };
    });
    await page.keyboard.press('KeyK');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pausedAfterK = await page.evaluate(() => document.querySelector('.wb-screen video').paused);
    const kBackwardSeeks = kResume.seeks.filter((s) => s.to_ms < s.from_ms - 1);

    // 暂停态定位仍须由 video 真实时长钳位；忽略迟到 timeupdate 不能让播放头越过片尾。
    await page.keyboard.press('End');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.wb-tp-btn')].find((b) => b.textContent === '+1s');
      button?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pausedSeek = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      const text = document.querySelector('.wb-tp-time b')?.textContent || '00:00.000';
      const [minutes, seconds] = text.split(':');
      return { duration_ms: v.duration * 1000, current_time_ms: v.currentTime * 1000,
        playhead_ms: (Number(minutes) * 60 + Number(seconds)) * 1000 };
    });

    // J 功能保持：按住倒放、松开停止，不承担 K 的恢复正放职责。
    await page.keyboard.down('KeyJ');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const jReverse = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      return { paused: v.paused, current_time_ms: v.currentTime * 1000 };
    });
    await page.keyboard.up('KeyJ');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const jStoppedMs = await page.evaluate(() => document.querySelector('.wb-screen video').currentTime * 1000);

    // 空格从单次停点重播：必须重新从片段起点播放，且同样没有停止回帧。
    const resetProbe = () => page.evaluate(() => {
      const p = window.__segmentStopProbe;
      p.seeks = []; p.frames = []; p.pauses = []; p.active = true;
      const v = document.querySelector('.wb-screen video');
      const onFrame = (_now, metadata) => {
        p.frames.push({ media_time_ms: metadata.mediaTime * 1000, current_time_ms: v.currentTime * 1000, at: performance.now() });
        if (p.active) v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      document.activeElement?.blur();
    });
    await resetProbe();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => {
      const v = document.querySelector('.wb-screen video');
      return v && v.paused && v.currentTime >= 3.5;
    }, { timeout: 10000 });
    const replay = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      const p = window.__segmentStopProbe;
      p.active = false;
      return { paused: v.paused, seeks: p.seeks, frames: p.frames };
    });
    // 重播会先有意从片尾 seek 到预卷起点；只把其余后退写入视为停止回帧。
    const replayBackwardSeeks = replay.seeks.filter((s) => s.to_ms < s.from_ms - 1 && Math.abs(s.to_ms - PREROLL_MS) > 1);
    const replayBackwardFrames = replay.frames.slice(1).filter((f, i) => f.media_time_ms < replay.frames[i].media_time_ms - 1);

    // 循环模式允许且应当回到预卷起点；持续播放和循环回卷不能被单次停止修复破坏。
    await page.click('.wb-loop-btn');
    await resetProbe();
    await page.click('.wb-play');
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const loop = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      const p = window.__segmentStopProbe;
      return { paused: v.paused, seeks: p.seeks, chip: document.querySelector('.wb-seg-chip')?.textContent || '' };
    });
    const loopRewinds = loop.seeks.filter((s) => s.to_ms < s.from_ms - 1);
    await page.click('.wb-play');
    await page.click('.wb-loop-btn');

    // 确定性复现：呈现回调已报止点，但 currentTime 仍停在片段内。下一次空格必须直接重播，
    // 不能因为 currentTime < end 而先残余播放一两帧、再次停住。
    await page.keyboard.press('Home');
    await page.evaluate((endMs) => {
      const v = document.querySelector('.wb-screen video');
      const original = v.requestVideoFrameCallback.bind(v);
      window.__forceFinishedFrame = false;
      v.requestVideoFrameCallback = (callback) => original((now, metadata) => {
        const presentedAhead = window.__forceFinishedFrame && v.currentTime * 1000 >= endMs - 67;
        callback(now, presentedAhead ? { ...metadata, mediaTime: endMs / 1000 } : metadata);
      });
      const p = window.__segmentStopProbe;
      p.seeks = []; p.pauses = [];
      window.__forceFinishedFrame = true;
      document.activeElement?.blur();
    }, END_MS);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => {
      const v = document.querySelector('.wb-screen video');
      return v.paused && window.__segmentStopProbe.pauses.length > 0;
    }, { timeout: 10000 });
    const laggingStop = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      window.__forceFinishedFrame = false;
      window.__segmentStopProbe.seeks = [];
      return { current_time_ms: v.currentTime * 1000, paused: v.paused };
    });
    await page.keyboard.press('Space');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const finishedReplay = await page.evaluate(() => {
      const v = document.querySelector('.wb-screen video');
      return { current_time_ms: v.currentTime * 1000, paused: v.paused, seeks: window.__segmentStopProbe.seeks };
    });
    await page.keyboard.press('KeyK');
    const replayedToPreroll = finishedReplay.seeks.some((s) => Math.abs(s.to_ms - PREROLL_MS) <= 1);

    const checks = {
      auto_paused: result.paused,
      no_backward_seek: backwardSeeks.length === 0,
      no_backward_presented_frame: backwardFrames.length === 0,
      presented_frame_probe_active: result.frames.length >= 10,
      stops_within_one_frame_of_end: Number.isFinite(lastPresentedMs) && Math.abs(lastPresentedMs - END_MS) <= 40,
      playhead_at_end: result.playhead_ms === END_MS,
      final_frame_stable: Math.abs(settledTimeMs - finalTimeMs) < 1,
      k_resumes_after_segment_stop: !kResume.paused && kResume.current_time_ms > finalTimeMs + 350,
      k_continues_after_keyup: !kResume.paused,
      k_resume_has_no_rewind: kBackwardSeeks.length === 0,
      k_pauses_after_k_resume: pausedAfterK,
      paused_seek_clamped: Math.abs(pausedSeek.playhead_ms - pausedSeek.duration_ms) <= 1 &&
        Math.abs(pausedSeek.current_time_ms - pausedSeek.duration_ms) <= 1,
      j_reverse_restored: jReverse.paused && jReverse.current_time_ms < pausedSeek.current_time_ms - 50,
      j_reverse_stops_on_keyup: Math.abs(jStoppedMs - jReverse.current_time_ms) < 50,
      space_replay_auto_paused: replay.paused,
      space_replay_no_backward_seek: replayBackwardSeeks.length === 0,
      space_replay_no_backward_presented_frame: replayBackwardFrames.length === 0,
      space_replay_frame_probe_active: replay.frames.length >= 10,
      loop_keeps_playing: !loop.paused && /循环/.test(loop.chip),
      loop_rewinds_intentionally: loopRewinds.length >= 2,
      presented_time_lag_fixture_valid: laggingStop.paused && laggingStop.current_time_ms >= END_MS - 100 && laggingStop.current_time_ms < END_MS,
      space_after_finished_replays_immediately: replayedToPreroll && !finishedReplay.paused,
      no_page_errors: pageErrors.length === 0,
    };
    report = {
      generated_at: new Date().toISOString(), station: 'PF-ST001', seq: 2, start_ms: START_MS, end_ms: END_MS, preroll_ms: PREROLL_MS,
      mode: 'headed system Chrome / fixed MP4 / currentTime setter + requestVideoFrameCallback probe',
      checks, backward_seeks: backwardSeeks, backward_frames: backwardFrames,
      final_time_ms: finalTimeMs, settled_time_ms: settledTimeMs, playhead_ms: result.playhead_ms,
      last_presented_media_ms: lastPresentedMs, final_minus_presented_ms: finalTimeMs - lastPresentedMs,
      paused_seek: pausedSeek,
      k_resume: { ...kResume, backward_seeks: kBackwardSeeks, paused_after_k: pausedAfterK },
      j_reverse: { ...jReverse, stopped_time_ms: jStoppedMs },
      space_replay: { backward_seeks: replayBackwardSeeks, backward_frames: replayBackwardFrames },
      loop: { intentional_rewinds: loopRewinds.length, paused: loop.paused, chip: loop.chip },
      presented_time_lag_replay: { lagging_stop: laggingStop, replay: finishedReplay, replayed_to_preroll: replayedToPreroll },
      seeks: result.seeks, presented_frames: result.frames, pause_events: result.pauses, page_errors: pageErrors,
      passed: Object.values(checks).every(Boolean),
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`片段停止: 后退seek=${backwardSeeks.length} 后退呈现帧=${backwardFrames.length} 停帧media=${lastPresentedMs.toFixed(1)}ms 时钟=${finalTimeMs.toFixed(1)}ms 播放头=${result.playhead_ms}ms；${report.passed ? 'PASS' : 'FAIL'}`);
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
