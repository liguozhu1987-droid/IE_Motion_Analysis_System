/**
 * 回归脚本用的最小 DB 客户端：同一份 SQL 既能在 mssql（正式库手工复跑）执行，
 * 也能在隔离临时 SQLite 执行。
 *
 * 约定：SQL 用 `@p0`、`@p1`… 命名参数；`GETDATE()` 由本模块在 sqlite 下降级为
 * `datetime('now')`。其它方言差异（TOP/LIMIT）由调用方按 cfg.dbType 分支。
 */
const { loadConfig } = require('../dist/src/core/config/configuration.js');

const cfg = loadConfig();
let sqliteDb = null;

function sqlite() {
  if (!sqliteDb) {
    const { DatabaseSync } = require('node:sqlite');
    sqliteDb = new DatabaseSync(cfg.dbPath);
    // API 进程同时持有同一个临时库；等待写锁释放而不是立即抛 database is locked。
    sqliteDb.exec('PRAGMA busy_timeout = 5000');
  }
  return sqliteDb;
}

function toSqliteSql(sql) {
  return sql
    .replace(/GETDATE\(\)/gi, "datetime('now')")
    .replace(/@p(\d+)/g, '?');
}

async function connectMssql() {
  const mssql = require('mssql');
  return mssql.connect({
    server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
    options: { encrypt: cfg.dbEncrypt, trustServerCertificate: true },
  });
}

async function dbQuery(sql, params = []) {
  if (cfg.dbType === 'sqlite') {
    return sqlite().prepare(toSqliteSql(sql)).all(...params);
  }
  const pool = await connectMssql();
  try {
    const request = pool.request();
    params.forEach((value, i) => request.input(`p${i}`, value));
    return (await request.query(sql)).recordset;
  } finally {
    await pool.close();
  }
}

async function dbExec(sql, params = []) {
  if (cfg.dbType === 'sqlite') {
    sqlite().prepare(toSqliteSql(sql)).run(...params);
    return [];
  }
  return dbQuery(sql, params);
}

module.exports = { cfg, dbQuery, dbExec, isSqlite: cfg.dbType === 'sqlite' };
