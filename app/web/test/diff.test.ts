/* 版本 Diff 纯函数单测（设计规范附录 A 十条用例）。
 * 运行：node test/diff.test.ts（Node ≥22.18 支持 TS 类型剥离，零依赖） */
import assert from 'node:assert/strict';
import { computeDiff, normalizeDesc, type DiffElement } from '../src/diff.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name, extra); }
  else { fail++; console.log('  ✘', name, extra); }
};

const el = (over: Partial<DiffElement> & { seq: number; desc: string }): DiffElement => ({
  start_ms: over.seq * 1000,
  dur_s: 1,
  hand: 'R',
  type: '装配',
  va_class: 'VA',
  outlier_flag: 0,
  rating: 1,
  allowance: 0.15,
  std_time: 1.15,
  ...over,
});

const rowOf = (r: ReturnType<typeof computeDiff>, desc: string) =>
  r.rows.find((row) => normalizeDesc(row.b?.desc ?? row.a?.desc ?? '') === desc)!;

/* 1. 同名同描述同时长不变 → UNCHANGED */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '装后盖' })],
  );
  ok('1. 全同 → UNCHANGED', r.rows.length === 1 && r.rows[0].state === 'UNCHANGED', `state=${r.rows[0]?.state}`);
}

/* 2. 同名同时长 +1s → MODIFY-数值（时长+ST） */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '装后盖', dur_s: 2, std_time: 2.3 })],
  );
  const row = r.rows[0];
  ok('2. 时长+1s → MODIFY-数值（时长/ST）', row.state === 'MODIFY-数值' && row.changed.includes('时长') && row.changed.includes('ST'),
    `state=${row.state} changed=${row.changed.join('/')}`);
}

/* 3. 同名同时长变且 VA 变 → MODIFY-结构 */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖', va_class: 'VA' })],
    [el({ seq: 1, desc: '装后盖', dur_s: 2, std_time: 2.3, va_class: 'NVA' })],
  );
  ok('3. VA 变 → MODIFY-结构', r.rows[0].state === 'MODIFY-结构', `state=${r.rows[0].state}`);
}

/* 4. 同名同字段仅起点 +300ms → MOVE */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '装后盖', start_ms: 300 })],
  );
  ok('4. 起点+300ms → MOVE', r.rows[0].state === 'MOVE', `state=${r.rows[0].state}`);
}

/* 5. 起点 +30ms → 不判 MOVE（旧侧 1000ms → 新侧 1030ms） */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '装后盖', start_ms: 1030 })],
  );
  ok('5. 起点+30ms → 不判 MOVE', r.rows[0].state === 'UNCHANGED', `state=${r.rows[0].state}`);
}

/* 6. 描述消失 → DELETE + ADD */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '锁螺丝' })],
  );
  ok('6. 描述替换 → DELETE + ADD', r.summary.deletes === 1 && r.summary.adds === 1 && r.rows.length === 2,
    `del=${r.summary.deletes} add=${r.summary.adds} rows=${r.rows.length}`);
}

/* 7. 手别 R→L 且时长不变 → MODIFY-结构（手别） */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '持住零件', hand: 'R' })],
    [el({ seq: 1, desc: '持住零件', hand: 'L' })],
  );
  ok('7. 手别 R→L → MODIFY-结构（手别）', r.rows[0].state === 'MODIFY-结构' && r.rows[0].changed.includes('手别'),
    `state=${r.rows[0].state} changed=${r.rows[0].changed.join('/')}`);
}

/* 8. 时长 +0.005 → 不判变化 */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖', dur_s: 1 })],
    [el({ seq: 1, desc: '装后盖', dur_s: 1.005 })],
  );
  ok('8. 时长+0.005 → 不判变化', r.rows[0].state === 'UNCHANGED', `state=${r.rows[0].state}`);
}

/* 9. 异常 0→1 且时长不变 → MODIFY-结构（异常标记） */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '装后盖', outlier_flag: 1, outlier_reason: '缺料' } as Partial<DiffElement>)],
  );
  ok('9. 异常 0→1 → MODIFY-结构（异常标记）', r.rows[0].state === 'MODIFY-结构' && r.rows[0].changed.includes('异常标记'),
    `state=${r.rows[0].state} changed=${r.rows[0].changed.join('/')}`);
}

/* 10. 无描述同时长 +2s → 判 MODIFY-数值（时长）+ 近似配对提示 */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '', start_ms: 0, dur_s: 1, std_time: 1.15 })],
    [el({ seq: 1, desc: '', start_ms: 0, dur_s: 3, std_time: 3.45 })],
  );
  ok('10. 无描述时长+2s → MODIFY-数值（时长）', r.rows[0].state === 'MODIFY-数值' && r.rows[0].changed.includes('时长'),
    `state=${r.rows[0].state} changed=${r.rows[0].changed.join('/')}`);
  ok('10b. 无描述近似配对有提示', r.summary.warnings.length > 0, r.summary.warnings[0] ?? '');
}

/* 附加：汇总口径（CT=Σ非异常ST；异常不计入） */
{
  const r = computeDiff(
    [el({ seq: 1, desc: 'a' }), el({ seq: 2, desc: 'b', outlier_flag: 1, std_time: 5 } as Partial<DiffElement>)],
    [el({ seq: 1, desc: 'a' }), el({ seq: 2, desc: 'b', dur_s: 2, std_time: 2.3 })],
  );
  ok('11. CT 口径：异常要素不计入', r.summary.ctA === 1.15 && Math.abs(r.summary.ctB - 3.45) < 0.001, `ctA=${r.summary.ctA} ctB=${r.summary.ctB}`);
  ok('11b. 行序按当前侧起点交错', r.rows[0].b?.desc === 'a' && r.rows[1].b?.desc === 'b', r.rows.map((x) => x.b?.desc).join(','));
}

/* 附加：LCS 抗中间插入（插入使后移要素判 MOVE，前段不变） */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '取螺丝' }), el({ seq: 2, desc: '装后盖' })],
    [el({ seq: 1, desc: '取螺丝' }), el({ seq: 2, desc: '点胶' }), el({ seq: 3, desc: '装后盖' })],
  );
  ok('12. 中间插入 → 新增 1 + 前段不变 + 后移判 MOVE',
    r.summary.adds === 1 && r.summary.unchanged === 1 && r.summary.moves === 1 && r.summary.deletes === 0,
    `add=${r.summary.adds} unch=${r.summary.unchanged} move=${r.summary.moves}`);
}

/* 附加：描述改写（含/被含）允许 MODIFY 配对，不拆成 DELETE+ADD，且 desc 变化显式标注 */
{
  const r = computeDiff(
    [el({ seq: 1, desc: '装后盖' })],
    [el({ seq: 1, desc: '装后盖（左）', start_ms: 1030 })],
  );
  ok('13. 描述改写（包含关系）→ 不拆行且标注「描述」',
    r.rows.length === 1 && r.rows[0].state === 'MODIFY-数值' && r.rows[0].changed.includes('描述'),
    `rows=${r.rows.length} state=${r.rows[0]?.state} changed=${r.rows[0]?.changed.join('/')}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
