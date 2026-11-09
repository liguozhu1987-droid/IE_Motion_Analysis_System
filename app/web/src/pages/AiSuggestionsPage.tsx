import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, ApiError, parseValidationTrace,
  type AiBatch, type AiSuggestion, type AiSuggestionsResult, type AiSuggestElementSource,
} from '../api';
import { useAuth } from '../auth';
import { METHOD_LABEL, today } from '../constants';
import AiCallBanner from '../components/AiCallBanner';
/** 批次状态徽标与文案 */
const BATCH_META: Record<AiBatch['status'], { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 't-gray' },
  running: { label: '生成中…', cls: 't-blue' },
  done: { label: '已生成', cls: 't-teal' },
  done_empty: { label: '无有效建议', cls: 't-amber' },
  failed: { label: '生成失败', cls: 't-red' },
};

/** ECRS 手法徽标配色 */
const METHOD_CLS: Record<AiSuggestion['method'], string> = {
  E: 't-red', C: 't-blue', R: 't-amber', S: 't-teal',
};
const TIER_CLS: Record<string, string> = { P1: 't-red', P2: 't-amber', P3: 't-gray' };

/** v3.46 来源线徽标（页头）：mixed→「全量」/ ai_assisted→「AI 分解」/ manual→「手工分解」 */
const SOURCE_META: Record<AiSuggestElementSource, { label: string; cls: string; title: string }> = {
  mixed: { label: '全量', cls: 't-gray', title: '要素口径：当前版本全部 active 要素（AI+手工混合，legacy 口径）' },
  ai_assisted: { label: 'AI 分解', cls: 't-blue', title: '要素口径：只分析 source=ai_assisted 的要素（AI 自动分解写入）' },
  manual: { label: '手工分解', cls: 't-amber', title: '要素口径：只分析 source=manual 的要素（手工分解写入）' },
};

/** risk_flags 角标：needs_quality_redline 红（采纳须红线确认）、exceeds_batch_ceiling 琥珀（转人工）
 *  v3.46：后端 suggestionVo 返数组，兼容历史字符串形态（'|' 分隔）；双形态解析避免整树崩溃 */
function riskFlagBadges(flags: string[] | string | null) {
  if (!flags) return null;
  const set = Array.isArray(flags) ? flags : String(flags ?? '').split('|').filter(Boolean);
  return (
    <>
      {set.includes('needs_quality_redline') && (
        <span className="tag t-red ai-risk-dot" title="命中质量红线关键词：采纳前须品质负责人确认">红线</span>
      )}
      {set.includes('exceeds_batch_ceiling') && (
        <span className="tag t-amber" title="批次节省合计超工位 CT 的 50%，转人工复核">超上限</span>
      )}
      {set.includes('manual_review') && (
        <span className="tag t-amber" title="收益表述与优先级不一致，建议人工复核">待复核</span>
      )}
    </>
  );
}

/** 校验轨迹归一为可展示行 */
interface TraceRow { round: string; rule: string; action: string; detail: string }
function traceRows(trace: unknown): TraceRow[] {
  if (trace == null) return [];
  if (Array.isArray(trace)) {
    return trace.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        round: String(o.round ?? o.R ?? '—'),
        rule: String(o.rule ?? o.id ?? '—'),
        action: String(o.action ?? o.disposal ?? '—'),
        detail: String(o.detail ?? o.message ?? JSON.stringify(o)),
      };
    });
  }
  if (typeof trace === 'object') {
    // 对象形态：{ rounds: [...] } 或按轮次分组
    const obj = trace as Record<string, unknown>;
    if (Array.isArray(obj.rounds)) return traceRows(obj.rounds);
    if (Array.isArray(obj.items)) return traceRows(obj.items);
    return Object.entries(obj).map(([k, v]) => ({
      round: k, rule: '—', action: '—', detail: typeof v === 'string' ? v : JSON.stringify(v),
    }));
  }
  return [{ round: '—', rule: '—', action: '—', detail: String(trace) }];
}

/**
 * AI 建议列表（#/ai-suggestions/:stationId · 工位工作区第四页签）。
 * 铁律①：AI 建议永远「待审」——只有 采纳/否决 决策按钮，无任何「直接执行」。
 * 批次状态条：pending/running 5s 轮询；done 显示生成时间+条数；done_empty 提示已计费；failed 可重试。
 * v3.46 双来源线：全量线（mixed=AI+手工全部 active 要素，legacy 默认口径）/ AI 分解线（ai_assisted）/
 * 手工分解线（manual）——三线的批次/幂等/建议相互隔离（后端按 element_source 分流）。
 */
export default function AiSuggestionsPage({ stationId, initialSource }: { stationId: string; initialSource?: AiSuggestElementSource }) {
  const { can, user } = useAuth();
  const canGenerate = can('suggestion:generate');

  /** v3.46 当前来源线页签（缺省 mixed=legacy 全量口径） */
  const [source, setSource] = useState<AiSuggestElementSource>(initialSource ?? 'mixed');
  const [data, setData] = useState<AiSuggestionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 决策中建议 id */
  const [decidingId, setDecidingId] = useState<string | null>(null);
  /** 红线确认框（422 → 填确认人重试）；type: quality|ergonomics（后端两类型都检查） */
  const [redline, setRedline] = useState<{ suggestion: AiSuggestion; messages: string[]; type: 'quality' | 'ergonomics' } | null>(null);
  const [confirmName, setConfirmName] = useState(user?.displayName || user?.username || '');
  /** 展开校验轨迹的建议 id */
  const [traceOpen, setTraceOpen] = useState<Record<string, boolean>>({});

  /* 数据加载（受保护：登录态变化重取，坑 #9）；保留既有 error 横幅可选。
     v3.46：始终显式传 source（mixed 也传——后端按 'mixed' 过滤恰好等价 legacy 全量） */
  const load = useCallback(async (opts?: { keepError?: boolean }) => {
    if (!canGenerate) { setLoading(false); return; } // 纪律 #10：无权限不请求
    try {
      const res = await api.ai.list(stationId, undefined, source);
      setData(res);
      if (!opts?.keepError) setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setData({ station_id: stationId, version: 0, batches: [], suggestions: [] }); // 后端未就绪：空态而非报错横幅
      } else {
        setError((err as Error).message);
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, [stationId, canGenerate, source]);

  useEffect(() => { void load(); }, [load, canGenerate]);

  /* v3.46 页签切换：清空旧线数据/提示，load 依赖 source 自动重取（与 AiWastePage 同模式） */
  const switchSource = (next: AiSuggestElementSource) => {
    if (next === source) return;
    setSource(next);
    setData(null);
    setError(null);
    setMsg(null);
  };

  /* pending/running → 5s 轮询；其余状态停止（batches[0] 为当前批次） */
  const batchStatus = data?.batches?.[0]?.status ?? null;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (batchStatus === 'pending' || batchStatus === 'running') {
      pollRef.current = setInterval(() => { void load(); }, 5000);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [batchStatus, load]);

  /* 生成：409 生成进行中 / 429 配额尽 / 幂等 200 展示历史结果。
     generate 响应为扁平结构（无嵌套 batch）——成功/幂等都直接走 GET list 复用同一渲染路径。
     v3.46：按当前来源线生成（后端槽位/幂等按 source 隔离） */
  const generate = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const res = await api.ai.generate(stationId, source);
      setMsg(res.idempotent_hit
        ? '已生成过：展示历史结果（幂等命中，不重复计费）'
        : 'AI 生成完成：建议已进入待审列表');
      await load({ keepError: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('生成进行中：同一工位的 AI 批次正在排队或执行，请稍候（可切换回本页查看进度）。');
        await load({ keepError: true });
      } else if (err instanceof ApiError && err.status === 429) {
        setError(`配额已用尽${err.hint ? `（${err.hint}）` : ''}：今日生成次数已达上限，可联系管理员在「AI 配置 → 配额管理」调整。`);
      } else if (err instanceof ApiError && err.hint) {
        setError(`${err.message}（${err.hint}）`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  /* 采纳：422 红线 → 弹确认框填确认人再重试（quality/ergonomics） */
  const adopt = async (s: AiSuggestion, confirmations?: { quality?: { name: string; date?: string }; ergonomics?: { name: string; date?: string } }) => {
    setDecidingId(s.suggestion_id); setError(null); setMsg(null);
    try {
      const res = await api.ai.adopt(s.suggestion_id, confirmations);
      setMsg(`已采纳（改善任务 ${res.imp_id}，状态「待实施」）——AI 建议转正后进入任务跟踪`
        + (res.note ? ` · ${res.note}` : ''));
      setRedline(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const requires = err.requires ?? [];
        const type = requires.some((r) => r.type === 'ergonomics') ? 'ergonomics' : 'quality';
        setRedline({ suggestion: s, messages: requires.map((r) => r.message), type });
        setError('命中红线：须填写确认人后方可采纳');
      } else if (err instanceof ApiError && err.hint) {
        setError(`${err.message}（${err.hint}）`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setDecidingId(null);
    }
  };

  const confirmRedline = async () => {
    if (!redline) return;
    if (!confirmName.trim()) { setError('请填写确认人姓名'); return; }
    const confirmation = { name: confirmName.trim(), date: today() };
    await adopt(redline.suggestion, redline.type === 'ergonomics' ? { ergonomics: confirmation } : { quality: confirmation });
  };

  /* 否决：confirm（可选理由）后提交 */
  const reject = async (s: AiSuggestion) => {
    const reason = window.prompt(`否决该建议？\n\n${s.measure.slice(0, 60)}\n\n否决后状态置为「已否决」，不可恢复。\n可填写否决理由（留空跳过，≤256 字）：`) ?? null;
    if (reason === null) return; // 取消
    if (reason.trim().length > 256) { setError('否决理由不超过 256 字'); return; }
    setDecidingId(s.suggestion_id); setError(null); setMsg(null);
    try {
      await api.ai.reject(s.suggestion_id, reason.trim() || undefined);
      setMsg('已否决');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDecidingId(null);
    }
  };

  /* 当前批次 = batches[0]（后端按 created_at DESC 返回） */
  const batch = data?.batches?.[0] ?? null;
  const suggestions = data?.suggestions ?? [];
  const batchMeta = batch ? BATCH_META[batch.status] : null;
  const reviewing = suggestions.filter((s) => s.status === '待审').length;
  const decided = suggestions.filter((s) => s.status !== '待审').length;

  if (!canGenerate) {
    return <div className="card empty">当前角色无 AI 建议权限（缺少 suggestion:generate）。AI 建议仅对 IE 工程师及以上角色开放。</div>;
  }

  return (
    <div>
      <div className="page-head">
        <h1>AI 改善建议</h1>
        {/* v3.46 来源徽标：优先取当前批次 element_source，回落页签 source */}
        <span className={`tag ${SOURCE_META[data?.batches?.[0]?.element_source ?? source].cls}`}
          title={SOURCE_META[data?.batches?.[0]?.element_source ?? source].title}>
          {SOURCE_META[data?.batches?.[0]?.element_source ?? source].label}
        </span>
        <span className="sub">
          {source === 'mixed'
            ? 'AI 生成的改善建议永远处于「待审」状态，采纳后才进入改善任务'
            : source === 'ai_assisted'
              ? '只分析 AI 自动分解写入的要素；AI 生成的建议永远「待审」，采纳后才进入改善任务'
              : '只分析手工分解写入的要素；AI 生成的建议永远「待审」，采纳后才进入改善任务'} ·
          待审 {reviewing} · 已决策 {decided}
          {' · '}规则引擎候选（操作级、批量勾选）见「分析结果」页
        </span>
        <div className="spacer" />
        <button className="btn primary sm" disabled={busy || batchStatus === 'pending' || batchStatus === 'running'}
          onClick={() => void generate()}>
          {busy ? '生成中…' : batchStatus === 'pending' || batchStatus === 'running' ? '生成进行中…' : batch ? '重新生成' : 'AI 生成建议'}
        </button>
      </div>

      {/* ---------- v3.46 来源线页签（三线批次/幂等/建议相互隔离） ---------- */}
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button type="button" className={`btn sm${source === 'mixed' ? ' primary' : ''}`}
          onClick={() => switchSource('mixed')}
          title="全量线（AI+手工）：分析当前版本全部 active 要素（legacy 口径）">
          全量线（AI+手工）
        </button>
        <button type="button" className={`btn sm${source === 'ai_assisted' ? ' primary' : ''}`}
          onClick={() => switchSource('ai_assisted')}
          title="AI 分解线：只分析 source=ai_assisted 的要素（AI 自动分解写入）">
          AI 分解线
        </button>
        <button type="button" className={`btn sm${source === 'manual' ? ' primary' : ''}`}
          onClick={() => switchSource('manual')}
          title="手工分解线：只分析 source=manual 的要素（分解工作台提交的手工分解）">
          手工分解线
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {/* v3.61：AI 调用全局横幅（统一反馈件）。两种形态：本次点击发起的同步调用 /
         后台批次排队/执行中（重进页面或 409 后接上，5 秒轮询）——结果都落本页待审列表 */}
      <AiCallBanner active={busy} label="正在生成 AI 改善建议" phase="LLM 生成中，通常需要数十秒，请勿离开本页" />
      <AiCallBanner active={!busy && (batchStatus === 'pending' || batchStatus === 'running')} label="AI 建议批次执行中"
        phase={batchStatus === 'pending' ? '排队中 · 每 5 秒自动刷新' : 'LLM 生成中 · 每 5 秒自动刷新'} />

      {/* ---------- 批次状态条 ---------- */}
      {batch && batchMeta && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`tag ${batchMeta.cls}`}>{batchMeta.label}</span>
            {batch.status === 'done' && (
              <span className="muted">
                生成于 {batch.completed_at ? String(batch.completed_at).slice(0, 19).replace('T', ' ') : '—'}
                {' · '}共 {batch.suggestion_count} 条 · 模型 <span className="mono">{batch.model ?? '—'}</span>
                {' · '}tokens {batch.tokens_used.toLocaleString()}
              </span>
            )}
            {batch.status === 'done_empty' && (
              <span className="muted">本次未产生有效建议（三轮校验后全部剔除，已计入配额）——可点击「重新生成」再试。</span>
            )}
            {batch.status === 'failed' && (
              <span className="muted" style={{ color: 'var(--red)' }}>
                失败原因：{batch.error ?? '模型或网络异常'}（失败不计费，可重试，第 {batch.attempt + 1} 次尝试）
              </span>
            )}
            {(batch.status === 'pending' || batch.status === 'running') && (
              <span className="muted">批次排队/执行中，本页每 5 秒自动刷新…</span>
            )}
            <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 12 }}>
              v{batch.version} · {batch.batch_id.slice(0, 8)}
            </span>
          </div>
        </div>
      )}
      {!batch && !loading && (
        source === 'mixed' ? (
          <div className="card empty">
            该工位还没有 AI 建议批次：点击右上角「AI 生成建议」，AI 将基于当前版本的要素分析与浪费识别结果生成待审建议。
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              （建议生成的输入 = 当前版本全量要素 + 浪费证据；输出经 R1 结构 / R2 业务 / R3 交叉三轮确定性校验后才落库）
            </div>
          </div>
        ) : source === 'ai_assisted' ? (
          <div className="card empty">
            该工位还没有 AI 分解线的建议批次：点击右上角「AI 生成建议」，AI 将只分析当前版本 AI 自动分解写入的要素（source=ai_assisted）。
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              （输入 = AI 分解线 active 要素 + 浪费证据；请先做一次 AI 自动分解，或切换到「全量线（AI+手工）」页签）
            </div>
          </div>
        ) : (
          <div className="card empty">
            该工位还没有手工分解线的建议批次：在分解工作台提交手工分解后，点击右上角「AI 生成建议」，AI 将只分析手工分解写入的要素（source=manual）。
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              （输入 = 手工分解线 active 要素 + 浪费证据；或切换到「全量线（AI+手工）」页签）
            </div>
          </div>
        )
      )}

      {/* ---------- 建议卡片 ---------- */}
      <div className="ai-sug-list">
        {suggestions.map((s) => {
          const decidedRow = s.status !== '待审';
          const trace = parseValidationTrace(s.validation_trace);
          const rows = traceRows(trace);
          return (
            <div key={s.suggestion_id} className={`card ai-sug-card${decidedRow ? ' decided' : ''}`}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <span className={`tag ${METHOD_CLS[s.method]}`}>{METHOD_LABEL[s.method] ?? s.method}</span>
                <span className="tag t-gray">{s.waste_type}</span>
                <span className={`tag ${TIER_CLS[s.tier] ?? 't-gray'}`}>{s.tier} · 优先级 {s.priority}</span>
                {riskFlagBadges(s.risk_flags)}
                <span className={`tag ${s.status === '待审' ? 't-blue' : s.status === '已采纳' ? 't-teal' : 't-gray'}`}>
                  {s.status}
                </span>
                <span className="spacer" />
                <span className="muted num" style={{ fontSize: 13 }}>
                  预估节省 <b style={{ fontSize: 15 }}>{s.est_save_s}</b> s
                </span>
              </div>
              <div style={{ margin: '8px 0 4px' }}>
                <b>措施：</b>{s.measure}
              </div>
              {s.method === 'E' && (
                <div className="muted" style={{ fontSize: 13 }}>
                  <b>消除依据：</b>{s.eliminate_basis ?? <span style={{ color: 'var(--red)' }}>（缺失——E 类必须给出产生条件的消除依据）</span>}
                </div>
              )}
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                难度 {s.difficulty}/3 · 可验证性 V{s.verif} · 要素 {(() => { try { const ids = JSON.parse(s.element_ids); return Array.isArray(ids) ? ids.join(', ') : s.element_ids; } catch { return s.element_ids; } })()}
                {s.reviewed_by && <> · 决策人 {s.reviewed_by}（{s.reviewed_at ? String(s.reviewed_at).slice(0, 16).replace('T', ' ') : '—'}）</>}
              </div>

              {/* 决策区（铁律①：只有采纳/否决，无「直接执行」） */}
              {!decidedRow ? (
                <div className="row" style={{ marginTop: 10, gap: 8 }}>
                  <button className="btn primary sm" disabled={decidingId === s.suggestion_id}
                    onClick={() => void adopt(s)}>
                    {decidingId === s.suggestion_id ? '…' : '采纳'}
                  </button>
                  <button className="btn sm danger" disabled={decidingId === s.suggestion_id}
                    onClick={() => void reject(s)}>
                    否决
                  </button>
                  {s.risk_flags?.includes('needs_quality_redline') && (
                    <span className="muted" style={{ fontSize: 12 }}>命中质量红线：采纳时须确认人</span>
                  )}
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
                  已{decidedRow && s.status === '已采纳' ? '采纳：进入改善任务（待实施）' : '否决：不再进入任务跟踪'}
                </div>
              )}

              {/* 校验轨迹折叠面板 */}
              {rows.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <button className="btn sm ghost" onClick={() => setTraceOpen((p) => ({ ...p, [s.suggestion_id]: !p[s.suggestion_id] }))}>
                    {traceOpen[s.suggestion_id] ? '收起校验轨迹' : `查看校验轨迹（${rows.length} 条）`}
                  </button>
                  {traceOpen[s.suggestion_id] && (
                    <div className="table-scroll" style={{ marginTop: 6 }}>
                      <table className="dash-table">
                        <thead><tr><th style={{ width: 60 }}>轮次</th><th style={{ width: 90 }}>规则</th><th style={{ width: 90 }}>处置</th><th>明细</th></tr></thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i}>
                              <td className="mono">{r.round}</td>
                              <td className="mono">{r.rule}</td>
                              <td>{r.action}</td>
                              <td className="muted">{r.detail}</td>
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

      {/* 红线确认框（422 → 确认人 → 重试） */}
      {redline && (
        <div className="ai-modal-mask" role="dialog" aria-modal="true">
          <div className="card ai-modal" style={{ maxWidth: 460 }}>
            <h3>{redline.type === 'ergonomics' ? '人因红线确认' : '质量红线确认'}</h3>
            <div className="banner-warn" style={{ borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
              {redline.messages.length > 0 ? redline.messages.map((m, i) => <div key={i}>{m}</div>)
                : redline.type === 'ergonomics' ? '该建议命中人因红线关键词，须确认人确认后方可采纳。' : '该建议命中质量红线关键词，须品质负责人确认后方可采纳。'}
            </div>
            <label className="filter-item" style={{ display: 'block' }}>
              <span>确认人（品质负责人）</span>
              <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} style={{ width: '100%' }} placeholder="姓名" />
            </label>
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn sm" onClick={() => { setRedline(null); setError(null); }}>取消</button>
              <button className="btn primary sm" disabled={decidingId === redline.suggestion.suggestion_id}
                onClick={() => void confirmRedline()}>
                确认并采纳
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
