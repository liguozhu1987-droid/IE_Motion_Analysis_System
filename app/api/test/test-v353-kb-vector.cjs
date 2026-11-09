/**
 * v3.53 知识库向量化回归（AI_EMBED_BACKEND 两态对比，全 mock 零成本）。
 *
 * Part A（降级态：AI_EMBED_BACKEND 未设，自起实例 3002）：
 *   1. 人工录入 → 整理进知识库：embedding 落 NULL（零依赖零成本默认路径）
 *   2. mock LLM 生成：关键词召回照旧命中（hit_count ≥ 1）——向量分支不参与、行为不回退
 *
 * Part B（向量态：AI_EMBED_BACKEND=ollama + mock 向量服务，自起实例 3002）：
 *   3. archive 写入 embedding（NOT NULL）
 *   4. 语义召回：两条知识行关键词分均为 0，向量分支只捞回语义相近行
 *      （mock LLM 捕获 prompt：含 VECMARK-A，不含 VECMARK-B）
 *
 * mock 向量服务：确定性 32 维字频向量（同文本恒同向量；无共享字符 → 余弦 0）。
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { randomUUID } = require('crypto');
const sql = require('mssql');

const BASE2 = 'http://127.0.0.1:3002/api';
const API_DIR = path.resolve(__dirname, '..');
const DB_PASS = process.env.DB_PASS;
if (!DB_PASS) {
  console.error('缺少 DB_PASS 环境变量：本脚本不内置明文数据库口令，请由部署环境注入后重跑。');
  process.exit(1);
}
const DB = { server: 'localhost', database: 'CN_AME', user: 'sa', password: DB_PASS, options: { encrypt: false, trustServerCertificate: true } };

const MOCK_LLM_PORT = 19113;
const MOCK_EMB_PORT = 19114;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ✓ ' + n + (d ? ' ' + d : '')); } else { fail++; console.log('  ✗ ' + n + ' ' + d); } };

/** 确定性字频向量（与 mock 向量服务同一算法） */
function vecOf(text) {
  const v = new Array(32).fill(0);
  for (const ch of String(text)) v[ch.charCodeAt(0) % 32] += 1;
  return v;
}

const WASTE_PAYLOAD = {
  findings: [{ element_seqs: [1], waste_type: '搬运', evidence: '取料往返距离长（mock）' }],
  issues: [{ element_seqs: [1], waste_type: '搬运', problem: '物料架过远导致往返取料（mock）', ecrs: 'R', suggestion: '物料架移至操作区右手可达范围（mock）' }],
};

let lastPrompt = '';
function startMockLlm() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        lastPrompt = String(parsed?.messages?.[1]?.content ?? '');
      } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(WASTE_PAYLOAD) } }], usage: { total_tokens: 66 } }));
    });
  });
  return new Promise((r) => server.listen(MOCK_LLM_PORT, '127.0.0.1', () => r(server)));
}

/** mock Ollama 嵌入服务：/api/embeddings → { embedding: number[] } */
function startMockEmbed() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let prompt = '';
      try { prompt = String(JSON.parse(body)?.prompt ?? ''); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embedding: vecOf(prompt) }));
    });
  });
  return new Promise((r) => server.listen(MOCK_EMB_PORT, '127.0.0.1', () => r(server)));
}

async function waitHealth(tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(BASE2 + '/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function startInstance(extraEnv) {
  const child = spawn('node', ['dist/src/main.js'], {
    cwd: API_DIR, stdio: 'ignore', detached: false,
    env: { ...process.env, PORT: '3002', ...extraEnv },
  });
  return child;
}

function stopInstance(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => setTimeout(resolve, 800)); // 等端口释放
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(resolve, 3000); // 兜底
  });
}

(async () => {
  const mockLlm = await startMockLlm();
  let pool = await sql.connect(DB);
  let child = null;
  let mockEmbed = null;
  let admin = '';

  const login = async (u, p) => {
    const r = await fetch(BASE2 + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    return (await r.json()).accessToken;
  };
  const call = async (m, p, body, token) => {
    const res = await fetch(BASE2 + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    return { status: res.status, data: d };
  };
  const setKey = async (k, v) => pool.request().query(
    `IF EXISTS (SELECT 1 FROM t_ai_setting WHERE setting_key='${k}') UPDATE t_ai_setting SET setting_value='${v}' WHERE setting_key='${k}'
     ELSE INSERT INTO t_ai_setting (setting_key, setting_value, updated_by) VALUES ('${k}','${v}','v353-vec')`);

  /* 前置：停用真实 profile（否则旁路 mock），记录原 ai_enabled */
  await pool.request().query('UPDATE t_ai_llm_profile SET enabled = 0');
  const origEnabled = (await pool.request().query("SELECT setting_value FROM t_ai_setting WHERE setting_key='ai_enabled'")).recordset[0]?.setting_value ?? '1';

  /* ═══ Part A：降级态（无 AI_EMBED_BACKEND） ═══ */
  console.log('— Part A：降级态实例（无向量后端） —');
  child = startInstance({});
  ok('A0 实例就绪', await waitHealth());
  admin = await login('admin', '123456');
  ok('登录 admin（3002）', Boolean(admin));

  /** 找含手工要素的工位，返回 {SID, types, firstSeq} */
  const pickStation = async () => {
    const st = await call('GET', '/stations', null, admin);
    const arr = Array.isArray(st.data) ? st.data : (st.data.stations ?? []);
    for (const s of arr.slice(0, 25)) {
      const els = await call('GET', `/stations/${s.station_id}/elements`, null, admin);
      const list = (els.data?.elements ?? []).filter((e) => (e.source ?? 'manual') === 'manual');
      if (list.length > 0) {
        return { SID: s.station_id, types: [...new Set(list.map((e) => String(e.type ?? '')).filter(Boolean))], firstSeq: Number(list[0].seq) };
      }
    }
    return null;
  };

  /** FK 安全顺序清空工位 AI 浪费从表（finding → issue → batch；保留知识库行） */
  const clearStationWaste = async (SID) => {
    await pool.request().query(`DELETE FROM t_ai_waste_finding WHERE station_id='${SID}'`);
    await pool.request().query(`DELETE FROM t_ai_waste_issue WHERE station_id='${SID}'`);
    await pool.request().query(`DELETE FROM t_ai_waste_batch WHERE station_id='${SID}'`);
  };

  /** 收尾清理：从表 + 本测试产生的知识库行 */
  const cleanupStation = async (SID) => {
    await clearStationWaste(SID);
    await pool.request().query(`DELETE FROM t_ai_waste_kb WHERE station_id='${SID}' OR source_ref LIKE 'VECMARK-%' OR created_by='v353-vec'`);
  };

  const pa = await pickStation();
  ok('A1 找到含手工要素工位', Boolean(pa), `${pa?.SID} types=${(pa?.types ?? []).join('/')}`);
  if (pa) {
    /* waste_type 走 waste_triggers/ecrsa_map 白名单（持住/重复取放/搬运/等待/寻找选择/检验冗余/预对），
       与要素类型（移物/装配/持住…）是两套词表——原先 `pa.types[0]` 把要素类型当浪费类型传，
       仅当首个要素类型恰好撞上「持住」时才侥幸 201，其余一律 400。改用固定合法值。 */
    const mi = await call('POST', `/stations/${pa.SID}/ai-waste/manual/issues`, {
      waste_type: '搬运', problem: '字频向量降级验证：物料架距操作区过远，每循环往返取料',
      ecrs: 'R', suggestion: '物料架移至操作区右手可达范围，取消往返', element_seqs: [pa.firstSeq],
    }, admin);
    ok('A2 人工录入 201', mi.status === 201, `status=${mi.status}`);

    await call('POST', `/stations/${pa.SID}/ai-waste/kb/archive`, {}, admin);
    const kbRow = (await pool.request().query(
      `SELECT kb_id, embedding, keywords FROM t_ai_waste_kb WHERE source_ref='${mi.data.issue_id}'`)).recordset[0];
    ok('A3 降级态：archive 后 embedding 为 NULL（零成本默认路径）',
      Boolean(kbRow) && kbRow.embedding === null, `kb=${kbRow?.kb_id} embedding=${kbRow?.embedding}`);
    ok('A4 降级态：关键词含引用的要素类型（供关键词召回）',
      pa.types.some((t) => String(kbRow?.keywords ?? '').includes(t)), String(kbRow?.keywords ?? '').slice(0, 60));

    await setKey('ai_enabled', '1');
    await setKey('llm_base_url', `http://127.0.0.1:${MOCK_LLM_PORT}/v1`);
    await setKey('llm_api_key', 'test-key');
    await setKey('llm_model', 'mock-model');
    await clearStationWaste(pa.SID); // 清旧批次绕开幂等 200；知识库行（本次断言对象）保留
    const gen = await call('POST', `/stations/${pa.SID}/ai-waste/generate-manual`, null, admin);
    ok('A5 mock 生成 200', gen.status === 200, `status=${gen.status}`);

    let hits = -1;
    for (let i = 0; i < 10; i += 1) {
      const r = (await pool.request().query(
        `SELECT hit_count FROM t_ai_waste_kb WHERE kb_id='${kbRow.kb_id}'`)).recordset[0];
      hits = Number(r?.hit_count ?? 0);
      if (hits >= 1) break;
      await new Promise((r2) => setTimeout(r2, 500));
    }
    ok('A6 降级态：关键词召回照旧命中（hit_count ≥ 1）', hits >= 1, `hit_count=${hits}`);
  }

  /* ═══ Part B：向量态（AI_EMBED_BACKEND=ollama + mock 向量服务） ═══ */
  await stopInstance(child); child = null;
  mockEmbed = await startMockEmbed();
  console.log('— Part B：向量态实例（ollama mock） —');
  child = startInstance({ AI_EMBED_BACKEND: 'ollama', AI_EMBED_OLLAMA_URL: `http://127.0.0.1:${MOCK_EMB_PORT}` });
  ok('B0 实例就绪', await waitHealth());

  const pb = await pickStation();
  ok('B1 找到含手工要素工位', Boolean(pb), `${pb?.SID} types=${(pb?.types ?? []).join('/')}`);
  if (pb) {
    const qText = pb.types.join(' '); // searchKb 的查询文本 = 要素类型拼接
    /* 两条关键词分均为 0 的知识行：keywords 用不可能命中要素词表的值、element_types 空、通用（station_id NULL） */
    const mkRow = (embedText, marker) => {
      const kbId = randomUUID();
      return pool.request()
        .input('kb', kbId).input('marker', marker)
        .input('emb', JSON.stringify(vecOf(embedText)))
        .query(`INSERT INTO t_ai_waste_kb (kb_id, tenant_id, station_id, kind, waste_type, ecrs, problem, suggestion,
            keywords, element_types, source_origin, source_ref, hit_count, status, created_by, embedding)
          VALUES (@kb, 'DEFAULT', NULL, 'issue', '搬运', 'R', @marker, 'VECMARK 措施占位',
            'zzz_none', NULL, 'manual', @marker, 0, 'active', 'v353-vec', @emb)`);
    };
    const nearText = `${qText} 无效移动浪费`;                 // 与查询共享全部字符 → 余弦 > 0
    const farText = pickFarText(qText);                        // 与查询零共享字符 → 余弦 = 0
    await mkRow(nearText, 'VECMARK-A');
    await mkRow(farText, 'VECMARK-B');
    ok('B2 注入两条零关键词分知识行（近/远）', true, `near="${nearText}" far="${farText}"`);

    await clearStationWaste(pb.SID); // 清旧批次绕开幂等 200；VECMARK 知识行（station_id NULL）不受影响
    const gen = await call('POST', `/stations/${pb.SID}/ai-waste/generate-manual`, null, admin);
    ok('B3 mock 生成 200', gen.status === 200, `status=${gen.status}`);
    ok('B4 语义召回到近邻行（prompt 含 VECMARK-A）', lastPrompt.includes('VECMARK-A'), lastPrompt.slice(0, 80));
    ok('B5 远邻行未被捞回（prompt 不含 VECMARK-B）', !lastPrompt.includes('VECMARK-B'));

    /* archive 写入路径：向量 NOT NULL */
    const mi = await call('POST', `/stations/${pb.SID}/ai-waste/manual/issues`, {
      waste_type: '搬运', problem: '字频向量写入验证：物料架距操作区过远',
      ecrs: 'R', suggestion: '物料架移至操作区右手可达范围', element_seqs: [pb.firstSeq],
    }, admin);
    ok('B6a 人工录入 201', mi.status === 201, `status=${mi.status}`);
    await call('POST', `/stations/${pb.SID}/ai-waste/kb/archive`, {}, admin);
    const kbRow = (await pool.request().query(
      `SELECT embedding FROM t_ai_waste_kb WHERE source_ref='${mi.data.issue_id}'`)).recordset[0];
    ok('B6 向量态：archive 写入 embedding（NOT NULL）', Boolean(kbRow?.embedding), `len=${String(kbRow?.embedding ?? '').length}`);
    const vecOk = (() => { try { return Array.isArray(JSON.parse(kbRow.embedding)) && JSON.parse(kbRow.embedding).length === 32; } catch { return false; } })();
    ok('B7 向量态：embedding 为 32 维 JSON 数组', vecOk);
  }

  /* ── 清理：数据 / 配置 / 实例 ── */
  if (pa) await cleanupStation(pa.SID);
  if (pb) await cleanupStation(pb.SID);
  await setKey('llm_base_url', '');
  await pool.request().query("DELETE FROM t_ai_setting WHERE setting_key IN ('llm_api_key','llm_model')");
  await setKey('ai_enabled', origEnabled);
  await pool.request().query(`UPDATE t_ai_llm_profile SET enabled = 1 WHERE name = N'初始配置'`);
  await stopInstance(child);
  if (mockEmbed) mockEmbed.close();
  await pool.close();
  mockLlm.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('异常：', e);
  try {
    const p = await sql.connect(DB);
    await p.request().query("UPDATE t_ai_setting SET setting_value = '' WHERE setting_key = 'llm_base_url'");
    await p.request().query('UPDATE t_ai_llm_profile SET enabled = 1 WHERE name = N\'初始配置\'');
    await p.close();
  } catch { /* ignore */ }
  process.exit(1);
});

/** 选一个与查询 bucket 零重叠的中文串（字频向量余弦必为 0；按 charCode%32 选桶避免碰撞） */
function pickFarText(query) {
  const usedBuckets = new Set([...String(query)].map((ch) => ch.charCodeAt(0) % 32));
  const pool = '检查装配外观不良问题松动磨损偏移误差';
  let out = '';
  for (const ch of pool) if (!usedBuckets.has(ch.charCodeAt(0) % 32)) out += ch;
  return out.length >= 4 ? out : '检查装配外观不良';
}
