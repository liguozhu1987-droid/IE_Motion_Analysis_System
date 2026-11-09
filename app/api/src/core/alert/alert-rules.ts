/**
 * 告警规则纯函数层（盘点第 3 类：监控告警；P0-4 扩业务规则）。
 *
 * 运维级 3 条：
 *  - login_locked      登录锁定激增：当前锁定账号数 ≥ 阈值
 *  - ai_task_backlog   AI 任务堆积：pending 任务数 ≥ 阈值（文档口径 >50）
 *  - error_rate        HTTP 错误率：检查窗口内 5xx 占比 ≥ 阈值%（窗口样本须达最小样本）
 *
 * 业务级 3 条（P0-4）：
 *  - derive_failure_rate  派生失败率：窗口内终端派生（ready / error retry>=2）中失败占比 ≥ 阈值
 *  - ai_task_failure_rate AI 任务失败率：窗口内终态任务（done / failed）中失败占比 ≥ 阈值
 *  - derived_disk_usage   派生磁盘占用：worker du 判定 derived/ 超过 VIDEO_DERIVED_MAX_GB
 *
 * 阈值纪律（项目铁律「不猜数字」）：业务规则阈值未配置（null）= 规则关闭，
 * 不参与判定也不发火；启动期由 monitor 显式 warn，绝不暗设默认。
 *
 * 状态机：边沿触发——条件由 false→true 发一次告警，true→false 发一次恢复；
 * 冷却期（cooldownMs）内不重复发火（防抖动刷屏）。快照缺失（null）视为「查不到」，不发火也不恢复；
 * 单条业务指标缺失（null）视为「本轮不可判定」，保持原状态（不误发恢复）。
 */

export const ALERT_RULE_CODES = [
  'login_locked',
  'ai_task_backlog',
  'error_rate',
  'derive_failure_rate',
  'ai_task_failure_rate',
  'derived_disk_usage',
] as const;

export type AlertRuleCode = (typeof ALERT_RULE_CODES)[number];

export interface AlertSnapshot {
  /** 当前锁定账号数（status='locked' 或 locked_until > now） */
  loginLocked: number;
  /** AI 任务 pending 数 */
  aiTaskPending: number;
  /** HTTP 累计请求数（prom 计数器全 label 求和） */
  httpTotal: number;
  /** HTTP 累计 5xx 数 */
  httpError: number;
  /** 窗口内派生终态成功数（status='ready'）；null = 窗口未配置或查询失败 */
  deriveReady: number | null;
  /** 窗口内派生终态失败数（status='error' 且 retry>=2）；null = 同上 */
  deriveFailed: number | null;
  /** 窗口内 AI 任务成功数（status='done'）；null = 同上 */
  aiDone: number | null;
  /** 窗口内 AI 任务失败数（status='failed'）；null = 同上 */
  aiFailed: number | null;
  /** 派生目录是否超限（worker 每轮 du 后写入 alert-runtime） */
  derivedOverLimit: boolean;
  /** 最近一次 du 的派生目录字节数 */
  derivedBytes: number;
  /** 最近一次 du 生效的上限字节数（未配置时为 0） */
  derivedLimitBytes: number;
  /** 源视频占用：活跃（到期会删除）字节数 */
  sourceActiveBytes: number;
  /** 源视频占用：已选择永久保留的字节数 */
  sourcePermanentBytes: number;
}

export interface RuleThresholds {
  loginLockedMax: number;
  aiTaskBacklog: number;
  errorRatePct: number;
  /** 错误率最小样本：窗口内请求总数低于此值不计错误率（默认 20，零星 5xx 不告警） */
  errorMinRequests: number;
  /** 派生失败率阈值 %；null = 未配置，规则关闭 */
  deriveFailPct: number | null;
  /** AI 任务失败率阈值 %；null = 未配置，规则关闭 */
  aiFailPct: number | null;
  /** 业务失败率统计窗口（分钟）；null = 未配置，两条失败率规则关闭 */
  failWindowMin: number | null;
  /** 业务失败率最小样本；null = 未配置，两条失败率规则关闭 */
  failMinSample: number | null;
  /** 派生磁盘上限 GB（复用 VIDEO_DERIVED_MAX_GB）；null = 未配置，磁盘规则关闭 */
  derivedMaxGb: number | null;
}

export interface AlertEvent {
  code: AlertRuleCode;
  title: string;
  detail: string;
}

export interface RuleTickInput {
  snapshot: AlertSnapshot | null;
  thresholds: RuleThresholds;
  /** 上一轮累计计数（错误率按窗口增量计算；首轮为 null → 本轮只建立基线不判定） */
  prevCounters: { httpTotal: number; httpError: number } | null;
  /** 各规则当前是否处于「已发火」态 */
  firing: Record<AlertRuleCode, boolean>;
  /** 各规则上次发火时间戳（ms）；0 = 从未发过 */
  lastFireAt: Record<AlertRuleCode, number>;
  cooldownMs: number;
  now: number;
}

export interface RuleTickResult {
  events: AlertEvent[];
  recoveries: AlertEvent[];
  /** 窗口错误率（%（增量口径）；样本不足或首轮为 null） */
  windowErrorPct: number | null;
  /** 窗口派生失败率（%；样本不足/未配置为 null） */
  deriveFailurePct: number | null;
  /** 窗口 AI 任务失败率（%；样本不足/未配置为 null） */
  aiFailurePct: number | null;
  nextFiring: Record<AlertRuleCode, boolean>;
  nextLastFireAt: Record<AlertRuleCode, number>;
}

function isErrorRateFiring(pct: number | null, t: RuleThresholds): boolean {
  return pct !== null && pct >= t.errorRatePct;
}

/** 失败率 = failed / (failed + success)；样本不足或未配置 → null（本轮不可判定） */
function failurePct(failed: number | null, success: number | null, minSample: number | null): number | null {
  if (failed == null || success == null || minSample == null) return null;
  const sample = failed + success;
  if (sample < minSample) return null;
  return (failed / sample) * 100;
}

export function tickRules(input: RuleTickInput): RuleTickResult {
  const { snapshot, thresholds: t, prevCounters, firing, lastFireAt, cooldownMs, now } = input;
  const nextFiring = { ...firing };
  const nextLastFireAt = { ...lastFireAt };
  const events: AlertEvent[] = [];
  const recoveries: AlertEvent[] = [];
  const empty = {
    events, recoveries, windowErrorPct: null as number | null,
    deriveFailurePct: null as number | null, aiFailurePct: null as number | null,
    nextFiring, nextLastFireAt,
  };

  if (!snapshot) return empty;

  // 错误率：按两次检查之间的增量算（prom 计数器是进程累计值，直接用比值会被历史摊平）
  let windowErrorPct: number | null = null;
  if (prevCounters) {
    const dTotal = snapshot.httpTotal - prevCounters.httpTotal;
    const dError = snapshot.httpError - prevCounters.httpError;
    if (dTotal >= t.errorMinRequests) {
      windowErrorPct = dTotal > 0 ? (dError / dTotal) * 100 : 0;
    }
  }

  const derivePct = failurePct(snapshot.deriveFailed, snapshot.deriveReady, t.failMinSample);
  const aiPct = failurePct(snapshot.aiFailed, snapshot.aiDone, t.failMinSample);
  // null = 本轮不可判定（阈值未配/窗口未配/样本不足/查询失败）——保持原状态，不误发恢复
  const deriveBad: boolean | null =
    t.deriveFailPct == null || derivePct == null ? null : derivePct >= t.deriveFailPct;
  const aiBad: boolean | null =
    t.aiFailPct == null || aiPct == null ? null : aiPct >= t.aiFailPct;
  const diskBad: boolean | null = t.derivedMaxGb == null ? null : snapshot.derivedOverLimit;

  const pctText = (v: number | null) => (v == null ? '?' : v.toFixed(2));
  const gb = (n: number) => (n / 1024 ** 3).toFixed(3);

  const conditions: Array<{ code: AlertRuleCode; bad: boolean | null; title: string; detail: string }> = [
    {
      code: 'login_locked',
      bad: snapshot.loginLocked >= t.loginLockedMax,
      title: `登录锁定账号激增（当前 ${snapshot.loginLocked}，阈值 ${t.loginLockedMax}）`,
      detail: `疑似暴力破解或批量口令过期：t_user 中 status='locked' 或 locked_until 未过期的账号已达 ${snapshot.loginLocked} 个（阈值 ${t.loginLockedMax}）。请检查登录失败来源 IP 与账号。`,
    },
    {
      code: 'ai_task_backlog',
      bad: snapshot.aiTaskPending > t.aiTaskBacklog,
      title: `AI 任务队列堆积（pending ${snapshot.aiTaskPending}，阈值 >${t.aiTaskBacklog}）`,
      detail: `t_ai_task 中 status='pending' 的任务已达 ${snapshot.aiTaskPending} 个（阈值 >${t.aiTaskBacklog}）。可能 LLM 端点不可用或 worker 停转，请检查 /ready 与 LLM 配置。`,
    },
    {
      code: 'error_rate',
      bad: isErrorRateFiring(windowErrorPct, t),
      title: `HTTP 错误率超标（窗口 ${pctText(windowErrorPct)}%，阈值 ≥${t.errorRatePct}%）`,
      detail: `本次检查窗口内 5xx 占比 ${pctText(windowErrorPct)}%（样本 ${t.errorMinRequests}+ 请求，阈值 ≥${t.errorRatePct}%）。请结合 /api/metrics 的 ie_http_requests_total 按路由定位。`,
    },
    {
      code: 'derive_failure_rate',
      bad: deriveBad,
      title: `派生失败率超标（窗口 ${pctText(derivePct)}%，阈值 ≥${t.deriveFailPct ?? '未配置'}%）`,
      detail: `最近 ${t.failWindowMin ?? '?'} 分钟内终端派生（ready + error retry>=2）共 ${(snapshot.deriveReady ?? 0) + (snapshot.deriveFailed ?? 0)} 条，失败 ${snapshot.deriveFailed ?? '?'} 条，失败率 ${pctText(derivePct)}%（最小样本 ${t.failMinSample ?? '未配置'}，阈值 ≥${t.deriveFailPct ?? '未配置'}%）。请检查派生 worker 日志、ffmpeg/编码器可用性与源视频完整性。`,
    },
    {
      code: 'ai_task_failure_rate',
      bad: aiBad,
      title: `AI 任务失败率超标（窗口 ${pctText(aiPct)}%，阈值 ≥${t.aiFailPct ?? '未配置'}%）`,
      detail: `最近 ${t.failWindowMin ?? '?'} 分钟内终态 AI 任务（done + failed）共 ${(snapshot.aiDone ?? 0) + (snapshot.aiFailed ?? 0)} 条，失败 ${snapshot.aiFailed ?? '?'} 条，失败率 ${pctText(aiPct)}%（最小样本 ${t.failMinSample ?? '未配置'}，阈值 ≥${t.aiFailPct ?? '未配置'}%）。请检查 LLM 端点、AI_ENABLED 与月度配额（quota_exceeded 也会记为 failed）。`,
    },
    {
      code: 'derived_disk_usage',
      bad: diskBad,
      title: `派生目录占用超限（${gb(snapshot.derivedBytes)}GB > 上限 ${gb(snapshot.derivedLimitBytes)}GB）`,
      detail: `worker 实测 derived/ 占用 ${gb(snapshot.derivedBytes)}GB，超过 VIDEO_DERIVED_MAX_GB=${t.derivedMaxGb ?? '未配置'}GB（上限 ${gb(snapshot.derivedLimitBytes)}GB）。`
        + `源视频占用另计：活跃（到期会删除）${gb(snapshot.sourceActiveBytes)}GB / 永久保留 ${gb(snapshot.sourcePermanentBytes)}GB（永久保留不随保留期清理，是长期磁盘成本）。`
        + '已按 LRU 只淘汰 proxy，源视频不动；请扩盘或调低派生产出，并核对 GET /api/videos/storage。',
    },
  ];

  for (const c of conditions) {
    if (c.bad === null) continue; // 本轮不可判定：不发火也不恢复
    if (c.bad && !firing[c.code]) {
      // 边沿触发 + 冷却：距上次发火不足冷却期则本轮不通知，但不置 firing——
      // 条件持续为真时冷却期满的那一轮会自然补发，避免告警被冷却期彻底吞掉
      if (now - lastFireAt[c.code] >= cooldownMs) {
        events.push({ code: c.code, title: c.title, detail: c.detail });
        nextLastFireAt[c.code] = now;
        nextFiring[c.code] = true;
      }
    } else if (!c.bad && firing[c.code]) {
      recoveries.push({ code: c.code, title: `已恢复：${c.title.split('（')[0]}`, detail: `${c.code} 告警条件已解除（本轮快照恢复正常）。` });
      nextFiring[c.code] = false;
    }
  }

  return {
    events, recoveries, windowErrorPct,
    deriveFailurePct: derivePct, aiFailurePct: aiPct,
    nextFiring, nextLastFireAt,
  };
}
