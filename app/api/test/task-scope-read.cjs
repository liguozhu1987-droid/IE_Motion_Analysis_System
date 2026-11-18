/**
 * Phase 3 / Wave 1 · #104 读取侧真实 HTTP 契约（A-104-1~5）
 * ------------------------------------------------------------
 * 前置：API 已启动（生产 mssql，默认 http://127.0.0.1:3001）。
 * 夹具：独立新建工位 + T1(active)/T2(archived) 各 4/3 条要素，跑完按名清理。
 *
 *   node test/task-scope-read.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const L = require('./task-scope-lib.cjs');
const { assert, ok, finish, login, call, postJson, getJson, db, query, exec, elements, cleanup } = L;

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.resolve(__dirname, '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A-104-1：全仓要素取数点静态扫描（withTask / matchesTask / 显式兼容标注） */
function scanTakePoints() {
  const REPO = /getRepository\(Element\)|getRepository\('t_element'\)|elementRepo\.find\(|createQueryBuilder\(Element|this\.repo\.find\(/;
  const OP = /\.find\(|\.count\(|\.countBy\(|\.createQueryBuilder\(|\.delete\(|\.getRawMany\(|\.getRawOne\(/;
  const MARK = /withTask\(|matchesTask\(|task_id|\[task-scope:compat\]/;
  const hits = [];
  const misses = [];
  for (const file of walk(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!REPO.test(line)) return;
      // 「const elementRepo = ds.getRepository('t_element')」只是声明，真正的取数在后续语句；
      // 声明行本身不产生数据，避免把整段聚合误判成残留。
      if (!OP.test(line) && !OP.test(lines.slice(i, i + 4).join('\n'))) return;
      // this.repo.find 只在要素服务里指向 ElementRepository，其余模块是别的实体
      if (/this\.repo\.find\(/.test(line) && !file.endsWith(path.join('elements', 'elements.service.ts'))) return;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const win = lines.slice(Math.max(0, i - 14), i + 15).join('\n');
      (MARK.test(win) ? hits : misses).push(`${rel}:${i + 1}`);
    });
  }
  return { hits, misses };
}

async function main() {
  console.log(`task-scope 读取侧契约　${L.BASE}`);
  const token = await login('admin');
  const viewer = await login('viewer1').catch(() => null);
  const pool = await db();
  let lineId, stationId, t1, t2, ids1 = [], ids2 = [];

  try {
    /* ── A-104-1 ─────────────────────────────────────────────────── */
    await ok('A-104-1 全仓要素取数点残留 = 0（withTask / matchesTask / 显式 compat）', () => {
      const { hits, misses } = scanTakePoints();
      assert.ok(hits.length > 0, '未扫描到任何要素取数点（扫描规则失效）');
      assert.deepEqual(misses, [], `未收口的取数点：${misses.join(', ')}`);
      console.log(`    扫描 ${hits.length} 处取数点，全部带任务条件或显式 compat 标注`);
    });

    /* ── A-104-5 ─────────────────────────────────────────────────── */
    await ok('A-104-5 engine.ts 纯函数签名与算法逐字未变（git diff 为空）', () => {
      const rel = 'app/api/src/modules/analysis/engine.ts';
      const diff = execSync(`git diff -- ${rel}`, { cwd: ROOT }).toString().trim();
      assert.equal(diff, '', 'engine.ts 被改动');
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.match(src, /export function analyzeStation\(station: any, elements: any\[\], vaRules: any, wasteRules: any\): any \{/);
    });

    /* ── 夹具 ────────────────────────────────────────────────────── */
    await ok('A-104-0 夹具：新建工位 + T1/T2 两任务各 4/3 条要素', async () => {
      const st = await getJson('/api/stations', token);
      lineId = String(st.data[0].line_id);
      stationId = `${lineId}-ST98`;
      await cleanup(pool, stationId);
      const c = await postJson('/api/stations', {
        station_id: stationId, line_id: lineId, name: 'Phase3契约测试-读取侧工位', tt: 40,
      }, token);
      assert.equal(c.status, 201, `建工位失败 ${c.status}: ${JSON.stringify(c.data)}`);
      for (const [key, name, n] of [['t1', 'Phase3契约测试-读取侧A', 4], ['t2', 'Phase3契约测试-读取侧B', 3]]) {
        const r = await postJson('/api/tasks', {
          line_id: lineId, name, period_start: '2026-11-01', period_end: '2026-11-05',
          round_type: 'baseline', station_ids: [stationId],
        }, token);
        assert.equal(r.status, 201, `建任务失败 ${r.status}: ${JSON.stringify(r.data)}`);
        const id = r.data.task_id;
        const s = await postJson(`/api/stations/${stationId}/elements/submit`, {
          task_id: id, cycle_count: 15, cv: 0.05, elements: elements(n),
        }, token);
        assert.equal(s.status, 201, `要素提交失败 ${s.status}: ${JSON.stringify(s.data)}`);
        if (key === 't1') t1 = id; else t2 = id;
      }
      // 再开一个复测版本：让 compare 真正返回 200（而不是「版本不足」409），
      // 才能验证 listVersions / analyzeStationAtVersion 也按任务隔离。
      const rt = await postJson(`/api/stations/${stationId}/retest`, {}, token);
      assert.equal(rt.status, 201, `开复测失败 ${rt.status}: ${JSON.stringify(rt.data)}`);
      assert.equal(Number(rt.data.version), 2);
      for (const [id, n] of [[t1, 4], [t2, 3]]) {
        const s = await postJson(`/api/stations/${stationId}/elements/submit`, {
          task_id: id, bol_version: 2, cycle_count: 15, cv: 0.05, elements: elements(n),
        }, token);
        assert.equal(s.status, 201, `v2 提交失败 ${s.status}: ${JSON.stringify(s.data)}`);
      }
      await exec(pool, `UPDATE t_decomposition_task SET status = 'archived' WHERE task_id = @tid`, { tid: t2 });
      ids1 = (await query(pool, `SELECT element_id FROM t_element WHERE task_id = @tid`, { tid: t1 }))
        .map((r) => String(r.element_id));
      ids2 = (await query(pool, `SELECT element_id FROM t_element WHERE task_id = @tid`, { tid: t2 }))
        .map((r) => String(r.element_id));
      assert.equal(ids1.length, 8, 'T1 应有 v1/v2 两版共 8 条');
      assert.equal(ids2.length, 6, 'T2 应有 v1/v2 两版共 6 条');
      console.log(`    T1=${t1}(4+4 条) T2=${t2}(3+3 条) 工位 ${stationId} · v1/v2 两版`);
    });

    /* ── A-104-2 ─────────────────────────────────────────────────── */
    let ct1, ct2;
    await ok('A-104-2 analysis 传不同 task_id 返回不同 ΣCT/要素数；不传时自动继承且不串', async () => {
      const a = await getJson(`/api/stations/${stationId}/analysis?task_id=${encodeURIComponent(t1)}`, token);
      const b = await getJson(`/api/stations/${stationId}/analysis?task_id=${encodeURIComponent(t2)}`, token);
      assert.equal(a.status, 200, `T1 分析失败 ${a.status}`);
      assert.equal(b.status, 200, `T2 分析失败 ${b.status}`);
      ct1 = Number(a.data.metrics.ct); ct2 = Number(b.data.metrics.ct);
      assert.notEqual(ct1, ct2, '两任务 ΣCT 相同，未按任务隔离');
      assert.equal(a.data.elements.length, 4);
      assert.equal(b.data.elements.length, 3);
      assert.equal(a.data.task_scope.source, 'explicit');
      assert.ok(!JSON.stringify(a.data).includes(ids2[0]), 'T1 结果混入 T2 的 element_id');
      const auto = await getJson(`/api/stations/${stationId}/analysis`, token);
      assert.equal(auto.status, 200);
      assert.equal(auto.data.task_scope.source, 'inherited');
      assert.equal(Number(auto.data.metrics.ct), ct1, '未自动继承唯一生效任务 T1');
      assert.ok(!JSON.stringify(auto.data).includes(ids2[0]), '自动继承结果混入 T2 的 element_id');
      console.log(`    ΣCT：T1=${ct1}s / T2=${ct2}s · 自动继承=T1`);
    });

    /* ── A-104-3 五类端点 ─────────────────────────────────────────── */
    await ok('A-104-3 compare / suggestions / ai-* / dashboard / lines 五类端点均不串任务', async () => {
      const cases = [
        ['compare', 'GET', `/api/stations/${stationId}/compare?task_id=${encodeURIComponent(t1)}`],
        ['suggestions', 'POST', `/api/stations/${stationId}/suggestions/generate?task_id=${encodeURIComponent(t1)}`],
        ['ai-waste', 'GET', `/api/stations/${stationId}/ai-waste/latest?task_id=${encodeURIComponent(t1)}`],
        ['dashboard', 'GET', `/api/dashboard/summary?task_id=${encodeURIComponent(t1)}`],
        ['lines', 'GET', `/api/lines/summary?task_id=${encodeURIComponent(t1)}`],
      ];
      for (const [name, method, url] of cases) {
        const r = method === 'POST' ? await postJson(url, {}, token) : await getJson(url, token);
        assert.ok(r.status < 500, `${name} 返回 5xx：${r.status} ${String(r.text).slice(0, 160)}`);
        if (name === 'compare') assert.equal(r.status, 200, `compare 应基于 v1/v2 正常返回：${String(r.text).slice(0, 200)}`);
        assert.ok(!String(r.text).includes(ids2[0]), `${name} 结果混入 T2 的 element_id`);
        console.log(`    ${name}: ${r.status}`);
      }
      const cmpT2 = await getJson(`/api/stations/${stationId}/compare?task_id=${encodeURIComponent(t2)}`, token);
      assert.equal(cmpT2.status, 200, 'T2 版本对比失败');
      assert.ok(!String(cmpT2.text).includes(ids1[0]), 'T2 对比结果混入 T1 的 element_id');
      // 静态铁律：ai-* 不自带要素取数，全部经 AnalysisService（已带 withTask）
      for (const f of ['ai-suggest/ai-suggest.service.ts', 'ai-waste/ai-waste.service.ts', 'ai-insight/ai-insight.service.ts']) {
        const src = fs.readFileSync(path.join(SRC, 'modules', f), 'utf8');
        assert.ok(/analyzeStation(AtVersion)?\(/.test(src), `${f} 未走 AnalysisService`);
        assert.ok(!/getRepository\(Element\)|elementRepo\.find\(/.test(src), `${f} 绕开 AnalysisService 直取要素`);
      }
    });

    await ok('A-104-3 dashboard / lines 显式任务与自动继承的聚合结果按任务分区', async () => {
      const d1 = await getJson(`/api/dashboard/summary?task_id=${encodeURIComponent(t1)}`, token);
      const d2 = await getJson(`/api/dashboard/summary?task_id=${encodeURIComponent(t2)}`, token);
      assert.equal(d1.status, 200); assert.equal(d2.status, 200);
      assert.notEqual(JSON.stringify(d1.data), JSON.stringify(d2.data), 'dashboard 缓存未按任务分区');
      const l1 = await getJson(`/api/lines/summary?task_id=${encodeURIComponent(t1)}`, token);
      const l2 = await getJson(`/api/lines/summary?task_id=${encodeURIComponent(t2)}`, token);
      assert.equal(l1.status, 200); assert.equal(l2.status, 200);
      assert.notEqual(JSON.stringify(l1.data), JSON.stringify(l2.data), 'lines 未按任务过滤');
    });

    /* ── A-104-4 ─────────────────────────────────────────────────── */
    await ok('A-104-4 不可见工位静默剔除 / 单工位读 403 / 跨租户任务 404', async () => {
      if (viewer) {
        const hidden = await getJson(`/api/stations/${stationId}/analysis`, viewer);
        assert.ok([403, 404].includes(hidden.status), `不可见工位期望 403/404，实际 ${hidden.status}`);
        const dash = await getJson('/api/dashboard/summary', viewer);
        assert.equal(dash.status, 200);
        assert.ok(!String(dash.text).includes(stationId), '驾驶舱泄露不可见工位');
      }
      await exec(pool, `INSERT INTO t_decomposition_task
        (task_id, tenant_id, task_no, line_id, name, round_type, round_no, period_start, period_end,
         status, baseline_task_id, project_id, project_no_snapshot, rule_versions, owner_user_id, created_by, created_at, closed_at)
        SELECT 'DT-XTEST-999', 'PHASE3_TEST', 'DT-XTEST-999', line_id, N'Phase3契约测试-跨租户', round_type, round_no,
               period_start, period_end, status, NULL, NULL, NULL, rule_versions, NULL, 'test', created_at, NULL
        FROM t_decomposition_task WHERE task_id = @tid`, { tid: t1 });
      const cross = await getJson(`/api/stations/${stationId}/analysis?task_id=DT-XTEST-999`, token);
      assert.equal(cross.status, 404, `跨租户期望 404，实际 ${cross.status}`);
    });
  } finally {
    await cleanup(pool, stationId).catch((e) => console.error('    清理失败：' + e.message));
    await pool.close().catch(() => {});
  }
  finish('A-104 读取侧');
}

main().catch((e) => { console.error('契约异常：', e); process.exitCode = 1; });
