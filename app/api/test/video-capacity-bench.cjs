/**
 * P0-1 容量参数压测（独立脚本，不启动 Nest、不连任何数据库、不写仓库 storage）。
 *
 * 目的：为目标机（6C Xeon E7-4850 v4 / 2.1GHz / 32G，无核显）给出有实测依据的
 * VIDEO_DERIVE_CONCURRENCY / VIDEO_DERIVE_TIMEOUT_MIN / VIDEO_DERIVED_MAX_GB 建议值。
 *
 * 做法：
 *  - 用 ffmpeg 合成 1280x720@25fps 的"接近生产"源视频（testsrc2），再用 libx264 编码成 .mp4
 *    （目标机无 QSV，生产实际走 libx264，因此基准固定用 libx264，不享受本机 QSV 加速）；
 *  - 直接调用编译产物里的 buildProxy / buildSprite / buildIndex，与生产代码路径一致；
 *  - 每个场景用 os.cpus() 差分采样 CPU 利用率，输出峰值/均值与"等效占用核数"；
 *  - 并发场景：同一源视频同时跑 N 条 proxy，测墙钟耗时与 CPU 峰值。
 *
 * 运行：
 *   node test/video-capacity-bench.cjs --minutes=10
 *   node test/video-capacity-bench.cjs --minutes=10 --large=30
 * 前置：npm run build（dist 必须最新）；app/api/bin/ffmpeg.exe 可执行。
 */
const API_DIR = __dirname.replace(/[\\/]test$/, '');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FF = path.join(API_DIR, 'bin', 'ffmpeg.exe');
process.env.FFMPEG_BIN = FF;

const { buildProxy, buildSprite, buildIndex } = require(path.join(API_DIR, 'dist', 'src', 'modules', 'videos', 'derivative-build.js'));
const { probeVideoMeta } = require(path.join(API_DIR, 'dist', 'src', 'modules', 'videos', 'derivative-ffmpeg.js'));

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}
const MINUTES = argOf('minutes', 10);
const LARGE_MINUTES = argOf('large', 0);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vid-bench-'));
const LOGICAL = os.cpus().length;

function cpuSnapshot() {
  return os.cpus().map((c) => {
    const t = c.times;
    return t.user + t.nice + t.sys + t.idle + t.irq;
  });
}
function cpuIdleSnapshot() {
  return os.cpus().map((c) => c.times.idle);
}

/** 采样总 CPU 利用率：每 intervalMs 一次，返回峰值/均值（0..1） */
function startCpuSampler(intervalMs = 500) {
  let last = cpuSnapshot();
  let lastIdle = cpuIdleSnapshot();
  const samples = [];
  const timer = setInterval(() => {
    const cur = cpuSnapshot();
    const curIdle = cpuIdleSnapshot();
    let total = 0;
    let idle = 0;
    for (let i = 0; i < cur.length; i++) {
      total += cur[i] - last[i];
      idle += curIdle[i] - lastIdle[i];
    }
    if (total > 0) samples.push(Math.max(0, Math.min(1, 1 - idle / total)));
    last = cur;
    lastIdle = curIdle;
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      const peak = samples.length ? Math.max(...samples) : 0;
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      return { peak, avg, samples: samples.length };
    },
  };
}

const mb = (n) => Number((n / 1024 / 1024).toFixed(2));

function makeSource(outPath, minutes) {
  const t0 = Date.now();
  const r = spawnSync(FF, [
    '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${Math.round(minutes * 60)}:size=1280x720:rate=25`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', outPath,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`合成源视频失败: ${(r.stderr ?? '').slice(-400)}`);
  const sec = Date.now() - t0;
  return { path: outPath, size: fs.statSync(outPath).size, genSec: Number((sec / 1000).toFixed(1)) };
}

async function runScenario(label, jobs) {
  const sampler = startCpuSampler();
  const t0 = Date.now();
  const results = await Promise.all(jobs.map((j) => j()));
  const wallSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const cpu = sampler.stop();
  const out = {
    label,
    wallSec,
    cpuPeakPct: Number((cpu.peak * 100).toFixed(1)),
    cpuAvgPct: Number((cpu.avg * 100).toFixed(1)),
    cpuPeakCores: Number((cpu.peak * LOGICAL).toFixed(2)),
    cpuAvgCores: Number((cpu.avg * LOGICAL).toFixed(2)),
    jobs: results,
  };
  console.log(`BENCH ${JSON.stringify(out)}`);
  return out;
}

function rmDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

async function main() {
  console.log(`压测机: ${os.cpus()[0]?.model ?? 'unknown'} | 逻辑核 ${LOGICAL} | 内存 ${(os.totalmem() / 1024 ** 3).toFixed(1)}GB`);
  console.log(`ffmpeg: ${FF}`);
  console.log(`临时目录: ${tmpRoot}`);
  if (!fs.existsSync(FF)) throw new Error('缺少 app/api/bin/ffmpeg.exe');

  const source = makeSource(path.join(tmpRoot, `src-${MINUTES}m.mp4`), MINUTES);
  const meta = await probeVideoMeta(FF, source.path);
  console.log(`源视频: ${MINUTES}min, ${mb(source.size)}MB, ${meta.width}x${meta.height}@${meta.fps}fps, 合成耗时 ${source.genSec}s`);
  console.log(`SOURCE ${JSON.stringify({ minutes: MINUTES, sizeBytes: source.size, sizeMB: mb(source.size), genSec: source.genSec, meta: { w: meta.width, h: meta.height, fps: meta.fps, durationS: meta.durationS } })}`);

  const results = [];
  const dirs = [];

  // ── 单任务：proxy / sprite / index 顺序执行（各独立采样） ──
  const d1 = path.join(tmpRoot, 'single');
  fs.mkdirSync(d1, { recursive: true }); dirs.push(d1);
  let proxyPath = '';
  const singleProxy = await runScenario('single-proxy', [async () => {
    const r = await buildProxy(FF, source.path, d1, 'libx264', meta);
    proxyPath = r.path;
    return { kind: 'proxy', sizeMB: mb(r.size), width: r.width, height: r.height, frames: r.frames };
  }]);
  results.push(singleProxy);

  const singleSprite = await runScenario('single-sprite', [async () => {
    const r = await buildSprite(FF, source.path, d1, meta);
    return { kind: 'sprite', sizeMB: mb(r.size), frames: r.frames, height: r.height };
  }]);
  results.push(singleSprite);

  const singleIndex = await runScenario('single-index', [async () => {
    const r = await buildIndex(FF, proxyPath || source.path, d1, meta, source.path);
    return { kind: 'index', sizeMB: mb(r.size), frames: r.frames };
  }]);
  results.push(singleIndex);

  // ── 并发 proxy：1 / 2 / 3（同一源，多个输出目录） ──
  for (const n of [1, 2, 3]) {
    const dn = path.join(tmpRoot, `conc${n}`);
    fs.mkdirSync(dn, { recursive: true }); dirs.push(dn);
    const out = await runScenario(`conc${n}-proxy`, Array.from({ length: n }, (_, i) => async () => {
      const sub = path.join(dn, `job${i}`);
      fs.mkdirSync(sub, { recursive: true });
      const r = await buildProxy(FF, source.path, sub, 'libx264', meta);
      return { i, sizeMB: mb(r.size), frames: r.frames };
    }));
    results.push(out);
    rmDir(dn); // 释放磁盘（体积已记录）
    dirs.splice(dirs.indexOf(dn), 1);
  }

  // ── 30 分钟单任务（可选）──
  if (LARGE_MINUTES > 0) {
    const large = makeSource(path.join(tmpRoot, `src-${LARGE_MINUTES}m.mp4`), LARGE_MINUTES);
    const lmeta = await probeVideoMeta(FF, large.path);
    console.log(`大视频: ${LARGE_MINUTES}min, ${mb(large.size)}MB, 合成耗时 ${large.genSec}s`);
    console.log(`SOURCE_LARGE ${JSON.stringify({ minutes: LARGE_MINUTES, sizeBytes: large.size, sizeMB: mb(large.size), genSec: large.genSec })}`);
    const dl = path.join(tmpRoot, 'large');
    fs.mkdirSync(dl, { recursive: true });
    const out = await runScenario(`single-proxy-${LARGE_MINUTES}min`, [async () => {
      const r = await buildProxy(FF, large.path, dl, 'libx264', lmeta);
      return { kind: 'proxy', sizeMB: mb(r.size), width: r.width, height: r.height, frames: r.frames };
    }]);
    results.push(out);
    rmDir(dl);
  }

  const single = results.find((r) => r.label === 'single-proxy');
  const minutes = MINUTES;
  const perMinProxyMB = single ? Number((single.jobs[0].sizeMB / minutes).toFixed(2)) : null;
  const perMinSpriteMB = Number((results.find((r) => r.label === 'single-sprite').jobs[0].sizeMB / minutes).toFixed(3));
  const perMinIndexMB = Number((results.find((r) => r.label === 'single-index').jobs[0].sizeMB / minutes).toFixed(3));
  console.log(`SUMMARY ${JSON.stringify({
    logicalCores: LOGICAL,
    perMinute: { proxyMB: perMinProxyMB, spriteMB: perMinSpriteMB, indexMB: perMinIndexMB },
    singleProxySec: single?.wallSec ?? null,
    cpuPeak: {
      p1: results.find((r) => r.label === 'conc1-proxy')?.cpuPeakPct,
      p2: results.find((r) => r.label === 'conc2-proxy')?.cpuPeakPct,
      p3: results.find((r) => r.label === 'conc3-proxy')?.cpuPeakPct,
    },
  })}`);

  rmDir(tmpRoot);
}

main().catch((e) => {
  console.error('压测异常:', e);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exitCode = 1;
});
