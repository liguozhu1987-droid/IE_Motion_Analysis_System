import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser, DataScope } from '../auth/auth-user.interface';

/** 非法/空值一律回落 own（最小可见范围）——宁缺勿错，绝不因脏数据放大可见性 */
function normalizeScope(raw: unknown): DataScope {
  const v = String(raw ?? '').trim().toLowerCase();
  return (['own', 'line', 'tenant', 'all'] as string[]).includes(v) ? (v as DataScope) : 'own';
}

/**
 * 登录用户加载器：token 校验后按 userId 加载角色与权限（实时查库，
 * 权限变更即时生效）。带 30s 短缓存降低查询压力；变更时 invalidate。
 */
@Injectable()
export class AuthUserLoader {
  private readonly log = new Logger('AuthUserLoader');
  private cache = new Map<string, { user: AuthUser; exp: number }>();

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async load(userId: string): Promise<AuthUser | null> {
    const hit = this.cache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.user;
    try {
      const user = await this.ds.getRepository('t_user').findOne({ where: { user_id: userId } } as any) as any;
      if (!user || user.status !== 'active') return null;
      const roleRows = await this.ds.getRepository('t_user_role').find({ where: { user_id: userId } } as any) as any[];
      const roleIds = roleRows.map((r) => r.role_id);
      let roles: string[] = [];
      const perms = new Set<string>();
      if (roleIds.length) {
        const roleEnts = await this.ds.getRepository('t_role').find({ where: roleIds.map((id) => ({ role_id: id })) } as any) as any[];
        roles = roleEnts.map((r) => r.code);
        const rpRows = await this.ds.getRepository('t_role_permission').find({ where: roleIds.map((id) => ({ role_id: id })) } as any) as any[];
        const permIds = [...new Set(rpRows.map((r) => r.perm_id))];
        if (permIds.length) {
          const permEnts = await this.ds.getRepository('t_permission').find({ where: permIds.map((id) => ({ perm_id: id })) } as any) as any[];
          permEnts.forEach((p) => perms.add(p.code));
        }
      }
      const authUser: AuthUser = {
        userId: user.user_id,
        username: user.username,
        displayName: user.display_name,
        tenantId: user.tenant_id,
        roles,
        permissions: perms,
        mustChangePwd: Number(user.must_change_pwd) === 1,
        // v3.55：数据范围真正参与可见性判定（此前只写不读，空转）
        dataScope: normalizeScope(user.data_scope),
        // v3.57：统一身份认证增量字段（向后兼容，旧前端忽略即可）
        employeeNo: user.employee_no ?? null,
        authSource: user.auth_source === 'oidc' ? 'oidc' : 'local',
      };
      this.cache.set(userId, { user: authUser, exp: Date.now() + 30_000 });
      return authUser;
    } catch (e) {
      this.log.error(`load(${userId}) 失败: ${(e as Error).message}`);
      return null;
    }
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
