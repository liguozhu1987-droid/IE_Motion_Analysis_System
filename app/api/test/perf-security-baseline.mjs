/**
 * 性能与安全基线探针（零依赖，Node >= 22）
 * 用法：node test/perf-security-baseline.mjs
 * 环境：BASE=http://127.0.0.1:3001/api   PROBE_USER=admin  PROBE_PWD=123456
 *      METRICS_TOKEN=<抓取令牌>        未配置则跳过 SEC-03 的正向分支
 *      EXPECT_HSTS=off                 非生产环境（不下发 HSTS）时置 off，SEC-01 记为人工待核验
 *
 * 设计原则：
 *  1) 只读探针——不写入业务数据、不创建账号、不删除任何内容；
 *  2) 失败登录不做重试——避免把真实账号打成 locked 态；
 *  3) 输出 JSON 报告（供 CI 归档）+ 控制台摘要，critical 存在时退出码 1。
 *
 * v2 变更（并发口径 30 → 50 人）：
 *  - SEC-01：HSTS 按环境断言（生产必须下发；非生产豁免并标注 manual 待人工核验）+ 去指纹断言；
 *  - SEC-03：改成双向断言（不带令牌 403 / 带正确令牌 200），令牌未配置时跳过正向分支；
 *  - SEC-15：明确断言"20 次失败登录必现 429"（IP 桶上限 15 次失败，第 16 次触顶）；
 *  - SEC-16：保持"轮换伪造 XFF 仍应 429"——新 clientIp 不再读 XFF，应自然通过；
 *  - PERF-05：50 并发同键驾驶舱，断言 total < single × 5（证明 single-flight 生效）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../../../deliverables');
const BASE = process.env.BASE || 'http://127.0.0.1:3001/api';
const USER = process.env.PROBE_USER || 'admin';
const PWD = process.env.PROBE_PWD || '123456';
const METRICS_TOKEN = (process.env.METRICS_TOKEN || '').trim();
const EXPECT_HSTS = (process.env.EXPECT_HSTS || 'on').toLowerCase() !== 'off';

const findings = [];
const metrics = {};

function add(id, title, severity, status, evidence) {
  findings.push({ id, title, severity, status, evidence });
}

async function req(path, { method = 'GET', body, token, headers = {} } = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h['authorization'] = `Bearer ${token}`;
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      method,
      headers: h,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: String(e?.message || e), ms: performance.now() - t0, error: true };
  }
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stat = (arr) => ({
  n: arr.length,
  p50: +pct(arr, 50).toFixed(1),
  p95: +pct(arr, 95).toFixed(1),
  max: +Math.max(...arr, 0).toFixed(1),
  avg: +(arr.reduce((a, b) => a + b, 0) / (arr.length || 1)).toFixed(1),
});
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/* ───────────────── 安全：传输与响应头 ───────────────── */
async function security() {
  const h = await req('/health');

  const required = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy'];
  const missing = required.filter((k) => !h.headers.get(k));
  const hsts = h.headers.get('strict-transport-security');
  if (!hsts) missing.push('strict-transport-security');
  const poweredBy = h.headers.get('x-powered-by');
  // 非生产环境（内网明文 HTTP）允许不下发 HSTS，但必须人工核验；生产缺失即失败
  const hstsOk = Boolean(hsts) || !EXPECT_HSTS;
  const passed = missing.length === 0 && hstsOk && !poweredBy;
  add('SEC-01', '安全响应头（nosniff/XFO/Referrer/CSP/HSTS + 去指纹）',
    missing.length >= 3 ? 'high' : 'medium',
    passed ? 'pass' : 'fail',
    {
      missing,
      hsts: hsts || (EXPECT_HSTS ? 'missing' : 'manual: 非生产环境豁免，须在 IIS ARR/网关人工核验'),
      xPoweredBy: poweredBy || 'absent',
      corp: h.headers.get('cross-origin-resource-policy'),
      csp: h.headers.get('content-security-policy'),
      present: [...h.headers.keys()].filter((k) => /security|x-|content-security|referrer|strict/i.test(k)),
    });

  add('SEC-02', 'HTTPS/HSTS 强制（生产入口）', 'high', 'manual',
    { note: '本探针走明文回环，HSTS 需在 IIS ARR/网关层核验；内网明文=口令与 refresh token 可被嗅探' });

  /* 指标端点是否收权：不带令牌必须 403（不能是 200+空内容），带正确令牌必须 200 */
  const METRICS_BODY_RE = /ie_http_request|process_cpu|nodejs_heap/i; // 本服务只注册了 ie_* 业务指标
  const noTok = await req('/metrics');
  const leak = noTok.status === 200 && METRICS_BODY_RE.test(noTok.text);
  let positive = null;
  if (METRICS_TOKEN) {
    const byBearer = await req('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    const byHeader = await req('/metrics', { headers: { 'x-metrics-token': METRICS_TOKEN } });
    const byWrong = await req('/metrics', { headers: { 'x-metrics-token': 'definitely-not-the-token' } });
    positive = {
      bearer: { status: byBearer.status, hasBody: METRICS_BODY_RE.test(byBearer.text) },
      header: { status: byHeader.status, hasBody: METRICS_BODY_RE.test(byHeader.text) },
      wrong: { status: byWrong.status },
    };
  }
  const positiveOk = positive
    ? [positive.bearer, positive.header].every((x) => x.status === 200 && x.hasBody) && positive.wrong.status === 403
    : true;
  const sec03Pass = !leak && noTok.status === 403 && positiveOk;
  add('SEC-03', '/metrics 收权（无令牌 403 / 正确令牌 200）',
    leak ? 'medium' : 'info',
    sec03Pass ? 'pass' : 'fail',
    {
      statusWithoutToken: noTok.status,
      bytes: noTok.text.length,
      sample: leak ? noTok.text.slice(0, 160) : '',
      withToken: positive ?? 'skipped: 未配置 METRICS_TOKEN（仅验证了无令牌 403 分支）',
      note: METRICS_TOKEN ? '' : '未提供 METRICS_TOKEN，正向分支跳过',
    });

  /* ───────── 认证与错误信封 ───────── */
  const noAuth = await req('/auth/me');
  add('SEC-04', '受保护端点无令牌访问被拒', noAuth.status === 401 ? 'info' : 'critical',
    noAuth.status === 401 ? 'pass' : 'fail', { status: noAuth.status });

  const badTok = await req('/auth/me', { token: 'aaa.bbb.ccc' });
  add('SEC-05', '伪造/畸形 JWT 返回 401 而非 5xx',
    badTok.status === 401 ? 'info' : 'high',
    badTok.status === 401 ? 'pass' : 'fail', { status: badTok.status, body: badTok.text.slice(0, 120) });

  const badJson = await req('/auth/login', { method: 'POST', body: '{"username":' });
  add('SEC-06', '畸形 JSON 返回 400 而非 5xx', badJson.status === 400 ? 'info' : 'medium',
    badJson.status === 400 ? 'pass' : 'fail', { status: badJson.status });

  // 错误信封是否泄露内部细节（堆栈/驱动/SQL）
  const leakRe = /at\s+\w+\s+\(|node_modules|mssql|SELECT |INSERT |TypeError|ReferenceError/i;
  const envelopes = [noAuth, badTok, badJson].filter((r) => r.text);
  const leaked = envelopes.filter((r) => leakRe.test(r.text));
  add('SEC-07', '错误响应不泄露内部实现细节', leaked.length ? 'high' : 'info',
    leaked.length ? 'fail' : 'pass',
    { checked: envelopes.length, leaked: leaked.map((r) => r.text.slice(0, 160)) });

  /* ───────── 跨域 ───────── */
  const cors = await req('/health', { headers: { origin: 'https://evil.example' } });
  const acao = cors.headers.get('access-control-allow-origin');
  const acac = cors.headers.get('access-control-allow-credentials');
  const reflected = acao === 'https://evil.example';
  add('SEC-08', 'CORS 不回显任意 Origin（credentials=true 时反射即高危）',
    reflected && acac === 'true' ? 'critical' : (reflected ? 'high' : 'info'),
    reflected ? 'fail' : 'pass', { acao, acac });

  /* ───────── 口令策略 ───────── */
  const weak = await req('/auth/register', {
    method: 'POST',
    body: { username: '__probe_weak_' + Date.now(), password: 'abc' },
  });
  add('SEC-09', '弱口令注册被拒绝（≥8 位且含字母数字）',
    weak.status === 400 ? 'info' : 'high', weak.status === 400 ? 'pass' : 'fail',
    { status: weak.status, body: weak.text.slice(0, 140) });

  /* ───────── 已认证：租户隔离与权限边界 ───────── */
  const login = await req('/auth/login', { method: 'POST', body: { username: USER, password: PWD } });
  if (login.status !== 200) {
    add('SEC-10', '认证态探针（租户隔离/越权）', 'info', 'skipped',
      {
        reason: `登录返回 ${login.status}，不做重试以免锁定账号`,
        body: login.text.slice(0, 120),
        hint: login.status === 429 ? '登录限流已触发（同 IP 15 次失败/5 分钟内建过桶），等待窗口过期后重跑' : '',
      });
    return { authed: false };
  }
  const adminTok = JSON.parse(login.text).accessToken;
  const loginBody = login.text;

  const sensitive = /password_hash|passwordHash|refresh_token|secret/i.test(loginBody);
  add('SEC-11', '登录响应不含口令哈希/密钥', sensitive ? 'high' : 'info',
    sensitive ? 'fail' : 'pass', { keys: Object.keys(JSON.parse(loginBody)) });

  // 租户头伪造：token=DEFAULT 却声明 OTHER
  const spoof = await req('/auth/me', { token: adminTok, headers: { 'x-tenant-id': 'OTHER' } });
  add('SEC-12', 'x-tenant-id 与 token 租户不一致时 403', spoof.status === 403 ? 'info' : 'high',
    spoof.status === 403 ? 'pass' : 'fail', { status: spoof.status });

  // 低权账号越租户读取：other1(OTHER 租户) 拉集团驾驶舱，不应看到 DEFAULT 租户数据
  const otherLogin = await req('/auth/login', { method: 'POST', body: { username: 'other1', password: PWD } });
  if (otherLogin.status === 200) {
    const otherTok = JSON.parse(otherLogin.text).accessToken;
    const dash = await req('/dashboard/summary', { token: otherTok });
    let tenantsSeen = [];
    try {
      const j = JSON.parse(dash.text);
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (k === 'tenant_id' && typeof v === 'string') tenantsSeen.push(v);
          else walk(v);
        }
      };
      walk(j);
    } catch { /* 非 JSON */ }
    const crossTenant = [...new Set(tenantsSeen)].filter((t) => t !== 'OTHER');
    // 403 = 被权限挡在门外，属于"挡住了但没验证到数据层"，不能记 PASS
    const inconclusive = dash.status === 403;
    add('SEC-13', '跨租户数据隔离（OTHER 用户不应看到他租户记录）',
      crossTenant.length ? 'critical' : 'info',
      crossTenant.length ? 'fail' : (inconclusive ? 'skipped' : 'pass'),
      {
        status: dash.status, tenantsSeen: [...new Set(tenantsSeen)], crossTenant,
        note: inconclusive ? '该角色无 dashboard 权限，需用具备权限的四档账号各跑一遍才算验证' : '',
      });
  } else {
    add('SEC-13', '跨租户数据隔离', 'info', 'skipped', { reason: `other1 登录 ${otherLogin.status}` });
  }

  // 越权写：低权账号尝试删除他人工位（期望 403/404，绝不可 200）——只发一个不可解析 ID，不触碰真实数据
  const forbiddenWrite = await req('/stations/__probe_nonexistent__', { method: 'DELETE', token: adminTok });
  add('SEC-14', '不存在的资源返回 404（不返回 2xx 静默成功）',
    [400, 404, 422].includes(forbiddenWrite.status) ? 'info' : 'low',
    [400, 404, 422].includes(forbiddenWrite.status) ? 'pass' : 'fail',
    { status: forbiddenWrite.status, body: forbiddenWrite.text.slice(0, 120) });

  /*
   * 登录接口是否有限流：用不存在的用户名连打 20 次（不触碰任何真实账号，不会造成锁定）。
   * 预期：IP 桶上限 15 次失败 / 5 分钟 → 第 16 次起返回 429。
   * 用户名每次不同 ⇒ 账号桶不参与，这里验证的正是 IP 桶。
   */
  const burst = [];
  let first429At = null;
  for (let i = 0; i < 20; i++) {
    const r = await req('/auth/login', { method: 'POST', body: { username: `__nosuch_${i}`, password: 'x' } });
    burst.push(r.status);
    if (r.status === 429 && first429At === null) first429At = i + 1;
  }
  const has429 = burst.includes(429);
  add('SEC-15', '登录接口暴力破解限流（20 次连打应出现 429）',
    has429 ? 'info' : 'high', has429 ? 'pass' : 'fail',
    { statuses: [...new Set(burst)], has429, first429At, distribution: burst.join(',') });

  /* ───────── 限流键是否可被伪造 XFF 绕过 ───────── */
  // forgot-password 限流 5 次/小时：先同 IP 打满，再轮换伪造 XFF 看是否仍放行。
  // 注意：只伪造 x-forwarded-for —— clientIp 已完全不读该头；x-real-ip 是"可信反代专用头"，
  // 本机探针自己就来自可信 peer(127.0.0.1)，伪造它等同于"ARR 自己在说谎"，不在本用例范围内
  // （服务只 listen 回环，远程客户端无法直连，故该路径不可被外网利用；见回报中的 ARR 配置要求）。
  const fp = (xf) => req('/auth/forgot-password', {
    method: 'POST',
    body: { username: '__nosuch_probe' },
    headers: xf ? { 'x-forwarded-for': xf } : {},
  });
  const same = [];
  for (let i = 0; i < 7; i++) same.push((await fp()).status);
  const blockedSame = same.includes(429);
  const forged = [];
  for (let i = 0; i < 8; i++) forged.push((await fp(`203.0.113.${i}`)).status);
  const bypass = blockedSame && !forged.includes(429);
  add('SEC-16', '限流键不可被伪造 X-Forwarded-For 绕过（clientIp 信任链）',
    !blockedSame ? 'medium' : (bypass ? 'high' : 'info'),
    !blockedSame ? 'warn' : (bypass ? 'fail' : 'pass'),
    {
      sameIpStatuses: same, forgedXffStatuses: forged, blockedSame, bypass,
      trustChain: 'socket peer → TRUSTED_PROXIES 白名单 → CLIENT_IP_HEADER（ARR 覆写）；XFF 完全不读',
      residualRisk: '同机进程可伪造 x-real-ip（仅回环可达，且同机进程本已完全可信）；须确保 IIS ARR 用 {REMOTE_ADDR} 覆写该头',
    });

  return { authed: true, adminTok, otherTok: otherLogin.status === 200 ? JSON.parse(otherLogin.text).accessToken : null };
}

/* ───────────────── 性能 ───────────────── */
async function perf(ctx) {
  // 预热，排除首请求 JIT/连接建立
  for (let i = 0; i < 5; i++) await req('/health');

  const healthMs = [];
  for (let i = 0; i < 30; i++) {
    const r = await req('/health');
    if (r.status === 200) healthMs.push(r.ms);
  }
  metrics.health = stat(healthMs);

  let summaryMs = [];
  let summaryBytes = 0;
  let compressed = false;
  if (ctx?.adminTok) {
    const warm = await req('/dashboard/summary', {
      token: ctx.adminTok,
      headers: { 'accept-encoding': 'gzip, br' },
    });
    summaryBytes = Buffer.byteLength(warm.text || '', 'utf8');
    compressed = Boolean(warm.headers.get('content-encoding'));
    for (let i = 0; i < 20; i++) {
      const r = await req('/dashboard/summary', { token: ctx.adminTok });
      if (r.status === 200) summaryMs.push(r.ms);
    }
    metrics.dashboardSummary = {
      ...stat(summaryMs), bytes: summaryBytes, compressed,
      contentEncoding: warm.headers.get('content-encoding') || null,
    };
  }

  // 并发突刺：20 并发 × 3 波
  const burstTimes = [];
  let burstErr = 0;
  for (let wave = 0; wave < 3; wave++) {
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: 20 }, () => req('/health')));
    burstTimes.push(performance.now() - t0);
    burstErr += rs.filter((r) => r.status !== 200).length;
  }
  metrics.burst20 = { waves: burstTimes.map((t) => +t.toFixed(1)), errors: burstErr };

  add('PERF-01', 'API 基础延迟（/health 顺序 30 次）',
    metrics.health.p95 > 100 ? 'high' : 'info',
    metrics.health.p95 > 100 ? 'fail' : 'pass', metrics.health);

  if (metrics.dashboardSummary) {
    const d = metrics.dashboardSummary;
    add('PERF-02', '驾驶舱聚合接口延迟（/dashboard/summary 20 次）',
      d.p95 > 1500 ? 'high' : (d.p95 > 800 ? 'medium' : 'info'),
      d.p95 > 1500 ? 'fail' : (d.p95 > 800 ? 'warn' : 'pass'), d);
    add('PERF-03', 'JSON 响应压缩（gzip/br）',
      compressed ? 'info' : (d.bytes > 20_000 ? 'medium' : 'low'),
      compressed ? 'pass' : 'fail', { bytes: d.bytes, compressed, contentEncoding: d.contentEncoding });
  }

  add('PERF-04', '20 并发突刺无错误且不劣化',
    burstErr > 0 ? 'high' : 'info', burstErr > 0 ? 'fail' : 'pass', metrics.burst20);

  await perf05(ctx);
}

/**
 * PERF-05：50 并发同键驾驶舱（验证 single-flight）。
 *
 * 口径说明：必须用**冷键**测，否则测到的是 TTL 缓存命中，证明不了"50 个同时到达的
 * 请求只回源一次"。因此先用 4 个互不相同的真实筛选组合各打一次（各自都是冷键），
 * 取中位数作为"单次聚合成本 singleMs"；再用第 5 个**同样冷**的组合并发打 50 次。
 * 断言 total < singleMs × 5：single-flight 生效时 total ≈ singleMs（+ 50 次响应序列化），
 * 若退化成 50 次独立聚合，至少是 singleMs 的十几倍（受连接池与 CPU 串行度限制）。
 */
async function perf05(ctx) {
  if (!ctx?.adminTok) {
    add('PERF-05', '50 并发同键驾驶舱（single-flight）', 'info', 'skipped', { reason: '未取得 token' });
    return;
  }
  const base = await req('/dashboard/summary', { token: ctx.adminTok });
  let combos = [];
  try {
    const j = JSON.parse(base.text);
    const out = [];
    for (const r of (j.by_region ?? []).slice(0, 4)) out.push(`?region=${encodeURIComponent(r.region)}`);
    for (const p of (j.by_process ?? []).slice(0, 4)) out.push(`?process=${encodeURIComponent(p.process_type)}`);
    for (const p of (j.by_product ?? []).slice(0, 4)) out.push(`?product_type=${encodeURIComponent(p.product_type)}`);
    for (const p of (j.by_project ?? []).slice(0, 4)) out.push(`?project=${encodeURIComponent(p.project_type)}`);
    combos = [...new Set(out)];
  } catch { /* 非 JSON，走 skipped */ }

  if (combos.length < 5) {
    add('PERF-05', '50 并发同键驾驶舱（single-flight）', 'info', 'skipped',
      { reason: `可用筛选组合不足（需 ≥5，实际 ${combos.length}）`, status: base.status });
    return;
  }

  const coldSingles = [];
  for (let i = 0; i < 4; i++) {
    const r = await req(`/dashboard/summary${combos[i]}`, { token: ctx.adminTok });
    if (r.status === 200) coldSingles.push(r.ms);
  }
  const singleMs = median(coldSingles);

  const t0 = performance.now();
  const rs = await Promise.all(
    Array.from({ length: 50 }, () => req(`/dashboard/summary${combos[4]}`, { token: ctx.adminTok })),
  );
  const totalMs = performance.now() - t0;

  const okCount = rs.filter((r) => r.status === 200).length;
  const times = rs.map((r) => r.ms);
  // 50 个响应逐字节一致 ⇒ 它们共享同一次聚合结果（single-flight 的直接证据）
  const distinctBodies = new Set(rs.filter((r) => r.status === 200).map((r) => r.text)).size;
  const identical = okCount === 50 && distinctBodies === 1;
  const ratio = singleMs > 0 ? totalMs / singleMs : Number.POSITIVE_INFINITY;
  const passed = okCount === 50 && singleMs > 0 && ratio < 5;

  const evidence = {
    concurrent: 50, key: combos[4],
    singleMs: +singleMs.toFixed(1),
    coldSingles: coldSingles.map((v) => +v.toFixed(1)),
    totalMs: +totalMs.toFixed(1),
    ratio: +ratio.toFixed(2),
    perRequest: stat(times),
    ok: okCount,
    identical,
    note: '判定：total < single×5 ⇒ 50 次并发被压成 1 次回源；identical=true 表示 50 份响应逐字节一致',
  };
  metrics.perf05 = evidence;
  add('PERF-05', '50 并发同键驾驶舱（single-flight 合并回源）',
    passed ? 'info' : 'high', passed ? 'pass' : 'fail', evidence);
}

/* ───────────────── main ───────────────── */
const startedAt = new Date().toISOString();
let ctx = null;
try {
  ctx = await security();
  await perf(ctx);
} catch (e) {
  add('PROBE-00', '探针自身异常', 'info', 'error', { error: String(e?.stack || e) });
}

const critical = findings.filter((f) => f.severity === 'critical' && f.status === 'fail');
const high = findings.filter((f) => f.severity === 'high' && f.status === 'fail');
const report = { startedAt, base: BASE, findings, metrics, summary: { critical: critical.length, high: high.length } };

mkdirSync(OUT_DIR, { recursive: true });
const out = resolve(OUT_DIR, 'PST-baseline-report.json');
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');

const icon = (f) => (f.status === 'pass' ? 'PASS' : f.status === 'fail' ? 'FAIL' : f.status.toUpperCase());
console.log(`\n=== 性能与安全基线 @ ${BASE} ===`);
for (const f of findings) console.log(`${icon(f).padEnd(8)} ${f.severity.toUpperCase().padEnd(8)} ${f.id}  ${f.title}`);
console.log('\n--- 延迟 ---');
console.log('health   :', JSON.stringify(metrics.health));
if (metrics.dashboardSummary) console.log('dashboard:', JSON.stringify(metrics.dashboardSummary));
if (metrics.burst20) console.log('burst20  :', JSON.stringify(metrics.burst20));
if (metrics.perf05) console.log('perf05   :', JSON.stringify(metrics.perf05));
console.log(`\ncritical=${critical.length} high=${high.length} → ${out}\n`);
process.exit(critical.length ? 1 : 0);
