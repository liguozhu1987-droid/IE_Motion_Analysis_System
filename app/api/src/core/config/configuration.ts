/**
 * 全局配置：集中读取环境变量并 fail-fast（延续 MVP config.js 纪律）。
 * DB_TYPE=mssql 生产；DB_TYPE=sqlite 开发/演示（同一套 Entity）。
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** 监听地址：默认仅回环（对外由 IIS ARR 反代的安全形态）；
   *  单文件部署版无反代直曝，需在 .env 显式 HOST=0.0.0.0 */
  host: string;
  dbType: 'mssql' | 'sqlite';
  // mssql
  dbHost: string; dbPort: number; dbName: string; dbUser: string; dbPass: string;
  dbEncrypt: boolean; dbPoolMax: number;
  // sqlite
  dbPath: string;
  // jwt
  jwtAccessSecret: string; jwtAccessTtl: string;
  jwtRefreshSecret: string; jwtRefreshTtl: string;
  loginMaxFail: number; loginLockMin: number;
  // 安全 / 反向代理（客户端 IP 信任链、安全响应头、指标抓取令牌）
  clientIpHeader: string;
  trustedProxies: string[];
  secHsts: boolean;
  metricsToken: string;
  // 登录失败双桶限流（只计失败，成功清零）
  loginIpMaxFail: number; loginIpWindowMin: number;
  loginUserMaxFail: number; loginUserWindowMin: number;
  // 驾驶舱聚合缓存（0 = 关闭）
  dashboardCacheTtlMs: number;
  // ai
  aiEnabled: boolean; aiBaseUrl: string; aiKey: string; aiModel: string;
  aiMonthlyTokenLimit: number; aiTimeoutMs: number;
  // ai-suggest（AI 改善建议模块；AI_ENABLED=false 时本组配置不生效）
  aiSuggestEnabled: boolean;
  aiLlmBaseUrl: string; aiLlmApiKey: string; aiLlmModel: string;
  aiBatchCeiling: number;
  aiQuotaScope: 'station' | 'station+version';
  // 告警监控（盘点第 3 类：登录锁定激增 / ai_task 堆积 / HTTP 错误率 → 日志 + 可选 SMTP 邮件。
  // 日志告警默认开启零成本；SMTP 未配 = 只落日志不发信）
  alertCheckSec: number;
  alertLoginLockedMax: number;
  alertAiTaskBacklog: number;
  alertErrorRatePct: number;
  alertErrorMinRequests: number;
  alertCooldownMin: number;
  // 业务告警（P0-4）：阈值一律「不猜」——未配置 = 规则关闭，启动期显式 warn，不暗设默认
  alertDeriveFailPct: number | null;
  alertAiFailPct: number | null;
  alertFailWindowMin: number | null;
  alertFailMinSample: number | null;
  // SMTP（可选：SMTP_HOST + ALERT_MAIL_TO 都非空才启用发信）
  smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string;
  smtpFrom: string; alertMailTo: string;
  // 统一身份认证（OIDC 双轨开关；关闭时行为与改造前完全一致）
  authOidcEnabled: boolean;
  authLocalLoginEnabled: boolean;
  authRegistrationEnabled: boolean;
  authOidcIssuer: string;
  authOidcClientId: string;
  authOidcClientSecret: string;
  authOidcRedirectUri: string;
  authOidcRequiredGroup: string;
  authOidcAutoProvision: boolean;
  authOidcSystemCode: string;
  authOidcDefaultRole: string;
  authOidcFrontendCallback: string;
  authOidcTimeoutMs: number;
  // 其他
  logLevel: string; logDir: string; rulesDir: string; seed: boolean;
}

function req(name: string, v: string | undefined): string {
  if (v === undefined || v === '') throw new Error(`缺少必需环境变量 ${name}`);
  return v;
}

/** 可选百分比阈值：空串/非数字/<=0/>100 一律视为「未配置」（null），由规则自行显式告警 */
function optionalPct(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** 可选正整数：空串/非数字/<=0 一律视为「未配置」（null） */
function optionalPositiveInt(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbType = (env.DB_TYPE ?? 'sqlite') as 'mssql' | 'sqlite';
  const cfg: AppConfig = {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? '127.0.0.1',
    dbType,
    dbHost: env.DB_HOST ?? '127.0.0.1',
    dbPort: Number(env.DB_PORT ?? 1433),
    dbName: env.DB_NAME ?? 'IEPlatform',
    dbUser: env.DB_USER ?? 'ie_app',
    dbPass: env.DB_PASS ?? '',
    dbEncrypt: (env.DB_ENCRYPT ?? 'true') === 'true',
    // 50 人同时在线口径（原 20）：稳态并发查询约 10~15，30 留一倍余量；
    // SQL Server 默认 max worker/连接上限 100，30 远不会撞顶，也不会把连接数吃满
    dbPoolMax: Number(env.DB_POOL_MAX ?? 30),
    dbPath: env.DB_PATH ?? './data/ie.db',
    jwtAccessSecret: env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
    jwtRefreshSecret: env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '15m',
    jwtRefreshTtl: env.JWT_REFRESH_TTL ?? '7d',
    loginMaxFail: Number(env.LOGIN_MAX_FAIL ?? 5),
    loginLockMin: Number(env.LOGIN_LOCK_MIN ?? 15),
    // 客户端 IP 信任链：ARR 与 API 同机，真实流量的 socket peer 恒为 127.0.0.1，
    // 所以只能用"由 ARR 覆写的专用头"承载客户端 IP，而非可被同机进程伪造的 XFF。
    clientIpHeader: (env.CLIENT_IP_HEADER ?? 'x-real-ip').trim().toLowerCase() || 'x-real-ip',
    trustedProxies: (env.TRUSTED_PROXIES ?? '127.0.0.1,::1,::ffff:127.0.0.1')
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    // HSTS 仅在生产或显式开启时下发：内网当前仍有明文 HTTP 入口，
    // 对纯 HTTP 站点下发 HSTS 会把用户浏览器钉在 https 上导致整站打不开
    secHsts: ['on', 'true', '1'].includes((env.SEC_HSTS ?? '').trim().toLowerCase()),
    metricsToken: (env.METRICS_TOKEN ?? '').trim(),
    loginIpMaxFail: Number(env.LOGIN_IP_MAX_FAIL ?? 15),
    loginIpWindowMin: Number(env.LOGIN_IP_WINDOW_MIN ?? 5),
    loginUserMaxFail: Number(env.LOGIN_USER_MAX_FAIL ?? 10),
    loginUserWindowMin: Number(env.LOGIN_USER_WINDOW_MIN ?? 15),
    dashboardCacheTtlMs: Number(env.DASHBOARD_CACHE_TTL_MS ?? 30_000),
    aiEnabled: (env.AI_ENABLED ?? 'false') === 'true',
    aiBaseUrl: env.AI_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    aiKey: env.AI_KEY ?? 'na',
    aiModel: env.AI_MODEL ?? 'qwen2.5-14b',
    aiMonthlyTokenLimit: Number(env.AI_MONTHLY_TOKEN_LIMIT ?? 200000),
    aiTimeoutMs: Number(env.AI_TIMEOUT_MS ?? 30000),
    // ai-suggest：默认关闭（开关开启也不依赖既有 ai 模块配置；LLM 端点独立可配）
    aiSuggestEnabled: (env.AI_SUGGEST_ENABLED ?? 'false') === 'true',
    aiLlmBaseUrl: env.AI_LLM_BASE_URL ?? env.AI_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    aiLlmApiKey: env.AI_LLM_API_KEY ?? env.AI_KEY ?? 'na',
    aiLlmModel: env.AI_LLM_MODEL ?? env.AI_MODEL ?? 'qwen2.5-14b',
    aiBatchCeiling: Number(env.AI_BATCH_CEILING ?? 0.5),
    aiQuotaScope: (env.AI_QUOTA_SCOPE === 'station+version' ? 'station+version' : 'station') as 'station' | 'station+version',
    alertCheckSec: Math.max(10, Number(env.ALERT_CHECK_SEC ?? 60)),
    alertLoginLockedMax: Number(env.ALERT_LOGIN_LOCKED_MAX ?? 5),
    alertAiTaskBacklog: Number(env.ALERT_AI_TASK_BACKLOG ?? 50),
    alertErrorRatePct: Number(env.ALERT_ERROR_RATE_PCT ?? 1),
    alertErrorMinRequests: Number(env.ALERT_ERROR_MIN_REQUESTS ?? 20),
    alertCooldownMin: Math.max(1, Number(env.ALERT_COOLDOWN_MIN ?? 30)),
    // P0-4 业务告警：未配置时保持 null（规则关闭），绝不在这里塞默认阈值
    alertDeriveFailPct: optionalPct(env.ALERT_DERIVE_FAIL_PCT),
    alertAiFailPct: optionalPct(env.ALERT_AI_FAIL_PCT),
    alertFailWindowMin: optionalPositiveInt(env.ALERT_FAIL_WINDOW_MIN),
    alertFailMinSample: optionalPositiveInt(env.ALERT_FAIL_MIN_SAMPLE),
    smtpHost: (env.SMTP_HOST ?? '').trim(),
    smtpPort: Number(env.SMTP_PORT ?? 25),
    smtpUser: (env.SMTP_USER ?? '').trim(),
    smtpPass: env.SMTP_PASS ?? '',
    smtpFrom: (env.SMTP_FROM ?? '').trim(),
    alertMailTo: (env.ALERT_MAIL_TO ?? '').trim(),
    /*
     * 统一身份认证（OIDC）双轨开关，默认「OIDC 关 / 本地登录开」= 与改造前完全一致。
     * 交底书契约：OIDC 成功后仍签发本系统原有本地 JWT，下游鉴权零改动。
     * 自助注册默认关闭（D9：保留能力但默认不开放）；兼容既有隔离基座的
     * REGISTER_ENABLED 别名，避免已登记套件因默认值变化而退化。
     */
    authOidcEnabled: ['true', '1', 'on'].includes((env.AUTH_OIDC_ENABLED ?? '').trim().toLowerCase()),
    authLocalLoginEnabled: !['false', '0', 'off'].includes((env.AUTH_LOCAL_LOGIN_ENABLED ?? '').trim().toLowerCase()),
    authRegistrationEnabled: ['true', '1', 'on'].includes(
      (env.AUTH_REGISTRATION_ENABLED ?? env.REGISTER_ENABLED ?? 'false').trim().toLowerCase(),
    ),
    // issuer 去掉尾部斜杠：Keycloak 的 iss 声明不带尾斜杠，避免手工配置多一个 '/' 就验签失败
    authOidcIssuer: (env.AUTH_OIDC_ISSUER ?? '').trim().replace(/\/+$/, ''),
    authOidcClientId: (env.AUTH_OIDC_CLIENT_ID ?? 'ie-platform').trim(),
    authOidcClientSecret: env.AUTH_OIDC_CLIENT_SECRET ?? '',
    authOidcRedirectUri: (env.AUTH_OIDC_REDIRECT_URI ?? '').trim(),
    authOidcRequiredGroup: (env.AUTH_OIDC_REQUIRED_GROUP ?? 'app-ie').trim(),
    authOidcAutoProvision: !['false', '0', 'off'].includes((env.AUTH_OIDC_AUTO_PROVISION ?? '').trim().toLowerCase()),
    authOidcSystemCode: (env.AUTH_OIDC_SYSTEM_CODE ?? 'ie').trim(),
    authOidcDefaultRole: (env.AUTH_OIDC_DEFAULT_ROLE ?? 'viewer').trim(),
    // 前端回调页：hash 路由，默认 '#/oidc/callback'
    authOidcFrontendCallback: (env.AUTH_OIDC_FRONTEND_CALLBACK ?? '#/oidc/callback').trim(),
    authOidcTimeoutMs: Math.max(1000, Math.min(30_000, Number(env.AUTH_OIDC_TIMEOUT_MS ?? 5000))),
    logLevel: env.LOG_LEVEL ?? 'info',
    logDir: env.LOG_DIR ?? './logs',
    rulesDir: env.RULES_DIR ?? '../config/rules',
    seed: (env.SEED ?? 'true') === 'true',
  };
  if (cfg.nodeEnv === 'production' && (cfg.jwtAccessSecret.startsWith('dev-') || cfg.jwtRefreshSecret.startsWith('dev-'))) {
    throw new Error('生产环境必须配置 JWT_ACCESS_SECRET / JWT_REFRESH_SECRET');
  }
  /* 双轨开关的非法组合在启动期 fail：两个入口全关 = 谁都登不进来 */
  if (!cfg.authOidcEnabled && !cfg.authLocalLoginEnabled) {
    throw new Error('AUTH_OIDC_ENABLED 与 AUTH_LOCAL_LOGIN_ENABLED 不能同时关闭（会导致所有用户无法登录）');
  }
  if (cfg.authOidcEnabled && !cfg.authOidcIssuer) {
    throw new Error('AUTH_OIDC_ENABLED=true 时必须配置 AUTH_OIDC_ISSUER（Keycloak realm 地址）');
  }
  return cfg;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
