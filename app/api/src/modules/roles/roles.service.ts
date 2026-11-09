import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AuthUserLoader } from '../../auth/auth-user.loader';
import { AuthedRequest } from '../../auth/auth-user.interface';
import { clientIp } from '../../auth/auth.service';
import {
  RBAC_TENANT as SCOPE_TENANT, SYSADMIN_LOCKED_PERMS as SYSADMIN_LOCKED, assertNotLockout,
} from '../../rbac/rbac-guard';

/** 角色 code 命名：小写字母开头，仅字母数字下划线，2-24 位 */
const CODE_RE = /^[a-z][a-z0-9_]{1,23}$/;

export interface CreateRoleInput {
  code: string; name: string; description?: string; permissions: string[];
  /** v3.58：从既有角色复制权限（岗位角色派生场景，避免逐项勾选） */
  sourceRoleId?: string;
}
export interface RenameRoleInput { name?: string; description?: string; }
export interface MemberInput { userIds: string[]; }

/**
 * 角色与权限管理（v3.50 用户与权限中心）：
 * 角色列表（含成员数/权限数）/ 权限点字典（按模块分组）/ 新建自定义角色 /
 * 改名改说明 / 权限全量替换 / 删除自定义角色 / 权限变更审计。
 *
 * 设计要点（对标本系统铁律）：
 * - 系统角色（is_system=1）不可删除；其权限可调整但 sys_admin 的 RBAC 四类权限锁定；
 * - 任何权限变更后立即失效相关用户的 AuthUserLoader 缓存（30s→即时），改完即生效；
 * - 全量操作写 t_audit_log，保留 before/after 便于追溯。
 */
@Injectable()
export class RolesService {
  private readonly log = new Logger('RolesService');

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly loader: AuthUserLoader,
  ) {}

  /** 角色列表：含权限点、成员数；按「系统角色在前、内置顺序」排序 */
  async list(): Promise<{ roles: any[] }> {
    const roles = (await this.ds.getRepository('t_role').find({
      where: { tenant_id: SCOPE_TENANT },
    } as any)) as any[];

    const rpRows = (await this.ds.getRepository('t_role_permission').find()) as any[];
    const permEnts = (await this.ds.getRepository('t_permission').find()) as any[];
    const codeByPerm = new Map<string, string>(permEnts.map((p) => [p.perm_id, p.code]));

    const urRows = (await this.ds.getRepository('t_user_role').find()) as any[];
    const memberCount = new Map<string, number>();
    urRows.forEach((r) => memberCount.set(r.role_id, (memberCount.get(r.role_id) ?? 0) + 1));

    const order = ['sys_admin', 'ie_admin', 'ie_engineer', 'line_leader', 'viewer'];
    roles.sort((a, b) => {
      const ia = order.indexOf(a.code); const ib = order.indexOf(b.code);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.code.localeCompare(b.code);
    });

    return {
      roles: roles.map((r) => ({
        roleId: r.role_id, code: r.code, name: r.name,
        description: r.description ?? null,
        isSystem: Number(r.is_system) === 1,
        permissions: rpRows.filter((x) => x.role_id === r.role_id)
          .map((x) => codeByPerm.get(x.perm_id)).filter(Boolean).sort(),
        memberCount: memberCount.get(r.role_id) ?? 0,
      })),
    };
  }

  /**
   * 权限点字典：按 module 分组（前端权限矩阵直接消费）。
   * v3.58 每项附 `roles`（引用该权限点的角色 code 列表）——回答「摘掉这一项会影响谁」。
   */
  async permissions(): Promise<{ groups: any[]; total: number }> {
    const perms = (await this.ds.getRepository('t_permission').find()) as any[];
    const rpRows = (await this.ds.getRepository('t_role_permission').find()) as any[];
    const roleEnts = (await this.ds.getRepository('t_role').find({ where: { tenant_id: SCOPE_TENANT } } as any)) as any[];
    const codeByRole = new Map<string, string>(roleEnts.map((r) => [r.role_id, r.code]));
    const usage = new Map<string, string[]>();
    rpRows.forEach((r) => {
      const code = codeByRole.get(r.role_id);
      if (!code) return;
      const arr = usage.get(r.perm_id) ?? [];
      arr.push(code);
      usage.set(r.perm_id, arr);
    });
    const map = new Map<string, any[]>();
    perms.forEach((p) => {
      const arr = map.get(p.module) ?? [];
      arr.push({ code: p.code, name: p.name, module: p.module, roles: (usage.get(p.perm_id) ?? []).sort() });
      map.set(p.module, arr);
    });
    const groups = [...map.entries()].map(([module, items]) => ({
      module, label: MODULE_LABEL[module] ?? module,
      items: items.sort((a, b) => a.code.localeCompare(b.code)),
    })).sort((a, b) => MODULE_ORDER.indexOf(a.module) - MODULE_ORDER.indexOf(b.module));
    return { groups, total: perms.length };
  }

  /** 新建自定义角色：code 租户内唯一；权限点必须存在于字典 */
  async create(dto: CreateRoleInput, operator: AuthedRequest): Promise<any> {
    const code = (dto.code ?? '').trim();
    const name = (dto.name ?? '').trim();
    if (!CODE_RE.test(code)) {
      throw new BadRequestException('角色 code 须为 2-24 位小写字母开头、仅含字母数字下划线');
    }
    if (!name) throw new BadRequestException('角色名称不能为空');
    const repo = this.ds.getRepository('t_role');
    if ((await repo.countBy({ tenant_id: SCOPE_TENANT, code } as any)) > 0) {
      throw new BadRequestException(`角色 code 已存在：${code}`);
    }
    const roleId = 'r_' + randomUUID().replace(/-/g, '').slice(0, 26);
    await repo.save(repo.create({
      role_id: roleId, tenant_id: SCOPE_TENANT, code, name,
      description: (dto.description ?? '').trim() || null, is_system: 0,
    } as any));
    // sourceRoleId：以既有角色权限为底稿（岗位角色派生：先复制再微调，避免逐项勾选漏项）
    let perms = [...(dto.permissions ?? [])];
    if (dto.sourceRoleId) {
      const src = await this.findScoped(dto.sourceRoleId);
      perms = [...new Set([...(await this.rolePermCodes(src.role_id)), ...perms])];
    }
    await this.writePermissions(roleId, code, perms, false);
    this.audit(operator, 'role_create', roleId, null,
      { code, name, permissions: perms, clonedFrom: dto.sourceRoleId ?? null });
    return this.getById(roleId);
  }

  /** 角色详情（含权限点与成员数） */
  async getById(roleId: string): Promise<any> {
    const one = (await this.list()).roles.find((r) => r.roleId === roleId);
    if (!one) throw new NotFoundException('角色不存在');
    return one;
  }

  // —— v3.58 角色侧授权（人员↔角色双向：此前只能从用户侧改角色）——

  /** 角色成员清单（含部门/岗位/状态，便于按组织核对授权是否到位） */
  async members(roleId: string): Promise<any> {
    const role = await this.findScoped(roleId);
    const urRows = (await this.ds.getRepository('t_user_role').find({ where: { role_id: roleId } } as any)) as any[];
    const ids = urRows.map((r) => r.user_id);
    const users = ids.length
      ? (await this.ds.getRepository('t_user').find({ where: ids.map((id) => ({ user_id: id })) } as any)) as any[]
      : [];
    return {
      roleId: role.role_id, code: role.code, name: role.name,
      members: users.map((u) => ({
        userId: u.user_id, username: u.username, displayName: u.display_name,
        department: u.department ?? null, position: u.position ?? null, status: u.status,
      })).sort((a, b) => a.username.localeCompare(b.username)),
    };
  }

  /**
   * 角色侧批量加入成员（追加，不动该用户原有其他角色）。
   * 未在本租户的用户、已在角色内的用户计入 skipped（部分成功不整批回滚，结果逐条可查）。
   */
  async addMembers(roleId: string, userIds: string[], operator: AuthedRequest): Promise<any> {
    const role = await this.findScoped(roleId);
    const repo = this.ds.getRepository('t_user_role');
    const existing = new Set(((await repo.find({ where: { role_id: roleId } } as any)) as any[]).map((r) => r.user_id));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const id of [...new Set(userIds ?? [])]) {
      const u = (await this.ds.getRepository('t_user').findOne({
        where: { user_id: id, tenant_id: SCOPE_TENANT },
      } as any)) as any;
      if (!u || existing.has(id)) { skipped.push(id); continue; }
      await repo.save(repo.create({ user_id: id, role_id: roleId } as any));
      this.loader.invalidate(id);
      added.push(id);
    }
    if (added.length) {
      this.audit(operator, 'role_members_add', roleId, null, { role: role.code, added });
    }
    return { roleId, added, skipped };
  }

  /**
   * 角色侧批量移除成员。防锁死：不允许把系统最后一名管理员摘掉
   * （比对角色权限而非角色 code——user:write/role:write 授给自定义角色时同样算管理员）。
   */
  async removeMembers(roleId: string, userIds: string[], operator: AuthedRequest): Promise<any> {
    const role = await this.findScoped(roleId);
    const targets = [...new Set(userIds ?? [])];
    if (targets.length === 0) throw new BadRequestException('请至少选择一名成员');
    const urRows = (await this.ds.getRepository('t_user_role').find()) as any[];
    const rolesOf = new Map<string, string[]>();
    urRows.forEach((r) => {
      const arr = rolesOf.get(r.user_id) ?? [];
      arr.push(r.role_id);
      rolesOf.set(r.user_id, arr);
    });
    const next = new Map<string, string[]>();
    for (const id of targets) {
      next.set(id, (rolesOf.get(id) ?? []).filter((rid) => rid !== roleId));
    }
    await assertNotLockout(this.ds, next);

    const repo = this.ds.getRepository('t_user_role');
    const removed: string[] = [];
    const skipped: string[] = [];
    for (const id of targets) {
      const has = (rolesOf.get(id) ?? []).includes(roleId);
      if (!has) { skipped.push(id); continue; }
      await repo.delete({ user_id: id, role_id: roleId } as any);
      this.loader.invalidate(id);
      removed.push(id);
    }
    if (removed.length) {
      this.audit(operator, 'role_members_remove', roleId, { role: role.code, count: removed.length }, { removed });
    }
    return { roleId, removed, skipped };
  }

  /** 改名 / 改说明（系统角色仅允许改说明，避免内置语义漂移） */
  async rename(roleId: string, dto: RenameRoleInput, operator: AuthedRequest): Promise<any> {
    const role = await this.findScoped(roleId);
    const patch: any = {};
    if (dto.name !== undefined) {
      if (Number(role.is_system) === 1) throw new BadRequestException('系统角色名称不可修改（可改说明）');
      if (!dto.name.trim()) throw new BadRequestException('角色名称不能为空');
      patch.name = dto.name.trim();
    }
    if (dto.description !== undefined) patch.description = dto.description.trim() || null;
    if (Object.keys(patch).length === 0) throw new BadRequestException('没有需要更新的字段');
    await this.ds.getRepository('t_role').update({ role_id: roleId } as any, patch);
    this.audit(operator, 'role_update', roleId, { name: role.name, description: role.description }, patch);
    return this.getById(roleId);
  }

  /** 权限全量替换：校验权限点合法 + sys_admin 防锁死 + 即时失效成员缓存 */
  async setPermissions(roleId: string, codes: string[], operator: AuthedRequest): Promise<any> {
    const role = await this.findScoped(roleId);
    const before = await this.rolePermCodes(roleId);
    await this.writePermissions(roleId, role.code, codes ?? [], Number(role.is_system) === 1);
    await this.invalidateMembers(roleId);
    this.audit(operator, 'role_permissions', roleId, { permissions: before }, { permissions: codes ?? [] });
    return this.getById(roleId);
  }

  /** 删除角色：仅自定义角色（is_system=0）且无成员 */
  async remove(roleId: string, operator: AuthedRequest): Promise<{ ok: true }> {
    const role = await this.findScoped(roleId);
    if (Number(role.is_system) === 1) throw new BadRequestException('系统角色不可删除');
    const memberCount = await this.ds.getRepository('t_user_role').countBy({ role_id: roleId } as any);
    if (memberCount > 0) {
      throw new BadRequestException(`该角色仍有 ${memberCount} 名成员，请先解除授权再删除`);
    }
    const permSnapshot = await this.rolePermCodes(roleId); // 角色会消失，审计须自带权限快照
    await this.ds.getRepository('t_role_permission').delete({ role_id: roleId } as any);
    await this.ds.getRepository('t_role').delete({ role_id: roleId } as any);
    this.audit(operator, 'role_delete', roleId,
      { code: role.code, name: role.name, permissions: permSnapshot }, null);
    return { ok: true as const };
  }

  /**
   * 权限变更审计（v3.50 起：谁在什么时候改了哪个角色/用户的权限——可追溯性底线）。
   * v3.58：支持按动作 / 操作人 / 对象过滤；entity 不传时返回全部 RBAC 相关动作
   * （此前必须分别查 rbac 与 user 两次，前端合并易漏）。
   */
  async auditLogs(query: {
    entity?: string; action?: string; operator?: string; entityId?: string; limit?: number;
  }): Promise<{ logs: any[] }> {
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const actions = ['role_create', 'role_update', 'role_permissions', 'role_delete',
      'role_members_add', 'role_members_remove',
      'user_create', 'user_update', 'user_roles', 'user_bulk_roles', 'user_bulk_by_department',
      'user_approve', 'user_reject', 'user_reset_password', 'user_issue_reset_code'];
    const qb = this.ds.getRepository('t_audit_log')
      .createQueryBuilder('a')
      .where('a.tenant_id = :tenant', { tenant: SCOPE_TENANT })
      .andWhere('a.action IN (:...actions)', { actions })
      .orderBy('a.created_at', 'DESC')
      .limit(limit);
    if (query.entity) qb.andWhere('a.entity = :entity', { entity: query.entity });
    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.entityId) qb.andWhere('a.entity_id = :entityId', { entityId: query.entityId });
    // 过滤条件一律下推到 SQL：先 limit 后过滤会返回不足 limit 条且漏掉命中记录
    if (query.operator) {
      qb.andWhere('(LOWER(a.username) LIKE :op OR a.user_id LIKE :op)', { op: `%${query.operator.trim().toLowerCase()}%` });
    }
    const rows = (await qb.getMany()) as any[];
    return {
      logs: rows.map((r) => ({
        logId: r.log_id, action: r.action, entity: r.entity, entityId: r.entity_id,
        operator: r.username ?? '(系统)', operatorId: r.user_id,
        before: safeParse(r.before_json), after: safeParse(r.after_json),
        ip: r.ip ?? '', at: r.created_at,
      })),
    };
  }

  // —— 私有 ——

  private async findScoped(roleId: string): Promise<any> {
    const r = (await this.ds.getRepository('t_role').findOne({
      where: { role_id: roleId, tenant_id: SCOPE_TENANT },
    } as any)) as any;
    if (!r) throw new NotFoundException('角色不存在');
    return r;
  }

  private async rolePermCodes(roleId: string): Promise<string[]> {
    const rpRows = (await this.ds.getRepository('t_role_permission').find({ where: { role_id: roleId } } as any)) as any[];
    if (rpRows.length === 0) return [];
    const perms = (await this.ds.getRepository('t_permission').find()) as any[];
    const byId = new Map<string, string>(perms.map((p) => [p.perm_id, p.code]));
    return rpRows.map((r) => byId.get(r.perm_id)).filter(Boolean) as string[];
  }

  /** 写角色-权限（全量替换）。isSystem 角色追加防锁死保护 */
  private async writePermissions(roleId: string, roleCode: string, codes: string[], isSystem: boolean): Promise<void> {
    const perms = (await this.ds.getRepository('t_permission').find()) as any[];
    const byCode = new Map<string, string>(perms.map((p) => [p.code, p.perm_id]));
    const wanted = new Set<string>();
    for (const c of codes ?? []) {
      if (!byCode.has(c)) throw new BadRequestException(`非法权限点：${c}`);
      wanted.add(c);
    }
    if (isSystem && roleCode === 'sys_admin') {
      for (const lock of SYSADMIN_LOCKED) wanted.add(lock); // 防锁死：强制保留
    }
    const repo = this.ds.getRepository('t_role_permission');
    await repo.delete({ role_id: roleId } as any);
    for (const c of wanted) {
      await repo.save(repo.create({ role_id: roleId, perm_id: byCode.get(c) } as any));
    }
  }

  /** 角色权限变更 → 失效该角色全部成员的登录态缓存（改完即生效，无需等 30s） */
  private async invalidateMembers(roleId: string): Promise<void> {
    const urRows = (await this.ds.getRepository('t_user_role').find({ where: { role_id: roleId } } as any)) as any[];
    urRows.forEach((r) => this.loader.invalidate(r.user_id));
  }

  /**
   * 审计落库：不阻塞响应，但失败必须留痕——静默吞异常会让「可追溯性底线」形同虚设。
   * before/after 双态：只记 after 的审计无法回答「改之前是什么」。
   */
  private audit(operator: AuthedRequest, action: string, entityId: string, before: any, after: any): void {
    void this.ds.getRepository('t_audit_log').save(this.ds.getRepository('t_audit_log').create({
      log_id: randomUUID(),
      tenant_id: SCOPE_TENANT,
      user_id: operator.user?.userId ?? null,
      username: operator.user?.username ?? '',
      action, entity: 'rbac', entity_id: entityId,
      before_json: before === null || before === undefined ? null : JSON.stringify(before),
      after_json: after === null || after === undefined ? null : JSON.stringify(after),
      ip: clientIp(operator),
    } as any)).catch((e) => this.log.error(`审计写入失败 ${action}/${entityId}: ${(e as Error).message}`));
  }
}

function safeParse(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

/** 模块中文名与展示顺序（与 seed.ts PERMISSIONS 的 module 一致） */
const MODULE_LABEL: Record<string, string> = {
  stations: '工位与产线', elements: '动作要素分解', analysis: '分析与诊断',
  suggestions: '改善建议', compare: '改善前后对比', settings: '系统设置',
  rules: '规则与标准', rbac: '用户与权限', audit: '审计追溯',
  auth: '账号与认证', ai: 'AI 能力', dashboard: '综合看板',
};
const MODULE_ORDER = ['stations', 'elements', 'analysis', 'suggestions', 'compare',
  'settings', 'rules', 'rbac', 'audit', 'auth', 'ai', 'dashboard'];
