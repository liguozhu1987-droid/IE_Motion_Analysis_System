import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../../core/config/configuration';
import { AuditService } from '../../audit/audit.service';
import { AuthUser, AuthedRequest } from '../auth-user.interface';
import { AuthUserLoader } from '../auth-user.loader';
import { clientIp } from '../auth.service';
import { User } from '../../entities/user.entity';
import { SsoUser, SsoUserMap } from '../../entities/sso.entity';
import { IdTokenClaims } from './oidc-client.service';

/** 准入 / 身份解析拒绝原因：作为 `#/oidc/callback?error=<code>` 的前端可读错误码 */
export class SsoRejectedError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'SsoRejectedError';
  }
}

export interface SsoIdentity {
  userId: string;
  username: string;
  tenantId: string;
  provisioned: boolean;
}

const DEFAULT_TENANT = 'DEFAULT';

/**
 * 统一身份解析（交底书 §6.4 顺序的本地实现）：
 *  1) groups 准入校验
 *  2) 中央表 CN_AME_SSO_User 按 login_name 命中（D10：查无此人 → 拒绝 + 审计）
 *  3) 中央 status 必须为在职
 *  4) CN_AME_SSO_UserMap(system_code, employee_no) → 本地用户名，未命中回落 preferred_username
 *  5) 本地 t_user 按 employee_no 或 username 命中 → 登录
 *  6) 未命中且允许自动建档（D2）→ 建号 + 赋默认角色 viewer（D3）
 *  D4：角色永远取自本地 t_role，不从中央表回写/覆盖。
 */
@Injectable()
export class SsoIdentityService {
  private readonly log = new Logger('SsoIdentity');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly audit: AuditService,
    private readonly loader: AuthUserLoader,
  ) {}

  async resolve(claims: IdTokenClaims, req: AuthedRequest): Promise<SsoIdentity> {
    const ip = clientIp(req);
    const loginName = String(claims.preferred_username ?? '').trim();

    /* 1) 准入组：Keycloak 组路径可能带前导 '/'（如 /app-ie），两种写法都认 */
    const required = this.cfg.authOidcRequiredGroup.replace(/^\/+/, '');
    if (required) {
      const groups = (Array.isArray(claims.groups) ? claims.groups : []).map((g) => String(g).replace(/^\/+/, ''));
      if (!groups.includes(required)) {
        throw this.rejectOf(loginName, 'group_denied', ip, { groups, required });
      }
    }
    if (!loginName) throw this.rejectOf(loginName, 'identity_invalid', ip, { reason: 'missing preferred_username' });

    /* 2) 中央人员表：只读；表不存在/网络异常时明确失败，不猜测放行 */
    let central: SsoUser | null = null;
    try {
      central = await this.ds.getRepository(SsoUser).findOne({ where: { login_name: loginName } });
    } catch (e) {
      this.log.error(`中央人员表读取失败：${(e as Error).message}`);
      this.audit.record(null, 'sso.login_rejected', 'user', loginName, null, { reason: 'directory_unavailable' }, ip);
      throw new SsoRejectedError('directory_unavailable', 'SSO 中央人员表不可用');
    }
    if (!central) throw this.rejectOf(loginName, 'central_not_found', ip, {});
    if (Number(central.status) !== 1) throw this.rejectOf(loginName, 'account_disabled', ip, { employeeNo: central.employee_no });

    /* 3) 本地用户名映射（IE 系统编码固定 AUTH_OIDC_SYSTEM_CODE，默认 'ie'） */
    let localUsername = String(central.login_name ?? '').trim();
    try {
      const map = await this.ds.getRepository(SsoUserMap).findOne({
        where: { employee_no: central.employee_no, system_code: this.cfg.authOidcSystemCode },
      });
      if (map?.local_username) localUsername = String(map.local_username).trim();
    } catch (e) {
      /* 映射表故障不该让人登不进来：回落 preferred_username 并记日志 */
      this.log.warn(`UserMap 读取失败，回落 login_name：${(e as Error).message}`);
    }

    /* 4) 本地账号：先按工号，再按用户名（合同 §6.4 步骤 3-5） */
    const userRepo = this.ds.getRepository(User);
    let user = await userRepo.findOne({ where: { employee_no: central.employee_no } });
    if (!user) user = await userRepo.findOne({ where: { username: localUsername } });

    if (user) {
      /* 用户名命中但工号属于另一个人 → 典型账号接管风险，拒绝而非自动改绑 */
      if (user.employee_no && user.employee_no !== central.employee_no) {
        throw this.rejectOf(loginName, 'employee_conflict', ip, {
          employeeNo: central.employee_no, boundEmployeeNo: user.employee_no, username: user.username,
        });
      }
      if (String(user.status) !== 'active') throw this.rejectOf(loginName, 'account_inactive', ip, { username: user.username, status: user.status });

      /* 首次以 SSO 身份进入的本地账号：绑定工号 + 标记来源（只用于 /auth/me 展示与离职回写范围） */
      if (!user.employee_no || user.auth_source !== 'oidc') {
        await userRepo.update({ user_id: user.user_id }, {
          employee_no: central.employee_no,
          auth_source: 'oidc',
        } as any);
        this.loader.invalidate(user.user_id);
      }
      this.audit.record(
        this.minimalUser(user, central), 'sso.login', 'user', user.user_id, null,
        { loginName, employeeNo: central.employee_no, provisioned: false }, ip,
      );
      return { userId: user.user_id, username: user.username, tenantId: user.tenant_id, provisioned: false };
    }

    /* 5) 自动建档（D2）；D10 的“中央表查无此人”已在上面拒绝，这里只处理“中央有、本地无” */
    if (!this.cfg.authOidcAutoProvision) throw this.rejectOf(loginName, 'account_not_provisioned', ip, { employeeNo: central.employee_no });
    return this.provision(central, localUsername, loginName, ip);
  }

  private async provision(central: SsoUser, username: string, loginName: string, ip: string): Promise<SsoIdentity> {
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw this.rejectOf(loginName, 'username_invalid', ip, { username });

    const roleId = `r_${DEFAULT_TENANT}_${this.cfg.authOidcDefaultRole}`;
    const role = await this.ds.getRepository('t_role').findOne({ where: { role_id: roleId } } as any) as any;
    if (!role) {
      this.log.error(`默认角色 ${roleId} 不存在，拒绝自动建档（D3 需要 viewer 角色已种子化）`);
      throw this.rejectOf(loginName, 'provision_failed', ip, { reason: `role ${roleId} missing` });
    }

    const userId = `u_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
    const userRepo = this.ds.getRepository(User);
    try {
      await userRepo.insert({
        user_id: userId,
        tenant_id: DEFAULT_TENANT,
        username,
        display_name: String(central.display_name ?? username).slice(0, 32),
        email: central.email ?? null,
        password_hash: '!', // 非 bcrypt 哈希：本地密码登录会被明确拒绝并提示走 SSO
        status: 'active',
        must_change_pwd: 0, // D7：SSO 用户跳过强制改密
        data_scope: 'own',
        employee_no: central.employee_no,
        auth_source: 'oidc',
        failed_count: 0,
        locked_until: null,
      } as any);
      await this.ds.getRepository('t_user_role').insert({ user_id: userId, role_id: roleId } as any);
    } catch (e) {
      this.log.error(`自动建档失败 ${username}：${(e as Error).message}`);
      throw this.rejectOf(loginName, 'provision_failed', ip, { username, reason: 'insert failed' });
    }

    this.loader.invalidate(userId);
    this.audit.record(null, 'sso.provision', 'user', userId, null,
      { username, employeeNo: central.employee_no, role: this.cfg.authOidcDefaultRole, loginName }, ip);
    this.audit.record(null, 'sso.login', 'user', userId, null,
      { loginName, employeeNo: central.employee_no, provisioned: true }, ip);
    return { userId, username, tenantId: DEFAULT_TENANT, provisioned: true };
  }

  private minimalUser(user: any, central: SsoUser): AuthUser {
    return {
      userId: user.user_id,
      username: user.username,
      displayName: user.display_name ?? central.display_name ?? user.username,
      tenantId: user.tenant_id,
      roles: [],
      permissions: new Set<string>(),
      mustChangePwd: false,
      dataScope: 'own',
      employeeNo: central.employee_no,
      authSource: 'oidc',
    };
  }

  /** 审计 + 日志后返回错误对象；调用点统一 `throw this.rejectOf(...)`，保证类型收窄可用 */
  private rejectOf(loginName: string, code: string, ip: string, detail: Record<string, any>): SsoRejectedError {
    this.audit.record(null, 'sso.login_rejected', 'user', loginName || null, null, { code, ...detail }, ip);
    this.log.warn(`SSO 登录拒绝 code=${code} login=${loginName || '-'} detail=${JSON.stringify(detail)}`);
    return new SsoRejectedError(code);
  }
}
