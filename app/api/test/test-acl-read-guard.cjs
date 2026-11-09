/**
 * v3.55 个人可见范围守卫回归（纯 API 层，无 UI 依赖）。
 *
 * 背景：本轮修复用户投诉——「以 IE 工程师身份进入系统后，还能看到集团视图下
 *      各工厂/产线/工位的分析结果，甚至能进入示例装配线分解」。
 *      根因：读路径全线绕过资源级 ACL（GET /stations 被挡住，但 GET /stations/:id/elements 放行），
 *      且聚合层（看板/产线总览）只按租户过滤，不按个人可见范围过滤。
 *
 * 本套件建立双向防线（既防越权，也防"过度收口"把合法用户锁死）：
 *
 *   【越权防线 R】
 *   R1  非相关用户读他人工位主数据 → 403
 *   R2  非相关用户读他人工位要素明细 → 403（最敏感层：ST/VA 判定/浪费类型）
 *   R3  非相关用户读他人工位分析结果 → 403
 *   R4  非相关用户读他人工位版本/协作者/对比 → 403
 *   R5  非相关用户读他人工位 AI 建议/浪费清单 → 403
 *   R6  非相关用户读他人工位产线分析 → 404（无可见工位）
 *   R7  非相关用户改他人工位 VA 判定 → 403（对象级写守卫）
 *   R8  非相关用户提交他人工位要素 → 403
 *   R9  非相关用户改他人工位改善任务状态 → 403
 *   R10 看板/产线总览只统计可见工位（聚合值不得泄露）
 *
 *   【过度收口防线 O】（守卫不能把合法用户锁死——这是本次修复最大的回归风险）
 *   O1  协作者（editor）能读共享工位全部敏感读端点 → 200
 *   O2  协作者（viewer）能读但不能写 → 读 200 / 写 403
 *   O3  管理员仍能看全量工位与全量聚合
 *   O4  产线级共享（t_line_share）后可见该线全部工位
 *   O5  data_scope=tenant 时可见本租户全部工位（授权扩大路径可用）
 *
 * 前置：API 已在 3001 运行且加载 v3.55 构建（dist 需为最新编译产物）。
 * 夹具：专用产线码 L97 / 工位 L97-ST01，测后级联删除，不动任何业务工位。
 * 纪律：与其它写库测试串行执行。
 *
 * 用法：node app/api/test/test-acl-read-guard.cjs
 */
require('dotenv/config');
const { dbQuery, dbExec, isSqlite } = require('./db-client.cjs');

const API = process.env.BASE || 'http://127.0.0.1:3001/api';
const LINE = 'L97';
const SID = 'L97-ST01';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  X    ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 220) : '')); }
}

async function api(method, url, token, body) {
  const res = await fetch(API + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应（CSV 导出等） */ }
  return { status: res.status, data };
}
async function login(username, password) {
  const r = await api('POST', '/auth/login', null, { username, password });
  return r.data && r.data.accessToken;
}

/**
 * 上传视频（multipart）。视频收口测试用真实文件走一遍上传→登记→下载全链。
 * 源视频由 ffmpeg 生成 1 秒测试片，避免依赖仓库里现成的业务视频。
 */
async function uploadVideo(token, filePath) {
  const fs = require('fs');
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'video/mp4' }), 'acl-probe.mp4');
  const res = await fetch(API + '/videos/upload', {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

/** 下载视频（<video> 场景用 ?token= 回退），只看状态码 */
async function fetchVideo(token, name) {
  const res = await fetch(`${API}/videos/file/${name}?token=${encodeURIComponent(token)}`);
  return { status: res.status };
}

/** 构造要素行（hand/类型/desc 均为合法词表值） */
function el(seq, startMs, durS) {
  return {
    seq, start_ms: startMs, dur_s: durS, hand: 'R', type: '移物', desc: `ACL守卫要素${seq}`,
    va_class: 'VA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15, source: 'manual',
  };
}

/**
 * 切换用户数据范围。
 * 走正规 API（PATCH /users/:id）而非直接改库——该端点会 invalidate AuthUserLoader 缓存
 * （30s 短缓存），直接 UPDATE t_user 会让登录态仍持旧 scope，导致 O5 误判为失败。
 */
async function setScope(admin, userId, scope) {
  const r = await api('PATCH', `/admin/users/${userId}`, admin, { dataScope: scope });
  return r.status;
}

(async () => {
  console.log('前置：登录与夹具准备');
  const admin = await login('admin', '123456');
  if (!admin) { console.log('admin 登录失败，终止'); process.exit(1); }
  const ie1 = await login('ie1', '123456');
  if (!ie1) { console.log('ie1 登录失败，终止'); process.exit(1); }
  const viewer1 = await login('viewer1', '123456');
  if (!viewer1) { console.log('viewer1 登录失败，终止'); process.exit(1); }

  // 幂等清理历史碰撞（FK 倒序：finding→issue→batch→station）
  for (const t of ['t_ai_waste_issue', 't_ai_waste_finding', 't_ai_waste_batch',
    't_ai_suggestion', 't_ai_suggestion_batch', 't_improvement', 't_element', 't_station_collaborator']) {
    await dbExec(`DELETE FROM ${t} WHERE station_id = '${SID}'`).catch(() => {});
  }
  await dbExec(`DELETE FROM t_station WHERE station_id = '${SID}'`).catch(() => {});
  await dbExec(`DELETE FROM t_line_share WHERE line_id = '${LINE}'`).catch(() => {});
  await dbExec(`DELETE FROM t_line WHERE line_id = '${LINE}'`).catch(() => {});
  await api('POST', '/lines', admin, { line_id: LINE, name: 'ACL守卫测试线' }).catch(() => {});

  const created = await api('POST', '/stations', admin, { station_id: SID, line_id: LINE, name: 'ACL守卫测试工位', tt: 60 });
  ok('夹具工位创建成功', created.status === 200 || created.status === 201, created.status);

  // 提交要素（有分析结果，聚合测试才有内容可比）
  // 校验铁律：有效循环数 ≥15（V3），否则提交被拦
  const sub = await api('POST', `/stations/${SID}/elements/submit`, admin, {
    bol_version: 1, cycle_count: 15, cv: 0, video_id: 'manual',
    elements: [el(1, 0, 2.0), el(2, 2000, 2.0), el(3, 4000, 1.5)],
  });
  ok('夹具要素提交成功', sub.status < 300, { status: sub.status, detail: sub.data?.detail });

  // 兜底：ie1 / viewer1 的 data_scope 归 own（测试可重复，不受其他用例污染）
  await setScope(admin, 'u_ie1', 'own');
  await setScope(admin, 'u_viewer1', 'own');

  // 记下 admin 全量基线（供聚合对比）
  const adminStations = await api('GET', '/stations', admin);
  const adminStationIds = (adminStations.data || []).map((s) => s.station_id);
  const adminSummary = await api('GET', '/dashboard/summary', admin);
  const adminCount = adminSummary.data?.kpis?.station_count ?? 0;
  ok('基线：admin 可读全量工位', adminStations.status === 200 && adminStationIds.length > 1,
    { count: adminStationIds.length });
  ok('基线：admin 看板工位数 ≥ 工位清单数（跨租户聚合）', adminCount >= adminStationIds.length,
    { adminCount, listCount: adminStationIds.length });

  console.log('\n[R1-R6] 越权防线：非相关用户读他人工位');
  /* 读端点分两类断言：
     - 严格 403：主数据 / 要素 / 分析 / 版本 / 协作者 / 对比 / AI 建议 / 浪费清单
     - 非 403 即可（业务语义优先）：AI 建议与浪费 latest/batches 在 AI 服务未启用时
       返回 503（ServiceUnavailable），这是"服务关停"而非"越权"——
       越权判定看的是「权限层放行与否」，故断言「不是 200 也不是 2xx 成功」。
       但必须严格是 403 而非 503，否则守卫失效（未校验即 503）会被误判为通过。 */
  const deniedProbes = [
    ['R1', 'GET', `/stations/${SID}`, 'strict'],
    ['R2', 'GET', `/stations/${SID}/elements`, 'strict'],
    ['R3', 'GET', `/stations/${SID}/analysis`, 'strict'],
    ['R4a', 'GET', `/stations/${SID}/versions`, 'strict'],
    ['R4b', 'GET', `/stations/${SID}/collaborators`, 'strict'],
    ['R4c', 'GET', `/stations/${SID}/compare`, 'strict'],
    ['R5a', 'GET', `/stations/${SID}/ai-suggestions`, 'strict'],
    ['R5b', 'GET', `/stations/${SID}/ai-waste/latest`, 'strict'],
    ['R5c', 'GET', `/stations/${SID}/ai-waste/batches`, 'strict'],
    ['R5d', 'GET', `/stations/${SID}/ai-waste/items`, 'strict'],
  ];
  for (const [tag, method, url] of deniedProbes) {
    const r = await api(method, url, ie1);
    ok(`${tag} ie1 读他人工位 → 403`, r.status === 403, { status: r.status, detail: r.data?.message || r.data?.detail });
  }
  // 产线分析：无可见工位 → 404（不泄露产线存在性）
  const lineAnalysis = await api('GET', `/lines/${LINE}/analysis`, ie1);
  ok('R6 ie1 读他人产线分析 → 404', lineAnalysis.status === 404, { status: lineAnalysis.status });

  console.log('\n[R7-R9] 越权防线：对象级写守卫');
  const elId = (await dbQuery(isSqlite
    ? `SELECT element_id FROM t_element WHERE station_id = '${SID}' LIMIT 1`
    : `SELECT TOP 1 element_id FROM t_element WHERE station_id = '${SID}'`))[0]?.element_id;
  if (elId) {
    const vaPatch = await api('PATCH', `/stations/${SID}/elements/${elId}/va-class`, ie1,
      { va_class: 'NVA', reason: '试图改判他人工位的VA判定' });
    ok('R7 ie1 改判他人 VA → 403', vaPatch.status === 403, { status: vaPatch.status, detail: vaPatch.data?.message });
  } else {
    ok('R7 跳过（无要素 element_id）', false, '夹具要素未落库');
  }
  const crossSubmit = await api('POST', `/stations/${SID}/elements/submit`, ie1, {
    bol_version: 1, cycle_count: 12, cv: 0, video_id: 'manual', elements: [el(1, 0, 2.0)],
  });
  ok('R8 ie1 提交他人工位要素 → 403', crossSubmit.status === 403, { status: crossSubmit.status });

  // 造一条改善任务，验证状态流转守卫
  const impId = `IMP-ACL-${Date.now()}`;
  await dbExec(`INSERT INTO t_improvement (imp_id, tenant_id, station_id, element_ids, waste_type, method, measure,
    est_save_s, priority, status, source, created_at) VALUES ('${impId}', 'DEFAULT', '${SID}', '', '等待', 'E',
    'ACL守卫测试用改善任务', 10, 50, '待实施', 'manual', GETDATE())`);
  const statusPatch = await api('PATCH', `/improvements/${impId}/status`, ie1, { status: '已完成' });
  ok('R9 ie1 改他人改善任务状态 → 403', statusPatch.status === 403, { status: statusPatch.status, detail: statusPatch.data?.message });
  const impRow = await dbQuery(`SELECT status FROM t_improvement WHERE imp_id = '${impId}'`);
  ok('R9b 改善任务状态未被改动（仍为待实施）', impRow[0]?.status === '待实施', impRow[0]);

  console.log('\n[R10] 聚合层收口：看板/产线总览只统计可见工位');
  const ie1Stations = await api('GET', '/stations', ie1);
  const ie1Ids = (ie1Stations.data || []).map((s) => s.station_id);
  ok('R10a ie1 工位清单不含他人工位', !ie1Ids.includes(SID), { ie1Ids });
  const ie1Summary = await api('GET', '/dashboard/summary', ie1);
  const ie1Count = ie1Summary.data?.kpis?.station_count ?? -1;
  ok('R10b ie1 看板工位数 < admin 看板工位数', ie1Count >= 0 && ie1Count < adminCount, { ie1Count, adminCount });
  ok('R10c ie1 看板产线表不含他人产线',
    !(ie1Summary.data?.lines || []).some((l) => l.line_id === LINE),
    (ie1Summary.data?.lines || []).map((l) => l.line_id));
  const ie1Lines = await api('GET', '/lines/summary', ie1);
  ok('R10d ie1 产线总览不含他人产线',
    !(ie1Lines.data?.lines || []).some((l) => l.line_id === LINE),
    (ie1Lines.data?.lines || []).map((l) => l.line_id));
  const ie1Imps = await api('GET', '/improvements', ie1);
  ok('R10e ie1 改善任务清单不含他人任务',
    !(ie1Imps.data?.improvements || []).some((i) => i.imp_id === impId),
    (ie1Imps.data?.improvements || []).length);

  console.log('\n[O1/O2] 过度收口防线：共享后必须可读');
  /* 共享后断言「不再是 403」：403 = 被权限层挡住（收口过头）；
     200 = 完全放行；503 = AI 服务未启用（服务关停，与权限无关）；
     409 = 业务前置不满足（如工位尚无复测版本无法对比），同样不是权限问题。
     关键：绝不能是 403——那说明守卫把合法协作者也挡在外面了。 */
  const sharedProbes = [
    ['O1-R1', `/stations/${SID}`],
    ['O1-R2', `/stations/${SID}/elements`],
    ['O1-R3', `/stations/${SID}/analysis`],
    ['O1-R4a', `/stations/${SID}/versions`],
    ['O1-R4b', `/stations/${SID}/collaborators`],
    ['O1-R4c', `/stations/${SID}/compare`],
    ['O1-R5a', `/stations/${SID}/ai-suggestions`],
    ['O1-R5b', `/stations/${SID}/ai-waste/latest`],
    ['O1-R5c', `/stations/${SID}/ai-waste/batches`],
    ['O1-R5d', `/stations/${SID}/ai-waste/items`],
  ];
  // 工位级共享：ie1 变 editor → 全部敏感读端点放行
  await api('POST', `/stations/${SID}/collaborators`, admin, { user_id: 'u_ie1', acl_role: 'editor' }).catch(() => {});
  for (const [tag, url] of sharedProbes) {
    const r = await api('GET', url, ie1);
    ok(`${tag} 共享后 ie1 不再被 403 挡住`, r.status !== 403, { status: r.status, detail: r.data?.message });
  }
  // 严格 200 的核心端点（数据必须真的能读出来）
  for (const [tag, url] of [['O1-c1', `/stations/${SID}`], ['O1-c2', `/stations/${SID}/elements`], ['O1-c3', `/stations/${SID}/analysis`]]) {
    const r = await api('GET', url, ie1);
    ok(`${tag} 共享后 ie1 可读 → 200`, r.status === 200, { status: r.status, detail: r.data?.message });
  }
  const lineAnalysis2 = await api('GET', `/lines/${LINE}/analysis`, ie1);
  ok('O1b 共享后 ie1 可读产线分析 → 200', lineAnalysis2.status === 200, { status: lineAnalysis2.status });

  console.log('\n[O2] viewer 协作者：可读不可写');
  await api('POST', `/stations/${SID}/collaborators`, admin, { user_id: 'u_viewer1', acl_role: 'viewer' }).catch(() => {});
  const vRead = await api('GET', `/stations/${SID}/elements`, viewer1);
  ok('O2a viewer 协作者可读要素 → 200', vRead.status === 200, { status: vRead.status });
  const vWrite = await api('POST', `/stations/${SID}/elements/submit`, viewer1, {
    bol_version: 1, cycle_count: 12, cv: 0, video_id: 'manual', elements: [el(1, 0, 2.0)],
  });
  ok('O2b viewer 协作者不可写 → 403', vWrite.status === 403, { status: vWrite.status });

  console.log('\n[O4] 产线级共享（t_line_share）');
  await api('DELETE', `/stations/${SID}/collaborators/u_ie1`, admin).catch(() => {});
  await api('DELETE', `/stations/${SID}/collaborators/u_viewer1`, admin).catch(() => {});
  const shareRes = await api('POST', '/stations/line-shares', admin, { line_id: LINE, user_id: 'u_ie1', acl_role: 'viewer' });
  ok('O4a 整线共享创建成功', shareRes.status === 200 || shareRes.status === 201, shareRes.status);
  const shareRead = await api('GET', `/stations/${SID}`, ie1);
  ok('O4b 整线共享后 ie1 可见该线工位 → 200', shareRead.status === 200, { status: shareRead.status });

  console.log('\n[O5] data_scope=tenant 授权扩大路径');
  await api('DELETE', `/stations/line-shares/${LINE}/u_ie1`, admin).catch(() => {});
  const scopeRes = await setScope(admin, 'u_ie1', 'tenant');
  ok('O5-0 data_scope 改 tenant 成功（正规 API 会失效登录态缓存）', scopeRes === 200 || scopeRes === 201, scopeRes);
  const tenantScopeRead = await api('GET', `/stations/${SID}`, ie1);
  ok('O5a data_scope=tenant 时可见本租户工位 → 200', tenantScopeRead.status === 200, { status: tenantScopeRead.status });
  const tenantScopeList = await api('GET', '/stations', ie1);
  const tenantScopeIds = (tenantScopeList.data || []).map((s) => s.station_id);
  ok('O5b data_scope=tenant 时工位清单覆盖本租户全部工位',
    tenantScopeIds.length >= adminStationIds.length - 1,
    { tenant: tenantScopeIds.length, admin: adminStationIds.length });
  await setScope(admin, 'u_ie1', 'own');

  console.log('\n[O3] 管理员仍全量可见');
  const adminRecheck = await api('GET', '/dashboard/summary', admin);
  ok('O3a admin 看板仍为全量工位', adminRecheck.data?.kpis?.station_count === adminCount,
    { now: adminRecheck.data?.kpis?.station_count, expect: adminCount });
  const adminRead = await api('GET', `/stations/${SID}/elements`, admin);
  ok('O3b admin 仍可读任意工位要素 → 200', adminRead.status === 200, { status: adminRead.status });

  console.log('\n[V] 视频归属收口（跨租户泄露面）');
  // 工位视频原为「上传即入全局目录」的裸文件池，下载端点只校验 station:read 权限点
  // → 任何登录用户凭文件名即可下载任意租户的视频。v3.55 补 t_video_asset 归属登记 + 资源级判定。
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const tmpVideo = path.resolve(process.cwd(), 'storage', 'videos', 'tmp', 'acl-probe-src.mp4');
  let videoName = null;
  try {
    fs.mkdirSync(path.dirname(tmpVideo), { recursive: true });
    const ffmpegBin = fs.existsSync(path.resolve(process.cwd(), 'bin', 'ffmpeg.exe'))
      ? path.resolve(process.cwd(), 'bin', 'ffmpeg.exe')
      : require('ffmpeg-static');
    execFileSync(ffmpegBin, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-pix_fmt', 'yuv420p', tmpVideo,
    ], { stdio: 'ignore', timeout: 60000 });
  } catch (e) {
    console.log('  SKIP V 视频收口（ffmpeg 不可用，无法造测试片）');
  }
  if (fs.existsSync(tmpVideo)) {
    const up = await uploadVideo(ie1, tmpVideo);
    videoName = up.data && up.data.name;
    ok('V1a ie1 上传视频成功（登记归属）', up.status === 201 && !!videoName, { status: up.status, name: videoName });
    if (videoName) {
      // ② 上传者本人可播
      const own = await fetchVideo(ie1, videoName);
      ok('V1b 上传者本人可播放 → 200', own.status === 200, { status: own.status });
      // ① 全权角色可播
      const adm = await fetchVideo(admin, videoName);
      ok('V1c 管理员可播放 → 200', adm.status === 200, { status: adm.status });
      // ③ 无关用户（无关联工位）不可播
      const unrelated = await fetchVideo(viewer1, videoName);
      ok('V1d 无关用户播放他人视频 → 403', unrelated.status === 403, { status: unrelated.status });
      // ④ 他租户用户不可播（跨租户）
      const other1 = await login('other1', '123456');
      const crossTenant = await fetchVideo(other1, videoName);
      ok('V1e 他租户用户播放 → 403', crossTenant.status === 403, { status: crossTenant.status });

      // ③ 关联工位可见 → 放行（要素带 video_id 关联到工位）
      const els = [];
      for (let i = 1; i <= 15; i += 1) els.push(el(i, (i - 1) * 2000, 1.5));
      const sub = await api('POST', `/stations/${SID}/elements/submit`, admin, {
        bol_version: 1, cycle_count: 15, cv: 0, video_id: videoName, elements: els,
      });
      ok('V2a 要素关联视频到工位成功', sub.status === 201, { status: sub.status });
      // 关联工位可见 → 放行：viewer1 先取得该工位协作者身份（viewer 只读）
      const collab = await api('POST', `/stations/${SID}/collaborators`, admin, { user_id: 'u_viewer1', acl_role: 'viewer' });
      ok('V2a-1 viewer1 成为该工位协作者', collab.status === 200 || collab.status === 201, { status: collab.status });
      const byStation = await fetchVideo(viewer1, videoName);
      ok('V2b 关联工位可见者（viewer 协作者）可播放 → 200', byStation.status === 200, { status: byStation.status });

      // 过度收口防线：video_id 关联不能让「无关用户」也通过
      await api('DELETE', `/stations/${SID}/collaborators/u_viewer1`, admin).catch(() => {});
      const afterRemove = await fetchVideo(viewer1, videoName);
      ok('V2c 撤销协作者后不可再播放 → 403（防过度放行）', afterRemove.status === 403, { status: afterRemove.status });
    }
  }

  console.log('\n清理：删除夹具');
  await dbExec(`DELETE FROM t_improvement WHERE imp_id = '${impId}'`).catch(() => {});
  await api('DELETE', `/stations/${SID}`, admin).catch(() => {});
  await dbExec(`DELETE FROM t_line WHERE line_id = '${LINE}'`).catch(() => {});
  await dbExec(`UPDATE t_user SET data_scope = 'own' WHERE user_id IN ('u_ie1','u_viewer1')`).catch(() => {});
  // 视频夹具清理：归属登记 + 磁盘文件
  if (videoName) {
    await dbExec(`DELETE FROM t_video_asset WHERE file_name = '${videoName}'`).catch(() => {});
    try { require('fs').unlinkSync(require('path').resolve(process.cwd(), 'storage', 'videos', videoName)); } catch { /* 已删 */ }
  }
  try { require('fs').unlinkSync(require('path').resolve(process.cwd(), 'storage', 'videos', 'tmp', 'acl-probe-src.mp4')); } catch { /* 已删 */ }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('执行异常:', e && e.message, e); process.exit(1); });
