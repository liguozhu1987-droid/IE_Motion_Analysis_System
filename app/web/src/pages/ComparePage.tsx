import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type BenefitParamsLine, type CompareResult } from '../api';
import { useAuth } from '../auth';
import AiCallBanner from '../components/AiCallBanner';

/**
 * 改善前后对比 + 收益参数设置（v3.0：benefit-params 按线 lines[] 整体读写）。
 * 保存策略：先拉全量 lines → 替换/追加本线条目 → 整体 POST（后端为整体替换语义）。
 */
export default function ComparePage({ stationId }: { stationId: string }) {
  const { can, user } = useAuth();
  const [data, setData] = useState<CompareResult | null>(null);
  const [needsRetest, setNeedsRetest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lineId, setLineId] = useState('');
  const [form, setForm] = useState({ rate: 45, output: 1200, realization: 0.7 });
  const [configured, setConfigured] = useState<BenefitParamsLine | null>(null);
  const [interp, setInterp] = useState<{ interpretation: string; regressionWarnings: string[]; generated_by: string } | null>(null);
  /** AI 解读进行态（独立于共享 busy，只控制本按钮文案） */
  const [interpBusy, setInterpBusy] = useState(false);

  const canSaveParams = can('settings:benefit-write');

  const load = useCallback(async () => {
    try {
      const res = await api.compare(stationId);
      setData(res);
      setLineId(res.station.line_id);
      setNeedsRetest(false);
      const p = await api.benefitParams();
      const entry = p.lines.find((l) => l.line_id === res.station.line_id) ?? null;
      setConfigured(entry);
      if (entry) setForm({ rate: entry.rate_yuan_per_hour, output: entry.daily_output, realization: entry.land_rate });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) { setNeedsRetest(true); setError(null); return; }
      setError((err as Error).message);
    }
  }, [stationId]);

  useEffect(() => { load().catch((err) => setError(err.message)); }, [load]);

  const runInterpret = async () => {
    setInterpBusy(true); setError(null);
    try {
      setInterp(await api.interpret(stationId));
      setMsg('AI 差异解读完成：结果见下方「AI 差异解读」卡片（待审状态）');
    } catch (err) {
      setMsg(null);
      setError((err as Error).message);
    } finally {
      setInterpBusy(false);
    }
  };

  const saveParams = async () => {
    if (!lineId) return;
    setBusy(true); setError(null);
    try {
      const current = await api.benefitParams();
      const next: BenefitParamsLine = {
        line_id: lineId,
        rate_yuan_per_hour: form.rate,
        daily_output: form.output,
        land_rate: form.realization,
        configured_by: user?.displayName || user?.username || 'IE主管',
        configured_at: new Date().toISOString().slice(0, 10),
      };
      const others = current.lines.filter((l) => l.line_id !== lineId);
      const res = await api.saveBenefitParams([...others, next]);
      setConfigured(res.lines.find((l) => l.line_id === lineId) ?? next);
      setMsg('收益参数已保存（按线一条，公式固定；其他产线参数不受影响）');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (needsRetest) {
    return (
      <div>
        <div className="page-head"><h1>改善前后对比</h1><div className="spacer" /><a className="btn" href="#/stations">← 工位清单</a></div>
        <div className="card empty">
          该工位尚无复测版本（只有v1），无法对比。<br />
          流程：改善实施 → 在分解工作台点“开始复测”（封存旧版）→ 提交复测分解 → 回到本页。
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <a className="btn primary" href={`#/workbench/${stationId}`}>去开始复测</a>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return <div className="card empty">{error ?? '加载中…'}</div>;

  const delta = data.delta_ct;
  const deltaPct = data.prev.ct > 0 ? Math.round((delta / data.prev.ct) * 1000) / 10 : 0;

  return (
    <div>
      <div className="page-head">
        <h1>{data.station.name} · 改善前后对比</h1>
        <span className="sub mono">{data.station.station_id} · v{data.prev.version} → v{data.curr.version} · {data.station.line_id}</span>
        <div className="spacer" />
        <a className="btn" href={`#/workbench/${stationId}`}>去分解</a>
        <a className="btn" href={`#/analysis/${stationId}`}>分析结果</a>
        <button className="btn" onClick={() => window.print()}>打印 / 导出PDF</button>
        {can('compare:read') && <button className="btn" disabled={busy || interpBusy} onClick={runInterpret}>{interpBusy ? '解读中…' : 'AI 解读差异'}</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}
      {/* v3.61：AI 调用全局横幅（统一反馈件；结果落在下方「AI 差异解读」卡片） */}
      <AiCallBanner active={interpBusy} label="正在调用 AI 差异解读" phase="LLM 生成中，通常需要数十秒" />

      <div className="metrics" style={{ marginBottom: 14 }}>
        <div className="metric"><div className="v">v{data.prev.version}</div><div className="l">改善前 CT {data.prev.ct}s</div></div>
        <div className="metric"><div className="v">v{data.curr.version}</div><div className="l">改善后 CT {data.curr.ct}s</div></div>
        <div className="metric"><div className={`v ${delta > 0 ? 'teal' : 'red'}`}>{delta > 0 ? '−' : '+'}{Math.abs(delta)}s</div><div className="l">单件节省（{deltaPct}%）</div></div>
        <div className="metric"><div className="v amber">{data.pairing_rate}%</div><div className="l">要素配对率</div></div>
        <div className="metric">
          <div className={`v ${data.benefit ? 'teal' : 'red'}`}>
            {data.benefit ? `¥${data.benefit.annual_yuan.toLocaleString()}` : '未配置'}
          </div>
          <div className="l">年化收益（估算）</div>
        </div>
      </div>

      {data.warnings.length > 0 && <div className="note">{data.warnings.join('；')}</div>}

      <div className="split" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3>收益估算（一行公式）</h3>
          {data.benefit ? (
            <>
              <div className="mono" style={{ background: '#f7f9fc', padding: 10, borderRadius: 8 }}>
                年化收益 = 节省秒数({data.benefit.saved_s_per_unit}) × 日产量({data.benefit.daily_output}) × 365 × 费率({data.benefit.rate_yuan_per_hour}元/工时) ÷ 3600 × 落地率({data.benefit.realization_rate})
                <br />= <b>¥{data.benefit.annual_yuan.toLocaleString()}/年</b>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>参数配置人：{data.benefit.configured_by ?? '—'} · {data.benefit.configured_at ?? ''}（IE主管一次性写入，公式固定）</div>
            </>
          ) : (
            <div className="law"><b>参数未配置，不计算收益（不猜默认值）。</b>请在右侧填写综合费率与日产量。</div>
          )}
        </div>

        <div className="card no-print">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>收益参数（线级：{lineId}）</h3>
            {canSaveParams && <a className="btn sm ghost" href="#/settings">全部产线 →</a>}
          </div>
          <div className="form">
            <div className="field"><label>综合费率（元/工时，10~500）</label><input type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: Number(e.target.value) })} /></div>
            <div className="field"><label>日产量（件/日，1~100000）</label><input type="number" value={form.output} onChange={(e) => setForm({ ...form, output: Number(e.target.value) })} /></div>
            <div className="field"><label>落地率（默认0.70）</label><input type="number" step="0.05" value={form.realization} onChange={(e) => setForm({ ...form, realization: Number(e.target.value) })} /></div>
            {canSaveParams ? (
              <button className="btn primary" disabled={busy} onClick={saveParams}>保存参数</button>
            ) : (
              <div className="muted">当前角色无参数保存权限（settings:benefit-write）</div>
            )}
            {configured && <div className="muted">当前生效：{configured.rate_yuan_per_hour}元/h · {configured.daily_output}件/日 · {configured.land_rate}</div>}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>前后要素对比（{data.pairs.length} 组配对，成功/部分/消除）</h3>
        <table>
          <thead>
            <tr>
              <th>#</th><th>改善前要素（v{data.prev.version}）</th><th className="num">ST</th>
              <th>改善后要素（v{data.curr.version}）</th><th className="num">ST</th>
              <th>配对</th><th className="num">ΔST</th>
            </tr>
          </thead>
          <tbody>
            {data.pairs.map((pair, index) => (
              <tr key={index}>
                <td className="num">{index + 1}</td>
                <td>{pair.prev ? `#${pair.prev.seq} ${pair.prev.desc}` : '—'}<div className="muted">{pair.prev?.type} {pair.referenced ? '· 建议关联' : ''}</div></td>
                <td className="num">{pair.prev?.std_time ?? '—'}</td>
                <td>{pair.curr ? `#${pair.curr.seq} ${pair.curr.desc}` : <span className="muted">已消除</span>}</td>
                <td className="num">{pair.curr?.std_time ?? '—'}</td>
                <td>
                  <span className={`tag ${pair.quality === 'success' ? 't-teal' : pair.quality === 'partial' ? 't-amber' : 't-gray'}`}>
                    {pair.quality === 'success' ? '成功' : pair.quality === 'partial' ? '部分' : '消除'}
                  </span>
                </td>
                <td className="num" style={{ color: pair.delta_std > 0 ? 'var(--teal)' : pair.delta_std < 0 ? 'var(--red)' : undefined }}>
                  {pair.delta_std > 0 ? '−' : pair.delta_std < 0 ? '+' : ''}{Math.abs(pair.delta_std)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10, gap: 24 }}>
          <div><b>新增要素：</b>{data.added.length === 0 ? '无' : data.added.map((el) => `#${el.seq} ${el.desc}`).join('；')}</div>
          <div><b>消除要素：</b>{data.removed.length === 0 ? '无' : data.removed.map((el) => `#${el.seq} ${el.desc}`).join('；')}</div>
        </div>
      </div>

      <div className="card">
        <h3>版本信息与签署（打印用）</h3>
        <table>
          <tbody>
            <tr><th style={{ width: 160 }}>工位</th><td>{data.station.name}（{data.station.station_id}）</td><th style={{ width: 120 }}>产线</th><td>{data.station.line_id}</td></tr>
            <tr><th>对比版本</th><td>v{data.prev.version}（{data.prev.element_count}要素, CT {data.prev.ct}s） → v{data.curr.version}（{data.curr.element_count}要素, CT {data.curr.ct}s）</td><th>TT</th><td>{data.station.tt_s}s</td></tr>
            <tr><th>VA占比</th><td>{data.prev.metrics.va_pct}% → {data.curr.metrics.va_pct}%</td><th>NVA占比</th><td>{data.prev.metrics.nva_pct}% → {data.curr.metrics.nva_pct}%</td></tr>
            <tr><th>IE工程师</th><td style={{ height: 34 }} /><th>主管抽审</th><td /></tr>
            <tr><th>日期</th><td /><th>备注</th><td>配对规则：要素ID精确→同类型+描述相似度≥75% →未匹配=消除</td></tr>
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 8 }}>
           ΔCT口径：工位级 CT 差为权威口径（CT=Σ生效且非异常要素ST）；要素级做归因。收益=节省秒数×日产量×365×费率÷3600×落地率，仅为估算，不进财务口径。
        </div>
      </div>

      {interp && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--blue)' }}>
          <h3>AI 差异解读（待审 · {interp.generated_by === 'ai' ? 'AI 生成' : '系统模板'}）</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{interp.interpretation}</pre>
          {interp.regressionWarnings.length > 0 && (
            <div className="note" style={{ marginTop: 8 }}>倒退预警：{interp.regressionWarnings.join('；')}</div>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            AI 文案仅供参考，定量结论以本页规则计算为准；采纳请人工研判。
          </div>
        </div>
      )}
    </div>
  );
}
