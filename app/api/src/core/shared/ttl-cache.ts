/**
 * 进程内 TTL 缓存 + single-flight（同键并发合并）。
 *
 * 为什么需要它：50 人早高峰在月会/早会同时打开驾驶舱，URL 与筛选条件完全相同，
 * 每次请求都要跑一遍跨 5 张表的全表聚合 + 逐工位 analyzeStation()。
 * 单纯加 TTL 缓存只能挡掉"前一次算完之后"的请求，挡不住**同一瞬间**涌入的 N 个
 * 并发请求（它们会同时 miss、同时回源）。因此这里做 single-flight：同键的并发
 * 调用共享同一个 in-flight Promise，N 次回源被压成 1 次。
 *
 * 设计约束：
 *  1) 只缓存**成功**结果——loader 抛错时不落盘，避免把一次数据库抖动固化成 TTL 窗口内的错误；
 *  2) 容量上限（默认 64 条），超出按"最旧插入"淘汰，防止筛选条件组合无限膨胀（无界 Map 是内存泄漏）；
 *  3) 清理定时器 unref()——不阻挡进程退出（测试进程 / PM2 reload 时不会被挂住）；
 *  4) ttlMs <= 0 视为关闭缓存（但仍保留 single-flight 之外的直通行为，便于排障时快速关缓存）。
 */
import { Logger } from '@nestjs/common';

export type CacheResult = 'hit' | 'miss' | 'shared';

export interface CacheOutcome<T> {
  value: T;
  /** hit=命中已有值；miss=未命中并回源计算；shared=合并到同键正在进行的计算 */
  result: CacheResult;
}

export interface TtlCacheOptions {
  /** 存活时间（毫秒）；<= 0 表示关闭缓存 */
  ttlMs: number;
  /** 条目上限，超出按最旧插入淘汰 */
  maxEntries?: number;
  /** 日志标识（出错/淘汰时可定位是哪个缓存） */
  label?: string;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** 清理间隔：至少 30s，至多 60s——比 TTL 短太多是空转，太长则过期条目占内存 */
const CLEANUP_MIN_MS = 30_000;
const CLEANUP_MAX_MS = 60_000;

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly label: string;
  private readonly log = new Logger('TtlCache');
  private readonly timer: NodeJS.Timeout | null;
  private hits = 0;
  private misses = 0;
  private shared = 0;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 0;
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? 64));
    this.label = opts.label ?? 'default';
    if (this.enabled) {
      const interval = Math.min(Math.max(this.ttlMs, CLEANUP_MIN_MS), CLEANUP_MAX_MS);
      this.timer = setInterval(() => this.purge(), interval);
      // unref：定时器不参与"进程还有没有活要干"的判定，否则测试/脚本跑完不退出
      this.timer.unref();
    } else {
      this.timer = null;
    }
  }

  /** 缓存是否生效（TTL <= 0 时关闭） */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /**
   * 取键对应的值：命中直接返回；同键已有 in-flight 则共享；否则回源计算并写缓存。
   * 回源失败会原样抛给**所有**等待者，且不写入缓存。
   */
  async resolve<T>(key: string, loader: () => Promise<T>): Promise<CacheOutcome<T>> {
    if (!this.enabled) {
      return { value: await loader(), result: 'miss' };
    }

    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expiresAt > now) {
        this.hits += 1;
        return { value: hit.value as T, result: 'hit' };
      }
      // 惰性清理：读路径顺手淘汰过期条目，避免依赖定时器时读到陈旧值
      this.entries.delete(key);
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.shared += 1;
      // 同键 ⇒ 结果形状一致，等待者拿到的就是同一个对象
      return { value: (await pending) as T, result: 'shared' };
    }

    this.misses += 1;
    // 注意：loader 抛同步异常时不会进入 inflight，直接向上冒泡（不会误缓存）
    const task: Promise<unknown> = Promise.resolve().then(loader);
    this.inflight.set(key, task);
    try {
      const value = await task;
      this.store(key, value);
      return { value: value as T, result: 'miss' };
    } finally {
      // 无论成功失败都要摘掉 in-flight，否则后续同键请求永远等一个已完成的 Promise
      this.inflight.delete(key);
    }
  }

  /** 失效某个键（数据写入后按需调用） */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** 清空全部条目与 in-flight 引用（规则发布/回滚后可整体失效） */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /** 运行态统计（供日志/排障，不参与业务口径） */
  stats(): { enabled: boolean; size: number; inflight: number; hits: number; misses: number; shared: number } {
    return {
      enabled: this.enabled,
      size: this.entries.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
      shared: this.shared,
    };
  }

  /** 清理过期条目（定时器调用，也可测时手动调用） */
  purge(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /** 写入并做容量控制 */
  private store(key: string, value: unknown): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      this.purge();
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
      this.log.debug(`${this.label} 缓存达上限 ${this.maxEntries}，按最旧淘汰`);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
