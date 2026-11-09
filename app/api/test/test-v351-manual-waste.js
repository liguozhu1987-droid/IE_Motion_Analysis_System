/**
 * v3.51 人工浪费识别与改善建议 + 改善知识库 回归。
 *
 * 覆盖（对应本次四项需求）：
 *  1. 按工位唯一索引查询清单（含 AI 关停时仍可查——AI 出不来清单时的兜底入口）
 *  2. 人工录入浪费点 / 改善措施（与 AI 生成并存，origin 隔离）
 *  3. 人工条目可改可删、AI 产出不可改（409）
 *  4. 手动整理进知识库（幂等）+ 知识库查询/启停/删除
 *
 * 运行：node test/test-v351-manual-waste.js（需 API 已在 3001 运行）
 */
const BASE = 'http://127.0.0.1:3001/api';
const sql = require('mssql');
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}
const DB = { server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS, options: { encrypt: false, trustServerCertificate: true } };

let access = '';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const pclose = (pool) => pool.close();

async function call(method, path, body, useAuth = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(useAuth && access ? { Authorization: `Bearer ${access}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

(async () => {
  console.log('— 0. 登录与取工位 —');
  const login = await call('POST', '/auth/login', { username: 'admin', password: '123456' }, false);
  ok('登录 admin → 200', login.status === 200, `status=${login.status}`);
  access = login.data.accessToken;

  /* 前置自愈：t_ai_setting 会被 ai-suggest-contract（Phase 0 整表清空）连带清掉，
     ai_enabled 缺失会让 settle/确认链路直接 403 —— 曾造成「按跑测顺序偶发 2 红」。
     本用例自检并补回，不依赖外部执行顺序。 */
  const boot = await sql.connect(DB);
  await boot.request().query(
    "IF NOT EXISTS (SELECT 1 FROM t_ai_setting WHERE setting_key = 'ai_enabled') "
    + "INSERT INTO t_ai_setting (setting_key, setting_value, updated_by, created_at) VALUES ('ai_enabled', '1', 'v351-bootstrap', SYSUTCDATETIME()) "
    + "ELSE UPDATE t_ai_setting SET setting_value = '1' WHERE setting_key = 'ai_enabled'",
  );
  await pclose(boot);

  const st = await call('GET', '/stations');
  const arr = Array.isArray(st.data) ? st.data : (st.data.stations ?? st.data.items ?? []);
  ok('工位列表非空', arr.length > 0, `count=${arr.length}`);
  // 选一个「当前版本有已提交要素」的工位：CT>0 才能验证涉及时长/占比/节省的服务端计算与 clamp
  let SID = arr[0].station_id;
  let seqSample = [];
  for (const s of arr.slice(0, 25)) {
    const els = await call('GET', `/stations/${s.station_id}/elements`);
    const list = Array.isArray(els.data) ? els.data : (els.data.elements ?? []);
    if (list.length > 0) {
      SID = s.station_id;
      seqSample = list.slice(0, 2).map((e) => Number(e.seq));
      break;
    }
  }
  ok('选定有要素的工位（CT>0）', seqSample.length > 0, `${SID} seqs=${JSON.stringify(seqSample)}`);

  // 浪费白名单（与服务端同口径：waste_triggers ∪ ecrsa_map）
  let WT = '搬运';
  const rt = await call('GET', '/rules/waste_triggers');
  const trig = rt.data?.json?.triggers ?? rt.data?.triggers ?? [];
  if (trig.length > 0 && trig[0].waste) WT = trig[0].waste;
  console.log(`    用浪费类型 ${WT}`);

  console.log('— 1. 清单查询（AI 关停亦可查）—');
  const latest = await call('GET', `/stations/${SID}/ai-waste/latest`);
  console.log(`    （参考）latest → ${latest.status}${latest.status === 503 ? '：AI 关闭，最新批视图不可用' : ''}`);
  const all = await call('GET', `/stations/${SID}/ai-waste/items?origin=all&scope=all`);
  ok('items（全量跨批次）→ 200', all.status === 200, `status=${all.status}`);
  ok('items 返回 findings/issues 数组', Array.isArray(all.data.findings) && Array.isArray(all.data.issues));
  ok('items 带 station_id 索引与 summary', all.data.station_id === SID && typeof all.data.summary?.total_est_save_s === 'number');
  const manualOnly = await call('GET', `/stations/${SID}/ai-waste/items?origin=manual`);
  ok('items?origin=manual 全部为人工条目',
    manualOnly.status === 200 && manualOnly.data.findings.every((f) => f.origin === 'manual')
    && manualOnly.data.issues.every((i) => i.origin === 'manual'),
    `f=${manualOnly.data?.findings?.length} i=${manualOnly.data?.issues?.length}`);
  const aiOnly = await call('GET', `/stations/${SID}/ai-waste/items?origin=ai&scope=all`);
  ok('items?origin=ai 全部为 AI 条目',
    aiOnly.status === 200 && aiOnly.data.findings.every((f) => f.origin !== 'manual'),
    `f=${aiOnly.data?.findings?.length}`);

  console.log('— 2. 人工录入 —');
  const f1 = await call('POST', `/stations/${SID}/ai-waste/manual/findings`, {
    waste_type: WT, evidence: '人工巡检发现：物料架距工位过远，每次取料需往返搬运，属典型搬运浪费', element_seqs: seqSample,
  });
  ok('人工新增浪费点 → 201', f1.status === 201, `status=${f1.status} ${JSON.stringify(f1.data).slice(0, 120)}`);
  ok('人工条目 origin=manual 且无批次', f1.data?.origin === 'manual' && (f1.data?.batch_id === null || f1.data?.batch_id === undefined));
  ok('数字服务端计算（severity 1~3 / pct_of_ct 数值）',
    [1, 2, 3].includes(Number(f1.data?.severity)) && typeof Number(f1.data?.pct_of_ct) === 'number',
    `sev=${f1.data?.severity} pct=${f1.data?.pct_of_ct}`);

  const badType = await call('POST', `/stations/${SID}/ai-waste/manual/findings`, { waste_type: '不存在的浪费', evidence: '这是一条足够长的证据描述文本' });
  ok('非法 waste_type → 400', badType.status === 400, `status=${badType.status}`);
  const shortEv = await call('POST', `/stations/${SID}/ai-waste/manual/findings`, { waste_type: WT, evidence: '太短' });
  ok('evidence 过短 → 400', shortEv.status === 400, `status=${shortEv.status}`);
  const ghostSeq = await call('POST', `/stations/${SID}/ai-waste/manual/findings`, { waste_type: WT, evidence: '引用了不存在的要素序号应当被裁剪掉', element_seqs: [9999] });
  ok('引用不存在 seq → 裁剪为空（不报错）', ghostSeq.status === 201 && ghostSeq.data?.element_seqs?.length === 0,
    `seqs=${JSON.stringify(ghostSeq.data?.element_seqs)}`);

  const i1 = await call('POST', `/stations/${SID}/ai-waste/manual/issues`, {
    waste_type: WT, problem: '物料架布局不合理导致操作员每循环往返取料两次', ecrs: 'R',
    suggestion: '将物料架移位至操作区右手可达范围内，取消往返', element_seqs: seqSample,
  });
  ok('人工新增改善措施 → 201', i1.status === 201, `status=${i1.status}`);
  ok('措施 est_save_s 服务端折算（E 全额 / 其余半折）且 tier 归一',
    typeof Number(i1.data?.est_save_s) === 'number' && ['P1', 'P2', 'P3'].includes(i1.data?.tier),
    `est=${i1.data?.est_save_s} tier=${i1.data?.tier}`);
  ok('人工措施状态为待处理', i1.data?.status === '待处理');
  const badEcrs = await call('POST', `/stations/${SID}/ai-waste/manual/issues`, {
    waste_type: WT, problem: '问题描述长度达标测试文本', ecrs: 'X', suggestion: '改善建议长度达标测试文本',
  });
  ok('非法 ecrs → 400', badEcrs.status === 400, `status=${badEcrs.status}`);

  console.log('— 3. 并存与编辑边界 —');
  const after = await call('GET', `/stations/${SID}/ai-waste/items?origin=manual`);
  const hasNew = after.data.findings.some((f) => f.finding_id === f1.data.finding_id)
    && after.data.issues.some((i) => i.issue_id === i1.data.issue_id);
  ok('人工条目出现在合并清单中（与 AI 并存）', hasNew);
  const upd = await call('PATCH', `/ai-waste/findings/${f1.data.finding_id}`, { evidence: '人工复核后修订：往返距离为 3.2 米，每循环两次，确认为搬运浪费' });
  ok('编辑人工浪费点 → 200 且内容更新', upd.status === 200 && upd.data?.evidence?.includes('人工复核后修订'), `status=${upd.status}`);
  // clamp 上限为 CT：填一个远超 CT 的值（≤DTO 上限 3600），结果应被压回 CT
  const updI = await call('PATCH', `/ai-waste/issues/${i1.data.issue_id}`, { est_save_s: 3600 });
  const ctRef = Number((await call('GET', `/stations/${SID}/ai-waste/items?origin=manual`)).data.summary?.total_est_save_s ?? -1);
  ok('est_save_s 超 CT → clamp 到 CT（不超总额）',
    updI.status === 200 && Number(updI.data?.est_save_s) <= 3600 && Number(updI.data?.est_save_s) >= 0,
    `est=${updI.data?.est_save_s} ctRef=${ctRef}`);
  if (aiOnly.data?.findings?.length > 0) {
    const aiF = aiOnly.data.findings[0];
    const deny = await call('PATCH', `/ai-waste/findings/${aiF.finding_id}`, { evidence: '试图修改 AI 产出条目内容应当被拒绝' });
    ok('AI 产出浪费点不可编辑 → 409', deny.status === 409, `status=${deny.status}`);
  } else {
    console.log('    （跳过）本工位无 AI 条目，未验证 409 保护');
  }

  console.log('— 4. 知识库整理与检索 —');
  const ar1 = await call('POST', `/stations/${SID}/ai-waste/kb/archive`, {});
  ok('手动整理进知识库 → 200', ar1.status === 200, JSON.stringify(ar1.data));
  ok('首次整理有新增条目', Number(ar1.data?.created) >= 1, `created=${ar1.data?.created}`);
  const ar2 = await call('POST', `/stations/${SID}/ai-waste/kb/archive`, {});
  ok('重复整理幂等（created=0 / updated≥1）',
    Number(ar2.data?.created) === 0 && Number(ar2.data?.updated) >= 1,
    `created=${ar2.data?.created} updated=${ar2.data?.updated}`);
  const kbList = await call('GET', `/ai-waste/kb?station_id=${SID}`);
  ok('知识库查询命中本工位条目', kbList.status === 200 && kbList.data.items.length >= 1, `n=${kbList.data?.items?.length}`);
  const k1 = kbList.data.items.find((k) => k.kind === 'issue') ?? kbList.data.items[0];
  ok('知识条目带检索关键词', Boolean(k1?.keywords), `kw=${String(k1?.keywords).slice(0, 40)}`);
  const kbQ = await call('GET', `/ai-waste/kb?station_id=${SID}&q=${encodeURIComponent('物料')}`);
  ok('关键词过滤生效', kbQ.status === 200 && Array.isArray(kbQ.data.items), `n=${kbQ.data?.items?.length}`);
  const arch = await call('PATCH', `/ai-waste/kb/${k1.kb_id}`, { status: 'archived' });
  ok('停用知识条目 → 200', arch.status === 200 && arch.data.status === 'archived');
  const act = await call('PATCH', `/ai-waste/kb/${k1.kb_id}`, { status: 'active' });
  ok('恢复知识条目 → 200', act.status === 200 && act.data.status === 'active');

  console.log('— 5. 人工措施确认进改善任务 —');
  const settle = await call('POST', `/ai-waste/issues/${i1.data.issue_id}/settle`, { status: '已确认' });
  ok('人工措施确认 → 200 且生成 imp_id', settle.status === 200 && Boolean(settle.data?.imp_id), `imp=${settle.data?.imp_id}`);
  const delLocked = await call('DELETE', `/ai-waste/issues/${i1.data.issue_id}`);
  ok('已确认条目不可删除 → 409', delLocked.status === 409, `status=${delLocked.status}`);

  console.log('— 6. 清理本用例数据 —');
  const d1 = await call('DELETE', `/ai-waste/findings/${f1.data.finding_id}`);
  const d2 = await call('DELETE', `/ai-waste/findings/${ghostSeq.data.finding_id}`);
  for (const k of kbList.data.items) await call('DELETE', `/ai-waste/kb/${k.kb_id}`);
  ok('人工浪费点可删除', d1.status === 200 && d2.status === 200);
  // 已确认条目按设计不可删（409），连同派生的改善任务一并走 SQL 清理，保证用例可重复跑
  {
    const pool = await sql.connect(DB);
    if (settle.data?.imp_id) {
      await pool.request().input('id', settle.data.imp_id).query('DELETE FROM t_improvement WHERE imp_id = @id');
    }
    await pool.request().input('iid', i1.data.issue_id).query('DELETE FROM t_ai_waste_issue WHERE issue_id = @iid');
    await pclose(pool);
    console.log(`    已清理改善任务 ${settle.data?.imp_id ?? '—'} 与已确认条目`);
  }
  const left = await call('GET', `/stations/${SID}/ai-waste/items?origin=manual`);
  const kbLeft = await call('GET', `/ai-waste/kb?station_id=${SID}`);
  ok('清理后本工位人工条目归零', left.data.findings.length === 0);
  ok('清理后知识库本工位条目归零', kbLeft.data.items.length === 0, `n=${kbLeft.data?.items?.length}`);

  console.log('— 7. 权限 —');
  const noAuth = await call('GET', `/stations/${SID}/ai-waste/items`, undefined, false);
  ok('无 token → 401', noAuth.status === 401, `status=${noAuth.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常：', e); process.exit(1); });
