import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * 数据层：单文件 SQLite（node:sqlite 内置，零依赖）。
 * 3 张表、16 字段要素表、"desc" 为保留字需引号；见《MVP系统架构设计》§3。
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS t_station (
  station_id TEXT PRIMARY KEY,
  line_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  CT         REAL NOT NULL DEFAULT 0,
  TT         REAL NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_station_line ON t_station(line_id);

CREATE TABLE IF NOT EXISTS t_element (
  element_id     TEXT PRIMARY KEY,
  station_id     TEXT NOT NULL REFERENCES t_station(station_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  start_ms       INTEGER NOT NULL CHECK (start_ms >= 0),
  dur_s          REAL NOT NULL CHECK (dur_s > 0),
  hand           TEXT NOT NULL CHECK (hand IN ('L','R','B')),
  type           TEXT NOT NULL CHECK (type IN ('装配','使用','取放','预对','检验','搬运','等待','寻找选择','持住','其他')),
  "desc"         TEXT NOT NULL,
  va_class       TEXT NOT NULL CHECK (va_class IN ('VA','NNVA','NVA')),
  outlier_flag   INTEGER NOT NULL DEFAULT 0 CHECK (outlier_flag IN (0,1)),
  outlier_reason TEXT,
  video_id       TEXT NOT NULL,
  rating         REAL NOT NULL DEFAULT 1.0 CHECK (rating >= 0.7 AND rating <= 1.25),
  allowance      REAL NOT NULL DEFAULT 0.15 CHECK (allowance >= 0.05 AND allowance <= 0.3),
  std_time       REAL NOT NULL CHECK (std_time >= 0),
  bol_version    INTEGER NOT NULL CHECK (bol_version >= 1),
  UNIQUE (station_id, bol_version, seq)
);
CREATE INDEX IF NOT EXISTS idx_element_station_version ON t_element(station_id, bol_version);
CREATE INDEX IF NOT EXISTS idx_element_station ON t_element(station_id);

CREATE TABLE IF NOT EXISTS t_improvement (
  imp_id      TEXT PRIMARY KEY,
  station_id  TEXT NOT NULL REFERENCES t_station(station_id) ON DELETE CASCADE,
  element_ids TEXT NOT NULL,
  waste_type  TEXT NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('E','C','R','S')),
  measure     TEXT NOT NULL,
  est_save_s  REAL NOT NULL DEFAULT 0,
  priority    REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT '待实施' CHECK (status IN ('待实施','已完成','已验证')),
  owner       TEXT,
  due         TEXT,
  before_ct   REAL,
  after_ct    REAL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imp_station_status ON t_improvement(station_id, status);
`;

let dbHandle;

export function openDb() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  dbHandle = new DatabaseSync(config.dbPath);
  dbHandle.exec(SCHEMA);
  log.info('数据库已就绪', { path: config.dbPath });
  return dbHandle;
}

export function getDb() {
  if (!dbHandle) throw new Error('数据库未初始化，请先调用 openDb()');
  return dbHandle;
}

export function closeDb() {
  if (dbHandle) {
    dbHandle.close();
    dbHandle = undefined;
  }
}

/** 事务包装：失败自动回滚（复测封存/提交流程必须原子） */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
