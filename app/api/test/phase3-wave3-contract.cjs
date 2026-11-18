/**
 * Phase 3 / Wave 3 · #107 `#/diff` 跨任务对比 真实 HTTP 契约（A-107-1~4）
 * ------------------------------------------------------------
 * 前置：API 已启动（生产 mssql，默认 http://127.0.0.1:3001）。
 * 夹具：新建专用工位 {line}-ST97 + 三个分解任务：
 *       T1 baseline(active，v1/v2 各一套要素) → T2 kaizen_after(baseline_task_id=T1, archived)
 *       T3 混入对照（v2 一套要素，验证「不含第三任务要素」）+ SQL 直插同产线非成员任务
 *       跑完按名清理任务与工位（FK 倒序），不改写任何存量 element_id。
 * 无 DB 变更（#107 无 DDL）。
 *
 *   npm run test:wave3:contract
 */
const fs = require('node:fs');
const path = require('node:path');
const L = require('./task-scope-lib.cjs');
const { assert, ok, finish, login, postJson, getJson, call, db, query, exec, elements, cleanup } = L;

const T3_DESC = '第三任务专用要素勿混入';

async function main() {
  console.log(`task-scope Wave3(#107) 契约　${L.BASE}`);
  const token = await login('admin');
  const pool = await db();

  let lineId, stationId, t1, t2, t3;
  let t1V1ct = 0, t1V2ct = 0;

  try {
    /* ── 夹具 ─────────────────────────────────────────────── */
    await ok('A-107-0 夹具：确定产线并清理上一轮残留', async () => {
      const r = await getJson('/api/stations', token);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.data) && r.data.length > 0, '生产库应有至少一个工位');
      lineId = String(r.data[0].line_id);
      stationId = `${lineId}-ST97`;
      await cleanup(pool, stationId);
      await exec(pool, `DELETE FROM t_decomposition_task WHERE name LIKE N'Phase3契约测试%'`).catch(() => {});
    });

    await ok('A-107-0 夹具：建工位 + T1/T2/T3 三任务（T2 带 baseline_task_id=T1）', async () => {
      const s = await postJson('/api/stations', {
        station_id: stationId, line_id: lineId, name: 'Phase3契约测试-Diff工位', tt: 40,
      }, token);
      assert.equal(s.status, 201, `建工位失败 ${s.status}: ${JSON.stringify(s.data)}`);
      for (const [key, payload] of [
        ['t1', { line_id: lineId, name: 'Phase3契约测试-Diff基准', round_type: 'baseline', station_ids: [stationId] }],
        ['t2', { line_id: lineId, name: 'Phase3契约测试-Diff改善后', round_type: 'kaizen_after', baseline_task_id: null, station_ids: [stationId] }],
        ['t3', { line_id: lineId, name: 'Phase3契约测试-Diff第三任务', round_type: 'other', station_ids: [stationId] }],
      ]) {
        const r = await postJson('/api/tasks', payload, token);
        assert.equal(r.status, 201, `创建任务失败 ${r.status}: ${JSON.stringify(r.data)}`);
        if (key === 't1') t1 = r.data.task_id;
        if (key === 't2') t2 = r.data.task_id;
        if (key === 't3') t3 = r.data.task_id;
      }
      // T2 基线指向 T1（baseline_task_id 建库时不可空校验放行 null，这里补链）
      await exec(pool, `UPDATE t_decomposition_task SET baseline_task_id = @a WHERE task_id = @b`, { a: t1, b: t2 });
      // 避免「多个生效任务」干扰自动继承（显式 task_id 全程直连，不受影响）
      await exec(pool, `UPDATE t_decomposition_task SET status = 'archived' WHERE task_id IN (@a, @b)`, { a: t2, b: t3 });
    });

    await ok('A-107-0 夹具：T1 提交 v1(4要素)→复测→v2(3要素)；T3 提交 v2(2要素)', async () => {
      const v1 = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t1, cycle_count: 15, cv: 0.05, elements: elements(4),
      }, token);
      assert.equal(v1.status, 201, `T1 v1 提交失败 ${v1.status}: ${JSON.stringify(v1.data)}`);
      const re = await postJson(`/api/stations/${stationId}/retest`, {}, token);
      assert.equal(re.status, 201, `开始复测失败 ${re.status}: ${JSON.stringify(re.data)}`);
      const v2els = elements(3).map((e, i) => ({ ...e, dur_s: 2.0 + i * 0.5 }));
      const v2 = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t1, cycle_count: 15, cv: 0.05, elements: v2els,
      }, token);
      assert.equal(v2.status, 201, `T1 v2 提交失败 ${v2.status}: ${JSON.stringify(v2.data)}`);
      const t3els = [
        { seq: 1, start_ms: 0, dur_s: 3.0, hand: 'R', type: '持住', desc: T3_DESC, va_class: 'NVA', rating: 1, allowance: 0.15, outlier_flag: 0, outlier_reason: '' },
        { seq: 2, start_ms: 3000, dur_s: 2.0, hand: 'L', type: '移物', desc: `${T3_DESC}-2`, va_class: 'VA', rating: 1, allowance: 0.15, outlier_flag: 0, outlier_reason: '' },
      ];
      const t3r = await postJson(`/api/stations/${stationId}/elements/submit`, {
        task_id: t3, cycle_count: 15, cv: 0.05, elements: t3els,
      }, token);
      assert.equal(t3r.status, 201, `T3 v2 提交失败 ${t3r.status}: ${JSON.stringify(t3r.data)}`);
      const rows = await query(pool,
        `SELECT task_id, bol_version, COUNT(*) AS n, COALESCE(SUM(CASE WHEN outlier_flag = 0 THEN std_time ELSE 0 END), 0) AS ct
         FROM t_element WHERE station_id = @sid GROUP BY task_id, bol_version`, { sid: stationId });
      const ct = (tid, v) => Number(rows.find((r) => String(r.task_id) === tid && Number(r.bol_version) === v)?.ct ?? 0);
      t1V1ct = ct(t1, 1); t1V2ct = ct(t1, 2);
      assert.equal(ct(t3, 2) > 0, true, 'T3 v2 应有要素');
      console.log(`    T1 v1 CT=${t1V1ct} v2 CT=${t1V2ct} · T3 v2 CT=${ct(t3, 2)}`);
    });

    /* ── A-107-1：versions?task_id= 按任务取版本，ΣCT 正确 ───────── */
    await ok('A-107-1 versions?task_id=T1 只含 T1 的版本与 ΣCT（不含 T3 计数）', async () => {
      const r = await getJson(`/api/stations/${stationId}/versions?task_id=${encodeURIComponent(t1)}`, token);
      assert.equal(r.status, 200);
      const withEls = r.data.filter((v) => v.element_count > 0);
      assert.deepEqual(withEls.map((v) => v.version).sort(), [1, 2], `T1 版本集异常：${JSON.stringify(withEls)}`);
      assert.equal(withEls.find((v) => v.version === 1).element_count, 4, 'v1 要素数应为 T1 独有的 4');
      assert.equal(withEls.find((v) => v.version === 2).element_count, 3, 'v2 要素数应为 T1 独有的 3（混入 T3 则为 5）');
      assert.equal(withEls.find((v) => v.version === 1).ct, t1V1ct, 'v1 ΣCT 与 DB 口径不一致');
      assert.equal(withEls.find((v) => v.version === 2).ct, t1V2ct, 'v2 ΣCT 与 DB 口径不一致');
    });

    await ok('A-107-1 versions 不传 task_id 行为逐字不变（全版本枚举 + 字段齐全）', async () => {
      const r = await getJson(`/api/stations/${stationId}/versions`, token);
      assert.equal(r.status, 200);
      assert.equal(r.data.length, 2, '兼容模式应枚举 v1..station.version 全部版本');
      const v1 = r.data.find((v) => v.version === 1);
      const v2 = r.data.find((v) => v.version === 2);
      assert.equal(v1.element_count, 4, 'v1 全任务计数（仅 T1）');
      assert.equal(v2.element_count, 5, 'v2 全任务计数 = T1 3 + T3 2（不过滤＝兼容模式原行为）');
      for (const v of r.data) {
        for (const k of ['version', 'element_count', 'ct', 'is_current', 'is_sealed']) assert.ok(k in v, `缺字段 ${k}`);
      }
      assert.equal(v2.is_current, true);
      assert.equal(v1.is_sealed, true);
    });

    await ok('A-107-1 elements?task_id= 两版要素集归属正确、零 T3 混入', async () => {
      for (const [v, n] of [[1, 4], [2, 3]]) {
        const r = await getJson(`/api/stations/${stationId}/elements?version=${v}&task_id=${encodeURIComponent(t1)}`, token);
        assert.equal(r.status, 200);
        assert.equal(r.data.elements.length, n, `v${v} 要素数`);
        assert.ok(r.data.elements.every((e) => String(e.task_id) === t1), `v${v} 混入非 T1 要素`);
        assert.ok(r.data.elements.every((e) => !String(e.desc).includes('第三任务')), `v${v} 混入 T3 描述要素`);
      }
    });

    await ok('A-107-1 compare?task_id=T1 复用现有端点：ΔCT 与配对结果正确', async () => {
      const r = await getJson(`/api/stations/${stationId}/compare?task_id=${encodeURIComponent(t1)}`, token);
      assert.equal(r.status, 200, `compare 失败 ${r.status}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.prev.version, 1);
      assert.equal(r.data.curr.version, 2);
      assert.equal(r.data.prev.element_count, 4);
      assert.equal(r.data.curr.element_count, 3);
      assert.equal(r.data.prev.ct, t1V1ct, 'prev ΣCT 应为 T1 v1');
      assert.equal(r.data.curr.ct, t1V2ct, 'curr ΣCT 应为 T1 v2');
      assert.equal(r.data.delta_ct, Math.round((t1V1ct - t1V2ct) * 100) / 100, 'ΔCT 口径');
      const t1Ids = new Set((await query(pool,
        `SELECT element_id FROM t_element WHERE station_id = @sid AND task_id = @tid`, { sid: stationId, tid: t1 }))
        .map((x) => String(x.element_id)));
      const seen = [...r.data.pairs, ...r.data.added, ...r.data.removed]
        .flatMap((p) => [p.prev?.element_id, p.curr?.element_id, p.element_id].filter(Boolean).map(String));
      assert.ok(seen.length > 0, '配对结果为空');
      assert.ok(seen.every((id) => t1Ids.has(id)), `混入第三任务要素：${seen.filter((id) => !t1Ids.has(id)).join(',')}`);
    });

    await ok('A-107-1 compare 不传 task_id 行为不变（D1 自动继承唯一生效任务 T1，与显式一致）', async () => {
      const implicit = await getJson(`/api/stations/${stationId}/compare`, token);
      assert.equal(implicit.status, 200, `自动继承应维持 Wave1 行为（200），实际 ${implicit.status}`);
      assert.ok(['inherited', 'explicit'].includes(String(implicit.headers.get('X-Task-Scope'))),
        `D2 响应头异常：${implicit.headers.get('X-Task-Scope')}`);
      const explicit = await getJson(`/api/stations/${stationId}/compare?task_id=${encodeURIComponent(t1)}`, token);
      assert.equal(explicit.status, 200);
      for (const k of ['delta_ct', 'pairing_rate', 'prev', 'curr']) {
        assert.deepEqual(implicit.data[k], explicit.data[k], `无 task_id 与显式 T1 的 ${k} 不一致`);
      }
      assert.equal(implicit.data.pairs.length, explicit.data.pairs.length, '配对数不一致');
    });

    /* ── A-107-2：跨租户 404 ─────────────────────────────────────── */
    await ok('A-107-2 跨租户任务 versions/elements/compare 一律 404', async () => {
      await exec(pool, `INSERT INTO t_decomposition_task
        (task_id, tenant_id, task_no, line_id, name, round_type, round_no, status, created_at)
        VALUES ('DT-XTEST-999', 'OTHER_TENANT', 'DT-9999-999', @lid, N'Phase3契约测试-跨租户', 'legacy', 1, 'active', GETDATE())`, { lid: lineId });
      for (const p of [
        `/api/stations/${stationId}/versions?task_id=DT-XTEST-999`,
        `/api/stations/${stationId}/elements?task_id=DT-XTEST-999`,
        `/api/stations/${stationId}/compare?task_id=DT-XTEST-999`,
      ]) {
        const r = await getJson(p, token);
        assert.equal(r.status, 404, `${p} 应 404，实际 ${r.status}`);
      }
      await exec(pool, `DELETE FROM t_decomposition_task WHERE task_id = 'DT-XTEST-999'`);
    });

    /* ── #107 配套：tasks?station_id= 成员过滤 ───────────────────── */
    await ok('#107 tasks?station_id= 只列包含该工位的任务（同产线非成员任务不出现）', async () => {
      await exec(pool, `INSERT INTO t_decomposition_task
        (task_id, tenant_id, task_no, line_id, name, round_type, round_no, status, created_at)
        VALUES ('DT-XTEST-998', (SELECT tenant_id FROM t_decomposition_task WHERE task_id = @a), 'DT-9999-998', @lid, N'Phase3契约测试-非成员任务', 'baseline', 1, 'archived', GETDATE())`,
      { a: t1, lid: lineId });
      const r = await getJson(`/api/tasks?station_id=${encodeURIComponent(stationId)}&limit=100`, token);
      assert.equal(r.status, 200);
      const ids = r.data.items.map((x) => x.task_id);
      for (const tid of [t1, t2, t3]) assert.ok(ids.includes(tid), `成员任务 ${tid} 未列出`);
      assert.ok(!ids.includes('DT-XTEST-998'), '同产线非成员任务被错误列出');
      const links = new Set((await query(pool, `SELECT task_id FROM t_task_station WHERE station_id = @sid`, { sid: stationId }))
        .map((x) => String(x.task_id)));
      assert.ok(ids.every((id) => links.has(id)), '返回了不含该工位的任务');
      const t2vo = r.data.items.find((x) => x.task_id === t2);
      assert.equal(t2vo.baseline_task_id, t1, 'baseline_task_id 未随任务下发');
      await exec(pool, `DELETE FROM t_decomposition_task WHERE task_id = 'DT-XTEST-998'`);
    });

    /* ── A-107-4：复用现有引擎，新增引擎文件数 = 0 ───────────────── */
    await ok('A-107-4 未新增对比引擎：compare 模块文件集不变、web/src/diff.ts 原样存在', async () => {
      const cmpDir = path.join(__dirname, '..', 'src', 'modules', 'compare');
      const files = fs.readdirSync(cmpDir);
      assert.ok(files.includes('engine.ts'), 'compare/engine.ts 缺失');
      assert.ok(!files.some((f) => /diff/i.test(f)), `compare 模块混入新引擎文件：${files.join(',')}`);
      const engineSrc = fs.readFileSync(path.join(cmpDir, 'engine.ts'), 'utf8');
      assert.ok(/export function (pairElements|estimateBenefit|getLineParams)/.test(engineSrc), 'compare 引擎签名被改动');
      const diffSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'diff.ts'), 'utf8');
      assert.ok(/export function computeDiff/.test(diffSrc), 'web computeDiff 纯函数缺失');
    });

  } finally {
    await cleanup(pool, stationId).catch(() => {});
    await pool.close().catch(() => {});
  }
  finish('Wave3(#107) 契约');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
