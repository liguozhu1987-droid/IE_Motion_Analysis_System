/**
 * 目标架构冒烟测试：认证 / RBAC / 租户隔离 / 规则双源 / AI 降级 / 审计。
 * 前置：先执行 npm run seed。运行：npm run build && npm run smoke
 */
import 'dotenv/config'; // 从 .env 读取目标库配置（mssql/sqlite 由 DB_TYPE 决定）
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/core/all-exceptions.filter';
import { loadConfig } from '../src/core/config/configuration';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let ok = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { ok++; console.log(`  ${PASS} ${name}`); }
  else {
    fail++;
    const d = detail === undefined ? '' : ` → ${JSON.stringify(detail).slice(0, 300)}`;
    failures.push(name + d);
    console.log(`  ${FAIL} ${name}${d}`);
  }
}

/** 诊断：失败时打印 status + 响应体 */
function checkR(name: string, r: { status: number; data: any }, cond: boolean): void {
  if (cond) { ok++; console.log(`  ${PASS} ${name}`); return; }
  fail++;
  const d = ` [HTTP ${r.status}] ${JSON.stringify(r.data).slice(0, 300)}`;
  failures.push(name + d);
  console.log(`  ${FAIL} ${name}${d}`);
}

async function api(base: string, method: string, path: string, opts: { token?: string; body?: unknown; tenant?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.tenant) headers['x-tenant-id'] = opts.tenant;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, data: json, text };
}

async function login(base: string, username: string, password = '123456') {
  const r = await api(base, 'POST', '/api/auth/login', { body: { username, password } });
  return r;
}

/** 清理测试工位（按库类型直连清理；先子表后主表，避免外键约束失败）。
 *  sqlite：node:sqlite 直连；mssql：mssql 驱动直连（配置同 .env）。 */
async function cleanStation(cfg: { dbType: string; dbPath: string; dbHost: string; dbPort: number; dbName: string; dbUser: string; dbPass: string }, stationId: string) {
  if (cfg.dbType === 'mssql') {
    const sql = await import('mssql');
    const pool = await sql.connect({
      server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
      options: { encrypt: false, trustServerCertificate: true },
    });
    try {
      /* v3.47 补齐 AI 派生表清理（与 StationsService.remove() 同口径）。
         此前只清 t_element/t_improvement/t_station，测试工位一旦跑过浪费识别/AI 建议，
         t_ai_waste_batch 的 FK（FK_ai_waste_batch_station）会在删 t_station 时报 547，
         导致冒烟跑到最后一步清理失败。顺序先子表后主表。 */
      for (const t of [
        't_ai_waste_issue', 't_ai_waste_finding', 't_ai_waste_batch',
        't_ai_suggestion', 't_ai_suggestion_batch', 't_station_collaborator',
      ]) {
        await pool.request().input('sid', sql.NVarChar, stationId)
          .query(`DELETE FROM ${t} WHERE station_id = @sid`);
      }
      await pool.request().input('sid', sql.NVarChar, stationId)
        .query('DELETE FROM t_element WHERE station_id = @sid');
      await pool.request().input('sid', sql.NVarChar, stationId)
        .query('DELETE FROM t_improvement WHERE station_id = @sid');
      await pool.request().input('sid', sql.NVarChar, stationId)
        .query('DELETE FROM t_station WHERE station_id = @sid');
    } finally {
      await pool.close();
    }
    return;
  }
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(cfg.dbPath);
  try {
    // v3.47 同上：sqlite 分支亦补齐 AI 派生表，保持两库分支同口径
    for (const t of [
      't_ai_waste_issue', 't_ai_waste_finding', 't_ai_waste_batch',
      't_ai_suggestion', 't_ai_suggestion_batch', 't_station_collaborator',
    ]) {
      raw.prepare(`DELETE FROM ${t} WHERE station_id = ?`).run(stationId);
    }
    raw.prepare('DELETE FROM t_element WHERE station_id = ?').run(stationId);
    raw.prepare('DELETE FROM t_improvement WHERE station_id = ?').run(stationId);
    raw.prepare('DELETE FROM t_station WHERE station_id = ?').run(stationId);
  } finally {
    raw.close();
  }
}

/** 收尾：复测会把 L01-ST01 推到空壳 v2（要素只在 v1），回拨回 1 恢复种子态（v3.25 坑：不回拨则下轮 UI 回归工作台空载） */
async function restoreStationVersion(cfg: { dbType: string; dbPath: string; dbHost: string; dbPort: number; dbName: string; dbUser: string; dbPass: string }, stationId: string) {
  if (cfg.dbType !== 'mssql') return;
  const sql = await import('mssql');
  const pool = await sql.connect({
    server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.request().input('sid', sql.NVarChar, stationId)
      .query("UPDATE t_station SET version = 1 WHERE station_id = @sid AND version > 1 AND NOT EXISTS (SELECT 1 FROM t_element e WHERE e.station_id = @sid AND e.bol_version = t_station.version)");
  } finally {
    await pool.close();
  }
}

/** 收尾：解除登录锁定测试对账号的副作用（连错 5 次锁定 leader1，测后必须解锁，否则污染后续登录） */
async function unlockUser(cfg: { dbType: string; dbPath: string; dbHost: string; dbPort: number; dbName: string; dbUser: string; dbPass: string }, username: string) {
  if (cfg.dbType !== 'mssql') return;
  const sql = await import('mssql');
  const pool = await sql.connect({
    server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.request().input('u', sql.NVarChar, username)
      .query("UPDATE t_user SET status = 'active', locked_until = NULL, failed_count = 0 WHERE username = @u");
  } finally {
    await pool.close();
  }
}

async function main() {
  const cfg = loadConfig();
  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api'); // 与 main.ts 一致
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  console.log(`\n冒烟测试目标: ${base}  (db=${cfg.dbType}, ai=${cfg.aiEnabled ? 'on' : 'off'})\n`);

  // —— 1. 健康与就绪 ——
  const health = await api(base, 'GET', '/api/health');
  check('GET /api/health 200', health.status === 200);
  const ready = await api(base, 'GET', '/api/ready');
  check('GET /api/ready db=up', ready.data?.db === 'up', ready.data);
  check('GET /api/ready rules=up', ready.data?.rules === 'up');

  // —— 2. 认证 ——
  const bad = await login(base, 'admin', 'wrong-password');
  check('错误密码 → 401', bad.status === 401, bad.data?.detail);
  const noToken = await api(base, 'GET', '/api/stations');
  check('无 token 访问业务接口 → 401', noToken.status === 401);

  const admin = await login(base, 'admin');
  check('admin 登录 → 200', admin.status === 200, admin.data?.detail);
  check('签发 accessToken', typeof admin.data?.accessToken === 'string');

  const me = await api(base, 'GET', '/api/auth/me', { token: admin.data.accessToken });
  check('GET /api/auth/me 返回角色与权限', me.status === 200 && me.data?.roles?.includes('sys_admin') && me.data?.permissions?.length > 10, me.data);

  // —— 3. 登录锁定（连错 5 次）——
  for (let i = 0; i < 5; i++) await login(base, 'leader1', 'bad');
  const locked = await login(base, 'leader1', '123456');
  checkR('连错 5 次后即使正确密码也锁定 → 401', locked, locked.status === 401 && /锁定/.test(locked.data?.detail ?? locked.data?.message ?? ''));

  // —— 4. RBAC ——
  const viewer = await login(base, 'viewer1');
  check('viewer 登录成功', viewer.status === 200);
  const viewerRead = await api(base, 'GET', '/api/stations', { token: viewer.data.accessToken });
  check('viewer 可读工位（station:read）', viewerRead.status === 200);
  const viewerWrite = await api(base, 'POST', '/api/stations', {
    token: viewer.data.accessToken,
    body: { station_id: 'L01-ST99', line_id: 'L01', name: '越权测试' },
  });
  check('viewer 写工位 → 403（无 station:write）', viewerWrite.status === 403, viewerWrite.data?.detail);
  const viewerUserMgmt = await api(base, 'GET', '/api/stations', { token: viewer.data.accessToken, tenant: 'OTHER' });
  check('viewer 指定他租户 → 403（TenantGuard）', viewerUserMgmt.status === 403, viewerUserMgmt.data?.detail);

  // —— 5. 多租户数据隔离 ——（v3.3：DEFAULT 租户含 seed-demo 演示线 L20/L30）
  // v3.22 断言更新：工位编码自 v3.21 起支持 CMC 产线码前缀（BJFA1-ST01/SHFA9-ST01）；
  // v3.23 起 from-cmc 入口开放手动录入（现场习称，DTO 仅 MaxLength(32) 不限格式，如 PA10）——
  // 故编码形状断言对齐产品规则（≤32 位安全字符），不再强求 -ST\d{2} 后缀；
  // 隔离语义断言不变（不含他租户 L02-ST01）。
  const adminStations = await api(base, 'GET', '/api/stations', { token: admin.data.accessToken });
  const adminIds = (adminStations.data ?? []).map((s: any) => s.station_id);
  check('admin 只见本租户工位（不含他租户 L02-ST01；编码兼容 CMC 前缀/手动习称）',
    adminIds.length >= 2 && !adminIds.includes('L02-ST01') && adminIds.every((i: string) => /^[A-Za-z0-9][A-Za-z0-9\-_]{0,31}$/.test(i)), adminIds);
  const adminCrossRead = await api(base, 'GET', '/api/stations/L02-ST01', { token: admin.data.accessToken });
  check('admin 直读他租户工位 → 404（行级隔离）', adminCrossRead.status === 404, adminCrossRead.data?.detail);

  const other = await login(base, 'other1');
  check('other1（OTHER 租户）登录成功', other.status === 200);
  const otherStations = await api(base, 'GET', '/api/stations', { token: other.data.accessToken });
  const otherIds = (otherStations.data ?? []).map((s: any) => s.station_id);
  check('other1 只见 L02-ST01（反向隔离）', otherIds.length === 1 && otherIds[0] === 'L02-ST01', otherIds);

  // —— 6. 业务写入（权限+租户上下文自动注入）——
  const newStationId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`; // 幂等：随机工位号（符合 L01-ST01 格式）
  await cleanStation(cfg, newStationId); // 清理历史碰撞（sqlite/mssql 均适用）
  const created = await api(base, 'POST', '/api/stations', {
    token: admin.data.accessToken,
    body: { station_id: newStationId, line_id: 'L01', name: '冒烟测试工位', tt: 55 },
  });
  checkR('admin 新建工位 → 200/201', created, created.status === 200 || created.status === 201);
  check('新工位自动归属 DEFAULT 租户', created.data?.tenant_id === 'DEFAULT', created.data?.tenant_id);

  const badFormat = await api(base, 'POST', '/api/stations', {
    token: admin.data.accessToken,
    body: { station_id: 'ST-BAD', line_id: 'L01', name: '格式错误' },
  });
  checkR('station_id 格式校验 → 400', badFormat, badFormat.status === 400);

  // v3.19 空版本护栏：无要素工位不允许开始复测（防止误点/测试点击堆积空壳版本）
  const emptyRetest = await api(base, 'POST', `/api/stations/${newStationId}/retest`, { token: admin.data.accessToken });
  checkR('空版本护栏：无要素工位开始复测 → 400', emptyRetest,
    emptyRetest.status === 400 && /还没有任何要素/.test(String(emptyRetest.data?.detail ?? '')));

  const before = await api(base, 'GET', '/api/stations/L01-ST01', { token: admin.data.accessToken });
  const retest = await api(base, 'POST', '/api/stations/L01-ST01/retest', { token: admin.data.accessToken });
  // 种子版 L01-ST01 有要素 → 正常 +1；若当前版本恰为空（上一轮复测未提交），护栏 400 亦属预期
  checkR('开始复测 version+1（封存旧版；空版本则护栏 400）', retest,
    ((retest.status === 200 || retest.status === 201) && retest.data?.version === (before.data?.version ?? 0) + 1)
    || (retest.status === 400 && /还没有任何要素/.test(String(retest.data?.detail ?? ''))));
  /* 复测会制造 L01-ST01 空壳 v2（要素只存在于 v1），下一轮 UI 回归工作台即空载——
     收尾把版本回拨回 1（种子态），保持测试库幂等可重跑（v3.25 坑） */
  await restoreStationVersion(cfg, 'L01-ST01');

  // —— 7. 规则库 ——
  const rules = await api(base, 'GET', '/api/rules', { token: admin.data.accessToken });
  check('规则快照 6 组（含 motion_standard 动作标准）', rules.status === 200 && Object.keys(rules.data ?? {}).length === 6, rules.data);
  // 版本号随规则迭代变化（RNVA 改名即 RV1.1、动作标准 MS1.0），断言语义化格式而非写死值
  check('规则版本齐备（RVx.y/MSx.y 语义化）', Object.values(rules.data ?? {}).every((r: any) => /^(RV|MS)\d+\.\d+$/.test(String(r.version))), rules.data);

  // v3.19 版本号治理：同 code 版本号撞车自动顺延次版本（历史 56 条同名 RV1.0 的修复）
  const curVa = (rules.data as any)?.va_rules?.version ?? 'RV1.0';
  // 取当前生效内容原样重发（内容不变，只验证版本号治理，不污染规则数据）
  const curVaContent = (await api(base, 'GET', '/api/rules/va_rules', { token: admin.data.accessToken })).data?.content;
  const dupPublish = await api(base, 'POST', '/api/rules/va_rules/publish', {
    token: admin.data.accessToken,
    body: { content: curVaContent, operator: 'smoke' },
  });
  checkR('重复版本号发布 → 自动顺延次版本（bumped=true）', dupPublish,
    (dupPublish.status === 200 || dupPublish.status === 201) && dupPublish.data?.bumped === true
    && dupPublish.data?.version !== curVa && /^RV\d+\.\d+$/.test(String(dupPublish.data?.version)));
  // 快照基准随发布后移（否则后面"分析结果版本与快照一致"会拿旧基准比对）
  const rulesAfter = await api(base, 'GET', '/api/rules', { token: admin.data.accessToken });
  if (rulesAfter.status === 200) rules.data = rulesAfter.data;

  // —— 8. AI 降级（AI_ENABLED=false）——
  const aiStatus = await api(base, 'GET', '/api/ai/status');
  check('AI 状态 enabled=false', aiStatus.data?.enabled === false);
  const polish = await api(base, 'POST', '/api/ai/polish', {
    token: admin.data.accessToken,
    body: { element_ids: ['E1'], waste_type: '持住', measure: '以治具替代手持住', est_save_s: 2.5, method: 'E' },
  });
  checkR('AI 关闭时提交润色 → 503（前端保持模板文案）', polish, polish.status === 503);

  // —— 9. 收益参数（规则集在线读写）——
  const params = await api(base, 'GET', '/api/config/benefit-params', { token: admin.data.accessToken });
  check('收益参数可读', params.status === 200 && typeof params.data?.formula === 'string');
  const putParams = await api(base, 'POST', '/api/config/benefit-params', {
    token: admin.data.accessToken,
    body: { lines: [{ line_id: 'L01', daily_output: 2000, rate_yuan_per_hour: 45, land_rate: 0.7 }] },
  });
  checkR('收益参数发布（规则版本切换）', putParams, (putParams.status === 200 || putParams.status === 201) && !!putParams.data?.rule_set_id);
  const paramsAfter = await api(base, 'GET', '/api/config/benefit-params', { token: admin.data.accessToken });
  // v3.19 版本号治理：rv 不再手工递增，发布撞车自动顺延（RV1.0 → RV1.1 → …），断言语义化
  check('发布后即时生效（lines 形态：L01 2000件/日）', /^RV1\.\d+$/.test(String(paramsAfter.data?.version))
    && (paramsAfter.data?.lines ?? []).some((l: any) => l.line_id === 'L01' && l.daily_output === 2000), paramsAfter.data);

  // —— 10. 审计留痕（按库类型直连校验：sqlite 用 node:sqlite，mssql 用 mssql 驱动）——
  if (cfg.dbType === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(cfg.dbPath);
    const rows = raw.prepare('SELECT action, entity FROM t_audit_log ORDER BY created_at DESC LIMIT 5').all();
    raw.close();
    check('写操作已留审计日志', Array.isArray(rows) && rows.length > 0, rows);
  } else {
    const sql = await import('mssql');
    const pool = await sql.connect({
      server: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: cfg.dbName,
      options: { encrypt: false, trustServerCertificate: true },
    });
    const auditRows = await pool.request().query('SELECT TOP 5 action, entity FROM t_audit_log ORDER BY created_at DESC');
    await pool.close();
    check('写操作已留审计日志（mssql 直连校验）', auditRows.recordset.length > 0, auditRows.recordset);
  }

  // —— 11. 要素分解模块（V1/V2/V3 / 写守卫 / 事务 / CSV / VA 改判）——
  const elStationId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await cleanStation(cfg, elStationId); // 清理历史碰撞（sqlite/mssql 均适用）
  const elStation = await api(base, 'POST', '/api/stations', {
    token: admin.data.accessToken,
    body: { station_id: elStationId, line_id: 'L01', name: '要素冒烟工位', tt: 60 },
  });
  checkR('要素测试工位创建', elStation, elStation.status === 200 || elStation.status === 201);

  const baseEl = (over: Record<string, unknown> = {}) => ({
    seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '移物', desc: '取前壳',
    va_class: 'VA', rating: 1, allowance: 0.15, ...over,
  });
  const submitEl = (body: Record<string, unknown>, token = admin.data.accessToken) =>
    api(base, 'POST', `/api/stations/${elStationId}/elements/submit`, { token, body });

  // V1 必填完整性（每条一个拦截点）
  const v1Desc = await submitEl({ cycle_count: 15, cv: 0.05, elements: [baseEl({ desc: '   ' })] });
  checkR('V1 拦截：描述为空', v1Desc, v1Desc.status === 400 && (v1Desc.data?.errors ?? []).some((e: any) => e.code === 'V1' && /描述/.test(e.message)));
  const v1Type = await submitEl({ cycle_count: 15, cv: 0.05, elements: [baseEl({ type: '玄学' })] });
  checkR('V1 拦截：类型不在动素词表', v1Type, v1Type.status === 400 && (v1Type.data?.errors ?? []).some((e: any) => e.code === 'V1' && /不在动作词表/.test(e.message)));
  const v1Rating = await submitEl({ cycle_count: 15, cv: 0.05, elements: [baseEl({ rating: 1.5 })] });
  checkR('V1 拦截：评比越界(0.70~1.25)', v1Rating, v1Rating.status === 400 && (v1Rating.data?.errors ?? []).some((e: any) => e.code === 'V1' && /评比/.test(e.message)));
  const v1Hand = await submitEl({ cycle_count: 15, cv: 0.05, elements: [baseEl({ hand: 'X' })] });
  checkR('V1 拦截：手别非法', v1Hand, v1Hand.status === 400 && (v1Hand.data?.errors ?? []).some((e: any) => e.code === 'V1' && /手别/.test(e.message)));
  const v1Va = await submitEl({ cycle_count: 15, cv: 0.05, elements: [baseEl({ type: '持住', va_class: 'VA' })] });
  checkR('V1 拦截：VA与默认不符且无改判标记', v1Va, v1Va.status === 400 && (v1Va.data?.errors ?? []).some((e: any) => e.code === 'V1' && /VA类别\(VA\)与类型默认值\(NVA\)不一致/.test(e.message)));
  const v1Outlier = await submitEl({ cycle_count: 15, cv: 0.05, elements: [baseEl({ outlier_flag: 1, outlier_reason: '' })] });
  checkR('V1 拦截：异常要素缺原因', v1Outlier, v1Outlier.status === 400 && (v1Outlier.data?.errors ?? []).some((e: any) => e.code === 'V1' && /异常原因/.test(e.message)));

  // V2 同手时间轴重叠
  const v2Overlap = await submitEl({
    cycle_count: 15, cv: 0.05,
    elements: [baseEl(), baseEl({ seq: 2, start_ms: 3000, dur_s: 2.8, type: '装配', desc: '装前壳到位', va_class: 'VA' })],
  });
  checkR('V2 拦截：R手要素时间重叠', v2Overlap, v2Overlap.status === 400 && (v2Overlap.data?.errors ?? []).some((e: any) => e.code === 'V2' && /重叠200ms/.test(e.message)));

  // v3.29 修复回归（"要素时间重叠"幻影误报）：前端时间数学网格化后，自动链/分割/拖拽产物
  // 一律"起点=前一要素止点、时长 10ms 网格"，止点恒等于 start_ms+round(dur_s*1000) → 零误报
  const v2GridChain = await submitEl({
    cycle_count: 15, cv: 0.05,
    elements: [baseEl(), baseEl({ seq: 2, start_ms: 3200, dur_s: 2.8, type: '装配', desc: '装前壳到位', va_class: 'VA' }),
      baseEl({ seq: 3, start_ms: 6000, dur_s: 0.07, type: '拿取', desc: '取小件', va_class: 'NVA' }),
      baseEl({ seq: 4, start_ms: 6070, dur_s: 1.93, type: '放置', desc: '放小件', va_class: 'RNVA' })],
  });
  checkR('V2 回归：网格化紧贴链零误报', v2GridChain, (v2GridChain.status === 200 || v2GridChain.status === 201));
  // V2 止点改按落库值 round2 判定（"校验什么就存什么"）：3 位小数 dur 的越界在提交前暴露，
  // 而非旧实现"校验放过→落库 round2(1.005)=1.01→重载才报 5ms 幻影"
  const v2Stored = await submitEl({
    cycle_count: 15, cv: 0.05,
    elements: [baseEl({ dur_s: 1.005 }), baseEl({ seq: 2, start_ms: 1005, dur_s: 1.0, type: '装配', desc: '装前壳到位', va_class: 'VA' })],
  });
  checkR('V2 回归：按落库值判定(重叠5ms提交前拦截)', v2Stored, v2Stored.status === 400 && (v2Stored.data?.errors ?? []).some((e: any) => e.code === 'V2' && /重叠5ms/.test(e.message)));

  // V3 循环数
  const v3Low = await submitEl({ cycle_count: 10, cv: 0.05, elements: [baseEl()] });
  checkR('V3 拦截：循环数不足15', v3Low, v3Low.status === 400 && (v3Low.data?.errors ?? []).some((e: any) => e.code === 'V3' && /不足15个/.test(e.message)));
  const v3Cv = await submitEl({ cycle_count: 20, cv: 0.2, elements: [baseEl()] });
  checkR('V3 拦截：CV>0.15 须加测至25', v3Cv, v3Cv.status === 400 && (v3Cv.data?.errors ?? []).some((e: any) => e.code === 'V3' && /加测至25/.test(e.message)));

  // 合法提交（4 要素双手并行；CT=3.68+3.22+2.88+2.30=12.08；L手含 W2 间隙警告）
  const validElements = [
    baseEl(),
    baseEl({ seq: 2, start_ms: 3200, dur_s: 2.8, type: '装配', desc: '装前壳到位', va_class: 'VA' }),
    baseEl({ seq: 3, start_ms: 0, dur_s: 2.5, hand: 'L', type: '持住', desc: '扶住壳体', va_class: 'NVA' }),
    baseEl({ seq: 4, start_ms: 6000, dur_s: 2.0, hand: 'L', type: '可避免延迟', desc: '等传送带', va_class: 'NVA' }),
  ];
  const submitOk = await submitEl({ cycle_count: 15, cv: 0.05, elements: validElements });
  checkR('合法提交 → 200 且 CT=12.08', submitOk, (submitOk.status === 200 || submitOk.status === 201) && submitOk.data?.ct === 12.08 && submitOk.data?.element_count === 4);
  check('W2 间隙警告随提交返回', (submitOk.data?.warnings ?? []).some((w: any) => w.code === 'W2'));

  const elList = await api(base, 'GET', `/api/stations/${elStationId}/elements`, { token: admin.data.accessToken });
  check('要素列表按 seq 升序返回4条', elList.status === 200 && (elList.data?.elements ?? []).length === 4
    && (elList.data?.elements ?? []).map((e: any) => e.seq).join(',') === '1,2,3,4');
  check('要素ID四层一码（工位-版本-序号）', elList.data?.elements?.[0]?.element_id === `${elStationId}-V1-001`);

  const validateOk = await api(base, 'POST', `/api/stations/${elStationId}/elements/validate`, {
    token: admin.data.accessToken, body: { cycle_count: 15, cv: 0.05, elements: validElements },
  });
  checkR('validate 干跑 → ok=true 无错误', validateOk, (validateOk.status === 200 || validateOk.status === 201) && validateOk.data?.ok === true && (validateOk.data?.errors ?? []).length === 0);

  // 写守卫：复测封存 v1 后，bol_version=1 的提交必须 409
  const retest2 = await api(base, 'POST', `/api/stations/${elStationId}/retest`, { token: admin.data.accessToken });
  checkR('开始复测 → v2', retest2, (retest2.status === 200 || retest2.status === 201) && retest2.data?.version === 2);
  const sealedSubmit = await submitEl({ bol_version: 1, cycle_count: 15, cv: 0.05, elements: validElements });
  checkR('写守卫：封存版本提交 → 409', sealedSubmit, sealedSubmit.status === 409);

  // CSV 导入 v2（整批语义：任一行失败整批拒绝）
  // v3.29 修复回归：导入按量化后时长链接——旧实现按 1.996 原值累加 1996ms，落库 round2→2.0s
  // 后重载即报 4ms 幻影重叠；修复后 1.996s→2.0s→链接 2000ms，止点与下一要素起点逐毫秒连续
  const csvGrid = '序号,手别,类型,描述,时长s,VA类别\n1,R,移物,取前壳,1.996,VA\n2,R,装配,装前壳到位,1.0,VA\n';
  const csvGridOk = await api(base, 'POST', `/api/stations/${elStationId}/elements/import`, {
    token: admin.data.accessToken, body: { csv: csvGrid },
  });
  checkR('CSV 导入回归：量化后链接(1.996s→2000ms) → CT=3.45', csvGridOk, (csvGridOk.status === 200 || csvGridOk.status === 201) && csvGridOk.data?.ct === 3.45 && csvGridOk.data?.element_count === 2);
  const csvGridList = await api(base, 'GET', `/api/stations/${elStationId}/elements`, { token: admin.data.accessToken });
  check('CSV 导入回归：第二要素起点=2000ms 且首要素 dur=2（落库即网格值）',
    csvGridList.data?.elements?.[1]?.start_ms === 2000 && csvGridList.data?.elements?.[0]?.dur_s === 2);

  const csvGood = '序号,手别,类型,描述,时长s,VA类别\n1,R,移物,取前壳,3.2,VA\n2,R,装配,装前壳到位,2.8,VA\n3,L,持住,扶住壳体,2.5,NVA\n4,L,可避免延迟,等上件,2.0,NVA\n';
  const csvOk = await api(base, 'POST', `/api/stations/${elStationId}/elements/import`, {
    token: admin.data.accessToken, body: { csv: csvGood },
  });
  checkR('CSV 导入4要素 → 200 且 CT=12.08', csvOk, (csvOk.status === 200 || csvOk.status === 201) && csvOk.data?.ct === 12.08 && csvOk.data?.element_count === 4);
  const csvBad = await api(base, 'POST', `/api/stations/${elStationId}/elements/import`, {
    token: admin.data.accessToken,
    body: { csv: '序号,手别,类型,描述,时长s\n1,R,玄学,不可能的动作,3.2\n2,R,移物,取前壳,2.8\n' },
  });
  checkR('CSV 整批失败（一行坏类型）→ 400', csvBad, csvBad.status === 400 && (csvBad.data?.errors ?? []).some((e: any) => e.code === 'IMPORT' && /不在动作词表/.test(e.message)));

  const csvExport = await api(base, 'GET', `/api/stations/${elStationId}/elements/export`, { token: admin.data.accessToken });
  check('CSV 导出含表头与4行数据', csvExport.status === 200 && /工位编码,版本,序号/.test(csvExport.text ?? '') && (csvExport.text ?? '').split('\r\n').length === 5);

  // VA 改判（留痕标记 + CT 不变：VA 归类不影响 std_time）
  const v2El1 = `${elStationId}-V2-001`;
  const vaOverride = await api(base, 'PATCH', `/api/stations/${elStationId}/elements/${v2El1}/va-class`, {
    token: admin.data.accessToken, body: { va_class: 'NVA', reason: '治具改善后移物可消除' },
  });
  checkR('VA 改判 → 200 且 desc 带 [VA改判| 标记', vaOverride, vaOverride.status === 200 && /\[VA改判\|原:VA\|新:NVA/.test(vaOverride.data?.desc ?? '') && vaOverride.data?.va_class === 'NVA' && vaOverride.data?.ct === 12.08);
  const vaConfirm = await api(base, 'POST', `/api/stations/${elStationId}/elements/${elStationId}-V2-002/va-confirm`, {
    token: admin.data.accessToken, body: { va_class: 'VA' },
  });
  checkR('VA 确认 → 200/201 且 desc 带 [VA确认| 标记', vaConfirm, (vaConfirm.status === 200 || vaConfirm.status === 201) && /\[VA确认\|类:VA/.test(vaConfirm.data?.desc ?? ''));
  const sealedVa = await api(base, 'PATCH', `/api/stations/${elStationId}/elements/${elStationId}-V1-001/va-class`, {
    token: admin.data.accessToken, body: { va_class: 'VA', reason: '封存版本不允许改判' },
  });
  checkR('封存版本 VA 改判 → 409', sealedVa, sealedVa.status === 409);

  // 权限与租户边界
  const viewerElWrite = await submitEl({ cycle_count: 15, cv: 0.05, elements: validElements }, viewer.data.accessToken);
  check('viewer 提交要素 → 403（无 element:write）', viewerElWrite.status === 403, viewerElWrite.data?.detail);
  const crossTenant = await api(base, 'GET', `/api/stations/${elStationId}/elements`, { token: other.data.accessToken });
  check('他租户读要素 → 404（行级隔离）', crossTenant.status === 404, crossTenant.data?.detail);

  // —— 12. 分析引擎（VA 归类 / 6 类浪费 / 双手图 / 产线平衡率）——
  // 12a. 工位分析：沿用 11 节的工位（v2 四要素，CT=12.08；#1 已改判 NVA、#2 已确认 VA）
  const stAnalysis = await api(base, 'GET', `/api/stations/${elStationId}/analysis`, { token: admin.data.accessToken });
  checkR('工位分析 → 200', stAnalysis, stAnalysis.status === 200);
  check('CT=12.08（Σ生效非异常ST）', stAnalysis.data?.metrics?.ct === 12.08, stAnalysis.data?.metrics);
  check('VA/RNVA/NVA 拆分正确（3.22/0/8.86）', stAnalysis.data?.metrics?.va === 3.22 && stAnalysis.data?.metrics?.rnva === 0 && stAnalysis.data?.metrics?.nva === 8.86);
  check('va_pct=26.7 / nva_pct=73.3', stAnalysis.data?.metrics?.va_pct === 26.7 && stAnalysis.data?.metrics?.nva_pct === 73.3);
  check('TT 与缺口（tt=60, gap=-47.92）', stAnalysis.data?.metrics?.tt === 60 && stAnalysis.data?.metrics?.tt_gap === -47.92);
  check('人工裁决优先（#1 改判 NVA、#2 确认 VA）', stAnalysis.data?.elements?.[0]?.va_effective === 'NVA' && stAnalysis.data?.elements?.[0]?.va_confidence === 'human'
    && stAnalysis.data?.elements?.[1]?.va_effective === 'VA' && stAnalysis.data?.elements?.[1]?.va_confidence === 'human');
  const wasteIds = (stAnalysis.data?.wastes ?? []).map((w: any) => w.id);
  check('6 类浪费命中 WT01/WT02(持住) + WT07/WT08(等待)', ['WT01', 'WT02', 'WT07', 'WT08'].every((id) => wasteIds.includes(id)), wasteIds);
  check('持住元素级证据含占用CT比例', (stAnalysis.data?.wastes ?? []).find((w: any) => w.id === 'WT01')?.pct === 20.7);
  check('双手图 cycle_ms=10500 且 L/R 各2段', stAnalysis.data?.hands?.cycle_ms === 10500
    && stAnalysis.data?.hands?.L?.length === 2 && stAnalysis.data?.hands?.R?.length === 2);
  check('规则版本随分析结果带回（与快照一致）',
    stAnalysis.data?.rule_versions?.va_rules === (rules.data as any)?.va_rules?.version
    && stAnalysis.data?.rule_versions?.waste_triggers === (rules.data as any)?.waste_triggers?.version,
    stAnalysis.data?.rule_versions);

  // 12b. 规则例外链：装配desc含"重装"→NVA(low)；定位dur>2→NVA(low)；装配默认→VA(high)
  const vaStationId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await cleanStation(cfg, vaStationId); // 清理历史碰撞（sqlite/mssql 均适用）
  await api(base, 'POST', '/api/stations', {
    token: admin.data.accessToken,
    body: { station_id: vaStationId, line_id: 'L01', name: 'VA归类验证工位', tt: 40 },
  });
  const vaSubmit = await api(base, 'POST', `/api/stations/${vaStationId}/elements/submit`, {
    token: admin.data.accessToken,
    body: {
      cycle_count: 15, cv: 0.05,
      elements: [
        baseEl({ seq: 1, start_ms: 0, dur_s: 2.0, type: '装配', desc: '重装外壳', va_class: 'VA' }),
        baseEl({ seq: 2, start_ms: 2000, dur_s: 2.5, type: '定位', desc: '预对支架', va_class: 'VA' }),
        baseEl({ seq: 3, start_ms: 4500, dur_s: 2.0, type: '装配', desc: '装前壳到位', va_class: 'VA' }),
      ],
    },
  });
  checkR('VA 验证工位提交 → 200', vaSubmit, vaSubmit.status === 200 || vaSubmit.status === 201);
  const vaAnalysis = await api(base, 'GET', `/api/stations/${vaStationId}/analysis`, { token: admin.data.accessToken });
  const vaEls = vaAnalysis.data?.elements ?? [];
  check('例外规则：装配+重装 → NVA（VR05, low）', vaEls[0]?.va_effective === 'NVA' && vaEls[0]?.rule_id === 'VR05' && vaEls[0]?.va_confidence === 'low');
  check('例外规则：定位>2s → NVA（VR04, low）', vaEls[1]?.va_effective === 'NVA' && vaEls[1]?.rule_id === 'VR04' && vaEls[1]?.va_confidence === 'low');
  check('默认规则：装配 → VA（high）', vaEls[2]?.va_effective === 'VA' && vaEls[2]?.rule_id === 'VR05' && vaEls[2]?.va_confidence === 'high');
  check('待复核队列收录 2 条 low 置信要素', (vaAnalysis.data?.pending ?? []).length === 2);
  check('CT=7.48（2.30+2.88+2.30）', vaAnalysis.data?.metrics?.ct === 7.48, vaAnalysis.data?.metrics?.ct);

  // 12c. 产线分析：山积图行 + 平衡率 + 瓶颈榜
  const lineAnalysis = await api(base, 'GET', '/api/lines/L01/analysis', { token: admin.data.accessToken });
  checkR('产线分析 → 200', lineAnalysis, lineAnalysis.status === 200);
  const lineRow = (lineAnalysis.data?.rows ?? []).find((r: any) => r.station_id === elStationId);
  check('山积图行含本工位且 is_bottleneck=true', lineRow?.ct_s === 12.08 && lineRow?.is_bottleneck === true);
  check('平衡率为正数（≤100）', typeof lineAnalysis.data?.balance_rate === 'number' && lineAnalysis.data?.balance_rate > 0 && lineAnalysis.data?.balance_rate <= 100);
  // 注：缺口最大者随测试数据累积而变（VA 工位 -32.52 / 对比工位 -32.29），以"全场最大缺口"断言
  const allRows = lineAnalysis.data?.rows ?? [];
  const maxGap = Math.max(...allRows.map((r: any) => Number(r.ct_s) - Number(r.tt_s)));
  check('瓶颈榜 Top1 = 全场缺口最大工位', Math.abs((lineAnalysis.data?.bottleneck?.[0]?.gap_s ?? NaN) - maxGap) < 0.005
    && (lineAnalysis.data?.bottleneck ?? []).length <= 5, lineAnalysis.data?.bottleneck?.[0]);
  const lineMissing = await api(base, 'GET', '/api/lines/L99/analysis', { token: admin.data.accessToken });
  checkR('不存在的产线 → 404', lineMissing, lineMissing.status === 404);

  // 12d. 权限与租户边界
  // v3.55 起读权限为 ACL×data_scope 双层：viewer 角色有 analysis:read/compare:read（ACL 层），
  // 但 data_scope=own 时看不到他人（owner=admin）的工位 → 403 是**行级不可见**而非 ACL 缺权。
  // 故先经正规 API（PATCH /admin/users/:id 会失效 AuthUserLoader 缓存）把 viewer1 切到 tenant 档，
  // 断言 ACL 放行后立即恢复 own，避免污染后续用例（对齐 acl-guard setScope 模式）。
  const scopeUp = await api(base, 'PATCH', '/api/admin/users/u_viewer1', {
    token: admin.data.accessToken, body: { dataScope: 'tenant' },
  });
  check('viewer1 data_scope 切 tenant 成功', scopeUp.status === 200 || scopeUp.status === 201, scopeUp.data);
  const viewerAnalysis = await api(base, 'GET', `/api/stations/${elStationId}/analysis`, { token: viewer.data.accessToken });
  check('viewer 可查看分析（analysis:read）', viewerAnalysis.status === 200, viewerAnalysis.data);
  const scopeBack = await api(base, 'PATCH', '/api/admin/users/u_viewer1', {
    token: admin.data.accessToken, body: { dataScope: 'own' },
  });
  check('viewer1 data_scope 恢复 own', scopeBack.status === 200 || scopeBack.status === 201, scopeBack.data);
  const crossLine = await api(base, 'GET', '/api/lines/L01/analysis', { token: other.data.accessToken });
  checkR('他租户产线分析 → 404（无 L01 工位）', crossLine, crossLine.status === 404);

  // —— 13. 前后对比与收益（三层配对 / ΔCT / 收益估算 / 一页报告）——
  const cmpStationId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await cleanStation(cfg, cmpStationId); // 清理历史碰撞（sqlite/mssql 均适用）
  await api(base, 'POST', '/api/stations', {
    token: admin.data.accessToken,
    body: { station_id: cmpStationId, line_id: 'L01', name: '对比验证工位', tt: 40 },
  });
  // v1：三要素 CT=9.78
  const cmpV1 = await api(base, 'POST', `/api/stations/${cmpStationId}/elements/submit`, {
    token: admin.data.accessToken,
    body: {
      cycle_count: 15, cv: 0.05,
      elements: [
        baseEl({ seq: 1, start_ms: 0, dur_s: 3.2, type: '移物', desc: '取前壳', va_class: 'VA' }),
        baseEl({ seq: 2, start_ms: 3200, dur_s: 2.8, type: '装配', desc: '装前壳到位', va_class: 'VA' }),
        baseEl({ seq: 3, start_ms: 6000, dur_s: 2.5, type: '持住', desc: '手持住扶壳体', va_class: 'NVA' }),
      ],
    },
  });
  checkR('对比工位 v1 提交 → CT=9.78', cmpV1, (cmpV1.status === 200 || cmpV1.status === 201) && cmpV1.data?.ct === 9.78);
  await api(base, 'POST', `/api/stations/${cmpStationId}/retest`, { token: admin.data.accessToken });
  // v2：装配缩短至2.0、持住消除、新增可避免延迟1.5 → CT=7.71
  const cmpV2 = await api(base, 'POST', `/api/stations/${cmpStationId}/elements/submit`, {
    token: admin.data.accessToken,
    body: {
      bol_version: 2, cycle_count: 15, cv: 0.05,
      elements: [
        baseEl({ seq: 1, start_ms: 0, dur_s: 3.2, type: '移物', desc: '取前壳', va_class: 'VA' }),
        baseEl({ seq: 2, start_ms: 3200, dur_s: 2.0, type: '装配', desc: '装前壳到位', va_class: 'VA' }),
        baseEl({ seq: 3, start_ms: 5200, dur_s: 1.5, type: '可避免延迟', desc: '等上件', va_class: 'NVA' }),
      ],
    },
  });
  checkR('对比工位 v2 提交 → CT=7.71', cmpV2, (cmpV2.status === 200 || cmpV2.status === 201) && cmpV2.data?.ct === 7.71);

  const cmp = await api(base, 'GET', `/api/stations/${cmpStationId}/compare`, { token: admin.data.accessToken });
  checkR('前后对比 → 200（默认最近两版）', cmp, cmp.status === 200);
  check('版本指向 v1→v2', cmp.data?.prev?.version === 1 && cmp.data?.curr?.version === 2);
  check('ΔCT=2.07（工位级权威口径）', cmp.data?.delta_ct === 2.07, cmp.data?.delta_ct);
  check('配对率 67%（2/3 匹配）', cmp.data?.pairing_rate === 67, cmp.data?.pairing_rate);
  const p0 = cmp.data?.pairs?.[0]; const p1 = cmp.data?.pairs?.[1]; const p2 = cmp.data?.pairs?.[2];
  check('L1 精确配对：取前壳 Δstd=0', p0?.quality === 'success' && p0?.rule === 'exact' && p0?.delta_std === 0);
  check('L1 精确配对：装配缩短 Δstd=0.92', p1?.quality === 'success' && p1?.rule === 'exact' && p1?.delta_std === 0.92);
  check('L3 消除：持住未匹配 Δstd=2.88', p2?.quality === 'unmatched' && p2?.rule === 'removed' && p2?.delta_std === 2.88);
  check('新增要素进入 added（可避免延迟）', (cmp.data?.added ?? []).length === 1 && cmp.data?.added?.[0]?.type === '可避免延迟');
  check('消除要素进入 removed（持住）', (cmp.data?.removed ?? []).length === 1 && cmp.data?.removed?.[0]?.type === '持住');
  check('收益估算（2000件/日×45元/h×0.7）= 13222.13 元/年', cmp.data?.benefit?.annual_yuan === 13222.13 && cmp.data?.params_configured === true, cmp.data?.benefit);
  check('配对率≥60% 无低配对警告', (cmp.data?.warnings ?? []).length === 0);

  const cmpQ = await api(base, 'GET', `/api/stations/${cmpStationId}/compare?v1=2&v2=1`, { token: admin.data.accessToken });
  check('显式版本参数对比一致', cmpQ.status === 200 && cmpQ.data?.delta_ct === 2.07);
  const cmpBad = await api(base, 'GET', `/api/stations/${cmpStationId}/compare?v1=9&v2=1`, { token: admin.data.accessToken });
  checkR('不存在版本 → 404', cmpBad, cmpBad.status === 404);
  const cmpSingle = await api(base, 'GET', `/api/stations/${vaStationId}/compare`, { token: admin.data.accessToken });
  checkR('单版本工位对比 → 409', cmpSingle, cmpSingle.status === 409);

  const report = await api(base, 'GET', `/api/stations/${cmpStationId}/compare/report`, { token: admin.data.accessToken });
  checkR('一页对比报告 → 200', report, report.status === 200);
  check('报告 KPI：delta_pct=21.2、消除浪费要素1个', report.data?.kpi?.delta_pct === 21.2 && report.data?.kpi?.removed_elements === 1, report.data?.kpi);
  check('报告含三处签署栏', Array.isArray(report.data?.signatures) && report.data.signatures.length === 3);
  check('报告含改善状态统计', report.data?.kpi?.improvement_stats?.待实施 === 0);

  // viewer 对比：同 12d——compare:read 在 ACL 层已有，需 tenant 档才可见他人工位（v3.55 双层语义）
  const scopeUp2 = await api(base, 'PATCH', '/api/admin/users/u_viewer1', {
    token: admin.data.accessToken, body: { dataScope: 'tenant' },
  });
  check('viewer1 data_scope 切 tenant 成功（对比段）', scopeUp2.status === 200 || scopeUp2.status === 201, scopeUp2.data);
  const viewerCmp = await api(base, 'GET', `/api/stations/${cmpStationId}/compare`, { token: viewer.data.accessToken });
  check('viewer 可查看对比（compare:read）', viewerCmp.status === 200, viewerCmp.data);
  const scopeBack2 = await api(base, 'PATCH', '/api/admin/users/u_viewer1', {
    token: admin.data.accessToken, body: { dataScope: 'own' },
  });
  check('viewer1 data_scope 恢复 own（对比段）', scopeBack2.status === 200 || scopeBack2.status === 201, scopeBack2.data);
  const viewerReport = await api(base, 'GET', `/api/stations/${cmpStationId}/compare/report`, { token: viewer.data.accessToken });
  check('viewer 导出报告 → 403（无 compare:export）', viewerReport.status === 403, viewerReport.data?.detail);
  const crossCmp = await api(base, 'GET', `/api/stations/${cmpStationId}/compare`, { token: other.data.accessToken });
  checkR('他租户对比 → 404（行级隔离）', crossCmp, crossCmp.status === 404);

  // —— 14. 改善建议（ECRSA 映射 / 三因子优先级 / 红线 / 三态流转 / 建议书）——
  const sugStationId = `L01-ST${String(Math.floor(Math.random() * 90) + 10)}`;
  await cleanStation(cfg, sugStationId); // 清理历史碰撞（sqlite/mssql 均适用）
  await api(base, 'POST', '/api/stations', {
    token: admin.data.accessToken,
    body: { station_id: sugStationId, line_id: 'L01', name: '建议验证工位', tt: 40 },
  });
  // v1：持住3.2 + 移物2.8 + 可避免延迟2.5 + 定位2.5 → CT=12.66；浪费：WT01/WT02(持住) + WT05/WT06(搬运) + WT07/WT08(等待)
  const sugSubmit = await api(base, 'POST', `/api/stations/${sugStationId}/elements/submit`, {
    token: admin.data.accessToken,
    body: {
      cycle_count: 15, cv: 0.05,
      elements: [
        baseEl({ seq: 1, start_ms: 0, dur_s: 3.2, type: '持住', desc: '手持住扶壳体', va_class: 'NVA' }),
        baseEl({ seq: 2, start_ms: 3200, dur_s: 2.8, type: '移物', desc: '取前壳', va_class: 'VA' }),
        baseEl({ seq: 3, start_ms: 6000, dur_s: 2.5, type: '可避免延迟', desc: '等上件', va_class: 'NVA' }),
        baseEl({ seq: 4, start_ms: 0, dur_s: 2.5, hand: 'L', type: '定位', desc: '预对支架', va_class: 'VA' }),
      ],
    },
  });
  checkR('建议工位 v1 提交 → CT=12.66', sugSubmit, (sugSubmit.status === 200 || sugSubmit.status === 201) && sugSubmit.data?.ct === 12.66);

  const gen = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/generate`, { token: admin.data.accessToken });
  checkR('候选生成 → 200/201', gen, gen.status === 200 || gen.status === 201);
  const cands = gen.data?.candidates ?? [];
  check('7 条候选（持住M01/M07 + 搬运M04 + 等待M10/M11 + 定位专项M06/M09，重复浪费去重）',
    cands.length === 7 && ['M01', 'M07', 'M04', 'M10', 'M11', 'M06', 'M09'].every((m) => cands.some((c: any) => c.mapping_id === m)),
    cands.map((c: any) => c.mapping_id));
  check('Top1 = M01 持住治具化（priority=100, P1, est_save_s=2.94）',
    cands[0]?.mapping_id === 'M01' && cands[0]?.priority === 100 && cands[0]?.tier === 'P1' && cands[0]?.est_save_s === 2.94, cands[0]);
  const m09 = cands.find((c: any) => c.mapping_id === 'M09');
  const m06 = cands.find((c: any) => c.mapping_id === 'M06');
  check('定位专项 M09 命中（priority=69, P1, 证据含 ST 合计）', m09?.priority === 69 && m09?.tier === 'P1' && /定位要素1个、ST合计2.88s/.test(m09?.evidence ?? ''), m09);
  check('M06 优先级 59（P2）', m06?.priority === 59 && m06?.tier === 'P2', m06);
  check('候选按优先级降序', cands.every((c: any, i: number) => i === 0 || cands[i - 1].priority >= c.priority));
  check('CT=12.66 随候选结果带回', gen.data?.ct === 12.66);
  check('日产量已配置（freq_configured=true, 2000件/日, 无提示）', gen.data?.freq_configured === true && gen.data?.daily_output === 2000 && gen.data?.note === null);
  check('规则版本带回（ecrsa_map 与快照一致）', gen.data?.rule_versions?.ecrsa_map === (rules.data as any)?.ecrsa_map?.version, gen.data?.rule_versions);
  const beforeAdopt = await api(base, 'GET', `/api/improvements?station_id=${sugStationId}`, { token: admin.data.accessToken });
  check('候选不落库（铁律①：生成后建议清单仍为空）', beforeAdopt.status === 200 && (beforeAdopt.data?.improvements ?? []).length === 0);

  // 采纳真实候选（M01）
  const adopt1 = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/adopt`, {
    token: admin.data.accessToken,
    body: { candidates: [cands[0]] },
  });
  checkR('采纳 M01 → 200/201 且 imp_id 带工位前缀', adopt1, (adopt1.status === 200 || adopt1.status === 201)
    && adopt1.data?.created === 1 && new RegExp(`^IMP-${sugStationId}-\\d+-01$`).test(adopt1.data?.imp_ids?.[0] ?? ''));
  const imp1 = adopt1.data?.imp_ids?.[0] ?? '';

  const impList = await api(base, 'GET', `/api/improvements?station_id=${sugStationId}`, { token: admin.data.accessToken });
  checkR('建议清单 → 200', impList, impList.status === 200);
  check('清单字段：待实施 / before_ct=12.66 / priority=100 / 带工位名',
    (impList.data?.improvements ?? []).length === 1 && impList.data.improvements[0].status === '待实施'
    && impList.data.improvements[0].before_ct === 12.66 && impList.data.improvements[0].priority === 100
    && impList.data.improvements[0].station_name === '建议验证工位', impList.data?.improvements?.[0]);

  // 三态流转
  const toDone = await api(base, 'PATCH', `/api/improvements/${imp1}/status`, { token: admin.data.accessToken, body: { status: '已完成' } });
  checkR('待实施 → 已完成', toDone, toDone.status === 200 && toDone.data?.status === '已完成');
  const backStep = await api(base, 'PATCH', `/api/improvements/${imp1}/status`, { token: admin.data.accessToken, body: { status: '待实施' } });
  checkR('非法回流（已完成→待实施）→ 409 且带回合法迁移表', backStep, backStep.status === 409
    && Array.isArray(backStep.data?.allowed) && backStep.data.allowed.includes('已验证'));
  const earlyVerify = await api(base, 'PATCH', `/api/improvements/${imp1}/status`, { token: admin.data.accessToken, body: { status: '已验证' } });
  checkR('无复测版置已验证 → 409（提示先复测）', earlyVerify, earlyVerify.status === 409 && /尚未复测/.test(earlyVerify.data?.detail ?? '') && /开始复测/.test(earlyVerify.data?.hint ?? ''));

  // 红线：品质 / 人因（未确认 422，确认后放行并留痕）
  const qualityCand = { mapping_id: null, waste_type: '检验冗余', method: 'E', measure: '取消重复确认/合并检验（须品质确认）', element_ids: [], est_save_s: 1.0, difficulty: 1, priority: 50 };
  const redQ = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/adopt`, {
    token: admin.data.accessToken, body: { candidates: [qualityCand] },
  });
  checkR('品质红线未确认 → 422 REDLINE_CONFIRM_REQUIRED', redQ, redQ.status === 422
    && redQ.data?.code === 'REDLINE_CONFIRM_REQUIRED' && (redQ.data?.requires ?? []).some((r: any) => r.type === 'quality'));
  const adoptQ = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/adopt`, {
    token: admin.data.accessToken,
    body: { candidates: [qualityCand], confirmations: { quality: { name: '张品质' } } },
  });
  checkR('品质确认后采纳 → 200/201', adoptQ, (adoptQ.status === 200 || adoptQ.status === 201) && adoptQ.data?.created === 1);

  const ergoCand = { mapping_id: null, waste_type: '持住', method: 'E', measure: '治具代手持住，避免弯腰操作', element_ids: [], est_save_s: 1.0, difficulty: 1, priority: 50 };
  const redE = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/adopt`, {
    token: admin.data.accessToken, body: { candidates: [ergoCand] },
  });
  checkR('人因红线未确认 → 422', redE, redE.status === 422 && (redE.data?.requires ?? []).some((r: any) => r.type === 'ergonomics'));
  const adoptE = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/adopt`, {
    token: admin.data.accessToken,
    body: { candidates: [ergoCand], confirmations: { ergonomics: { name: '李人因' } } },
  });
  checkR('人因复核后采纳 → 200/201', adoptE, adoptE.status === 200 || adoptE.status === 201);

  const emptyAdopt = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/adopt`, {
    token: admin.data.accessToken, body: { candidates: [] },
  });
  checkR('空采纳 → 400', emptyAdopt, emptyAdopt.status === 400);

  const impList2 = await api(base, 'GET', `/api/improvements?station_id=${sugStationId}`, { token: admin.data.accessToken });
  const imps2 = impList2.data?.improvements ?? [];
  check('红线确认标记写入 measure 尾部（[品质确认:张品质 …]/[人因复核:李人因 …]）',
    imps2.length === 3 && imps2.some((i: any) => /\[品质确认:张品质 \d{4}-\d{2}-\d{2}\]/.test(i.measure))
    && imps2.some((i: any) => /\[人因复核:李人因 \d{4}-\d{2}-\d{2}\]/.test(i.measure)), imps2.map((i: any) => i.measure));

  // 复测后置已验证（回填 after_ct=当前版CT）
  await api(base, 'POST', `/api/stations/${sugStationId}/retest`, { token: admin.data.accessToken });
  const sugV2 = await api(base, 'POST', `/api/stations/${sugStationId}/elements/submit`, {
    token: admin.data.accessToken,
    body: {
      bol_version: 2, cycle_count: 15, cv: 0.05,
      elements: [
        baseEl({ seq: 1, start_ms: 0, dur_s: 2.0, type: '持住', desc: '手持住扶壳体', va_class: 'NVA' }),
        baseEl({ seq: 2, start_ms: 2000, dur_s: 2.8, type: '移物', desc: '取前壳', va_class: 'VA' }),
        baseEl({ seq: 3, start_ms: 4800, dur_s: 2.5, type: '可避免延迟', desc: '等上件', va_class: 'NVA' }),
        baseEl({ seq: 4, start_ms: 0, dur_s: 2.5, hand: 'L', type: '定位', desc: '预对支架', va_class: 'VA' }),
      ],
    },
  });
  checkR('建议工位 v2 提交 → CT=11.28（持住缩短2.0s）', sugV2, (sugV2.status === 200 || sugV2.status === 201) && sugV2.data?.ct === 11.28);
  const verify1 = await api(base, 'PATCH', `/api/improvements/${imp1}/status`, { token: admin.data.accessToken, body: { status: '已验证' } });
  checkR('已完成 → 已验证（回填 after_ct=11.28）', verify1, verify1.status === 200 && verify1.data?.status === '已验证' && verify1.data?.after_ct === 11.28);
  const byStatus = await api(base, 'GET', `/api/improvements?status=已验证&station_id=${sugStationId}`, { token: admin.data.accessToken });
  check('按状态过滤清单（已验证1条）', byStatus.status === 200 && (byStatus.data?.improvements ?? []).length === 1 && byStatus.data.improvements[0].imp_id === imp1);

  // 建议书一页报告
  const sugReport = await api(base, 'GET', `/api/improvements/${imp1}/report`, { token: admin.data.accessToken });
  checkR('建议书一页报告 → 200', sugReport, sugReport.status === 200);
  check('报告头：工位/版本v2/生成人=admin', sugReport.data?.header?.station_id === sugStationId
    && sugReport.data?.header?.version === 2 && sugReport.data?.header?.generated_by === 'admin', sugReport.data?.header);
  check('问题区：涉及要素按ID解析（持住1条，v1 快照 ST=3.68）',
    (sugReport.data?.problem?.involved ?? []).length === 1 && sugReport.data.problem.involved[0].desc === '手持住扶壳体'
    && sugReport.data.problem.involved[0].std_time === 3.68, sugReport.data?.problem?.involved);
  check('收益区：年化=18779.25 元（2.94s×2000件×365×45元/h÷3600×0.7）',
    sugReport.data?.benefit?.annual_yuan === 18779.25 && sugReport.data?.benefit?.before_ct === 12.66
    && sugReport.data?.benefit?.after_ct === 11.28 && sugReport.data?.benefit?.params_configured === true, sugReport.data?.benefit);
  check('报告含5步实施指引与4栏签署', (sugReport.data?.steps ?? []).length === 5 && (sugReport.data?.signatures ?? []).length === 4);
  check('报告状态=已验证', sugReport.data?.status === '已验证');

  // 权限与租户边界
  const viewerGen = await api(base, 'POST', `/api/stations/${sugStationId}/suggestions/generate`, { token: viewer.data.accessToken });
  check('viewer 生成候选 → 403（无 suggestion:generate）', viewerGen.status === 403, viewerGen.data?.detail);
  const viewerImp = await api(base, 'GET', '/api/improvements', { token: viewer.data.accessToken });
  check('viewer 读建议清单 → 403', viewerImp.status === 403);
  const viewerStatus = await api(base, 'PATCH', `/api/improvements/${imp1}/status`, { token: viewer.data.accessToken, body: { status: '已完成' } });
  check('viewer 流转状态 → 403', viewerStatus.status === 403);
  const crossImp = await api(base, 'GET', `/api/improvements?station_id=${sugStationId}`, { token: other.data.accessToken });
  check('他租户读建议清单 → 空（行级隔离）', crossImp.status === 200 && (crossImp.data?.improvements ?? []).length === 0);
  const crossReport = await api(base, 'GET', `/api/improvements/${imp1}/report`, { token: other.data.accessToken });
  checkR('他租户读建议书 → 404（行级隔离）', crossReport, crossReport.status === 404);

  // —— 收尾：清理冒烟创建的测试工位（防历史积累污染工位清单）——
  for (const sid of [newStationId, elStationId, vaStationId, cmpStationId, sugStationId]) {
    try { await cleanStation(cfg, sid); } catch { /* 清理失败不影响结果判定 */ }
  }
  // 收尾：解锁登录锁定测试的副作用账号（leader1），恢复种子可用状态
  try { await unlockUser(cfg, 'leader1'); } catch { /* 清理失败不影响结果判定 */ }

  // —— 汇总 ——
  await app.close();
  console.log(`\n结果: ${ok} 通过 / ${fail} 失败\n`);
  if (fail > 0) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((e) => { console.error('冒烟执行异常:', e); process.exit(1); });
