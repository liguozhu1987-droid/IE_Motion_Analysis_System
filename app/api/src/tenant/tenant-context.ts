import { AsyncLocalStorage } from 'node:async_hooks';

/** 租户上下文：请求级传递 tenant_id，Repository 自动读取，漏写即编译期可见（泛型约束）。 */
export const tenantStorage = new AsyncLocalStorage<{ tenantId: string }>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}

export function currentTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}
