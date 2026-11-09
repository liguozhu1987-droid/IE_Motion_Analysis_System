import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { AuthService, clientIp, validatePassword } from '../../auth/auth.service';
import { AuthUserLoader } from '../../auth/auth-user.loader';
import { AuthedRequest } from '../../auth/auth-user.interface';
import {
  RBAC_TENANT as SCOPE_TENANT, adminCapableRoleIds, assertNotLockout, certStatusOf,
} from '../../rbac/rbac-guard';

/**
 * 合法角色 code：v3.50 起**不再硬编码**——以 t_role（DEFAULT 租户）为唯一来源，
 * 管理员新建的自定义角色自动进入可选范围（与 RolesService 同源，避免两处字典漂移）。
 * 下方常量仅作「库不可用时的兜底」与前端展示顺序参考。
 */
const FALLBACK_ROLE_CODES = ['sys_admin', 'ie_admin', 'ie_engineer', 'line_leader', 'viewer'];
/** 数据范围（行级）：own=仅本人 / line=本产线 / tenant=本租户 / all=全集团 */
const DATA_SCOPES = ['own', 'line', 'tenant', 'all'];
/** 方法资质等级（借鉴 MTM Blue Card / MOST 分级认证；none=未认证） */
const CERT_LEVELS = ['none', 'L1', 'L2', 'L3'];

export interface CreateUserInput {
  username: string; password: string; displayName?: string; email?: string; roles: string[];
  department?: string; position?: string; employeeNo?: string;
  dataScope?: string; certLevel?: string; certExpiresAt?: string;
}
export interface UpdateUserInput {
  displayName?: string; email?: string; status?: string;
  department?: string; position?: string; employeeNo?: string;
  dataScope?: string; certLevel?: string; certExpiresAt?: string;
}
/** v3.58：列表筛选（角色维度 + 资质状态维度） */
export interface ListUserQuery {
  status?: string; keyword?: string; department?: string; role?: string; certStatus?: string;
}

/**
 * 用户管理（sys_admin，权限点 user:read / user:write）：
 * 列表 / 建号 / 改资料 / 停启用 / 角色全量替换 / 注册审批（approve/reject）/
 * 代置临时口令（一次性返回）/ 下发重置码（一次性返回明文）/ 重置申请列表（helpdesk 用）。
 */
@Injectable()
export class UsersService {
  private readonly log = new Logger('UsersService');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly auth: AuthService,
    private readonly loader: AuthUserLoader,
  ) {}

  /**
   * 用户列表（DEFAULT 租户，含角色聚合；status/keyword/department/role/certStatus 可选过滤）。
   * v3.58 增 summary：按状态/角色/部门计数 + 资质临期人数——回答「现在有多少人待审批、
   * 多少人的方法资质快到期」，对应行业软件「多站点组织维度 + 方法认证有效期」的人员台账。
   */
  async list(query: ListUserQuery): Promise<{
    users: any[]; pendingCount: number; departments: string[];
    summary: { byStatus: any[]; byRole: any[]; byDepartment: any[]; certExpiring: number; total: number };
  }> {
    const users = (await this.ds.getRepository('t_user').find({
      where: { tenant_id: SCOPE_TENANT },
      order: { created_at: 'DESC' },
    } as any)) as any[];
    let rows = users;
    if (query.status) rows = rows.filter((u) => u.status === query.status);
    if (query.department) {
      const dep = query.department.trim();
      rows = rows.filter((u) => (u.department ?? '') === dep);
    }
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      rows = rows.filter((u) =>
        u.username.toLowerCase().includes(kw)
        || (u.display_name ?? '').toLowerCase().includes(kw)
        || (u.employee_no ?? '').toLowerCase().includes(kw)
        || (u.department ?? '').toLowerCase().includes(kw)
        || (u.position ?? '').toLowerCase().includes(kw));
    }
    // 角色聚合：对全量用户一次查绑定后内存映射（内网工具用户量小；汇总需覆盖未过滤全集）
    const roleMap = await this.roleCodesOf(users.map((u) => u.user_id));
    // 角色 / 资质筛选需在聚合之后执行
    if (query.role) {
      rows = rows.filter((u) => (roleMap.get(u.user_id) ?? []).includes(query.role as string));
    }
    let vos = rows.map((u) => this.vo(u, roleMap.get(u.user_id) ?? []));
    if (query.certStatus) vos = vos.filter((v) => v.certStatus === query.certStatus);
    return {
      users: vos,
      pendingCount: users.filter((u) => u.status === 'pending').length,
      // 部门字典（前端筛选下拉；取自现有用户，避免再建组织表）
      departments: [...new Set(users.map((u) => u.department).filter(Boolean))].sort(),
      summary: this.summarize(users, roleMap),
    };
  }

  /** 角色 code → role_id（本租户）。防锁死判定需按 role_id 比对 */
  private async roleIdByCode(codes?: string[]): Promise<Map<string, string>> {
    const ents = (await this.ds.getRepository('t_role').find({ where: { tenant_id: SCOPE_TENANT } } as any)) as any[];
    const map = new Map<string, string>(ents.map((r) => [r.code, r.role_id]));
    if (codes) {
      const missing = codes.filter((c) => !map.has(c));
      if (missing.length) throw new BadRequestException(`非法角色 code：${missing.join('、')}`);
    }
    return map;
  }

  /** 批量取用户 → 角色 code 列表（一次查绑定 + 一次查角色，避免逐人查库） */
  private async roleCodesOf(userIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (userIds.length === 0) return map;
    const urRows = (await this.ds.getRepository('t_user_role').find({
      where: userIds.map((id) => ({ user_id: id })),
    } as any)) as any[];
    const roleIds = [...new Set(urRows.map((r) => r.role_id))];
    const codeByRole = new Map<string, string>();
    if (roleIds.length) {
      const roleEnts = (await this.ds.getRepository('t_role').find({
        where: roleIds.map((id) => ({ role_id: id })),
      } as any)) as any[];
      roleEnts.forEach((r) => codeByRole.set(r.role_id, r.code));
    }
    urRows.forEach((r) => {
      const code = codeByRole.get(r.role_id);
      if (!code) return;
      const arr = map.get(r.user_id) ?? [];
      arr.push(code);
      map.set(r.user_id, arr);
    });
    return map;
  }

  /** 人员台账汇总：按状态 / 角色 / 部门计数 + 资质临期人数 */
  private summarize(users: any[], roleMap: Map<string, string[]>): any {
    const byStatus = new Map<string, number>();
    const byDepartment = new Map<string, number>();
    const byRole = new Map<string, number>();
    users.forEach((u) => {
      byStatus.set(u.status, (byStatus.get(u.status) ?? 0) + 1);
      const dep = u.department ?? '(未填部门)';
      byDepartment.set(dep, (byDepartment.get(dep) ?? 0) + 1);
      (roleMap.get(u.user_id) ?? []).forEach((c) => byRole.set(c, (byRole.get(c) ?? 0) + 1));
    });
    return {
      byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
      byRole: [...byRole.entries()].map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count),
      byDepartment: [...byDepartment.entries()].map(([department, count]) => ({ department, count }))
        .sort((a, b) => b.count - a.count),
      certExpiring: users.filter((u) => certStatusOf(u.cert_level, u.cert_expires_at) === 'expiring').length,
      certExpired: users.filter((u) => certStatusOf(u.cert_level, u.cert_expires_at) === 'expired').length,
      total: users.length,
    };
  }

  /** 单个用户详情（含角色） */
  async getById(userId: string): Promise<any> {
    const u = await this.findScoped(userId);
    const roles = await this.rolesOf(userId);
    return this.vo(u, roles);
  }

  /**
   * 生效权限（v3.50）：按该用户持有的每个角色展开权限点，并给出并集。
   * 用途：管理员在授权前回答「这个账号现在到底能干什么」。
   */
  async effectivePermissions(userId: string): Promise<any> {
    const u = await this.findScoped(userId);
    const roleEnts = await this.roleEntitiesOf(userId);
    const rpRows = (await this.ds.getRepository('t_role_permission').find({
      where: roleEnts.map((r) => ({ role_id: r.role_id })),
    } as any)) as any[];
    const perms = (await this.ds.getRepository('t_permission').find()) as any[];
    const byId = new Map<string, any>(perms.map((p) => [p.perm_id, p]));
    const byRole = new Map<string, string[]>();
    rpRows.forEach((r) => {
      const arr = byRole.get(r.role_id) ?? [];
      const code = byId.get(r.perm_id)?.code;
      if (code) arr.push(code);
      byRole.set(r.role_id, arr);
    });
    const union = new Set<string>();
    byRole.forEach((arr) => arr.forEach((c) => union.add(c)));
    return {
      userId: u.user_id, username: u.username, displayName: u.display_name,
      roles: roleEnts.map((r) => ({ code: r.code, name: r.name })),
      byRole: roleEnts.map((r) => ({ code: r.code, name: r.name, permissions: (byRole.get(r.role_id) ?? []).sort() })),
      permissions: [...union].sort(),
      dataScope: u.data_scope ?? 'own',
    };
  }

  /**
   * 批量授权（v3.50）：一次给多名用户改角色（组织调整/新线开线场景）。
   * mode=replace（默认）全量替换；mode=merge 追加并去重。
   * 保护：① 操作者不得把自己改出管理权限（否则当场掉权限）② 变更不得使系统管理员归零。
   */
  async bulkSetRoles(
    userIds: string[], roles: string[], mode: 'replace' | 'merge', operator: AuthedRequest,
  ): Promise<{ updated: number; skipped: string[] }> {
    if (!Array.isArray(userIds) || userIds.length === 0) throw new BadRequestException('请至少选择一名用户');
    if (userIds.length > 200) throw new BadRequestException('单次批量不超过 200 人');
    await this.assertRoles(roles);
    const capable = await adminCapableRoleIds(this.ds);
    const roleIdByCode = await this.roleIdByCode(roles);
    const selfId = operator.user?.userId ?? null;
    // 先整体推演变更后的角色分布：防锁死必须看全局，逐个改会在中途出现真空窗口
    const nextCodes = new Map<string, string[]>();
    const nextRoleIds = new Map<string, string[]>();
    const skipped: string[] = [];
    for (const id of [...new Set(userIds)]) {
      const u = (await this.ds.getRepository('t_user').findOne({
        where: { user_id: id, tenant_id: SCOPE_TENANT },
      } as any)) as any;
      if (!u) { skipped.push(id); continue; }
      const before = await this.rolesOf(id);
      const next = mode === 'merge' ? [...new Set([...before, ...roles])] : roles;
      // ① 自我保护：操作者变更后必须仍持有具备管理能力的角色
      if (selfId && id === selfId && !next.some((c) => capable.has(roleIdByCode.get(c) ?? ''))) {
        skipped.push(id);
        continue;
      }
      nextCodes.set(id, next);
      nextRoleIds.set(id, next.map((c) => roleIdByCode.get(c)).filter(Boolean) as string[]);
    }
    await assertNotLockout(this.ds, nextRoleIds);

    let updated = 0;
    for (const [id, next] of nextCodes) {
      const before = await this.rolesOf(id);
      await this.replaceRoles(id, next);
      // 权限收紧 → 立即吊销会话，消除 30s 缓存窗口内的旧权限
      if (before.length && !next.some((c) => capable.has(roleIdByCode.get(c) ?? ''))) {
        await this.revokeSessions(id);
      }
      this.loader.invalidate(id);
      this.audit(operator, 'user_bulk_roles', 'user', id, { roles: before, mode }, { roles: next, mode });
      updated += 1;
    }
    return { updated, skipped };
  }

  /**
   * 按部门批量授权（v3.58）：组织调整时直接以部门为粒度授权，
   * 对应行业软件「多站点 + 组织维度」的人员主数据用法，避免逐个勾选漏人。
   */
  async bulkSetRolesByDepartment(
    department: string, roles: string[], mode: 'replace' | 'merge', operator: AuthedRequest,
  ): Promise<{ updated: number; skipped: string[] }> {
    const dep = (department ?? '').trim();
    if (!dep) throw new BadRequestException('部门不能为空');
    const users = (await this.ds.getRepository('t_user').find({
      where: { tenant_id: SCOPE_TENANT, department: dep },
    } as any)) as any[];
    if (users.length === 0) throw new BadRequestException(`部门「${dep}」下没有用户`);
    const r = await this.bulkSetRoles(users.map((u) => u.user_id), roles, mode, operator);
    this.audit(operator, 'user_bulk_by_department', 'user', dep,
      { department: dep, roles, mode, matched: users.length }, { updated: r.updated });
    return r;
  }

  /** 统一 VO：列表/详情/建号返回同一形状，避免前后端字段漂移 */
  private vo(u: any, roles: string[]): any {
    return {
      userId: u.user_id, username: u.username, displayName: u.display_name,
      email: u.email ?? null, status: u.status, mustChangePwd: Number(u.must_change_pwd) === 1,
      roles, createdAt: u.created_at,
      // v3.50 人员档案 + 数据范围 + 方法资质
      department: u.department ?? null, position: u.position ?? null, employeeNo: u.employee_no ?? null,
      dataScope: u.data_scope ?? 'own',
      certLevel: u.cert_level ?? null,
      certExpiresAt: u.cert_expires_at ?? null,
      // v3.58：资质状态在服务端算（前端不再各算各的，避免展示口径漂移）
      certStatus: certStatusOf(u.cert_level, u.cert_expires_at),
    };
  }

  /** 建号：用户名全局唯一；建号即生效（active）+ 强制首次改密（must_change_pwd=1） */
  async create(dto: CreateUserInput, operator: AuthedRequest): Promise<any> {
    validatePassword(dto.password);
    const username = (dto.username ?? '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      throw new BadRequestException('用户名须为 3-32 位字母、数字、._- 组合');
    }
    await this.assertRoles(dto.roles);
    const email = (dto.email ?? '').trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }
    const repo = this.ds.getRepository('t_user');
    if ((await repo.countBy({ username } as any)) > 0) throw new BadRequestException('用户名已存在');
    const userId = 'u_' + randomUUID().replace(/-/g, '').slice(0, 26);
    await repo.save(repo.create({
      user_id: userId, tenant_id: SCOPE_TENANT, username,
      password_hash: bcrypt.hashSync(dto.password, 10),
      display_name: (dto.displayName ?? '').trim() || username,
      email, status: 'active', failed_count: 0, must_change_pwd: 1,
      ...this.profilePatch(dto),
    } as any));
    await this.replaceRoles(userId, dto.roles);
    this.audit(operator, 'user_create', 'user', userId, null,
      { username, roles: dto.roles, department: dto.department ?? null, dataScope: dto.dataScope ?? 'own' });
    return this.getById(userId);
  }

  /**
   * 改资料：display_name / email / status（仅 active|disabled 可设；停用即吊销会话踢下线）。
   * v3.58 守卫：
   *  ① 状态机：rejected 不得直接改 active（须重走注册审批，否则驳回形同虚设）；
   *  ② 停用管理员前先验证系统仍会留有至少一名管理员（停用 = 隐性摘权）；
   *  ③ 停用当前登录管理员本人需显式确认（confirmSelf=true）。
   */
  async update(userId: string, dto: UpdateUserInput & { confirmSelf?: boolean }, operator: AuthedRequest): Promise<any> {
    const u = await this.findScoped(userId);
    const patch: any = {};
    if (dto.displayName !== undefined) patch.display_name = dto.displayName.trim();
    if (dto.email !== undefined) {
      const email = dto.email.trim() || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('邮箱格式不正确');
      patch.email = email;
    }
    if (dto.status !== undefined) {
      if (!['active', 'disabled'].includes(dto.status)) {
        throw new BadRequestException('status 仅允许 active|disabled');
      }
      // ① 驳回账号不得直接复活：注册审批是唯一入口
      if (u.status === 'rejected' && dto.status === 'active') {
        throw new BadRequestException('已驳回账号不能直接启用：请让用户重新提交注册申请');
      }
      // ③ 停用本人需显式确认
      const selfId = operator.user?.userId ?? null;
      if (dto.status === 'disabled' && selfId && userId === selfId && dto.confirmSelf !== true) {
        throw new BadRequestException('停用当前登录的管理员需显式确认：请带上 confirmSelf=true');
      }
      // ② 停用 = 隐性摘权，走同一道防锁死闸门
      if (dto.status === 'disabled') await assertNotLockout(this.ds, new Map([[userId, []]]));
      patch.status = dto.status;
    }
    const before = {
      display_name: u.display_name, email: u.email, status: u.status,
      department: u.department, position: u.position, employee_no: u.employee_no,
      data_scope: u.data_scope, cert_level: u.cert_level,
    };
    Object.assign(patch, this.profilePatch(dto));
    if (Object.keys(patch).length === 0) throw new BadRequestException('没有需要更新的字段');
    await this.ds.getRepository('t_user').update({ user_id: userId } as any, patch);
    if (patch.status === 'disabled') {
      await this.revokeSessions(userId); // 停用立即踢下线
      this.loader.invalidate(userId);
    } else {
      this.loader.invalidate(userId);
    }
    this.audit(operator, 'user_update', 'user', userId, before, patch);
    return this.getById(userId);
  }

  /**
   * 角色全量替换（先删后插）。
   * v3.58 守卫：① 系统管理员不得归零；② 操作者不得把自己改出管理权限（当场掉权限）；
   * ③ 降权后吊销该用户全部会话——旧 token 在 30s 缓存窗口内仍带旧权限。
   */
  async setRoles(userId: string, roles: string[], operator: AuthedRequest): Promise<any> {
    await this.findScoped(userId);
    await this.assertRoles(roles);
    const capable = await adminCapableRoleIds(this.ds);
    const roleIdByCode = await this.roleIdByCode(roles);
    const selfId = operator.user?.userId ?? null;
    if (selfId && userId === selfId && !roles.some((c) => capable.has(roleIdByCode.get(c) ?? ''))) {
      throw new BadRequestException('不能移除自己的用户/角色管理权限：请由其他管理员操作');
    }
    await assertNotLockout(this.ds, new Map([[userId, roles.map((c) => roleIdByCode.get(c)).filter(Boolean) as string[]]]));
    const beforeRoles = await this.rolesOf(userId);
    await this.replaceRoles(userId, roles);
    // ③ 权限收紧（不再是管理员）→ 立即吊销会话，消除缓存窗口内的越权
    if (beforeRoles.length && !roles.some((c) => capable.has(roleIdByCode.get(c) ?? ''))) {
      await this.revokeSessions(userId);
    }
    this.loader.invalidate(userId);
    this.audit(operator, 'user_roles', 'user', userId, { roles: beforeRoles }, { roles });
    return this.getById(userId);
  }

  /** 审批通过：pending → active 并赋予角色（无角色不放行——不持角色看不到任何数据） */
  async approve(userId: string, roles: string[], operator: AuthedRequest): Promise<any> {
    const u = await this.findScoped(userId);
    if (u.status !== 'pending') throw new BadRequestException('仅待审批（pending）账号可审批');
    await this.assertRoles(roles);
    await this.ds.getRepository('t_user').update({ user_id: userId } as any, { status: 'active' });
    await this.replaceRoles(userId, roles);
    this.loader.invalidate(userId);
    this.audit(operator, 'user_approve', 'user', userId, { status: 'pending', roles: [] },
      { username: u.username, status: 'active', roles });
    return this.getById(userId);
  }

  /** 审批驳回：pending → rejected（终态：不得直接复活，须重新注册） */
  async reject(userId: string, reason: string | undefined, operator: AuthedRequest): Promise<any> {
    const u = await this.findScoped(userId);
    if (u.status !== 'pending') throw new BadRequestException('仅待审批（pending）账号可驳回');
    await this.ds.getRepository('t_user').update({ user_id: userId } as any, { status: 'rejected' });
    await this.revokeSessions(userId);
    this.loader.invalidate(userId);
    this.audit(operator, 'user_reject', 'user', userId, { status: 'pending', username: u.username },
      { status: 'rejected', username: u.username, reason: reason ?? '' });
    return this.getById(userId);
  }

  /** 代置临时口令：一次性返回明文，下次登录强制改密，全部会话吊销 */
  async resetPassword(userId: string, operator: AuthedRequest): Promise<{ tempPassword: string }> {
    const u = await this.findScoped(userId);
    const r = await this.auth.adminResetPassword(userId, this.ipOf(operator));
    this.audit(operator, 'user_reset_password', 'user', userId, { username: u.username }, { mustChangePwd: true });
    return r;
  }

  /** 下发重置码：一次性返回 6 位明文码，由管理员线下告知用户（30 分钟有效） */
  async issueResetCode(userId: string, operator: AuthedRequest): Promise<{ code: string; expiresAt: Date }> {
    const u = await this.findScoped(userId);
    const r = await this.auth.adminIssueResetCode(userId, this.ipOf(operator));
    this.audit(operator, 'user_issue_reset_code', 'user', userId, { username: u.username }, { channel: 'admin-issued' });
    return r;
  }

  /** 重置申请列表（helpdesk）：未使用且未过期的重置码元数据（不含明文码——库内仅存哈希） */
  async listResetRequests(): Promise<{ requests: any[] }> {
    const rows = (await this.ds.getRepository('t_password_reset').find({
      where: { tenant_id: SCOPE_TENANT, used: 0 },
      order: { created_at: 'DESC' },
    } as any)) as any[];
    const live = rows.filter((r) => new Date(r.expires_at) > new Date());
    if (live.length === 0) return { requests: [] };
    const userIds = [...new Set(live.map((r) => r.user_id))];
    const users = (await this.ds.getRepository('t_user').find({ where: userIds.map((id) => ({ user_id: id })) } as any)) as any[];
    const nameByUser = new Map<string, { username: string; displayName: string; status: string }>();
    users.forEach((u) => nameByUser.set(u.user_id, { username: u.username, displayName: u.display_name, status: u.status }));
    return {
      requests: live.map((r) => {
        const n = nameByUser.get(r.user_id);
        return {
          resetId: r.reset_id, userId: r.user_id,
          username: n?.username ?? '(已删除)', displayName: n?.displayName ?? '', userStatus: n?.status ?? '',
          appliedAt: r.created_at, expiresAt: r.expires_at, attempts: r.attempts ?? 0, ip: r.ip ?? '',
        };
      }),
    };
  }

  // —— 私有 ——

  private async findScoped(userId: string): Promise<any> {
    const u = (await this.ds.getRepository('t_user').findOne({ where: { user_id: userId, tenant_id: SCOPE_TENANT } } as any)) as any;
    if (!u) throw new NotFoundException('用户不存在');
    return u;
  }

  private async rolesOf(userId: string): Promise<string[]> {
    return (await this.roleEntitiesOf(userId)).map((r) => r.code);
  }

  private async roleEntitiesOf(userId: string): Promise<any[]> {
    const urRows = (await this.ds.getRepository('t_user_role').find({ where: { user_id: userId } } as any)) as any[];
    if (urRows.length === 0) return [];
    return (await this.ds.getRepository('t_role').find({ where: urRows.map((r) => ({ role_id: r.role_id })) } as any)) as any[];
  }

  private async replaceRoles(userId: string, roles: string[]): Promise<void> {
    const repo = this.ds.getRepository('t_user_role');
    await repo.delete({ user_id: userId } as any);
    const roleEnts = (await this.ds.getRepository('t_role').find({
      where: roles.map((code) => ({ tenant_id: SCOPE_TENANT, code })),
    } as any)) as any[];
    const byCode = new Map<string, string>(roleEnts.map((r) => [r.code, r.role_id]));
    for (const code of roles) {
      const roleId = byCode.get(code);
      if (!roleId) continue;
      await repo.save(repo.create({ user_id: userId, role_id: roleId } as any));
    }
  }

  /**
   * v3.50：合法角色以 t_role（DEFAULT 租户）为唯一来源——自定义角色自动可用。
   * 库查询异常时回退内置五档，保证授权链路不会因一次查询抖动而整体不可用。
   */
  private async assertRoles(roles: string[] | undefined): Promise<void> {
    if (!Array.isArray(roles) || roles.length === 0) {
      throw new BadRequestException('至少需要一个角色');
    }
    let valid: string[] = FALLBACK_ROLE_CODES;
    try {
      const ents = (await this.ds.getRepository('t_role').find({ where: { tenant_id: SCOPE_TENANT } } as any)) as any[];
      if (ents.length) valid = ents.map((r) => r.code);
    } catch (e) {
      // 兜底字典是"退而求其次"，不落日志就会一直悄悄按内置五档放行而不自知觉
      this.log.warn(`角色字典查询失败，回退内置五档：${(e as Error).message}`);
    }
    for (const code of roles) {
      if (!valid.includes(code)) {
        throw new BadRequestException(`非法角色 code：${code}（合法值：${valid.join('/')}）`);
      }
    }
  }

  /** 人员档案字段（部门/岗位/工号/数据范围/资质）——建号与改资料共用，空值统一归一为 null */
  private profilePatch(dto: Partial<CreateUserInput & UpdateUserInput>): any {
    const patch: any = {};
    if (dto.department !== undefined) patch.department = (dto.department ?? '').trim() || null;
    if (dto.position !== undefined) patch.position = (dto.position ?? '').trim() || null;
    if (dto.employeeNo !== undefined) patch.employee_no = (dto.employeeNo ?? '').trim() || null;
    if (dto.dataScope !== undefined) {
      const scope = (dto.dataScope ?? '').trim();
      if (!DATA_SCOPES.includes(scope)) {
        throw new BadRequestException(`数据范围非法：${scope}（合法值：${DATA_SCOPES.join('/')}）`);
      }
      patch.data_scope = scope;
    }
    if (dto.certLevel !== undefined) {
      const lv = (dto.certLevel ?? '').trim();
      if (lv && !CERT_LEVELS.includes(lv)) {
        throw new BadRequestException(`资质等级非法：${lv}（合法值：${CERT_LEVELS.join('/')}）`);
      }
      patch.cert_level = lv || null;
    }
    if (dto.certExpiresAt !== undefined) {
      const raw = (dto.certExpiresAt ?? '').trim();
      if (!raw) { patch.cert_expires_at = null; }
      else {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) throw new BadRequestException('资质有效期格式不正确');
        patch.cert_expires_at = d;
      }
    }
    // 建号时未显式给出档案字段 → 显式落默认值，避免不同库 DEFAULT 行为差异
    if (dto.dataScope === undefined && 'username' in dto) patch.data_scope = 'own';
    return patch;
  }

  private async revokeSessions(userId: string): Promise<void> {
    await this.ds.getRepository('t_refresh_token').update({ user_id: userId, revoked: 0 } as any, { revoked: 1 });
  }

  /**
   * 审计用客户端 IP：单一来源委托给 clientIp()。
   * 此前这里复制了一份"取 x-forwarded-for 首值"的实现——与 auth.service 的旧实现同源同缺陷
   * （同机进程可伪造成任意 IP 写进审计表，审计溯源因此失真）。
   */
  private ipOf(req: AuthedRequest): string {
    return clientIp(req);
  }

  /**
   * 审计：before/after 双态（v3.58）——只记 after 的审计回答不了「改之前是什么」。
   * 落库失败必须留痕：静默吞异常会让追溯链断了还以为没断。
   */
  private audit(
    operator: AuthedRequest, action: string, entity: string, entityId: string,
    before: any, after: any,
  ): void {
    void this.ds.getRepository('t_audit_log').save(this.ds.getRepository('t_audit_log').create({
      log_id: randomUUID(),
      tenant_id: SCOPE_TENANT,
      user_id: operator.user?.userId ?? null,
      username: operator.user?.username ?? '',
      action, entity, entity_id: entityId,
      before_json: before === null || before === undefined ? null : JSON.stringify(before),
      after_json: after === null || after === undefined ? null : JSON.stringify(after),
      ip: this.ipOf(operator),
    } as any)).catch((e) => this.log.error(`审计写入失败 ${action}/${entityId}: ${(e as Error).message}`));
  }
}
