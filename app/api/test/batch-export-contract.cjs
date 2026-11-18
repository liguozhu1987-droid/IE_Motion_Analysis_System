/**
 * 批量导出 · 工作簿离线契约（v3.61）
 * ------------------------------------------------------------
 * 不依赖 DB / 不启动 API：直接驱动编译产物 workbook.ts 生成 XLSX，
 * 再用 exceljs 读回断言结构、四类时间互斥、焦点表与版式。
 * 与真实 HTTP 端点测试互补：本脚本管「生成得对不对」，端点测试管「取数与权限对不对」。
 *
 *   cd app/api && npx tsc -p tsconfig.json --outDir dist && node test/batch-export-contract.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const ExcelJS = require('exceljs');

const DIST = path.resolve(__dirname, '..', 'dist', 'src', 'modules', 'batch-export');
const { buildWorkbook, SHEETS } = require(path.join(DIST, 'workbook.js'));
const { bucketOf, bucketTable, makeBucketResolver } = require(path.join(DIST, 'time-buckets.js'));

let passed = 0;
const ok = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const el = (o) => ({
  element_id: o.id, seq: o.seq, start_ms: o.start_ms ?? 0, dur_s: o.dur ?? 1,
  hand: o.hand ?? 'R', type: o.type ?? '装配', desc: o.desc ?? '装配外壳于工位',
  va_class: o.va ?? 'VA', va_effective: o.va ?? 'VA',
  rating: 1, allowance: 0.15, std_time: o.st ?? 1,
  outlier_flag: o.outlier ?? 0, outlier_reason: o.outlier ? '读数异常' : null,
  bol_version: 1,
});

function makeModel(withFocus = true, task = null, resolver = undefined) {
  const e1 = [
    el({ id: 'S1-E1', seq: 1, st: 2.30, type: '装配', va: 'VA', desc: '装配外壳于工装' }),
    el({ id: 'S1-E2', seq: 2, st: 1.20, type: '机器自动', va: 'RNVA', desc: '设备自动压合' }),
    el({ id: 'S1-E3', seq: 3, st: 0.80, type: '移物', va: 'VA', desc: '移物料架至工位' }),
    el({ id: 'S1-E4', seq: 4, st: 0.50, type: '等待', va: 'NVA', desc: '等待设备复位' }),
    el({ id: 'S1-E5', seq: 5, st: 9.99, type: '持住', va: 'NVA', desc: '异常读数', outlier: 1 }),
  ];
  const e2 = [
    el({ id: 'S2-E1', seq: 1, st: 3.10, type: '检查', va: 'RNVA', desc: '目检外观' }),
    el({ id: 'S2-E2', seq: 2, st: 1.40, type: '走动', va: 'NVA', desc: '走动取料' }),
  ];
  const mk = (id, name, list, ct, buckets, focusIds) => ({
    stationId: id, stationName: name, version: 1,
    elements: list, classified: list, active: list.filter((x) => Number(x.outlier_flag) === 0),
    metrics: { ct, tt: 60, element_count: list.filter((x) => !x.outlier_flag).length,
      va: 2.3, rnva: 1.2, nva: 1.3, va_pct: 47.9, nva_pct: 27.1, outlier_count: 1, outlier_s: 9.99 },
    wastes: [], buckets, focusIds: new Set(focusIds), isBottleneck: id === 'L01-ST01',
    fallbackPct: 0,
  });
  const stations = [
    mk('L01-ST01', '前保险杠预装', e1, 4.80,
      { manual: 2.30, machine: 1.20, walk: 0.80, wait: 0.50 }, ['S1-E2', 'S1-E4']),
    // focusIds 必须与 04 表行一一对应：本例焦点只落在 ST01
    mk('L01-ST02', '后保险杠预装', e2, 4.50,
      { manual: 3.10, machine: 0, walk: 1.40, wait: 0 }, []),
  ];
  const focus = [
    { elementId: 'S1-E2', stationId: 'L01-ST01', seq: 2, desc: '设备自动压合', vaLabel: '必要非增值(RNVA)',
      stdTime: 1.20, waste: '等待', ecrs: '重排', measure: '重叠内外时间（人机并行）', compressible: 0.6, potential: 0.6, ctPct: 25 },
    { elementId: 'S1-E4', stationId: 'L01-ST01', seq: 4, desc: '等待设备复位', vaLabel: '非增值(NVA)',
      stdTime: 0.50, waste: '等待', ecrs: '取消', measure: '快换/SMED 缩短换型等待', compressible: 0.25, potential: 0.25, ctPct: 10.4 },
  ];
  return {
    meta: {
      lineId: 'L01', lineName: '示例装配线', company: '示例公司', region: '华东',
      productProject: 'P-2026-018', processType: '装配',
      scopeNote: task
        ? `一个工作簿 = 一个分解任务（${task.taskNo} · ${task.periodStart}~${task.periodEnd}）`
        : '按产线的兼容模式：可见工位 × 各工位当前生效版本',
      taskId: task?.taskNo ?? null,
      taskNo: task?.taskNo ?? null,
      taskName: task?.taskName ?? null,
      periodStart: task?.periodStart ?? '',
      periodEnd: task?.periodEnd ?? '',
      roundType: task?.roundType ?? null,
      taskStatus: task?.taskStatus ?? null,
      exportedAt: new Date('2026-11-09T08:30:00+08:00'), exporter: '测试员',
      ruleVersions: { va_rules: 'RV3.64', waste_triggers: 'RV1.4', ecrsa_map: 'RV1.1', motion_standard: 'MS1.4' },
      stationCount: 2, decomposedCount: 2, elementCount: 7, activeElementCount: 6, focusCount: 2,
    },
    totals: { ct: 9.30, tt: 60, balanceRate: 96.9, va: 4.6, rnva: 2.4, nva: 2.3,
      vaPct: 49.5, nvaPct: 24.7, manual: 5.40, machine: 1.20, walk: 2.20, wait: 0.50,
      outlierCount: 1, operatorVaPct: 56.8 },
    stations, focus: withFocus ? focus : [],
    options: { includeOutliers: true, includeUndecomposed: false, withFocus, focusTop: 30 },
    bucketResolver: resolver,
    bucketTable: bucketTable(['装配', '机器自动', '移物', '等待', '检查', '走动', '持住'], resolver),
  };
}

async function main() {
  console.log('批量导出工作簿离线契约');

  ok('类型→时间桶：机器/走动/等待/回落 manual', () => {
    assert.equal(bucketOf('机器自动'), 'machine');
    assert.equal(bucketOf('移物'), 'walk');
    assert.equal(bucketOf('走动'), 'walk');
    assert.equal(bucketOf('可避免延迟'), 'wait');
    assert.equal(bucketOf('休息'), 'wait');
    assert.equal(bucketOf('转身'), 'manual');
    assert.equal(bucketOf('持住'), 'manual');
    assert.equal(bucketOf('未知类型XYZ'), 'manual');
  });

  const table = bucketTable(['装配', '机器自动', '移物', '等待', '检查']);
  ok('映射表覆盖机器/走动/等待，其余回落 manual 且可枚举', () => {
    // bucketTable 会把「显式归桶但当前规则集词表未列出」的类型也补进说明页，保证映射可审计
    assert.ok(table.groups.machine.includes('机器自动'));
    assert.ok(table.groups.walk.includes('移物') && table.groups.walk.includes('走动'));
    assert.ok(table.groups.wait.includes('等待') && table.groups.wait.includes('休息'));
    assert.ok(table.groups.manual.includes('装配') && table.groups.manual.includes('检查'));
    assert.ok(table.fallback.includes('装配'));
  });

  const buf = await buildWorkbook(makeModel(true));
  ok('生成结果为 ZIP(XLSX) 二进制且非空', () => {
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 4000, `文件过小: ${buf.length}`);
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  ok('恰好 6 张 sheet，名称固定、无非法字符、无 ~n 去重', () => {
    assert.equal(wb.worksheets.length, 6);
    assert.deepEqual(wb.worksheets.map((w) => w.name), [...SHEETS]);
    for (const w of wb.worksheets) {
      assert.ok(w.name.length <= 31);
      assert.ok(!/[\\\/?*\[\]:]/.test(w.name));
    }
  });

  const sheet = (name) => wb.getWorksheet(name);

  ok('01 表 14 列、合计行 ΣCT 与封面一致', () => {
    const ws = sheet('01_工位汇总');
    assert.deepEqual(ws.getRow(4).values.slice(1), [
      '工位编码', '工位名称', '版本', '要素数', 'CT(s)', 'TT(s)', 'CT−TT(s)', 'VA%',
      'RNVA(s)', 'NVA(s)', '机器(s)', '走动(s)', '等待(s)', '标记',
    ]);
    assert.equal(Number(ws.getCell(7, 5).value), 9.30);
  });

  ok('02 表 11 列、异常要素标灰保留且不计入合计', () => {
    const ws = sheet('02_动作分解');
    assert.equal(ws.getRow(4).values.length - 1, 11);
    assert.equal(ws.getCell(5, 11).value, null);
    assert.ok(String(ws.getCell(9, 11).value).startsWith('异常'));
  });

  ok('03 表 12 列、四类时间独立成列且每有效要素恰一桶有值', () => {
    const ws = sheet('03_增值非增值分析');
    assert.equal(ws.getRow(4).values.length - 1, 12);
    assert.deepEqual(ws.getRow(4).values.slice(5, 9), ['手作业(s)', '机器(s)', '走动(s)', '等待(s)']);
    let checked = 0;
    for (let r = 5; r <= 12; r += 1) {
      const station = ws.getCell(r, 1).value;
      if (typeof station !== 'string' || station.includes('小计') || station.includes('合计')) continue;
      const four = [5, 6, 7, 8].map((c) => ws.getCell(r, c).value);
      const filled = four.filter((v) => v !== null && v !== undefined);
      // 有效要素恰一桶；异常要素四桶留空
      const isOutlier = String(ws.getCell(r, 12).value ?? '').includes('异常');
      assert.equal(filled.length, isOutlier ? 0 : 1, `第 ${r} 行四桶数量异常`);
      if (!isOutlier) {
        assert.equal(Number(filled[0]), Number(ws.getCell(r, 9).value), `第 ${r} 行 E+F+G+H ≠ ST`);
        checked += 1;
      }
    }
    assert.equal(checked, 6);
  });

  ok('03 表 ★ 与 04 表行一一对应', () => {
    const ws = sheet('03_增值非增值分析');
    const stars = [];
    for (let r = 5; r <= 12; r += 1) if (ws.getCell(r, 11).value === '★') stars.push([ws.getCell(r, 1).value, ws.getCell(r, 2).value]);
    const f = sheet('04_动作分析');
    const rows = [];
    for (let r = 5; r <= 8; r += 1) {
      const v = f.getCell(r, 1).value;
      // 表尾免责说明行的 A 列是长文本，不是工位编码
      if (typeof v === 'string' && /^L\d{2}-ST\d{2}$/.test(v)) rows.push([v, f.getCell(r, 2).value]);
    }
    assert.deepEqual(stars.sort(), rows.sort());
  });

  ok('04 表 ≤9 列、措施 ≤24 字、按改善潜力降序、不含异常要素', () => {
    const ws = sheet('04_动作分析');
    assert.equal(ws.getRow(4).values.length - 1, 9);
    assert.equal(ws.getCell(5, 1).value, 'L01-ST01');
    assert.ok(Number(ws.getCell(5, 5).value) >= Number(ws.getCell(6, 5).value));
    assert.ok(String(ws.getCell(5, 8).value).length <= 24);
    assert.ok(String(ws.getCell(6, 8).value).length <= 24);
  });

  ok('版式：冻结 B5 / 表头筛选 / A4 横向 / 重复第 4 行', () => {
    const ws = sheet('03_增值非增值分析');
    assert.equal(ws.views[0].state, 'frozen');
    assert.equal(ws.views[0].ySplit, 4);
    assert.equal(ws.views[0].xSplit, 1);
    assert.equal(ws.views[0].topLeftCell, 'B5');
    // exceljs 读回时 autoFilter 归一化为 A1 引用字符串（写入时是 {from,to} 对象）
    assert.equal(String(ws.autoFilter), 'A4:L4');
    assert.equal(ws.pageSetup.orientation, 'landscape');
    assert.equal(ws.pageSetup.fitToWidth, 1);
    assert.equal(ws.pageSetup.printTitlesRow, '4:4');
  });

  ok('封面（兼容模式）：如实标注未指定分解任务，索引超链接指向真实 sheet', () => {
    const ws = sheet('00_封面');
    assert.ok(String(ws.getCell(7, 2).value).includes('未指定分解任务'));
    assert.ok(String(ws.getCell(8, 2).value).includes('未启用'));
    const link = ws.getCell(28, 1).value;
    assert.ok(link && typeof link === 'object' && String(link.hyperlink).includes('01_工位汇总'));
  });

  /* ── Phase 2：规则集 time_bucket 配置化 + 任务维度的封面/信息区 ── */
  const fakeMs = {
    rv: 'MS1.4',
    groups: [
      { level1: '机器自动', time_bucket: 'walk', subs: [] },
      { level1: '常规', time_bucket: 'manual', subs: [{ type: '装配', time_bucket: 'machine' }] },
    ],
  };
  const resolver = makeBucketResolver(fakeMs);
  ok('MS1.4 规则集 time_bucket 优先于内置映射，非法值回落内置', () => {
    assert.equal(resolver('机器自动'), 'walk', '规则集应覆盖内置 machine');
    assert.equal(resolver('装配'), 'machine', '二级类型配置应生效');
    assert.equal(resolver('移物'), 'walk', '未配置类型走内置 44 类兜底');
    assert.equal(resolver('转身'), 'manual', '其余回落 manual');
    const bad = makeBucketResolver({ groups: [{ level1: '走动', time_bucket: 'nonsense', subs: [] }] });
    assert.equal(bad('走动'), 'walk', '非法 time_bucket 不应污染判定');
  });

  ok('bucketTable 区分规则集配置 / 内置兜底 / 回落清单（99_说明可审计）', () => {
    const t = bucketTable(['装配', '机器自动', '移物', '等待', '检查'], resolver);
    assert.ok(t.ruleConfigured.includes('装配') && t.ruleConfigured.includes('机器自动'));
    assert.ok(t.builtin.includes('移物') && t.builtin.includes('等待'));
    assert.ok(t.fallback.includes('检查'));
    assert.ok(t.groups.walk.includes('机器自动'), '规则集改桶后应落到 walk 组');
  });

  const taskBuf = await buildWorkbook(makeModel(true, {
    taskNo: 'DT-2026-011', taskName: '2026 Q4 线平衡改善',
    periodStart: '2026-10-08', periodEnd: '2026-10-12',
    roundType: 'kaizen_after', taskStatus: 'active',
  }, resolver));
  const taskWb = new ExcelJS.Workbook();
  await taskWb.xlsx.load(taskBuf);
  ok('任务模式：封面 + 每个 sheet 信息区同时带任务号与时间段', () => {
    const cover = taskWb.getWorksheet('00_封面');
    assert.ok(String(cover.getCell(7, 2).value).includes('DT-2026-011'));
    assert.ok(String(cover.getCell(8, 2).value).includes('2026-10-08') && String(cover.getCell(8, 2).value).includes('2026-10-12'));
    // 01~04 走 setupSheet 的统一信息行；99_说明 是自由布局，任务号在「导出范围」行
    for (const name of SHEETS.slice(1, 5)) {
      const ws = taskWb.getWorksheet(name);
      assert.ok(String(ws.getCell(2, 1).value).includes('DT-2026-011'), `${name} 表头缺任务号`);
      assert.ok(String(ws.getCell(2, 1).value).includes('2026-10-08~2026-10-12'), `${name} 表头缺时间段`);
    }
    const notes = taskWb.getWorksheet('99_说明');
    const cells = [];
    notes.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? ''))));
    const text = cells.join('\n');
    assert.ok(text.includes('DT-2026-011') && text.includes('2026-10-08~2026-10-12'), '99_说明 导出范围缺任务号/时间段');
  });

  ok('任务模式：改规则集 time_bucket 后 03 表四类时间列随之互换（合计不变）', () => {
    const ws = taskWb.getWorksheet('03_增值非增值分析');
    // E=manual F=machine G=walk H=wait；第 5 行起为要素行，找 type=机器自动 的那行（序号 2）
    let found = false;
    for (let r = 5; r <= 20; r += 1) {
      if (Number(ws.getCell(r, 2).value) !== 2) continue;
      const machine = Number(ws.getCell(r, 6).value ?? 0);
      const walk = Number(ws.getCell(r, 7).value ?? 0);
      assert.equal(machine, 0, '规则集把机器自动配成 walk 后 machine 列应为空');
      assert.ok(walk > 0, 'walk 列应承接该要素 ST');
      found = true;
    }
    assert.ok(found, '未找到序号 2 的要素行');
    const notes = taskWb.getWorksheet('99_说明');
    const all = [];
    notes.eachRow((row) => row.eachCell((c) => all.push(String(c.value ?? ''))));
    assert.ok(all.join('\n').includes('motion_standard 规则集配置'), '说明页应声明判定入口为规则集');
  });

  ok('99_说明：口径声明写明非 REFA / 非 MTM、不可回导、移物同名词风险', () => {
    const ws = sheet('99_说明');
    const all = [];
    ws.eachRow((row) => row.eachCell((c) => all.push(String(c.value ?? ''))));
    const text = all.join('\n');
    for (const kw of ['不是 REFA', '不得冒充 MTM-1', '不可回导', 'Walk time 会高估', '单循环要素分解汇总表']) {
      assert.ok(text.includes(kw), `缺少口径声明: ${kw}`);
    }
  });

  const bufNoFocus = await buildWorkbook(makeModel(false));
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(bufNoFocus);
  ok('关闭 04 表时恰好 5 张 sheet 且仍保留其余 5 张', () => {
    assert.equal(wb2.worksheets.length, 5);
    assert.deepEqual(wb2.worksheets.map((w) => w.name),
      ['00_封面', '01_工位汇总', '02_动作分解', '03_增值非增值分析', '99_说明']);
  });

  console.log(`\n通过 ${passed} 项`);
  if (process.exitCode) console.error('存在失败项');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
