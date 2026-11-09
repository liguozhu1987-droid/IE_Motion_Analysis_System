/**
 * 隔离安全门禁启动器：临时 SQLite + 独立 3101 端口 + 同源托管 app/web/dist。
 * 只 seed 临时库，结束后停止子进程并删除临时目录；绝不连接 .env 中的 SQL Server。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';

const API_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(API_DIR, '../..');
const OUT_DIR = path.resolve(ROOT, 'deliverables');
const BASE = 'http://127.0.0.1:3101/api';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ie-security-gate-'));
const dbPath = path.join(tempDir, 'gate-security.db');
const logPath = path.join(tempDir, 'api.log');
let server = null;

const env = {
  ...process.env,
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3101',
  DB_TYPE: 'sqlite', DB_PATH: dbPath,
  JWT_ACCESS_SECRET: 'isolated-gate-access-secret', JWT_REFRESH_SECRET: 'isolated-gate-refresh-secret',
  RULES_DIR: path.resolve(ROOT, 'app/config/rules'),
  WEB_DIST: path.resolve(ROOT, 'app/web/dist'),
  LOG_DIR: tempDir, METRICS_TOKEN: 'isolated-metrics', SEC_HSTS: 'off',
  AI_ENABLED: 'false', AI_SUGGEST_ENABLED: 'false', VIDEO_AUTO_DERIVE: '0',
  SECURITY_ISOLATED: '1', SECURITY_DB_PATH: dbPath, BASE, WEB_URL: 'http://127.0.0.1:3101',
  HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
};

function runNode(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: API_DIR, env: { ...env, ...extraEnv }, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitHealthy() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`隔离 API 提前退出: ${server.exitCode}; 日志 ${logPath}`);
    try {
      const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch { /* 启动等待 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`隔离 API 60 秒未就绪；日志 ${logPath}`);
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
  try {
    const occupied = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false);
    if (occupied) throw new Error('3101 已被占用；为保护既有进程，隔离门禁不启动也不清理该进程');

    console.log(`隔离数据库: ${dbPath}`);
    const seeded = await runNode(path.join(API_DIR, 'dist/scripts/seed.js'));
    if (seeded.code !== 0) throw new Error(`隔离 seed 失败: ${JSON.stringify(seeded)}`);

    const logFd = fs.openSync(logPath, 'a');
    server = spawn(process.execPath, [path.join(API_DIR, 'dist/src/main.js')], {
      cwd: API_DIR, env, stdio: ['ignore', logFd, logFd], windowsHide: true,
    });
    fs.closeSync(logFd);
    await waitHealthy();
    console.log('隔离 API 就绪：开始权限矩阵与 XSS 浏览器回归');

    const matrix = await runNode(path.join(__dirname, 'permission-matrix.cjs'));
    const xss = await runNode(path.join(__dirname, 'xss-browser.cjs'));
    const report = {
      generated_at: new Date().toISOString(), base: BASE, database: 'temporary SQLite',
      permission_matrix_exit: matrix.code, xss_exit: xss.code,
      passed: matrix.code === 0 && xss.code === 0,
      note: 'API 日志仅保留到临时目录清理前；结构化结果归档于 deliverables/PST-permission-matrix.json 与 PST-xss-report.json',
    };
    fs.writeFileSync(path.join(OUT_DIR, 'PST-isolated-gate.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await stopServer();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('隔离 API 已停止，临时数据库已删除');
    } catch (e) {
      console.error(`临时目录清理失败，请人工删除 ${tempDir}: ${e.message}`);
      process.exitCode = 1;
    }
  }
})();
