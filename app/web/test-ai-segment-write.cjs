/**
 * AI 自动分解写入链路端到端验证（v3.34）
 * 创建临时工位 → 按页面同一套逻辑构造 payload → 提交 → 校验 source 落库 → 删除临时工位
 */
const BASE = 'http://127.0.0.1:3001/api';
const SID = 'L01-ST98';

let ok = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { ok += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + ' ' + extra); }
}

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

(async () => {
  const login = await call('POST', '/auth/login', { username: 'admin', password: '123456' });
  const token = login.body && login.body.accessToken;
  check('登录成功', login.status === 200 && !!token, `status=${login.status}`);
  if (!token) { console.log('\n结果: ' + ok + ' 通过 / ' + fail + ' 失败'); process.exit(1); }

  await call('DELETE', '/stations/' + SID, undefined, token); // 清残留

  const created = await call('POST', '/stations', { station_id: SID, line_id: 'L01', name: 'AI分解临时位' }, token);
  check('创建临时工位', created.status === 200 || created.status === 201, `status=${created.status} ${JSON.stringify(created.body)}`);

  // ── 与 AiSegmentPage.buildPayload 同一套算法：按顺序累加时长、seq 连续、source=ai_assisted ──
  const cands = [[1200, 2400, 'L'], [2400, 3300, 'R'], [3300, 5100, 'B']];
  const elements = [];
  let cursor = 0;
  cands.forEach(([s, e, hand], i) => {
    const dur = Math.max(0.1, Math.round(((e - s) / 1000) * 100) / 100);
    elements.push({
      seq: i + 1, start_ms: cursor, dur_s: dur, hand, type: '其他',
      desc: 'AI 候选' + (i + 1), va_class: 'RNVA', outlier_flag: 0, outlier_reason: '',
      rating: 1, allowance: 0.15, source: 'ai_assisted',
    });
    cursor += Math.round(dur * 1000);
  });

  const val = await call('POST', `/stations/${SID}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0, elements }, token);
  check('V1/V2/V3 校验通过（AI 要素可直接提交）', (val.status === 200 || val.status === 201) && val.body && val.body.ok === true,
    `status=${val.status} errors=${JSON.stringify((val.body || {}).errors)}`);

  const sub = await call('POST', `/stations/${SID}/elements/submit`,
    { bol_version: 1, cycle_count: 15, cv: 0, video_id: 'ai-segment', elements }, token);
  check('提交写入成功', sub.status === 200 || sub.status === 201, `status=${sub.status} ${JSON.stringify(sub.body)}`);
  check('写入条数与 CT 合理',
    sub.body && sub.body.element_count === 3 && Number(sub.body.ct) > 0, JSON.stringify(sub.body));

  const back = await call('GET', `/stations/${SID}/elements`, undefined, token);
  const els = (back.body && back.body.elements) || [];
  check('回读 3 条要素', els.length === 3, 'got=' + els.length);
  check('source 落库为 ai_assisted', els.length > 0 && els.every((e) => e.source === 'ai_assisted'),
    'sources=' + JSON.stringify(els.map((e) => e.source)));
  check('video_id 记录为 ai-segment', els.length > 0 && els.every((e) => e.video_id === 'ai-segment'),
    'ids=' + JSON.stringify(els.map((e) => e.video_id)));
  check('时间链连续无重叠',
    els.length === 3 && [0, 1].every((i) => els[i].start_ms + Math.round(els[i].dur_s * 1000) <= els[i + 1].start_ms),
    JSON.stringify(els.map((e) => [e.start_ms, e.dur_s])));

  const del = await call('DELETE', '/stations/' + SID, undefined, token);
  check('清理临时工位', del.status === 200 || del.status === 204, `status=${del.status} ${JSON.stringify(del.body)}`);

  console.log('\n结果: ' + ok + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
