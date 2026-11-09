/**
 * 端到端链路验证（会创建临时工位并在结束时清理）：
 * 新建 → CSV导入 → 分析 → 开始复测 → 提交新版本 → 对比收益 → 清理
 * 用法：先 npm start，再 node scripts/e2e.js
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3001';
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH ?? path.join(appRoot, 'data', 'ie.db');
const STATION = 'L01-TEST';
let passed = 0;
let failed = 0;

async function call(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log(`✓ ${label}`); }
  else { failed += 1; console.log(`✗ ${label}`, detail ?? ''); }
}

function cleanup() {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare('DELETE FROM t_improvement WHERE station_id = ?').run(STATION);
  db.prepare('DELETE FROM t_element WHERE station_id = ?').run(STATION);
  db.prepare('DELETE FROM t_station WHERE station_id = ?').run(STATION);
  db.close();
}

try {
  cleanup(); // 确保干净起点

  const created = await call('POST', '/api/stations', { station_id: STATION, line_id: 'L01', name: '链路验证工位', TT: 12, updated_by: 'e2e' });
  check('新建工位', created.status === 200 && created.data.version === 1);

  const csv = [
    '序号,手别,类型,描述,时长s',
    '1,R,取放,取前壳,2.0',
    '2,B,搬运,搬料箱,3.0',
    '3,R,检验,重复确认外观,1.5',
    '4,L,持住,扶住件,2.5',
  ].join('\r\n');
  const imported = await call('POST', `/api/stations/${STATION}/import`, { csv });
  check('CSV 导入 4 要素', imported.status === 200 && imported.data.element_count === 4, JSON.stringify(imported.data).slice(0, 200));
  // 口径：要素级 std_time 各自四舍五入后求和 = 2.30+3.45+1.73+2.88
  check('导入后 CT=10.36', imported.data.ct === 10.36, imported.data.ct);

  const analysis = await call('GET', `/api/stations/${STATION}/analysis`);
  const wasteTypes = new Set(analysis.data.wastes.map((w) => w.waste));
  check('分析：检出 持住 与 搬运 浪费', wasteTypes.has('持住') && wasteTypes.has('搬运'), [...wasteTypes].join(','));
  check('“重复确认”触发 NVA 低置信度待复核', analysis.data.pending.some((p) => p.type === '检验'),
    JSON.stringify(analysis.data.pending?.map((p) => [p.type, p.va_effective])));

  const retest = await call('POST', `/api/stations/${STATION}/retest`, { user: 'e2e' });
  check('开始复测：封存v1，当前v2', retest.status === 200 && retest.data.version === 2 && retest.data.sealed_version === 1);

  const submitted = await call('POST', `/api/stations/${STATION}/elements/submit`, {
    bol_version: 2,
    cycle_count: 15,
    cv: 0.08,
    elements: [
      { seq: 1, start_ms: 0, dur_s: 1.8, hand: 'R', type: '取放', desc: '取前壳', va_class: 'NNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
      { seq: 2, start_ms: 1800, dur_s: 2.0, hand: 'R', type: '使用', desc: '装入壳体(治具夹持)', va_class: 'VA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
      { seq: 3, start_ms: 3800, dur_s: 1.0, hand: 'L', type: '检验', desc: '目视确认', va_class: 'NNVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
    ],
  });
  check('提交新版本 CT=5.52', submitted.status === 200 && submitted.data.ct === 5.52, JSON.stringify(submitted.data).slice(0, 200));

  const compare = await call('GET', `/api/stations/${STATION}/compare`);
  check('对比 ΔCT=4.84（10.36−5.52）', compare.status === 200 && compare.data.delta_ct === 4.84, compare.data.delta_ct);
  check('收益年化≈18549元', compare.data.benefit && Math.abs(compare.data.benefit.annual_yuan - 18549.3) < 1,
    compare.data.benefit?.annual_yuan);
  check('封存版本不可写（提交v1应409）',
    (await call('POST', `/api/stations/${STATION}/elements/submit`, { bol_version: 1, cycle_count: 15, cv: 0, elements: [] })).status === 409);

  const versions = await call('GET', `/api/stations/${STATION}/versions`);
  check('版本列表2条且v1封存', versions.data.versions.length === 2 && versions.data.versions.find((v) => v.version === 1).is_sealed);
} finally {
  cleanup();
  console.log('\n已清理临时工位');
}

console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
