import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, ApiError,
  type AiWasteElementSource, type AiWasteFinding, type AiWasteIssue, type AiWasteItemsResult,
  type AiWasteLatestResult, type AiWasteTier,
} from '../api';
import { useAuth } from '../auth';
import { METHOD_LABEL } from '../constants';
import AiCallBanner from '../components/AiCallBanner';
import AiWasteManualDialog from '../components/AiWasteManualDialog';
import AiWasteKbPanel from '../components/AiWasteKbPanel';

/**
 * P3-9 浪费识别 + 改善问题清单（#/ai-waste/:stationId · 工位工作区第六页签）。
 * v3.45 双来源线：AI 分解线（source=ai_assisted，默认）/ 手工分解线（source=manual，
 * 由工作台「AI自动识别浪费」按钮经 `?source=manual` 直达）——两线批次/幂等相互隔离，
 * 清单分开呈现（设计 D2/D6）；默认页签 AI 线保证既有 22/22 UI 回归。
 *
 * 边界铁律（用户裁定）：本模块与分解工作台 AI 建议页（#/ai-suggestions）是相互独立的
 * 两个模块——路由/页面/接口/数据表全部独立，不做任何交叉合并。
 *
 * 交互主线：
 *  1. 「开始识别」→ POST generate / generate-manual（后端 LLM→W1-W3 校验→数字服务端算→落库待处理）；
 *  2. 浪费点列表（severity 3 档徽标 + pct_of_ct 占比）+ 问题清单卡片（ECRS 徽标 + tier + 待处理/已确认/已忽略）;
 *  3. 问题条目「确认」（→t_improvement source=ai 溯源）或「忽略」（终态）；
 *  4. 校验轨迹折叠面板（W1-W3 处置透明）；
 *  5. 识别摘要卡（P1-3：by_type 分布 + 预计总节省 + 占 CT 比——数字全部取服务端 summary 字段，前端零计算）。
 */

/** 批次状态徽标与文案 */
const AW_BATCH_META: Record<AiWasteLatestResult['status'], { label: string; cls: string }> = {
  running: { label: '识别中…', cls: 't-blue' },
  done: { label: '已识别', cls: 't-teal' },
  done_empty: { label: '未识别到浪费', cls: 't-amber' },
  failed: { label: '识别失败', cls: 't-red' },
};

/** ECRS 徽标配色（与工作台口径一致：E红/C蓝/R琥珀/S青） */
const AW_METHOD_CLS: Record<AiWasteIssue['ecrs'], string> = {
  E: 't-red', C: 't-blue', R: 't-amber', S: 't-teal',
};
const AW_TIER_CLS: Record<AiWasteTier, string> = { P1: 't-red', P2: 't-amber', P3: 't-gray' };
/** severity 1轻微/2一般/3严重 */
const AW_SEV_META: Record<number, { label: string; cls: string }> = {
  1: { label: '轻微', cls: 't-gray' },
  2: { label: '一般', cls: 't-amber' },
  3: { label: '严重', cls: 't-red' },
};

/** 来源线徽标（页头 + 批次历史共用）：ai_assisted→「AI 分解」/ manual→「手工分解」 */
const AW_SOURCE_META: Record<AiWasteElementSource, { label: string; cls: string; title: string }> = {
  ai_assisted: { label: 'AI 分解', cls: 't-blue', title: '要素来源：AI 自动分解写入（source=ai_assisted）' },
  manual: { label: '手工分解', cls: 't-amber', title: '要素来源：手工分解写入（source=manual）' },
};

/** 校验轨迹归一为可展示行（W1-W3：{round, rule, hit, reason}） */
interface AwTraceRow { round: string; rule: string; hit: boolean; reason: string }
function awTraceRows(trace: unknown): AwTraceRow[] {
  if (trace == null) return [];
  if (Array.isArray(trace)) {
    return trace.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        round: String(o.round ?? '—'),
        rule: String(o.rule ?? '—'),
        hit: Boolean(o.hit),
        reason: String(o.reason ?? o.detail ?? JSON.stringify(o)),
      };
    });
  }
  return [];
}

export default function AiWastePage(
  { stationId, initialSource }: { stationId: string; initialSource?: AiWasteElementSource },
) {
  const { can } = useAuth();
  const canGenerate = can('suggestion:generate');

  /** 当前来源线页签（缺省 ai_assisted——既有默认路径不变） */
  const [source, setSource] = useState<AiWasteElementSource>(initialSource ?? 'ai_assisted');
  const [data, setData] = useState<AiWasteLatestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 流转中的 issue_id */
  const [decidingId, setDecidingId] = useState<string | null>(null);
  /** 展开校验轨迹的 issue_id */
  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({});
  /** 批次历史展开 */
  const [batchesOpen, setBatchesOpen] = useState(false);
  /** v3.51：合并清单（AI 批次条目 + 人工录入条目；AI 关停亦可查） */
  const [itemsData, setItemsData] = useState<AiWasteItemsResult | null>(null);
  /** 来源筛选：all=全部 / ai=AI 识别 / manual=人工录入 */
  const [originFilter, setOriginFilter] = useState<'all' | 'ai' | 'manual'>('all');
  /** 清单范围：latest=最新批次 / all=全部历史批次 */
  const [scopeAll, setScopeAll] = useState(false);
  /** 人工录入表单（null=关闭） */
  const [form, setForm] = useState<{ kind: 'finding' | 'issue'; editing: AiWasteFinding | AiWasteIssue | null } | null>(null);
  /** 知识库面板 */
  const [kbOpen, setKbOpen] = useState(false);
  const [batches, setBatches] = useState<Array<{
    batch_id: string; status: AiWasteLatestResult['status']; version: number;
    element_source: string; element_count: number;
    finding_count: number; issue_count: number; tokens_used: number; model: string | null;
    prompt_version: string | null; error: string | null; created_at: string; completed_at: string | null;
  }>>([]);

  /* 数据加载（受保护：无权限不请求，纪律 #10；按当前页签 source 隔离） */
  const load = useCallback(async (opts?: { keepError?: boolean }) => {
    if (!canGenerate) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await api.aiWaste.latest(stationId, source);
      setData(res);
      if (!opts?.keepError) setError(null);
    } catch (err) {
      // v3.51：latest 依赖 AI 开关（关闭 → 503）。此时不报错——合并清单 items 仍可查历史批次与人工条目，
      // 「AI 出不来清单」正是需要看历史/人工清单的场景，不能让整个页面挂掉。
      if (err instanceof ApiError && (err.status === 404 || err.status === 503)) {
        setData(null);
      } else {
        setError((err as Error).message);
        setData(null);
      }
    } finally {
      setLoading(false);
    }
    // 合并清单（独立请求：AI 关闭或批次缺失都不影响）
    try {
      setItemsData(await api.aiWaste.items(stationId, {
        origin: 'all', scope: scopeAll ? 'all' : 'latest', source,
      }));
    } catch {
      setItemsData(null);
    }
  }, [stationId, canGenerate, source, scopeAll]);

  useEffect(() => { void load(); }, [load]);

  /* running → 3s 轮询；其余停止 */
  const batchStatus = data?.status ?? null;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (batchStatus === 'running') {
      pollRef.current = setInterval(() => { void load({ keepError: true }); }, 3000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [batchStatus, load]);

  /* 页签切换：清空旧线数据/批次历史/提示，load 依赖 source 自动重取 */
  const switchSource = (next: AiWasteElementSource) => {
    if (next === source) return;
    setSource(next);
    setData(null);
    setBatchesOpen(false);
    setBatches([]);
    setTraceOpen({});
    setError(null);
    setMsg(null);
  };

  /* 识别生成：幂等 200 / running 409 / 无对应来源要素 400 / 服务关 503 */
  const generate = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const res = source === 'manual'
        ? await api.aiWaste.generateManual(stationId)
        : await api.aiWaste.generate(stationId);
      setMsg(res.idempotent_hit
        ? '已识别过：展示历史结果（幂等命中，不重复消耗 tokens）'
        : '浪费识别完成：发现 ' + (res.findings?.length ?? 0) + ' 个浪费点，生成 ' + (res.issues?.length ?? 0) + ' 条问题清单（待处理）');
      setData(res);
      setError(null);
      // v3.51：生成后必须刷新合并清单（items 是独立请求，不刷会停留在生成前的空列表）
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('识别进行中：该工位已有浪费识别任务执行，请稍候（页面每 3 秒自动刷新）。');
        await load({ keepError: true });
      } else if (err instanceof ApiError && err.status === 400) {
        setError(err.message || (source === 'manual'
          ? '该工位当前版本没有手工分解要素（source=manual）。请先在分解工作台提交手工分解，或切换到「AI 分解线」页签。'
          : '该工位当前版本没有 AI 自动分解写入的要素（source=ai_assisted）。请先做一次 AI 自动分解，或切换到「手工分解线」页签。'));
      } else if (err instanceof ApiError && err.hint) {
        setError(`${err.message}（${err.hint}）`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  /* 状态流转：确认→t_improvement；忽略→终态 */
  const settle = async (it: AiWasteIssue, status: '已确认' | '已忽略') => {
    if (status === '已确认') {
      const okToGo = window.confirm(
        `确认该问题条目进入改善任务？\n\n${it.problem.slice(0, 60)}\n\n`
        + `确认后复制为改善任务（状态「待实施」，溯源本条目），状态置为「已确认」不可回退。`,
      );
      if (!okToGo) return;
    }
    setDecidingId(it.issue_id); setError(null); setMsg(null);
    try {
      await api.aiWaste.settle(it.issue_id, status);
      setMsg(status === '已确认' ? '已确认：问题条目复制为改善任务（待实施）' : '已忽略：条目置为终态');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDecidingId(null);
    }
  };

  /* v3.51：删除人工条目（AI 产出服务端 409 兜底，前端也不给入口） */
  const removeFinding = async (f: AiWasteFinding) => {
    if (!window.confirm(`删除该人工浪费点？\n\n${f.evidence.slice(0, 60)}`)) return;
    setError(null); setMsg(null);
    try {
      await api.aiWaste.deleteFinding(f.finding_id);
      setMsg('已删除人工浪费点');
      await load();
    } catch (err) { setError((err as Error).message); }
  };
  const removeIssue = async (it: AiWasteIssue) => {
    if (!window.confirm(`删除该人工改善措施？\n\n${it.problem.slice(0, 60)}`)) return;
    setError(null); setMsg(null);
    try {
      await api.aiWaste.deleteIssue(it.issue_id);
      setMsg('已删除人工改善措施');
      await load();
    } catch (err) { setError((err as Error).message); }
  };

  /* 批次历史展开（按当前页签 source 隔离） */
  const toggleBatches = async () => {
    if (batchesOpen) { setBatchesOpen(false); return; }
    try {
      const res = await api.aiWaste.batches(stationId, source);
      setBatches(res.batches ?? []);
      setBatchesOpen(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /* v3.51：清单取合并视图（AI 批次条目 + 人工录入条目），按来源筛选后渲染——
     无人工条目时与 latest 完全等价（既有 UI 回归的表格/卡片计数不变） */
  const allFindings = itemsData?.findings ?? data?.findings ?? [];
  const allIssues = itemsData?.issues ?? data?.issues ?? [];
  const findings = originFilter === 'all' ? allFindings : allFindings.filter((f) => (f.origin ?? 'ai') === originFilter);
  const issues = originFilter === 'all' ? allIssues : allIssues.filter((i) => (i.origin ?? 'ai') === originFilter);
  const manualCount = allFindings.filter((f) => f.origin === 'manual').length
    + allIssues.filter((i) => i.origin === 'manual').length;
  const aiCount = allFindings.length + allIssues.length - manualCount;
  const pending = issues.filter((i) => i.status === '待处理').length;
  const confirmed = issues.filter((i) => i.status === '已确认').length;
  const ignored = issues.filter((i) => i.status === '已忽略').length;
  const summary = data?.summary ?? null;

  if (!canGenerate) {
    return <div className="card empty">当前角色无浪费识别权限（缺少 suggestion:generate）。浪费识别仅对 IE 工程师及以上角色开放。</div>;
  }

  return (
    <div className="aw-page">
      <div className="page-head">
        <h1>浪费识别与改善问题清单</h1>
        {/* 来源徽标（element_source）+ 版本展示（P1-2/P0-6） */}
        <span className={`tag ${AW_SOURCE_META[data?.element_source ?? source].cls}`}
          title={AW_SOURCE_META[data?.element_source ?? source].title}>
          {AW_SOURCE_META[data?.element_source ?? source].label}
        </span>
        <span className="muted mono" style={{ fontSize: 12 }} title="识别结果对应的工位版本">v{data?.version ?? '—'}</span>
        <span className="sub">
          基于 {source === 'manual' ? '手工分解' : 'AI 自动分解'}要素识别七大浪费并生成待处理问题清单 ·
          待处理 {pending} · 已确认 {confirmed} · 已忽略 {ignored}
        </span>
        <div className="spacer" />
        {/* v3.51：人工录入与知识库（与 AI 生成并存——AI 出不来清单时可人工兜底，人工经验反哺 AI） */}
        <button type="button" className="btn sm" onClick={() => setForm({ kind: 'finding', editing: null })}>
          + 人工浪费点
        </button>
        <button type="button" className="btn sm" onClick={() => setForm({ kind: 'issue', editing: null })}>
          + 人工措施
        </button>
        <button type="button" className="btn sm" onClick={() => setKbOpen((v) => !v)}>
          {kbOpen ? '收起知识库' : '知识库'}
        </button>
        <button className="btn primary sm" disabled={busy || batchStatus === 'running'}
          onClick={() => void generate()}>
          {busy ? '识别中…' : batchStatus === 'running' ? '识别进行中…' : findings.length + issues.length > 0 ? '重新识别' : '开始识别'}
        </button>
      </div>

      {/* ---------- v3.51 人工录入表单 ---------- */}
      {form && (
        <AiWasteManualDialog
          stationId={stationId}
          kind={form.kind}
          wasteTypes={itemsData?.waste_types ?? []}
          editing={form.editing}
          onClose={() => setForm(null)}
          onSaved={() => void load()}
        />
      )}

      {/* ---------- v3.51 知识库面板 ---------- */}
      {kbOpen && <AiWasteKbPanel stationId={stationId} />}

      {/* ---------- 来源筛选（AI 识别 / 人工录入）与范围 ---------- */}
      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>清单来源</span>
        {([['all', `全部（${aiCount + manualCount}）`], ['ai', `AI 识别（${aiCount}）`], ['manual', `人工录入（${manualCount}）`]] as const).map(([k, label]) => (
          <button key={k} type="button" className={`btn sm${originFilter === k ? ' primary' : ''}`}
            onClick={() => setOriginFilter(k)}>{label}</button>
        ))}
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, marginLeft: 8 }}>
          <input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} />
          含全部历史批次
        </label>
      </div>

      {/* ---------- 来源线页签（v3.45：默认 AI 线，工作台链接直达手工线） ---------- */}
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button type="button" className={`btn sm${source === 'ai_assisted' ? ' primary' : ''}`}
          onClick={() => switchSource('ai_assisted')}
          title="AI 分解线：只识别 source=ai_assisted 的要素（AI 自动分解写入）">
          AI 分解线
        </button>
        <button type="button" className={`btn sm${source === 'manual' ? ' primary' : ''}`}
          onClick={() => switchSource('manual')}
          title="手工分解线：只识别 source=manual 的要素（分解工作台提交的手工分解）">
          手工分解线
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {/* v3.61：AI 调用全局横幅（统一反馈件）。两种形态：本次点击发起的同步调用 /
         后台批次执行中（重进页面或 409 后接上，3 秒轮询）——结果都落本页清单 */}
      <AiCallBanner active={busy} label="正在执行浪费识别" phase="LLM 生成中，通常需要数十秒，请勿离开本页" />
      <AiCallBanner active={!busy && batchStatus === 'running'} label="浪费识别批次执行中"
        phase="结果将写入本页清单 · 每 3 秒自动刷新" />

      {/* ---------- 批次状态条 ---------- */}
      {data && data.batch !== null && (
        <div className="card aw-batch-bar" style={{ padding: '10px 14px', marginBottom: 12 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`tag ${AW_BATCH_META[data.status]?.cls ?? 't-gray'}`}>{AW_BATCH_META[data.status]?.label ?? data.status}</span>
            {data.status === 'done' && (
              <span className="muted">
                完成于 {data.completed_at ? String(data.completed_at).slice(0, 19).replace('T', ' ') : '—'}
                {' · '}浪费点 {data.finding_count} · 问题 {data.issue_count} 条 · 模型 <span className="mono">{data.model ?? '—'}</span>
                {' · '}tokens {Number(data.tokens_used ?? 0).toLocaleString()}
              </span>
            )}
            {data.status === 'done_empty' && (
              <span className="muted">本次未识别到符合白名单的浪费——可点击「重新识别」再试。</span>
            )}
            {data.status === 'failed' && (
              <span className="muted" style={{ color: 'var(--red)' }}>
                失败原因：{data.error ?? '模型或网络异常'}（可重试，重试复用失败批次）
              </span>
            )}
            {data.status === 'running' && (
              <span className="muted">识别执行中，本页每 3 秒自动刷新…</span>
            )}
            <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 12 }}>
              v{data.version} · {data.batch_id?.slice(0, 8)}
            </span>
          </div>
        </div>
      )}
      {(!data || data.batch === null) && !loading && findings.length + issues.length === 0 && (
        <div className="card empty">
          {source === 'manual' ? (
            <>
              该工位还没有手工分解线的识别批次：在分解工作台提交分解后，点顶栏「AI自动识别浪费」，或点右上角「开始识别」。
              {/* v3.48 跨线提示：当前线无数据但另一条线有要素时，给出一键切换 */}
              {(data?.source_availability?.ai_assisted ?? 0) > 0 && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  该工位还有 {data?.source_availability?.ai_assisted} 个 AI 自动分解写入的要素 ·
                  <button type="button" className="wb-inline-link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => switchSource('ai_assisted')}>切换到「AI 分解线」</button>
                </div>
              )}
            </>
          ) : (
            <>
              该工位还没有浪费识别批次：点击右上角「开始识别」，AI 将基于当前版本 <b>AI 自动分解写入的要素</b>（source=ai_assisted）识别浪费。
              {(data?.source_availability?.manual ?? 0) > 0 && (
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                  检测到该工位有 {data?.source_availability?.manual} 个<b>手工分解</b>写入的要素 ·
                  <button type="button" className="wb-inline-link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => switchSource('manual')}>切换到「手工分解线」识别</button>
                </div>
              )}
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                （只处理 AI 分解结果；手工分解工位请使用「AI 建议」页签——两个模块相互独立）
              </div>
            </>
          )}
        </div>
      )}

      {/* ---------- 识别摘要（P1-3：数字全部取服务端 summary 字段，前端零计算） ---------- */}
      {data && data.batch !== null && summary && (
        <div className="card aw-section" style={{ marginBottom: 12, padding: '10px 14px' }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>识别摘要</b>
            {Object.entries(summary.by_type).map(([wt, n]) => (
              <span key={wt} className="tag t-gray">{wt} × {n}</span>
            ))}
            {Object.keys(summary.by_type).length === 0 && <span className="muted">暂无浪费点分布</span>}
            <span className="spacer" />
            <span className="muted">预计总节省 <b style={{ fontSize: 15 }}>{summary.total_est_save_s}</b> s</span>
            <span className="muted">占 CT <b style={{ fontSize: 15 }}>{summary.est_pct_of_ct}</b>%</span>
          </div>
        </div>
      )}

      {/* ---------- 浪费点列表 ---------- */}
      {findings.length > 0 && (
        <div className="card aw-section" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: '0 0 8px' }}>浪费点（{findings.length}）</h3>
          <div className="table-scroll">
            <table className="dash-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>浪费类型</th>
                  <th style={{ width: 90 }}>严重度</th>
                  <th style={{ width: 110 }}>涉及时长</th>
                  <th style={{ width: 90 }}>占 CT</th>
                  <th>证据</th>
                  <th style={{ width: 110 }}>要素 seq</th>
                  {/* v3.51：来源列追加在末列——既有 UI 回归按 td[0..3] 取数，插在前面会错位 */}
                  <th style={{ width: 120 }}>来源</th>
                  {/* v3.57：路由列（finding=确定性命中计收益 / pool=待标定观察）追加在来源之后 */}
                  <th style={{ width: 130 }}>路由</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f: AiWasteFinding) => (
                  <tr key={f.finding_id}>
                    <td><span className="tag t-gray">{f.waste_type}</span></td>
                    <td><span className={`tag ${AW_SEV_META[f.severity]?.cls ?? 't-gray'}`}>{AW_SEV_META[f.severity]?.label ?? f.severity}</span></td>
                    <td className="num">{f.involved_s} s</td>
                    <td className="num">{f.pct_of_ct}%</td>
                    <td className="muted">{f.evidence}</td>
                    <td className="mono">{f.element_seqs.join(', ')}</td>
                    <td>
                      <span className={`tag ${f.origin === 'manual' ? 't-amber' : 't-blue'}`}
                        title={f.origin === 'manual' ? '人工录入（可编辑/删除）' : 'AI 识别产出（不可编辑）'}>
                        {f.origin === 'manual' ? '人工' : 'AI'}
                      </span>
                      {f.origin === 'manual' && (
                        <span style={{ marginLeft: 4 }}>
                          <button type="button" className="btn sm ghost"
                            onClick={() => setForm({ kind: 'finding', editing: f })}>编辑</button>
                          <button type="button" className="btn sm ghost"
                            onClick={() => void removeFinding(f)}>删除</button>
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`tag ${(f.route ?? 'finding') === 'pool' ? 't-amber' : 't-teal'}`}
                        title={(f.route ?? 'finding') === 'pool'
                          ? '待标定观察项：仍进清单，收益待现场标定后计值'
                          : '确定性命中：计收益、参与优先级排序'}>
                        {(f.route ?? 'finding') === 'pool' ? '待标定' : '确定性'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- 问题清单卡片 ---------- */}
      {issues.length > 0 && (
        <div className="aw-issues">
          {issues.map((it: AiWasteIssue) => {
            const decidedRow = it.status !== '待处理';
            const rows = awTraceRows(it.validation_trace);
            return (
              <div key={it.issue_id} className={`card aw-issue-card${decidedRow ? ' decided' : ''}`}>
                <div className="row" style={{ alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <span className={`tag ${AW_METHOD_CLS[it.ecrs] ?? 't-gray'}`}>{METHOD_LABEL[it.ecrs] ?? it.ecrs}</span>
                  <span className="tag t-gray">{it.waste_type}</span>
                  <span className={`tag ${AW_TIER_CLS[it.tier] ?? 't-gray'}`}>{it.tier} · 优先级 {it.priority}</span>
                  <span className={`tag ${it.status === '待处理' ? 't-blue' : it.status === '已确认' ? 't-teal' : 't-gray'}`}>
                    {it.status}
                  </span>
                  {/* v3.51 来源徽标：人工录入可编辑/删除，AI 产出只能确认或忽略 */}
                  <span className={`tag ${it.origin === 'manual' ? 't-amber' : 't-blue'}`}
                    title={it.origin === 'manual' ? `人工录入（${it.created_by ?? '—'}）` : 'AI 识别产出'}>
                    {it.origin === 'manual' ? '人工' : 'AI'}
                  </span>
                  <span className="spacer" />
                  <span className="muted num" style={{ fontSize: 13 }}>
                    预估节省 <b style={{ fontSize: 15 }}>{it.est_save_s}</b> s
                  </span>
                </div>
                <div style={{ margin: '8px 0 4px' }}>
                  <b>问题：</b>{it.problem}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  <b>建议：</b>{it.suggestion}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  要素 seq {it.element_seqs.join(', ')}
                  {it.imp_id && <> · 改善任务 <span className="mono">{it.imp_id}</span></>}
                  {it.reviewed_by && <> · 决策人 {it.reviewed_by}（{it.reviewed_at ? String(it.reviewed_at).slice(0, 16).replace('T', ' ') : '—'}）</>}
                </div>

                {/* 决策区（铁律①：待处理才可流转；确认→改善任务，忽略→终态） */}
                {!decidedRow ? (
                  <div className="row" style={{ marginTop: 10, gap: 8 }}>
                    <button className="btn primary sm" disabled={decidingId === it.issue_id}
                      onClick={() => void settle(it, '已确认')}>
                      {decidingId === it.issue_id ? '…' : '确认'}
                    </button>
                    <button className="btn sm" disabled={decidingId === it.issue_id}
                      onClick={() => void settle(it, '已忽略')}>
                      忽略
                    </button>
                    {it.origin === 'manual' && (
                      <>
                        <button className="btn sm ghost" onClick={() => setForm({ kind: 'issue', editing: it })}>编辑</button>
                        <button className="btn sm ghost" onClick={() => void removeIssue(it)}>删除</button>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                    {it.status === '已确认' ? '已确认：进入改善任务（待实施）' : '已忽略：不再进入改善任务'}
                  </div>
                )}

                {/* 校验轨迹折叠面板（W1-W3 透明可溯） */}
                {rows.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <button className="btn sm ghost" onClick={() => setTraceOpen((p) => ({ ...p, [it.issue_id]: !p[it.issue_id] }))}>
                      {traceOpen[it.issue_id] ? '收起校验轨迹' : `查看校验轨迹（${rows.length} 条）`}
                    </button>
                    {traceOpen[it.issue_id] && (
                      <div className="table-scroll" style={{ marginTop: 6 }}>
                        <table className="dash-table">
                          <thead><tr><th style={{ width: 60 }}>轮次</th><th style={{ width: 90 }}>规则</th><th style={{ width: 90 }}>命中</th><th>明细</th></tr></thead>
                          <tbody>
                            {rows.map((r, i) => (
                              <tr key={i}>
                                <td className="mono">{r.round}</td>
                                <td className="mono">{r.rule}</td>
                                <td>{r.hit ? '是' : '否'}</td>
                                <td className="muted">{r.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- 批次历史（只读溯源；按当前页签 source 隔离，含来源列） ---------- */}
      {data && data.batch !== null && (
        <div style={{ marginTop: 12 }}>
          <button className="btn sm ghost" onClick={() => void toggleBatches()}>
            {batchesOpen ? '收起批次历史' : '查看批次历史'}
          </button>
          {batchesOpen && (
            <div className="table-scroll" style={{ marginTop: 6 }}>
              <table className="dash-table">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>状态</th><th style={{ width: 90 }}>来源</th><th style={{ width: 60 }}>版本</th>
                    <th style={{ width: 90 }}>要素数</th><th style={{ width: 90 }}>浪费点</th>
                    <th style={{ width: 90 }}>问题数</th><th style={{ width: 100 }}>tokens</th>
                    <th>模型</th><th style={{ width: 150 }}>识别时间</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.batch_id}>
                      <td><span className={`tag ${AW_BATCH_META[b.status]?.cls ?? 't-gray'}`}>{AW_BATCH_META[b.status]?.label ?? b.status}</span></td>
                      <td><span className="tag t-gray" title={AW_SOURCE_META[b.element_source === 'manual' ? 'manual' : 'ai_assisted'].title}>
                        {AW_SOURCE_META[b.element_source === 'manual' ? 'manual' : 'ai_assisted'].label}
                      </span></td>
                      <td className="mono">v{b.version}</td>
                      <td className="num">{b.element_count}</td>
                      <td className="num">{b.finding_count}</td>
                      <td className="num">{b.issue_count}</td>
                      <td className={Number(b.tokens_used ?? 0) > 0 ? 'num' : 'num muted'}>{Number(b.tokens_used ?? 0).toLocaleString()}</td>
                      <td className="mono">{b.model ?? '—'}</td>
                      <td className="muted">{b.completed_at ? String(b.completed_at).slice(0, 19).replace('T', ' ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
