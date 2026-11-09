import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { createLogger, log } from './logger.js';
import { closeDb, openDb } from './db/index.js';
import { loadRules } from './rules/rules.js';
import { toErrorPayload, BadRequestError } from './errors.js';
import { buildRouter } from './routes.js';
import { seedIfEmpty } from './db/seed.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4',
};

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = origin && origin === config.origin ? origin : config.origin;
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res, status, payload, requestId) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Request-Id': requestId ?? '',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new BadRequestError(`请求体超过 ${config.maxBodyBytes} 字节限制`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve(undefined); return; }
      const contentType = String(req.headers['content-type'] ?? '');
      if (contentType.includes('application/json')) {
        try { resolve(JSON.parse(text)); } catch { reject(new BadRequestError('请求体不是合法 JSON')); }
        return;
      }
      resolve(text);
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  const decoded = decodeURIComponent(url.pathname);
  let filePath = path.join(config.webDist, decoded);
  if (!filePath.startsWith(config.webDist)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  if (!exists) {
    // SPA 回退：无扩展名的路径交给前端路由
    if (path.extname(decoded) === '') filePath = path.join(config.webDist, 'index.html');
    else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建：请在 app 目录执行 npm run build（或使用 npm run dev 启动 Vite）');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

openDb();
const rules = loadRules();
if (config.seed) {
  const result = seedIfEmpty();
  log.info('种子数据检查完成', result);
}

const router = buildRouter();
const server = http.createServer(async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  applyCors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const logger = createLogger({ request_id: requestId, method: req.method, path: url.pathname });

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, url);
    return;
  }

  const matched = router.match(req.method, url.pathname);
  if (!matched) {
    sendJson(res, 404, { title: 'NOT_FOUND', status: 404, detail: `接口不存在：${req.method} ${url.pathname}`, request_id: requestId }, requestId);
    return;
  }

  try {
    const body = await readBody(req);
    const data = await matched.handler({
      req,
      params: matched.params,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      requestId,
      log: logger,
    });
    if (data && typeof data === 'object' && data.__raw) {
      res.writeHead(200, { 'Content-Type': data.__raw.contentType, 'X-Request-Id': requestId });
      res.end(data.__raw.body);
    } else {
      sendJson(res, 200, data ?? { ok: true }, requestId);
    }
    logger.info('请求完成', { status: 200, duration_ms: Date.now() - startedAt });
  } catch (err) {
    const payload = toErrorPayload(err, requestId);
    if (payload.status >= 500) logger.error('请求失败', { status: payload.status, error: err.message, stack: err.stack });
    else logger.warn('请求被拒绝', { status: payload.status, error: err.message });
    sendJson(res, payload.status, payload, requestId);
  }
});

server.listen(config.port, config.host, () => {
  log.info('服务已启动', {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    db: config.dbPath,
    rules_rv: rules.rv,
    cors_origin: config.origin,
  });
});

function shutdown(signal) {
  log.info('收到退出信号，开始优雅关闭', { signal });
  server.close(() => {
    closeDb();
    log.info('已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
