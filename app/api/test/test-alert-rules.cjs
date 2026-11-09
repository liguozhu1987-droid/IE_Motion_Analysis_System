/**
 * 告警规则纯函数离线单测（不连 DB、不起服务）：
 * 用 typescript.transpileModule 把 src/core/alert/alert-rules.ts 转译成 CJS 后 require 断言。
 * 覆盖：阈值口径（>=/>）、首轮基线不判错误率、边沿触发不重复、恢复、冷却期内抑制再发火、
 *       快照缺失不判定、样本不足不计错误率。
 * 跑法：cd app/api && node test/test-alert-rules.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ts = require('typescript');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'alert', 'alert-rules.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const tmp = path.join(os.tmpdir(), `alert-rules-${process.pid}.js`);
fs.writeFileSync(tmp, js);
const { tickRules } = require(tmp);
fs.unlinkSync(tmp);

const T = { loginLockedMax: 5, aiTaskBacklog: 50, errorRatePct: 1, errorMinRequests: 20 };
const blankFiring = { login_locked: false, ai_task_backlog: false, error_rate: false };
const blankLast = { login_locked: 0, ai_task_backlog: 0, error_rate: 0 };
const snap = (loginLocked, aiTaskPending, httpTotal, httpError) => ({ loginLocked, aiTaskPending, httpTotal, httpError });

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
const codes = (r) => r.events.map((e) => e.code);

// 1. 首轮（无 prevCounters）：错误率只建基线不判定；锁定/堆积正常判定
let t0 = 1_770_000_000_000; // 真实量级毫秒时间戳（必须远大于冷却时长，与 Date.now 同量级）
let r = tickRules({ snapshot: snap(6, 60, 100, 50), thresholds: T, prevCounters: null, firing: blankFiring, lastFireAt: blankLast, cooldownMs: 30 * 60_000, now: t0 });
ok(codes(r).length === 2 && codes(r).includes('login_locked') && codes(r).includes('ai_task_backlog'), '首轮 锁定6+堆积60 双发火');
ok(!codes(r).includes('error_rate'), '首轮 错误率只建基线不发火');

// 2. 阈值口径：锁定 =5 恰好达阈值发火；堆积 =50 恰好不发（文档口径 >50）
r = tickRules({ snapshot: snap(5, 50, 100, 0), thresholds: T, prevCounters: null, firing: blankFiring, lastFireAt: blankLast, cooldownMs: 30 * 60_000, now: t0 });
ok(codes(r).includes('login_locked'), '锁定=5 恰好发火(>=口径)');
ok(!codes(r).includes('ai_task_backlog'), '堆积=50 不发火(>口径)');

// 3. 错误率增量口径：样本足够且 5xx 占比 5% ≥1% → 发火；样本不足(<20)不判
t0 += 60_000;
r = tickRules({ snapshot: snap(0, 0, 200, 60), thresholds: T, prevCounters: { httpTotal: 100, httpError: 50 }, firing: blankFiring, lastFireAt: blankLast, cooldownMs: 30 * 60_000, now: t0 });
ok(codes(r).includes('error_rate') && r.windowErrorPct !== null && Math.abs(r.windowErrorPct - 10) < 1e-9, '窗口增量 10/100=10% 发火');
t0 += 60_000;
r = tickRules({ snapshot: snap(0, 0, 210, 60), thresholds: T, prevCounters: { httpTotal: 200, httpError: 60 }, firing: blankFiring, lastFireAt: blankLast, cooldownMs: 30 * 60_000, now: t0 });
ok(!codes(r).includes('error_rate') && r.windowErrorPct === null, '样本 10<20 不判定');

// 4. 边沿触发：条件持续为真不重复发火
let firing1 = r.nextFiring;
t0 += 60_000;
r = tickRules({ snapshot: snap(0, 0, 400, 100), thresholds: T, prevCounters: { httpTotal: 210, httpError: 60 }, firing: firing1, lastFireAt: { ...blankLast, error_rate: t0 - 120_000 }, cooldownMs: 30 * 60_000, now: t0 });
ok(!codes(r).includes('error_rate'), '已发火态下条件持续为真不重复发火');

// 5. 恢复：条件解除 → recovery 一条；冷却期内再次越限被抑制
t0 += 60_000;
r = tickRules({ snapshot: snap(0, 0, 500, 100), thresholds: T, prevCounters: { httpTotal: 400, httpError: 100 }, firing: { ...firing1, error_rate: true }, lastFireAt: { ...blankLast, error_rate: t0 - 60_000 }, cooldownMs: 30 * 60_000, now: t0 });
ok(r.recoveries.length === 1 && r.recoveries[0].code === 'error_rate' && !r.nextFiring.error_rate, '条件解除发恢复事件');
// 冷却期内再越限 → 静默抑制（不发火，也不置 firing——冷却期满由后续轮次补发）
t0 += 60_000;
r = tickRules({ snapshot: snap(0, 0, 600, 110), thresholds: T, prevCounters: { httpTotal: 500, httpError: 100 }, firing: r.nextFiring, lastFireAt: { ...blankLast, error_rate: t0 - 60_000 }, cooldownMs: 30 * 60_000, now: t0 });
ok(codes(r).includes('error_rate') === false && r.nextFiring.error_rate === false, '冷却期内再越限静默抑制不置位');
// 冷却期已过 → 再发火
t0 += 31 * 60_000;
r = tickRules({ snapshot: snap(0, 0, 700, 120), thresholds: T, prevCounters: { httpTotal: 600, httpError: 110 }, firing: r.nextFiring, lastFireAt: { ...blankLast, error_rate: t0 - 32 * 60_000 }, cooldownMs: 30 * 60_000, now: t0 });
ok(codes(r).includes('error_rate'), '冷却期已过再发火');

// 6. 快照缺失（DB 慢/异常）：不判定不恢复
r = tickRules({ snapshot: null, thresholds: T, prevCounters: { httpTotal: 700, httpError: 120 }, firing: { ...blankFiring, login_locked: true }, lastFireAt: blankLast, cooldownMs: 30 * 60_000, now: t0 });
ok(r.events.length === 0 && r.recoveries.length === 0 && r.nextFiring.login_locked === true, '快照缺失不判定不恢复');

// 7. 错误率 0% 不误报；锁定 0/堆积 0 不误报
t0 += 60_000;
r = tickRules({ snapshot: snap(0, 0, 800, 120), thresholds: T, prevCounters: { httpTotal: 700, httpError: 120 }, firing: blankFiring, lastFireAt: blankLast, cooldownMs: 30 * 60_000, now: t0 });
ok(r.events.length === 0, '全正常零发火');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
