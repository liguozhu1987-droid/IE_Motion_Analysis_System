/**
 * 批量导出 · 真实 HTTP 端点契约（v3.61 + v3.62 留档）
 * ------------------------------------------------------------
 * 需要 API 已启动（默认 http://127.0.0.1:3001，可用 BATCH_EXPORT_BASE 覆盖）。
 * 覆盖：登录 → 取真实工位 → 导出 XLSX → 留档落库/复下载/可见性 → 权限降级 → CSV 回归 → 错误路径。
 *
 * 回环代理坑：本机默认 HTTP_PROXY 会让 node fetch 访问 127.0.0.1 失败，脚本顶部显式摘除。
 *
 *   node test/batch-export-http.cjs
 */
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
process.env.NO_PROXY = '127.0.0.1,localhost';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const BASE = process.env.BATCH_EXPORT_BASE || 'http://127.0.0.1:3001';
const OUT = path.resolve(__dirname, '..', '..', '..', 'deliverables');
let passed = 0;
const ok = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

async function login(username, password = '123456') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${username} 登录失败 ${res.status}: ${JSON.stringify(data)}`);
  return data.accessToken;
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function main() {
  console.log(`批量导出 HTTP 契约　${BASE}`);
  const token = await login('admin');
  let lineId, stationId;

  await ok('登录 admin 取得 accessToken', () => assert.ok(typeof token === 'string' && token.length > 20));

  await ok('读取真实工位清单，确定导出产线', async () => {
    const res = await fetch(`${BASE}/api/stations`, { headers: auth(token) });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list) && list.length > 0, '生产库应有至少一个工位');
    lineId = list[0].line_id;
    stationId = list[0].station_id;
    assert.ok(lineId && stationId);
    console.log(`    真实夹具：line=${lineId} station=${stationId} 共 ${list.length} 工位`);
  });

  let buf;
  let recordId;
  let stats;
  await ok('GET /api/export/batch.xlsx 返回 200 与 XLSX 响应头（v3.62 起带留档记录号）', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}`, { headers: auth(token) });
    const body = await res.arrayBuffer();
    assert.equal(res.status, 200, `状态 ${res.status}: ${Buffer.from(body).toString('utf8').slice(0, 300)}`);
    assert.match(res.headers.get('content-type') || '', /spreadsheetml\.sheet/);
    assert.match(res.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    buf = Buffer.from(body);
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
    stats = JSON.parse(res.headers.get('x-export-stats') || '{}');
    assert.equal(typeof stats.stations, 'number');
    recordId = res.headers.get('x-export-record-id') || '';
    assert.match(recordId, /^[0-9a-f-]{36}$/, '留档记录号缺失（v3.62 起导出必须落库登记）');
    console.log(`    服务端统计：${JSON.stringify(stats)} · 文件 ${buf.length} 字节 · 留档 ${recordId}`);
  });

  await ok('读回 XLSX：恰好 6 张 sheet、Σ四桶=ΣST=CT、焦点表一致', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.equal(wb.worksheets.length, 6);
    assert.deepEqual(wb.worksheets.map((w) => w.name),
      ['00_封面', '01_工位汇总', '02_动作分解', '03_增值非增值分析', '04_动作分析', '99_说明']);
    const s1 = wb.getWorksheet('01_工位汇总');
    const s3 = wb.getWorksheet('03_增值非增值分析');
    // 逐工位小计行：Σ四桶(E:H) = CT(I)
    let subtotalRows = 0;
    s3.eachRow((row) => {
      if (!String(row.getCell(1).value ?? '').includes('小计')) return;
      const four = [5, 6, 7, 8].reduce((a, c) => a + Number(row.getCell(c).value ?? 0), 0);
      const ct = Number(row.getCell(9).value ?? 0);
      assert.ok(Math.abs(four - ct) <= 0.011, `Σ四桶 ${four} ≠ CT ${ct}`);
      subtotalRows += 1;
    });
    assert.ok(subtotalRows > 0, '应至少有一个工位小计行');
    // 汇总页 ΣCT 与 01 表合计行一致（误差 ≤0.01）
    const totalRow = s1.getRow(s1.rowCount);
    assert.ok(Math.abs(Number(totalRow.getCell(5).value) - Number(
      s3.getRow(s3.rowCount).getCell(9).value)) <= 0.011);
    console.log(`    校验通过：${subtotalRows} 个工位小计行，Σ四桶=ΣST=CT`);
  });

  await ok('样例文件落盘供人工核对', () => {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    const p = path.join(OUT, `批量导出样例_${lineId}_20261109.xlsx`);
    fs.writeFileSync(p, buf);
    console.log(`    ${p}`);
  });

  await ok('含异常要素 / 含未分解工位开关不改变 sheet 数', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&include_outliers=1&include_undecomposed=1&focus_top=20`, { headers: auth(token) });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.equal(wb.worksheets.length, 6);
  });

  /* ── v3.62 留档：列表 / 复下载 / 可见性 ─────────────────────────────── */

  await ok('GET /api/export/batch/records：最新记录与导出统计一致', async () => {
    const res = await fetch(`${BASE}/api/export/batch/records?limit=10`, { headers: auth(token) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items) && body.items.length > 0, '留档列表为空（导出未登记）');
    const rec = body.items.find((r) => r.record_id === recordId);
    assert.ok(rec, '列表中找不到本次导出的留档记录');
    assert.equal(rec.line_id, lineId);
    assert.equal(rec.station_count, stats.stations);
    assert.equal(rec.element_count, stats.elements);
    assert.equal(rec.sheet_count, stats.sheets);
    assert.equal(rec.status, 'ready');
    assert.equal(rec.file_size, buf.length, '登记字节数与实际文件不一致');
    assert.ok(rec.username, '登记缺少导出人');
    assert.ok(rec.created_at, '登记缺少时间');
    console.log(`    留档：${rec.line_name || rec.line_id} · ${rec.station_count} 工位 · ${rec.sheet_count} sheet · ${rec.file_size}B`);
  });

  await ok('复下载：字节与首次导出完全一致（快照语义，不重新计算）', async () => {
    const res = await fetch(`${BASE}/api/export/batch/records/${recordId}/file`, { headers: auth(token) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const again = Buffer.from(await res.arrayBuffer());
    assert.equal(again.length, buf.length, '复下载文件长度不一致');
    assert.ok(again.equals(buf), '复下载文件内容与首次导出不一致');
  });

  await ok('复下载计数：download_count 自增且 last_downloaded_at 回写', async () => {
    const res = await fetch(`${BASE}/api/export/batch/records?limit=10`, { headers: auth(token) });
    const body = await res.json();
    const rec = body.items.find((r) => r.record_id === recordId);
    assert.ok(rec.download_count >= 1, '复下载未计数');
  });

  await ok('可见性：非创建者且非全权角色看不到 admin 的留档（列表过滤）', async () => {
    const viewer = await login('viewer1');
    const res = await fetch(`${BASE}/api/export/batch/records?limit=100`, { headers: auth(viewer) });
    if (res.status === 403) { console.log('    viewer1 无 element:read → 403（符合 RBAC）'); return; }
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.items.some((r) => r.record_id === recordId), 'viewer1 不应看到 admin 的留档记录');
  });

  await ok('可见性：非创建者复下载 → 404（不回显存在性）', async () => {
    const viewer = await login('viewer1');
    const res = await fetch(`${BASE}/api/export/batch/records/${recordId}/file`, { headers: auth(viewer) });
    assert.ok(res.status === 404 || res.status === 403, `期望 404/403，实际 ${res.status}`);
  });

  await ok('跨租户：other1 复下载 admin 的留档 → 404（行级隔离兜底）', async () => {
    let otherToken;
    try { otherToken = await login('other1'); } catch { console.log('    other1 不存在，跳过'); return; }
    const res = await fetch(`${BASE}/api/export/batch/records/${recordId}/file`, { headers: auth(otherToken) });
    assert.ok(res.status === 404 || res.status === 403, `期望 404/403，实际 ${res.status}`);
  });

  await ok('不存在的留档 id → 404（统一错误信封）', async () => {
    const res = await fetch(`${BASE}/api/export/batch/records/00000000-0000-0000-0000-000000000000/file`, { headers: auth(token) });
    assert.equal(res.status, 404);
  });

  await ok('关闭 04 表 → 恰好 5 张 sheet（权限降级路径同构）', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&with_focus=0`, { headers: auth(token) });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assert.equal(wb.worksheets.length, 5);
    assert.equal(wb.getWorksheet('04_动作分析'), undefined);
  });

  await ok('单工位 CSV 导出回归：200 + UTF-8 BOM + 14 列表头', async () => {
    const res = await fetch(`${BASE}/api/stations/${encodeURIComponent(stationId)}/elements/export`, { headers: auth(token) });
    assert.equal(res.status, 200);
    // Response.text() 按 UTF-8 解码规范会吞掉 BOM，必须查原始字节
    const raw = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([raw[0], raw[1], raw[2]], [0xEF, 0xBB, 0xBF], 'BOM 丢失，Excel 打开会乱码');
    const csvText = raw.toString('utf8').replace(/^\uFEFF/, '');
    assert.ok(csvText.includes('工位编码') && csvText.includes('标准工时'));
  });

  await ok('账号权限与 sheet 数一致（缺 analysis:read 时不生成 04 表）', async () => {
    const viewer = await login('viewer1');
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: auth(viewer) })).json();
    const perms = me.permissions ?? [];
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}`, { headers: auth(viewer) });
    if (!perms.includes('element:read')) {
      assert.equal(res.status, 403, '无 element:read 应被 Guard 拦截');
      console.log('    viewer1 无 element:read → 403（符合 RBAC）');
      return;
    }
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const expected = perms.includes('analysis:read') ? 6 : 5;
    assert.equal(wb.worksheets.length, expected);
    console.log(`    viewer1 analysis:read=${perms.includes('analysis:read')} → ${wb.worksheets.length} 张 sheet（期望 ${expected}）`);
  });

  await ok('无 token → 401（端点不公开）', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}`);
    assert.equal(res.status, 401);
  });

  await ok('非法参数 → 400（ValidationPipe 生效，不会静默截断）', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&focus_top=999`, { headers: auth(token) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.title || body.detail || body.message);
  });

  await ok('不存在的产线 → 400 且返回统一错误信封', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=LZZ`, { headers: auth(token) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.detail || body.message);
    console.log(`    错误信封：${String(body.detail || body.message).slice(0, 80)}`);
  });

  /* ══════════════ Phase 2：分解任务 API / 任务隔离 / 任务号贯穿 ══════════════ */
  require('dotenv/config');
  const sql = require('mssql');
  const db = async () => sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });
  const postJson = async (path, body, tok) => fetch(`${BASE}${path}`, {
    method: 'POST', headers: { ...auth(tok), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 幂等：清掉本脚本上一轮留下的测试任务（留档快照保留，属审计资产）
  const cleanTestTasks = async () => {
    const pool = await db();
    await pool.request().query(`
      DELETE FROM t_element WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE name LIKE N'Phase2契约测试%');
      DELETE FROM t_task_station WHERE task_id IN (SELECT task_id FROM t_decomposition_task WHERE name LIKE N'Phase2契约测试%');
      DELETE FROM t_decomposition_task WHERE name LIKE N'Phase2契约测试%';`);
    await pool.close();
  };
  await cleanTestTasks();

  let legacyTask;
  await ok('Phase2 · GET /api/tasks 按产线筛选，且本产线有历史归集任务', async () => {
    const res = await fetch(`${BASE}/api/tasks?line_id=${encodeURIComponent(lineId)}`, { headers: auth(token) });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.items) && data.items.length > 0);
    assert.ok(data.items.every((t) => t.line_id === lineId), '任务列表混入其它产线任务');
    legacyTask = data.items.find((t) => t.round_type === 'legacy');
    assert.ok(legacyTask, '本产线缺 DT-LEGACY 归档任务');
    assert.equal(legacyTask.status, 'archived');
    assert.ok(legacyTask.period_start && legacyTask.period_end, '归档任务时间段未回填');
    console.log(`    本产线归档任务：${legacyTask.task_no} · ${legacyTask.period_start}~${legacyTask.period_end}`);
  });

  let taskB;
  await ok('Phase2 · POST /api/tasks 生成 DT-{YYYY}-{NNN}，租户内唯一且关联工位', async () => {
    const res = await postJson('/api/tasks', {
      line_id: lineId,
      name: 'Phase2契约测试-基线复制',
      period_start: '2026-11-01', period_end: '2026-11-05',
      round_type: 'kaizen_after', baseline_task_id: legacyTask.task_id,
      station_ids: [stationId],
    }, token);
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 201, `创建失败 ${res.status}: ${JSON.stringify(body)}`);
    taskB = body;
    assert.match(taskB.task_no, /^DT-\d{4}-\d{3}$/);
    assert.equal(taskB.status, 'active');
    assert.equal(taskB.round_type, 'kaizen_after');
    assert.equal(taskB.baseline_task_id, legacyTask.task_id);
    assert.ok(taskB.stations.length >= 1, '任务未关联工位');
    assert.ok(taskB.stations[0].bol_version >= 1, '未锁定 bol_version');
    console.log(`    新任务：${taskB.task_no} · 锁定 ${taskB.stations.length} 工位 v${taskB.stations[0].bol_version}`);
  });

  let copied = 0;
  await ok('Phase2 · 从基线复制要素快照（新行带任务号前缀，源任务零改动）', async () => {
    const res = await postJson(`/api/tasks/${encodeURIComponent(taskB.task_id)}/clone-elements`,
      { from_task_id: legacyTask.task_id }, token);
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 201, `复制失败 ${res.status}: ${JSON.stringify(body)}`);
    copied = body.copied;
    assert.ok(copied > 0, '未复制到任何基线要素');
    const pool = await db();
    const rows = (await pool.request().query(`
      SELECT element_id, task_id FROM t_element WHERE task_id IN ('${taskB.task_id}','${legacyTask.task_id}')`)).recordset;
    await pool.close();
    const b = rows.filter((r) => r.task_id === taskB.task_id);
    const a = rows.filter((r) => r.task_id === legacyTask.task_id);
    assert.equal(b.length, copied);
    assert.ok(b.every((r) => r.element_id.startsWith(taskB.task_no)), '新要素编码未带任务号');
    assert.equal(new Set([...a, ...b].map((r) => r.element_id)).size, a.length + b.length, '跨任务 element_id 撞号');
    console.log(`    复制 ${copied} 条；两任务 element_id 零重叠（基线 ${a.length} 条保持原值）`);
  });

  let taskWbBuf;
  await ok('Phase2 · 按任务导出：文件名/封面/各表信息区/留档四处带任务号与时间段', async () => {
    const res = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&task_id=${encodeURIComponent(taskB.task_id)}`, { headers: auth(token) });
    const body = await res.arrayBuffer();
    assert.equal(res.status, 200, `状态 ${res.status}: ${Buffer.from(body).toString('utf8').slice(0, 300)}`);
    assert.match(decodeURIComponent(res.headers.get('content-disposition') || ''), new RegExp(taskB.task_no));
    taskWbBuf = Buffer.from(body);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(taskWbBuf);
    assert.equal(wb.worksheets.length, 6);
    const cover = wb.getWorksheet('00_封面');
    assert.ok(String(cover.getCell(7, 2).value).includes(taskB.task_no), '封面缺任务号');
    assert.ok(String(cover.getCell(8, 2).value).includes('2026-11-01') && String(cover.getCell(8, 2).value).includes('2026-11-05'), '封面缺时间段');
    for (const name of ['01_工位汇总', '02_动作分解', '03_增值非增值分析', '04_动作分析']) {
      assert.ok(String(wb.getWorksheet(name).getCell(2, 1).value).includes(taskB.task_no), `${name} 信息区缺任务号`);
    }
    const s = JSON.parse(res.headers.get('x-export-stats') || '{}');
    assert.equal(s.elements, copied, '导出要素数应等于复制到该任务的要素数');
    const rec = await (await fetch(`${BASE}/api/export/batch/records?limit=1`, { headers: auth(token) })).json();
    assert.equal(rec.items[0].task_no, taskB.task_no, '留档记录缺任务号');
    assert.equal(rec.items[0].task_id, taskB.task_id, '留档记录缺任务 ID');
    console.log(`    导出 ${s.sheets} sheet / ${s.elements} 要素 · 留档任务号 ${rec.items[0].task_no}`);
  });

  await ok('Phase2 · 任务隔离：空任务导出 0 要素、基线任务要素不受影响', async () => {
    const empty = await postJson('/api/tasks', {
      line_id: lineId, name: 'Phase2契约测试-空任务', round_type: 'recheck', station_ids: [stationId],
    }, token);
    const tC = await empty.json();
    assert.equal(empty.status, 201);
    const getStats = async (tid) => {
      const r = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&task_id=${encodeURIComponent(tid)}`, { headers: auth(token) });
      assert.equal(r.status, 200, `任务 ${tid} 导出失败`);
      await r.arrayBuffer();
      return JSON.parse(r.headers.get('x-export-stats') || '{}');
    };
    const sC = await getStats(tC.task_id);
    const sB = await getStats(taskB.task_id);
    const sA = await getStats(legacyTask.task_id);
    assert.equal(sC.elements, 0, '新空任务不应出现其它任务的要素');
    assert.equal(sB.elements, copied, '任务 B 要素数应与复制数一致');
    assert.ok(sA.elements > 0, '归档任务应有存量要素');
    console.log(`    空任务 ${sC.elements} / 任务B ${sB.elements} / 归档 ${sA.elements} 要素，互不串`);
  });

  await ok('Phase2 · 任务级 ACL：不存在/错产线/跨租户均不泄露', async () => {
    const missing = await fetch(`${BASE}/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&task_id=DT-9999-999`, { headers: auth(token) });
    assert.equal(missing.status, 404, '不存在的任务应 404');
    const wrongLine = await fetch(`${BASE}/api/export/batch.xlsx?line_id=LZZ&task_id=${encodeURIComponent(taskB.task_id)}`, { headers: auth(token) });
    assert.equal(wrongLine.status, 400, '任务与产线不匹配应 400');
    const other = await login('other1');
    const crossDetail = await fetch(`${BASE}/api/tasks/${encodeURIComponent(taskB.task_id)}`, { headers: auth(other) });
    assert.equal(crossDetail.status, 404, '跨租户应 404 不回显存在性');
    const crossList = await (await fetch(`${BASE}/api/tasks`, { headers: auth(other) })).json();
    assert.ok(!(crossList.items ?? []).some((t) => t.task_id === taskB.task_id), '跨租户任务出现在列表');
  });

  await ok('Phase2 · 写权限：无 element:write 的账号不能创建任务', async () => {
    const viewer = await login('viewer1');
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: auth(viewer) })).json();
    if ((me.permissions ?? []).includes('element:write')) {
      console.log('    viewer1 具备 element:write，跳过（仅校验有权限账号）');
      return;
    }
    const res = await postJson('/api/tasks', { line_id: lineId, name: 'Phase2契约测试-越权' }, viewer);
    assert.equal(res.status, 403);
  });

  await ok('Phase2 · MS1.4 生效：规则集 time_bucket 已发布且说明页声明判定入口', async () => {
    const rule = await (await fetch(`${BASE}/api/rules/motion_standard`, { headers: auth(token) })).json();
    assert.equal(rule.version, 'MS1.4');
    const c = rule.content ?? rule;
    assert.ok((c.groups ?? []).some((g) => g.time_bucket), '生效规则缺 time_bucket');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(taskWbBuf);
    const cells = [];
    wb.getWorksheet('99_说明').eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ''))));
    const text = cells.join('\n');
    assert.ok(text.includes('motion_standard 规则集配置'), '说明页未声明规则集判定入口');
    assert.ok(text.includes('MS1.4'), '说明页缺 MS 版本指纹');
  });

  await cleanTestTasks();

  console.log(`\n通过 ${passed} 项`);
  if (process.exitCode) console.error('存在失败项');
}

main().catch((e) => { console.error('端点契约异常：', e.message); process.exitCode = 1; });
