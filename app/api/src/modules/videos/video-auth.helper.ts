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

/** 媒体令牌声明：scope=media + vid=源视频名；只允许被同名视频的下发端点接受 */
export const MEDIA_TOKEN_SCOPE = 'media';

/**
 * JWT_TTL 解析（m/h/d；与 auth.service parseTtl 同口径），返回秒。
 * 非法值回落 fallbackSec——媒体令牌宁可短也不给无限期。
 */
export function parseJwtTtlSec(ttl: string, fallbackSec: number): number {
  const m = /^(\d+)([mhd])$/.exec(ttl);
  if (!m) return fallbackSec;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : n * 86400;
}

/** 手动鉴权（@Public 端点用）：返回用户或 null，不抛错。
 *  expectedMediaName 传入时：携带 scope=media 的长时效媒体令牌必须 vid 与该视频名一致，
 *  否则按无效令牌处理（防止拿 A 视频的令牌读 B 视频）。 */
export async function resolveAuthUser(
  jwt: JwtService, loader: AuthUserLoader, req: AuthedRequest, expectedMediaName?: string,
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
    const payload = jwt.verify(token) as { sub?: string; scope?: unknown; vid?: unknown };
    if (payload?.scope === MEDIA_TOKEN_SCOPE) {
      if (!expectedMediaName || payload.vid !== expectedMediaName) return null;
    }
    if (!payload?.sub) return null;
    return await loader.load(payload.sub);
  } catch {
    return null;
  }
}

/** 校验并返回用户：无 token / 权限不足 → 401（与现有 file/:name 口径一致） */
export async function requireStationRead(
  jwt: JwtService, loader: AuthUserLoader, req: AuthedRequest, expectedMediaName?: string,
): Promise<AuthUser> {
  const user = await resolveAuthUser(jwt, loader, req, expectedMediaName);
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
