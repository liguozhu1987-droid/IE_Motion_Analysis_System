import { useCallback, useEffect, useState } from 'react';
import {
  api, ApiError, type Candidate, type Improvement, type LineAnalysis,
  type Station, type StationAnalysis, type SuggestionReport, type SuggestResult,
} from '../api';
import { useAuth } from '../auth';
import AiCallBanner from '../components/AiCallBanner';
import SelectMenu from '../components/SelectMenu';
import PieChart from '../components/PieChart';
import YamazumiChart from '../components/YamazumiChart';
import HandsChart from '../components/HandsChart';
import { METHOD_LABEL, VA_CLASS_LABEL, VA_COLOR, today } from '../constants';

const candidateKey = (c: Candidate) => `${c.mapping_id ?? 'manual'}|${c.element_ids.join(',')}`;

export default function AnalysisPage({ stationId }: { stationId: string }) {
  const { can } = useAuth();
  const [station, setStation] = useState<Station | null>(null);
  const [analysis, setAnalysis] = useState<StationAnalysis | null>(null);
  const [line, setLine] = useState<LineAnalysis | null>(null);
  const [improvements, setImprovements] = useState<Improvement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** AI 类按钮进行态（busy 是共享禁用位；aiBusy 决定哪个按钮显示「进行中」文案，避免互相误导） */
  const [aiBusy, setAiBusy] = useState<null | 'suggest' | 'diagnose'>(null);
  const [suggest, setSuggest] = useState<SuggestResult | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [redline, setRedline] = useState<{ type: string; message: string }[] | null>(null);
  const [quality, setQuality] = useState({ name: '', date: today() });
  const [ergo, setErgo] = useState({ name: '', date: today() });
  const [vaEdit, setVaEdit] = useState<{ element_id: string; value: string; reason: string; desc: string } | null>(null);
  const [report, setReport] = useState<SuggestionReport | null>(null);
  const [diagnose, setDiagnose] = useState<{ report: string; generated_by: string; model: string } | null>(null);

  const canGenerate = can('suggestion:generate');
  const canAdopt = can('suggestion:adopt');
  const canStatus = can('suggestion:status');
  const canVaOverride = can('element:va-override');

  const load = useCallback(async () => {
    const s = await api.station(stationId);
    setStation(s);
    const [analysisRes, lineRes, impRes] = await Promise.all([
      api.analysis(stationId),
      api.lineAnalysis(s.line_id),
      api.improvements({ station_id: stationId }),
    ]);
    setAnalysis(analysisRes);
    setLine(lineRes);
    setImprovements(impRes.improvements);
  }, [stationId]);

  useEffect(() => { load().catch((err) => setError(err.message)); }, [load]);

  const generate = async () => {
    setBusy(true); setError(null); setAiBusy('suggest');
    try {
      const res = await api.suggest(stationId);
      setSuggest(res);
      const initial: Record<string, boolean> = {};
      res.candidates.forEach((c, index) => { initial[candidateKey(c)] = index === 0; });
      setChecked(initial);
      setRedline(null);
      setMsg(`候选建议已生成（${res.candidates.length} 条）：已在弹窗中列出——勾选后点「确认采纳」进入建议清单`);
    } catch (err) {
      setMsg(null);
      setError((err as Error).message);
    } finally {
      setBusy(false); setAiBusy(null);
    }
  };

  const adopt = async () => {
    if (!suggest) return;
    const selected = suggest.candidates.filter((c) => checked[candidateKey(c)]);
    if (selected.length === 0) { setError('请至少勾选一条建议'); return; }
    setBusy(true); setError(null);
    try {
      const confirmations = redline
        ? {
          quality: quality.name ? quality : undefined,
          ergonomics: ergo.name ? ergo : undefined,
        }
        : undefined;
      const res = await api.adopt(stationId, { candidates: selected, confirmations });
      setMsg(`已采纳 ${res.created} 条建议（进入“待实施”）`);
      setSuggest(null);
      setRedline(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && (err.requires?.length ?? 0) > 0) {
        setRedline(err.requires!);
        setError('命中红线：需填写确认人后放行');
      } else if (err instanceof ApiError && err.hint) {
        setError(`${err.message}（${err.hint}）`);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (imp: Improvement) => {
    const next = imp.status === '待实施' ? '已完成' : imp.status === '已完成' ? '已验证' : null;
    if (!next) return;
    setBusy(true); setError(null);
    try {
      await api.updateImprovementStatus(imp.imp_id, next);
      setMsg(`${imp.station_name ?? imp.station_id} 建议状态 → ${next}`);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.allowed && err.allowed.length > 0) {
        setError(`${err.message}（可迁移至：${err.allowed.join(' / ')}）`);
      } else if (err instanceof ApiError && err.hint) {
        setError(`${err.message}（${err.hint}）`);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyVa = async () => {
    if (!vaEdit) return;
    setBusy(true); setError(null);
    try {
      if (vaEdit.reason.trim().length >= 5) {
        await api.vaOverride(stationId, vaEdit.element_id, { va_class: vaEdit.value, reason: vaEdit.reason.trim() });
        setMsg('已改判并写入标记');
      } else {
        await api.vaConfirm(stationId, vaEdit.element_id, { va_class: vaEdit.value });
        setMsg('已确认暂定归类');
      }
      setVaEdit(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runDiagnose = async () => {
    setBusy(true); setError(null); setAiBusy('diagnose');
    try {
      setDiagnose(await api.diagnose(stationId));
      setMsg('AI 诊断完成：报告见下方「AI 诊断」卡片（待审状态）');
    } catch (err) {
      setMsg(null);
      setError((err as Error).message);
    } finally {
      setBusy(false); setAiBusy(null);
    }
  };

  const openReport = async (imp: Improvement) => {
    setBusy(true); setError(null);
    try {
      setReport(await api.improvementReport(imp.imp_id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!analysis || !station) return <div className="card empty">{error ?? '加载中…'}</div>;

  const m = analysis.metrics;
  const light = line ? (line.balance_rate >= 85 ? 'VAR' : line.balance_rate >= 70 ? 'WARN' : 'BAD') : '';

  return (
    <div>
      <div className="page-head">
        <h1>{station.name} · 分析结果</h1>
        <span className="sub mono">{station.station_id} · v{station.version} · {line?.line_id}</span>
        <div className="spacer" />
        <a className="btn" href={`#/workbench/${station.station_id}`}>去分解</a>
        <a className="btn" href={`#/compare/${station.station_id}`}>改善对比</a>
        {canGenerate && <button className="btn primary" disabled={busy} onClick={generate}>{aiBusy === 'suggest' ? '生成中…' : '生成改善建议'}</button>}
        {can('analysis:read') && <button className="btn" disabled={busy} onClick={runDiagnose}>{aiBusy === 'diagnose' ? '诊断中…' : 'AI 诊断'}</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {/* v3.61：AI 调用全局横幅（统一反馈件；结果落在下方对应卡片） */}
      <AiCallBanner active={aiBusy === 'suggest'} label="正在生成候选改善建议" phase="规则引擎计算中" />
      <AiCallBanner active={aiBusy === 'diagnose'} label="正在调用 AI 诊断" phase="LLM 生成中，通常需要数十秒" />

      <div className="metrics" style={{ marginBottom: 14 }}>
        <div className="metric"><div className={`v ${m.ct > m.tt ? 'red' : 'teal'}`}>{m.ct}s</div><div className="l">工位工时 CT（Σ生效非异常ST）</div></div>
        <div className="metric"><div className="v">{m.tt}s</div><div className="l">TT（IE主管配置）</div></div>
        <div className="metric"><div className={`v ${m.tt_gap > 0 ? 'red' : 'teal'}`}>{m.tt_gap > 0 ? '+' : ''}{m.tt_gap}s</div><div className="l">CT−TT 差</div></div>
        <div className="metric"><div className="v teal">{m.va_pct}%</div><div className="l">VA占比</div></div>
        <div className="metric"><div className="v red">{m.nva_pct}%</div><div className="l">NVA占比</div></div>
        <div className="metric"><div className="v amber">{m.outlier_count}</div><div className="l">异常要素（不计入ST）</div></div>
        {line && <div className="metric"><div className={`v ${light === 'VAR' ? 'teal' : light === 'WARN' ? 'amber' : 'red'}`}>{line.balance_rate}%</div><div className="l">线平衡率（{line.station_count}工位）</div></div>}
      </div>

      <div className="split" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>VA / RNVA / NVA <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>RNVA = Required Non-Value Added（必要非增值）</span></h3>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <PieChart
              size={180}
              centerValue={`${m.ct}s`}
              centerLabel="CT"
              segments={[
                { label: 'VA', value: m.va, color: VA_COLOR.VA },
                { label: 'RNVA', value: m.rnva, color: VA_COLOR.RNVA },
                { label: 'NVA', value: m.nva, color: VA_COLOR.NVA },
              ]}
            />
            <div style={{ flex: 1 }}>
              <table>
                <thead><tr><th>类别</th><th className="num">秒</th><th className="num">占比</th></tr></thead>
                <tbody>
                  <tr><td><abbr title={`${VA_CLASS_LABEL.VA.full} — ${VA_CLASS_LABEL.VA.hint}`}>VA</abbr></td><td className="num">{m.va}</td><td className="num">{m.va_pct}%</td></tr>
                  <tr><td><abbr title={`${VA_CLASS_LABEL.RNVA.full} — ${VA_CLASS_LABEL.RNVA.hint}`}>RNVA</abbr></td><td className="num">{m.rnva}</td><td className="num">{m.rnva_pct}%</td></tr>
                  <tr><td><abbr title={`${VA_CLASS_LABEL.NVA.full} — ${VA_CLASS_LABEL.NVA.hint}`}>NVA</abbr></td><td className="num">{m.nva}</td><td className="num">{m.nva_pct}%</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="va-note">
            判定总纲（动素三分法）：<b>VA</b> = 有效动素，改变产品形态或性能；<b>RNVA</b>（Required Non-Value Added，必要非增值）= 辅助动素，当前工艺条件下必需——有规范依据的检查、物流所必需的移物、人机配合所需的等待，只能压缩不能直接删；<b>NVA</b> = 无效动素，纯浪费。
            <span className="va-note-flow">改善优先序：<b>删 NVA → 压 RNVA → 简 VA</b></span>
          </div>
        </div>

        <div className="card">
          <h3>山积图（全线）</h3>
          {line ? <YamazumiChart rows={line.rows} tt={line.tt_s} /> : <div className="empty">加载中…</div>}
          <div className="legend">
            <span><i style={{ background: VA_COLOR.VA }} />VA</span>
            <span><i style={{ background: VA_COLOR.RNVA }} />RNVA</span>
            <span><i style={{ background: VA_COLOR.NVA }} />NVA</span>
            <span className="muted">虚线=TT · 红线标注=瓶颈工位</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>6类浪费清单（带证据 · {analysis.wastes.length} 条）</h3>
        <table>
          <thead><tr><th>浪费类型</th><th>级别</th><th className="num">涉及秒数</th><th className="num">占CT</th><th>证据</th><th>涉及要素</th></tr></thead>
          <tbody>
            {analysis.wastes.map((waste) => (
              <tr key={`${waste.id}-${waste.element_ids.join(',')}`}>
                <td><span className="tag t-red">{waste.waste}</span></td>
                <td>{waste.level === 'element' ? '要素级' : '工位级'}</td>
                <td className="num">{waste.involved_s}</td>
                <td className="num">{waste.pct}%</td>
                <td>{waste.evidence}</td>
                <td className="mono">#{waste.seqs.join(',')}</td>
              </tr>
            ))}
            {analysis.wastes.length === 0 && <tr><td colSpan={6} className="empty">本工位未触发浪费规则。</td></tr>}
          </tbody>
        </table>
      </div>

      {/* v3.48 动作分析明细（「Motion analysis_改善建议.xlsx · 动作分析-VA」同构）：
          每个生效要素一行——ST/作业内容/分类/浪费类型/改善方向，全部规则口径。
          修复「分析页只有聚合饼图、看不到逐要素浪费与改善方向」的缺口。 */}
      {analysis.detail && analysis.detail.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>动作分析明细（{analysis.detail.length} 个生效要素）</h3>
          <div className="table-scroll">
            <table>
              <thead><tr>
                <th className="num" style={{ width: 40 }}>#</th>
                <th className="num" style={{ width: 64 }}>ST(s)</th>
                <th>作业内容</th>
                <th style={{ width: 84 }}>分类</th>
                <th style={{ width: 150 }}>浪费类型</th>
                <th>改善方向</th>
              </tr></thead>
              <tbody>
                {analysis.detail.map((row) => (
                  <tr key={row.element_id}>
                    <td className="num">{row.seq}</td>
                    <td className="num">{row.std_time}</td>
                    <td>{row.desc}</td>
                    <td><span className={`tag ${row.va_class === 'VA' ? 't-teal' : row.va_class === 'RNVA' ? 't-amber' : 't-red'}`}>{row.va_class}</span></td>
                    <td>
                      {row.waste_types.length > 0
                        ? row.waste_types.map((w) => <span key={w} className="tag t-gray" style={{ marginRight: 4 }}>{w}</span>)
                        : <span className="muted">—</span>}
                    </td>
                    <td className="muted">{row.directions.length > 0 ? row.directions.join('；') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            浪费类型 = 浪费触发器命中（{String(analysis.rule_versions.waste_triggers)}）；改善方向 = ECRSA 措施模板。
            AI 生成的个性化浪费证据与问题清单见「浪费识别 / AI 建议」页签（两个独立模块）。
          </div>
        </div>
      )}

      <div className="split" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>待复核队列（低置信度 {analysis.pending.length} 条）</h3>
          {analysis.pending.length === 0 ? (
            <div className="empty">已清空：所有低置信度要素均已由人工改判/确认。</div>
          ) : (
            <div className="queue">
              {analysis.pending.map((item) => (
                <div key={item.element_id} className="row" style={{ justifyContent: 'space-between', borderBottom: '1px dashed var(--line)', padding: '6px 0' }}>
                  <div>
                    <b>#{item.seq} {item.desc}</b>
                    <div className="muted">{item.type} · 暂定 {item.va_effective} · {item.va_reason}</div>
                  </div>
                  <div className="row tight">
                    {canVaOverride && (
                      <button className="btn sm" onClick={() => setVaEdit({ element_id: item.element_id, value: item.va_effective, reason: '', desc: item.desc })}>确认/改判</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3>异常要素（{analysis.outliers.length} 条，不进ST/山积图）</h3>
          {analysis.outliers.length === 0 ? <div className="empty">无异常要素</div> : (
            <table>
              <thead><tr><th className="num">#</th><th>类型</th><th>描述</th><th>原因</th><th className="num">时长s</th></tr></thead>
              <tbody>
                {analysis.outliers.map((o) => (
                  <tr key={o.element_id}><td className="num">{o.seq}</td><td>{o.type}</td><td>{o.desc}</td><td>{o.reason}</td><td className="num">{o.dur_s}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>双手作业图</h3>
        <HandsChart hands={analysis.hands} />
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>瓶颈榜（Top 5，按 CT−TT 降序）</h3>
        {line ? (
          <table>
            <thead><tr><th>工位</th><th className="num">CT</th><th className="num">TT</th><th className="num">差</th><th className="num">VA%</th><th className="num">浪费条数</th></tr></thead>
            <tbody>
              {line.bottleneck.map((row) => (
                <tr key={row.station_id}>
                  <td>{row.name}<span className="muted mono"> {row.station_id}</span></td>
                  <td className="num">{row.ct_s}</td>
                  <td className="num">{row.tt_s}</td>
                  <td className="num" style={{ color: row.gap_s > 0 ? 'var(--red)' : 'var(--teal)' }}>{row.gap_s > 0 ? '+' : ''}{row.gap_s}</td>
                  <td className="num">{row.va_pct}</td>
                  <td className="num">{row.waste_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>改善建议（本工位 {improvements.length} 条）</h3>
          <span className="muted">建议书可打印留档；状态流转：待实施→已完成→已验证</span>
        </div>
        <table>
          <thead><tr><th>浪费</th><th>方法</th><th>措施</th><th className="num">预估节省s</th><th className="num">优先级</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {improvements.map((imp) => (
              <tr key={imp.imp_id}>
                <td>{imp.waste_type}</td>
                <td>{METHOD_LABEL[imp.method] ?? imp.method}</td>
                <td>{imp.measure}</td>
                <td className="num">{imp.est_save_s}</td>
                <td className="num">{imp.priority}</td>
                <td><span className={`tag ${imp.status === '已验证' ? 't-teal' : imp.status === '已完成' ? 't-blue' : 't-amber'}`}>{imp.status}</span></td>
                <td>
                  <div className="row tight">
                    <button className="btn sm ghost" disabled={busy} onClick={() => void openReport(imp)}>建议书</button>
                    {canStatus && imp.status !== '已验证' && (
                      <button className="btn sm" disabled={busy} onClick={() => changeStatus(imp)}>
                        {imp.status === '待实施' ? '标记已完成' : '标记已验证'}
                      </button>
                    )}
                    {imp.status === '已验证' && <span className="muted">{imp.before_ct}s → {imp.after_ct}s</span>}
                  </div>
                </td>
              </tr>
            ))}
            {improvements.length === 0 && <tr><td colSpan={7} className="empty">暂无建议，点右上角“生成改善建议”。</td></tr>}
          </tbody>
        </table>
      </div>

      {suggest && (
        <div className="modal-mask" onClick={() => setSuggest(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>候选改善建议（{suggest.candidates.length} 条）</h3>
            <p className="muted" style={{ marginTop: -6 }}>
              基于浪费证据与12条ECRSA映射生成；勾选后点“确认采纳”才写入建议清单（AI只建议不执行）。
              本弹窗为<b>规则引擎候选</b>（操作级、批量勾选）；LLM 改善建议请用「AI 建议」页签（逐条待审）。
              {suggest.freq_configured ? ` 日产量=${suggest.daily_output}，优先级已按频次计算。` : ' 参数未配置，优先级按频次=1计算。'}
            </p>
            {redline && (
              <div className="law">
                <b>命中红线，需确认后放行：</b>
                {redline.map((r) => <div key={r.type}>{r.message}</div>)}
                <div className="row" style={{ marginTop: 8 }}>
                  {redline.some((r) => r.type === 'quality') && (
                    <input placeholder="品质确认人姓名" value={quality.name} onChange={(e) => setQuality({ ...quality, name: e.target.value })} style={{ width: 160 }} />
                  )}
                  {redline.some((r) => r.type === 'ergonomics') && (
                    <input placeholder="人因复核人姓名" value={ergo.name} onChange={(e) => setErgo({ ...ergo, name: e.target.value })} style={{ width: 160 }} />
                  )}
                </div>
              </div>
            )}
            <table>
              <thead><tr><th></th><th>映射</th><th>浪费</th><th>措施</th><th className="num">节省s</th><th>难度</th><th>优先级</th></tr></thead>
              <tbody>
                {suggest.candidates.map((c) => {
                  const key = candidateKey(c);
                  return (
                    <tr key={key}>
                      <td><input type="checkbox" checked={Boolean(checked[key])} onChange={(e) => setChecked({ ...checked, [key]: e.target.checked })} /></td>
                      <td className="mono">{c.mapping_id ?? '人工'}</td>
                      <td>{c.waste_type}</td>
                      <td>{c.measure}<div className="muted">{c.evidence}</div></td>
                      <td className="num">{c.est_save_s}</td>
                      <td>{c.difficulty}</td>
                      <td><span className={`tag ${c.tier === 'P1' ? 't-red' : c.tier === 'P2' ? 't-amber' : 't-gray'}`}>{c.tier} {c.priority}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" onClick={() => setSuggest(null)}>取消</button>
              {canAdopt && (
                <button className="btn primary" disabled={busy} onClick={adopt}>{redline ? '确认并采纳' : '确认采纳'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {vaEdit && (
        <div className="modal-mask" onClick={() => setVaEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>确认 / 改判 VA归类</h3>
            <p className="muted">#{vaEdit.desc}</p>
            <div className="form">
              <div className="field">
                <label>VA类别</label>
                {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
                <SelectMenu ariaLabel="VA 类别"
                  value={vaEdit.value}
                  onChange={(v) => setVaEdit({ ...vaEdit, value: v })}
                  options={[
                    { value: 'VA', label: 'VA' },
                    { value: 'RNVA', label: 'RNVA' },
                    { value: 'NVA', label: 'NVA' },
                  ]} />
              </div>
              <div className="field">
                <label>改判理由（≥5字；留空=直接确认暂定归类）</label>
                <input value={vaEdit.reason} onChange={(e) => setVaEdit({ ...vaEdit, reason: e.target.value })} placeholder="如：治具已定向，预对可消除" />
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setVaEdit(null)}>取消</button>
                <button className="btn primary" disabled={busy} onClick={applyVa}>确认</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {report && (
        <div className="modal-mask" onClick={() => setReport(null)}>
          <div className="modal" style={{ width: 'min(720px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="row no-print" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>改善建议书</h3>
              <div className="row tight">
                <button className="btn sm" onClick={() => window.print()}>打印 / 导出PDF</button>
                <button className="btn sm ghost" onClick={() => setReport(null)}>关闭</button>
              </div>
            </div>
            <div className="print-area" style={{ marginTop: 12 }}>
              <h3 style={{ textAlign: 'center' }}>IE 改善建议书</h3>
              <table>
                <tbody>
                  <tr><th style={{ width: 110 }}>工位</th><td>{report.header.station_name}（{report.header.station_id}）</td><th style={{ width: 90 }}>产线</th><td>{report.header.line_id}</td></tr>
                  <tr><th>版本</th><td>v{report.header.version}</td><th>建议编号</th><td className="mono">{report.header.imp_id}</td></tr>
                  <tr><th>状态</th><td>{report.status}</td><th>生成</th><td>{report.header.generated_by} · {report.header.generated_at.slice(0, 16).replace('T', ' ')}</td></tr>
                </tbody>
              </table>
              <h4 style={{ marginTop: 12 }}>问题与措施</h4>
              <div className="law"><b>{report.problem.waste_type}</b>：{report.problem.measure}</div>
              <table>
                <thead><tr><th className="num">#</th><th>类型</th><th>描述</th><th>VA</th><th className="num">ST(s)</th></tr></thead>
                <tbody>
                  {report.problem.involved.map((el) => (
                    <tr key={`${el.seq}-${el.desc}`}><td className="num">{el.seq}</td><td>{el.type}</td><td>{el.desc}</td><td>{el.va_class}</td><td className="num">{el.std_time}</td></tr>
                  ))}
                </tbody>
              </table>
              <h4 style={{ marginTop: 12 }}>收益估算</h4>
              <div className="mono" style={{ background: '#f7f9fc', padding: 10, borderRadius: 8 }}>
                预估节省 {report.benefit.est_save_s}s/件
                {report.benefit.params_configured
                  ? ` · 年化收益 ≈ ¥${(report.benefit.annual_yuan ?? 0).toLocaleString()}/年`
                  : ' · 收益参数未配置，暂不估算金额'}
                <br />公式：{report.benefit.formula}
              </div>
              {report.benefit.before_ct !== null && (
                <div className="muted" style={{ marginTop: 6 }}>
                  采纳时 CT {report.benefit.before_ct}s{report.benefit.after_ct !== null ? ` → 复测后 CT ${report.benefit.after_ct}s` : '（尚未复测回填）'}
                </div>
              )}
              <h4 style={{ marginTop: 12 }}>实施步骤</h4>
              <ol className="list">
                {report.steps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
              <h4 style={{ marginTop: 12 }}>签署</h4>
              <table>
                <tbody>
                  <tr>{report.signatures.map((s) => <td key={s} style={{ height: 32 }}>{s}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {diagnose && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--blue)' }}>
          <h3>AI 诊断（待审 · {diagnose.generated_by === 'ai' ? 'AI 生成' : '系统模板'}）</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{diagnose.report}</pre>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            AI 文案仅供参考，定量结论以本页规则计算为准；采纳请人工研判。
          </div>
        </div>
      )}
    </div>
  );
}
