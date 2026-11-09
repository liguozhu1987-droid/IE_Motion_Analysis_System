import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { register } from 'prom-client';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AlertMailerService } from './mailer.service';
import {
  ALERT_RULE_CODES, tickRules, AlertSnapshot, AlertEvent, RuleThresholds, AlertRuleCode,
} from './alert-rules';
import { diskGuardRuntime } from './alert-runtime';
import { CapacityConfig, loadCapacityConfig } from '../../modules/videos/derivative-capacity';

interface RuleRuntimeState {
  firing: boolean;
  lastFireAt: number;
  lastEvent: (AlertEvent & { at: number }) | null;
  lastRecoveryAt: number;
  lastRecovery: (AlertEvent & { at: number }) | null;
}

function codeMap<T>(v: T): Record<AlertRuleCode, T> {
  return Object.fromEntries(ALERT_RULE_CODES.map((c) => [c, v])) as Record<AlertRuleCode, T>;
}

function runtimeMap(): Record<AlertRuleCode, RuleRuntimeState> {
  return Object.fromEntries(ALERT_RULE_CODES.map((c) => [c, {
    firing: false, lastFireAt: 0, lastEvent: null, lastRecoveryAt: 0, lastRecovery: null,
  }])) as Record<AlertRuleCode, RuleRuntimeState>;
}

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);

/**
 * 告警监控 worker（盘点第 3 类；P0-4 扩业务规则）。
 * 每 ALERT_CHECK_SEC（默认 60s）评估 6 条规则：
 *  运维级：登录锁定激增 / AI 任务堆积 / HTTP 错误率
 *  业务级：派生失败率 / AI 任务失败率 / 派生磁盘占用
 *
 * 输出：日志 warn（默认形态，零成本）+ 可选 SMTP 邮件（SMTP_HOST+ALERT_MAIL_TO 配了才发）。
 * 边沿触发 + 冷却（ALERT_COOLDOWN_MIN 默认 30min），不重复刷屏；恢复时记一条 info 并只发一次恢复通知。
 *
 * 阈值纪律：业务规则阈值未配置 = 规则关闭，启动期显式 warn，不暗设默认。
 * 磁盘规则复用 P0-1 的 VIDEO_DERIVED_MAX_GB 与 worker du 结果；本服务是唯一通知出口，
 * worker 不再重复发信（避免同一条件两封邮件）。
 */
@Injectable()
export class AlertMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AlertMonitor');
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private readonly thresholds: RuleThresholds;
  private readonly cooldownMs: number;
  private readonly checkSec: number;
  private readonly capacity: CapacityConfig;
  private firing = codeMap(false);
  private lastFireAt = codeMap(0);
  private readonly runtime = runtimeMap();
  private prevCounters: { httpTotal: number; httpError: number } | null = null;
  private lastSnapshot: AlertSnapshot | null = null;
  private lastMetrics: { windowErrorPct: number | null; deriveFailurePct: number | null; aiFailurePct: number | null } = {
    windowErrorPct: null, deriveFailurePct: null, aiFailurePct: null,
  };
  private lastCheckAt = 0;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly mailer: AlertMailerService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.capacity = loadCapacityConfig();
    this.thresholds = {
      loginLockedMax: cfg.alertLoginLockedMax,
      aiTaskBacklog: cfg.alertAiTaskBacklog,
      errorRatePct: cfg.alertErrorRatePct,
      errorMinRequests: cfg.alertErrorMinRequests,
      deriveFailPct: cfg.alertDeriveFailPct,
      aiFailPct: cfg.alertAiFailPct,
      failWindowMin: cfg.alertFailWindowMin,
      failMinSample: cfg.alertFailMinSample,
      derivedMaxGb: this.capacity.maxGb,
    };
    this.cooldownMs = cfg.alertCooldownMin * 60_000;
    this.checkSec = Math.max(10, Number(cfg.alertCheckSec ?? 60));
  }

  onModuleInit(): void {
    this.warnUnconfiguredBusiness();
    this.timer = setInterval(() => { void this.check(); }, this.checkSec * 1000);
    this.timer.unref?.();
    this.log.log(
      `告警监控已启动（每 ${this.checkSec}s；锁定≥${this.thresholds.loginLockedMax}／ai_task>${this.thresholds.aiTaskBacklog}／5xx≥${this.thresholds.errorRatePct}%；` +
      `业务规则=${this.activeBusinessRuleCount()}/3；邮件=${this.mailer.enabled ? '开' : '未配 SMTP，仅日志'}）`,
    );
    // 启动即评估一轮，避免 /api/alerts/status 在首个 tick 前为空窗
    void this.check();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 业务阈值未配置的启动期显式告警——项目铁律「不猜数字」的落地：
   * 不把未经现场确认的百分比伪装成生效配置，让运维在启动日志和 /api/alerts/status 看见缺口。
   */
  private warnUnconfiguredBusiness(): void {
    if (this.thresholds.deriveFailPct == null) {
      this.log.warn('ALERT_DERIVE_FAIL_PCT 未配置 → 派生失败率规则关闭（不暗设默认阈值；请按现场基线确认后配置）');
    }
    if (this.thresholds.aiFailPct == null) {
      this.log.warn('ALERT_AI_FAIL_PCT 未配置 → AI 任务失败率规则关闭（不暗设默认阈值；请按现场基线确认后配置）');
    }
    if (this.thresholds.failWindowMin == null || this.thresholds.failMinSample == null) {
      this.log.warn(
        'ALERT_FAIL_WINDOW_MIN / ALERT_FAIL_MIN_SAMPLE 未配置 → 两条失败率规则关闭'
        + '（统计窗口与最小样本均需显式配置，避免小样本误报）',
      );
    }
    if (this.thresholds.derivedMaxGb == null) {
      this.log.warn(
        'VIDEO_DERIVED_MAX_GB 未配置 → 派生磁盘占用规则关闭'
        + '（与 P0-1 磁盘治理同一阈值；未配置时 worker 不 du、不淘汰）',
      );
    }
  }

  private activeBusinessRuleCount(): number {
    let n = 0;
    if (this.thresholds.deriveFailPct != null && this.thresholds.failWindowMin != null && this.thresholds.failMinSample != null) n += 1;
    if (this.thresholds.aiFailPct != null && this.thresholds.failWindowMin != null && this.thresholds.failMinSample != null) n += 1;
    if (this.thresholds.derivedMaxGb != null) n += 1;
    return n;
  }

  /** 单轮检查（供测试直接调用） */
  async check(): Promise<void> {
    if (this.checking) return; // 上一轮 DB 慢查询未完，跳过本轮（不堆积）
    this.checking = true;
    const now = Date.now();
    try {
      const snapshot = await this.snapshot(now);
      const result = tickRules({
        snapshot,
        thresholds: this.thresholds,
        prevCounters: this.prevCounters,
        firing: this.firing,
        lastFireAt: this.lastFireAt,
        cooldownMs: this.cooldownMs,
        now,
      });
      this.firing = result.nextFiring;
      this.lastFireAt = result.nextLastFireAt;
      this.prevCounters = snapshot ? { httpTotal: snapshot.httpTotal, httpError: snapshot.httpError } : null;
      this.lastSnapshot = snapshot;
      this.lastMetrics = {
        windowErrorPct: result.windowErrorPct,
        deriveFailurePct: result.deriveFailurePct,
        aiFailurePct: result.aiFailurePct,
      };
      this.lastCheckAt = now;

      for (const ev of result.events) {
        this.log.warn(`⚠ ${ev.title} —— ${ev.detail}`);
        this.runtime[ev.code].lastEvent = { ...ev, at: now };
        void this.mailer.send(ev.title, `${ev.title}\n\n${ev.detail}\n\n时间: ${new Date(now).toISOString()}`);
      }
      for (const ev of result.recoveries) {
        this.log.log(`✓ ${ev.title}`);
        this.runtime[ev.code].lastRecovery = { ...ev, at: now };
        this.runtime[ev.code].lastRecoveryAt = now;
        void this.mailer.send(ev.title, `${ev.title}\n\n${ev.detail}\n\n时间: ${new Date(now).toISOString()}`);
      }
      for (const c of ALERT_RULE_CODES) {
        this.runtime[c].firing = result.nextFiring[c];
        this.runtime[c].lastFireAt = result.nextLastFireAt[c];
      }
    } catch (e) {
      this.log.warn(`告警检查异常（下轮重试）: ${(e as Error).message}`);
    } finally {
      this.checking = false;
    }
  }

  /** 只读状态（GET /api/alerts/status）：各规则配置/当前态/上次触发与最近内容 */
  getStatus(): Record<string, unknown> {
    const snap = this.lastSnapshot;
    const observed: Record<AlertRuleCode, Record<string, unknown>> = {
      login_locked: { login_locked: snap?.loginLocked ?? null },
      ai_task_backlog: { ai_task_pending: snap?.aiTaskPending ?? null },
      error_rate: { window_error_pct: this.lastMetrics.windowErrorPct },
      derive_failure_rate: {
        ready: snap?.deriveReady ?? null,
        failed: snap?.deriveFailed ?? null,
        failure_pct: this.lastMetrics.deriveFailurePct,
        window_min: this.thresholds.failWindowMin,
      },
      ai_task_failure_rate: {
        done: snap?.aiDone ?? null,
        failed: snap?.aiFailed ?? null,
        failure_pct: this.lastMetrics.aiFailurePct,
        window_min: this.thresholds.failWindowMin,
      },
      derived_disk_usage: {
        over_limit: diskGuardRuntime.overLimit,
        derived_bytes: diskGuardRuntime.lastTotalBytes,
        limit_bytes: diskGuardRuntime.lastLimitBytes,
        source_active_bytes: diskGuardRuntime.sourceActiveBytes,
        source_permanent_bytes: diskGuardRuntime.sourcePermanentBytes,
        max_gb_configured: this.capacity.maxGbConfigured,
        last_sweep_at: iso(diskGuardRuntime.lastSweepAt),
        evicted_total: diskGuardRuntime.evictedTotal,
      },
    };

    const rules = ALERT_RULE_CODES.map((code) => {
      const state = this.runtime[code];
      return {
        code,
        name: RULE_NAMES[code],
        configured: this.isConfigured(code),
        threshold: this.thresholdOf(code),
        firing: state.firing,
        last_fire_at: iso(state.lastFireAt),
        last_event: state.lastEvent ? {
          at: new Date(state.lastEvent.at).toISOString(),
          title: state.lastEvent.title,
          detail: state.lastEvent.detail,
        } : null,
        last_recovery_at: iso(state.lastRecoveryAt),
        last_recovery: state.lastRecovery ? {
          at: new Date(state.lastRecovery.at).toISOString(),
          title: state.lastRecovery.title,
          detail: state.lastRecovery.detail,
        } : null,
        observed: observed[code],
      };
    });

    return {
      generated_at: new Date().toISOString(),
      last_check_at: iso(this.lastCheckAt),
      check_sec: this.checkSec,
      cooldown_min: this.cfg.alertCooldownMin,
      smtp: { enabled: this.mailer.enabled },
      rules,
    };
  }

  private isConfigured(code: AlertRuleCode): boolean {
    switch (code) {
      case 'derive_failure_rate':
        return this.thresholds.deriveFailPct != null
          && this.thresholds.failWindowMin != null && this.thresholds.failMinSample != null;
      case 'ai_task_failure_rate':
        return this.thresholds.aiFailPct != null
          && this.thresholds.failWindowMin != null && this.thresholds.failMinSample != null;
      case 'derived_disk_usage':
        return this.thresholds.derivedMaxGb != null;
      default:
        return true;
    }
  }

  private thresholdOf(code: AlertRuleCode): Record<string, unknown> | number {
    switch (code) {
      case 'login_locked': return this.thresholds.loginLockedMax;
      case 'ai_task_backlog': return this.thresholds.aiTaskBacklog;
      case 'error_rate': return { pct: this.thresholds.errorRatePct, min_requests: this.thresholds.errorMinRequests };
      case 'derive_failure_rate':
        return { pct: this.thresholds.deriveFailPct, window_min: this.thresholds.failWindowMin, min_sample: this.thresholds.failMinSample };
      case 'ai_task_failure_rate':
        return { pct: this.thresholds.aiFailPct, window_min: this.thresholds.failWindowMin, min_sample: this.thresholds.failMinSample };
      case 'derived_disk_usage': return { max_gb: this.thresholds.derivedMaxGb, env: 'VIDEO_DERIVED_MAX_GB' };
      default: return {};
    }
  }

  private async snapshot(now: number): Promise<AlertSnapshot | null> {
    try {
      const nowDate = new Date(now);
      const loginLocked = Number(await this.ds.getRepository('t_user').createQueryBuilder('u')
        // mssql/sqlite 双兼容：锁定 = 显式 status，或锁定期未到（failed_count 累计中不算）
        .where("u.status = 'locked'")
        .orWhere('u.locked_until > :now', { now: nowDate })
        .getCount());
      const aiTaskPending = Number(await this.ds.getRepository('t_ai_task')
        .createQueryBuilder('t')
        .where("t.status = 'pending'")
        .getCount());
      const counters = await httpCounterTotals();

      let deriveReady: number | null = null;
      let deriveFailed: number | null = null;
      let aiDone: number | null = null;
      let aiFailed: number | null = null;
      if (this.thresholds.failWindowMin != null) {
        const start = new Date(now - this.thresholds.failWindowMin * 60_000);
        deriveReady = await this.safeCount('t_video_derivative', "t.status = 'ready' AND t.updated_at >= :start", { start });
        // 只统计终态失败：retry<2 的 error 行会被 worker 自动重入，算失败会虚高
        deriveFailed = await this.safeCount('t_video_derivative', "t.status = 'error' AND t.retry >= 2 AND t.updated_at >= :start", { start });
        aiDone = await this.safeCount('t_ai_task', "t.status = 'done' AND t.updated_at >= :start", { start });
        aiFailed = await this.safeCount('t_ai_task', "t.status = 'failed' AND t.updated_at >= :start", { start });
      }

      return {
        loginLocked, aiTaskPending,
        httpTotal: counters.total, httpError: counters.error,
        deriveReady, deriveFailed, aiDone, aiFailed,
        derivedOverLimit: diskGuardRuntime.overLimit,
        derivedBytes: diskGuardRuntime.lastTotalBytes,
        derivedLimitBytes: diskGuardRuntime.lastLimitBytes,
        sourceActiveBytes: diskGuardRuntime.sourceActiveBytes,
        sourcePermanentBytes: diskGuardRuntime.sourcePermanentBytes,
      };
    } catch (e) {
      this.log.warn(`告警快照采集失败（本轮跳过，不判定不恢复）: ${(e as Error).message}`);
      return null;
    }
  }

  /** 单表计数：失败时返回 null（本轮该指标不可判定），不影响其它规则 */
  private async safeCount(entity: string, where: string, params: Record<string, unknown>): Promise<number | null> {
    try {
      return Number(await this.ds.getRepository(entity).createQueryBuilder('t').where(where, params).getCount());
    } catch (e) {
      this.log.warn(`告警指标采集失败（${entity}，本轮不判定该规则）: ${(e as Error).message}`);
      return null;
    }
  }
}

const RULE_NAMES: Record<AlertRuleCode, string> = {
  login_locked: '登录锁定激增',
  ai_task_backlog: 'AI 任务堆积',
  error_rate: 'HTTP 错误率',
  derive_failure_rate: '派生失败率',
  ai_task_failure_rate: 'AI 任务失败率',
  derived_disk_usage: '派生磁盘占用',
};

/** 读 prom 注册表里 ie_http_requests_total 的累计值（全 label 求和；5xx 单列） */
export async function httpCounterTotals(): Promise<{ total: number; error: number }> {
  const metric = register.getSingleMetric('ie_http_requests_total');
  if (!metric) return { total: 0, error: 0 };
  const { values } = await metric.get();
  let total = 0;
  let error = 0;
  for (const v of values) {
    total += v.value;
    if (v.labels?.status === '5xx') error += v.value;
  }
  return { total, error };
}
