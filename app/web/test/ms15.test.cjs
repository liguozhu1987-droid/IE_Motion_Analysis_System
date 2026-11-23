/**
 * MS1.5 / v3.65 离线回归：新描述格式 + 部位词表（零 DB、零浏览器）。
 * 运行：node test/ms15.test.cjs
 */
const { buildAndRequire, makeReporter } = require('./ms-harness.cjs');
const {
  parseFormat, buildPreview, parseDescToFields, motionFormatHint,
  reachOptionsFor, BODY_REACH, EYE_REACH, REACH_LEGACY,
} = buildAndRequire();
const { ok, done } = makeReporter();

// ---- MS1.5 三类新描述格式 ----
const checkFields = parseFormat('检查 +对象 +属性 +工具', '检查');
ok('检查 解析出 对象/属性/工具 三字段', checkFields.map((f) => f.name).join('/') === '对象/属性/工具', JSON.stringify(checkFields));
ok('检查 预览拼装正确', buildPreview('检查', checkFields, { 对象: '焊缝', 属性: '无气孔', 工具: '放大镜' }, '眼') === '检查 焊缝 无气孔 放大镜（眼）');
const checkBack = parseDescToFields('检查 +对象 +属性 +工具', '检查', '检查 焊缝 无气孔 放大镜（眼）');
ok('检查 反解析回填三字段+部位', checkBack.values.对象 === '焊缝' && checkBack.values.属性 === '无气孔' && checkBack.values.工具 === '放大镜' && checkBack.reach === '眼', JSON.stringify(checkBack));

const moveFields = parseFormat('移动 +对象 +距离', '移动');
ok('移动 距离字段按步数分段（非 mm）', moveFields[1].name === '距离' && moveFields[1].kind === 'steps', JSON.stringify(moveFields));
const moveBack = parseDescToFields('移动 +对象 +距离', '移动', '移动 料箱 2步');
ok('移动 反解析对象+步数', moveBack.values.对象 === '料箱' && moveBack.values.距离 === '2步', JSON.stringify(moveBack));

ok('机器自动 单字段 设备动作', parseFormat('机器自动 +设备动作', '机器自动')[0]?.name === '设备动作');
ok('机器自动 标准骨架不再为空', motionFormatHint({ type: '机器自动', format: '机器自动 +设备动作' }) === '机器自动 设备动作');

// ---- 部位词表 v3.65 ----
ok('手臂档含 前臂 不含 小臂', BODY_REACH.includes('前臂') && !BODY_REACH.includes('小臂'));
ok('新增 躯干/眼/头/腿/脚', ['躯干', '眼', '头', '腿', '脚'].every((p) => BODY_REACH.includes(p)));
ok('历史别名 小臂 保留在反解析全集', REACH_LEGACY.includes('小臂'));
const legacy = parseDescToFields('拿取 +对象于 +位置 +距离', '拿取', '拿取 前横梁 于 料箱 150（小臂）');
ok('旧描述「（小臂）」仍可反解析且归一为前臂', legacy.reach === '前臂' && legacy.values.对象 === '前横梁', JSON.stringify(legacy));
const newForearm = parseDescToFields('拿取 +对象于 +位置 +距离', '拿取', '拿取 前横梁 于 料箱 150（前臂）');
ok('新描述「（前臂）」可反解析出行程', newForearm.reach === '前臂', JSON.stringify(newForearm));

ok('拿取 显示手臂档（含前臂/躯干）', (reachOptionsFor('拿取') || []).join('/') === '手指/手腕/前臂/大臂/肩/躯干/眼/头/腿/脚');
ok('目检 显示目视档（眼/头/躯干）', (reachOptionsFor('目检') || []).join('/') === EYE_REACH.join('/'));
ok('转身 不显示部位档', reachOptionsFor('转身') === null);

done();