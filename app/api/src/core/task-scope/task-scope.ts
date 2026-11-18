import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../auth/auth-user.interface';
import { DecompositionTask } from '../../entities/decomposition-task.entity';

/**
 * Phase 3 / Wave 1 · 分解任务上下文（D1 冻结口径）。
 *
 * 一个请求在读写 t_element 之前，必须先解析出「本请求属于哪个分解任务」。
 * 四种来源：
 *   explicit        请求显式带 task_id → 校验后采用
 *   inherited       该工位只归属一个生效（active 且非 legacy）任务 → 自动继承
 *   legacy-fallback 没有生效任务 → 回落该产线的 legacy 归档任务，并标注 D2 风险
 *   none            连 legacy 任务也不存在（如隔离 SQLite 空库）→ 不附加 task_id 条件
 *
 * none 是唯一「明确标注的兼容路径」：它保证无任务表的隔离测试不被打穿，
 * 生产 SQL Server 因 migrate 已按 (tenant,line) 建 legacy 任务，永远不会走这条。
 */
export type TaskScopeSource = 'explicit' | 'inherited' | 'legacy-fallback' | 'none';

export interface TaskScope {
  task_id: string | null;
  task_no: string | null;
  source: TaskScopeSource;
  fallback: boolean;
}

export const NO_SCOPE: TaskScope = { task_id: null, task_no: null, source: 'none', fallback: true };

export function scopeOf(t: DecompositionTask, source: TaskScopeSource): TaskScope {
  return {
    task_id: t.task_id,
    task_no: t.task_no,
    source,
    fallback: source === 'legacy-fallback' || source === 'none',
  };
}

/** 统一附加 task_id 条件（唯一入口；静态验收脚本据此判定残留=0） */
export function withTask<T extends Record<string, any>>(where: T, scope: TaskScope): T & { task_id?: string } {
  return scope.task_id ? { ...where, task_id: scope.task_id } : { ...where };
}

/** 内存侧过滤（dashboard / lines 一次取回后按工位分组时用） */
export function matchesTask(el: { task_id?: string | null }, scope: TaskScope): boolean {
  return !scope.task_id || String(el.task_id ?? '') === String(scope.task_id);
}

/** 响应体标记：前端据此显示 D2 兼容模式风险提示 */
export function scopeMarker(scope: TaskScope) {
  return { task_id: scope.task_id, task_no: scope.task_no, source: scope.source, fallback: scope.fallback };
}

/**
 * 任务级可读性唯一口径（与 TasksService.assertTaskReadable 共用一个实现）：
 * 同租户 + 不存在返回 404，不回显他租户任务的存在性。
 */
export async function findReadableTask(ds: DataSource, taskId: string, user: AuthUser): Promise<DecompositionTask> {
  const t = await ds.getRepository(DecompositionTask).findOne({
    where: { task_id: taskId, tenant_id: user.tenantId },
  } as any);
  if (!t || String(t.tenant_id) !== String(user.tenantId)) throw new NotFoundException('分解任务不存在');
  return t;
}
