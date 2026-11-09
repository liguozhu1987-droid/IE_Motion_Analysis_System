/**
 * W2 固定容量数据：200 工位 × 20 要素，只写 PERF_DB_PATH 指向的临时 SQLite。
 * 数据由确定性公式生成，不调用 API、不连接 .env 的 SQL Server。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.PERF_DB_PATH || '';
const OUT_DIR = process.env.ISOLATED_ARTIFACT_DIR || path.resolve(__dirname, '../../../deliverables');
const STATION_COUNT = 200;
const ELEMENTS_PER_STATION = 20;

function guard() {
  if (process.env.PERF_ISOLATED !== '1' || path.basename(DB_PATH) !== 'gate-performance.db' || !fs.existsSync(DB_PATH)) {
    throw new Error('容量数据只允许写入隔离启动器创建的 gate-performance.db');
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) => err ? reject(err) : resolve(db));
  });
}
function exec(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => err ? reject(err) : resolve()));
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
}
function get(db, sql) {
  return new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
}
function close(db) {
  return new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
}

(async () => {
  guard();
  const db = await connect();
  try {
    await exec(db, 'PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    // 这些 DELETE 只可能命中上面的临时 gate 数据库；清除 seed 演示行，保证容量口径精确。
    await run(db, 'DELETE FROM t_station_collaborator');
    await run(db, 'DELETE FROM t_element');
    await run(db, 'DELETE FROM t_station');
    await run(db, 'DELETE FROM t_line');
    await run(db,
      'INSERT INTO t_line (tenant_id,line_id,name,process_type,product_type,product_project) VALUES (?,?,?,?,?,?)',
      ['DEFAULT', 'LPERF', 'W2 固定容量线', '装配', '容量测试产品', 'P-PERF-200']);

    const stationSql = `INSERT INTO t_station (
      station_id,tenant_id,line_id,name,ct,tt,version,updated_by,updated_at,created_by,created_at,
      owner_user_id,program_number,cmc_line_id,roi,roi_zones,sop_steps
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const elementSql = `INSERT INTO t_element (
      element_id,tenant_id,station_id,seq,start_ms,dur_s,hand,type,desc,va_class,outlier_flag,
      outlier_reason,video_id,source,rating,allowance,std_time,bol_version,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const now = new Date('2026-10-30T00:00:00.000Z').toISOString();
    const types = ['拿取', '移物', '装配', '检查', '持住'];
    const vas = ['VA', 'RNVA', 'VA', 'RNVA', 'NVA'];
    for (let s = 1; s <= STATION_COUNT; s++) {
      const sid = `PF-ST${String(s).padStart(3, '0')}`;
      const durations = Array.from({ length: ELEMENTS_PER_STATION }, (_, i) => 1.5 + ((i + 1) % 5) * 0.25 + (s % 3) * 0.05);
      const ct = durations.reduce((sum, duration) => sum + Math.round(duration * 1.15 * 100) / 100, 0);
      // 先父行后要素，保持 SQLite 外键约束开启，避免用关约束换取造数成功。
      await run(db, stationSql, [
        sid, 'DEFAULT', 'LPERF', `容量工位 ${String(s).padStart(3, '0')}`, Math.round(ct * 100) / 100,
        60, 1, 'perf-gate', now, 'perf-gate', now, 'u_admin', 'P-PERF-200', null, null, null, null,
      ]);
      let start = 0;
      for (let seq = 1; seq <= ELEMENTS_PER_STATION; seq++) {
        const duration = durations[seq - 1];
        const std = Math.round(duration * 1.15 * 100) / 100;
        const type = types[(seq - 1) % types.length];
        await run(db, elementSql, [
          `${sid}-V1-${String(seq).padStart(3, '0')}`, 'DEFAULT', sid, seq, start, duration,
          ['L', 'R', 'B'][(seq - 1) % 3], type, `${type} 容量对象 ${String(seq).padStart(2, '0')}`,
          vas[(seq - 1) % vas.length], 0, null, null, 'manual', 1, 0.15, std, 1, now,
        ]);
        start += Math.round(duration * 1000);
      }
    }
    await run(db, 'UPDATE t_user SET must_change_pwd=0 WHERE username=?', ['admin']);
    await exec(db, 'COMMIT;');

    const stations = await get(db, "SELECT COUNT(*) AS n FROM t_station WHERE tenant_id='DEFAULT'");
    const elements = await get(db, "SELECT COUNT(*) AS n FROM t_element WHERE tenant_id='DEFAULT'");
    const lines = await get(db, "SELECT COUNT(*) AS n FROM t_line WHERE tenant_id='DEFAULT'");
    if (stations.n !== STATION_COUNT || elements.n !== STATION_COUNT * ELEMENTS_PER_STATION || lines.n !== 1) {
      throw new Error(`容量数据复核失败: ${JSON.stringify({ stations, elements, lines })}`);
    }
    const recipe = JSON.stringify({ STATION_COUNT, ELEMENTS_PER_STATION, duration: '1.5+(seq%5)*0.25+(station%3)*0.05', rating: 1, allowance: 0.15 });
    const report = {
      generated_at: new Date().toISOString(), database: 'temporary gate-performance.db',
      stations: stations.n, elements: elements.n, lines: lines.n,
      station_range: ['PF-ST001', 'PF-ST200'], fixture_sha256: crypto.createHash('sha256').update(recipe).digest('hex'),
    };
    fs.writeFileSync(path.join(OUT_DIR, 'PST-performance-dataset.json'), JSON.stringify(report, null, 2));
    console.log(`固定容量数据完成：${report.stations} 工位 / ${report.elements} 要素 / ${report.lines} 产线`);
  } catch (e) {
    try { await exec(db, 'ROLLBACK;'); } catch { /* 已提交或连接已断开 */ }
    throw e;
  } finally {
    await close(db);
  }
})().catch((e) => { console.error(e); process.exit(1); });
