import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** 租户管理范围：DEFAULT（多租户开通另行设计）。roles / users 两模块共用，避免两处漂移 */
export const RBAC_TENANT = 'DEFAULT';
/**
 * sys_admin 的防锁死权限点：不允许从该角色上摘除。
 * 摘掉 user:write / role:write 会导致全站再无账号能改权限——必须硬保护。
 */
export const SYSADMIN_LOCKED_PERMS = ['user:read', 'user:write', 'role:read', 'role:write'];
/** 「能改用户/角色」的权限点：系统必须永远至少有一名在用账号持有其一 */
const ADMIN_CAPABLE_PERMS = ['user:write', 'role:write'];

/**
 * 具备用户/角色管理能力的角色 role_id 集合。
 * 判定依据是权限点而非角色 code——管理员可把 user:write 授给自定义角色，
 * 届时该角色同样算「管理员角色」，锁死判定才不会失真。
 */
export async function adminCapableRoleIds(ds: DataSource): Promise<Set<string>> {
  const perms = (await ds.getRepository('t_permission').find()) as any[];
  const permIds = new Set(
    perms.filter((p) => ADMIN_CAPABLE_PERMS.includes(p.code)).map((p) => p.perm_id),
  );
  const rp = (await ds.getRepository('t_role_permission').find()) as any[];
  const roleIds = new Set<string>();
  rp.forEach((r) => { if (permIds.has(r.perm_id)) roleIds.add(r.role_id); });
  return roleIds;
}

/**
 * 授权防锁死（v3.58）：拦截「会让系统失去全部管理员」的变更。
 *
 * @param nextRolesByUser 变更后各用户的角色 id 集合（未列入的用户按现状计）
 * 只拦归零场景：单人调岗、降权、停用其余管理员等正常操作不受影响。
 */
export async function assertNotLockout(
  ds: DataSource,
  nextRolesByUser: Map<string, string[]>,
): Promise<void> {
  const capable = await adminCapableRoleIds(ds);
  if (capable.size === 0) return; // 无角色具备管理能力：属既有配置问题，交由角色权限接口自行防护
  const users = (await ds.getRepository('t_user').find({
    where: { tenant_id: RBAC_TENANT, status: 'active' },
  } as any)) as any[];
  const ur = (await ds.getRepository('t_user_role').find()) as any[];
  const current = new Map<string, string[]>();
  ur.forEach((r) => {
    const arr = current.get(r.user_id) ?? [];
    arr.push(r.role_id);
    current.set(r.user_id, arr);
  });
  const survives = users.some((u) => {
    const next = nextRolesByUser.get(u.user_id) ?? current.get(u.user_id) ?? [];
    return next.some((id) => capable.has(id));
  });
  if (!survives) {
    throw new BadRequestException(
      '该操作会使系统失去全部管理员（至少需保留一名具备用户/角色管理权限的在用账号）',
    );
  }
}

/**
 * 方法资质状态（借鉴 MTM Blue Card / MOST 分级认证：等级 + 有效期）。
 * none=未认证 / valid=有效 / expiring=30 天内到期 / expired=已过期。
 * 分级处置原则：过期只提示与限权，**不禁用账号**——能力失效不等于身份失效。
 */
export function certStatusOf(certLevel: string | null | undefined, certExpiresAt: any): string {
  const lv = String(certLevel ?? '').trim();
  if (!lv || lv === 'none') return 'none';
  if (!certExpiresAt) return 'valid';
  const at = new Date(certExpiresAt).getTime();
  if (Number.isNaN(at)) return 'valid';
  if (at < Date.now()) return 'expired';
  if (at - Date.now() <= 30 * 24 * 3600 * 1000) return 'expiring';
  return 'valid';
}
