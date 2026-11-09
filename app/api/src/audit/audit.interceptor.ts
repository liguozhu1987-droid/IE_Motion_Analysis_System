import { NestInterceptor, ExecutionContext, CallHandler, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap } from 'rxjs';
import { AuditService } from './audit.service';
import { AuthedRequest } from '../auth/auth-user.interface';
import { clientIp } from '../auth/auth.service';
import { SKIP_AUDIT } from './skip-audit.decorator';

/**
 * 审计拦截器：写操作（POST/PUT/PATCH/DELETE）记录
 * 谁/何时/对什么实体/前后内容摘要。@SkipAudit 可跳过（登录等已单独审计）。
 *
 * v3.58：真正实现 @SkipAudit——此前只有注释没有机制，代置口令等端点会把明文凭证
 * 写进 after_json（二次泄露面）。跳过前先在日志留一行，避免"静默不审计"。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly log = new Logger('AuditInterceptor');

  constructor(private readonly audit: AuditService, private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): any {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || !req.user) return next.handle();
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT, [ctx.getHandler(), ctx.getClass()]);
    if (skip) {
      this.log.debug(`跳过响应体审计（业务侧自审计）：${method} ${req.path ?? ''}`);
      return next.handle();
    }
    return next.handle().pipe(
      tap({
        next: (data) => {
          const action = `${method.toLowerCase()}_${(req.path ?? '').replace(/^\/api\//, '').replace(/\//g, '_')}`;
          this.audit.record(req.user ?? null, action, req.path ?? '', null, null, data, clientIp(req));
        },
      }),
    );
  }
}
