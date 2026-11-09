import 'dotenv/config';
import 'reflect-metadata';
import { DataSource, LessThan } from 'typeorm';
import { loadConfig } from '../src/core/config/configuration';
import { typeOrmConfigFactory } from '../src/core/database/database.module';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 审计记录与应用日志的保留期清理（P0-3）。
 *
 * 用法：
 *   node dist/scripts/audit-retention.js                 # 干跑（默认，只统计不删除）
 *   node dist/scripts/audit-retention.js --apply         # 真正删除
 *   node dist/scripts/audit-retention.js --days=730      # 覆盖审计保留天数
 *   node dist/scripts/audit-retention.js --log-days=730  # 覆盖日志文件保留天数
 *   node dist/scripts/audit-retention.js --max-batches=20
 *
 * 配置：AUDIT_RETENTION_DAYS（默认 730）/ LOG_RETENTION_DAYS（默认同审计）/ AUDIT_RETENTION_BATCH（默认 5000）
 * 安全：默认干跑；只有显式 --apply 才删除。每轮批删，避免长事务锁表。
 * 可观测：每次执行结果同时写 stdout 与 LOG_DIR/audit-retention.log（JSON 行，带时间戳）。
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function argOf(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
}
function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const APPLY = process.argv.includes('--apply');
const AUDIT_DAYS = posInt(argOf('days') ?? process.env.AUDIT_RETENTION_DAYS, 730);
const LOG_DAYS = posInt(argOf('log-days') ?? process.env.LOG_RETENTION_DAYS, AUDIT_DAYS);
const BATCH = posInt(process.env.AUDIT_RETENTION_BATCH, 5000);
const MAX_BATCHES = posInt(argOf('max-batches'), 0); // 0 = 不限制

const cfg = loadConfig();
const auditCutoff = new Date(Date.now() - AUDIT_DAYS * DAY_MS);
const logCutoff = new Date(Date.now() - LOG_DAYS * DAY_MS);
const retentionLogFile = path.join(cfg.logDir, 'audit-retention.log');

interface Summary {
  ts: string;
  dry_run: boolean;
  db_type: string;
  audit_days: number;
  audit_cutoff: string;
  audit_deleted: number;
  audit_remaining: number;
  log_days: number;
  log_files_deleted: number;
  log_bytes_deleted: number;
  batches: number;
  ok: boolean;
  error?: string;
}

function writeRetentionLog(sum: Summary): void {
  try {
    fs.mkdirSync(cfg.logDir, { recursive: true });
    fs.appendFileSync(retentionLogFile, `${JSON.stringify(sum)}\n`, 'utf8');
  } catch (e) {
    console.error(`保留清理日志写入失败: ${(e as Error).message}`);
  }
}

/** 只清理 LOG_DIR 内部的文件，且排除本次运行的清理日志本身 */
function cleanupLogFiles(): { files: number; bytes: number } {
  const root = path.resolve(cfg.logDir);
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!/\.(log|ndjson)(\.\d+|\.gz)?$/i.test(ent.name)) continue;
      if (path.resolve(full) === path.resolve(retentionLogFile)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtime >= logCutoff) continue;
      files += 1;
      bytes += st.size;
      if (APPLY) {
        try { fs.unlinkSync(full); } catch (e) { console.error(`日志删除失败 ${full}: ${(e as Error).message}`); }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

async function main(): Promise<Summary> {
  const ds = new DataSource(typeOrmConfigFactory(cfg));
  await ds.initialize();
  try {
    const repo = ds.getRepository('t_audit_log');
    const where = { created_at: LessThan(auditCutoff) };
    let deleted = 0;
    let batches = 0;

    if (!APPLY) {
      const remaining = await repo.count({ where });
      const logs = cleanupLogFiles();
      return {
        ts: new Date().toISOString(), dry_run: true, db_type: cfg.dbType,
        audit_days: AUDIT_DAYS, audit_cutoff: auditCutoff.toISOString(),
        audit_deleted: 0, audit_remaining: remaining,
        log_days: LOG_DAYS, log_files_deleted: logs.files, log_bytes_deleted: logs.bytes,
        batches: 0, ok: true,
      };
    }

    while (MAX_BATCHES === 0 || batches < MAX_BATCHES) {
      const rows = await repo.find({ select: ['log_id'], where, take: BATCH });
      if (rows.length === 0) break;
      const ids = rows.map((r: { log_id: string }) => r.log_id);
      const res = await repo.delete(ids);
      deleted += res.affected ?? ids.length;
      batches += 1;
      if (rows.length < BATCH) break;
    }
    const remaining = await repo.count({ where });
    const logs = cleanupLogFiles();
    return {
      ts: new Date().toISOString(), dry_run: false, db_type: cfg.dbType,
      audit_days: AUDIT_DAYS, audit_cutoff: auditCutoff.toISOString(),
      audit_deleted: deleted, audit_remaining: remaining,
      log_days: LOG_DAYS, log_files_deleted: logs.files, log_bytes_deleted: logs.bytes,
      batches, ok: true,
    };
  } finally {
    await ds.destroy();
  }
}

main()
  .then((sum) => {
    writeRetentionLog(sum);
    const mode = sum.dry_run ? 'DRY-RUN' : 'APPLY';
    console.log(`[audit-retention][${mode}] 审计天数=${sum.audit_days} 截止=${sum.audit_cutoff}`);
    console.log(`  审计待删/已删=${sum.audit_deleted} 剩余超期=${sum.audit_remaining} 批次=${sum.batches}`);
    console.log(`  日志天数=${sum.log_days} 文件=${sum.log_files_deleted} 字节=${sum.log_bytes_deleted}`);
    console.log(`  执行记录: ${retentionLogFile}`);
    if (sum.dry_run) console.log('  干跑模式：未删除任何数据；确认无误后加 --apply 执行');
  })
  .catch((e) => {
    const sum: Summary = {
      ts: new Date().toISOString(), dry_run: !APPLY, db_type: cfg.dbType,
      audit_days: AUDIT_DAYS, audit_cutoff: auditCutoff.toISOString(),
      audit_deleted: 0, audit_remaining: 0, log_days: LOG_DAYS, log_files_deleted: 0,
      log_bytes_deleted: 0, batches: 0, ok: false, error: (e as Error).message,
    };
    writeRetentionLog(sum);
    console.error('[audit-retention] 失败:', (e as Error).message);
    process.exitCode = 1;
  });
