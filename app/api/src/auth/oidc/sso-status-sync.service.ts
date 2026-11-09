import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../../core/config/configuration';
import { AuditService } from '../../audit/audit.service';
import { AuthUserLoader } from '../auth-user.loader';
import { User } from '../../entities/user.entity';
import { SsoUser } from '../../entities/sso.entity';

const SYNC_INTERVAL_MS = 3600_000; // 每小时（D11：复用每小时任务，不额外引入调度器）

/**
 * 中央人员状态回写（D11）：中央 `status=0`（离职/停用）→ 本地置 `disabled` 并吊销全部 refresh 令牌，
 * 账号与历史数据保留、不物理删除。
 *
 * 刻意的单向策略（与交底书 BOL §8「status=1 恢复 ACTIVE」不同）：
 *  - 只做「停用」不做「自动恢复」——本地管理员手工停用的 SSO 账号不会被下一次同步复活；
 *  - 复职由管理员在用户管理页手工启用（一步操作，语义明确）。
 *  差异已记入 docs/identity/SSO-INTEGRATION-PLAN.md「与交底书的差异」。
 *
 * 中央表查无此人时跳过（打 warn 一次）：同步作业本身异常时不应把人误锁。
 */
@Injectable()
export class SsoStatusSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SsoStatusSync');
  private timer?: NodeJS.Timeout;
  private warnedMissing = new Set<string>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly audit: AuditService,
    private readonly loader: AuthUserLoader,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.authOidcEnabled) return; // SSO 关闭时零查询、零行为变化
    await this.tick('startup'); // 启动先跑一次：部署窗口内离职人员不会被放进来登录
    this.timer = setInterval(() => { void this.tick('hourly'); }, SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 单轮同步；所有异常吞掉并记日志，不能拖垮应用启动或定时器 */
  async tick(phase: 'startup' | 'hourly'): Promise<void> {
    try {
      const central = await this.ds.getRepository(SsoUser).find();
      const byEmployee = new Map(central.map((r) => [String(r.employee_no), r]));
      const locals = await this.ds.getRepository(User).find({ where: { auth_source: 'oidc' } });
      let disabled = 0;

      for (const user of locals) {
        if (!user.employee_no) continue;
        const row = byEmployee.get(user.employee_no);
        if (!row) {
          if (!this.warnedMissing.has(user.employee_no)) {
            this.warnedMissing.add(user.employee_no);
            this.log.warn(`中央表无工号 ${user.employee_no}（本地用户 ${user.username}），跳过同步（不自动禁用）`);
          }
          continue;
        }
        if (Number(row.status) === 0 && String(user.status) === 'active') {
          await this.ds.getRepository(User).update({ user_id: user.user_id }, { status: 'disabled' });
          await this.ds.getRepository('t_refresh_token').update({ user_id: user.user_id } as any, { revoked: 1 } as any);
          this.loader.invalidate(user.user_id);
          this.audit.record(null, 'sso.status_sync', 'user', user.user_id, { status: 'active' }, { status: 'disabled', employeeNo: user.employee_no }, '-');
          disabled++;
        }
      }

      if (disabled > 0) this.log.warn(`[${phase}] 按中央人员表停用 ${disabled} 个 SSO 账号（已吊销刷新令牌）`);
      else this.log.debug(`[${phase}] 中央人员状态同步完成，无变更`);
    } catch (e) {
      this.log.error(`[${phase}] 中央人员状态同步失败：${(e as Error).message}`);
    }
  }
}
