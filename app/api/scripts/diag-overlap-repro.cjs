/* 复现诊断：忠实复刻前端 addElement/buildPayload 链路 + 后端 V2 判定，扫描误报场景 */
'use strict';

/** —— 前端 addElement（WorkbenchPage.tsx:698）忠实复刻 —— */
function addElementSim(draft, playhead, newDurS, dupFrom) {
  const prevEnd = draft.reduce((m, d) => Math.max(m, d.start_ms + d.dur_s * 1000), 0);
  const maxSeq = draft.reduce((m, d) => Math.max(m, d.seq), 0);
  return {
    seq: maxSeq + 1,
    start_ms: draft.length > 0 ? Math.round(prevEnd) : playhead,
    dur_s: dupFrom ? dupFrom.dur_s : newDurS,
    hand: dupFrom ? dupFrom.hand : 'B',
    type: '拿取', desc: '新要素', va_class: 'RNVA',
    outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15,
  };
}

/** —— 前端 buildPayload（WorkbenchPage.tsx:1082）忠实复刻 —— */
function buildPayloadSim(draft) {
  const ordered = [...draft].sort((a, b) => a.start_ms - b.start_ms).map((d, i) => ({ ...d, seq: i + 1 }));
  return ordered.map((d) => ({
    seq: d.seq,
    start_ms: Math.round(d.start_ms),
    dur_s: d.dur_s,
    hand: d.hand, type: d.type, desc: d.desc, va_class: d.va_class,
    outlier_flag: d.outlier_flag, outlier_reason: d.outlier_reason,
    rating: d.rating, allowance: d.allowance,
  }));
}

/** —— 后端 V2（validation.ts:79-98）忠实复刻 —— */
function v2Check(elements) {
  const errs = [];
  for (const hand of ['L', 'R', 'B']) {
    const list = elements.filter((el) => el.hand === hand).sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 0; i < list.length - 1; i += 1) {
      const cur = list[i]; const next = list[i + 1];
      const end = cur.start_ms + Math.round(cur.dur_s * 1000);
      if (end > next.start_ms) {
        errs.push(`${hand}手 第${cur.seq}→第${next.seq} 重叠${end - next.start_ms}ms (cur.end=${end}, next.start=${next.start_ms}, cur.dur_s=${cur.dur_s})`);
      }
    }
  }
  return errs;
}

/** I/O 落边界（WorkbenchPage.tsx:784/796）忠实复刻 */
function ioStart(el, playhead, frameMs) {
  const s = Math.max(0, Math.round(playhead));
  const end = el.start_ms + el.dur_s * 1000;
  if (s + frameMs >= end) return { start_ms: s, dur_s: frameMs / 1000 };
  return { start_ms: s, dur_s: (end - s) / 1000 };
}
function ioEnd(el, playhead, frameMs) {
  const end = Math.max(0, Math.round(playhead));
  if (end <= el.start_ms) return { dur_s: frameMs / 1000 };
  return { dur_s: (end - el.start_ms) / 1000 };
}

const results = [];
function report(tag, errs, extra = '') {
  if (errs.length) results.push({ tag, errs, extra });
}

/* ============ S1 纯 ＋新增 链 ============ */
{
  const playheads = [0, 3333.3333333333335, 3350.0000000000005, 3383.3333333333335, 5000.4, 1234.5, 999.9, 16.666666666666668 * 137];
  for (const ph of playheads) {
    for (let d10 = 1; d10 <= 60; d10 += 1) {
      const newDurS = d10 / 10;
      const draft = [];
      for (let n = 0; n < 5; n += 1) draft.push(addElementSim(draft, ph, newDurS));
      report(`S1 纯新增链 ph=${ph} dur=${newDurS}`, v2Check(buildPayloadSim(draft)));
    }
  }
  // 两位小数时长也扫一遍
  for (const ph of playheads) {
    for (let d100 = 10; d100 <= 6000; d100 += 7) {
      const newDurS = d100 / 100;
      const draft = [];
      for (let n = 0; n < 5; n += 1) draft.push(addElementSim(draft, ph, newDurS));
      report(`S1b 纯新增链(2位小数) ph=${ph} dur=${newDurS}`, v2Check(buildPayloadSim(draft)));
    }
  }
}

/* ============ S2 新增链 + I/O（用户"按 L 播、K 停、O 落止点"标准回路） ============ */
{
  const frameMs = 1000 / 30;
  for (const ph0 of [0, 3333.3333333333335, 3383.3333333333335]) {
    for (let oMs = 2000; oMs <= 9000; oMs += 333) {
      const draft = [addElementSim([], ph0, 1)];
      Object.assign(draft[0], ioEnd(draft[0], oMs, frameMs));
      for (let n = 0; n < 3; n += 1) draft.push(addElementSim(draft, ph0, 1));
      report(`S2 新增+I/O(O@${oMs}) ph0=${ph0}`, v2Check(buildPayloadSim(draft)));
    }
  }
}

/* ============ S3 新增链 + I 起点 ============ */
{
  const frameMs = 1000 / 30;
  for (const ph0 of [3333.3333333333335]) {
    for (let iMs = 1000; iMs <= 4000; iMs += 137) {
      const draft = [addElementSim([], ph0, 1)];
      Object.assign(draft[0], ioStart(draft[0], iMs, frameMs));
      for (let n = 0; n < 3; n += 1) draft.push(addElementSim(draft, ph0, 1));
      report(`S3 新增+I(I@${iMs}) ph0=${ph0}`, v2Check(buildPayloadSim(draft)));
    }
  }
}

/* ============ S4 分割（splitAtPlayhead，第二块 start=分数播放头） ============ */
{
  const frameMs = 1000 / 30;
  for (let pk = 30; pk <= 300; pk += 1) {
    const P = pk * frameMs; // 帧量化分数播放头
    const S = 2000; const E = 4000;
    if (P <= S + frameMs || P >= E - frameMs) continue;
    const first = { seq: 1, start_ms: S, dur_s: Math.round((P - S) / 10) / 100, hand: 'B', type: '拿取', desc: 'x', va_class: 'RNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 };
    const second = { seq: 2, start_ms: P, dur_s: Math.round((E - P) / 10) / 100, hand: 'B', type: '拿取', desc: 'x', va_class: 'RNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 };
    report(`S4 分割@P=${P.toFixed(4)}`, v2Check(buildPayloadSim([first, second])), `first.dur=${first.dur_s} second.start=${second.start_ms}`);
  }
}

/* ============ S5 拖拽磁吸到分数播放头 ============ */
{
  const frameMs = 1000 / 30;
  for (let pk = 30; pk <= 300; pk += 1) {
    const P = pk * frameMs;
    const S = 2000; const E = 4000;
    const nextStart = P; // snap 精确等于候选值（播放头）
    const dur = Math.round((E - nextStart) / 10) / 100;
    const el = { seq: 1, start_ms: nextStart, dur_s: dur, hand: 'B', type: '拿取', desc: 'x', va_class: 'RNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 };
    const nextEl = addElementSim([el], 0, 1);
    report(`S5 拖拽吸附@P=${P.toFixed(4)}`, v2Check(buildPayloadSim([el, nextEl])), `dur=${dur}`);
  }
}

/* ============ S6 现场最可能组合：K 停(分数播放头) → ＋新增 → 播 → K 停 → O → ＋新增… ============ */
{
  const frameMs = 1000 / 30;
  for (let pk = 60; pk <= 400; pk += 1) {
    const ph = pk * frameMs;
    const draft = [];
    // 第 1 个要素：落在分数播放头
    draft.push(addElementSim(draft, ph, 1.8));
    // 用户按 O 在某个整数帧位置落止点
    const oMs = Math.round(ph / 100) * 100 + 1500;
    Object.assign(draft[0], ioEnd(draft[0], oMs, frameMs));
    // 后续自动连续生成
    for (let n = 0; n < 3; n += 1) draft.push(addElementSim(draft, ph, 1.8));
    report(`S6 K停+O ph=${ph.toFixed(4)} O@${oMs}`, v2Check(buildPayloadSim(draft)));
  }
}

console.log('=== 误报命中数:', results.length, '===');
const byTag = {};
for (const r of results) {
  const key = r.tag.replace(/[\d.]+/g, 'N');
  byTag[key] = (byTag[key] || 0) + 1;
}
console.log(JSON.stringify(byTag, null, 2));
console.log('--- 样例（前 12 条）---');
results.slice(0, 12).forEach((r) => console.log(r.tag, '=>', r.errs[0], r.extra));
