import { NestInterceptor, ExecutionContext, CallHandler, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithTenant } from './tenant-context';
import { AuthedRequest } from '../auth/auth-user.interface';

/**
 * 租户拦截器：把请求包进 AsyncLocalStorage（tenant_id），
 * BaseRepository 在同一异步上下文自动附加 tenant_id 过滤——业务代码零感知。
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const tenantId = req.user?.tenantId ?? 'DEFAULT';
    return new Observable((subscriber) => {
      runWithTenant(tenantId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
