import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from '../../audit/audit.service';
import { TaskScopeHolder, runWithTaskScope } from './task-scope-context';

/**
 * Phase 3 / Wave 1 · D2 兼容模式标记。
 *
 * Service 只管把解析结果写进 ALS，这里统一写响应头：
 *   X-Task-Scope: explicit | inherited | legacy-fallback | none
 *   X-Task-Fallback: legacy-fallback   （仅回落时）
 * 并在回落时补一条审计（新增 action，不改动既有 action 派生规则）。
 * Wave 2 / #108：回落审计把已解析的任务号一并写入 t_audit_log.task_id；
 * 兼容模式（none）写 null，不冒充任务号。审计写入失败不阻断响应。
 */
@Injectable()
export class TaskScopeInterceptor implements NestInterceptor {
  constructor(@Optional() private readonly audit?: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const http = ctx.switchToHttp();
    const req: any = http.getRequest();
    const res: any = http.getResponse();
    const holder: TaskScopeHolder = { scope: null };

    return new Observable((subscriber) => {
      runWithTaskScope(holder, () => {
        next.handle()
          .pipe(tap(() => {
            const s = holder.scope;
            if (!s || !res?.setHeader) return;
            res.setHeader('X-Task-Scope', s.source);
            if (!s.fallback) return;
            res.setHeader('X-Task-Fallback', 'legacy-fallback');
            try {
              this.audit?.record(
                req?.user ?? null,
                'task_scope.legacy_fallback',
                't_decomposition_task',
                s.task_id ?? null,
                null,
                { task_no: s.task_no, source: s.source, path: String(req?.originalUrl ?? '') },
                String(req?.ip ?? ''),
                s.task_id ?? null,
              );
            } catch { /* 审计失败不阻断响应 */ }
          }))
          .subscribe(subscriber);
      });
    });
  }
}
