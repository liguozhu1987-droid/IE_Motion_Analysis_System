/**
 * 租户级全权角色（v3.56 抽为单一数据源）。
 *
 * 语义：命中即「不看 data_scope、不看归属」——可见范围覆盖全租户（聚合层可跨租户）。
 * 此前该集合在 stations.service / dashboard.controller / ai-waste.controller / videos.service
 * 各自硬编码一份，口径漂移风险高；后续新增判定一律 import 本常量。
 */
export const FULL_ACCESS_ROLES: ReadonlySet<string> = new Set(['sys_admin', 'ie_admin']);

/** 角色集合是否含全权角色 */
export function hasFullAccess(roles: string[] | undefined | null): boolean {
  return Array.isArray(roles) && roles.some((r) => FULL_ACCESS_ROLES.has(r));
}
