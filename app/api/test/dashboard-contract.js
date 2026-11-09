/* 集团综合驾驶舱契约实测（v3.3 迭代2）：/dashboard/summary + /dashboard/improvements + /improvements VO */
const BASE = process.env.BASE || 'http://127.0.0.1:3001/api';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function login(username, password = '123456') {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  return j.accessToken || j.access_token || j.token || (j.data && j.data.accessToken);
}

async function api(path, token) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  console.log('== 1. admin 登录 ==');
  const admin = await login('admin');
  ok(Boolean(admin), 'admin 登录获取 token');

  console.log('== 2. GET /dashboard/summary（无筛选） ==');
  const s = await api('/dashboard/summary', admin);
  ok(s.status === 200, 'HTTP 200', `status=${s.status}`);
  const d = s.body;
  ok(d && d.kpis, 'kpis 存在');
  ok(Array.isArray(d.by_region) && d.by_region.length > 0, 'by_region 非空', `region=${d.by_region.length}`);
  ok(Array.isArray(d.by_company) && d.by_company.length > 0, 'by_company 非空', `company=${d.by_company.length}`);
  ok(Array.isArray(d.by_process) && d.by_process.length > 0, 'by_process 非空');
  ok(Array.isArray(d.by_product) && d.by_product.length > 0, 'by_product 非空');
  ok(Array.isArray(d.by_project), 'by_project 为数组（无任务时允许为空）', `projects=${d.by_project.length}`);
  ok(Array.isArray(d.lines) && d.lines.length > 0, 'lines 非空', `lines=${d.lines.length}`);
  ok(d.kpis.station_count > 0, '工位聚合', `stations=${d.kpis.station_count}`);
  ok(d.kpis.company_count >= 1 && d.kpis.company_count === d.by_company.length, '公司数与 by_company 一致', `companies=${d.kpis.company_count}`);
  ok(d.kpis.line_count >= 1 && d.kpis.line_count === d.lines.length, '产线数与 lines 一致', `lines=${d.kpis.line_count}`);
  ok(typeof d.kpis.avg_balance_rate === 'number' && d.kpis.avg_balance_rate >= 0, '平均平衡率为百分数（无要素数据时允许 0）', `${d.kpis.avg_balance_rate}%`);
  ok(typeof d.kpis.est_save_s_total === 'number', '估算节省秒数汇总', `${d.kpis.est_save_s_total}s`);
  ok(d.rule_versions && d.rule_versions.va_rules, '规则版本回显', JSON.stringify(d.rule_versions));
  // 平衡率升序（关注清单口径）
  const rates = d.lines.map((l) => l.balance_rate);
  ok(rates.every((v, i) => i === 0 || rates[i - 1] <= v), '产线表按平衡率升序');
  // 铁律：不含要素明细
  ok(!JSON.stringify(d).includes('std_time') && !JSON.stringify(d).includes('element_id'), '响应不含要素明细字段（铁律）');

  console.log('== 3. 维度筛选联动 ==');
  if (d.by_region.length > 0) {
    const region = encodeURIComponent(d.by_region[0].region);
    const fr = await api(`/dashboard/summary?region=${region}`, admin);
    ok(fr.status === 200 && fr.body.scope.region === d.by_region[0].region, 'region 筛选生效', fr.body.scope.region);
    ok(fr.body.lines.every((l) => l.region === d.by_region[0].region), 'region 筛选后产线全部归属该区域');
  }
  const proc = d.by_process[0].process_type;
  const fp = await api(`/dashboard/summary?process=${encodeURIComponent(proc)}`, admin);
  ok(fp.status === 200 && fp.body.lines.every((l) => l.process_type === proc), 'process 筛选生效', proc);
  const prod = d.by_product[0].product_type;
  const fd = await api(`/dashboard/summary?product_type=${encodeURIComponent(prod)}`, admin);
  ok(fd.status === 200 && fd.body.lines.every((l) => l.product_type === prod), 'product_type 筛选生效', prod);
  if (d.by_project.length > 0) {
    const proj = d.by_project[0].project_type;
    const fj = await api(`/dashboard/summary?project=${encodeURIComponent(proj)}`, admin);
    ok(fj.status === 200 && fj.body.by_project.length === 1 && fj.body.by_project[0].project_type === proj, 'project 筛选只切任务侧', proj);
  } else {
    ok(true, 'project 筛选跳过（库内无改善任务）');
  }

  console.log('== 4. GET /dashboard/improvements（跨公司任务列表） ==');
  const im = await api('/dashboard/improvements', admin);
  ok(im.status === 200 && Array.isArray(im.body.improvements), 'HTTP 200 + 数组信封');
  const vo = im.body.improvements[0];
  const voFields = ['imp_id', 'station_id', 'waste_type', 'method', 'measure', 'est_save_s', 'priority', 'status',
    'project_type', 'owner', 'due', 'before_ct', 'after_ct', 'created_at', 'station_name', 'line_id', 'line_name',
    'process_type', 'product_type', 'product_project', 'tenant_id', 'company', 'region'];
  if (vo) {
    const missing = voFields.filter((k) => !(k in vo));
    ok(missing.length === 0, 'VO 字段完整（与 /improvements 统一契约）', missing.length ? `缺:${missing.join(',')}` : `${voFields.length} 字段`);
  } else {
    ok(true, 'improvements 列表为空（库内无任务，跳过字段断言）');
  }
  const im2 = await api('/dashboard/improvements?status=待实施', admin);
  ok(im2.status === 200 && im2.body.improvements.every((i) => i.status === '待实施'), 'status 过滤生效');

  console.log('== 5. GET /improvements（租户内清单，新维度字段） ==');
  const ti = await api('/improvements', admin);
  ok(ti.status === 200 && Array.isArray(ti.body.improvements), 'HTTP 200');
  const tvo = ti.body.improvements[0];
  if (tvo) {
    ok('project_type' in tvo && 'company' in tvo && 'region' in tvo && 'line_name' in tvo, 'VO 增加 project_type/company/region/line_name');
    const tf = await api('/improvements?project_type=' + encodeURIComponent(tvo.project_type), admin);
    ok(tf.status === 200 && tf.body.improvements.every((i) => i.project_type === tvo.project_type), '租户内 project_type 直查生效');
  } else {
    ok(true, '租户内清单为空（库内无任务，跳过字段断言）');
  }

  console.log('== 6. 权限零越权（v3.55：数据层收口，非接口拒绝）==');
  /* 口径变更说明（v3.55）：
     综合看板是「全角色开放」的产品决策（v3.42 决策#1，顶栏与落地页均已按此实现），
     因此非管理员访问 /dashboard/summary 不再是 403，而是**只统计其可见工位**。
     越权的真正危害是「看到别人的分析结果」，故断言改为验证数据不外泄：
       - 普通用户工位数必须显著少于管理员
       - 不得包含管理员才可见的产线/区域
       - 他租户用户只看得到本租户
     （接口级越权由 test-acl-read-guard.cjs 覆盖：读他人工位明细 → 403） */
  const viewer = await login('viewer1');
  const vSum = await api('/dashboard/summary', viewer);
  ok(vSum.status === 200, 'viewer 访问综合看板 → 200（全角色开放，仅数据收口）', `status=${vSum.status}`);
  const vCount = vSum.body?.kpis?.station_count ?? -1;
  ok(vCount < d.kpis.station_count, 'viewer 看板工位数 < admin（数据层收口生效）', `viewer=${vCount} admin=${d.kpis.station_count}`);
  const vLineIds = (vSum.body?.lines || []).map((l) => l.line_id);
  const adminLineIds = d.lines.map((l) => l.line_id);
  ok(vLineIds.every((id) => adminLineIds.includes(id)), 'viewer 看板产线均在 admin 可见集合内（无凭空多出的产线）', vLineIds.join(','));
  const other1 = await login('other1');
  const oSum = await api('/dashboard/summary', other1);
  ok(oSum.status === 200, '他租户 ie_engineer 访问综合看板 → 200（锁本租户聚合）', `status=${oSum.status}`);
  const oCount = oSum.body?.kpis?.station_count ?? -1;
  ok(oCount < d.kpis.station_count, '他租户看板工位数 < admin（不跨租户泄露）', `other=${oCount} admin=${d.kpis.station_count}`);
  const oCompanies = (oSum.body?.by_company || []).map((c) => c.company);
  const adminCompanies = d.by_company.map((c) => c.company);
  ok(oCompanies.every((c) => adminCompanies.includes(c)), '他租户看板公司均在 admin 集合内', oCompanies.join(','));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
