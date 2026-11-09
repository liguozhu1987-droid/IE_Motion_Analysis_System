/**
 * 前端静态资源托管（打包部署形态的核心一环）：让 IE平台.exe 单进程同时提供
 * /api（NestJS）与 SPA 前端，目标服务器不再需要 IIS/nginx 托管静态文件。
 *
 * 设计对齐 legacy MVP 的 serveStatic（经生产验证）：
 *  - 只读 GET/HEAD，其余方法放行给后续中间件；
 *  - 防目录穿越：join 后必须仍位于根目录内；
 *  - SPA 回退仅对无扩展名路径生效（带扩展名找不到就是 404，不掩盖真实缺失）；
 *  - /api 一律不碰（含 /api 本身），API 404 语义保持不变；
 *  - index.html 不缓存、hashed 资产长缓存——SPA 发版后刷新即生效。
 *
 * 目录不存在（开发期未构建 / API-only 部署）时返回 null，由调用方跳过挂载：
 * 宁缺勿错，API 照常运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function createWebAssetsMiddleware(webDist: string): ((req: Request, res: Response, next: NextFunction) => void) | null {
  const root = path.resolve(webDist);
  if (!fs.existsSync(path.join(root, 'index.html'))) return null;

  return function webAssets(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    // 本中间件终态响应自带基础安全头：helmet 在本中间件之前注册（API 专用 CSP
    // 'none' 不能落到静态响应上），nosniff 在此补齐，防 MIME 嗅探。
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let decoded: string;
    try {
      decoded = decodeURIComponent(new URL(req.url ?? '/', 'http://internal.invalid').pathname);
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    // API 路由一律不碰；/api 本身与 /api/xxx 的 404 语义留给 Nest 路由
    if (decoded === '/api' || decoded.startsWith('/api/')) return next();

    let filePath = path.normalize(path.join(root, decoded));
    if (!filePath.startsWith(root)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const isFile = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    if (!isFile) {
      // SPA 回退：无扩展名的路径（前端路由）交还 index.html；带扩展名即真实 404
      if (path.extname(decoded) === '') filePath = path.join(root, 'index.html');
      else {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
    }
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    if (decoded.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  };
}
