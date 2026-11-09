import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { VideoDerivative } from '../../entities/video-derivative.entity';
import { dirBytes, diskGuardRuntime, loadCapacityConfig } from './derivative-capacity';
import { retentionRuntime } from '../../core/alert/alert-runtime';

/** 派生类型（SPEC-VID-P0 §3） */
export type DerivativeKind = 'proxy' | 'sprite' | 'index';
export const DERIVATIVE_KINDS: readonly DerivativeKind[] = ['proxy', 'sprite', 'index'];

/** 派生 meta 视图（端点 2/4 返回形状；不含磁盘 path，避免暴露服务端布局） */
export interface DerivativeMetaView {
  kind: string;
  status: string;
  size: number | null;
  frames: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vfr: boolean | null;
  retry: number;
  error_msg: string | null;
  updated_at: Date | null;
}

/**
 * 视频派生服务（SPEC-VID-P0 §3/§4）：入队（幂等）+ meta 查询 + 文件定位。
 * ffmpeg 实际执行由 DerivativeWorkerService 负责（本服务不跑重活）。
 */
@Injectable()
export class DerivativeService {
  private readonly log = new Logger('DerivativeService');
  /** 存储布局（Spec §3）：storage/videos/derived/<uuid>/{proxy.mp4,sprite.jpg,sprite.json,index.json} */
  private readonly derivedDir = path.resolve(process.cwd(), 'storage', 'videos', 'derived');

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 派生输出目录：<uuid> 取自 file_name 去扩展名 */
  dirOf(fileName: string): string {
    return path.join(this.derivedDir, fileName.replace(/\.mp4$/, ''));
  }

  /** 派生根目录（worker 磁盘治理 du 用） */
  rootOf(): string {
    return this.derivedDir;
  }

  /**
   * 入队派生（Spec §4-1，幂等）：
   *  - 无行 → 插入 pending；
   *  - ready → 不动（重复请求不重转）；
   *  - error 且 retry<2 → 重置 pending 重入队；error 且 retry>=2 → 终态，不重入；
   *  - pending/running → 已在队列，不动；
   *  - evicted（P0.5 LRU 已淘汰）→ 重置 pending 按需再生成（retry 归零，历史 error 不累计）。
   */
  async derive(fileName: string, kinds?: DerivativeKind[]): Promise<DerivativeMetaView[]> {
    const wanted = this.normalizeKinds(kinds);
    const repo = this.repo();
    for (const kind of wanted) {
      const row = await this.findRow(fileName, kind);
      if (!row) {
        try {
          await repo.insert({
            id: randomUUID(), file_name: fileName, kind, status: 'pending', retry: 0,
          } as any);
        } catch (e) {
          // 并发插入撞唯一键 → 视为已入队（幂等），其余错误照抛
          if (!/duplicate|unique|2627|23000/i.test(String(e))) throw e;
        }
      } else if (row.status === 'evicted') {
        await repo.update({ id: row.id }, { status: 'pending', retry: 0, error_msg: null, updated_at: new Date() } as any);
      } else if (row.status === 'error' && row.retry < 2) {
        await repo.update({ id: row.id }, { status: 'pending', error_msg: null, updated_at: new Date() } as any);
      }
    }
    return this.listMeta(fileName);
  }

  /** 该视频全部派生 meta（Spec §4-2） */
  async listMeta(fileName: string): Promise<DerivativeMetaView[]> {
    const rows = await this.repo().find({
      where: { file_name: fileName } as any,
      order: { kind: 'ASC' },
    } as any) as any[];
    return rows.map((r) => this.view(r));
  }

  async findRow(fileName: string, kind: DerivativeKind): Promise<VideoDerivative | null> {
    const row = await this.repo().findOne({ where: { file_name: fileName, kind } } as any) as any;
    return row ?? null;
  }

  /** 派生文件磁盘路径（Spec §4-3）：仅 ready 且文件存在；kind 限 proxy/sprite。
   *  proxy 命中时回写 last_accessed_at（P0.5 LRU 时钟——发过一次就算被访问，失败仅少一次刷新）。 */
  async fileOf(fileName: string, kind: 'proxy' | 'sprite'): Promise<string | null> {
    const row = await this.findRow(fileName, kind);
    if (!row || row.status !== 'ready' || !row.path) return null;
    try {
      if (!fs.existsSync(row.path)) return null;
      if (kind === 'proxy') {
        this.repo().update({ id: row.id }, { last_accessed_at: new Date() } as any).catch(() => undefined);
      }
      return row.path;
    } catch {
      return null;
    }
  }

  /**
   * 单 kind meta（Spec §4-4，探活用）：
   * sprite/index 在 ready 后附带对应 json 载荷（sprite.json / index.json）。
   */
  async metaPayload(fileName: string, kind: DerivativeKind): Promise<(DerivativeMetaView & { payload?: unknown }) | null> {
    const row = await this.findRow(fileName, kind);
    if (!row) return null;
    const view: DerivativeMetaView & { payload?: unknown } = this.view(row);
    if (row.status !== 'ready') return view;
    const jsonName = kind === 'sprite' ? 'sprite.json' : kind === 'index' ? 'index.json' : null;
    if (!jsonName) return view;
    try {
      view.payload = JSON.parse(fs.readFileSync(path.join(this.dirOf(fileName), jsonName), 'utf8'));
    } catch (e) {
      // json 缺失/损坏不阻断探活（meta 状态仍有效），记日志即可
      this.log.warn(`派生 json 载荷读取失败 ${fileName}/${kind}: ${(e as Error).message}`);
    }
    return view;
  }

  /** 清理指定视频的派生记录与输出目录（源视频删除时由上层/管理员调用） */
  async purge(fileName: string): Promise<void> {
    await this.repo().delete({ file_name: fileName } as any).catch(() => undefined);
    try { fs.rmSync(this.dirOf(fileName), { recursive: true, force: true }); } catch { /* 无目录 */ }
  }

  /**
   * 容量观测口径（P0-1，GET /api/videos/storage）：
   * 让运维/验证脚本能看见"参数配了没、现在占多大、淘汰过几次、最后一次告警何时"。
   * 只回显总量与配置状态，不暴露服务端磁盘布局。
   */
  async capacitySnapshot(): Promise<Record<string, unknown>> {
    const c = loadCapacityConfig();
    const root = this.rootOf();
    const bytes = fs.existsSync(root) ? dirBytes(root) : 0;
    const proxyReady = await this.repo().count({ where: { kind: 'proxy', status: 'ready' } as any }).catch(() => 0);
    const proxyEvicted = await this.repo().count({ where: { kind: 'proxy', status: 'evicted' } as any }).catch(() => 0);
    return {
      max_gb: c.maxGb,
      max_gb_configured: c.maxGbConfigured,
      max_gb_raw: c.maxGbRaw || null,
      concurrency: c.concurrency,
      concurrency_configured: c.concurrencyConfigured,
      derive_timeout_min: c.deriveTimeoutMin,
      derive_timeout_configured: c.deriveTimeoutConfigured,
      stale_run_min: c.staleRunMin,
      du_sec: c.duSec,
      auto_derive: c.autoDerive,
      orphan_sweep: c.orphanSweep,
      derived_bytes: bytes,
      derived_gb: Number((bytes / 1024 ** 3).toFixed(3)),
      proxy_ready: proxyReady,
      proxy_evicted: proxyEvicted,
      disk_over_limit: diskGuardRuntime.overLimit,
      source_active_gb: Number((diskGuardRuntime.sourceActiveBytes / 1024 ** 3).toFixed(3)),
      source_permanent_gb: Number((diskGuardRuntime.sourcePermanentBytes / 1024 ** 3).toFixed(3)),
      last_disk_alert_at: diskGuardRuntime.lastAlertAt ? new Date(diskGuardRuntime.lastAlertAt).toISOString() : null,
      last_disk_sweep_at: diskGuardRuntime.lastSweepAt ? new Date(diskGuardRuntime.lastSweepAt).toISOString() : null,
      evicted_total: diskGuardRuntime.evictedTotal,
      // 源视频保留策略（到期提醒/硬删）观测
      retention_days: c.retentionDays,
      retention_days_configured: c.retentionDaysConfigured,
      notice_days: c.noticeDays,
      notice_days_configured: c.noticeDaysConfigured,
      notice_retry_hours: c.notifyRetryHours,
      last_retention_sweep_at: retentionRuntime.lastSweepAt ? new Date(retentionRuntime.lastSweepAt).toISOString() : null,
      retention_deleted_total: retentionRuntime.deletedTotal,
      retention_delete_failures: retentionRuntime.deleteFailuresTotal,
      retention_notice_failures: retentionRuntime.noticeFailuresTotal,
    };
  }

  private view(row: any): DerivativeMetaView {
    return {
      kind: row.kind,
      status: row.status,
      // mssql bigint 驱动可能返回字符串，统一归一为数字
      size: row.size == null ? null : Number(row.size),
      frames: row.frames == null ? null : Number(row.frames),
      duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      fps: row.fps == null ? null : Number(row.fps),
      vfr: row.vfr == null ? null : Boolean(row.vfr),
      retry: Number(row.retry ?? 0),
      error_msg: row.error_msg ?? null,
      updated_at: row.updated_at ?? null,
    };
  }

  /** kinds 归一：去重 + 白名单校验；缺省 = 全三种 */
  private normalizeKinds(kinds?: DerivativeKind[]): DerivativeKind[] {
    const list = kinds && kinds.length > 0 ? kinds : [...DERIVATIVE_KINDS];
    const uniq = [...new Set(list)];
    for (const k of uniq) {
      if (!DERIVATIVE_KINDS.includes(k as DerivativeKind)) {
        throw new BadRequestException(`非法派生类型 ${String(k)}（仅支持 proxy/sprite/index）`);
      }
    }
    return uniq as DerivativeKind[];
  }

  private repo() {
    return this.ds.getRepository(VideoDerivative);
  }
}
