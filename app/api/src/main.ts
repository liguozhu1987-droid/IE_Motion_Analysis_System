import 'dotenv/config'; // 配置文件（.env）优先于默认值加载；须在读取 process.env 的模块之前
import path from 'node:path';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './core/all-exceptions.filter';
import { loadConfig } from './core/config/configuration';
import { collectStartupChecks, logStartupChecks } from './core/startup/startup-check';
import { createWebAssetsMiddleware } from './core/web-assets';

/** 只压缩 JSON / 文本类响应：本服务唯一的二进制出口是前端静态资源（由 IIS 托管），
 *  在这里压缩图片/字体只会白烧 CPU 并可能把已压缩内容压得更大 */
const COMPRESSIBLE_TYPE = /^(?:application\/(?:json|xml|javascript|x-ndjson|x-www-form-urlencoded)|text\/)/i;

function compressionFilter(_req: Request, res: Response): boolean {
  const contentType = String(res.getHeader('Content-Type') ?? '');
  if (!contentType) return false;
  // 已自带编码（如 IIS/ARR 已压过）时不再二次压缩，避免双重编码
  if (res.getHeader('Content-Encoding')) return false;
  return COMPRESSIBLE_TYPE.test(contentType);
}

async function bootstrap() {
  const cfg = loadConfig(); // fail-fast：非法配置启动即失败
  /* P0-3 启动自检：生产必需配置缺失只 warn（逐条给修复动作），
     仅安全相关项（生产仍用 dev- 前缀 JWT 密钥）会 fail 并中止启动。 */
  const startupLog = new Logger('StartupCheck');
  if (!logStartupChecks(collectStartupChecks(process.env, cfg), startupLog)) {
    throw new Error('启动自检失败：存在安全相关配置缺失（见上方 FAIL 项）');
  }
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  /*
   * ── 0) 前端静态托管（打包部署形态）─────────────────────────────────────
   * 让单进程同时提供 API 与 SPA，目标服务器无需 IIS/nginx 托管静态文件。
   * 默认 ./web/dist（相对 exe 所在目录——cli.ts 启动时已 chdir 过去）；
   * 目录不存在（开发期未构建 / API-only 部署）则跳过挂载，服务退化为纯 API 形态。
   *
   * **必须先于 helmet 注册**：helmet 的 CSP 是"最严 API 形态"（default-src 'none'），
   * 若静态响应也带上它，浏览器会把 SPA 的 JS/CSS 全部拦掉（页面空白，而 curl
   * 不执行 CSP 所以 200 看不出来）。Express 中间件按注册顺序执行——托管中间件
   * 先注册并终态响应，helmet 根本不会跑到静态请求上；API 请求 next() 后照常经过。
   */
  const webDist = process.env.WEB_DIST ?? path.resolve(process.cwd(), 'web', 'dist');
  const webAssets = createWebAssetsMiddleware(webDist);
  if (webAssets) app.use(webAssets);

  /*
   * ── 1) 安全响应头 ──────────────────────────────────────────────────────
   * 本服务只返回 JSON（页面由 IIS 托管），所以 CSP 走"最严 API 形态"：
   * default-src 'none' —— 即使响应被当成 HTML 渲染，也不允许加载任何资源，
   * 从根上掐掉"API 返回的 JSON 被 MIME 嗅探成脚本/页面"的利用链。
   */
  const hstsEnabled = cfg.nodeEnv === 'production' || cfg.secHsts;
  app.use(helmet({
    contentSecurityPolicy: {
      // 关掉 helmet 默认指令集：默认值面向 HTML 站点（script-src 'self' 等），
      // 对纯 JSON 服务是噪音，还会引入 upgrade-insecure-requests 打断内网 HTTP 调试
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
      },
    },
    // 本服务不允许被任何页面套 frame（不存在"API 被内嵌"的合法场景）→ DENY 而非 SAMEORIGIN
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    /*
     * 关键坑：helmet 默认 crossOriginResourcePolicy=same-origin 会按"SAMEORIGIN"语义
     * 拦截跨源读取。开发期前端是 localhost:5173 → 127.0.0.1:3001（跨源），
     * 会被浏览器直接拦成 net::ERR_BLOCKED_BY_RESPONSE，表现为"接口莫名 0 响应"。
     * 本服务是给自家前端调的 JSON API，跨源读取本就是设计意图 → cross-origin。
     */
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // COEP 会强制 require-corp，对已存在的跨端口调试同样是坑，显式关闭
    crossOriginEmbedderPolicy: false,
    // HSTS 只给生产/显式开启：内网若仍是明文 HTTP，下发 HSTS 会把浏览器钉死在 https
    hsts: hstsEnabled ? { maxAge: 15_552_000, includeSubDomains: true, preload: false } : false,
  }));

  /* ── 2) 响应压缩：驾驶舱 summary 约 10KB JSON，gzip 后约 1~2KB ─────────── */
  app.use(compression({
    threshold: 1024,           // < 1KB 的响应压了反而更大（gzip 头 + 分块开销）
    filter: compressionFilter, // 只压 JSON/文本；/metrics 的 text/plain 也走这条
  }));

  /*
   * ── 3) 去指纹 + 不启用 Express 的 trust proxy ──────────────────────────
   * trust proxy 一旦开启，Express 会自行解析 x-forwarded-for 并写进 req.ip，
   * 而 XFF 在"ARR 与 API 同机"的部署下可被任何同机进程伪造。
   * 本项目的客户端 IP 只走 clientIp()（见 auth.service.ts），req.ip 不作为可信来源。
   */
  const httpInstance = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
    disable?: (setting: string) => void;
  };
  // helmet 自带 x-powered-by 移除，显式再写一行：它是"去指纹"的唯一防线，防止将来换实现时静默回退
  if (typeof httpInstance.disable === 'function') httpInstance.disable('x-powered-by');
  if (typeof httpInstance.set === 'function') httpInstance.set('trust proxy', false);

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  }));

  /* ── 4) CORS：同源部署（前端由本进程托管）下浏览器不会发预检也无跨源读 ──── */
  app.enableCors({
    origin: process.env.ORIGIN?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
  });
  await app.listen(cfg.port, cfg.host); // 默认仅回环；单文件部署版在 .env 显式 HOST=0.0.0.0 直曝

  const log = new Logger('Bootstrap');
  log.log(
    `IE平台 API 启动: http://${cfg.host}:${cfg.port}/api  db=${cfg.dbType} ai=${cfg.aiEnabled ? 'on' : 'off'} env=${cfg.nodeEnv}`,
  );
  log.log(`前端托管: ${webAssets ? webDist : '未启用（未找到 index.html，纯 API 形态）'}`);
  log.log(`安全: hsts=${hstsEnabled ? 'on' : 'off'} 客户端IP头=${cfg.clientIpHeader} 可信反代=${cfg.trustedProxies.join(',')}`);
  log.log(`驾驶舱缓存 TTL=${cfg.dashboardCacheTtlMs}ms  数据库连接池 max=${cfg.dbPoolMax}`);
  /* 连接池预热（性能 #73）：启动即打一发 CMC 探活查询。首用户的第一次 CMC 查询
     要付 TCP 握手 + sp_reset + 数据页冷读的叠加成本（实测冷启动首查可达数秒），
     预热把这部分挪到启动期；失败静默——CMC 不可达不阻塞本系统启动（宁缺勿错）。 */
  try {
    const ds = app.get(DataSource);
    await ds.query(`SELECT TOP 1 id FROM CMC.dbo.factories`);
    log.log('CMC 连接池预热完成');
  } catch (e) {
    log.warn(`CMC 预热失败（不阻塞启动）: ${(e as Error).message}`);
  }
}

bootstrap().catch((e) => {
  // 启动失败（含规则自检失败）直接退出，PM2/NSSM 会拉起重试
  console.error('启动失败:', e);
  process.exit(1);
});
