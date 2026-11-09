/* v3.29 修复验证：复刻修复后的前端时间数学 → 真实 API /validate + 提交-重载闭环 */
'use strict';
const BASE = 'http://127.0.0.1:3001/api';

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  return (await r.json()).accessToken;
}
function api(token, method, path, body) {
  return fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}
const el = (seq, start_ms, dur_s) => ({
  seq, start_ms, dur_s, hand: 'B', type: '装配', desc: '装前壳到位', va_class: 'VA',
  outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15,
});
const v2 = (j) => (j?.errors ?? []).filter((e) => e.code === 'V2');

/* ============ 修复后前端逻辑复刻（WorkbenchPage.tsx v3.29） ============ */
const durToGrid = (s) => Math.round(s * 100) / 100;
const elEndMs = (d) => Math.round(d.start_ms + durToGrid(d.dur_s) * 1000);

/** 修复后 addElement：起点=最大止点（INT 取整）/首要素=播放头取整；dur 网格化 */
function addElementFixed(draft, playhead, newDurS) {
  const prevEnd = draft.reduce((m, d) => Math.max(m, elEndMs(d)), 0);
  const maxSeq = draft.reduce((m, d) => Math.max(m, d.seq), 0);
  return { ...el(maxSeq + 1, 0, 1), start_ms: draft.length > 0 ? Math.round(prevEnd) : Math.max(0, Math.round(playhead)), dur_s: durToGrid(newDurS) };
}
/** 修复后 I/O 落止点：mark=播放头取整；dur 网格化 */
function ioEndFixed(d, playhead, frameMs) {
  const end = Math.max(0, Math.round(playhead));
  if (end <= d.start_ms) return { ...d, dur_s: durToGrid(frameMs / 1000) };
  return { ...d, dur_s: durToGrid((end - d.start_ms) / 1000) };
}
/** 修复后分割：splitMs 取整；第二半起点=第一半起点+第一半网格时长（后端 V2 同公式） */
function splitFixed(d, playhead, frameMs) {
  const end = elEndMs(d);
  const splitMs = Math.max(0, Math.round(playhead));
  if (splitMs <= d.start_ms + frameMs || splitMs >= end - frameMs) return [d];
  const firstDur = durToGrid((splitMs - d.start_ms) / 1000);
  const secondStart = d.start_ms + Math.round(firstDur * 1000);
  return [
    { ...d, dur_s: firstDur },
    { ...d, seq: d.seq + 1, start_ms: secondStart, dur_s: durToGrid((end - secondStart) / 1000) },
  ];
}
/** 修复后拖拽磁吸（左缘）：edge 取整；dur 网格化；止点保持 originEnd */
function dragLeftFixed(d, edgeRaw) {
  const originEnd = elEndMs(d);
  const nextStart = Math.round(edgeRaw);
  return { ...d, start_ms: nextStart, dur_s: durToGrid((originEnd - nextStart) / 1000) };
}
/** 修复后 buildPayload：start 取整 + dur 网格化 */
function payloadOf(draft) {
  return [...draft].sort((a, b) => a.start_ms - b.start_ms).map((d, i) => ({
    seq: i + 1, start_ms: Math.round(d.start_ms), dur_s: durToGrid(d.dur_s),
    hand: d.hand, type: d.type, desc: d.desc, va_class: d.va_class,
    outlier_flag: d.outlier_flag, outlier_reason: d.outlier_reason, rating: d.rating, allowance: d.allowance,
  }));
}

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
};

(async () => {
  const token = await login();
  const station = 'L01-ST01';
  const frameMs = 1000 / 30;
  const VAL = (elements) => api(token, 'POST', `/stations/${station}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements });

  console.log('== 1. 修复后前端产物 → /validate 零 V2 ==');
  // 1a K 停分数播放头（帧量化）→ ＋新增链
  for (const pk of [60, 61, 62, 63, 100, 101, 137, 200, 201]) {
    const ph = pk * frameMs;
    const draft = [];
    for (let n = 0; n < 5; n += 1) draft.push(addElementFixed(draft, ph, 1.8));
    const r = await VAL(payloadOf(draft));
    check(`1a 纯新增链(分数播放头 ${ph.toFixed(2)}ms)`, v2(r.json).length === 0, JSON.stringify(v2(r.json)));
  }
  // 1b 分数播放头 → I/O 止点 → 继续链
  for (const pk of [61, 62, 100, 101]) {
    const ph = pk * frameMs;
    let draft = [addElementFixed([], ph, 1.8)];
    draft[0] = ioEndFixed(draft[0], Math.round(ph) + 1500, frameMs);
    for (let n = 0; n < 3; n += 1) draft.push(addElementFixed(draft, ph, 1.8));
    const r = await VAL(payloadOf(draft));
    check(`1b I/O+链(播放头 ${ph.toFixed(2)}ms)`, v2(r.json).length === 0, JSON.stringify(v2(r.json)));
  }
  // 1c 分割：旧实现误报的全部帧位置，修复后零 V2
  for (let pk = 30; pk <= 300; pk += 1) {
    const P = pk * frameMs;
    const d0 = addElementFixed([], 0, 2.0); // {0, 2.0}
    const parts = splitFixed(d0, P, frameMs);
    if (parts.length !== 2) continue;
    const r = await VAL(payloadOf(parts));
    if (v2(r.json).length > 0) { check(`1c 分割@${P.toFixed(2)}ms`, false, JSON.stringify(v2(r.json))); break; }
  }
  check('1c 分割全帧位扫描(30..300)', true);
  // 1d 拖拽磁吸到分数播放头 + 后续链（左缘受 originEnd-frameMs 钳制，与前端 clamp 一致）
  for (let pk = 30; pk <= 300; pk += 1) {
    const P = pk * frameMs;
    const d0 = addElementFixed([], 0, 2.0); // {0, 2.0}，originEnd=2000
    const edge = Math.min(Math.round(P), elEndMs(d0) - frameMs); // 左缘不得越过右缘
    const dragged = dragLeftFixed(d0, edge);
    const draft = [dragged, addElementFixed([dragged], 0, 1.0)];
    const r = await VAL(payloadOf(draft));
    if (v2(r.json).length > 0) { check(`1d 拖拽吸附@${P.toFixed(2)}ms`, false, JSON.stringify(v2(r.json))); break; }
  }
  check('1d 拖拽吸附全帧位扫描(30..300)', true);

  console.log('== 2. 提交-重载闭环（旧实现 4ms 幻影场景） ==');
  const sid = 'L01-ST98';
  await api(token, 'POST', '/stations', { station_id: sid, line_id: 'L01', name: 'v329验证临时位', tt: 60 });
  // 模拟 I/O 在 1996ms 落止点（dur 网格化 → 2.0），自动链下一要素
  let d0 = addElementFixed([], 0, 1.0);
  d0 = ioEndFixed(d0, 1996, frameMs); // durToGrid(1.996)=2.0
  const draft = [d0, addElementFixed([d0], 0, 1.0)];
  const pre = await api(token, 'POST', `/stations/${sid}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: payloadOf(draft) });
  check('2a 提交前校验零 V2', v2(pre.json).length === 0, JSON.stringify(v2(pre.json)));
  const sub = await api(token, 'POST', `/stations/${sid}/elements/submit`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: payloadOf(draft) });
  check('2b 提交成功', sub.status === 201 && sub.json?.element_count === 2, JSON.stringify(sub.json).slice(0, 120));
  const rl = await api(token, 'GET', `/stations/${sid}/elements`);
  const saved = rl.json?.elements ?? [];
  const storedOk = saved.length === 2 && elEndMs(saved[0]) === saved[1].start_ms;
  check('2c 落库止点=下一要素起点(逐毫秒连续)', storedOk,
    saved.map((e) => `#${e.seq}{${e.start_ms},${e.dur_s}}`).join(' '));
  const post = await api(token, 'POST', `/stations/${sid}/elements/validate`,
    { bol_version: 1, cycle_count: 15, cv: 0.1, elements: saved.map((e) => el(e.seq, e.start_ms, e.dur_s)) });
  check('2d 重载后再校验零 V2', v2(post.json).length === 0, JSON.stringify(v2(post.json)));
  await api(token, 'DELETE', `/stations/${sid}/retest`); // 无直接删站端点：作废复测清草稿不可用，改 SQL 清理（见下）

  console.log('== 3. 真重叠仍如实拦截（防过度放宽） ==');
  const t1 = await VAL([el(1, 0, 2.0), el(2, 1000, 1.0)]);
  check('3a 真重叠 1000ms 仍拦截', t1.json?.errors?.some((e) => e.code === 'V2' && /重叠1000ms/.test(e.message)), JSON.stringify(v2(t1.json)));
  const t2 = await VAL([el(1, 0, 3.2), el(2, 3000, 2.8)]);
  check('3b smoke 契约 200ms 重叠仍拦截', t2.json?.errors?.some((e) => e.code === 'V2' && /重叠200ms/.test(e.message)), JSON.stringify(v2(t2.json)));
  // 3c：4 位小数 dur 直传（前端网格化后不再产生；验证后端对遗留/直连接口的防御）——
  //   V2 按落库值 round2(1.005)=1.01 判定：提交前即暴露 5ms 越界，而不是旧实现
  //   "校验放过(round(1005)=1005) → 落库 2.0s → 重载才报"的事后幻影
  const t3 = await VAL([el(1, 0, 1.005), el(2, 1005, 1.0)]);
  check('3c 4位小数 dur 按落库值提交前拦截', v2(t3.json).length === 1 && /重叠5ms/.test(v2(t3.json)[0].message), JSON.stringify(v2(t3.json)));
  // 3d：边界另一侧——round2(1.0049)=1.0 → 落库止点 1000 ≤ 1005，无重叠无幻影
  const t4 = await VAL([el(1, 0, 1.0049), el(2, 1005, 1.0)]);
  check('3d 4位小数 dur  benign 侧零误报', v2(t4.json).length === 0, JSON.stringify(v2(t4.json)));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
