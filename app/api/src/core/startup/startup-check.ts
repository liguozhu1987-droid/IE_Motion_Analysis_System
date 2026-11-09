import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Logger } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { loadCapacityConfig } from '../../modules/videos/derivative-capacity';

/**
 * 启动自检（P0-3）：
 *  - 生产必需但缺失的配置 → **warn 不阻断**，日志里逐条可见并给修复提示；
 *  - 只有「会导致安全问题」的项才 fail（当前仅生产环境仍用 dev- 前缀 JWT 密钥），
 *    由 main.ts 在 listen 之前抛出，避免带着默认密钥对外服务。
 *
 * 设计取舍：不在这里连数据库/发 SMTP 探活——自检只是"配置存在性 + 本机可执行性"，
 * 任何外部依赖失败都不应阻塞启动（与 CMC 预热同口径：宁缺勿错）。
 */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckItem {
  name: string;
  status: CheckStatus;
  detail: string;
  /** 缺失时的修复动作（warn/fail 必填，便于运维直接照做） */
  remediation?: string;
}

function ffmpegStatus(env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  const candidates = [
    env.FFMPEG_BIN,
    path.resolve(process.cwd(), 'bin', 'ffmpeg.exe'),
    path.resolve(process.cwd(), 'bin', 'ffmpeg'),
  ].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { ok: true, detail: candidate };
  }
  const probe = spawnSync('ffmpeg', ['-version'], { timeout: 5000, encoding: 'utf8' });
  if (probe.status === 0) return { ok: true, detail: 'PATH 中的 ffmpeg' };
  return { ok: false, detail: (probe.error as Error | undefined)?.message ?? '未找到 ffmpeg' };
}

function dirWritable(dir: string): { ok: boolean; detail: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true, detail: dir };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export function collectStartupChecks(env: NodeJS.ProcessEnv, cfg: AppConfig): CheckItem[] {
  const items: CheckItem[] = [];
  const production = cfg.nodeEnv === 'production';

  // 1) 运行环境
  items.push(production
    ? { name: 'NODE_ENV', status: 'ok', detail: 'production' }
    : {
      name: 'NODE_ENV', status: 'warn', detail: `当前为 ${cfg.nodeEnv}`,
      remediation: '生产部署请设置 NODE_ENV=production（决定同步建表、HSTS 与鉴权严格度）',
    });

  // 2) JWT 密钥（安全问题：唯一 fail 项）
  const devJwt = cfg.jwtAccessSecret.startsWith('dev-') || cfg.jwtRefreshSecret.startsWith('dev-');
  if (devJwt) {
    items.push({
      name: 'JWT_SECRET', status: production ? 'fail' : 'warn',
      detail: '仍在使用 dev- 前缀默认密钥',
      remediation: '配置 JWT_ACCESS_SECRET / JWT_REFRESH_SECRET（32 字节随机 hex，各一份）',
    });
  } else {
    items.push({ name: 'JWT_SECRET', status: 'ok', detail: '已配置自定义密钥' });
  }

  // 3) 数据库形态
  if (production && cfg.dbType !== 'mssql') {
    items.push({
      name: 'DATABASE', status: 'warn', detail: `生产环境使用 ${cfg.dbType}（非 SQL Server）`,
      remediation: '生产请设置 DB_TYPE=mssql 并确认 DB_HOST/DB_NAME/DB_USER/DB_PASS',
    });
  } else if (cfg.dbType === 'mssql' && !cfg.dbPass) {
    items.push({
      name: 'DATABASE', status: 'warn', detail: 'DB_PASS 为空',
      remediation: 'SQL Server 认证需要口令；若用 Windows 集成认证请确认驱动/连接串配置',
    });
  } else {
    const target = cfg.dbType === 'sqlite' ? cfg.dbPath : `${cfg.dbHost}:${cfg.dbPort}/${cfg.dbName}`;
    items.push({ name: 'DATABASE', status: 'ok', detail: `${cfg.dbType} @ ${target}` });
  }

  // 4) SMTP（告警邮件；缺失只落日志）
  if (cfg.smtpHost && cfg.alertMailTo) {
    items.push({ name: 'SMTP', status: 'ok', detail: `${cfg.smtpHost}:${cfg.smtpPort} → ${cfg.alertMailTo}` });
  } else {
    items.push({
      name: 'SMTP', status: 'warn', detail: 'SMTP_HOST 或 ALERT_MAIL_TO 未配置，告警只写日志不发信',
      remediation: '配置 SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM / ALERT_MAIL_TO',
    });
  }

  // 5) 派生磁盘预算（不猜数字：未配置 = 治理关闭）
  const cap = loadCapacityConfig(env);
  if (cap.maxGbConfigured && cap.maxGb) {
    items.push({ name: 'VIDEO_DERIVED_MAX_GB', status: 'ok', detail: `${cap.maxGb}GB，并发 ${cap.concurrency}` });
  } else {
    items.push({
      name: 'VIDEO_DERIVED_MAX_GB', status: 'warn', detail: '未配置：派生磁盘治理关闭（不告警、不淘汰）',
      remediation: '按目标机磁盘预算填写（6C/150G 目标机推荐 60，见 docs/ops/VIDEO-CAPACITY.md）',
    });
  }

  // 6) ffmpeg（派生/上传转码的前提）
  const ff = ffmpegStatus(env);
  items.push(ff.ok
    ? { name: 'FFMPEG', status: 'ok', detail: ff.detail }
    : {
      name: 'FFMPEG', status: 'warn', detail: ff.detail,
      remediation: '放置 app/api/bin/ffmpeg.exe 或配置 FFMPEG_BIN；否则非原生格式上传 503、派生全部失败',
    });

  // 7) 运行目录可写（上传/派生/日志都依赖 cwd）
  const storage = dirWritable(path.resolve(process.cwd(), 'storage', 'videos'));
  items.push(storage.ok
    ? { name: 'STORAGE_DIR', status: 'ok', detail: storage.detail }
    : {
      name: 'STORAGE_DIR', status: 'warn', detail: `不可写：${storage.detail}`,
      remediation: '确认运行账号对 storage/videos 有读写权限（IIS 应用池账号或服务账号）',
    });
  const logDir = dirWritable(cfg.logDir);
  items.push(logDir.ok
    ? { name: 'LOG_DIR', status: 'ok', detail: logDir.detail }
    : {
      name: 'LOG_DIR', status: 'warn', detail: `不可写：${logDir.detail}`,
      remediation: '配置 LOG_DIR 到有写权限的目录（审计保留清理日志也写在这里）',
    });

  // 8) 前端静态资源（纯 API 形态可接受，但生产页面会起不来）
  const webDist = env.WEB_DIST ?? path.resolve(process.cwd(), 'web', 'dist');
  const hasWeb = fs.existsSync(path.join(webDist, 'index.html'));
  items.push(hasWeb
    ? { name: 'WEB_DIST', status: 'ok', detail: webDist }
    : {
      name: 'WEB_DIST', status: 'warn', detail: `未找到 ${path.join(webDist, 'index.html')}（纯 API 形态）`,
      remediation: '构建前端并部署到 wwwroot 由 IIS 托管，或配置 WEB_DIST 指向构建产物',
    });

  // 9) 指标抓取令牌
  items.push(cfg.metricsToken
    ? { name: 'METRICS_TOKEN', status: 'ok', detail: '已配置' }
    : {
      name: 'METRICS_TOKEN', status: 'warn',
      detail: production ? '未配置：生产环境 /api/metrics 一律 403' : '未配置：非生产环境放行（仅限本地调试）',
      remediation: '配置 METRICS_TOKEN 供 Prometheus 抓取',
    });

  // 10) 统一身份认证（OIDC 双轨）
  if (!cfg.authOidcEnabled) {
    items.push({ name: 'SSO_OIDC', status: 'ok', detail: 'OIDC 关闭：仅本地账号登录（行为与改造前一致）' });
  } else {
    const notes = [
      `issuer=${cfg.authOidcIssuer}`,
      `client=${cfg.authOidcClientId}`,
      `group=${cfg.authOidcRequiredGroup || '(不限)'}`,
      `建档=${cfg.authOidcAutoProvision ? '自动' : '需管理员预建'}`,
    ];
    const risky = !cfg.authOidcClientSecret || !cfg.authOidcRedirectUri;
    if (!cfg.authOidcClientSecret) notes.push('client_secret 未配置');
    if (!cfg.authOidcRedirectUri) notes.push('redirect_uri 未固定');
    items.push({
      name: 'SSO_OIDC', status: risky ? 'warn' : 'ok', detail: notes.join('，'),
      remediation: risky ? '配置 AUTH_OIDC_CLIENT_SECRET 与 AUTH_OIDC_REDIRECT_URI（Keycloak 要求回调地址精确匹配，按请求 Host 推导仅适用于单机测试）' : undefined,
    });
    if (!cfg.authLocalLoginEnabled) {
      items.push({
        name: 'LOCAL_LOGIN', status: 'warn', detail: '本地账号登录已关闭（单轨）',
        remediation: '确认 SSO 已可用再关闭本地入口；异常时改回 AUTH_LOCAL_LOGIN_ENABLED=true 并重启',
      });
    }
  }
  if (!cfg.authRegistrationEnabled) {
    items.push({ name: 'SELF_REGISTER', status: 'ok', detail: '自助注册关闭（D9：能力保留、默认不开放）' });
  }

  return items;
}

/** 逐条打印并把结果汇总成一行；存在 fail 项时返回 false 供调用方决定是否中止 */
export function logStartupChecks(items: CheckItem[], log: Logger): boolean {
  const icon: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  for (const it of items) {
    const line = `[${icon[it.status]}] ${it.name}: ${it.detail}${it.remediation ? ` | 修复: ${it.remediation}` : ''}`;
    if (it.status === 'fail') log.error(line);
    else if (it.status === 'warn') log.warn(line);
    else log.log(line);
  }
  const counts = {
    ok: items.filter((i) => i.status === 'ok').length,
    warn: items.filter((i) => i.status === 'warn').length,
    fail: items.filter((i) => i.status === 'fail').length,
  };
  const summary = `启动自检完成: ok=${counts.ok} warn=${counts.warn} fail=${counts.fail}`;
  if (counts.fail > 0) log.error(summary);
  else if (counts.warn > 0) log.warn(summary);
  else log.log(summary);
  return counts.fail === 0;
}
