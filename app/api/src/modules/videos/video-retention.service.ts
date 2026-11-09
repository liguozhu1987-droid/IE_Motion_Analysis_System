import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Not } from 'typeorm';
import * as fs from 'fs';
import { VideoAsset } from '../../entities/video-asset.entity';
import { VideoDerivative } from '../../entities/video-derivative.entity';
import { AuthUser } from '../../auth/auth-user.interface';
import { AuditService } from '../../audit/audit.service';
import { AlertMailerService } from '../../core/alert/mailer.service';
import { retentionRuntime } from '../../core/alert/alert-runtime';
import { StationsService } from '../stations/stations.service';
import { CapacityConfig, loadCapacityConfig } from './derivative-capacity';
import { VideosService } from './videos.service';
import { DerivativeService } from './derivative.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionAction = 'extend' | 'permanent';

export interface RetentionSweepResult {
  scanned: number;
  deleted: number;
  failed: number;
  notices: number;
  failedNotices: number;
}

export interface VideoAssetView {
  file_name: string;
  tenant_id: string;
  owner_user_id: string;
  owner_username: string | null;
  created_at: Date;
  retention_status: string;
  retention_until: Date | null;
  /** 距离到期天数（向上取整）；永久保留为 null */
  days_left: number | null;
  notified_at: Date | null;
  notify_attempts: number;
  /** 当前调用者是否可以操作（上传者本人或全权管理员） */
  can_manage: boolean;
  play_url: string;
}

/**
 * 源视频保留策略（用户决策 2026-11-06）。
 *
 * 口径：
 *  - 默认保留 VIDEO_RETENTION_DAYS（默认 10）天，到期前 VIDEO_RETENTION_NOTICE_DAYS（默认 3）天邮件提醒；
 *  - 上传者本人或全权管理员可选择「再保留 10 天」（extend）或「永久保留」（permanent）；
 *  - 到期前未做任何选择 → 自动硬删：源文件 + 派生目录/行一并删除，不做回收站；
 *  - 删除写 t_audit_log（来源 auto_expired / manual）；失败保留记录、写 error 日志 + 计数 + 告警邮件（节流 1h），下轮重试；
 *  - 通知失败不阻断删除；成功通知只发一次，失败按 VIDEO_RETENTION_NOTIFY_RETRY_HOURS 冷却重试。
 *
 * 该任务是业务功能，默认按真实执行落库/落盘（非干跑）；扫描每小时一轮 + 启动立即一轮。
 * 单实例部署前提（与派生 worker 相同），进程内 sweeping 标志防重入。
 */
@Injectable()
export class VideoRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('VideoRetention');
  private readonly capacity: CapacityConfig;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly videos: VideosService,
    private readonly derivatives: DerivativeService,
    private readonly stations: StationsService,
    private readonly mailer: AlertMailerService,
    private readonly audit: AuditService,
  ) {
    this.capacity = loadCapacityConfig();
  }

  onModuleInit(): void {
    this.warnUnconfigured();
    void this.tick();
    // 小时级足够：提前 3 天窗口 + 到期日删除，不需要分钟级扫描
    this.timer = setInterval(() => { void this.tick(); }, 3600_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 参数缺失/未确认的启动期显式告警（项目铁律「不猜数字」） */
  private warnUnconfigured(): void {
    const c = this.capacity;
    if (!c.retentionDaysConfigured) {
      this.log.warn(`VIDEO_RETENTION_DAYS 未配置，使用默认 ${c.retentionDays} 天（待现场确认）`);
    }
    if (!c.noticeDaysConfigured) {
      this.log.warn(`VIDEO_RETENTION_NOTICE_DAYS 未配置，使用默认 ${c.noticeDays} 天（待现场确认）`);
    }
    if (!c.notifyRetryConfigured) {
      this.log.warn(`VIDEO_RETENTION_NOTIFY_RETRY_HOURS 未配置，通知失败按默认 ${c.notifyRetryHours} 小时冷却重试`);
    }
    if (!this.mailer.smtpReady) {
      this.log.warn('SMTP_HOST 未配置：源视频到期提醒只写日志，不会发出邮件（站内列表/详情状态仍可见）');
    }
  }

  private async tick(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (e) {
      // 扫描整体失败（如数据库不可用）→ 下一小时重试；不吞错
      this.log.error(`源视频保留扫描失败（下轮重试）: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * 一轮扫描（public：运维/验证脚本可直接调用；now 可注入便于隔离测试）。
   * 顺序：先提醒（窗口内）→ 再删除（到期）；删除前发最后一次提醒，失败不阻断删除。
   */
  async sweep(now: Date = new Date()): Promise<RetentionSweepResult> {
    const result: RetentionSweepResult = { scanned: 0, deleted: 0, failed: 0, notices: 0, failedNotices: 0 };
    const repo = this.ds.getRepository(VideoAsset);
    const rows = await repo.find({ where: { retention_status: Not('permanent') } as any }) as any[];
    result.scanned = rows.length;

    for (const row of rows) {
      const until = this.effectiveUntil(row);
      if (!until) continue;

      // 历史行（迁移前上传，retention_until 为 NULL）惰性回填，避免永远不进入保留期
      if (!row.retention_until) {
        await repo.update({ file_name: row.file_name }, { retention_until: until } as any)
          .catch((e) => this.log.warn(`保留期回填失败（本行跳过，下轮重试）: ${row.file_name} ${(e as Error).message}`));
      }

      if (until.getTime() <= now.getTime()) {
        // 到期：先发最后一次提醒（失败也继续删）→ 硬删
        await this.notify(row, now, until, true);
        const ok = await this.hardDelete(row, 'auto_expired', null, 'system');
        if (ok) result.deleted += 1;
        else result.failed += 1;
        continue;
      }

      // 到期前通知窗口：成功通知一次即止；失败按冷却重试（不每天轰炸）
      const noticeStart = until.getTime() - this.capacity.noticeDays * DAY_MS;
      if (now.getTime() >= noticeStart
        && !row.notified_at
        && this.cooldownPassed(row.last_notify_at, now)) {
        const ok = await this.notify(row, now, until, false);
        result.notices += 1;
        if (!ok) result.failedNotices += 1;
      }
    }

    retentionRuntime.lastSweepAt = now.getTime();
    retentionRuntime.lastDeletes = result.deleted;
    retentionRuntime.lastDeleteFailures = result.failed;
    retentionRuntime.lastNotices = result.notices;
    if (result.notices || result.deleted || result.failed) {
      this.log.log(`保留扫描完成: 扫描 ${result.scanned}，提醒 ${result.notices}（失败 ${result.failedNotices}），`
        + `删除 ${result.deleted}（失败 ${result.failed}）`);
    }
    return result;
  }

  /** 有效到期时间：permanent→null；有 retention_until 用其值；历史 NULL 按 created_at+保留天数 */
  private effectiveUntil(row: any): Date | null {
    if (row.retention_status === 'permanent') return null;
    if (row.retention_until) return new Date(row.retention_until);
    const created = new Date(row.created_at);
    if (Number.isNaN(created.getTime())) return null;
    return new Date(created.getTime() + this.capacity.retentionDays * DAY_MS);
  }

  private cooldownPassed(last: Date | string | null | undefined, now: Date): boolean {
    if (!last) return true;
    const t = new Date(last).getTime();
    if (Number.isNaN(t)) return true;
    return now.getTime() - t >= this.capacity.notifyRetryHours * 3600_000;
  }

  /** 发送到期提醒（final=true 为删除前最后一次）；失败只记账/日志，绝不抛出 */
  private async notify(row: any, now: Date, until: Date, final: boolean): Promise<boolean> {
    const recipient = await this.emailOf(row.owner_user_id);
    const days = Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
    const subject = final
      ? `源视频到期删除：${row.owner_username || row.file_name}`
      : `源视频将在 ${days} 天后到期：${row.owner_username || row.file_name}`;
    const choice = `请登录平台，在视频列表/工作台的保留提示中选择「再保留 ${this.capacity.retentionDays} 天」或「永久保留」；`
      + '不做选择将于到期时间自动删除源视频及其派生文件（不可恢复）。';
    const text = [
      `视频文件：${row.file_name}`,
      `上传时间：${new Date(row.created_at).toISOString()}`,
      `到期时间：${until.toISOString()}`,
      final
        ? '本邮件为删除前最后一次提醒：系统即将删除该源视频与派生文件（proxy/sprite/index）。'
        : `该视频已进入到期前 ${this.capacity.noticeDays} 天提醒窗口。`,
      choice,
    ].join('\n');

    let ok = false;
    if (!recipient) {
      this.log.warn(`到期提醒未发送：上传者无邮箱（${row.owner_user_id}） ${row.file_name}`);
    } else {
      ok = await this.mailer.sendTo(recipient, subject, text);
      if (!ok) this.log.warn(`到期提醒发送失败（已计数，按冷却重试）: ${row.file_name} → ${recipient}`);
    }
    if (!ok) retentionRuntime.noticeFailuresTotal += 1;

    const attempts = Number(row.notify_attempts ?? 0) + 1;
    const patch: Record<string, unknown> = { last_notify_at: now, notify_attempts: attempts };
    if (ok && !row.notified_at) patch.notified_at = now;
    await this.ds.getRepository(VideoAsset).update({ file_name: row.file_name }, patch as any)
      .catch((e) => this.log.warn(`提醒状态回写失败（不影响后续扫描）: ${row.file_name} ${(e as Error).message}`));
    return ok;
  }

  private async emailOf(userId: string): Promise<string | null> {
    try {
      const u = await this.ds.getRepository('t_user').createQueryBuilder('u')
        .select(['u.email'])
        .where('u.user_id = :id', { id: userId })
        .getOne() as any;
      const email = (u?.email ?? '').trim();
      return email || null;
    } catch {
      return null;
    }
  }

  /**
   * 硬删：派生目录/行 → 源文件 → 归属行。
   * 任一步失败：保留归属行（下轮重试），写审计 delete_failed + error 日志 + 告警邮件（1h 节流）。
   */
  private async hardDelete(
    row: any, source: 'auto_expired' | 'manual', actor: AuthUser | null, ip: string,
  ): Promise<boolean> {
    const before = {
      file_name: row.file_name,
      tenant_id: row.tenant_id,
      owner_user_id: row.owner_user_id,
      owner_username: row.owner_username,
      created_at: row.created_at,
      retention_status: row.retention_status,
      retention_until: row.retention_until,
    };
    try {
      // 1) 派生行 + 输出目录（strict：失败必须暴露，不能像 purge 那样吞）
      await this.ds.getRepository(VideoDerivative).delete({ file_name: row.file_name } as any);
      fs.rmSync(this.derivatives.dirOf(row.file_name), { recursive: true, force: true });

      // 2) 源文件（hard delete；删除后再验一次，防 Windows 文件占用时 rm 静默）
      const src = this.videos.filePathOf(row.file_name);
      if (src && fs.existsSync(src)) fs.rmSync(src, { force: true });
      if (src && fs.existsSync(src)) throw new Error('源文件删除后仍存在（可能被占用）');

      // 3) 归属行
      await this.ds.getRepository(VideoAsset).delete({ file_name: row.file_name } as any);

      retentionRuntime.deletedTotal += 1;
      this.audit.record(actor, 'video.delete', 'video_asset', row.file_name, before,
        { deleted: true, source }, ip);
      this.log.warn(`源视频硬删完成: ${row.file_name}（来源 ${source}${actor ? `，操作人 ${actor.username}` : ''}）`);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      retentionRuntime.deleteFailuresTotal += 1;
      this.log.error(`源视频删除失败（保留记录，下轮重试）: ${row.file_name}（来源 ${source}）: ${msg}`);
      this.audit.record(actor, 'video.delete_failed', 'video_asset', row.file_name, before,
        { deleted: false, source, error: msg }, ip);
      void this.alertDeleteFailure(row, msg);
      return false;
    }
  }

  /** 删除失败告警邮件（走既有 ALERT_MAIL_TO 通道；1 小时节流，避免故障期刷屏） */
  private async alertDeleteFailure(row: any, msg: string): Promise<void> {
    const now = Date.now();
    if (now - retentionRuntime.lastFailureAlertAt < 3600_000) return;
    retentionRuntime.lastFailureAlertAt = now;
    await this.mailer.send('源视频删除失败（保留期到期）', [
      `视频文件：${row.file_name}`,
      `上传者：${row.owner_username || row.owner_user_id}`,
      `失败原因：${msg}`,
      '系统保留该视频记录并在下一轮扫描重试；请检查文件占用/磁盘权限。',
    ].join('\n'));
  }

  // ───────────────────────── 查询与人工操作 ─────────────────────────

  /** 视频列表（默认带保留状态与操作入口；按调用者可见范围过滤） */
  async listAssets(user: AuthUser): Promise<VideoAssetView[]> {
    const repo = this.ds.getRepository(VideoAsset);
    const full = this.stations.hasFullAccess(user.roles);
    const rows = (await repo.find({
      where: full ? {} : { tenant_id: user.tenantId } as any,
      order: { created_at: 'DESC' },
    } as any)) as any[];
    const allowed = await this.visibilitySet(user, rows);
    const now = Date.now();
    return rows
      .filter((r) => allowed === null || allowed.has(r.file_name))
      .map((r) => this.toView(r, user, now));
  }

  /** 视频详情（保留状态 + 操作入口） */
  async getAsset(name: string, user: AuthUser): Promise<VideoAssetView> {
    const row = await this.ds.getRepository(VideoAsset).findOne({ where: { file_name: name } } as any) as any;
    if (!row) throw new NotFoundException('视频归属记录不存在');
    await this.videos.assertReadable(name, user);
    return this.toView(row, user, Date.now());
  }

  /**
   * 用户设置保留决定。
   * - extend：从当前时刻起再保留 VIDEO_RETENTION_DAYS 天，重置提醒状态（新窗口会再提醒）；
   * - permanent：永久保留（不再扫描/不再提醒）。
   * 权限：上传者本人或全权管理员。
   */
  async setDecision(name: string, action: RetentionAction, user: AuthUser, ip: string): Promise<VideoAssetView> {
    const repo = this.ds.getRepository(VideoAsset);
    const row = await repo.findOne({ where: { file_name: name } } as any) as any;
    if (!row) throw new NotFoundException('视频归属记录不存在');
    await this.assertManageable(row, user);

    const now = new Date();
    const patch = action === 'extend'
      ? {
        retention_status: 'extended',
        retention_until: new Date(now.getTime() + this.capacity.retentionDays * DAY_MS),
        notified_at: null,
        last_notify_at: null,
      }
      : { retention_status: 'permanent', retention_until: null, notified_at: null, last_notify_at: null };

    await repo.update({ file_name: name }, patch as any);
    const after = await repo.findOne({ where: { file_name: name } } as any) as any;
    this.audit.record(user, 'video.retention', 'video_asset', name,
      { retention_status: row.retention_status, retention_until: row.retention_until },
      { retention_status: after.retention_status, retention_until: after.retention_until, action }, ip);
    return this.toView(after, user, Date.now());
  }

  /** 立即硬删（上传者本人或全权管理员；审计来源 manual） */
  async deleteNow(name: string, user: AuthUser, ip: string): Promise<{ deleted: boolean }> {
    const repo = this.ds.getRepository(VideoAsset);
    const row = await repo.findOne({ where: { file_name: name } } as any) as any;
    if (!row) throw new NotFoundException('视频归属记录不存在');
    await this.assertManageable(row, user);
    const ok = await this.hardDelete(row, 'manual', user, ip);
    if (!ok) throw new Error('源视频删除失败（可能被占用），系统已保留记录并将重试');
    return { deleted: true };
  }

  private async assertManageable(row: any, user: AuthUser): Promise<void> {
    if (this.stations.hasFullAccess(user.roles)) return;
    if (row.owner_user_id === user.userId) return;
    throw new NotFoundException('该视频不在你的可管理范围（仅上传者本人或管理员可操作）');
  }

  /**
   * 列表可见集合：与 VideosService.assertReadable 同口径的批量版本。
   * null = 不限制（全权角色）。非全权：本人上传 ∪ 同租户+data_scope(tenant/all) ∪ 关联可见工位。
   */
  private async visibilitySet(user: AuthUser, rows: any[]): Promise<Set<string> | null> {
    if (this.stations.hasFullAccess(user.roles)) return null;
    const allowed = new Set<string>();
    for (const r of rows) {
      if (r.owner_user_id === user.userId) allowed.add(r.file_name);
      else if (r.tenant_id === user.tenantId && (user.dataScope === 'tenant' || user.dataScope === 'all')) {
        allowed.add(r.file_name);
      }
    }
    const visibleStations = await this.stations.visibleStationIds(
      user.userId, user.roles, user.tenantId, user.dataScope,
    ).catch(() => [] as string[]);
    if (visibleStations && visibleStations.length > 0) {
      try {
        const links = await this.ds.getRepository('t_element').createQueryBuilder('e')
          .select('DISTINCT e.video_id', 'video_id')
          .where('e.station_id IN (:...ids)', { ids: visibleStations })
          .andWhere('e.video_id IS NOT NULL')
          .getRawMany() as any[];
        for (const l of links) if (l.video_id) allowed.add(String(l.video_id));
      } catch (e) {
        this.log.warn(`视频列表关联工位查询失败（仅按本人/租户口径返回）: ${(e as Error).message}`);
      }
    }
    return allowed;
  }

  private toView(row: any, user: AuthUser, now: number): VideoAssetView {
    const until = this.effectiveUntil(row);
    const canManage = this.stations.hasFullAccess(user.roles) || row.owner_user_id === user.userId;
    return {
      file_name: row.file_name,
      tenant_id: row.tenant_id,
      owner_user_id: row.owner_user_id,
      owner_username: row.owner_username ?? null,
      created_at: row.created_at,
      retention_status: row.retention_status ?? 'auto',
      retention_until: until,
      days_left: until ? Math.max(0, Math.ceil((until.getTime() - now) / DAY_MS)) : null,
      notified_at: row.notified_at ?? null,
      notify_attempts: Number(row.notify_attempts ?? 0),
      can_manage: canManage,
      play_url: `/api/videos/file/${row.file_name}`,
    };
  }
}
