/**
 * 描述联想（公司标准骨架）离线回归：零 DB、零浏览器。
 * 入口复用 v3.60 esbuild bundle；保证运行时 motion_standard.format → datalist 的映射一致。
 */
const path = require('path');
const { execSync } = require('child_process');
const BUILT = path.join(__dirname, 'test-v360-desc.built.cjs');
const ENTRY = path.join(__dirname, 'test-v360-desc-entry.mjs');
const esbuild = path.join(__dirname, '..', 'node_modules', '.bin', 'esbuild.CMD');
execSync(`"${esbuild}" "${ENTRY}" --bundle --platform=node --format=cjs --outfile="${BUILT}" --log-level=error "--define:import.meta.env={}"`, { stdio: 'inherit' });
const { motionFormatHint } = require(BUILT);
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };

ok(motionFormatHint({ type: '拿取', format: '拿取 +对象于 +位置 +距离' }) === '拿取 对象 于 位置 距离', '公司标准介词与字段顺序完整');
ok(motionFormatHint({ type: '粘贴', format: '粘贴 +对象至 +位置 +距离' }) === '粘贴 对象 至 位置 距离', '粘贴保留「至」介词');
ok(motionFormatHint({ type: '压', format: '压 +对象' }) === '压 对象', '单字段标准骨架');
ok(motionFormatHint({ type: '机器自动', format: null }) === null, '无标准格式不编造提示');
ok(motionFormatHint({ type: '其他', format: '' }) === null, '空格式不生成提示');
// 配置页改了字段名/介词后，提示应随 format 变化，不依赖内置词表
ok(motionFormatHint({ type: '拿取', format: '拿取 +物料向 +料架' }) === '拿取 物料 向 料架', '发布版格式即时驱动联想');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
