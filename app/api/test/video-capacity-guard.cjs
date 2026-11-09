/**
 * P0-1 视频管线闭环 + 容量护栏 验证脚本（独立、可重复、不碰 CN_AME）。
 *
 * 覆盖（逐条对应验收口径）：
 *  ① 端到端：分片上传 → 自动派生 proxy/sprite/index → proxy Range 206 / sprite 200 / index keyframes 非空
 *  ② 重试收敛：人为破坏源文件 → error retry=1 → 恢复源文件 → 自动重入 retry=2 → ready（无永久卡死）
 *     另验证僵尸 running 回收与 ffmpeg 超时参数已生效（通过 /storage 回显 configured）
 *  ③ 磁盘护栏：把 VIDEO_DERIVED_MAX_GB 设到实测占用的一半左右 → 触发告警 → LRU 只删 proxy →
 *     evicted 状态正确、sprite/index 仍在、**源视频文件与大小不变**、derived_bytes 回落阈值内
 *  ④ 分片 TTL：把分片目录 mtime 改到 25h 前 → 被清理；新分片目录保留
 *  ⑤ 孤儿巡检（VIDEO_ORPHAN_SWEEP=1）：删除源视频 → 派生行与输出目录被清
 *
 * 运行：node test/video-capacity-guard.cjs
 * 前置：npm run build；本机可执行 app/api/bin/ffmpeg.exe
 * 隔离：临时目录作为 cwd（storage/logs/data 全在临时目录），DB_TYPE=sqlite；收尾整目录删除。
 */
const API_DIR = __dirname.replace(/[\\/]test$/, '');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { randomUUID } = require('node:crypto');

const PASS = '\x1b[32m\u2713\x1b[0m';
const FAIL = '\x1b[31m\u2717\x1b[0m';
let ok = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { ok++; console.log(`  ${PASS} ${name}`); }
  else {
    fail++;
    const d = detail === undefined ? '' : ` \u2192 ${JSON.stringify(detail).slice(0, 300)}`;
    failures.push(name + d);
    console.log(`  ${FAIL} ${name}${d}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, p, opts = {}) {
  const headers = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.range) headers.range = opts.range;
  let body;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(`${base}${p}`, { method, headers, body });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, data, ct, headers: res.headers };
}

/* ───────────── 环境（必须在 require dist 之前定型） ───────────── */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vid-cap-'));
const dbPath = path.join(tmpRoot, 'data', 'ie.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

process.chdir(tmpRoot);
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = dbPath;
process.env.NODE_ENV = 'development';
process.env.RULES_DIR = path.join(API_DIR, '..', 'config', 'rules');
process.env.LOG_DIR = path.join(tmpRoot, 'logs');
process.env.SEED = 'true';
process.env.VIDEO_MAX_MB = '2048';
process.env.VIDEO_AUTO_DERIVE = '1';
process.env.VIDEO_DERIVED_DU_SEC = '10';
process.env.VIDEO_DERIVE_CONCURRENCY = '3';
process.env.VIDEO_DERIVE_TIMEOUT_MIN = '5';
process.env.VIDEO_RUNNING_STALE_MIN = '1';
process.env.VIDEO_DERIVED_MAX_GB = ''; // 第一阶段：护栏关闭
process.env.VIDEO_ORPHAN_SWEEP = '0';
// resolveFfmpeg 先查 FFMPEG_BIN，再查 <cwd>/bin（本测试 cwd 是临时目录，须显式指定仓库内二进制）
process.env.FFMPEG_BIN = path.join(API_DIR, 'bin', 'ffmpeg.exe');
// 确保不会误连生产库
for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'DB_ENCRYPT']) delete process.env[k];

require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require(path.join(API_DIR, 'dist', 'src', 'app.module.js'));
const { AllExceptionsFilter } = require(path.join(API_DIR, 'dist', 'src', 'core', 'all-exceptions.filter.js'));
const { DatabaseSync } = require('node:sqlite');

const videoDir = path.join(tmpRoot, 'storage', 'videos');
const derivedRoot = path.join(videoDir, 'derived');
const chunkRoot = path.join(videoDir, 'tmp', 'chunks');

function ffmpegBin() {
  const local = path.join(API_DIR, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg';
}

function makeVideo(outPath, seconds = 6) {
  const r = spawnSync(ffmpegBin(), [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=10`,
    '-pix_fmt', 'yuv420p', outPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`合成测试视频失败: ${(r.stderr ?? '').slice(-400)}`);
  return outPath;
}

function dbAll(sql, params = []) {
  const raw = new DatabaseSync(dbPath);
  try { return raw.prepare(sql).all(...params); } finally { raw.close(); }
}

function dbRun(sql, params = []) {
  const raw = new DatabaseSync(dbPath);
  try { raw.prepare(sql).run(...params); } finally { raw.close(); }
}

async function startApp(envPatch) {
  if (envPatch) Object.assign(process.env, envPatch);
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const login = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  if (!login.data?.accessToken) throw new Error(`登录失败: ${login.status} ${JSON.stringify(login.data)}`);
  return { app, base, token: login.data.accessToken };
}

async function uploadChunked(base, token, fileBuffer, filename) {
  const uploadId = randomUUID();
  const parts = [fileBuffer.subarray(0, 1000), fileBuffer.subarray(1000, 2000), fileBuffer.subarray(2000)];
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const form = new FormData();
    form.append('file', new Blob([parts[i]]), 'part.mp4');
    if (i === 0) { form.append('originalname', filename); form.append('raw', ''); }
    last = await api(base, 'POST', `/api/videos/upload?uploadId=${uploadId}&chunkIndex=${i}&chunkTotal=${parts.length}`, { token, form });
  }
  return { uploadId, last };
}

async function listMeta(base, token, name) {
  const r = await api(base, 'GET', `/api/videos/${name}/derivatives`, { token });
  return (r.data ?? []);
}

async function waitUntil(fn, timeoutMs, intervalMs = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last === true) return true;
    await sleep(intervalMs);
  }
  return last === true ? true : last;
}

async function waitAllReady(base, token, name, timeoutMs = 120000) {
  return waitUntil(async () => {
    const rows = await listMeta(base, token, name);
    return rows.length === 3 && rows.every((r) => r.status === 'ready') ? rows : false;
  }, timeoutMs, 2000);
}

async function storage(base, token) {
  const r = await api(base, 'GET', '/api/videos/storage', { token });
  return r.status === 200 ? r.data : null;
}

async function main() {
  console.log(`临时工作目录: ${tmpRoot}`);
  check('ffmpeg 可用（合成测试视频前提）', fs.existsSync(ffmpegBin()) || ffmpegBin() === 'ffmpeg', ffmpegBin());

  // 种子（独立进程；sqlite 由 synchronize 建表）
  const seedPath = path.join(API_DIR, 'dist', 'scripts', 'seed.js');
  const seed = spawnSync(process.execPath, [seedPath], { cwd: tmpRoot, env: process.env, encoding: 'utf8' });
  check('种子数据初始化（sqlite 临时库）', seed.status === 0, { status: seed.status, err: (seed.stderr ?? '').slice(-300) });
  if (seed.status !== 0) throw new Error('种子失败，终止');

  let app1 = await startApp();
  let base = app1.base;
  let token = app1.token;
  const names = [];
  let holdBuffers = [];
  const derivedDirs = [];
  let uploadIds = [];

  try {
    // ═════════ S0 启动期参数告警的可观测证据 ═════════
    console.log('\n[S0] 参数未配置时的可观测状态（启动期 warn 的机器可读口径）');
    const s0 = await storage(base, token);
    check('S0.1 护栏关闭：max_gb_configured=false 且 max_gb=null', s0?.max_gb_configured === false && s0?.max_gb === null, s0);
    check('S0.2 并发/超时按显式配置生效（测试值 3 / 5min）',
      s0?.concurrency === 3 && s0?.derive_timeout_min === 5, { conc: s0?.concurrency, timeout: s0?.derive_timeout_min });

    // ═════════ S1 端到端：分片上传 → 自动派生 → 可播可拖 ═════════
    console.log('\n[S1] 端到端（分片上传 → 自动派生 → Range/精灵图/关键帧）');
    const srcA = makeVideo(path.join(tmpRoot, 'src-a.mp4'), 6);
    holdBuffers.push(fs.readFileSync(srcA));
    const upA = await uploadChunked(base, token, holdBuffers[0], 'src-a.mp4');
    uploadIds.push(upA.uploadId);
    check('S1.1 分片上传末片返回 ingest 结果',
      [200, 201].includes(upA.last.status) && /^[0-9a-f-]{36}\.mp4$/.test(upA.last.data?.name ?? ''),
      { s: upA.last.status, name: upA.last.data?.name });
    const nameA = upA.last.data?.name;
    names.push(nameA);
    const dirA = path.join(derivedRoot, nameA.replace(/\.mp4$/, ''));
    derivedDirs.push(dirA);
    const rowsA = await waitAllReady(base, token, nameA);
    check('S1.2 proxy/sprite/index 全部 ready',
      Array.isArray(rowsA) && rowsA.length === 3 && ['proxy', 'sprite', 'index'].every((k) => rowsA.find((r) => r.kind === k)?.status === 'ready'),
      (rowsA ?? []).map((r) => `${r.kind}:${r.status}${r.error_msg ? `(${r.error_msg})` : ''}`));
    const r206 = await api(base, 'GET', `/api/videos/${nameA}/derivative/proxy`, { token, range: 'bytes=0-99' });
    check('S1.3 proxy Range 0-99 → 206（可拖拽的证据）', r206.status === 206 && /bytes 0-99\/\d+/.test(r206.headers.get('content-range') ?? ''),
      { s: r206.status, cr: r206.headers.get('content-range') });
    const spr = await api(base, 'GET', `/api/videos/${nameA}/derivative/sprite?token=${token}`, {});
    check('S1.4 sprite 下发 → 200 image/jpeg', spr.status === 200 && /image\/jpeg/.test(spr.ct ?? ''), { s: spr.status, ct: spr.ct });
    const idxMeta = await api(base, 'GET', `/api/videos/${nameA}/derivative/index/meta`, { token });
    const kf = idxMeta.data?.payload?.keyframes;
    check('S1.5 index 载荷 keyframes 非空且升序（帧吸附前置）',
      idxMeta.status === 200 && Array.isArray(kf) && kf.length > 0 && kf.every((v, i) => i === 0 || v > kf[i - 1]), kf);
    const s1 = await storage(base, token);
    check('S1.6 /storage 反映实际占用（derived_bytes>0，proxy_ready=1）',
      s1?.derived_bytes > 0 && s1?.proxy_ready === 1, { bytes: s1?.derived_bytes, ready: s1?.proxy_ready });

    // ═════════ S2 重试收敛（②） ═════════
    console.log('\n[S2] 派生失败自动重入并收敛（破坏源文件 → error retry=1 → 恢复 → 自动重入 ready）');
    const srcPathA = path.join(videoDir, nameA);
    // 仅动 proxy 一行：sprite/index 已是 ready，不参与本轮，避免"等全部 error"被 ready 行卡死
    fs.writeFileSync(srcPathA, 'this is not a video');
    dbRun('UPDATE t_video_derivative SET status=?, retry=0, error_msg=NULL WHERE file_name=? AND kind=?', ['pending', nameA, 'proxy']);
    // 直接读 sqlite（100ms 粒度）：error retry=1 的窗口只有 1 个 tick（5s），
    // 必须抢在自动重入第 2 次之前恢复源文件，否则会落到 retry>=2 终态
    await waitUntil(() => {
      const p = dbAll("SELECT status, retry FROM t_video_derivative WHERE file_name=? AND kind='proxy'", [nameA])[0];
      return p && p.status === 'error' && Number(p.retry) >= 1;
    }, 40000, 100);
    const errRows = await listMeta(base, token, nameA);
    const errProxy = errRows.find((r) => r.kind === 'proxy');
    check('S2.1 源文件损坏 → proxy 进入 error 且 retry=1（worker 已领取并失败）',
      errProxy?.status === 'error' && errProxy?.retry === 1, errProxy);
    fs.writeFileSync(srcPathA, holdBuffers[0]); // 恢复源文件（模拟瞬时故障消失）
    await waitUntil(() => {
      const p = dbAll("SELECT status, retry FROM t_video_derivative WHERE file_name=? AND kind='proxy'", [nameA])[0];
      return p && p.status === 'ready' && Number(p.retry) === 1;
    }, 90000, 100);
    const recovered = await listMeta(base, token, nameA);
    const recProxy = recovered.find((r) => r.kind === 'proxy');
    check('S2.2 恢复后无需人工干预自动重入并收敛为 ready（无永久卡死）',
      recProxy?.status === 'ready' && recProxy?.retry === 1, recProxy);
    const stuck = dbAll("SELECT id FROM t_video_derivative WHERE status='running'");
    check('S2.3 无残留 running 行（僵尸回收口径可用）', stuck.length === 0, stuck.length);

    // ═════════ S3 磁盘护栏（③） ═════════
    console.log('\n[S3] 磁盘护栏（超限告警 + LRU 只删 proxy + 源视频保留）');
    const srcB = makeVideo(path.join(tmpRoot, 'src-b.mp4'), 6);
    holdBuffers.push(fs.readFileSync(srcB));
    const upB = await uploadChunked(base, token, holdBuffers[1], 'src-b.mp4');
    uploadIds.push(upB.uploadId);
    const nameB = upB.last.data?.name;
    check('S3.0 第二个视频上传成功（构造 >1 个 ready proxy）', !!nameB && /^[0-9a-f-]{36}\.mp4$/.test(nameB ?? ''), { s: upB.last.status, name: nameB });
    if (!nameB) throw new Error('第二个视频上传失败，无法验证 LRU');
    names.push(nameB);
    derivedDirs.push(path.join(derivedRoot, nameB.replace(/\.mp4$/, '')));
    const rowsB = await waitAllReady(base, token, nameB);
    const rowsBnow = Array.isArray(rowsB) ? rowsB : await listMeta(base, token, nameB);
    check('S3.1 第二个视频三派生 ready',
      Array.isArray(rowsB) && rowsB.every((r) => r.status === 'ready'),
      rowsBnow.map((r) => `${r.kind}:${r.status}${r.error_msg ? `(${r.error_msg})` : ''}`));

    const srcSizes = {};
    for (const n of names) srcSizes[n] = fs.statSync(path.join(videoDir, n)).size;
    const before = await storage(base, token);
    const proxySizes = dbAll("SELECT size FROM t_video_derivative WHERE kind='proxy' AND status='ready'").map((r) => Number(r.size || 0));
    const minProxy = proxySizes.length ? Math.min(...proxySizes) : 0;
    // 阈值取"总量 - 最小 proxy 的一半"：保证至少淘汰一个、且淘汰一个后必然回落到阈值内
    const limitBytes = before.derived_bytes - Math.floor(minProxy * 0.5);
    const limitGb = limitBytes / 1024 ** 3;
    check('S3.2 实测基线可用（derived_bytes>0 且至少 2 个 ready proxy）',
      before?.derived_bytes > 0 && proxySizes.length >= 2 && minProxy > 0, { bytes: before?.derived_bytes, proxies: proxySizes });

    // 重启：护栏参数生效（阈值=实测占用减去半个最小 proxy，du 周期 10s）
    await app1.app.close();
    const app2 = await startApp({ VIDEO_DERIVED_MAX_GB: String(limitGb) });
    base = app2.base;
    token = app2.token;
    try {
      const hit = await waitUntil(async () => {
        const s = await storage(base, token);
        return s && s.proxy_evicted >= 1 && s.derived_bytes <= limitBytes ? s : false;
      }, 90000, 2000);
      const s3 = await storage(base, token);
      check('S3.3 超限后触发告警（last_disk_alert_at 已记录）', s3?.last_disk_alert_at !== null, s3?.last_disk_alert_at);
      check('S3.4 LRU 淘汰至少 1 个 proxy 且占用回落阈值内',
        !!hit && s3.proxy_evicted >= 1 && s3.derived_bytes <= limitBytes,
        { evicted: s3?.proxy_evicted, bytes: s3?.derived_bytes, limit: limitBytes });

      // evicted 行语义 + 文件级证据
      const evRow = dbAll("SELECT file_name FROM t_video_derivative WHERE kind='proxy' AND status='evicted'")[0];
      check('S3.5 存在 proxy status=evicted 的行', !!evRow, evRow);
      const evName = evRow?.file_name;
      if (!evName) {
        check('S3.6~S3.12 依赖 evicted 行，未产生则无法继续', false, 'no evicted row');
      } else {
        const evDir = path.join(derivedRoot, String(evName).replace(/\.mp4$/, ''));
        check('S3.6 evicted 的 proxy.mp4 已删除', !fs.existsSync(path.join(evDir, 'proxy.mp4')), path.join(evDir, 'proxy.mp4'));
        check('S3.7 sprite/index 仍在（只淘汰 proxy）',
          fs.existsSync(path.join(evDir, 'sprite.jpg')) && fs.existsSync(path.join(evDir, 'index.json')),
          fs.readdirSync(evDir).filter((f) => !f.startsWith('.')));
        check('S3.8 源视频保留且大小不变（磁盘护栏不碰源）',
          names.every((n) => fs.existsSync(path.join(videoDir, n)) && fs.statSync(path.join(videoDir, n)).size === srcSizes[n]),
          Object.fromEntries(names.map((n) => [n, fs.existsSync(path.join(videoDir, n)) ? fs.statSync(path.join(videoDir, n)).size : null])));
        const evGet = await api(base, 'GET', `/api/videos/${evName}/derivative/proxy`, { token, range: 'bytes=0-0' });
        check('S3.9 evicted 后 proxy 下发 → 404（不暴露坏路径）', evGet.status === 404, evGet.status);
        const alive = dbAll("SELECT file_name FROM t_video_derivative WHERE kind='proxy' AND status='ready'")[0];
        if (alive) {
          const okGet = await api(base, 'GET', `/api/videos/${alive.file_name}/derivative/proxy`, { token, range: 'bytes=0-0' });
          check('S3.10 未被淘汰的 proxy 仍可下发 206', okGet.status === 206, okGet.status);
        } else {
          check('S3.10 未被淘汰的 proxy 仍可下发 206', false, '本轮全部被淘汰（阈值过小，测试设计需复核）');
        }

        // 按需重生成：evicted → derive 重置 pending → （关掉护栏重启，避免刚生成又被 LRU 淘汰）
        const regen = await api(base, 'POST', `/api/videos/${evName}/derive`, { token, body: { kinds: ['proxy'] } });
        check('S3.11 evicted 再 derive 重置为 pending', [200, 201].includes(regen.status)
          && (regen.data ?? []).find((r) => r.kind === 'proxy')?.status === 'pending',
          (regen.data ?? []).find((r) => r.kind === 'proxy'));
        await app2.app.close();
        const regenApp = await startApp({ VIDEO_DERIVED_MAX_GB: '', VIDEO_ORPHAN_SWEEP: '0' });
        base = regenApp.base;
        token = regenApp.token;
        try {
          let lastRegen = null;
          await waitUntil(async () => {
            const rows = await listMeta(base, token, evName);
            lastRegen = rows.find((r) => r.kind === 'proxy');
            return lastRegen?.status === 'ready' ? rows : false;
          }, 60000, 1000);
          const regenReady = lastRegen;
          check('S3.12 按需重生成成功（evicted → ready，链路可自愈）', regenReady?.status === 'ready', regenReady);
        } finally {
          await regenApp.app.close();
        }
      }
    } finally {
      try { await app2.app.close(); } catch { /* S3.12 已提前关闭 */ }
    }

    // ═════════ S4 分片 TTL（④） ═════════
    console.log('\n[S4] 分片中断 24h 后目录被清理');
    const ttlId = randomUUID();
    const ttlDir = path.join(chunkRoot, ttlId);
    fs.mkdirSync(ttlDir, { recursive: true });
    fs.writeFileSync(path.join(ttlDir, '0'), Buffer.alloc(1024));
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(ttlDir, old, old);
    const freshId = randomUUID();
    const freshDir = path.join(chunkRoot, freshId);
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, '0'), Buffer.alloc(1024));

    const app3 = await startApp({ VIDEO_DERIVED_MAX_GB: '', VIDEO_ORPHAN_SWEEP: '0' });
    base = app3.base;
    token = app3.token;
    try {
      const cleaned = await waitUntil(async () => !fs.existsSync(ttlDir), 70000, 1000);
      check('S4.1 mtime>24h 的分片目录被清理', cleaned && !fs.existsSync(ttlDir), { cleaned });
      check('S4.2 未超 24h 的分片目录保留', fs.existsSync(freshDir), fs.existsSync(freshDir));
    } finally {
      await app3.app.close();
    }

    // ═════════ S5 孤儿巡检（默认关，显式开启后生效） ═════════
    console.log('\n[S5] 孤儿派生行巡检（VIDEO_ORPHAN_SWEEP=1）');
    const orphanName = names[names.length - 1];
    fs.rmSync(path.join(videoDir, orphanName), { force: true }); // 模拟人工删源视频
    const beforeOrphanRows = dbAll('SELECT COUNT(*) AS c FROM t_video_derivative WHERE file_name=?', [orphanName])[0].c;
    check('S5.1 前置：源视频删除后派生行仍在（P0 无级联）', Number(beforeOrphanRows) > 0, beforeOrphanRows);
    const app4 = await startApp({ VIDEO_DERIVED_MAX_GB: '', VIDEO_ORPHAN_SWEEP: '1' });
    base = app4.base;
    token = app4.token;
    try {
      const purged = await waitUntil(async () => {
        const c = dbAll('SELECT COUNT(*) AS c FROM t_video_derivative WHERE file_name=?', [orphanName])[0].c;
        return Number(c) === 0;
      }, 40000, 1000);
      check('S5.2 开启巡检后派生行被清理（源缺失 → purge）', purged, dbAll('SELECT COUNT(*) AS c FROM t_video_derivative WHERE file_name=?', [orphanName])[0].c);
      check('S5.3 对应输出目录被删除',
        !fs.existsSync(path.join(derivedRoot, orphanName.replace(/\.mp4$/, ''))),
        path.join(derivedRoot, orphanName.replace(/\.mp4$/, '')));
      const otherRows = dbAll('SELECT COUNT(*) AS c FROM t_video_derivative WHERE file_name=?', [names[0]])[0].c;
      check('S5.4 源视频仍在的派生行不被误删', Number(otherRows) === 3, otherRows);
    } finally {
      await app4.app.close();
    }
  } finally {
    // 收尾：临时目录整体删除（含 sqlite / storage / logs），不触碰正式库
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows 句柄占用时忽略 */ }
    try { await app1.app.close(); } catch { /* 已关闭 */ }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`结果: ${ok} 通过 / ${fail} 失败`);
  if (fail > 0) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
}

main().catch((e) => { console.error('测试执行异常:', e); process.exitCode = 1; });
