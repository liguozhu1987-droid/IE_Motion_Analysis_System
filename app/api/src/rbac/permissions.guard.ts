import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_PERMISSIONS } from '../rbac/require-permission.decorator';
import { IS_PUBLIC } from './public.decorator';
import { AuthedRequest } from '../auth/auth-user.interface';

/**
 * 全局守卫③：RBAC 权限校验（安全默认）。
 * 未标注 @RequirePermission 的路由（且非 @Public）→ 直接 403；
 * 标注多个权限点 → 满足其一即放行。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true; // @Public 路由直接放行
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    if (!required || required.length === 0) {
      throw new ForbiddenException('该接口未授权访问（默认拒绝：请显式声明权限）');
    }
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException('未认证');
    const ok = required.some((code) => user.permissions.has(code));
    if (!ok) throw new ForbiddenException(`权限不足：需要 ${required.join(' 或 ')}`);
    return true;
  }
}
