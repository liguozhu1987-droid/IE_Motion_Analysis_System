/**
 * 隔离回归批量入口。
 *
 *   node test/isolated-run.cjs                 # 跑已迁移的全部套件
 *   node test/isolated-run.cjs smoke            # 只跑指定套件
 *   node test/isolated-run.cjs --repeat 2 名字   # 自定义遍数
 *
 * 数据源按套件选择：默认独立临时 SQLite；吃 MSSQL 方言的套件（acl-read-guard）
 * 通过 datasource:'mssql' 指向 ISO_MSSQL_* 专用测试库，无配置时明确 SKIPPED（不是 PASS）。
 * 结束后统一核对正式开发库与 uploads/storage 指纹未变化。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runIsolated } = require('./isolated-harness.cjs');

const API_DIR = path.resolve(__dirname, '..');
const DEV_DB = path.join(API_DIR, 'data', 'ie.db');
const STORAGE_DIR = path.join(API_DIR, 'storage');

/** 已迁移套件清单：mode=api 表示由基座拉起独立端口 API；in-process 由套件自己建应用。 */
const SUITES = {
  smoke: {
    script: 'dist/test/smoke.js',
    mode: 'in-process',
    // seed 默认 data_scope=own；smoke 的反向隔离用例要求 other1 为 tenant（历史正式库口径）。
    extraSql: ["UPDATE t_user SET data_scope = 'tenant' WHERE user_id = 'u_other1'"],
  },
  'dashboard-contract': { script: 'test/dashboard-contract.js', mode: 'api' },
  'settings-contract': { script: 'test/settings-contract.js', mode: 'api' },
  'auth-management-flow': { script: 'test/auth-management-flow.js', mode: 'api' },
  'acl-read-guard': {
    script: 'test/test-acl-read-guard.cjs',
    mode: 'api',
    // 该套件覆盖的共享工位接口走 stations.service 的 MSSQL 专有 MERGE/SYSUTCDATETIME，
    // SQLite 下会 500；故只把它指向专用测试库（ISO_MSSQL_*）。
    // 无 ISO_MSSQL_* 时基座明确拒绝运行并报 SKIPPED（不是 PASS）；库名为 CN_AME/生产库则硬失败。
    datasource: 'mssql',
    // 已知夹具范围：产线 L97 / 工位 L97-ST01 / 改善任务 IMP-ACL-*。
    // 每轮跑前跑后各执行一次（幂等）；视频登记表用 __RUN_START__ 占位（跑前清历史残留，跑后只删本轮）。
    mssqlCleanupSql: [
      "DELETE FROM t_ai_waste_issue WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_ai_waste_finding WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_ai_waste_batch WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_ai_suggestion WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_ai_suggestion_batch WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_improvement WHERE station_id = 'L97-ST01' OR imp_id LIKE 'IMP-ACL-%'",
      "DELETE FROM t_element WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_station_collaborator WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_station WHERE station_id = 'L97-ST01'",
      "DELETE FROM t_line_share WHERE line_id = 'L97'",
      "DELETE FROM t_refresh_token",
      "DELETE FROM t_line WHERE line_id = 'L97'",
      "DELETE FROM t_video_asset WHERE created_at >= '__RUN_START__'",
      "UPDATE t_user SET data_scope = 'own' WHERE user_id IN ('u_ie1','u_viewer1')",
    ],
    // 收尾只删本轮产生的审计行（审计是追加日志，不删除历史）
    mssqlRunWindowCleanupSql: [
      "DELETE FROM t_audit_log WHERE created_at >= '__RUN_START__'",
    ],
  },
  'acl-line-scope': { script: 'test/test-acl-line-scope.cjs', mode: 'api' },
  'rbac-v358': { script: 'test/test-rbac-v358.cjs', mode: 'api' },
  'permission-matrix': { script: 'test/permission-matrix.cjs', mode: 'api' },
  'ai-suggest-source': { script: 'test/ai-suggest-source-contract.cjs', mode: 'in-process' },
  'workbench-segment-stop': {
    script: 'test/workbench-segment-stop.cjs',
    mode: 'api',
    // performance-dataset 的安全守卫要求临时库名为 gate-performance.db，故本套件沿用该名。
    dbFileName: 'gate-performance.db',
    // 该套件要求隔离标记 + 临时库；端口不再写死 3102，由基座分配。
    env: { PERF_ISOLATED: '1', PERF_DB_PATH: '__DB_PATH__' },
    // 200 工位/4000 要素基准夹具（会先清空临时库内的工位，只对本次临时库生效）。
    prepare: [{ name: 'performance-dataset', script: 'test/performance-dataset.cjs' }],
  },
};

function fileFingerprint(file) {
  if (!fs.existsSync(file)) return 'absent';
  const stat = fs.statSync(file);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  return `${stat.size}|${stat.mtimeMs}|${hash}`;
}

function treeFingerprint(dir) {
  if (!fs.existsSync(dir)) return 'absent';
  const rows = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else rows.push(`${path.relative(dir, full).replace(/\\/g, '/')}|${fs.statSync(full).size}`);
    }
  };
  walk(dir);
  rows.sort();
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
}

function parseArgs(argv) {
  const names = [];
  let repeat = 2;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repeat' && argv[i + 1]) {
      repeat = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--all') {
      // 显式全量（默认即全量）
    } else {
      names.push(argv[i]);
    }
  }
  const chosen = names.length ? names : Object.keys(SUITES);
  for (const name of chosen) {
    if (!SUITES[name]) throw new Error(`未登记的隔离套件: ${name}（可用: ${Object.keys(SUITES).join(', ')}）`);
  }
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat 必须 >= 1');
  return { chosen, repeat };
}

(async () => {
  const { chosen, repeat } = parseArgs(process.argv.slice(2));
  const beforeDb = fileFingerprint(DEV_DB);
  const beforeStorage = treeFingerprint(STORAGE_DIR);

  console.log(`批量隔离回归: ${chosen.length} 套，每套 ${repeat} 遍`);
  console.log(`正式开发库存量指纹: ${beforeDb}`);
  console.log(`uploads/storage 指纹: ${beforeStorage}`);

  const rows = [];
  for (const name of chosen) {
    const options = { suite: name, repeat, ...SUITES[name] };
    let summary;
    try {
      summary = await runIsolated(options);
    } catch (e) {
      console.error(`[${name}] 启动失败: ${e.message}`);
      summary = { suite: name, mode: SUITES[name].mode, repeat, results: [], consistent: false, cleanupOk: false, success: false };
    }
    rows.push({ name, mode: summary.mode, summary });
  }

  const afterDb = fileFingerprint(DEV_DB);
  const afterStorage = treeFingerprint(STORAGE_DIR);
  const devDbUntouched = beforeDb === afterDb;
  const storageUntouched = beforeStorage === afterStorage;

  console.log('\n' + '='.repeat(78));
  console.log('批量隔离回归汇总');
  console.log('='.repeat(78));
  console.log('套件'.padEnd(24) + '模式'.padEnd(12) + '各遍通过/失败'.padEnd(30) + '一致   清理');
  for (const { name, mode, summary } of rows) {
    const runs = summary.skipped
      ? 'SKIPPED（已拒绝运行）'
      : summary.results.map((r) => (r.pass !== null ? `${r.pass}/${r.fail}` : `exit=${r.code}`)).join(' , ');
    console.log(
      name.padEnd(24) + String(mode).padEnd(12) + (runs || 'n/a').padEnd(30)
      + `${summary.consistent ? 'PASS' : 'FAIL'}`.padEnd(7) + `${summary.cleanupOk ? 'PASS' : 'FAIL'}`,
    );
  }
  const skipped = rows.filter((r) => r.summary.skipped);
  console.log('-'.repeat(78));
  console.log(`正式开发库 data/ie.db: ${devDbUntouched ? 'PASS（未变化）' : 'FAIL（已被写入）'}`);
  console.log(`uploads/storage: ${storageUntouched ? 'PASS（未变化）' : 'FAIL（已被写入）'}`);
  console.log('正式 SQL Server(CN_AME): 未连接（sqlite 套件已剔除 DB_*；mssql 套件只认 ISO_MSSQL_* 专用测试库并做库名黑名单校验）');
  if (skipped.length) {
    console.log(`未执行（SKIPPED，非 PASS）: ${skipped.map((r) => r.name).join(', ')}`);
    console.log(`  原因: ${skipped[0].summary.skipReason.split('\n')[0]}`);
  }
  // SKIPPED 不计入通过，也不拉低总判定；但必须至少有一个套件真正执行。
  const executed = rows.filter((r) => !r.summary.skipped);
  const allPass = executed.length > 0 && executed.every((r) => r.summary.success);
  const nothingExecuted = executed.length === 0;
  if (nothingExecuted) {
    console.log('总判定: SKIPPED（选中的套件全部未执行，不计为 PASS）');
    process.exitCode = 0;
  } else {
    console.log(`总判定: ${allPass && devDbUntouched && storageUntouched ? 'PASS' : 'FAIL'}`);
    process.exitCode = allPass && devDbUntouched && storageUntouched ? 0 : 1;
  }
})().catch((e) => {
  console.error('批量隔离回归异常:', e);
  process.exitCode = 1;
});
