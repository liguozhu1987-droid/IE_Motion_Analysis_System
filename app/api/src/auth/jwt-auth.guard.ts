import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC } from '../rbac/public.decorator';
import { AuthUserLoader } from './auth-user.loader';
import { AuthedRequest } from './auth-user.interface';

/**
 * 全局守卫①：JWT 认证。
 * @Public 路由跳过；否则校验 Bearer token 并加载用户挂 req.user。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly loader: AuthUserLoader,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (isPublic) return true;
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw?.startsWith('Bearer ')) throw new UnauthorizedException('缺少访问令牌');
    const token = raw.slice(7);
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
    const user = await this.loader.load(payload.sub);
    if (!user) throw new UnauthorizedException('用户不存在或已停用');
    req.user = user;
    // v3.57：会话认证来源（SSO 与本地登录签发的 JWT 都合法，/auth/me 据此下发 authSource）
    req.authSource = payload.src === 'oidc' ? 'oidc' : 'local';
    return true;
  }
}
