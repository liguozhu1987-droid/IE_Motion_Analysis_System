/**
 * 可复用隔离回归启动器（本地开发用，不连接正式库）。
 *
 * 每次运行（每一遍）都会：
 *   1. 新建独立临时目录与临时 SQLite 文件；
 *   2. 用 TypeORM synchronize 建表（sqlite 对应 migrate 的等价动作）；
 *   3. 在临时库内执行既有 seed，生成最小夹具（用户/角色/规则/L01-L02 与工位）；
 *   4. 校验关键夹具存在；
 *   5. 以 cwd=临时目录、DB_PATH=临时库启动目标套件（可选先拉起独立端口 API）；
 *   6. finally / 信号中断时都停止子进程并删除临时目录。
 *
 * 用法示例：
 *   node test/isolated-harness.cjs --suite smoke --script dist/test/smoke.js --mode in-process --repeat 2
 *   node test/isolated-harness.cjs --suite demo  --script test/xxx.cjs --mode api --repeat 2
 *   node test/isolated-harness.cjs --suite acl --script test/x.cjs --mode api --datasource mssql
 *
 * 数据源（按套件选择，默认 sqlite）：
 * - sqlite：临时库文件 + TypeORM synchronize 建表，完全离线，行为保持不变。
 * - mssql：只认 ISO_MSSQL_*（ISO_MSSQL_HOST/DB/USER/PASS，可选 PORT/ENCRYPT），
 *   拒绝 CN_AME / 系统库 / 与 .env DB_NAME 同名 / 无测试库标记的库名；
 *   建表只走 dist/scripts/migrate.js（幂等 DDL），不建库、不 DROP DATABASE；
 *   不提供 ISO_MSSQL_* 时明确拒绝运行，绝不回退到 .env 的 DB_*。
 * - 子进程环境一律先剔除 DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS/DB_ENCRYPT/DATABASE_URL，
 *   因此 sqlite 套件不可能落到 .env 中的 SQL Server。
 * - cwd 设为临时目录，任何相对路径的 storage/uploads/logs 都落在临时目录内。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const API_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(API_DIR, '../..');
const ACTIVE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const activeChildren = new Set();
let activeTempDir = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const MSSQL_REQUIRED = ['ISO_MSSQL_HOST', 'ISO_MSSQL_DB', 'ISO_MSSQL_USER', 'ISO_MSSQL_PASS'];
const MSSQL_FORBIDDEN_DBS = new Set(['cn_ame', 'master', 'model', 'msdb', 'tempdb']);
/** 专用测试库命名标记：库名必须能证明不是生产库，避免「手滑指向正式库」。 */
const MSSQL_TEST_MARKER = /(test|iso|ci|tmp|sandbox|dev|uat|qa|stage)/i;

class MssqlTargetError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** 从环境解析 MSSQL 专用测试库；只读 ISO_MSSQL_*，绝不回退 .env 的 DB_*。 */
function resolveMssqlTarget() {
  const read = (key) => (process.env[key] ?? '').trim();
  const pass = process.env.ISO_MSSQL_PASS ?? '';
  const missing = MSSQL_REQUIRED.filter((key) => (key === 'ISO_MSSQL_PASS' ? !pass.trim() : !read(key)));
  if (missing.length) {
    throw new MssqlTargetError(
      `拒绝运行：缺少专用测试库配置 ${missing.join(' / ')}。\n`
      + '  基座在 mssql 模式下只认 ISO_MSSQL_*，绝不回退到 .env 的 DB_*（.env 指向生产库 CN_AME）。\n'
      + '  请先提供 ISO_MSSQL_HOST / ISO_MSSQL_DB / ISO_MSSQL_USER / ISO_MSSQL_PASS（可选 ISO_MSSQL_PORT / ISO_MSSQL_ENCRYPT）。',
      'MSSQL_CONFIG_MISSING',
    );
  }
  const db = read('ISO_MSSQL_DB');
  const lower = db.toLowerCase();
  const prodDb = (process.env.DB_NAME ?? 'CN_AME').trim();
  if (MSSQL_FORBIDDEN_DBS.has(lower)) {
    throw new MssqlTargetError(
      `拒绝运行：ISO_MSSQL_DB='${db}' 是生产库或系统库，禁止执行 migrate / seed / 业务写入。`,
      'MSSQL_TARGET_FORBIDDEN',
    );
  }
  if (prodDb && lower === prodDb.toLowerCase()) {
    throw new MssqlTargetError(
      `拒绝运行：ISO_MSSQL_DB='${db}' 与 .env 的 DB_NAME 同名（生产库），禁止执行 migrate / seed / 业务写入。`,
      'MSSQL_TARGET_FORBIDDEN',
    );
  }
  if (!MSSQL_TEST_MARKER.test(db)) {
    throw new MssqlTargetError(
      `拒绝运行：ISO_MSSQL_DB='${db}' 未带测试库标记（需含 test/iso/ci/tmp/sandbox/dev/uat/qa/stage 之一），`
      + '无法确认是专用测试库，为防误伤生产库已中止。',
      'MSSQL_TARGET_FORBIDDEN',
    );
  }
  return {
    host: read('ISO_MSSQL_HOST'),
    port: Number(read('ISO_MSSQL_PORT') || 1433),
    db,
    user: read('ISO_MSSQL_USER'),
    pass,
    encrypt: (read('ISO_MSSQL_ENCRYPT') || 'false') === 'true',
  };
}

async function mssqlPool(target) {
  const mssql = require('mssql');
  try {
    return await mssql.connect({
      server: target.host,
      port: target.port,
      user: target.user,
      password: target.pass,
      database: target.db,
      options: { encrypt: target.encrypt, trustServerCertificate: true },
      pool: { min: 0, max: 4, idleTimeoutMillis: 10000 },
      connectionTimeout: 15000,
      requestTimeout: 60000,
    });
  } catch (e) {
    if (/Cannot open database|4060/i.test(String(e && e.message))) {
      throw new Error(
        `专用测试库 ${target.db} 不存在或无权访问（基座不会创建数据库，请先由 DBA 建空库）：${e.message}`,
      );
    }
    throw e;
  }
}

/** 执行清理语句；__RUN_START__ 占位替换为 UTC 时间字面量（仅匹配本轮产生的行）。 */
async function runMssqlCleanup(target, statements = [], runStartUtc = null, label = 'cleanup') {
  if (!statements.length) return { statements: 0, rows: 0, skipped: 0 };
  const pool = await mssqlPool(target);
  let rows = 0;
  let skipped = 0;
  try {
    for (const raw of statements) {
      const sql = raw.replace(
        /__RUN_START__/g,
        runStartUtc ? `'${runStartUtc}'` : `'1970-01-01 00:00:00'`,
      );
      try {
        const result = await pool.request().query(sql);
        rows += (result.rowsAffected || []).reduce((sum, n) => sum + n, 0);
      } catch (e) {
        // 首轮 migrate 之前表还不存在：清理语句跳过即可，不算失败。
        if (/Invalid object name|208/i.test(String(e && e.message))) { skipped += 1; continue; }
        throw e;
      }
    }
  } finally {
    await pool.close();
  }
  console.log(`[${label}] MSSQL 清理: ${statements.length} 条语句，影响 ${rows} 行，跳过 ${skipped} 条（表未建立）`);
  return { statements: statements.length, rows, skipped };
}

async function applyExtraFixturesMssql(target, statements = []) {
  if (!statements.length) return;
  const pool = await mssqlPool(target);
  try {
    for (const sql of statements) await pool.request().query(sql);
    console.log(`隔离额外夹具（MSSQL）: 已执行 ${statements.length} 条 SQL`);
  } finally {
    await pool.close();
  }
}

/** 收尾残留核对：这些表的行数在每一轮清理后必须回到同一基线。
 *  说明：t_refresh_token 每轮登录都会新增（按轮清空），t_audit_log 是追加只读日志
 *  （保留本轮审计、不纳入基线），二者不作为「夹具残留」指标。 */
const MSSQL_RESIDUE_TABLES = [
  't_user', 't_tenant', 't_rule_set', 't_line', 't_station', 't_element', 't_improvement',
  't_station_collaborator', 't_line_share', 't_video_asset',
];

async function mssqlResidue(target) {
  const pool = await mssqlPool(target);
  try {
    const rows = {};
    for (const table of MSSQL_RESIDUE_TABLES) {
      const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`);
      rows[table] = Number(r.recordset[0].n);
    }
    return rows;
  } finally {
    await pool.close();
  }
}

async function verifyFixturesMssql(target) {
  const pool = await mssqlPool(target);
  try {
    const scalar = async (sql) => Number((await pool.request().query(sql)).recordset[0].n);
    const users = await scalar('SELECT COUNT(*) AS n FROM t_user');
    const tenants = await scalar('SELECT COUNT(*) AS n FROM t_tenant');
    const ruleSets = await scalar('SELECT COUNT(*) AS n FROM t_rule_set');
    const seededStations = await scalar(
      "SELECT COUNT(*) AS n FROM t_station WHERE station_id IN ('L01-ST01','L02-ST01')",
    );
    const elements = await scalar("SELECT COUNT(*) AS n FROM t_element WHERE station_id = 'L01-ST01'");
    if (users < 5) throw new Error(`夹具用户不足: ${users}`);
    if (tenants < 2) throw new Error(`夹具租户不足: ${tenants}`);
    if (ruleSets < 6) throw new Error(`夹具规则集不足: ${ruleSets}`);
    if (seededStations !== 2) throw new Error(`关键工位缺失: 期望 2，实际 ${seededStations}`);
    if (elements < 1) throw new Error('L01-ST01 要素缺失');
    return { users, tenants, ruleSets, seededStations, elements };
  } finally {
    await pool.close();
  }
}

function buildEnv(tempDir, port, extraEnv = {}, dbFileName = 'isolated.db', mssqlTarget = null) {
  const dbPath = path.join(tempDir, dbFileName);
  const artifactDir = path.join(tempDir, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const base = `http://127.0.0.1:${port}/api`;
  const env = { ...process.env };
  // 物理隔离：先剔除任何 SQL Server 连接信息。mssql 模式随后只从 ISO_MSSQL_* 注入，
  // 绝不把 .env 里的 DB_*（生产库 CN_AME）带进子进程。
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'DB_ENCRYPT', 'DATABASE_URL']) {
    delete env[key];
  }
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  Object.assign(env, {
    HOST: '127.0.0.1',
    PORT: String(port),
    RULES_DIR: path.resolve(ROOT, 'app/config/rules'),
    WEB_DIST: path.resolve(ROOT, 'app/web/dist'),
    LOG_DIR: path.join(tempDir, 'logs'),
    ISOLATED_ARTIFACT_DIR: artifactDir,
    JWT_ACCESS_SECRET: 'isolated-harness-access-secret',
    JWT_REFRESH_SECRET: 'isolated-harness-refresh-secret',
    METRICS_TOKEN: 'isolated-harness-metrics',
    SEC_HSTS: 'off',
    AI_ENABLED: 'false',
    AI_SUGGEST_ENABLED: 'false',
    AI_WASTE_ENABLED: 'false',
    VIDEO_AUTO_DERIVE: '0',
    REGISTER_ENABLED: 'true',
    BASE: base,
    WEB_URL: `http://127.0.0.1:${port}`,
    ISOLATED_HARNESS: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  });
  if (mssqlTarget) {
    Object.assign(env, {
      // production 仅用于关闭 TypeORM synchronize——表结构只允许由 scripts/migrate.ts 建立，
      // 避免 synchronize 在首次建表后擅自 ALTER。JWT 已注入非 dev- 前缀的隔离密钥，满足配置校验。
      NODE_ENV: 'production',
      DB_TYPE: 'mssql',
      DB_HOST: mssqlTarget.host,
      DB_PORT: String(mssqlTarget.port),
      DB_NAME: mssqlTarget.db,
      DB_USER: mssqlTarget.user,
      DB_PASS: mssqlTarget.pass,
      DB_ENCRYPT: mssqlTarget.encrypt ? 'true' : 'false',
      DB_POOL_MAX: '10',
      ISOLATED_DB_PATH: `mssql:${mssqlTarget.host}:${mssqlTarget.port}/${mssqlTarget.db}`,
    });
  } else {
    Object.assign(env, {
      NODE_ENV: 'development',
      DB_TYPE: 'sqlite',
      DB_PATH: dbPath,
      ISOLATED_DB_PATH: dbPath,
      ISOLATED_MSSQL: '0',
    });
  }
  // 套件级覆盖（如 PERF_DB_PATH 指向本次临时库）；先做 __DB_PATH__ 占位替换，避免误指正式库。
  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = String(value).replace(/__DB_PATH__/g, dbPath).replace(/__ARTIFACT_DIR__/g, artifactDir);
  }
  return { env, dbPath, base, port, artifactDir };
}

function runNode(script, { cwd, env, timeoutMs = 300000, label = path.basename(script) } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({
        label,
        code,
        signal,
        timedOut,
        ms: Date.now() - started,
        stdout,
        stderr,
        output: `${stdout}\n${stderr}`.trim(),
      });
    });
  });
}

function waitHealthy(baseUrl, server, logPath) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const attempt = () => {
      if (server.exitCode !== null) {
        reject(new Error(`隔离 API 提前退出 code=${server.exitCode}；日志: ${logPath}`));
        return;
      }
      const req = http.get(`${baseUrl}/health`, { timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`隔离 API 60 秒未就绪；日志: ${logPath}`));
        return;
      }
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

async function cleanupTempDir(tempDir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    } catch { /* 文件可能仍被句柄占用，稍后重试 */ }
    if (!fs.existsSync(tempDir)) return true;
    await sleep(250);
  }
  return !fs.existsSync(tempDir);
}

function verifyFixtures(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const scalar = (sql) => Number(db.prepare(sql).get().n);
    const users = scalar('SELECT COUNT(*) AS n FROM t_user');
    const tenants = scalar('SELECT COUNT(*) AS n FROM t_tenant');
    const ruleSets = scalar('SELECT COUNT(*) AS n FROM t_rule_set');
    const seededStations = scalar(
      "SELECT COUNT(*) AS n FROM t_station WHERE station_id IN ('L01-ST01','L02-ST01')",
    );
    const elements = scalar("SELECT COUNT(*) AS n FROM t_element WHERE station_id = 'L01-ST01'");
    if (users < 5) throw new Error(`夹具用户不足: ${users}`);
    if (tenants < 2) throw new Error(`夹具租户不足: ${tenants}`);
    if (ruleSets < 6) throw new Error(`夹具规则集不足: ${ruleSets}`);
    if (seededStations !== 2) throw new Error(`关键工位缺失: 期望 2，实际 ${seededStations}`);
    if (elements < 1) throw new Error('L01-ST01 要素缺失');
    return { users, tenants, ruleSets, seededStations, elements };
  } finally {
    db.close();
  }
}

function applyExtraFixtures(dbPath, statements = []) {
  if (!statements.length) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    for (const sql of statements) db.exec(sql);
    console.log(`隔离额外夹具: 已执行 ${statements.length} 条 SQL`);
  } finally {
    db.close();
  }
}

function parseResult(output) {
  const summary = /结果[：:]\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(output);
  const matrix = /权限矩阵:\s*(\d+)\/(\d+)\s*通过/.exec(output);
  const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
  let pass = summary ? Number(summary[1]) : null;
  let fail = summary ? Number(summary[2]) : null;
  if (matrix) {
    pass = Number(matrix[1]);
    fail = Number(matrix[2]) - Number(matrix[1]);
  }
  return {
    pass,
    fail,
    port: port ? Number(port[1]) : null,
  };
}

async function runIteration(options, index) {
  const {
    suite, script, mode, extraSql, env: extraEnv = {}, prepare = [], dbFileName = 'isolated.db',
    datasource = 'sqlite', mssqlCleanupSql = [], mssqlRunWindowCleanupSql = [],
  } = options;
  const useMssql = datasource === 'mssql';
  const target = useMssql ? resolveMssqlTarget() : null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ie-iso-${suite}-`));
  activeTempDir = tempDir;
  const port = await findFreePort();
  const { env, dbPath, base } = buildEnv(tempDir, port, extraEnv, dbFileName, target);
  const logPath = path.join(tempDir, 'api.log');
  // 本轮开始时间（UTC，DATETIME2 口径）：收尾清理只删除本轮产生的行。
  const runStartUtc = new Date().toISOString().replace('T', ' ').replace('Z', '');
  let server = null;
  let cleaned = false;
  let result = null;
  let residue = null;
  let mssqlError = null;
  try {
    console.log(`\n[${suite} run ${index}] 临时目录: ${tempDir}`);
    console.log(useMssql
      ? `[${suite} run ${index}] 数据源: mssql ${target.host}:${target.port}/${target.db}（user=${target.user}，口令不打印）`
      : `[${suite} run ${index}] 数据源: sqlite ${dbPath}；端口: ${port}`);

    let fixtures;
    if (useMssql) {
      // 1) 先清理上一轮可能残留的夹具（幂等；首轮表不存在则跳过）
      await runMssqlCleanup(target, mssqlCleanupSql, null, `${suite} run ${index} 预清理`);
      // 2) 建表只走既有 migrate（幂等 DDL；不建库、不 DROP DATABASE）
      const migrate = await runNode(path.join(API_DIR, 'dist/scripts/migrate.js'), {
        cwd: tempDir, env, label: 'migrate',
      });
      if (migrate.code !== 0) throw new Error(`MSSQL 迁移失败:\n${migrate.output}`);
      console.log(`[${suite} run ${index}] ${migrate.output.trim().split('\n').slice(-1)[0]}`);
      // 3) seed（NODE_ENV=production → TypeORM synchronize=false，只写数据不改结构）
      const seed = await runNode(path.join(API_DIR, 'dist/scripts/seed.js'), {
        cwd: tempDir, env, label: 'seed',
      });
      if (seed.code !== 0) throw new Error(`MSSQL seed 失败:\n${seed.output}`);
      fixtures = await verifyFixturesMssql(target);
      if (extraSql.length) await applyExtraFixturesMssql(target, extraSql);
    } else {
      const schema = await runNode(path.join(__dirname, 'isolated-schema.cjs'), {
        cwd: tempDir, env, label: 'schema',
      });
      if (schema.code !== 0) throw new Error(`隔离建表失败:\n${schema.output}`);

      const seed = await runNode(path.join(API_DIR, 'dist/scripts/seed.js'), {
        cwd: tempDir, env, label: 'seed',
      });
      if (seed.code !== 0) throw new Error(`隔离 seed 失败:\n${seed.output}`);

      fixtures = verifyFixtures(dbPath);
      applyExtraFixtures(dbPath, extraSql);
    }
    console.log(
      `[${suite} run ${index}] 夹具校验: users=${fixtures.users} tenants=${fixtures.tenants} `
      + `ruleSets=${fixtures.ruleSets} stations=${fixtures.seededStations} elements=${fixtures.elements}`,
    );

    for (const step of prepare) {
      const prepared = await runNode(
        path.isAbsolute(step.script) ? step.script : path.resolve(API_DIR, step.script),
        { cwd: tempDir, env, label: `prepare:${step.name ?? path.basename(step.script)}` },
      );
      if (prepared.code !== 0) throw new Error(`隔离预处理失败（${step.name ?? step.script}）:\n${prepared.output}`);
      console.log(`[${suite} run ${index}] 预处理完成: ${step.name ?? step.script}`);
    }

    if (mode === 'api') {
      const logFd = fs.openSync(logPath, 'a');
      server = spawn(process.execPath, [path.join(API_DIR, 'dist/src/main.js')], {
        cwd: tempDir,
        env,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      fs.closeSync(logFd);
      activeChildren.add(server);
      await waitHealthy(base, server, logPath);
      console.log(`[${suite} run ${index}] 隔离 API 就绪: ${base}（${useMssql ? target.db : 'sqlite'}）`);
    }

    const run = await runNode(script, { cwd: tempDir, env, label: suite });
    const parsed = parseResult(run.output);
    console.log(
      `[${suite} run ${index}] exit=${run.code} 通过=${parsed.pass ?? 'n/a'} `
      + `失败=${parsed.fail ?? 'n/a'} 用例端口=${parsed.port ?? 'n/a'} 耗时=${run.ms}ms`,
    );
    if (run.code !== 0 || (parsed.fail !== null && parsed.fail > 0)) {
      console.error(`\n--- ${suite} run ${index} 输出（末 60 行）---`);
      console.error(run.output.split('\n').slice(-60).join('\n'));
    }
    result = {
      index,
      code: run.code,
      pass: parsed.pass,
      fail: parsed.fail,
      suitePort: parsed.port,
      apiPort: port,
      dbPath: useMssql ? `mssql:${target.host}:${target.port}/${target.db}` : dbPath,
      tempDir,
      ms: run.ms,
      output: run.output,
    };
  } finally {
    await stopServer(server);
    if (server) activeChildren.delete(server);
    if (useMssql && target) {
      // 先停 API（连接池已释放）再清理；收尾清理失败必须显式失败，不能静默留下脏数据。
      try {
        const post = await runMssqlCleanup(
          target,
          [...mssqlCleanupSql, ...mssqlRunWindowCleanupSql],
          runStartUtc,
          `${suite} run ${index} 收尾清理`,
        );
        residue = await mssqlResidue(target);
        console.log(`[${suite} run ${index}] 残留核对: ${JSON.stringify(residue)}`);
        if (result) result.mssqlCleanup = post;
      } catch (e) {
        mssqlError = e;
        if (result) result.mssqlCleanupError = e.message;
        console.error(`[${suite} run ${index}] MSSQL 收尾清理失败: ${e.message}`);
      }
    }
    cleaned = await cleanupTempDir(tempDir);
    console.log(
      `[${suite} run ${index}] 清理: ${cleaned ? 'PASS（临时目录已删除）' : 'FAIL（残留 ' + tempDir + '）'}`,
    );
    if (activeTempDir === tempDir) activeTempDir = null;
  }
  // 收尾清理失败：套件本身已成功时才向上升级为失败（避免掩盖套件的原始错误）。
  if (mssqlError) throw mssqlError;
  if (result && residue) result.residue = residue;
  if (!cleaned) {
    const err = new Error(`临时目录残留: ${tempDir}`);
    err.tempDir = tempDir;
    throw err;
  }
  return result;
}

async function runIsolated(options) {
  const opts = {
    suite: 'suite',
    script: '',
    mode: 'in-process',
    repeat: 2,
    ...options,
  };
  if (!opts.script) throw new Error('缺少 --script');
  opts.script = path.isAbsolute(opts.script) ? opts.script : path.resolve(API_DIR, opts.script);
  if (!fs.existsSync(opts.script)) throw new Error(`套件脚本不存在: ${opts.script}`);
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat 必须 >= 1');
  const useMssql = opts.datasource === 'mssql';

  // 数据源前置校验：无 ISO_MSSQL_* 时明确拒绝（返回 SKIPPED，不是 PASS）；
  // 指向生产库/系统库/无测试标记的库名时直接抛错（硬失败）。
  if (useMssql) {
    try {
      resolveMssqlTarget();
    } catch (e) {
      if (e.code === 'MSSQL_CONFIG_MISSING') {
        console.log('='.repeat(72));
        console.log(`隔离回归: ${opts.suite}  mode=${opts.mode}  数据源=mssql → SKIPPED`);
        console.log(e.message);
        console.log('='.repeat(72));
        return {
          suite: opts.suite, mode: opts.mode, repeat: opts.repeat,
          results: [], consistent: true, cleanupOk: true,
          skipped: true, skipReason: e.message, success: false,
        };
      }
      throw e;
    }
  }

  console.log('='.repeat(72));
  console.log(`隔离回归: ${opts.suite}  mode=${opts.mode}  repeat=${opts.repeat}  数据源=${useMssql ? 'mssql' : 'sqlite'}`);
  console.log(`套件脚本: ${opts.script}`);
  console.log(useMssql
    ? '说明: 专用测试库（migrate 幂等建表 + 每轮按夹具范围清理，不建库、不 DROP DATABASE）；cwd 指向临时目录'
    : '说明: 每遍独立临时 SQLite；不读取正式库连接信息；cwd 指向临时目录');
  console.log('='.repeat(72));

  const results = [];
  for (let i = 1; i <= opts.repeat; i += 1) {
    try {
      const result = await runIteration(opts, i);
      results.push(result);
    } catch (e) {
      console.error(`\n[${opts.suite} run ${i}] 失败: ${e.message}`);
      results.push({
        index: i,
        code: 1,
        pass: null,
        fail: null,
        error: e.message,
        tempDir: e.tempDir || null,
      });
    }
  }

  // 有计数时比通过/失败数；无计数（UI 套件只报 PASS/FAIL）时退化为比退出码。
  const signature = (r) => (r.pass !== null ? `${r.pass}/${r.fail}` : `exit=${r.code}`);
  const consistent = results.length > 0 && results.every((r) => signature(r) === signature(results[0]));
  // MSSQL 模式额外比对「收尾清理后的表行数基线」：三遍必须完全一致才算无累积残留。
  const residueSig = (r) => (r.residue
    ? Object.entries(r.residue).sort().map(([k, v]) => `${k}=${v}`).join(',')
    : 'n/a');
  const residueConsistent = !useMssql
    || (results.length > 0 && results.every((r) => r.residue && residueSig(r) === residueSig(results[0])));
  const allGreen = results.every((r) => r.code === 0 && (r.fail === null || r.fail === 0));
  const dirsRemoved = results.every((r) => !r.tempDir || !fs.existsSync(r.tempDir));
  const cleanupOk = dirsRemoved;

  console.log('\n' + '-'.repeat(72));
  console.log(`结果汇总: ${opts.suite}`);
  for (const r of results) {
    console.log(
      `  第 ${r.index} 遍: exit=${r.code} 通过=${r.pass ?? 'n/a'} 失败=${r.fail ?? 'n/a'} `
      + `casePort=${r.suitePort ?? 'n/a'} apiPort=${r.apiPort ?? 'n/a'}`,
    );
    if (useMssql && r.residue) console.log(`         残留基线: ${residueSig(r)}`);
  }
  console.log(`  一致性: ${consistent ? 'PASS' : 'FAIL'}（各遍通过/失败数相同）`);
  if (useMssql) console.log(`  残留一致性: ${residueConsistent ? 'PASS' : 'FAIL'}（各遍清理后表行数基线相同）`);
  console.log(`  清理: ${dirsRemoved && cleanupOk ? 'PASS' : 'FAIL'}（临时目录均不存在）`);
  console.log(`  总判定: ${allGreen && consistent && dirsRemoved && cleanupOk && residueConsistent ? 'PASS' : 'FAIL'}`);
  console.log('-'.repeat(72));

  return {
    suite: opts.suite,
    mode: opts.mode,
    repeat: opts.repeat,
    results,
    consistent,
    residueConsistent,
    cleanupOk: dirsRemoved && cleanupOk,
    success: allGreen && consistent && dirsRemoved && cleanupOk && residueConsistent,
  };
}

for (const sig of ACTIVE_SIGNALS) {
  process.once(sig, () => {
    for (const child of activeChildren) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    if (activeTempDir) {
      try { fs.rmSync(activeTempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* ignore */ }
    }
    process.exit(130);
  });
}

process.once('uncaughtException', (err) => {
  console.error('隔离启动器异常:', err);
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  if (activeTempDir) {
    try { fs.rmSync(activeTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(1);
});

module.exports = { runIsolated, findFreePort };

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const repeat = Number(value('repeat', '2'));
  runIsolated({
    suite: value('suite', 'suite'),
    script: value('script', ''),
    mode: value('mode', 'in-process'),
    datasource: value('datasource', 'sqlite'),
    repeat,
  }).then((summary) => {
    if (summary.skipped) console.error(`\n${summary.suite}: 已拒绝运行（SKIPPED，非 PASS）——${summary.skipReason.split('\n')[0]}`);
    process.exitCode = summary.success ? 0 : 1;
  }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
