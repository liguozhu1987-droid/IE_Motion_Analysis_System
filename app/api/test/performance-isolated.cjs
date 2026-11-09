/**
 * W2/W3 隔离性能门：临时 SQLite(200工位) + 3102 + k6 + Lighthouse + 有界面 Chrome 时间线。
 * 默认执行性能三阶段；另支持 PERF_PHASES=segment-stop 复跑片段停止专项，汇总会记录实际阶段。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const API_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(API_DIR, '../..');
const OUT_DIR = path.resolve(ROOT, 'deliverables');
const BASE = 'http://127.0.0.1:3102/api';
const WEB = 'http://127.0.0.1:3102';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-performance-gate-'));
const dbPath = path.join(tempDir, 'gate-performance.db');
const logPath = path.join(tempDir, 'api.log');
const phases = (process.env.PERF_PHASES || 'k6,lighthouse,timeline').split(',').map((s) => s.trim()).filter(Boolean);
let server = null;

const env = {
  ...process.env,
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3102',
  DB_TYPE: 'sqlite', DB_PATH: dbPath,
  JWT_ACCESS_SECRET: 'isolated-performance-access-secret', JWT_REFRESH_SECRET: 'isolated-performance-refresh-secret',
  RULES_DIR: path.resolve(ROOT, 'app/config/rules'), WEB_DIST: path.resolve(ROOT, 'app/web/dist'),
  LOG_DIR: tempDir, METRICS_TOKEN: 'isolated-performance-metrics', SEC_HSTS: 'off',
  AI_ENABLED: 'false', AI_SUGGEST_ENABLED: 'false', VIDEO_AUTO_DERIVE: '0',
  PERF_ISOLATED: '1', PERF_DB_PATH: dbPath, BASE, WEB_URL: WEB,
  HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || API_DIR, env: { ...env, ...(options.extraEnv || {}) },
      stdio: 'inherit', windowsHide: Boolean(options.hide),
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
function runNode(script, extraEnv = {}) {
  return run(process.execPath, [script], { extraEnv });
}
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}
function findK6(dir = path.join(API_DIR, '.tools'), depth = 0) {
  if (process.env.K6_PATH && fs.existsSync(process.env.K6_PATH)) return process.env.K6_PATH;
  if (!fs.existsSync(dir) || depth > 4) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'k6.exe') return p;
    if (entry.isDirectory()) {
      const found = findK6(p, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
async function waitHealthy() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`隔离 API 提前退出: ${server.exitCode}`);
    try {
      const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch { /* 启动等待 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('隔离 API 60 秒未就绪');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await exited;
  }
}

(async () => {
  const results = {};
  try {
    const occupied = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false);
    if (occupied) throw new Error('3102 已被占用；为保护既有进程，性能门不启动也不清理该进程');
    console.log(`隔离容量数据库: ${dbPath}`);
    const seeded = await runNode(path.join(API_DIR, 'dist/scripts/seed.js'));
    if (seeded.code !== 0) throw new Error(`隔离 seed 失败: ${JSON.stringify(seeded)}`);
    const dataset = await runNode(path.join(__dirname, 'performance-dataset.cjs'));
    if (dataset.code !== 0) throw new Error(`200 工位数据生成失败: ${JSON.stringify(dataset)}`);

    const logFd = fs.openSync(logPath, 'a');
    // cwd=tempDir：视频/派生/临时上传目录也全部落在隔离区，绝不会写 app/api/storage。
    server = spawn(process.execPath, [path.join(API_DIR, 'dist/src/main.js')], {
      cwd: tempDir, env, stdio: ['ignore', logFd, logFd], windowsHide: true,
    });
    fs.closeSync(logFd);
    await waitHealthy();
    console.log(`隔离 API 就绪，执行阶段: ${phases.join(', ')}`);

    for (const phase of phases) {
      try {
        if (phase === 'k6') {
          const k6 = findK6();
          if (!k6) throw new Error('未找到 k6.exe；可设 K6_PATH 或安装到 app/api/.tools');
          console.log(`k6: ${k6}`);
          results.k6 = await run(k6, [
            'run', '--no-color',
            '-e', `BASE=${BASE}`, '-e', 'USER=admin', '-e', 'PWD=123456',
            '-e', 'SCENARIO=load,cachehit', '-e', 'PERF_ISOLATED=1',
            path.join(__dirname, 'perf-k6-load.js'),
          ], { cwd: tempDir });
          const summary = path.join(tempDir, 'perf-k6-summary.json');
          if (fs.existsSync(summary)) fs.copyFileSync(summary, path.join(OUT_DIR, 'PST-k6-summary.json'));
        } else if (phase === 'lighthouse') {
          results.lighthouse = await runNode(path.join(__dirname, 'performance-lighthouse.cjs'), { PERF_CHROME_PORT: String(await freePort()) });
        } else if (phase === 'timeline') {
          results.timeline = await runNode(path.join(__dirname, 'performance-timeline.cjs'));
        } else if (phase === 'segment-stop') {
          results['segment-stop'] = await runNode(path.join(__dirname, 'workbench-segment-stop.cjs'));
        } else {
          throw new Error(`未知 PERF_PHASES 阶段: ${phase}`);
        }
      } catch (e) {
        results[phase] = { code: 1, error: String(e.message || e) };
        console.error(`${phase} 阶段失败: ${results[phase].error}`);
      }
    }
    const report = {
      generated_at: new Date().toISOString(), base: BASE, database: 'temporary SQLite / 200 stations / 4000 elements',
      requested_phases: phases, results,
      passed: phases.length > 0 && phases.every((p) => results[p]?.code === 0),
      note: '本地隔离容量与浏览器实验室结果；不替代 SQL Server/IIS 生产入口或真实用户现场 INP。',
    };
    fs.writeFileSync(path.join(OUT_DIR, 'PST-performance-gate.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await stopServer();
    try {
      if (fs.existsSync(logPath)) fs.copyFileSync(logPath, path.join(OUT_DIR, 'PST-performance-api.log'));
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('隔离 API 已停止，临时数据库/浏览器配置/视频存储已删除');
    } catch (e) {
      console.error(`临时目录清理失败，请人工删除 ${tempDir}: ${e.message}`);
      process.exitCode = 1;
    }
  }
})();
