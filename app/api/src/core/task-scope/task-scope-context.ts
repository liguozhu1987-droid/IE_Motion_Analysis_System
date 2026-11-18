import { AsyncLocalStorage } from 'node:async_hooks';
import { TaskScope } from './task-scope';

/** 请求级任务上下文载体：Service 写入、全局拦截器读取后写响应头/审计（Service 无需碰 Request 对象） */
export interface TaskScopeHolder {
  scope: TaskScope | null;
}

export const taskScopeStorage = new AsyncLocalStorage<TaskScopeHolder>();

export function runWithTaskScope<T>(holder: TaskScopeHolder, fn: () => T): T {
  return taskScopeStorage.run(holder, fn);
}

export function markTaskScope(scope: TaskScope): void {
  const holder = taskScopeStorage.getStore();
  if (holder) holder.scope = scope;
}

/**
 * Phase 3 / Wave 2 · 无 station_id 的写入点（如 t_ai_task 队列）从请求上下文取当前任务号。
 * 读不到时返回 null —— 兼容模式「如实标注」，绝不臆造或反推任务号。
 */
export function currentTaskScope(): TaskScope | null {
  return taskScopeStorage.getStore()?.scope ?? null;
}
