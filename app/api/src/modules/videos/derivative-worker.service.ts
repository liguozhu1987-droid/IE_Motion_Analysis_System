import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, LessThan } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { VideoAsset } from '../../entities/video-asset.entity';
import { VideoDerivative } from '../../entities/video-derivative.entity';
import { VideosService } from './videos.service';
import { DerivativeService } from './derivative.service';
import { probeVideoMeta, resolveEncoder, encoderOrderFrom, invalidateEncoderCache } from './derivative-ffmpeg';
import { buildProxy, buildSprite, buildIndex } from './derivative-build';
import { CapacityConfig, dirBytes, diskGuardRuntime, loadCapacityConfig } from './derivative-capacity';

/**
 * 派生 worker（SPEC-VID-P0 §5，复用 ai-task 5s 轮询范式）：
 *  - 进程内 setInterval(5000) 轮询 pending（及 error 且 retry<2 自动重入的行）；
 *  - in-flight Set 按 file_name+kind 去重（同任务只跑一个）；
 *  - 并发上限由 VIDEO_DERIVE_CONCURRENCY 决定（未配置时保守默认 2，启动期显式告警）；
 *  - 状态机 pending → running → ready(填 meta) / error(retry+1；retry<2 下轮自动重入，>=2 终态)；
 *  - 单任务 ffmpeg 超时（VIDEO_DERIVE_TIMEOUT_MIN），防卡死永久占用并发；
 *  - 僵尸 running 回收（>VIDEO_RUNNING_STALE_MIN 无更新 → pending），防进程崩溃后永久卡死；
 *  - 顺带清理分片目录 TTL>24h 残留（Spec §7.1 防中断遗留）；
 *  - P0.5 磁盘治理（Spec §10）：每 VIDEO_DERIVED_DU_SEC 秒 du 派生目录，
 *    超 VIDEO_DERIVED_MAX_GB → 更新 diskGuardRuntime（overLimit/字节数）并按
 *    last_accessed_at（NULL 回落 created_at）升序 LRU 淘汰 proxy（删文件 + status='evicted'）；
 *    只删 derived/<id>/proxy.mp4，**源视频 storage/videos/<uuid>.mp4 永不触碰**；
 *    P0-4 起，告警的日志/邮件通知统一由 AlertMonitorService 发出（本 worker 不再重复发信）；
 *  - P0-1 孤儿巡检（VIDEO_ORPHAN_SWEEP=1 才开，默认关）：源视频已不存在的派生行会被清理。
 * 领取用条件更新（CAS）防同库多进程/同轮重复领取。
 */
@Injectable()
export class DerivativeWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DerivativeWorker');
  private timer: NodeJS.Timeout | null = null;
  /** in-flight 去重：key = `<file_name>|<kind>` */
  private readonly inflight = new Set<string>();
  private readonly capacity: CapacityConfig;
  private readonly chunkRoot = path.resolve(process.cwd(), 'storage', 'videos', 'tmp', 'chunks');
  /** 磁盘治理节流：同一时刻只跑一轮 du/淘汰（异步，不阻塞 5s tick） */
  private maintaining = false;
  private lastDuAt = 0;
  private lastChunkCleanAt = 0;
  private lastStaleSweepAt = 0;
  private lastOrphanSweepAt = 0;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly videos: VideosService,
    private readonly derivatives: DerivativeService,
  ) {
    this.capacity = loadCapacityConfig();
  }

  async onModuleInit(): Promise<void> {
    this.warnUnconfiguredParams();
    // 崩溃恢复：上次进程中断残留的 running 行回置 pending（单实例部署前提）
    try {
      const r = await this.repo().update({ status: 'running' } as any, { status: 'pending', updated_at: new Date() } as any);
      if ((r.affected ?? 0) > 0) this.log.warn(`启动恢复：${r.affected} 条 running 行回置 pending`);
    } catch (e) {
      this.log.warn(`running 残留恢复失败（不影响启动）: ${(e as Error).message}`);
    }
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 参数缺失/非法的启动期显式告警——项目铁律「不猜数字」的落地：
   * 不把未经现场确认的值伪装成生效配置，让运维在启动日志和 /api/videos/storage 里看见缺口。
   */
  private warnUnconfiguredParams(): void {
    const c = this.capacity;
    if (!c.maxGbConfigured) {
      this.log.warn(
        `VIDEO_DERIVED_MAX_GB 未配置${c.maxGbRaw ? `（当前值 "${c.maxGbRaw}" 非法）` : ''}：`
        + '派生磁盘治理关闭（不告警、不 LRU 淘汰）。上线前必须按目标服务器的可用磁盘实测值配置（单位 GB）。',
      );
    }
    if (!c.concurrencyConfigured) {
      this.log.warn(`VIDEO_DERIVE_CONCURRENCY 未配置，使用保守默认 ${c.concurrency}（需按服务器核数/编码器类型确认后再定）`);
    }
    if (!c.deriveTimeoutConfigured) {
      this.log.warn(`VIDEO_DERIVE_TIMEOUT_MIN 未配置，单任务超时使用保守默认 ${c.deriveTimeoutMin} 分钟（需按最长视频确认）`);
    }
    if (!this.videos.resolveFfmpeg()) {
      this.log.warn('服务器未找到 ffmpeg（FFMPEG_BIN / app/api/bin / ffmpeg-static / PATH 均落空）：派生队列将全部失败，浏览器不可播的格式也无法转码');
    }
    if (!c.autoDerive) this.log.log('VIDEO_AUTO_DERIVE=0：上传后不自动派生（工作台载入时的 POST /derive 兜底仍有效）');
    if (!c.orphanSweep) this.log.log('VIDEO_ORPHAN_SWEEP 未开启：源视频被人工删除后，其派生行不会自动清理（默认关闭，防共享存储瞬时不可见时误删）');
  }

  private async tick(): Promise<void> {
    this.cleanChunkDirs();
    this.recoverStaleRunning();
    this.maintainDerivedDisk();
    this.sweepOrphanRows();
    const free = this.capacity.concurrency - this.inflight.size;
    if (free <= 0) return;
    let rows: any[] = [];
    try {
      rows = await this.repo().find({
        // error 且 retry<2：失败自动重入（下一轮领取）；retry>=2 为终态不再领取
        where: [{ status: 'pending' }, { status: 'error', retry: LessThan(2) }],
        order: { created_at: 'ASC' },
        take: free + this.inflight.size,
      } as any) as any[];
    } catch (e) {
      this.log.warn(`派生队列轮询失败: ${(e as Error).message}`);
      return;
    }
    for (const row of rows) {
      if (this.inflight.size >= this.capacity.concurrency) break;
      const key = `${row.file_name}|${row.kind}`;
      if (this.inflight.has(key)) continue;
      const claimed = await this.claim(row.id);
      if (!claimed) continue; // 已被其他轮次/进程领取
      this.inflight.add(key);
      void this.runOne(row, key).catch(() => undefined);
    }
  }

  /** CAS 领取：仅当状态仍为 pending/error 才置 running */
  private async claim(id: string): Promise<boolean> {
    const r = await this.repo().createQueryBuilder()
      .update()
      .set({ status: 'running', updated_at: new Date() })
      .where('id = :id AND status IN (:...st)', { id, st: ['pending', 'error'] })
      .execute();
    return (r.affected ?? 0) > 0;
  }

  private async runOne(row: any, key: string): Promise<void> {
    const t0 = Date.now();
    try {
      const src = this.videos.filePathOf(row.file_name);
      const ffmpeg = this.videos.resolveFfmpeg();
      if (!src || !fs.existsSync(src)) throw new Error('源视频文件不存在');
      if (!ffmpeg) throw new Error('服务器未配置 ffmpeg，无法生成派生');
      const meta = await probeVideoMeta(ffmpeg, src);
      const outDir = this.derivatives.dirOf(row.file_name);
      fs.mkdirSync(outDir, { recursive: true });
      let res;
      if (row.kind === 'proxy') {
        const preferred = await resolveEncoder(ffmpeg, src);
        if (!preferred) throw new Error('无可用 H.264 编码器（QSV/NVENC/libx264 探测全失败）');
        // 运行时回退：硬件编码器探测过≠实跑稳（QSV 实测单帧过、全片翻车）——按序试错
        let lastEncErr: Error | null = null;
        for (const enc of encoderOrderFrom(preferred)) {
          try {
            res = await buildProxy(ffmpeg, src, outDir, enc, meta);
            break;
          } catch (e) {
            lastEncErr = e as Error;
            this.log.warn(`代理编码 ${enc} 实跑失败，回退下一编码器: ${lastEncErr.message.slice(0, 120)}`);
            invalidateEncoderCache(); // 硬件状态存疑，下条视频重新探测
          }
        }
        if (!res) throw lastEncErr ?? new Error('代理编码失败');
      } else if (row.kind === 'sprite') {
        res = await buildSprite(ffmpeg, src, outDir, meta);
      } else {
        // index：VFR 优先取代理逐帧 pts（all-intra 解码快）；代理未就绪时回退源文件（时间戳保持）。
        // srcPath 另传源视频：keyframes（P0.5）须取源 I 帧——代理 all-intra 每帧都是 I 帧无参考价值。
        const proxy = path.join(outDir, 'proxy.mp4');
        res = await buildIndex(ffmpeg, fs.existsSync(proxy) ? proxy : src, outDir, meta, src);
      }
      await this.repo().update({ id: row.id }, {
        status: 'ready', path: res.path, size: res.size,
        frames: res.frames ?? null, duration_ms: res.durationMs ?? null,
        width: res.width ?? null, height: res.height ?? null,
        fps: res.fps ?? null, vfr: res.vfr ?? null,
        error_msg: null, updated_at: new Date(),
      } as any);
      this.log.log(`派生完成 ${row.file_name}/${row.kind} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${(res.size / 1024).toFixed(0)}KB)`);
    } catch (e) {
      const retry = Number(row.retry ?? 0) + 1;
      const msg = String((e as Error).message ?? e).slice(0, 500);
      await this.repo().update({ id: row.id }, {
        status: 'error', retry, error_msg: msg, updated_at: new Date(),
      } as any).catch(() => undefined);
      // retry<2 的 error 行下轮 tick 自动重入（poll 条件已覆盖）；retry>=2 终态，不再空转
      this.log.warn(`派生失败 ${row.file_name}/${row.kind}（第 ${retry} 次${retry >= 2 ? '，终态' : '，下次 tick 自动重试'}）：${msg}`);
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * running 僵尸回收：进程崩溃/ffmpeg 被杀后行可能停在 running。
   * 启动时已全量回置一次；运行期再按 updated_at 超时兜底（单实例部署前提）。
   */
  private recoverStaleRunning(): void {
    const now = Date.now();
    if (now - this.lastStaleSweepAt < 60_000) return;
    this.lastStaleSweepAt = now;
    const cutoff = new Date(now - this.capacity.staleRunMin * 60_000);
    void this.repo().update(
      { status: 'running', updated_at: LessThan(cutoff) } as any,
      { status: 'pending', updated_at: new Date() } as any,
    ).then((r) => {
      if ((r.affected ?? 0) > 0) {
        this.log.warn(`僵尸 running 行回收: ${r.affected} 条（>${this.capacity.staleRunMin} 分钟无更新，已回置 pending）`);
      }
    }).catch(() => undefined);
  }

  /** 分片目录 TTL>24h 清理（Spec §7.1：上传中断遗留的分片不永久占盘）；每 60s 至多扫一次 */
  private cleanChunkDirs(): void {
    const now = Date.now();
    if (now - this.lastChunkCleanAt < 60_000) return;
    this.lastChunkCleanAt = now;
    try {
      if (!fs.existsSync(this.chunkRoot)) return;
      const cutoff = now - 24 * 3600 * 1000;
      let removed = 0;
      for (const d of fs.readdirSync(this.chunkRoot)) {
        const dir = path.join(this.chunkRoot, d);
        try {
          const st = fs.statSync(dir);
          if (st.mtimeMs < cutoff) { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; }
        } catch { /* 单目录失败跳过 */ }
      }
      if (removed > 0) this.log.log(`分片残留清理: ${removed} 个目录（TTL>24h）`);
    } catch { /* 清理属顺带任务，失败不影响主流程 */ }
  }

  private maintainDerivedDisk(): void {
    const maxGb = this.capacity.maxGb;
    if (maxGb == null || this.maintaining) return;
    const now = Date.now();
    if (now - this.lastDuAt < this.capacity.duSec * 1000) return;
    this.lastDuAt = now;
    this.maintaining = true;
    void this.runDiskGuard(maxGb)
      .catch((e) => this.log.warn(`磁盘治理异常（不影响主流程）: ${(e as Error).message}`))
      .finally(() => { this.maintaining = false; });
  }

  /**
   * P0-1 磁盘护栏（异步）：du → 告警 → LRU 只删 proxy → 回读真实 du。
   * - 只对 derivedRoot 内的 proxy.mp4 动手，源视频目录 storage/videos/*.mp4 永不触碰；
   * - 淘汰记账用删除前的真实文件大小（行 size 可能为空，避免"减 0 导致全删"）；
   * - evicted 行若因占用残留文件，先清扫一轮，保证磁盘实际回落；
   * - in-flight 的 proxy 不动（防与 runOne 写文件竞态）。
   */
  private async runDiskGuard(maxGb: number): Promise<void> {
    const root = this.derivatives.rootOf();
    const limit = maxGb * 1024 ** 3;
    const gb = (n: number) => (n / 1024 ** 3).toFixed(3);
    let total = fs.existsSync(root) ? dirBytes(root) : 0;

    // 源视频占用按「到期会删除（active）/ 已选择永久保留（permanent）」拆分，
    // 供告警文案与 /api/videos/storage 区分口径（永久保留仍占磁盘，是真实长期成本）。
    const src = await this.sourceUsageBreakdown();
    diskGuardRuntime.sourceActiveBytes = src.active;
    diskGuardRuntime.sourcePermanentBytes = src.permanent;

    // 1) 已淘汰但文件残留（占用/删除失败）→ 补删，避免 du 永远超限
    total -= await this.sweepEvictedLeftovers();
    diskGuardRuntime.lastTotalBytes = total;
    diskGuardRuntime.lastLimitBytes = limit;

    if (total <= limit) {
      // 恢复通知由 AlertMonitorService 统一发出（只发一次）；worker 只更新检测状态
      diskGuardRuntime.overLimit = false;
      return;
    }

    if (!diskGuardRuntime.overLimit) {
      // 首次超限判定时间：/api/videos/storage 的 last_disk_alert_at 沿用该字段
      diskGuardRuntime.lastAlertAt = Date.now();
    }
    diskGuardRuntime.overLimit = true;

    // 2) LRU：ready 的 proxy，按最后访问时间升序（NULL 回落 created_at）
    const rows = await this.repo().find({
      where: { kind: 'proxy', status: 'ready' } as any,
      order: { created_at: 'ASC' },
    } as any) as any[];
    const keyOf = (r: any) => new Date(r.last_accessed_at ?? r.created_at ?? 0).getTime();
    const sorted = rows
      .filter((r) => !this.inflight.has(`${r.file_name}|proxy`))
      .sort((a, b) => keyOf(a) - keyOf(b));

    for (const r of sorted) {
      if (total <= limit) break;
      const proxyPath = r.path || path.join(this.derivatives.dirOf(r.file_name), 'proxy.mp4');
      let freed = 0;
      try {
        freed = fs.statSync(proxyPath).size;
        fs.rmSync(proxyPath, { force: true });
      } catch { /* 文件不存在/占用：状态照置，磁盘按 0 记 */ }
      await this.repo().update({ id: r.id }, {
        status: 'evicted', path: null, size: null, last_accessed_at: null, updated_at: new Date(),
      } as any).catch(() => undefined);
      total -= freed || Number(r.size ?? 0);
      diskGuardRuntime.evictedTotal += 1;
      this.log.log(`LRU 淘汰代理: ${r.file_name}（释放 ${((freed || Number(r.size ?? 0)) / 1024 / 1024).toFixed(1)}MB，源视频保留，再次访问时按需重生成）`);
    }

    // 3) 回读真实 du（避免记账偏差掩盖"仍超限"）
    total = fs.existsSync(root) ? dirBytes(root) : 0;
    diskGuardRuntime.lastTotalBytes = total;
    diskGuardRuntime.lastSweepAt = Date.now();
    if (total > limit) {
      this.log.warn(`LRU 淘汰后仍超限: ${gb(total)}GB > 上限 ${gb(limit)}GB（proxy 已清完，剩余为 sprite/index 或不可删项，请扩盘或调低派生产出）`);
    }
  }

  /**
   * 源视频目录占用拆分（只统计 storage/videos 顶层 *.mp4，不含 derived/ tmp/ 子目录）：
   *  - active：默认到期删除 + 已选择「再保留」的文件（含无归属登记的历史文件）；
   *  - permanent：用户已选择永久保留的文件。
   * 统计失败按 0 计，不影响磁盘治理主流程。
   */
  private async sourceUsageBreakdown(): Promise<{ active: number; permanent: number }> {
    const dir = path.resolve(process.cwd(), 'storage', 'videos');
    if (!fs.existsSync(dir)) return { active: 0, permanent: 0 };
    const sizes = new Map<string, number>();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.toLowerCase().endsWith('.mp4')) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) sizes.set(name, st.size);
        } catch { /* 单文件失败跳过 */ }
      }
    } catch {
      return { active: 0, permanent: 0 };
    }
    let permanentNames = new Set<string>();
    try {
      const rows = await this.ds.getRepository(VideoAsset).find({ select: ['file_name', 'retention_status'] } as any) as any[];
      permanentNames = new Set(rows.filter((r) => r.retention_status === 'permanent').map((r) => r.file_name));
    } catch { /* 归属表不可读：全部按活跃计 */ }
    let permanent = 0;
    let total = 0;
    for (const [name, size] of sizes) {
      total += size;
      if (permanentNames.has(name)) permanent += size;
    }
    return { active: Math.max(0, total - permanent), permanent };
  }

  /** 补删 evicted 行的残留 proxy 文件；返回释放字节数 */
  private async sweepEvictedLeftovers(): Promise<number> {
    const rows = await this.repo().find({ where: { kind: 'proxy', status: 'evicted' } as any }) as any[];
    let freed = 0;
    for (const r of rows) {
      const p = path.join(this.derivatives.dirOf(r.file_name), 'proxy.mp4');
      try {
        const st = fs.statSync(p);
        fs.rmSync(p, { force: true });
        freed += st.size;
        this.log.log(`清理 evicted 残留代理文件: ${r.file_name}（${(st.size / 1024 / 1024).toFixed(1)}MB）`);
      } catch { /* 不存在/占用 */ }
    }
    return freed;
  }

  /**
   * 孤儿派生行巡检（默认关）：源视频文件已不存在 → purge 该视频的派生行与输出目录。
   * 保守取舍：共享存储瞬时不可见可能造成批量误删，所以只有 VIDEO_ORPHAN_SWEEP=1 才执行；
   * 开启后每 10 分钟一轮，running 行不动（避免删掉正在写的任务）。
   */
  private sweepOrphanRows(): void {
    if (!this.capacity.orphanSweep) return;
    const now = Date.now();
    if (now - this.lastOrphanSweepAt < 10 * 60_000) return;
    this.lastOrphanSweepAt = now;
    void this.runOrphanSweep().catch((e) => this.log.warn(`孤儿巡检失败（不影响主流程）: ${(e as Error).message}`));
  }

  private async runOrphanSweep(): Promise<void> {
    const rows = await this.repo().find() as any[];
    const names = new Set<string>(rows.filter((r) => r.status !== 'running').map((r) => r.file_name));
    const orphans: string[] = [];
    for (const name of names) {
      const src = this.videos.filePathOf(name);
      if (!src || !fs.existsSync(src)) orphans.push(name);
    }
    for (const name of orphans) await this.derivatives.purge(name);
    if (orphans.length > 0) {
      this.log.warn(`孤儿派生行巡检: 清理 ${orphans.length} 个源视频已不存在的派生记录与输出目录（VIDEO_ORPHAN_SWEEP=1）`);
    }
  }

  private repo() {
    return this.ds.getRepository(VideoDerivative);
  }
}
