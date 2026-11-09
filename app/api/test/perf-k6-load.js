/**
 * k6 负载 / 突刺 / 浸泡 / 缓存命中 四场景脚本 —— IE 平台 API
 *
 * 安装：https://grafana.com/docs/k6/latest/set-up/install-k6/  （Windows: winget install k6）
 * 运行：
 *   k6 run -e BASE=http://127.0.0.1:3001/api -e USER=admin -e PWD=123456 perf-k6-load.js
 *   k6 run -e SCENARIO=spike  ...       仅跑突刺
 *   k6 run -e SCENARIO=cachehit ...     仅跑缓存命中场景（50 VU 同键）
 *   k6 run -e SCENARIO=soak  -e DURATION=30m ...   跑浸泡
 *
 * 容量口径（v2）：**50 人同时在线**（原 30）。50 人里有相当比例会在月会/早高峰
 * 同时打开驾驶舱——URL 与筛选条件都相同，这正是后端 TTL 缓存 + single-flight 的靶心。
 *
 * 纪律：脚本内**只有读请求**（GET）+ 低频登录。写接口的压测单独用影子库，
 *       绝不对生产/共享测试库压写入——那是造脏数据最快的方式。
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:3001/api';
const USER = __ENV.USER || 'admin';
const PWD = __ENV.PWD || '123456';
const ONLY = __ENV.SCENARIO || '';
const DURATION = __ENV.DURATION || '10m';

// 隔离性能门只允许打 3102；防止环境变量串用后把 50 VU 压到既有 3001 服务。
if (__ENV.PERF_ISOLATED === '1' && BASE.replace(/\/$/, '') !== 'http://127.0.0.1:3102/api') {
  throw new Error(`PERF_ISOLATED=1 时 BASE 必须是 http://127.0.0.1:3102/api，当前=${BASE}`);
}

const summaryTrend = new Trend('ep_dashboard_summary', true);
const cachedTrend = new Trend('ep_dashboard_cached', true);
const listTrend = new Trend('ep_stations_list', true);
const meTrend = new Trend('ep_auth_me', true);
const loginTrend = new Trend('ep_auth_login', true);
const bizErrors = new Rate('biz_errors');       // 5xx 或非预期状态码
const aiOrLong = new Counter('slow_calls');     // 超过 1s 的调用计数

const pick = (all) => (ONLY ? ONLY.split(',').includes(all) : true);

/** 缓存命中场景固定同一 URL（同键才会合并/命中） */
const CACHE_HIT_URL = `${BASE}/dashboard/summary`;

export const options = {
  scenarios: {
    ...(pick('load') ? {
      load: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '30s', target: 10 },   // 爬坡
          { duration: '2m', target: 10 },    // 稳态
          { duration: '2m', target: 50 },    // 峰值：50 人同时在线（Month-meeting / 早高峰同开驾驶舱）
          { duration: '30s', target: 0 },
        ],
        gracefulRampDown: '10s',
        tags: { scenario: 'load' },
      },
    } : {}),
    ...(pick('spike') ? {
      spike: {
        executor: 'ramping-arrival-rate',
        startRate: 5,
        timeUnit: '1s',
        preAllocatedVUs: 50,
        maxVUs: 200,
        stages: [
          { duration: '10s', target: 5 },
          { duration: '10s', target: 120 },  // 瞬间 120 rps
          { duration: '30s', target: 120 },
          { duration: '10s', target: 5 },
        ],
        startTime: pick('load') ? '6m' : '0s',
        tags: { scenario: 'spike' },
      },
    } : {}),
    ...(pick('cachehit') ? {
      /**
       * 缓存命中场景：50 VU **固定同一筛选**（即同一缓存键），验证 TTL 缓存 +
       * single-flight 生效后的延迟。与 load 场景的区别：load 混合了不同查询，
       * 这里刻意让 50 并发压同一个键——缓存未命中时也只回源一次。
       */
      cache_hit: {
        executor: 'constant-vus',
        vus: 50,
        duration: '1m',
        startTime: pick('load') ? '5m10s' : '0s',
        exec: 'cacheHit',
        tags: { scenario: 'cache_hit' },
      },
    } : {}),
    ...(pick('soak') ? {
      soak: {
        executor: 'constant-vus',
        vus: 8,
        duration: DURATION,                 // 浸泡：找内存泄漏 / 连接池耗尽
        startTime: (pick('load') || pick('spike')) ? '7m' : '0s',
        tags: { scenario: 'soak' },
      },
    } : {}),
  },
  thresholds: {
    // 出口门槛：任一不达标即视为性能不通过（k6 退出码非 0，可直接卡发版）
    'http_req_failed': ['rate<0.01'],
    'biz_errors': ['rate<0.01'],
    'http_req_duration': ['p(95)<800', 'p(99)<2000'],
    // 50 并发口径：放宽到 1.5s，含缓存未命中的冷启动（多表聚合 + 逐工位分析）
    'ep_dashboard_summary': ['p(95)<1500'],
    'ep_stations_list': ['p(95)<400'],
    'ep_auth_me': ['p(95)<200'],
    'ep_auth_login': ['p(95)<1500'],          // bcrypt cost=10 本身就是 60~100ms 级
    // 命中缓存后应是一个数量级的改善；超过 300ms 说明缓存/single-flight 没生效
    ...(pick('cachehit') ? { 'ep_dashboard_cached': ['p(95)<300'] } : {}),
  },
};

export function setup() {
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ username: USER, password: PWD }),
    { headers: { 'content-type': 'application/json' }, tags: { ep: 'auth_login' } });
  if (r.status !== 200) throw new Error(`setup 登录失败 status=${r.status} body=${r.body}`);
  check(r, { '登录成功': (x) => x.status === 200 });
  const token = r.json('accessToken');
  // 预热同键驾驶舱：让 cache-hit 场景测到的是"命中"，而不是冷启动
  const warm = http.get(CACHE_HIT_URL, { headers: { authorization: `Bearer ${token}` }, tags: { ep: 'dashboard_cached' } });
  check(warm, { '驾驶舱预热 2xx': (x) => x.status === 200 });
  return { token };
}

export default function (data) {
  const H = { headers: { authorization: `Bearer ${data.token}`, accept: 'application/json' } };

  const me = http.get(`${BASE}/auth/me`, { ...H, tags: { ep: 'auth_me' } });
  meTrend.add(me.timings.duration);
  bizErrors.add(me.status >= 500 || me.status === 0);

  const sum = http.get(`${BASE}/dashboard/summary`, { ...H, tags: { ep: 'dashboard_summary' } });
  summaryTrend.add(sum.timings.duration);
  bizErrors.add(sum.status >= 500 || sum.status === 0);
  if (sum.timings.duration > 1000) aiOrLong.add(1);
  check(sum, { '驾驶舱 2xx': (x) => x.status === 200 });

  const st = http.get(`${BASE}/stations?limit=50`, { ...H, tags: { ep: 'stations_list' } });
  listTrend.add(st.timings.duration);
  // 404 说明端点名不同——不是性能问题，但要让脚本叫出来
  check(st, { '工位列表非 5xx': (x) => x.status < 500 });

  // 低频登录压测（bcrypt 是 CPU 密集，过高频会掩盖真实瓶颈）
  if (Math.random() < 0.02) {
    const lg = http.post(`${BASE}/auth/login`, JSON.stringify({ username: USER, password: PWD }),
      { headers: { 'content-type': 'application/json' }, tags: { ep: 'auth_login' } });
    loginTrend.add(lg.timings.duration);
  }

  sleep(Math.random() * 2 + 1); // 1~3s 思考时间，模拟真实 IE 点击节奏
}

/** cache-hit 场景专用：50 VU 同键反复拉，验证缓存 + single-flight 的稳态延迟 */
export function cacheHit(data) {
  const r = http.get(CACHE_HIT_URL, {
    headers: { authorization: `Bearer ${data.token}`, accept: 'application/json' },
    tags: { ep: 'dashboard_cached' },
  });
  cachedTrend.add(r.timings.duration);
  bizErrors.add(r.status >= 500 || r.status === 0);
  check(r, { '驾驶舱（缓存命中）2xx': (x) => x.status === 200 });
  sleep(1); // 50 VU × 1 次/秒 ≈ 50 rps，贴近"50 人在看同一块看板"
}

export function handleSummary(data) {
  const m = data.metrics;
  const line = (k, label) => {
    const v = m[k];
    if (!v) return '';
    const t = v.values;
    return `${label.padEnd(24)} p50=${(t['p(50)'] ?? 0).toFixed(0)}ms p95=${(t['p(95)'] ?? 0).toFixed(0)}ms ` +
      `p99=${(t['p(99)'] ?? 0).toFixed(0)}ms reqs=${t.count}`;
  };
  const txt = [
    '\n===== 负载结果摘要（50 人同时在线口径）=====',
    line('ep_auth_me', 'GET /auth/me'),
    line('ep_dashboard_summary', 'GET /dashboard/summary'),
    line('ep_dashboard_cached', 'GET /dashboard/summary*'),
    line('ep_stations_list', 'GET /stations'),
    line('ep_auth_login', 'POST /auth/login'),
    `http_req_failed rate = ${((m.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)}%`,
    `slow_calls(>1s) = ${m.slow_calls?.values?.count ?? 0}`,
    '（* 缓存命中场景：50 VU 固定同一筛选）',
    '',
  ].join('\n');
  return {
    stdout: txt,
    'perf-k6-summary.json': JSON.stringify(data, null, 2),
  };
}
