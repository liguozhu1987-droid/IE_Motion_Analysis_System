/**
 * Phase 3 / Wave 1 · #103 写入侧真实 HTTP 契约（A-103-1~7）
 * ------------------------------------------------------------
 * 前置：API 已启动（生产 mssql，默认 http://127.0.0.1:3001）。
 * 夹具：新建专用工位 {line}-ST98 + 两个分解任务（T1 active / T2 archived），
 *       跑完按名清理任务与工位（FK 倒序），不改写任何存量 element_id。
 *
 *   node test/task-scope-write.cjs
 */
const L = require('./task-scope-lib.cjs');
const { assert, ok, finish, login, call, postJson, getJson, db, query, exec, elements, cleanup, CSV_HEADER } = L;

async function main() {
  console.log(`task-scope 写入侧契约　${L.BASE}`);
  const token = await login('admin');
  const viewer = await login('viewer1').catch(() => null);
  const pool = await db();

  let lineId, stationId, t1, t2, legacyCountBefore, legacyIdsBefore;

  try {
    await ok('A-103-0 夹具：确定产线并清理上一轮残留', async () => {
      const r = await getJson('/api/stations', token);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data) && r.data.length > 0, '生产库应有至少一个工位');
      lineId = String(r.data[0].line_id);
      assert.match(lineId, /^[A-Za-z0-9]+$/, '产线码不符合工位编码前缀约束');
      stationId = `${lineId}-ST98`;
      await cleanup(pool, stationId);
      legacyCountBefore = (await query(pool, `SELECT COUNT(*) AS n FROM t_element WHERE task_id LIKE 'DT-LEGACY%'`))[0].n;
      legacyIdsBefore = (await query(pool, `SELECT element_id FROM t_element WHERE task_id LIKE 'DT-LEGACY%'`))
        .map((x) => String(x.element_id)).sort();
      console.log(`    夹具：line=${lineId} station=${stationId} 存量 legacy 要素 ${legacyCountBefore} 条`);
    });

    /* ── A-103-6：新建工位自动关联当前任务（前端零必填步骤） ───────────── */
    await ok('A-103-6 新建工位不传 task_id 仍自动写 t_task_station 且锁定 bol_version', async () => {
      const r = await postJson('/api/stations', {
        station_id: stationId, line_id: lineId, name: 'Phase3契约测试-专用工位', tt: 40,
      }, token);
      assert.equal(r.status, 201, `建工位失败 ${r.status}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.task_link?.linked, true, '未自动关联任务');
      assert.equal(r.data.task_link?.source, 'legacy-fallback', '应回落本产线 legacy 并标注');
      const links = await query(pool, `SELECT task_id, bol_version FROM t_task_station WHERE station_id = @sid`, { sid: stationId });
      assert.equal(links.length, 1, `关联行数应为 1，实际 ${links.length}`);
      assert.equal(Number(links[0].bol_version), 1);
      const task = await query(pool, `SELECT line_id, round_type FROM t_decomposition_task WHERE task_id = @tid`, { tid: links[0].task_id });
      assert.equal(String(task[0].line_id), lineId, '关联任务跨产线');
      assert.equal(task[0].round_type, 'legacy');
      console.log(`    自动关联：${links[0].task_id} · 锁定 v${links[0].bol_version}`);
    });

    /* ── 两个任务：T1 active（自动继承）/ T2 archived（仅显式指定时可读） ── */
    await ok('A-103-0 夹具：创建 T1 / T2 两个同产线任务', async () => {
      for (const [key, name] of [['t1', 'Phase3契约测试-写入侧A'], ['t2', 'Phase3契约测试-写入侧B']]) {
        const r = await postJson('/api/tasks', {
          line_id: lineId, name, period_start: '2026-11-01', period_end: '2026-11-05',
          round_type: 'baseline', station_ids: [stationId],
        }, token);
        assert.equal(r.status, 201, `创建任务失败 ${r.status}: ${JSON.stringify(r.data)}`);
        assert.match(r.data.task_no, /^DT-\d{4}-\d{3}$/);
        assert.ok(r.data.stations.some((s) => s.station_id === stationId), '任务未关联测试工位');
        if (key === 't1') t1 = r.data.task_id; else t2 = r.data.task_id;
      }
      assert.notEqual(t1, t2);
      // 避免「多个生效任务」触发 D1 的 409（该行为由 A-103-7 前置单独验证）
      await exec(pool, `UPDATE t_decomposition_task SET status = 'archived' WHERE task_id = @tid`, { tid: t2 });
      console.log(`    T1=${t1}(active) T2=${t2}(archived)`);
    });

    /* ── A-103-1 / -2 / -3 ─────────────────────────────────────────── */
    await ok('A-103-1 提交 T1 不误删 T2 要素（delete 条件带 task_id）', async () => {
      const a = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t1, cycle_count: 15, cv: 0.05, elements: elements(4),
      }, token);
      assert.equal(a.status, 201, `T1 提交失败 ${a.status}: ${JSON.stringify(a.data)}`);
      assert.equal(a.data.task_scope?.source, 'explicit');
      const b = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t2, cycle_count: 15, cv: 0.05, elements: elements(3),
      }, token);
      assert.equal(b.status, 201, `T2 提交失败 ${b.status}: ${JSON.stringify(b.data)}`);
      // 再次提交 T1（改成 2 条）→ T2 必须原封不动
      const c = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t1, cycle_count: 15, cv: 0.05, elements: elements(2),
      }, token);
      assert.equal(c.status, 201);
      const rows = await query(pool,
        `SELECT task_id, COUNT(*) AS n FROM t_element WHERE station_id = @sid GROUP BY task_id`, { sid: stationId });
      const byTask = Object.fromEntries(rows.map((r) => [String(r.task_id), Number(r.n)]));
      assert.equal(byTask[t1], 2, `T1 应为 2 条，实际 ${byTask[t1]}`);
      assert.equal(byTask[t2], 3, `T2 被连坐删除，仅剩 ${byTask[t2]} 条`);
      console.log(`    T1=${byTask[t1]} 条 / T2=${byTask[t2]} 条（互不干扰）`);
    });

    await ok('A-103-2 新增要素 task_id 均为请求任务，全库 legacy 新增行数 = 0', async () => {
      const rows = await query(pool, `SELECT DISTINCT task_id FROM t_element WHERE station_id = @sid`, { sid: stationId });
      const ids = rows.map((r) => String(r.task_id));
      assert.ok(ids.every((x) => x === t1 || x === t2), `混入非任务归属：${ids.join(',')}`);
      const after = (await query(pool, `SELECT COUNT(*) AS n FROM t_element WHERE task_id LIKE 'DT-LEGACY%'`))[0].n;
      assert.equal(Number(after), Number(legacyCountBefore), `legacy 新增行数 ${after - legacyCountBefore}`);
    });

    await ok('A-103-3 element_id ≤96、跨任务不撞号、存量原值零改写', async () => {
      const rows = await query(pool, `SELECT element_id, task_id FROM t_element WHERE station_id = @sid`, { sid: stationId });
      assert.ok(rows.length > 0);
      assert.ok(rows.every((r) => String(r.element_id).length <= 96));
      const ids = rows.map((r) => String(r.element_id));
      assert.equal(new Set(ids).size, ids.length, 'T1/T2 出现重复主键');
      const a = ids.filter((_, i) => rows[i].task_id === t1);
      const b = ids.filter((_, i) => rows[i].task_id === t2);
      assert.ok(a.length && b.length && a.every((x) => !b.includes(x)), '跨任务 element_id 未区分');
      assert.ok(a.some((x) => x.startsWith('DT-')) && b.some((x) => x.startsWith('DT-')), '新写入未带任务号前缀');
      const after = (await query(pool, `SELECT element_id FROM t_element WHERE task_id LIKE 'DT-LEGACY%'`))
        .map((x) => String(x.element_id)).sort();
      assert.deepEqual(after, legacyIdsBefore, '存量 element_id 被改写');
      console.log(`    T1 示例 ${a[0]} · T2 示例 ${b[0]} · 最长 ${Math.max(...ids.map((x) => x.length))} 字符`);
    });

    /* ── A-103-4 CSV 模板逐字不变 + 导入导出按任务隔离 ───────────────── */
    let csvText;
    await ok('A-103-4 CSV 导出表头逐字不变、带 UTF-8 BOM、只含该任务要素', async () => {
      const r = await call('GET', `/api/stations/${stationId}/elements/export?task_id=${encodeURIComponent(t1)}`,
        { token, raw: true });
      assert.equal(r.status, 200);
      assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], '缺 UTF-8 BOM');
      csvText = r.buf.toString('utf8').replace(/^\uFEFF/, '');
      const lines = csvText.trim().split(/\r?\n/);
      assert.deepEqual(lines[0].split(','), CSV_HEADER, 'CSV 模板列被改动');
      assert.equal(lines.length - 1, 2, `应只含 T1 的 2 条要素，实际 ${lines.length - 1}`);
      assert.equal(r.headers.get('x-task-scope'), 'explicit');
    });

    await ok('A-103-4 CSV 回导（上下文注入任务号）后行数一致且不影响 T2', async () => {
      const r = await postJson(`/api/stations/${stationId}/elements/import`, { csv: csvText, task_id: t1 }, token);
      assert.equal(r.status, 201, `回导失败 ${r.status}: ${JSON.stringify(r.data)}`);
      const rows = await query(pool,
        `SELECT task_id, COUNT(*) AS n FROM t_element WHERE station_id = @sid GROUP BY task_id`, { sid: stationId });
      const byTask = Object.fromEntries(rows.map((x) => [String(x.task_id), Number(x.n)]));
      assert.equal(byTask[t1], 2, `T1 回导后应 2 条，实际 ${byTask[t1]}`);
      assert.equal(byTask[t2], 3, `T2 被回导影响，仅剩 ${byTask[t2]} 条`);
    });

    /* ── A-103-5 权限与跨租户 ──────────────────────────────────────── */
    await ok('A-103-5 无 element:write 账号提交带 task_id → 403', async () => {
      if (!viewer) { console.log('    viewer1 不可用，跳过'); return; }
      const me = await getJson('/api/auth/me', viewer);
      if ((me.data?.permissions ?? []).includes('element:write')) { console.log('    viewer1 具备 element:write，跳过'); return; }
      const r = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t1, cycle_count: 15, cv: 0.05, elements: elements(2),
      }, viewer);
      assert.equal(r.status, 403, `期望 403，实际 ${r.status}`);
    });

    await ok('A-103-5 跨租户任务 404（不泄露存在性）+ 不存在任务 404', async () => {
      await exec(pool, `INSERT INTO t_decomposition_task
        (task_id, tenant_id, task_no, line_id, name, round_type, round_no, period_start, period_end,
         status, baseline_task_id, project_id, project_no_snapshot, rule_versions, owner_user_id, created_by, created_at, closed_at)
        SELECT 'DT-XTEST-999', 'PHASE3_TEST', 'DT-XTEST-999', line_id, N'Phase3契约测试-跨租户', round_type, round_no,
               period_start, period_end, status, NULL, NULL, NULL, rule_versions, NULL, 'test', created_at, NULL
        FROM t_decomposition_task WHERE task_id = @tid`, { tid: t1 });
      const cross = await getJson(`/api/stations/${stationId}/elements?task_id=DT-XTEST-999`, token);
      assert.equal(cross.status, 404, `跨租户期望 404，实际 ${cross.status}`);
      const missing = await getJson(`/api/stations/${stationId}/elements?task_id=DT-9999-999`, token);
      assert.equal(missing.status, 404);
    });

    /* ── D1 多生效任务 → 409 列候选 ─────────────────────────────────── */
    await ok('D1 同工位多个生效任务且未显式指定 → 409 并列出候选', async () => {
      await exec(pool, `UPDATE t_decomposition_task SET status = 'active' WHERE task_id = @tid`, { tid: t2 });
      const r = await getJson(`/api/stations/${stationId}/elements`, token);
      assert.equal(r.status, 409, `期望 409，实际 ${r.status}`);
      assert.ok(Array.isArray(r.data?.candidates) && r.data.candidates.length >= 2, '未列出候选任务');
      await exec(pool, `UPDATE t_decomposition_task SET status = 'archived' WHERE task_id = @tid`, { tid: t2 });
    });

    /* ── A-103-7 兼容模式回落标记 + 导出按任务过滤 ───────────────────── */
    await ok('A-103-7 无生效任务时兼容模式导出带 legacy-fallback 标记且不含 T1/T2 要素', async () => {
      await exec(pool, `UPDATE t_decomposition_task SET status = 'archived' WHERE task_id IN (@t1, @t2)`, { t1, t2 });
      const r = await call('GET', `/api/stations/${stationId}/elements/export`, { token, raw: true });
      assert.equal(r.status, 200, `兼容模式导出失败 ${r.status}`);
      assert.equal(r.headers.get('x-task-scope'), 'legacy-fallback');
      assert.equal(r.headers.get('x-task-fallback'), 'legacy-fallback');
      const lines = r.buf.toString('utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      assert.equal(lines.length - 1, 0, `兼容模式不应混入 T1/T2 要素，实际 ${lines.length - 1} 行`);
      const r1 = await call('GET', `/api/stations/${stationId}/elements/export?task_id=${encodeURIComponent(t1)}`, { token, raw: true });
      assert.equal(r1.headers.get('x-task-scope'), 'explicit');
    });

    await ok('A-103-7 响应体 task_scope 与响应头一致（显式 / 回落双通道）', async () => {
      const r = await getJson(`/api/stations/${stationId}/elements?task_id=${encodeURIComponent(t1)}`, token);
      assert.equal(r.status, 200);
      assert.equal(r.data.task_scope.source, 'explicit');
      assert.equal(r.data.task_scope.task_id, t1);
      assert.equal(r.headers.get('x-task-scope'), 'explicit');
      const c = await getJson(`/api/stations/${stationId}/elements`, token);
      assert.equal(c.status, 200);
      assert.equal(c.data.task_scope.source, 'legacy-fallback');
    });
  } finally {
    await cleanup(pool, stationId).catch((e) => console.error('    清理失败：' + e.message));
    await pool.close().catch(() => {});
  }
  finish('A-103 写入侧');
}

main().catch((e) => { console.error('契约异常：', e); process.exitCode = 1; });
