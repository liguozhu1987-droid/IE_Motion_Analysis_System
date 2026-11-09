/* 前端联调脚本：按 app/web 新前端的真实调用序走一遍全链路（登录→工位→分解→分析→建议→对比→参数→VA）。 */
const BASE = 'http://127.0.0.1:3001/api';
const sql = require('mssql');
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}

let access = '';
let refresh = '';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

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

const SID = 'L01-ST99';

(async () => {
  // 前置布置：本用例断言「种子账号首次登录 mustChangePwd=true」。
  // UI 自动化环境约定 ie1 的 must_change_pwd=0（否则登录即被拦去改密页），
  // 故在此显式置 1 保证用例自给自足；结束还原为 0（见文件末尾）。
  {
    const pool = await sql.connect({
      server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS,
      options: { encrypt: false, trustServerCertificate: true },
    });
    await pool.request().query("UPDATE t_user SET must_change_pwd = 1 WHERE username = 'ie1'");
    await pool.close();
  }

  console.log('— 1. 登录与身份 —');
  const login = await call('POST', '/auth/login', { username: 'ie1', password: '123456' }, false);
  ok('登录 ie1 → 200', login.status === 200, JSON.stringify(login.data).slice(0, 120));
  access = login.data.accessToken; refresh = login.data.refreshToken;
  ok('登录返回 mustChangePwd', typeof login.data.mustChangePwd === 'boolean');

  const me = await call('GET', '/auth/me');
  ok('/me → 200 且含 permissions', me.status === 200 && Array.isArray(me.data.permissions));
  ok('/me mustChangePwd=true（种子账号首次登录）', me.data.mustChangePwd === true);

  console.log('— 2. 401 刷新链路（前端 api.ts 的核心行为）—');
  const bad = await call('GET', '/stations', undefined, false);
  ok('无 token → 401', bad.status === 401);
  const rf = await call('POST', '/auth/refresh', { refreshToken: refresh }, false);
  // 注意：JWT 同秒签发时 access token 字节相同（iat 确定性），轮换判据看 refresh token
  ok('refresh 轮换 → 200 且换发双 token', rf.status === 200 && rf.data.refreshToken !== refresh);
  access = rf.data.accessToken; refresh = rf.data.refreshToken;

  console.log('— 3. 工位 —');
  // 幂等重置：联调工位已存在则把版本指针退到 v1（复测草稿逐级作废；v1 要素会被后续 submit 覆盖）
  const exist = await call('GET', `/stations/${SID}`);
  if (exist.status === 200) {
    for (; ;) {
      const v = await call('GET', `/stations/${SID}/versions`);
      if (v.data[v.data.length - 1].version <= 1) break;
      const c = await call('DELETE', `/stations/${SID}/retest`);
      if (c.status !== 200) break;
    }
  }
  const list = await call('GET', '/stations?line_id=L01');
  ok('GET /stations → 数组直返', list.status === 200 && Array.isArray(list.data));
  const created = await call('POST', '/stations', { station_id: SID, line_id: 'L01', name: '联调工位', tt: 13.5 });
  ok('POST /stations 创建联调工位', (created.status === 201 || created.status === 200) || exist.status === 200, created.data?.station_id ?? '');
  const vers0 = await call('GET', `/stations/${SID}/versions`);
  ok('versions 初始 = 仅 v1', vers0.status === 200 && vers0.data.length === 1 && vers0.data[0].version === 1);

  console.log('— 4. 要素分解（validate → submit）—');
  const elements = [
    { seq: 1, start_ms: 0, dur_s: 2.5, hand: 'R', type: '移物', desc: '取料', va_class: 'VA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
    { seq: 2, start_ms: 2500, dur_s: 4.0, hand: 'B', type: '装配', desc: '锁附螺丝', va_class: 'VA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
    { seq: 3, start_ms: 6500, dur_s: 1.2, hand: 'L', type: '持住', desc: '持住定位', va_class: 'NVA', outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15 },
  ];
  const payload = { bol_version: 1, cycle_count: 15, cv: 0.1, elements };
  const val = await call('POST', `/stations/${SID}/elements/validate`, payload);
  ok('validate → ok=true 0 错误', (val.status === 200 || val.status === 201) && val.data.ok === true && val.data.errors.length === 0);
  const sub = await call('POST', `/stations/${SID}/elements/submit`, payload);
  ok('submit → ct 回写', sub.status === 200 || sub.status === 201, `ct=${sub.data?.ct}`);
  const els = await call('GET', `/stations/${SID}/elements`);
  ok('elements 列表 = 3 条', els.status === 200 && els.data.elements.length === 3 && els.data.version === 1);
  const csv = await fetch(`${BASE}/stations/${SID}/elements/export`, { headers: { Authorization: `Bearer ${access}` } });
  ok('export CSV 带头可下载', csv.status === 200 && (csv.headers.get('content-type') || '').includes('text/csv'));

  console.log('— 5. VA 改判（PATCH va-class）—');
  const va = await call('PATCH', `/stations/${SID}/elements/${els.data.elements[2].element_id}/va-class`, { va_class: 'RNVA', reason: '治具已定向，持住可消除' });
  ok('va-class 改判 → 200 且回传 desc 标记', va.status === 200 && String(va.data.desc).includes('[VA改判'));

  console.log('— 6. 分析 —');
  const ana = await call('GET', `/stations/${SID}/analysis`);
  ok('station analysis → metrics 齐全', ana.status === 200 && ana.data.metrics && ana.data.metrics.ct > 0);
  const line = await call('GET', '/lines/L01/analysis');
  ok('line analysis → rows 含 element_count', line.status === 200 && line.data.rows.every((r) => typeof r.element_count === 'number'));

  console.log('— 7. 建议（generate → adopt）—');
  const gen = await call('POST', `/stations/${SID}/suggestions/generate`);
  ok('generate → 候选不落库', (gen.status === 200 || gen.status === 201) && Array.isArray(gen.data.candidates), `candidates=${gen.data.candidates?.length}`);
  const cands = gen.data.candidates ?? [];
  const pick = cands.slice(0, Math.min(2, cands.length));
  if (pick.length > 0) {
    const adoptRes = await call('POST', `/stations/${SID}/suggestions/adopt`, { candidates: pick });
    ok('adopt → 写入待实施', (adoptRes.status === 200 || adoptRes.status === 201) && adoptRes.data.created === pick.length, `created=${adoptRes.data?.created}`);
  } else {
    console.log('  · 本工位无候选（浪费未触发），跳过 adopt');
  }
  const imps = await call('GET', `/improvements?station_id=${SID}`);
  ok('improvements 清单', imps.status === 200 && Array.isArray(imps.data.improvements));
  const todo = (imps.data.improvements ?? []).find((i) => i.status === '待实施');
  if (todo) {
    const st = await call('PATCH', `/improvements/${todo.imp_id}/status`, { status: '已完成' });
    ok('状态流转 待实施→已完成', st.status === 200 && st.data.status === '已完成');
    const rep = await call('GET', `/improvements/${todo.imp_id}/report`);
    ok('建议书报告 → header/problem/steps', rep.status === 200 && rep.data.header && rep.data.steps);
  } else {
    console.log('  · 无待实施建议（历史批次已流转），跳过状态测试');
  }

  console.log('— 8. 复测与对比 —');
  const retest = await call('POST', `/stations/${SID}/retest`);
  ok('retest → version=2', (retest.status === 200 || retest.status === 201) && retest.data.version === 2);
  const v2Elements = elements.map((e, i) => (i === 2 ? { ...e, dur_s: 0.6, desc: '持住定位(已改善)' } : e));
  const sub2 = await call('POST', `/stations/${SID}/elements/submit`, { bol_version: 2, cycle_count: 20, cv: 0.08, elements: v2Elements });
  ok('v2 提交 → CT 下降', (sub2.status === 200 || sub2.status === 201) && sub2.data.ct < sub.data.ct, `v1=${sub.data.ct} v2=${sub2.data.ct}`);
  const cmp = await call('GET', `/stations/${SID}/compare`);
  ok('compare 默认最近两版', cmp.status === 200 && cmp.data.prev.version === 1 && cmp.data.curr.version === 2 && cmp.data.delta_ct > 0, `ΔCT=${cmp.data.delta_ct}`);
  const vers2 = await call('GET', `/stations/${SID}/versions`);
  ok('versions = [v1封存, v2当前]', vers2.status === 200 && vers2.data.length === 2 && vers2.data[0].is_sealed && vers2.data[1].is_current);

  console.log('— 9. 收益参数（lines 整体替换语义）—');
  const bp0 = await call('GET', '/config/benefit-params');
  ok('benefit-params GET → lines 数组', bp0.status === 200 && Array.isArray(bp0.data.lines));
  // ie1 只有 benefit-read：保存应 403（权限正确执行，前端也会隐藏按钮）
  const bpDenied = await call('POST', '/config/benefit-params', { lines: [{ line_id: 'L01', rate_yuan_per_hour: 45, daily_output: 2000, land_rate: 0.7 }] });
  ok('ie1 保存参数 → 403（settings:benefit-write 缺失）', bpDenied.status === 403);
  // 换 admin（持有 settings:benefit-write）完成保存
  const adminLogin = await call('POST', '/auth/login', { username: 'admin', password: '123456' }, false);
  access = adminLogin.data.accessToken;
  const merged = [...(bp0.data.lines ?? []).filter((l) => l.line_id !== 'L01'),
    { line_id: 'L01', rate_yuan_per_hour: 45, daily_output: 2000, land_rate: 0.7, configured_by: 'admin', configured_at: '2026-10-22' }];
  const bp1 = await call('POST', '/config/benefit-params', { lines: merged });
  ok('admin benefit-params POST 合并保存', (bp1.status === 200 || bp1.status === 201) && (bp1.data.lines ?? []).some((l) => l.line_id === 'L01' && l.daily_output === 2000));
  access = rf.data.accessToken; // 换回 ie1 继续后续步骤
  const cmp2 = await call('GET', `/stations/${SID}/compare`);
  ok('配置后 compare 收益可算', cmp2.status === 200 && cmp2.data.benefit && cmp2.data.benefit.annual_yuan > 0, `annual=${cmp2.data.benefit?.annual_yuan}`);

  console.log('— 10. 登出 —');
  const out = await call('POST', '/auth/logout', { refreshToken: refresh }, false);
  ok('logout → ok', out.status === 200 && out.data.ok === true);
  const reuse = await call('POST', '/auth/refresh', { refreshToken: refresh }, false);
  ok('登出后 refresh 失效（轮换+吊销）', reuse.status === 401);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  // 结束还原：ie1 恢复 UI 自动化环境约定（must_change_pwd=0），避免后续浏览器测试被改密页拦截
  {
    const pool = await sql.connect({
      server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS,
      options: { encrypt: false, trustServerCertificate: true },
    });
    try {
      await pool.request().query("UPDATE t_user SET must_change_pwd = 0 WHERE username = 'ie1'");
      // 收尾：清理联调工位（API 无 DELETE /stations 端点，走 DB；顺序先子表后主表，外键强制）
      await pool.request().input('sid', sql.NVarChar, SID).query('DELETE FROM t_element WHERE station_id = @sid');
      await pool.request().input('sid', sql.NVarChar, SID).query('DELETE FROM t_improvement WHERE station_id = @sid');
      await pool.request().input('sid', sql.NVarChar, SID).query('DELETE FROM t_station WHERE station_id = @sid');
    } finally {
      await pool.close();
    }
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
