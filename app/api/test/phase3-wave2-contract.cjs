/**
 * Phase 3 · Wave 2 · #105 / #106 / #108 真实 HTTP 契约
 * ------------------------------------------------------------
 * 前置：API 已真起生产 mssql（http://127.0.0.1:3001），且已跑 migrate:prod。
 * 夹具：专用工位 {line}-ST97 + 两个同产线任务 T1(active) / T2(archived)；
 *       直接落批次 / 建议 / 问题 / 措施夹具行（前缀 W2TEST-），跑完按名彻底清理。
 * 零 LLM 调用：只走列表、采纳、结算、导出端点，不触发 generate 的模型链路。
 *
 *   cd app/api && node test/phase3-wave2-contract.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const L = require('./task-scope-lib.cjs');
const { assert, ok, finish, login, call, postJson, getJson, db, query, exec, cleanup } = L;

const SRC = path.resolve(__dirname, '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const PREFIX = 'W2TEST-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const token = await login('admin');
  const pool = await db();
  let lineId, stationId, t1, t2, otherTenantTask;
  const exportRecordIds = [];
  const auditLogIds = [];

  const purge = async (sid) => {
    for (const t of ['t_ai_suggestion', 't_ai_waste_issue', 't_ai_waste_finding']) {
      await exec(pool, `DELETE FROM ${t} WHERE batch_id LIKE '${PREFIX}%'`).catch(() => {});
    }
    await exec(pool, `DELETE FROM t_ai_suggestion_batch WHERE batch_id LIKE '${PREFIX}%'`).catch(() => {});
    await exec(pool, `DELETE FROM t_ai_waste_batch WHERE batch_id LIKE '${PREFIX}%'`).catch(() => {});
    await exec(pool, `DELETE FROM t_improvement WHERE imp_id LIKE '${PREFIX}%' OR station_id = '${sid}'`).catch(() => {});
    if (exportRecordIds.length) {
      const inIds = exportRecordIds.map((x) => `'${x}'`).join(',');
      await exec(pool, `DELETE FROM t_batch_export_record WHERE record_id IN (${inIds})`).catch(() => {});
    }
    if (auditLogIds.length) {
      const inIds = auditLogIds.map((x) => `'${x}'`).join(',');
      await exec(pool, `DELETE FROM t_audit_log WHERE log_id IN (${inIds})`).catch(() => {});
    }
    if (exportRecordIds.length) {
      const inIds = exportRecordIds.map((x) => `'${x}'`).join(',');
      await exec(pool, `DELETE FROM t_audit_log WHERE action = 'export_batch_xlsx' AND entity_id IN (${inIds})`).catch(() => {});
    }
    // 清理上一轮异常退出留下的孤儿导出审计行（留档记录已被删除，但审计是即发即忘异步落库）
    await exec(pool, `DELETE FROM t_audit_log WHERE action = 'export_batch_xlsx'
      AND entity_id IS NOT NULL AND entity_id NOT IN (SELECT record_id FROM t_batch_export_record)`).catch(() => {});
    await exec(pool, `DELETE FROM t_decomposition_task WHERE task_id = '${PREFIX}OTHER'`).catch(() => {});
    await cleanup(pool, sid);
  };

  /** AuditService.record 是即发即忘异步落库，按 entity_id 轮询（最多 5s）避免竞态 */
  const waitAudit = async (recordId) => {
    for (let i = 0; i < 50; i += 1) {
      const rows = await query(pool,
        `SELECT log_id, task_id, after_json FROM t_audit_log WHERE action = 'export_batch_xlsx' AND entity_id = '${recordId}'`);
      if (rows.length) return rows[0];
      await sleep(100);
    }
    return null;
  };

  try {
    /* ── 夹具 ─────────────────────────────────────────────────────── */
    await ok('夹具：清理残留 → 新建专用工位 → 建 T1/T2 两个任务', async () => {
      const r = await getJson('/api/stations', token);
      assert.equal(r.status, 200);
      lineId = String(r.data[0].line_id);
      stationId = `${lineId}-ST97`;
      await purge(stationId);
      const st = await postJson('/api/stations', {
        station_id: stationId, line_id: lineId, name: 'Phase3Wave2契约测试工位', tt: 40,
      }, token);
      assert.equal(st.status, 201, `建工位失败：${JSON.stringify(st.data)}`);
      for (const [key, name] of [['t1', 'Phase3契约测试-Wave2-A'], ['t2', 'Phase3契约测试-Wave2-B']]) {
        const t = await postJson('/api/tasks', {
          line_id: lineId, name, period_start: '2026-11-01', period_end: '2026-11-05',
          round_type: 'baseline', station_ids: [stationId],
        }, token);
        assert.equal(t.status, 201, `建任务失败：${JSON.stringify(t.data)}`);
        if (key === 't1') t1 = t.data.task_id; else t2 = t.data.task_id;
      }
      assert.notEqual(t1, t2);
      await exec(pool, `UPDATE t_decomposition_task SET status = 'archived' WHERE task_id = '${t2}'`);
      console.log(`    line=${lineId} station=${stationId} T1=${t1} T2=${t2}`);
    });

    await ok('夹具：同槽位 T1/T2 各插一条建议批次成功（F3 唯一索引含 task_id）', async () => {
      for (const [tid, tag] of [[t1, 'T1'], [t2, 'T2']]) {
        await exec(pool, `INSERT INTO t_ai_suggestion_batch
          (batch_id, tenant_id, station_id, version, user_id, element_source, is_unlimited, status, input_hash, task_id, suggestion_count)
          VALUES ('${PREFIX}SG-${tag}', 'DEFAULT', '${stationId}', 1, 'u_admin', 'mixed', 0, 'done', 'w2hash-${tag}', '${tid}', 0)`);
      }
      const rows = await query(pool, `SELECT batch_id, task_id FROM t_ai_suggestion_batch WHERE batch_id LIKE '${PREFIX}SG-%'`);
      assert.equal(rows.length, 2, '两条不同任务的同槽位批次应共存');
      // 同任务内仍必须唯一（唯一性语义未被放宽）
      let dupBlocked = false;
      try {
        await exec(pool, `INSERT INTO t_ai_suggestion_batch
          (batch_id, tenant_id, station_id, version, user_id, element_source, is_unlimited, status, input_hash, task_id)
          VALUES ('${PREFIX}SG-DUP', 'DEFAULT', '${stationId}', 1, 'u_admin', 'mixed', 0, 'done', 'w2hash-dup', '${t1}')`);
      } catch { dupBlocked = true; }
      assert.equal(dupBlocked, true, '同一任务同槽位重复插入未被唯一索引拦截');
    });

    await ok('夹具：浪费批次 / 改善措施 / 建议 / 问题条目各就位', async () => {
      for (const [tid, tag] of [[t1, 'T1'], [t2, 'T2']]) {
        await exec(pool, `INSERT INTO t_ai_waste_batch
          (batch_id, tenant_id, station_id, version, user_id, status, element_source, task_id)
          VALUES ('${PREFIX}WB-${tag}', 'DEFAULT', '${stationId}', 1, 'u_admin', 'done', 'ai_assisted', '${tid}')`);
        await exec(pool, `INSERT INTO t_improvement
          (imp_id, tenant_id, station_id, element_ids, waste_type, method, measure, est_save_s, priority, status, task_id)
          VALUES ('${PREFIX}IMP-${tag}', 'DEFAULT', '${stationId}', 'E1,E2', N'搬运浪费', 'E', N'合并搬运', 1.5, 50, N'待实施', '${tid}')`);
      }
      await exec(pool, `INSERT INTO t_ai_suggestion
        (suggestion_id, batch_id, tenant_id, station_id, version, element_ids, waste_type, method, action_class,
         measure, est_save_s, priority, tier, difficulty, status)
        VALUES ('${PREFIX}SUG-1', '${PREFIX}SG-T1', 'DEFAULT', '${stationId}', 1, 'E1', N'搬运浪费', 'E', 'A1',
         N'合并相邻搬运步骤', 1.2, 60, 'P2', 2, N'待审')`);
      await exec(pool, `INSERT INTO t_ai_waste_issue
        (issue_id, batch_id, tenant_id, station_id, version, element_refs, waste_type, problem, ecrs,
         suggestion, est_save_s, priority, tier, status, origin)
        VALUES ('${PREFIX}ISS-1', '${PREFIX}WB-T1', 'DEFAULT', '${stationId}', 1, '1', N'搬运浪费', N'来回取料', 'E',
         N'合并取料点', 1.1, 55, 'P2', N'待处理', 'ai')`);
    });

    /* ── A-105-3 / A-105-4 / A-106-2 ───────────────────────────────── */
    await ok('A-105-3 建议列表按任务隔离：T1 / T2 / 自动继承三态互不串', async () => {
      const a = await getJson(`/api/stations/${stationId}/ai-suggestions?task_id=${t1}`, token);
      assert.equal(a.status, 200, JSON.stringify(a.data));
      assert.ok(a.data.batches.some((b) => b.batch_id === `${PREFIX}SG-T1`), 'T1 批次缺失');
      assert.ok(!a.data.batches.some((b) => b.batch_id === `${PREFIX}SG-T2`), 'T2 批次串进 T1');
      assert.ok(a.data.suggestions.some((s) => s.suggestion_id === `${PREFIX}SUG-1`), 'T1 建议缺失');
      const b = await getJson(`/api/stations/${stationId}/ai-suggestions?task_id=${t2}`, token);
      assert.equal(b.status, 200, JSON.stringify(b.data));
      assert.ok(b.data.batches.some((x) => x.batch_id === `${PREFIX}SG-T2`), 'T2 批次缺失');
      assert.ok(!b.data.batches.some((x) => x.batch_id === `${PREFIX}SG-T1`), 'T1 批次串进 T2');
      assert.ok(!b.data.suggestions.some((s) => s.suggestion_id === `${PREFIX}SUG-1`), 'T1 建议串进 T2');
      const c = await getJson(`/api/stations/${stationId}/ai-suggestions`, token);
      assert.equal(c.status, 200);
      assert.ok(c.data.batches.every((x) => x.task_id === t1), '未显式指定时应自动继承唯一生效任务 T1');
    });

    await ok('A-105-3 浪费批次列表 / 最新批次按任务隔离', async () => {
      const a = await getJson(`/api/stations/${stationId}/ai-waste/batches?task_id=${t1}&source=ai_assisted`, token);
      assert.equal(a.status, 200, JSON.stringify(a.data));
      assert.ok(a.data.batches.some((b) => b.batch_id === `${PREFIX}WB-T1`), 'T1 浪费批次缺失');
      assert.ok(!a.data.batches.some((b) => b.batch_id === `${PREFIX}WB-T2`), 'T2 浪费批次串进 T1');
      const b = await getJson(`/api/stations/${stationId}/ai-waste/batches?task_id=${t2}&source=ai_assisted`, token);
      assert.equal(b.status, 200);
      assert.ok(b.data.batches.every((x) => x.task_id === t2), 'T2 列表混入其它任务');
      const c = await getJson(`/api/stations/${stationId}/ai-waste/latest?task_id=${t1}&source=ai_assisted`, token);
      assert.equal(c.status, 200, JSON.stringify(c.data));
      assert.equal(c.data.batch_id, `${PREFIX}WB-T1`, 'latest 未按任务取批');
      const d = await getJson(`/api/stations/${stationId}/ai-waste/latest?task_id=${t2}&source=ai_assisted`, token);
      assert.equal(d.status, 200);
      assert.equal(d.data.batch_id, `${PREFIX}WB-T2`, 'latest 串到别的任务');
    });

    await ok('A-105-4 / D4 缓存键含 task_id、命中查询按任务硬隔离、cache_from 零跨任务', async () => {
      const src = read('modules/ai-suggest/ai-suggest.service.ts');
      assert.match(src, /pv: PROMPT_VERSION, task: taskId/, 'input_hash 未纳入任务号');
      assert.match(src, /\.where\('b\.tenant_id = :tid AND b\.station_id = :sid AND b\.version = :ver[\s\S]{0,400}?\.andWhere\(\.\.\.this\.taskFilter\(taskId\)\)/,
        '缓存命中查询未加任务条件');
      const cross = await query(pool, `SELECT COUNT(*) AS n FROM t_ai_suggestion_batch b
        JOIN t_ai_suggestion_batch s ON s.batch_id = b.cache_from
        WHERE b.task_id IS NOT NULL AND s.task_id IS NOT NULL AND b.task_id <> s.task_id`);
      assert.equal(cross[0].n, 0, `cache_from 跨任务 ${cross[0].n} 条`);
    });

    await ok('A-106-2 GET /improvements?task_id= 可筛；不传时行为不变（两任务都在）', async () => {
      const a = await getJson(`/api/improvements?task_id=${t1}`, token);
      assert.equal(a.status, 200);
      assert.ok(a.data.improvements.some((x) => x.imp_id === `${PREFIX}IMP-T1`), 'T1 措施缺失');
      assert.ok(!a.data.improvements.some((x) => x.imp_id === `${PREFIX}IMP-T2`), 'T2 措施串进 T1');
      assert.ok(a.data.improvements.every((x) => x.task_id === t1), '返回了非 T1 的措施');
      const b = await getJson('/api/improvements', token);
      assert.equal(b.status, 200);
      assert.ok(b.data.improvements.some((x) => x.imp_id === `${PREFIX}IMP-T1`));
      assert.ok(b.data.improvements.some((x) => x.imp_id === `${PREFIX}IMP-T2`));
    });

    /* ── A-106-1 三处创建路径 ─────────────────────────────────────── */
    await ok('A-106-1 路径①：候选建议采纳写入的改善任务带显式任务号', async () => {
      const r = await postJson(`/api/stations/${stationId}/suggestions/adopt?task_id=${t1}`, {
        candidates: [{ waste_type: '搬运浪费', method: 'E', measure: '合并相邻工位', est_save_s: 1.0, priority: 40, element_ids: [] }],
      }, token);
      assert.equal(r.status, 201, `采纳失败：${JSON.stringify(r.data)}`);
      const rows = await query(pool, `SELECT imp_id, task_id FROM t_improvement WHERE imp_id IN (${r.data.imp_ids.map((x) => `'${x}'`).join(',')})`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].task_id, t1, '措施未归属 T1');
    });

    await ok('A-106-1 路径②：AI 建议采纳归属**来源批次**任务（显式传 T2 也不改挂）', async () => {
      const r = await postJson(`/api/ai-suggestions/${PREFIX}SUG-1/adopt?task_id=${t2}`, {}, token);
      assert.equal(r.status, 200, `采纳失败：${JSON.stringify(r.data)}`);
      const rows = await query(pool, `SELECT task_id FROM t_improvement WHERE imp_id = '${r.data.imp_id}'`);
      assert.equal(rows[0]?.task_id, t1, `应归属来源批次 T1，实际 ${rows[0]?.task_id}`);
    });

    await ok('A-106-1 路径③：浪费问题结算归属来源批次任务', async () => {
      const r = await postJson(`/api/ai-waste/issues/${PREFIX}ISS-1/settle?task_id=${t2}`, { status: '已确认' }, token);
      assert.equal(r.status, 200, `结算失败：${JSON.stringify(r.data)}`);
      const rows = await query(pool, `SELECT task_id FROM t_improvement WHERE imp_id = '${r.data.imp_id}'`);
      assert.equal(rows[0]?.task_id, t1, `应归属来源批次 T1，实际 ${rows[0]?.task_id}`);
    });

    await ok('A-106-3 存量措施 element_ids 零改写（快照逐行比对由迁移验证覆盖）', async () => {
      const snap = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../storage/wave2/backup_before.json'), 'utf8'));
      const rows = await query(pool, `SELECT imp_id, element_ids FROM t_improvement`);
      const now = new Map(rows.map((r) => [String(r.imp_id), String(r.element_ids)]));
      for (const r of snap.tables.t_improvement) {
        assert.ok(now.has(String(r.imp_id)), `存量措施 ${r.imp_id} 丢失`);
        assert.equal(now.get(String(r.imp_id)), String(r.element_ids), `${r.imp_id}.element_ids 被改写`);
      }
    });

    /* ── A-105-5 权限 ─────────────────────────────────────────────── */
    await ok('A-105-5 无 suggestion:generate 的账号 403；不存在/跨租户任务 404', async () => {
      const viewer = await login('viewer1').catch(() => null);
      if (viewer) {
        const v = await getJson(`/api/stations/${stationId}/ai-suggestions`, viewer);
        assert.equal(v.status, 403, `viewer 应 403，实际 ${v.status}`);
      }
      const bad = await getJson(`/api/stations/${stationId}/ai-suggestions?task_id=${PREFIX}NOTEXIST`, token);
      assert.equal(bad.status, 404, `不存在任务应 404，实际 ${bad.status}`);
      // 真实跨租户任务：tenant_id 不同 → findReadableTask 返回 404，不泄露存在性
      await exec(pool, `INSERT INTO t_decomposition_task
        (task_id, tenant_id, task_no, line_id, name, round_type, status)
        VALUES ('${PREFIX}OTHER', 'W2OTHER', 'DT-9999-999', '${lineId}', N'跨租户任务', 'baseline', 'active')`);
      otherTenantTask = `${PREFIX}OTHER`;
      const cross = await getJson(`/api/stations/${stationId}/ai-suggestions?task_id=${otherTenantTask}`, token);
      assert.equal(cross.status, 404, `跨租户任务应 404，实际 ${cross.status}`);
    });

    /* ── A-108 导出自审计 ─────────────────────────────────────────── */
    let taskExportAudit;
    await ok('A-108-1 按任务导出成功 → 新增审计行带 task_id / task_no / sheet 数', async () => {
      const r = await call('GET', `/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}&task_id=${t1}`, { token, raw: true });
      assert.equal(r.status, 200, `导出失败 ${r.status}: ${r.buf.slice(0, 200).toString()}`);
      const recId = r.headers.get('x-export-record-id');
      assert.ok(recId, '缺 X-Export-Record-Id（留档未成功）');
      exportRecordIds.push(recId);
      const log = await waitAudit(recId);
      assert.ok(log, '导出未新增自审计行');
      taskExportAudit = log;
      auditLogIds.push(log.log_id);
      assert.equal(log.task_id, t1, `审计 task_id 应为 ${t1}`);
      const j = JSON.parse(log.after_json);
      assert.ok(j.task_no, 'after_json 缺 task_no');
      assert.ok(j.sheets === 5 || j.sheets === 6, 'after_json 缺 sheet 数');
    });

    await ok('A-108-1 兼容模式（不传 task_id）审计记 null，不冒充任务号', async () => {
      const r = await call('GET', `/api/export/batch.xlsx?line_id=${encodeURIComponent(lineId)}`, { token, raw: true });
      assert.equal(r.status, 200, `兼容模式导出失败 ${r.status}`);
      const recId = r.headers.get('x-export-record-id');
      assert.ok(recId, '缺 X-Export-Record-Id');
      exportRecordIds.push(recId);
      const log = await waitAudit(recId);
      assert.ok(log, '兼容模式未新增自审计行');
      auditLogIds.push(log.log_id);
      assert.notEqual(log.log_id, taskExportAudit?.log_id, '两次导出复用了同一审计行');
      assert.equal(log.task_id, null, '兼容模式不应带任务号');
      assert.equal(JSON.parse(log.after_json).task_no, null);
    });

    await ok('A-108-2 既有 action 派生规则逐字未变；历史日志仍可读', async () => {
      const interceptor = read('audit/audit.interceptor.ts');
      assert.ok(interceptor.includes('const action = `${method.toLowerCase()}_${(req.path'),
        'action 派生规则被改动');
      assert.ok(interceptor.includes(".replace(/^\\/api\\//, '').replace(/\\//g, '_')"),
        'path 派生细节被改动');
      const old = await query(pool, `SELECT COUNT(*) AS n FROM t_audit_log WHERE action <> 'export_batch_xlsx' AND task_id IS NOT NULL AND action <> 'task_scope.legacy_fallback'`);
      assert.equal(old[0].n, 0, '历史 action 行被写入任务号');
      const total = (await query(pool, `SELECT COUNT(*) AS n FROM t_audit_log`))[0].n;
      assert.ok(total >= 7731, '历史审计行丢失');
    });

    await ok('A-108-3 复下载不新增导出审计行；审计写入失败不阻断导出（try/catch + .catch）', async () => {
      const list = await getJson('/api/export/batch/records?limit=5', token);
      assert.equal(list.status, 200);
      const rec = list.data.items.find((x) => exportRecordIds.includes(x.record_id));
      assert.ok(rec, '找不到本次测试的留档记录');
      const before = (await query(pool, `SELECT COUNT(*) AS n FROM t_audit_log WHERE action = 'export_batch_xlsx'`))[0].n;
      const dl = await call('GET', `/api/export/batch/records/${rec.record_id}/file`, { token, raw: true });
      assert.equal(dl.status, 200);
      const after = (await query(pool, `SELECT COUNT(*) AS n FROM t_audit_log WHERE action = 'export_batch_xlsx'`))[0].n;
      assert.equal(after, before, '复下载写了导出审计行');
      const ctrl = read('modules/batch-export/batch-export.controller.ts');
      assert.match(ctrl, /try \{[\s\S]*?this\.audit\.record\([\s\S]*?\} catch \{ \/\* 审计失败不阻断导出 \*\/ \}/,
        '导出自审计缺 try/catch 兜底');
      const svc = read('audit/audit.service.ts');
      assert.match(svc, /\.catch\(\(e\) => this\.log\.error/, 'AuditService.record 缺 .catch()');
    });

    /* ── 静态：迁移与实体单一来源 ─────────────────────────────────── */
    await ok('A-105-1 migrate.ts 是表结构唯一来源：5 加列 + 回填 + 索引重建均在案', () => {
      const m = fs.readFileSync(path.resolve(__dirname, '../scripts/migrate.ts'), 'utf8');
      for (const [t, c] of [['t_ai_task', 'decomp_task_id'], ['t_ai_suggestion_batch', 'task_id'],
        ['t_ai_waste_batch', 'task_id'], ['t_improvement', 'task_id'], ['t_audit_log', 'task_id']]) {
        assert.ok(m.includes(`COL_LENGTH('${t}','${c}')`), `缺 ${t}.${c} 幂等加列`);
      }
      assert.match(m, /CREATE UNIQUE INDEX UQ_ai_batch_slot ON t_ai_suggestion_batch \(tenant_id, station_id, version, user_id, element_source, task_id\)/);
    });

    finish('Phase3 Wave2 HTTP 契约');
  } finally {
    try { await purge(stationId || '__none__'); } catch (e) { console.error('清理异常：', e.message); }
    await pool.close();
  }
}

main().catch((e) => { console.error('契约测试异常：', e); process.exitCode = 1; });
