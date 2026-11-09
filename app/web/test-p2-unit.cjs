/**
 * v3.44 P2 纯函数单测：HOI 状态机（hoi.ts）+ SOP 序列对齐（sop.ts）
 *
 * 不起浏览器、不连 API：用 TypeScript 编译器把两个纯函数模块转译成 CJS 后直接断言。
 * （Node 22 直跑 .ts 对 ai-segment 的无扩展名 import 不可靠，转译是最稳路径。）
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};

/** 把 ai-segment 下的 .ts 转成 CJS 并加载（hoi.ts 的类型 import 已是 import type，转译后消失） */
function loadTs(rel) {
  const src = fs.readFileSync(path.join(__dirname, 'src', 'ai-segment', rel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'require', 'module', js)(mod.exports, require, mod);
  return mod.exports;
}

const { hoiInfer, zoneAt } = loadTs('hoi.ts');
const { alignSop } = loadTs('sop.ts');

const ROI = { x: 0.2, y: 0.3, w: 0.6, h: 0.5 };
const ZONES = [
  { name: '扫码枪卡位', x: 0.0, y: 0.0, w: 0.4, h: 1.0 },  // ROI 左 40%
  { name: '料箱', x: 0.6, y: 0.0, w: 0.4, h: 1.0 },         // ROI 右 40%
];

/** 构造轨迹：tMs→画布归一化坐标 */
function traj(pts) { return pts.map(([t, cx, cy]) => ({ t, cx, cy })); }

console.log('\n--- zoneAt（子区命中，坐标相对 ROI 换算到画布） ---');
// ROI.x=0.2,w=0.6：子区1 画布 x ∈ [0.2, 0.44]；子区2 画布 x ∈ [0.56, 0.8]
ok('z1 区内点', zoneAt(0.30, 0.5, ZONES, ROI) === 0);
ok('z2 区内点', zoneAt(0.70, 0.5, ZONES, ROI) === 1);
ok('ROI 内但不在任何子区（中间 20%）', zoneAt(0.50, 0.5, ZONES, ROI) === -1);
ok('ROI 外（y 不在 ROI）', zoneAt(0.30, 0.1, ZONES, ROI) === -1);

console.log('\n--- hoiInfer（HOI 状态机四结局） ---');
// 结局1：起于 z1 → 止于 z2（拿取该区物体放至目的区）
{
  const pts = [];
  for (let i = 0; i < 8; i++) pts.push({ t: 1000 + i * 100, cx: 0.30, cy: 0.5 });   // 起 z1（0.8s 驻留）
  for (let i = 0; i < 8; i++) pts.push({ t: 1800 + i * 100, cx: 0.70, cy: 0.5 });   // 终 z2
  const r = hoiInfer(pts, 1000, 2600, ZONES, ROI);
  ok('拿取推断 object=扫码枪卡位', r.object === '扫码枪卡位', JSON.stringify(r));
  ok('拿取推断 dest=料箱', r.dest === '料箱');
  ok('依据可解释（含起止区名）', /起于「扫码枪卡位」.*止于「料箱」/.test(r.basis ?? ''), r.basis);
}
// 结局2：全程同区（区内作业）
{
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push({ t: 1000 + i * 100, cx: 0.70, cy: 0.5 });
  const r = hoiInfer(pts, 1000, 3000, ZONES, ROI);
  ok('区内作业 object=dest=料箱', r.object === '料箱' && r.dest === '料箱', JSON.stringify(r));
}
// 结局3：只终点有区（放置类，对象未知）
{
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ t: 1000 + i * 100, cx: 0.50, cy: 0.5 });  // 中间无区
  for (let i = 0; i < 10; i++) pts.push({ t: 2000 + i * 100, cx: 0.70, cy: 0.5 });  // 终 z2
  const r = hoiInfer(pts, 1000, 3000, ZONES, ROI);
  ok('放置推断 dest=料箱 且 object 空', r.dest === '料箱' && r.object === undefined, JSON.stringify(r));
}
// 结局4：只起点有区（去向未知）
{
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ t: 1000 + i * 100, cx: 0.30, cy: 0.5 });
  for (let i = 0; i < 10; i++) pts.push({ t: 2000 + i * 100, cx: 0.50, cy: 0.5 });
  const r = hoiInfer(pts, 1000, 3000, ZONES, ROI);
  ok('起于区 object=扫码枪卡位 且 dest 空', r.object === '扫码枪卡位' && r.dest === undefined, JSON.stringify(r));
}
// 驻留不足（每区只 1 帧）→ 不算驻留
{
  const pts = [
    { t: 1000, cx: 0.30, cy: 0.5 }, { t: 1100, cx: 0.50, cy: 0.5 },
    { t: 1200, cx: 0.70, cy: 0.5 }, { t: 1300, cx: 0.50, cy: 0.5 },
  ];
  const r = hoiInfer(pts, 1000, 1300, ZONES, ROI);
  ok('驻留不足不推断', !r.object && !r.dest, JSON.stringify(r));
}
// 空轨迹/无子区 → 空（v3.43 行为保持）
{
  ok('空轨迹返回空', Object.keys(hoiInfer([], 0, 1000, ZONES, ROI)).length === 0);
  ok('无子区返回空', Object.keys(hoiInfer(traj([[1000, 0.3, 0.5]]), 0, 2000, [], ROI)).length === 0);
}

console.log('\n--- alignSop（LCS 对齐五类输出） ---');
// 完美对齐
{
  const cands = [
    { id: 'c1', type: '拿取', start_ms: 0 },
    { id: 'c2', type: '装配', start_ms: 2000 },
    { id: 'c3', type: '放置', start_ms: 4000 },
  ];
  const steps = [{ verb: '拿取', object: '后横梁' }, { verb: '装配' }, { verb: '放置' }];
  const r = alignSop(cands, steps);
  ok('完美对齐 3/3', r.matched === 3 && r.missedSteps.length === 0, r.summary);
  ok('c1 命中第1步', r.byCand.get('c1')?.kind === 'match' && r.byCand.get('c1')?.stepIdx === 0);
  ok('摘要文案', /对齐 3\/3 步/.test(r.summary), r.summary);
}
// 漏步 + SOP 外 + 待分类
{
  const cands = [
    { id: 'c1', type: '拿取', start_ms: 0 },
    { id: 'c2', type: '其他', start_ms: 1500 },
    { id: 'c3', type: '目检', start_ms: 3000 },
  ];
  const steps = [{ verb: '拿取' }, { verb: '装配' }, { verb: '放置' }];
  const r = alignSop(cands, steps);
  ok('漏步 2（装配/放置）', r.missedSteps.length === 2 && r.missedSteps.includes(1) && r.missedSteps.includes(2), JSON.stringify(r.missedSteps));
  const c2 = r.byCand.get('c2');
  const c3 = r.byCand.get('c3');
  ok('其他=待分类不算异常', c2?.kind === 'unclassified', c2?.label);
  ok('目检=SOP 外动作', c3?.kind === 'extra' && /SOP 外动作「目检」/.test(c3.label), c3?.label);
}
// 重复/多段：同动词出现两次但 SOP 只有一步（LCS 只配一个，另一个标 dup）
{
  const cands = [
    { id: 'c1', type: '拿取', start_ms: 0 },
    { id: 'c2', type: '拿取', start_ms: 1500 },
  ];
  const r = alignSop(cands, [{ verb: '拿取' }]);
  const kinds = [...r.byCand.values()].map((x) => x.kind).sort();
  ok('一个 match 一个 dup', JSON.stringify(kinds) === JSON.stringify(['dup', 'match']), kinds.join(','));
}
// 顺序异常：LCS 保序——反序时只配到后段
{
  const cands = [
    { id: 'c1', type: '放置', start_ms: 0 },
    { id: 'c2', type: '拿取', start_ms: 2000 },
  ];
  const r = alignSop(cands, [{ verb: '拿取' }, { verb: '放置' }]);
  // 放置(c1) 在拿取(c2) 前：LCS 只能配 c1→放置(第2步) 或 c2→拿取(第1步) 之一? 保序下 c1↔放置(j=1) 与 c2 无法配（j 已过 0）
  ok('反序时漏步≥1（顺序异常以漏步/重复呈现，只提示）', r.matched === 1 && r.missedSteps.length >= 1, `matched=${r.matched} miss=${JSON.stringify(r.missedSteps)}`);
}
// 空输入
{
  ok('空候选', alignSop([], [{ verb: '拿取' }]).missedSteps.length === 1);
  ok('空步骤', alignSop([{ id: 'c1', type: '拿取', start_ms: 0 }], []).byCand.get('c1')?.kind === 'extra');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
