/* 端到端复现 v2：修正测试构造 + 证实"提交-重载"幻影路径 */
'use strict';
const BASE = 'http://127.0.0.1:3001/api';

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  return (await r.json()).accessToken;
}
function el(seq, start_ms, dur_s, hand = 'B', type = '拿取', desc = '拿取料盒', va_class = 'RNVA') {
  return { seq, start_ms, dur_s, hand, type, desc, va_class, outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 };
}
async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const v2 = (j) => (j?.errors ?? []).filter((e) => e.code === 'V2');

(async () => {
  const token = await login();
  const station = 'L01-ST01';

  // A 分割产物（分数播放头 2066.6667 处分割）→ 立即 V2
  const a = await api(token, 'POST', `/stations/${station}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: [el(1, 2000, 0.07), el(2, 2067, 1.93)] });
  console.log('A 分割产物(分数起点) → V2:', JSON.stringify(v2(a.json)));

  // A2 修正后的网格化分割形态（分割点量化到 2070）→ 应零 V2
  const a2 = await api(token, 'POST', `/stations/${station}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: [el(1, 2000, 0.07), el(2, 2070, 1.93)] });
  console.log('A2 网格化分割 → V2:', JSON.stringify(v2(a2.json)));

  // B 拖拽磁吸幻影：左缘拖到 2063.3333（round10 后止点 4003 > 下一要素起点 4000）
  const b = await api(token, 'POST', `/stations/${station}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: [el(1, 2063, 1.94), el(2, 4000, 1.0)] });
  console.log('B 拖拽磁吸(止点越界) → V2:', JSON.stringify(v2(b.json)));

  // C 纯自动链 → 零 V2
  const c = await api(token, 'POST', `/stations/${station}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: [el(1, 0, 1.0), el(2, 1000, 1.0), el(3, 2000, 1.0)] });
  console.log('C 纯自动链 → V2:', JSON.stringify(v2(c.json)));

  // D "提交-重载"幻影：I/O 产生 3 位小数 dur=1.996（链接受到的起点 +1996），
  //   校验通过（round(1996.0000000000002)=1996），但落库 round2(1.996)=2.0 → 止点 +2000 > 1996
  const tmp = await api(token, 'POST', '/stations', { station_id: 'Z99-ST01', line_id: 'L01', name: '幻影复现临时位', tt: 60 });
  console.log('D 临时工位创建:', tmp.status, tmp.json?.station_id ?? tmp.json?.message);
  const sid = 'Z99-ST01';
  const pre = await api(token, 'POST', `/stations/${sid}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: [el(1, 0, 1.996), el(2, 1996, 1.0)] });
  console.log('D1 提交前校验 → V2:', JSON.stringify(v2(pre.json)), '(期望空=校验放过)');
  const sub = await api(token, 'POST', `/stations/${sid}/elements/submit`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: [el(1, 0, 1.996), el(2, 1996, 1.0)] });
  console.log('D2 提交:', sub.status, sub.json?.element_count != null ? `CT=${sub.json.ct}` : sub.json?.message);
  const reload = await api(token, 'GET', `/stations/${sid}/elements`);
  const saved = reload.json?.elements ?? [];
  console.log('D3 落库值:', saved.map((e) => `#${e.seq}{start:${e.start_ms},dur:${e.dur_s}}`).join(' '));
  const post = await api(token, 'POST', `/stations/${sid}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: saved.map((e) => el(e.seq, e.start_ms, e.dur_s)) });
  console.log('D4 重载后再校验 → V2:', JSON.stringify(v2(post.json)), '← 幻影重叠');

  // 清理
  const del = await api(token, 'DELETE', `/stations/${sid}`);
  console.log('D5 临时工位清理:', del.status);
})();
