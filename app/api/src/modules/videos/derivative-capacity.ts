import * as fs from 'fs';
import * as path from 'path';

/**
 * 视频派生容量参数（P0-1）——单一事实来源。
 *
 * 项目铁律：不猜数字。现场未确认的参数（磁盘预算、转码并发、超时）一律不写死成"生效配置"：
 *  - 缺失/非法 → 返回 null 或保守默认，并由 worker 在启动期显式 warn；
 *  - `/api/videos/storage` 回显 configured 标记，运维能一眼看出"参数还没配"；
 *  - 只有用户显式写入 .env 的值才作为阈值参与告警/淘汰。
 */
export interface CapacityConfig {
  /** 派生目录上限（GB）；null = 未配置或非法 → 磁盘治理整体关闭 */
  maxGb: number | null;
  maxGbRaw: string;
  maxGbConfigured: boolean;
  /** 转码并发数；未配置时为保守默认 2（启动期告警要求现场确认） */
  concurrency: number;
  concurrencyConfigured: boolean;
  concurrencyRaw: string;
  /** 单任务 ffmpeg 超时（分钟）；未配置时保守默认 30 */
  deriveTimeoutMin: number;
  deriveTimeoutConfigured: boolean;
  /** running 行无更新判定超时（分钟）；默认 30，用于进程崩溃后的僵尸任务回收 */
  staleRunMin: number;
  /** 磁盘治理 du 周期（秒），最小 10 */
  duSec: number;
  /** 孤儿派生行巡检（1=开）；默认关，防共享存储瞬时不可见时误删 */
  orphanSweep: boolean;
  /** 上传后自动派生；默认开（VIDEO_AUTO_DERIVE=0 关闭） */
  autoDerive: boolean;
  /** 源视频保留天数；未配置时默认 10（启动期告警要求现场确认） */
  retentionDays: number;
  retentionDaysConfigured: boolean;
  retentionDaysRaw: string;
  /** 到期前提前通知天数；未配置时默认 3 */
  noticeDays: number;
  noticeDaysConfigured: boolean;
  noticeDaysRaw: string;
  /** 通知失败后的重试冷却（小时），默认 24；成功通知不重复发送 */
  notifyRetryHours: number;
  notifyRetryConfigured: boolean;
  notifyRetryRaw: string;
}

/** 正数解析：空串/非数字/<=0 一律视为"未配置" */
function positive(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function loadCapacityConfig(env: NodeJS.ProcessEnv = process.env): CapacityConfig {
  const maxGbRaw = (env.VIDEO_DERIVED_MAX_GB ?? '').trim();
  const maxGb = positive(maxGbRaw);
  const concRaw = (env.VIDEO_DERIVE_CONCURRENCY ?? '').trim();
  const conc = positive(concRaw);
  const timeoutRaw = (env.VIDEO_DERIVE_TIMEOUT_MIN ?? '').trim();
  const timeout = positive(timeoutRaw);
  const staleRaw = (env.VIDEO_RUNNING_STALE_MIN ?? '').trim();
  const duRaw = (env.VIDEO_DERIVED_DU_SEC ?? '').trim();
  const retentionRaw = (env.VIDEO_RETENTION_DAYS ?? '').trim();
  const retention = positive(retentionRaw);
  const noticeRaw = (env.VIDEO_RETENTION_NOTICE_DAYS ?? '').trim();
  const notice = positive(noticeRaw);
  const retryRaw = (env.VIDEO_RETENTION_NOTIFY_RETRY_HOURS ?? '').trim();
  const retry = positive(retryRaw);
  return {
    maxGb,
    maxGbRaw,
    maxGbConfigured: maxGb != null,
    concurrency: Math.max(1, Math.floor(conc ?? 2)),
    concurrencyConfigured: conc != null,
    concurrencyRaw: concRaw,
    deriveTimeoutMin: Math.floor(timeout ?? 30),
    deriveTimeoutConfigured: timeout != null,
    staleRunMin: Math.floor(positive(staleRaw) ?? 30),
    duSec: Math.max(10, Math.floor(positive(duRaw) ?? 60)),
    orphanSweep: (env.VIDEO_ORPHAN_SWEEP ?? '') === '1',
    autoDerive: (env.VIDEO_AUTO_DERIVE ?? '1') !== '0',
    retentionDays: Math.floor(retention ?? 10),
    retentionDaysConfigured: retention != null,
    retentionDaysRaw: retentionRaw,
    noticeDays: Math.floor(notice ?? 3),
    noticeDaysConfigured: notice != null,
    noticeDaysRaw: noticeRaw,
    notifyRetryHours: Math.floor(retry ?? 24),
    notifyRetryConfigured: retry != null,
    notifyRetryRaw: retryRaw,
  };
}

/** 目录字节数（du；不跟符号链接，单项失败跳过） */
export function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) total += dirBytes(p);
        else if (st.isFile()) total += st.size;
      } catch { /* 单项失败跳过 */ }
    }
  } catch { /* 目录不可读按 0 计 */ }
  return total;
}

/**
 * 磁盘治理运行时状态：已迁到 core/alert/alert-runtime.ts（P0-4 统一告警状态源）。
 * 此处保留 re-export，避免既有调用方（derivative.service / derivative-worker）大改。
 */
export { diskGuardRuntime } from '../../core/alert/alert-runtime';
