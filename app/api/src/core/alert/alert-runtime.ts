/**
 * 告警运行时共享状态（进程内，单实例部署前提）。
 *
 * 磁盘治理的「检测/淘汰」由视频派生 worker 执行，而「日志 + 邮件通知」统一由
 * AlertMonitorService 收敛——同一条件只允许一条通知链路，避免 P0-1 与 P0-4 各发一封。
 * 因此 worker 只写这里的观测状态，monitor 读取后决定是否触发/恢复告警。
 */
/**
 * 源视频保留扫描的运行时观测（进程内，单实例部署前提）。
 * 删除失败必须可见：worker 只写这里的计数，`/api/videos/storage` 回显；
 * 失败告警走 AlertMailerService（ALERT_MAIL_TO）+ error 日志，不静默吞。
 */
export const retentionRuntime = {
  /** 最近一轮扫描完成时间 */
  lastSweepAt: 0,
  /** 最近一轮删除条数 */
  lastDeletes: 0,
  /** 最近一轮删除失败条数 */
  lastDeleteFailures: 0,
  /** 最近一轮发出/尝试的到期提醒数 */
  lastNotices: 0,
  /** 累计删除成功条数 */
  deletedTotal: 0,
  /** 累计删除失败条数（含下一轮重试前的失败） */
  deleteFailuresTotal: 0,
  /** 累计提醒失败条数（SMTP 未配/发送异常） */
  noticeFailuresTotal: 0,
  /** 最近一次删除失败告警邮件时间（1 小时节流） */
  lastFailureAlertAt: 0,
};

export const diskGuardRuntime = {
  /** 最近一次超限判定时间（/api/videos/storage 沿用 last_disk_alert_at 字段） */
  lastAlertAt: 0,
  /** 最近一次 du/淘汰完成时间 */
  lastSweepAt: 0,
  /** 派生目录是否超限（由 worker 每轮 du 后写入） */
  overLimit: false,
  /** 最近一次 du 的派生目录字节数 */
  lastTotalBytes: 0,
  /** 最近一次 du 生效的磁盘上限字节数 */
  lastLimitBytes: 0,
  /** 累计 LRU 淘汰的 proxy 数 */
  evictedTotal: 0,
  /** 源视频目录占用：仍在保留期内（含未登记的历史文件）的活跃字节数 */
  sourceActiveBytes: 0,
  /** 源视频目录占用：已选择永久保留的字节数（仅标记，仍占磁盘） */
  sourcePermanentBytes: 0,
};
