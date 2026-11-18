/**
 * Phase 3 / D1 · 前端「当前分解任务」上下文。
 *
 * 设计约束（§3.7 硬约束）：**不新增任何前端必填步骤**。
 * 当前任务只在用户于批量导出弹窗里显式选择/新建任务时记录；
 * 未选择时一律不传 task_id，由服务端 resolveTaskId 自动继承或回落 legacy。
 * 因此本模块不是权限来源，只是「把用户已表达的意图带到其它链路」的载体。
 */
const STORAGE_KEY = 'ie.currentTaskId';

export interface TaskScopeEcho {
  task_id: string | null;
  task_no: string | null;
  source: 'explicit' | 'inherited' | 'legacy-fallback' | 'none';
  fallback: boolean;
}

let currentTaskId = '';
let lastScope: TaskScopeEcho | null = null;

try {
  currentTaskId = localStorage.getItem(STORAGE_KEY) ?? '';
} catch { /* 隐私模式 / SSR：仅内存态，不影响功能 */ }

export function getCurrentTaskId(): string {
  return currentTaskId;
}

export function setCurrentTaskId(taskId: string | null): void {
  currentTaskId = taskId ?? '';
  try {
    if (currentTaskId) localStorage.setItem(STORAGE_KEY, currentTaskId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* 同上 */ }
  try {
    window.dispatchEvent(new CustomEvent('ie:task-change', { detail: currentTaskId }));
  } catch { /* 非浏览器环境 */ }
}

export function getLastTaskScope(): TaskScopeEcho | null {
  return lastScope;
}

/** 从响应头读取 D2 兼容模式标记（响应体里的 task_scope 双保险） */
export function captureTaskScope(res: Response): void {
  const source = res.headers.get('X-Task-Scope');
  if (!source) return;
  lastScope = {
    task_id: null,
    task_no: null,
    source: source as TaskScopeEcho['source'],
    fallback: res.headers.get('X-Task-Fallback') === 'legacy-fallback',
  };
}

/** 响应体带 task_scope 时用它覆盖（信息更全：含任务号） */
export function captureTaskScopeBody(payload: unknown): void {
  const s = (payload as { task_scope?: TaskScopeEcho } | null)?.task_scope;
  if (s && typeof s.source === 'string') lastScope = s;
}
