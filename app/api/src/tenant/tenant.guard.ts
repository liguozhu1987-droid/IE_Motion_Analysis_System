import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { AuthedRequest } from '../auth/auth-user.interface';

/**
 * 全局守卫②：租户一致性。
 * 请求可带 x-tenant-id 头（未来多租户切换入口）；与 token 租户不一致 → 403。
 * 正常内网使用不带该头，恒等于 token 租户。
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) return true; // 未认证交给 JwtAuthGuard
    const header = req.headers['x-tenant-id'];
    const requested = Array.isArray(header) ? header[0] : header;
    if (requested && requested !== req.user.tenantId) {
      throw new ForbiddenException('越权访问：请求租户与当前用户租户不一致');
    }
    return true;
  }
}
