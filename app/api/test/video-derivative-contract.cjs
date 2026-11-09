/**
 * SPEC-VID-P0 §8 视频派生契约测试（服务端派生层 + 帧步进前置资产）。
 *
 * 被测契约（逐条独立验证）：
 *  - 分片上传（§7.1）：uploadId/chunkIndex/chunkTotal 查询参数模式；非末片 {received,total}；
 *    末片返回与单文件上传完全相同的 ingest 结果（VideoHandle: url/name/probe/transcoded）；
 *    末片但分片不齐 → 400 且报缺失序号
 *  - 派生入队（§4-1）：POST derive 幂等（重复请求不重转；唯一键 (file_name,kind)）
 *  - worker 状态机（§5）：pending → ready；meta 回填（fps/frames/duration_ms/width/height/vfr）
 *  - 派生文件（§4-3）：proxy Range 206 / 越界 416（§7.2 不再转 500）/ 无 token 401 / 非法 kind 400
 *  - meta 探活（§4-4）：index.json/sprite.json 载荷（CFR fps/frames、VFR 判定、sprite cols/rows/count 实数）
 *  - 归属校验：assertReadable 复用（admin 全权放行；无 token 拒绝）
 *
 * 前置：npm run build 后本文件经 dist 启动（进程内 listen(0)，不占固定端口）；
 *       DB_TYPE=mssql 直连 CN_AME（与既有契约测试一致，收尾清理自有数据）。
 * 运行：node test/video-derivative-contract.cjs
 *
 * 设计（确定性，不依赖外部资源）：
 *  - 测试视频由本机 ffmpeg 合成（testsrc 6s/10fps/320x240 → 60 帧），CFR、无音频；
 *  - ffmpeg 解析沿用 VideosService.resolveFfmpeg() 口径：FFMPEG_BIN → app/api/bin → PATH；
 *  - 固定名前缀 qa-vid-deriv-*，收尾按名前缀清理 t_video_derivative / t_video_asset / 磁盘文件。
 */
process.env.DB_TYPE = process.env.DB_TYPE || 'mssql';
require('dotenv').config();
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module.js');
const { AllExceptionsFilter } = require('../dist/src/core/all-exceptions.filter.js');
const { loadConfig } = require('../dist/src/core/config/configuration.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
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

async function api(base, method, p, opts = {}) {
  const headers = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.range) headers['range'] = opts.range;
  let body;
  if (opts.form) { body = opts.form; }
  else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const res = await fetch(`${base}${p}`, { method, headers, body });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : null;
  return { status: res.status, data, ct, headers: res.headers };
}

const cfg = loadConfig();

async function dbQuery(sql, params = []) {
  if (cfg.dbType === 'mssql') {
    const sqlmod = require('mssql');
    const pool = await sqlmod.connect({
      server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
      options: { encrypt: false, trustServerCertificate: true },
    });
    try {
      const req = pool.request();
      params.forEach((p, i) => req.input(`p${i}`, p));
      const r = await req.query(sql);
      return r.recordset;
    } finally { await pool.close(); }
  }
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(cfg.dbPath);
  try { return raw.prepare(sql).all(...params); } finally { raw.close(); }
}

async function dbExec(sql, params = []) {
  if (cfg.dbType === 'mssql') {
    const sqlmod = require('mssql');
    const pool = await sqlmod.connect({
      server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
      options: { encrypt: false, trustServerCertificate: true },
    });
    try {
      const req = pool.request();
      params.forEach((p, i) => req.input(`p${i}`, p));
      await req.query(sql);
      return;
    } finally { await pool.close(); }
  }
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(cfg.dbPath);
  try { raw.prepare(sql).run(...params); } finally { raw.close(); }
}

/** ffmpeg 解析（与 VideosService.resolveFfmpeg 同口径） */
function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const local = path.resolve(process.cwd(), 'bin', 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg';
}

/** 合成 CFR 测试视频：6s / 10fps / 320x240 / 无音频 → 60 帧 */
function makeTinyVideo(dir) {
  const ffmpeg = resolveFfmpeg();
  const out = path.join(dir, 'qa-vid-deriv-src.mp4');
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
    '-pix_fmt', 'yuv420p', out,
  ], { stdio: 'ignore' });
  return out;
}

/** S7 用：直接把合成视频写到指定路径（不走 ingest，无归属登记） */
function makeTinyVideoFast(outPath) {
  execFileSync(resolveFfmpeg(), [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
    '-pix_fmt', 'yuv420p', outPath,
  ], { stdio: 'ignore' });
  return outPath;
}

/** 轮询派生 meta 直到全部 ready 或超时 */
async function waitReady(base, token, name, timeoutMs = 90000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await api(base, 'GET', `/api/videos/${name}/derivatives`, { token });
    const rows = last.data ?? [];
    if (rows.length === 3 && rows.every((r) => r.status === 'ready')) return rows;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last?.data ?? [];
}

async function main() {
  const ffmpeg = resolveFfmpeg();
  check('ffmpeg 可用（合成测试视频前提）', fs.existsSync(ffmpeg) || ffmpeg === 'ffmpeg', ffmpeg);

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  const login = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const token = login.data?.accessToken;
  check('登录 admin/123456', !!token, login.status);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vid-deriv-'));
  const srcFile = makeTinyVideo(tmpDir);
  const buf = fs.readFileSync(srcFile);
  let name = null;
  const uploadIds = [];

  try {
    // ═══════════════ S1 分片上传（§7.1 契约） ═══════════════
    console.log('\n[S1] 分片上传（3 片；末片 = 完整 ingest 结果）');
    const uploadId = randomUUID();
    uploadIds.push(uploadId);
    const parts = [buf.subarray(0, 1000), buf.subarray(1000, 2000), buf.subarray(2000)];
    let lastResp = null;
    for (let i = 0; i < parts.length; i++) {
      const form = new FormData();
      form.append('file', new Blob([parts[i]]), 'part.mp4');
      if (i === 0) { form.append('originalname', 'qa-vid-deriv-src.mp4'); form.append('raw', ''); }
      lastResp = await api(base, 'POST',
        `/api/videos/upload?uploadId=${uploadId}&chunkIndex=${i}&chunkTotal=${parts.length}`,
        { token, form });
      if (i < parts.length - 1) {
        check(`S1.${i + 1} 非末片 ${i} → {received,total}`,
          [200, 201].includes(lastResp.status) && lastResp.data?.received === i + 1 && lastResp.data?.total === parts.length,
          lastResp.data);
      }
    }
    check('S1.3 末片返回 ingest 结果（url/name/probe/transcoded 四字段）',
      [200, 201].includes(lastResp.status) && typeof lastResp.data?.url === 'string' && /^[0-9a-f-]{36}\.mp4$/.test(lastResp.data?.name ?? '')
      && !!lastResp.data?.probe && typeof lastResp.data?.transcoded === 'boolean',
      { url: lastResp.data?.url, name: lastResp.data?.name, transcoded: lastResp.data?.transcoded });
    name = lastResp.data?.name;

    // S1.5 P0.5 派生自动触发：上传成功后服务端自动入队（无需手动 POST /derive）
    let autoRows = [];
    for (let i = 0; i < 10 && autoRows.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const l = await api(base, 'GET', `/api/videos/${name}/derivatives`, { token });
      autoRows = l.data ?? [];
    }
    check('S1.5 上传后派生自动入队（ingest 回调，3 行 pending+）', autoRows.length === 3,
      autoRows.map((r) => `${r.kind}:${r.status}`));

    // 分片不齐：只传末片 → 400 报缺失序号
    const uid2 = randomUUID();
    uploadIds.push(uid2);
    const form2 = new FormData();
    form2.append('file', new Blob([buf.subarray(0, 500)]), 'part.mp4');
    const badChunk = await api(base, 'POST',
      `/api/videos/upload?uploadId=${uid2}&chunkIndex=2&chunkTotal=3`, { token, form: form2 });
    check('S1.4 末片但 0/1 缺失 → 400 且 detail 报缺失序号',
      badChunk.status === 400 && /缺失序号/.test(badChunk.data?.detail ?? ''), badChunk.data);

    // ═══════════════ S2 派生入队与幂等（§4-1） ═══════════════
    console.log('\n[S2] 派生入队（幂等 + 唯一键）');
    const d1 = await api(base, 'POST', `/api/videos/${name}/derive`, { token, body: {} });
    check('S2.1 derive → 200 且返回 3 类 meta',
      [200, 201].includes(d1.status) && Array.isArray(d1.data) && d1.data.length === 3, d1.data?.map?.((r) => r.kind));
    check('S2.2 三类 kind = index/proxy/sprite',
      (d1.data ?? []).map((r) => r.kind).sort().join(',') === 'index,proxy,sprite');
    const d2 = await api(base, 'POST', `/api/videos/${name}/derive`, { token, body: {} });
    check('S2.3 重复 derive 仍 200 且不产生重复行（唯一键 (file_name,kind)）',
      [200, 201].includes(d2.status) && (d2.data ?? []).length === 3, d2.data?.length);
    const rowCount = (await dbQuery('SELECT COUNT(*) AS c FROM t_video_derivative WHERE file_name = @p0', [name]))[0].c;
    check('S2.4 DB 行数 = 3（并发/重复请求未击穿唯一索引）', Number(rowCount) === 3, rowCount);
    const d3 = await api(base, 'POST', `/api/videos/${name}/derive`, { token, body: { kinds: ['proxy'] } });
    check('S2.5 kinds 过滤（仅 proxy）→ 200 且仍 3 行（listMeta 全量返回）',
      [200, 201].includes(d3.status) && (d3.data ?? []).length === 3, d3.data?.length);
    const d4 = await api(base, 'POST', `/api/videos/${name}/derive`, { token, body: { kinds: ['bogus'] } });
    check('S2.6 非法 kind → 400', d4.status === 400, d4.status);

    // ═══════════════ S3 worker 状态机 + meta 回填（§5） ═══════════════
    console.log('\n[S3] worker 处理（ffmpeg 实跑：代理 all-intra / 精灵图 / 帧索引）');
    const rows = await waitReady(base, token, name);
    const byKind = Object.fromEntries((rows ?? []).map((r) => [r.kind, r]));
    check('S3.1 三类派生全部 ready', ['proxy', 'sprite', 'index'].every((k) => byKind[k]?.status === 'ready'),
      Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v?.status + (v?.error_msg ? `(${v.error_msg})` : '')])));
    check('S3.2 proxy meta：fps=10 / frames=60 / width=854 / duration_ms=6000',
      byKind.proxy?.fps === 10 && byKind.proxy?.frames === 60 && byKind.proxy?.width === 854 && byKind.proxy?.duration_ms === 6000,
      { fps: byKind.proxy?.fps, frames: byKind.proxy?.frames, w: byKind.proxy?.width, dur: byKind.proxy?.duration_ms });
    check('S3.3 index meta：frames=60 / vfr=false（CFR 不落 entries）',
      byKind.index?.frames === 60 && byKind.index?.vfr === false, { frames: byKind.index?.frames, vfr: byKind.index?.vfr });
    check('S3.4 sprite meta：frames=6（fps=1 采样实数，非 cols×rows 推算）',
      byKind.sprite?.frames === 6, byKind.sprite?.frames);

    // ═══════════════ S4 派生文件下发（§4-3 / §7.2） ═══════════════
    console.log('\n[S4] 派生文件（Range 206 / 416 不转 500 / 鉴权 / kind 白名单）');
    const r206 = await api(base, 'GET', `/api/videos/${name}/derivative/proxy`, { token, range: 'bytes=0-99' });
    check('S4.1 proxy Range 0-99 → 206 + Content-Range',
      r206.status === 206 && /bytes 0-99\/\d+/.test(r206.headers.get('content-range') ?? ''), { s: r206.status, cr: r206.headers.get('content-range') });
    const r416 = await api(base, 'GET', `/api/videos/${name}/derivative/proxy`, { token, range: 'bytes=999999999-' });
    check('S4.2 越界 Range → 416（§7.2 修复：不再是 500）', r416.status === 416, { s: r416.status, body: r416.data });
    const noTok = await api(base, 'GET', `/api/videos/${name}/derivative/proxy`, {});
    check('S4.3 无 token → 401', noTok.status === 401, noTok.status);
    const badKind = await api(base, 'GET', `/api/videos/${name}/derivative/bogus`, { token });
    check('S4.4 非法 kind → 400', badKind.status === 400, badKind.status);
    const sprite = await api(base, 'GET', `/api/videos/${name}/derivative/sprite?token=${token}`, {});
    check('S4.5 sprite（img 标签 ?token= 路径）→ 200 image/jpeg',
      sprite.status === 200 && /image\/jpeg/.test(sprite.ct ?? ''), { s: sprite.status, ct: sprite.ct });
    const notReady = await api(base, 'GET', `/api/videos/${name}/derivative/proxy`, { token, range: 'bytes=0-0' });
    check('S4.6 单字节 Range → 206（seek 拖动依赖）', notReady.status === 206, notReady.status);

    // ═══════════════ S5 meta 探活载荷（§4-4） ═══════════════
    console.log('\n[S5] meta 载荷（index.json / sprite.json）');
    const idxMeta = await api(base, 'GET', `/api/videos/${name}/derivative/index/meta`, { token });
    check('S5.1 index meta 载荷：fps=10 / frames=60 / durationMs=6000 / vfr=0 且无 entries',
      idxMeta.status === 200 && idxMeta.data?.payload?.fps === 10 && idxMeta.data?.payload?.frames === 60
      && idxMeta.data?.payload?.durationMs === 6000 && idxMeta.data?.payload?.vfr === 0
      && idxMeta.data?.payload?.entries === undefined,
      idxMeta.data?.payload);
    // S5.1b P0.5 关键帧清单：合成片首帧即 I 帧（GOP=250 默认下 6s/60fps 片至少 1 个 I 帧 @0ms）
    const kf = idxMeta.data?.payload?.keyframes;
    check('S5.1b index 载荷 keyframes：非空数组、升序、首项≈0（源 I 帧时刻 ms）',
      Array.isArray(kf) && kf.length > 0 && kf.every((v, i) => i === 0 || v > kf[i - 1]) && Math.abs(kf[0]) <= 50,
      kf);
    const sprMeta = await api(base, 'GET', `/api/videos/${name}/derivative/sprite/meta`, { token });
    check('S5.2 sprite meta 载荷：cols=10 / rows=1 / count=6（实际值）',
      sprMeta.status === 200 && sprMeta.data?.payload?.cols === 10 && sprMeta.data?.payload?.rows === 1
      && sprMeta.data?.payload?.count === 6, sprMeta.data?.payload);
    const missMeta = await api(base, 'GET', `/api/videos/${name}/derivative/index/meta`, {});
    check('S5.3 meta 无 token → 401', missMeta.status === 401, missMeta.status);

    // ═══════════════ S6 幂等不重转（ready 行不被重复消费） ═══════════════
    console.log('\n[S6] 幂等不重转');
    const before = (await dbQuery('SELECT updated_at FROM t_video_derivative WHERE file_name = @p0 AND kind = @p1', [name, 'proxy']))[0];
    await api(base, 'POST', `/api/videos/${name}/derive`, { token, body: {} });
    await new Promise((r) => setTimeout(r, 7000)); // 跨过一个 worker tick
    const after = (await dbQuery('SELECT updated_at FROM t_video_derivative WHERE file_name = @p0 AND kind = @p1', [name, 'proxy']))[0];
    check('S6.1 重复 derive 后 ready 行 updated_at 不变（未触发重转）',
      new Date(before.updated_at).getTime() === new Date(after.updated_at).getTime(),
      { before: before.updated_at, after: after.updated_at });
  } finally {
    // ── 收尾清理（自有数据：派生行/资产登记/磁盘文件/分片残留目录） ──
    if (name) {
      await dbExec('DELETE FROM t_video_derivative WHERE file_name = @p0', [name]).catch(() => {});
      await dbExec('DELETE FROM t_video_asset WHERE file_name = @p0', [name]).catch(() => {});
      const derived = path.resolve(process.cwd(), 'storage', 'videos', 'derived', name.replace(/\.mp4$/, ''));
      fs.rmSync(derived, { recursive: true, force: true });
      const src = path.resolve(process.cwd(), 'storage', 'videos', name);
      fs.rmSync(src, { force: true });
    }
    const chunkRoot = path.resolve(process.cwd(), 'storage', 'videos', 'tmp', 'chunks');
    for (const uid of uploadIds) fs.rmSync(path.join(chunkRoot, uid), { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await app.close();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`结果: ${ok} 通过 / ${fail} 失败`);
  if (fail > 0) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
}

/** 独立套件 S7：evicted 状态语义（P0.5 LRU）——不跑 ffmpeg，直接操纵 DB + 文件 */
async function testEvicted() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const login = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const token = login.data?.accessToken;
  const name = `${randomUUID()}.mp4`; // filePathOf 白名单 ^[0-9a-f-]{36}\.mp4$：测试名不得带前缀
  const srcPath = path.resolve(process.cwd(), 'storage', 'videos', name);
  const derivedDir = path.resolve(process.cwd(), 'storage', 'videos', 'derived', name.replace(/\.mp4$/, ''));
  try {
    // 直造源文件 + ready proxy 行（跳过 ffmpeg 转码链：evicted 语义与编码无关）
    makeTinyVideoFast(srcPath);
    await dbExec(`INSERT INTO t_video_derivative (id, file_name, kind, status, path, size, retry, last_accessed_at)
      VALUES (@p0, @p1, @p2, @p3, @p4, @p5, 0, @p6)`,
      [randomUUID(), name, 'proxy', 'ready', path.join(derivedDir, 'proxy.mp4'), 1024, new Date(Date.now() - 3600_000)]);
    fs.mkdirSync(derivedDir, { recursive: true });
    fs.writeFileSync(path.join(derivedDir, 'proxy.mp4'), Buffer.alloc(2048));

    // proxy 可下发（ready + 文件存在）
    const p1 = await api(base, 'GET', `/api/videos/${name}/derivative/proxy`, { token, range: 'bytes=0-0' });
    check('S7.1 evicted 前置：ready proxy 可下发 206', p1.status === 206, p1.status);

    // 手工置 evicted（模拟 LRU 淘汰结果）+ 删文件
    await dbExec(`UPDATE t_video_derivative SET status='evicted', path=NULL, size=NULL, last_accessed_at=NULL WHERE file_name=@p0 AND kind='proxy'`, [name]);
    fs.rmSync(path.join(derivedDir, 'proxy.mp4'), { force: true });
    const p2 = await api(base, 'GET', `/api/videos/${name}/derivative/proxy`, { token, range: 'bytes=0-0' });
    check('S7.2 evicted 后下发 → 404（fileOf 只认 ready，不暴露坏路径）', p2.status === 404, p2.status);

    // derive() 对 evicted 行重置 pending（按需再生成）
    const d = await api(base, 'POST', `/api/videos/${name}/derive`, { token, body: { kinds: ['proxy'] } });
    const prow = (d.data ?? []).find((r) => r.kind === 'proxy');
    check('S7.3 derive 对 evicted 行重置 pending（按需再生成语义）',
      [200, 201].includes(d.status) && prow?.status === 'pending', prow);
    const dbRow = (await dbQuery('SELECT status, retry FROM t_video_derivative WHERE file_name=@p0 AND kind=@p1', [name, 'proxy']))[0];
    check('S7.4 DB 侧 evicted → pending 且 retry 归零', dbRow?.status === 'pending' && Number(dbRow?.retry) === 0, dbRow);
  } finally {
    await dbExec('DELETE FROM t_video_derivative WHERE file_name = @p0', [name]).catch(() => {});
    await dbExec('DELETE FROM t_video_asset WHERE file_name = @p0', [name]).catch(() => {});
    fs.rmSync(derivedDir, { recursive: true, force: true });
    fs.rmSync(srcPath, { force: true });
    await app.close();
  }
}

main().then(() => testEvicted()).catch((e) => { console.error('测试执行异常:', e); process.exitCode = 1; });
