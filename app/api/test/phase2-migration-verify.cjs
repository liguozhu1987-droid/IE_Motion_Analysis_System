/**
 * Phase 2 · 生产 mssql 迁移与存量回填验证（只读，不修改任何数据）
 * ------------------------------------------------------------
 * 前置：已执行 `npm run migrate:prod`。读取 app/api/.env 的 DB_* 配置直连 SQL Server。
 * 覆盖：新表存在 / 列长 48→96 / task_id 补列 / DT-LEGACY 归档任务 / 工位关联 /
 *       存量要素归集无孤儿 / 存量 element_id 未被重写 / 唯一键含 task_id / 留档表任务维度。
 *
 *   cd app/api && node test/phase2-migration-verify.cjs
 */
require('dotenv/config');
const assert = require('node:assert/strict');
const sql = require('mssql');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

(async () => {
  const cfg = {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  };
  const pool = await sql.connect(cfg);
  const q = async (text) => (await pool.request().query(text)).recordset;

  const tables = (await q(`SELECT name FROM sys.tables WHERE name IN
    ('t_decomposition_task','t_task_station','t_element','t_batch_export_record')`)).map((r) => r.name);
  ok('四张相关表全部存在', () => {
    for (const t of ['t_decomposition_task', 't_task_station', 't_element', 't_batch_export_record']) {
      assert.ok(tables.includes(t), `缺表 ${t}`);
    }
  });

  const cols = await q(`SELECT t.name AS tbl, c.name AS col, c.max_length, c.is_nullable
    FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
    WHERE (t.name = 't_element' AND c.name IN ('element_id','task_id'))
       OR (t.name = 't_batch_export_record' AND c.name IN ('task_id','task_no'))`);
  const col = (tbl, name) => cols.find((c) => c.tbl === tbl && c.col === name);
  ok('t_element.element_id 已扩至 NVARCHAR(96)（max_length=192 字节）', () => {
    assert.equal(col('t_element', 'element_id')?.max_length, 192);
  });
  ok('t_element.task_id 已补列且 NOT NULL', () => {
    assert.ok(col('t_element', 'task_id'), '缺列');
    assert.equal(col('t_element', 'task_id').is_nullable, false);
  });
  ok('t_batch_export_record 已补 task_id / task_no（可空，兼容 v3.62 存量行）', () => {
    assert.ok(col('t_batch_export_record', 'task_id'));
    assert.ok(col('t_batch_export_record', 'task_no'));
  });

  const legacy = await q(`SELECT task_id, tenant_id, task_no, line_id, round_type, status, period_start, period_end
    FROM t_decomposition_task WHERE round_type = 'legacy'`);
  const lines = await q(`SELECT DISTINCT line_id FROM t_station`);
  ok('每产线各一条 DT-LEGACY 归档任务（单产线硬约束），首条固定 DT-LEGACY', () => {
    assert.equal(legacy.length, lines.length, `任务 ${legacy.length} / 产线 ${lines.length}`);
    assert.equal(legacy.filter((t) => t.task_id === 'DT-LEGACY').length, 1, '缺固定 id DT-LEGACY');
    for (const t of legacy) {
      assert.equal(t.status, 'archived');
      assert.equal(t.round_type, 'legacy');
      assert.ok(t.period_start && t.period_end, '时间段未回填');
      assert.ok(lines.some((l) => l.line_id === t.line_id), `任务 ${t.task_id} 的产线不存在`);
    }
    // 任务号租户内唯一
    assert.equal(new Set(legacy.map((t) => `${t.tenant_id}|${t.task_no}`)).size, legacy.length);
  });

  const ts = await q(`SELECT COUNT(*) AS n FROM t_task_station ts
    JOIN t_decomposition_task t ON t.task_id = ts.task_id AND t.round_type = 'legacy'
    JOIN t_station s ON s.station_id = ts.station_id AND s.tenant_id = ts.tenant_id
    WHERE t.line_id = s.line_id`);
  const cross = await q(`SELECT COUNT(*) AS n FROM t_task_station ts
    JOIN t_decomposition_task t ON t.task_id = ts.task_id AND t.round_type = 'legacy'
    JOIN t_station s ON s.station_id = ts.station_id AND s.tenant_id = ts.tenant_id
    WHERE t.line_id <> s.line_id`);
  const st = await q(`SELECT COUNT(*) AS n FROM t_station`);
  ok('存量工位全部纳入本产线的 legacy 任务，且零跨线关联', () => {
    assert.equal(ts[0].n, st[0].n, `正确关联 ${ts[0].n} / 工位 ${st[0].n}`);
    assert.equal(cross[0].n, 0, `跨线关联残留 ${cross[0].n}`);
    assert.ok(st[0].n > 0, '工位表为空，无法验证回填');
  });

  const wrongLine = await q(`SELECT COUNT(*) AS n FROM t_element e
    JOIN t_station s ON s.station_id = e.station_id AND s.tenant_id = e.tenant_id
    JOIN t_decomposition_task t ON t.task_id = e.task_id
    WHERE t.round_type = 'legacy' AND t.line_id <> s.line_id`);
  ok('存量要素按产线对齐归档任务（无跨线归集）', () => {
    assert.equal(wrongLine[0].n, 0, `跨线归集 ${wrongLine[0].n} 条`);
  });

  const grouped = await q(`SELECT e.task_id, COUNT(*) AS n FROM t_element e GROUP BY e.task_id`);
  const orphans = await q(`SELECT COUNT(*) AS n FROM t_element e
    WHERE NOT EXISTS (SELECT 1 FROM t_decomposition_task t WHERE t.task_id = e.task_id AND t.tenant_id = e.tenant_id)`);
  ok('存量要素全部归集到合法任务，零孤儿', () => {
    assert.ok(grouped.length >= 1, 't_element 为空');
    assert.equal(orphans[0].n, 0, `孤儿 ${orphans[0].n} 条`);
    assert.ok(grouped.some((g) => g.task_id === 'DT-LEGACY' && g.n > 0), 'DT-LEGACY 下无要素');
    console.log(`    归集：${grouped.map((g) => `${g.task_id}=${g.n}`).join(', ')}`);
  });

  const legacyIds = await q(`SELECT TOP 5 element_id FROM t_element WHERE task_id = 'DT-LEGACY' ORDER BY element_id`);
  ok('存量 element_id 保持原值（未被重写为跨任务新编码）', () => {
    assert.ok(legacyIds.length > 0);
    for (const r of legacyIds) {
      assert.ok(!/^DT-/.test(r.element_id), `被重写：${r.element_id}`);
      assert.ok(r.element_id.length <= 48, `超长：${r.element_id}`);
    }
  });

  const keys = await q(`SELECT name, type FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID('t_element')`);
  ok('唯一键 UQ_element_task_ver_seq 含 task_id、主键已重建', () => {
    assert.ok(keys.some((k) => k.name === 'UQ_element_task_ver_seq'), '新唯一键缺失');
    assert.ok(!keys.some((k) => k.name === 'UQ_element_tenant_ver_seq'), '旧唯一键未删除');
    assert.ok(keys.some((k) => k.type === 'PK'), '主键缺失');
  });

  const idx = await q(`SELECT name FROM sys.indexes WHERE name IN
    ('idx_element_task','idx_task_tenant_line','UQ_task_tenant_no','idx_task_station_tenant_station','idx_batch_export_task')`);
  ok('Phase 2 五个索引全部建立', () => {
    assert.equal(idx.length, 5, `实际 ${idx.length}: ${idx.map((i) => i.name).join(',')}`);
  });

  await pool.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => { console.error('迁移验证异常：', e); process.exitCode = 1; });
