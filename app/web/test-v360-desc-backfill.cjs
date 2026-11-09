/**
 * v3.60 纯函数单测：motionStandard.parseDescToFields（desc 反向回填结构化字段）
 *
 * 不起浏览器、不连 API：TypeScript 转译 CJS 后直接断言（同 test-p2-unit.cjs 路径）。
 * 语料 = 2026-10-30 ST010（BJFA1/框架组装）真实落库 desc 全量 + 边界用例。
 * 背景：切换选中要素时结构化字段须从 desc 完整回填——多词对象（Dual lock）、
 * 无空格连写（滑轮支架至导轨安装孔）、逗号缀行程（，小臂）、单字段长描述不丢字。
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};

// 被测函数经 esbuild 从 motionStandard.ts（及其依赖链）打包为 CJS——
// Node 22 直跑 .ts 会按 ESM 判定（importSyncForRequire），require.extensions 钩子救不了，
// esbuild bundle 是最稳路径（build 产物 parse-test.built.mjs 同源，随手重打包保证一致）。
const { execSync } = require('child_process');
const BUILT = path.join(__dirname, 'test-v360-desc.built.cjs');
const ENTRY = path.join(__dirname, 'test-v360-desc-entry.mjs');
const esbuild = path.join(__dirname, '..', 'node_modules', '.bin', 'esbuild.CMD');
execSync(`"${esbuild}" "${ENTRY}" --bundle --platform=node --format=cjs --outfile="${BUILT}" --log-level=error "--define:import.meta.env={}"`, { stdio: 'inherit' });
const { parseDescToFields, parseFormat, buildPreview } = require(BUILT);

/** 与内置 motion_standard 对应的 format（测试用子集，与 config/rules/motion_standard.json 一致） */
const F = {
  '拿取': '拿取 +对象于 +位置 +距离', '放置': '放置 +对象至 +位置 +距离', '移物': '移物 +对象 +距离',
  '装配': '装配 +对象于 +位置 +距离', '粘贴': '粘贴 +对象至 +位置 +距离', '压': '压 +对象',
  '清洁': '清洁 +对象', '目检': '目检 +对象 +属性', '走动': '走动 +距离', '转身': '转身 +角度',
  '弯腰': '弯腰 +对象 +程度', '扫描': '扫描 +对象 +条码', '拆': '拆 +对象包装',
};

/** 断言解析结果与期望完全一致（期望里 null 的键=必须为空：undefined/''/null 都算空） */
function expectFields(type, desc, want) {
  const got = parseDescToFields(F[type] ?? null, type, desc);
  const empty = (v) => v == null || v === '';
  const problems = [];
  for (const [k, v] of Object.entries(want)) {
    if (k === 'reach') { if (got.reach !== v) problems.push(`reach: want ${JSON.stringify(v)} got ${JSON.stringify(got.reach)}`); continue; }
    const g = got.values[k];
    if (v == null) { if (!empty(g)) problems.push(`${k}: want 空 got ${JSON.stringify(g)}`); continue; }
    if (g !== v) problems.push(`${k}: want ${JSON.stringify(v)} got ${JSON.stringify(g)}`);
  }
  const wantKeys = Object.keys(want).filter((k) => k !== 'reach');
  for (const k of Object.keys(got.values)) {
    if (got.values[k] && !wantKeys.includes(k)) problems.push(`多余字段 ${k}=${JSON.stringify(got.values[k])}`);
  }
  ok(`[${type}] ${desc}`, problems.length === 0, problems.join('; '));
}

console.log('\n--- ST010 真实语料（20 条全量） ---');
expectFields('拿取', '拿取 左右导轨 于 物料箱（肩）', { 对象: '左右导轨', 位置: '物料箱', reach: '肩' });
expectFields('移物', '移物 左右导轨 2步', { 对象: '左右导轨', 距离: '2步' });
expectFields('放置', '放置 左右导轨 至 定位工装（小臂）', { 对象: '左右导轨', 位置: '定位工装', reach: '小臂' });
expectFields('拿取', '拿取 标签 于 标签纸 整理标签纸（大臂）', { 对象: '标签', 位置: '标签纸', 距离: '整理标签纸', reach: '大臂' });
expectFields('粘贴', '粘贴 标签 至 左导轨（小臂）', { 对象: '标签', 位置: '左导轨', reach: '小臂' });
expectFields('拿取', '拿取 无尘纸 于 物料盒（大臂）', { 对象: '无尘纸', 位置: '物料盒', reach: '大臂' });
expectFields('清洁', '清洁 左导轨表面，全厂（大臂）', { 对象: '左导轨表面，全厂', reach: '大臂' });
expectFields('清洁', '清洁 右导轨表面，全长（大臂）', { 对象: '右导轨表面，全长', reach: '大臂' });
expectFields('放置', '放置 无尘纸 至 垃圾桶（大臂）', { 对象: '无尘纸', 位置: '垃圾桶', reach: '大臂' });
expectFields('拿取', '拿取 Dual lock 于 物料盒（大臂）', { 对象: 'Dual lock', 位置: '物料盒', reach: '大臂' });
expectFields('粘贴', '粘贴 Dual lock 至 左右导轨 8个（大臂）', { 对象: 'Dual lock', 位置: '左右导轨', 距离: '8个', reach: '大臂' });
expectFields('拿取', '拿取', { 对象: null, 位置: null, 距离: null });
expectFields('压', '压 导轨上的dual locks，共8个（大臂）', { 对象: '导轨上的dual locks，共8个', reach: '大臂' });
expectFields('拿取', '拿取 滑轮支架 于 物料盒（大臂）', { 对象: '滑轮支架', 位置: '物料盒', reach: '大臂' });
expectFields('装配', '装配 滑轮支架至导轨安装孔，小臂', { 对象: '滑轮支架', 位置: '导轨安装孔', reach: '小臂' });
expectFields('拿取', '拿取 辅助工具 于 工具盒（大臂）', { 对象: '辅助工具', 位置: '工具盒', reach: '大臂' });
expectFields('压', '压 辅助工具安装滑轮架至导轨', { 对象: '辅助工具安装滑轮架至导轨' });
expectFields('装配', '装配 滑轮支架 于 导轨（大臂）', { 对象: '滑轮支架', 位置: '导轨', reach: '大臂' });

console.log('\n--- 其他类型 + 边界 ---');
expectFields('目检', '目检 后横梁 划伤', { 对象: '后横梁', 属性: '划伤' });
expectFields('走动', '走动 2步', { 距离: '2步' });
expectFields('拿取', '拿取 后横梁 于 料箱（大臂）[VA改判|RNVA|VA|装入产品|张三|2026-10-30]', { 对象: '后横梁', 位置: '料箱', reach: '大臂' });
expectFields('转身', '转身 90°', { 角度: '90°' });
expectFields('弯腰', '弯腰 料箱 浅弯', { 对象: '料箱', 程度: '浅弯' });
expectFields('扫描', '扫描 后横梁 条码123', { 对象: '后横梁', 条码: '条码123' });
expectFields('拆', '拆 包装纸箱', { 对象包装: '包装纸箱' });
expectFields('拿取', '拿取 （大臂）', { reach: '大臂' }); // 无对象但有行程：对象留空
expectFields('拿取', '手写一句没有类型词的描述', { 对象: null, 位置: null, 距离: null }); // 非标准描述不猜字段
expectFields('拿取', '', { 对象: null, 位置: null, 距离: null });

console.log('\n--- 往返一致性：parse → buildPreview ≥ 原语义（值域内 round-trip） ---');
// 标准写法 round-trip 后应与原 desc 一致（行程括号回缀）
{
  const pairs = [
    ['拿取', '拿取 左右导轨 于 物料箱（肩）'],
    ['放置', '放置 无尘纸 至 垃圾桶（大臂）'],
    ['装配', '装配 滑轮支架 于 导轨（大臂）'],
  ];
  for (const [type, desc] of pairs) {
    const { values, reach } = parseDescToFields(F[type], type, desc);
    const fields = parseFormat(F[type], type);
    const back = buildPreview(type, fields, values, reach);
    ok(`round-trip ${desc}`, back === desc, `got ${JSON.stringify(back)}`);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
