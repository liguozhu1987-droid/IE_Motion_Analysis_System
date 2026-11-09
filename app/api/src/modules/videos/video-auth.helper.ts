import { Logger, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { AuthUserLoader } from '../../auth/auth-user.loader';
import { AuthedRequest, AuthUser } from '../../auth/auth-user.interface';

/**
 * 视频模块共享鉴权/下发助手。
 * 鉴权范式来自 videos.controller.ts：Bearer 头优先，回退 ?token= 查询参数
 * （<video>/<img> 标签发不了 Authorization 头）。
 */

/** 手动鉴权（@Public 端点用）：返回用户或 null，不抛错 */
export async function resolveAuthUser(
  jwt: JwtService, loader: AuthUserLoader, req: AuthedRequest,
): Promise<AuthUser | null> {
  const header = req.headers?.['authorization'];
  const raw = Array.isArray(header) ? header[0] : header;
  let token = raw?.startsWith('Bearer ') ? raw.slice(7) : null;
  const q = typeof (req as unknown as { query?: Record<string, unknown> }).query?.token === 'string'
    ? (req as unknown as { query: Record<string, unknown> }).query.token as string
    : null;
  if (!token && q) token = q;
  if (!token) return null;
  try {
    const payload = jwt.verify(token);
    return await loader.load(payload.sub);
  } catch {
    return null;
  }
}

/** 校验并返回用户：无 token / 权限不足 → 401（与现有 file/:name 口径一致） */
export async function requireStationRead(
  jwt: JwtService, loader: AuthUserLoader, req: AuthedRequest,
): Promise<AuthUser> {
  const user = await resolveAuthUser(jwt, loader, req);
  if (!user) throw new UnauthorizedException('无效或缺失的访问令牌');
  if (!user.permissions.has('station:read')) throw new UnauthorizedException('权限不足：需要 station:read');
  return user;
}

/**
 * sendFile 安全下发（SPEC-VID-P0 §7.2）：
 * 增加 callback 后，sendFile 的裸 Error（416 Range Not Satisfiable / 404 等）
 * 不再走 next(err) 被 AllExceptionsFilter 当成未知异常转 500——按真实状态码回复；
 * 头已发出（206 中途断开等）则只能销毁连接。响应体对齐全局错误信封 { title, status, detail }。
 */
export function sendFileSafe(
  log: Logger, res: Response, filePath: string, headers: Record<string, string>,
): void {
  res.sendFile(filePath, { headers }, (err) => {
    if (!err) return;
    const status = Number((err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode ?? 500);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (status >= 500) log.error(`sendFile 失败 ${filePath}: ${(err as Error).message}`);
    const title = status === 416 ? '请求范围不可满足'
      : status === 404 ? '文件不存在'
        : status === 400 ? '请求参数非法' : '服务器内部错误';
    res.status(status).json({ title, status, detail: String((err as Error).message ?? '').slice(0, 200) });
  });
}
