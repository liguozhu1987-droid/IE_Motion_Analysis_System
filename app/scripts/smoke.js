/**
 * 冒烟测试：对运行中的服务执行关键链路请求（只读为主 + 一次预期失败的提交校验）
 * 用法：先 npm start，再 npm run smoke
 */
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3001';

let passed = 0;
let failed = 0;

async function call(method, path, body, expect = 200) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload;
  try { payload = await res.json(); } catch { payload = null; }
  const ok = res.status === expect;
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`✗ ${method} ${path} 期望 ${expect}，实际 ${res.status}`, JSON.stringify(payload)?.slice(0, 300));
  }
  return { status: res.status, payload };
}

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.log(`✗ ${label}`, detail ?? ''); }
}

const health = await call('GET', '/api/health');
check('health 返回 ok', health.payload?.status === 'ok');

const ready = await call('GET', '/api/ready');
check('ready 数据库正常', ready.payload?.checks?.database === 'ok');

const rules = await call('GET', '/api/rules');
check('规则集加载', rules.payload?.va_types?.length === 10 && rules.payload?.waste_triggers?.length === 12);

const lines = await call('GET', '/api/lines');
check('产线列表存在 L01', lines.payload?.lines?.some((l) => l.line_id === 'L01'));

const stations = await call('GET', '/api/stations?line_id=L01');
check('6个工位', stations.payload?.stations?.length === 6, JSON.stringify(stations.payload)?.slice(0, 200));

const st03 = await call('GET', '/api/stations/L01-ST03');
check('ST03 当前版本 v2', st03.payload?.version === 2, st03.payload?.version);
check('ST03 要素4条(v2)', st03.payload?.elements?.length === 4);
check('ST03 封存版本列表2条', st03.payload?.versions?.length === 2);

const analysis = await call('GET', '/api/stations/L01-ST03/analysis');
check('ST03 分析 CT=14.72', analysis.payload?.metrics?.ct === 14.72, analysis.payload?.metrics?.ct);
check('ST03 无待复核', (analysis.payload?.pending ?? []).length === 0);
check('双手图数据存在', Array.isArray(analysis.payload?.hands?.R) && analysis.payload.hands.R.length > 0);

const st02 = await call('GET', '/api/stations/L01-ST02/analysis');
check('ST02 检出持住浪费', (st02.payload?.wastes ?? []).some((w) => w.waste === '持住'));

const line = await call('GET', '/api/lines/L01/analysis');
check('山积图6行', line.payload?.rows?.length === 6);
check('瓶颈稳定为ST02（ST03改善后瓶颈转移）', line.payload?.rows?.find((r) => r.is_bottleneck)?.station_id === 'L01-ST02',
  JSON.stringify(line.payload?.rows?.map((r) => [r.station_id, r.ct_s])));
check('平衡率有值', typeof line.payload?.balance_rate === 'number' && line.payload.balance_rate > 0);

const invalid = await call('POST', '/api/stations/L01-ST05/elements/submit', {
  cycle_count: 10,
  cv: 0,
  elements: [{ seq: 1, start_ms: 0, dur_s: 1.5, hand: 'R', type: '取放', desc: '取标签', va_class: 'NNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 }],
}, 422);
check('V3 循环数<15 被拦截', invalid.payload?.details?.errors?.some((e) => e.code === 'V3'));

const overlap = await call('POST', '/api/stations/L01-ST05/elements/submit', {
  cycle_count: 15,
  cv: 0,
  elements: [
    { seq: 1, start_ms: 0, dur_s: 2.0, hand: 'R', type: '取放', desc: 'A', va_class: 'NNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
    { seq: 2, start_ms: 1000, dur_s: 1.0, hand: 'R', type: '取放', desc: 'B', va_class: 'NNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
  ],
}, 422);
check('V2 时间轴重叠被拦截', overlap.payload?.details?.errors?.some((e) => e.code === 'V2'));

const suggestion = await call('POST', '/api/stations/L01-ST02/suggestions/generate');
check('生成候选建议', (suggestion.payload?.candidates ?? []).length > 0, JSON.stringify(suggestion.payload)?.slice(0, 200));
check('建议含优先级分档', suggestion.payload?.candidates?.[0]?.tier?.startsWith('P'));

const imps = await call('GET', '/api/improvements?line_id=L01');
check('建议清单3条', imps.payload?.improvements?.length >= 3);

const compare = await call('GET', '/api/stations/L01-ST03/compare');
check('对比 ΔCT=4.26', compare.payload?.delta_ct === 4.26, compare.payload?.delta_ct);
check('收益年化约16326元', compare.payload?.benefit?.annual_yuan > 16000 && compare.payload?.benefit?.annual_yuan < 17000,
  compare.payload?.benefit?.annual_yuan);
check('配对率≥60%', compare.payload?.pairing_rate >= 60, compare.payload?.pairing_rate);

const params = await call('GET', '/api/config/benefit-params?line_id=L01');
check('收益参数已配置 45元/h', params.payload?.params?.rate_yuan_per_hour === 45);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
