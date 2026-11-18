/**
 * Phase 3 · Wave 2 · 生产 mssql 加列/回填验证（只读，不修改任何数据）
 * ------------------------------------------------------------
 * 前置：已执行 `npm run migrate:prod`；迁移前已跑 phase3-wave2-snapshot.cjs。
 * 覆盖冻结清单 §4 step 7：列长 32 / NULL 性 / 零 DEFAULT / 索引与唯一键含 task_id /
 *       6 行回填正确 / 零跨线零孤儿 / 历史审计零回填 / element_ids 与原值零改写 /
 *       实体 length/type 与 DDL 同步 / D5 无第二个 task_id。
 *
 *   cd app/api && node test/phase3-wave2-migration-verify.cjs
 */
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sql = require('mssql');

const SNAPSHOT = path.resolve(__dirname, '../storage/wave2/backup_before.json');
const BUSINESS = [
  ['t_ai_suggestion_batch', 'batch_id'],
  ['t_ai_waste_batch', 'batch_id'],
  ['t_improvement', 'imp_id'],
];
let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
};
const norm = (v) => (v instanceof Date ? v.toISOString() : (v === undefined ? null : v));

(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    server: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 1433),
    database: process.env.DB_NAME || 'CN_AME',
    options: { encrypt: false, trustServerCertificate: true },
  });
  const q = async (text) => (await pool.request().query(text)).recordset;
  const snap = fs.existsSync(SNAPSHOT)
    ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
    : null;

  const cols = await q(`SELECT t.name AS tbl, c.name AS col, c.max_length, c.is_nullable, c.default_object_id
    FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
    WHERE (t.name IN ('t_ai_suggestion_batch','t_ai_waste_batch','t_improvement','t_audit_log') AND c.name = 'task_id')
       OR (t.name = 't_ai_task' AND c.name = 'decomp_task_id')`);
  const col = (tbl, name) => cols.find((c) => c.tbl === tbl && c.col === name);
  const targets = [
    ['t_ai_task', 'decomp_task_id'],
    ['t_ai_suggestion_batch', 'task_id'],
    ['t_ai_waste_batch', 'task_id'],
    ['t_improvement', 'task_id'],
    ['t_audit_log', 'task_id'],
  ];
  ok('A-105-1 / 五表目标列齐全（NVARCHAR(32) NULL、无 DEFAULT）', () => {
    assert.equal(cols.length, 5, `实际 ${cols.length}: ${cols.map((c) => `${c.tbl}.${c.col}`).join(',')}`);
    for (const [tbl, name] of targets) {
      const c = col(tbl, name);
      assert.ok(c, `缺列 ${tbl}.${name}`);
      assert.equal(c.max_length, 64, `${tbl}.${name} 不是 NVARCHAR(32)`);
      assert.equal(c.is_nullable, true, `${tbl}.${name} 不可空（D8 不收紧）`);
      assert.equal(c.default_object_id, 0, `${tbl}.${name} 带默认约束`);
    }
  });

  const aiTaskCols = await q(`SELECT c.name FROM sys.columns c
    WHERE c.object_id = OBJECT_ID('t_ai_task') AND c.name LIKE '%task_id%'`);
  ok('A-105-1 / D5：t_ai_task 只有一个 task_id（队列 UUID 主键）+ decomp_task_id', () => {
    assert.equal(aiTaskCols.filter((c) => c.name === 'task_id').length, 1);
    assert.equal(aiTaskCols.filter((c) => c.name === 'decomp_task_id').length, 1);
  });

  const entities = [
    ['src/entities/ai-task.entity.ts', 'decomp_task_id'],
    ['src/modules/ai-suggest/entities/ai-suggestion-batch.entity.ts', 'task_id'],
    ['src/modules/ai-waste/entities/ai-waste-batch.entity.ts', 'task_id'],
    ['src/entities/improvement.entity.ts', 'task_id'],
    ['src/entities/audit-log.entity.ts', 'task_id'],
  ];
  ok('A-105-1 / 五个实体 length/type 与 DDL 同步（length:32、nullable:true、无 type）', () => {
    for (const [file, field] of entities) {
      const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const line = text.split('\n').find((l) => l.includes('@Column(') && l.includes(`${field}:`));
      assert.ok(line, `${file} 缺字段 ${field}`);
      assert.match(line, /@Column\(\{[^}]*length: ?32[^}]*nullable: ?true/, `${file} 列定义不同步：${line.trim()}`);
      assert.ok(!/type:\s*['"]/i.test(line), `${file} 不应写 type`);
    }
  });

  const idx = await q(`SELECT i.name, i.has_filter FROM sys.indexes i WHERE i.name IN
    ('idx_ai_task_decomp','idx_ai_suggest_batch_task','idx_ai_waste_batch_task','idx_imp_task','idx_audit_task','UQ_ai_batch_slot')`);
  ok('五条任务维度索引 + UQ_ai_batch_slot 全部存在', () => {
    assert.equal(idx.length, 6, `实际 ${idx.length}: ${idx.map((i) => i.name).join(',')}`);
  });
  const uqCols = await q(`SELECT c.name FROM sys.index_columns ic
    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.name = 'UQ_ai_batch_slot' AND i.object_id = OBJECT_ID('t_ai_suggestion_batch')
    ORDER BY ic.key_ordinal`);
  ok('F3 / A-105-3：UQ_ai_batch_slot 唯一键含 task_id 且仍为过滤索引', () => {
    assert.ok(uqCols.some((c) => c.name === 'task_id'), `键列：${uqCols.map((c) => c.name).join(',')}`);
    assert.equal(uqCols.filter((c) => c.name === 'task_id').length, 1);
    assert.equal(idx.find((i) => i.name === 'UQ_ai_batch_slot').has_filter, true);
  });

  const nullRows = await q(BUSINESS.map(([t]) => `SELECT '${t}' AS tbl, COUNT(*) AS n FROM ${t} WHERE task_id IS NULL`).join(' UNION ALL '));
  ok('A-105-2 / A-106-3：三张业务表 task_id IS NULL = 0（回填 1+1+4=6 行）', () => {
    for (const r of nullRows) assert.equal(r.n, 0, `${r.tbl} 残留 ${r.n} 行 NULL`);
  });

  for (const [t] of BUSINESS) {
    const cross = await q(`SELECT COUNT(*) AS n FROM ${t} x
      JOIN t_station s ON s.station_id = x.station_id AND s.tenant_id = x.tenant_id
      JOIN t_decomposition_task dt ON dt.task_id = x.task_id
      WHERE dt.line_id <> s.line_id`);
    const orphan = await q(`SELECT COUNT(*) AS n FROM ${t} x
      WHERE NOT EXISTS (SELECT 1 FROM t_decomposition_task dt WHERE dt.task_id = x.task_id AND dt.tenant_id = x.tenant_id)`);
    ok(`A-105-2 / ${t} 零跨线、零孤儿`, () => {
      assert.equal(cross[0].n, 0, `跨线 ${cross[0].n}`);
      assert.equal(orphan[0].n, 0, `孤儿 ${orphan[0].n}`);
    });
  }

  const audit = await q(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN task_id IS NULL THEN 1 ELSE 0 END) AS null_task,
      SUM(CASE WHEN task_id IS NOT NULL AND action NOT IN ('export_batch_xlsx','task_scope.legacy_fallback') THEN 1 ELSE 0 END) AS suspicious
    FROM t_audit_log`);
  // 审计表按设计不建外键（用户/任务删除后日志必须留存），故新增的两类业务自审计行
  // 在测试任务被清理后允许留下悬空 task_id；旧 action 行则必须严格指向合法任务。
  const auditOrphan = await q(`SELECT COUNT(*) AS n FROM t_audit_log a
    WHERE a.task_id IS NOT NULL
      AND a.action NOT IN ('export_batch_xlsx','task_scope.legacy_fallback')
      AND NOT EXISTS (SELECT 1 FROM t_decomposition_task dt WHERE dt.task_id = a.task_id)`);
  const auditDangling = await q(`SELECT COUNT(*) AS n FROM t_audit_log a
    WHERE a.task_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM t_decomposition_task dt WHERE dt.task_id = a.task_id)`);
  ok('#108 / 历史审计零回填：仅业务自审计行可带 task_id，旧 action 行必须指向合法任务', () => {
    assert.equal(audit[0].suspicious, 0, `异常带任务号的旧 action ${audit[0].suspicious} 行`);
    assert.equal(auditOrphan[0].n, 0, `旧 action 行孤儿 ${auditOrphan[0].n} 行`);
    console.log(`    审计共 ${audit[0].total} 行，task_id 非空 ${audit[0].total - audit[0].null_task} 行`);
    console.log(`    附加日志（append-only，任务删除后留存）：悬空引用 ${auditDangling[0].n} 行`);
  });

  if (snap) {
    const current = {};
    for (const [t] of BUSINESS) current[t] = await q(`SELECT * FROM ${t}`);
    current.t_ai_task = await q(`SELECT * FROM t_ai_task`);
    ok('D7 / 逐行比对：快照中的主键 / element_ids / 全部原字段零改写', () => {
      for (const [t, pk] of BUSINESS) {
        const before = new Map(snap.tables[t].map((r) => [String(r[pk]), r]));
        const after = new Map(current[t].map((r) => [String(r[pk]), r]));
        assert.ok(after.size >= before.size, `${t} 主键行数减少`);
        for (const [id, row] of before) {
          assert.ok(after.has(id), `${t} 丢失主键 ${id}`);
          const now = after.get(id);
          for (const key of Object.keys(row)) {
            if (key === 'task_id') continue;
            assert.deepEqual(norm(now[key]), norm(row[key]), `${t}.${id}.${key} 被改写`);
          }
        }
      }
      const beforeAi = new Map(snap.tables.t_ai_task.map((r) => [String(r.task_id), r]));
      for (const [id, row] of beforeAi) {
        const now = current.t_ai_task.find((r) => String(r.task_id) === id);
        assert.ok(now, `t_ai_task 丢失主键 ${id}`);
        for (const key of Object.keys(row)) {
          if (key === 'decomp_task_id') continue;
          assert.deepEqual(norm(now[key]), norm(row[key]), `t_ai_task.${id}.${key} 被改写`);
        }
      }
    });
    const tagged = await q(`SELECT log_id, action FROM t_audit_log WHERE task_id IS NOT NULL`);
    const oldIds = new Set(snap.tables.t_audit_log.map((r) => String(r.log_id)));
    ok(`D7 / 迁移前 ${snap.auditTotal} 行历史审计全部保持 task_id=NULL`, () => {
      const touchedOld = tagged.filter((r) => oldIds.has(String(r.log_id)));
      assert.equal(touchedOld.length, 0, `历史行被改写 ${touchedOld.length} 条：${touchedOld.slice(0, 3).map((r) => r.log_id).join(',')}`);
      console.log(`    当前带任务号 ${tagged.length} 行，均为迁移后新写入`);
    });
  } else {
    console.log('  ! 未找到迁移前快照，跳过 D7 逐行比对');
  }

  await pool.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => { console.error('迁移验证异常：', e); process.exitCode = 1; });
