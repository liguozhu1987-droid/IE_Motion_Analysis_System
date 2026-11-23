/**
 * MS1.6 / v3.66 离线回归：操作族/清洁/翻转/拆/等待 新增二字段 + 部位词表回归。
 * 运行：node test/ms16.test.cjs
 */
const { buildAndRequire, makeReporter } = require('./ms-harness.cjs');
const {
  parseFormat, buildPreview, parseDescToFields, reachOptionsFor, EYE_REACH, BODY_REACH,
} = buildAndRequire();
const { ok, done } = makeReporter();

// ---- MS1.6 操作族补 对象+数量 ----
const opFields = parseFormat('操作 +对象 +数量', '操作');
ok('操作 解析出 对象/数量', opFields.map(f=>f.name).join('/') === '对象/数量');

const anFields = parseFormat('按 +对象 +数量', '按');
ok('按 预览拼装正确', buildPreview('按', anFields, {对象:'启动按钮',数量:'2次'}, '手指') === '按 启动按钮 2次（手指）');
ok('按 反解析回填', (() => { const r = parseDescToFields('按 +对象 +数量', '按', '按 启动按钮 2次（手指）'); return r.values.对象 === '启动按钮' && r.values.数量 === '2次' && r.reach === '手指'; })());

// ---- 清洁：对象+范围 ----
const cleanFields = parseFormat('清洁 +对象 +范围', '清洁');
ok('清洁 解析出 对象/范围', cleanFields.map(f=>f.name).join('/') === '对象/范围');
ok('清洁 预览', buildPreview('清洁', cleanFields, {对象:'导轨',范围:'表面 20cm'}, '') === '清洁 导轨 表面 20cm');

// ---- 翻转：对象+正反（"方向"尾字"向"属 PREP 集合，会误切为 方→向，故用"正反"） ----
ok('翻转 正反字段', parseFormat('翻转 +对象 +正反','翻转')[1].name === '正反');
const fanBack = parseDescToFields('翻转 +对象 +正反', '翻转', '翻转 工件 正→反');
ok('翻转 反解析对象+正反', fanBack.values.对象 === '工件' && fanBack.values.正反 === '正→反', JSON.stringify(fanBack));

// ---- 拆：拆分复合字段 ----
const chaiFields = parseFormat('拆 +对象 +包装方式', '拆');
ok('拆 解析出 对象/包装方式', chaiFields.map(f=>f.name).join('/') === '对象/包装方式');
const chaiBack = parseDescToFields('拆 +对象 +包装方式', '拆', '拆 密封袋 热封口撕开');
ok('拆 反解析对象+包装方式', chaiBack.values.对象 === '密封袋' && chaiBack.values.包装方式 === '热封口撕开', JSON.stringify(chaiBack));

// ---- 等待：设备动作+原因 ----
const waitFields = parseFormat('等待 +设备动作 +原因', '等待');
ok('等待 解析出 设备动作/原因', waitFields.map(f=>f.name).join('/') === '设备动作/原因');
ok('等待 预览', buildPreview('等待', waitFields, {设备动作:'机械臂',原因:'节拍慢'}, '') === '等待 机械臂 节拍慢');

// ---- 部位词表回归（v3.65 不变） ----
ok('前臂在档位中', BODY_REACH.includes('前臂'));
ok('目检仍走眼/头/躯干', reachOptionsFor('目检').join('/') === EYE_REACH.join('/'));
ok('转身无部位行', reachOptionsFor('转身') === null);
ok('拿取 显示10档手臂+眼部', reachOptionsFor('拿取').length === 10);

done();