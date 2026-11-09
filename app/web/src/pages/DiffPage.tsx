import { useEffect, useMemo, useState } from 'react';
import { api, type Element, type Station, type StationVersion } from '../api';
import { computeDiff, normalizeDesc, type DiffResult } from '../diff';
import SelectMenu from '../components/SelectMenu';

/**
 * 版本 Diff 视图（三堂会审 P1，作业专家苏定标设计）。
 * 同一工位相邻两版要素结构逐条比对：CT 汇总头 + 三色差异表 + 双轨时间线 + ECN 话术。
 * 只读页，不开编辑入口；入口在工作台「版本」菜单与头部版本meta。
 */

const STATE_META: Record<string, { label: string; cls: string }> = {
  'ADD': { label: '新增', cls: 'add' },
  'DELETE': { label: '删除', cls: 'del' },
  'MODIFY-结构': { label: '改结构', cls: 'mod-s' },
  'MODIFY-数值': { label: '改数值', cls: 'mod-n' },
  'MOVE': { label: '位移', cls: 'move' },
  'UNCHANGED': { label: '未变', cls: 'same' },
};

const fmtS = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const sign = (n: number) => (n > 0 ? `+${fmtS(n)}` : fmtS(n));

export default function DiffPage({ stationId, vA, vB }: { stationId: string; vA: number; vB: number }) {
  const [station, setStation] = useState<Station | null>(null);
  const [versions, setVersions] = useState<StationVersion[]>([]);
  const [elsA, setElsA] = useState<Element[] | null>(null);
  const [elsB, setElsB] = useState<Element[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStation(null); setVersions([]); setElsA(null); setElsB(null); setError(null);
    (async () => {
      try {
        const [st, vs] = await Promise.all([api.station(stationId), api.stationVersions(stationId)]);
        if (!alive) return;
        setStation(st); setVersions(vs);
        const [ea, eb] = await Promise.all([api.elements(stationId, vA), api.elements(stationId, vB)]);
        if (!alive) return;
        setElsA(ea.elements ?? []); setElsB(eb.elements ?? []);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [stationId, vA, vB]);

  const diff: DiffResult | null = useMemo(
    () => (elsA && elsB ? computeDiff(elsA as unknown as Parameters<typeof computeDiff>[0], elsB as unknown as Parameters<typeof computeDiff>[1]) : null),
    [elsA, elsB],
  );

  /* A/B 切换即改 hash（路由驱动，与全站一致） */
  const switchVersion = (side: 'a' | 'b', v: number) => {
    const na = side === 'a' ? v : vA;
    const nb = side === 'b' ? v : vB;
    window.location.hash = `#/diff/${stationId}/${na}/${nb}`;
  };

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文等）：降级为弹出文本域手动复制
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(key); setTimeout(() => setCopied(null), 2000); } catch { /* 忽略 */ }
      ta.remove();
    }
  };

  /* ---- ECN 话术四条（设计规范 §7）---- */
  const ecn = useMemo(() => {
    if (!diff) return null;
    const s = diff.summary;
    const sid = station?.station_id ?? stationId;
    const structRows = diff.rows.filter((r) => r.state === 'MODIFY-结构');
    const delRows = diff.rows.filter((r) => r.state === 'DELETE');
    const f = (n: number) => sign(n);
    return {
      summary:
        `工位 ${sid} v${vA}→v${vB}：要素 ${s.countA}→${s.countB}，CT ${fmtS(s.ctA)}s→${fmtS(s.ctB)}s（${s.deltaCtPct > 0 ? '+' : ''}${s.deltaCtPct}%）。` +
        `新增 ${s.adds} 项、删除 ${s.deletes} 项、修改 ${s.structMods + s.numMods} 项（结构 ${s.structMods} / 数值 ${s.numMods}）、位移 ${s.moves} 项。`,
      time:
        `CT 变化 ${f(s.deltaCt)}s（${s.deltaCtPct > 0 ? '+' : ''}${s.deltaCtPct}%），其中 NVA ${f(s.nvaB - s.nvaA)}s、RNVA ${f(s.rnvaB - s.rnvaA)}s、VA ${f(s.vaB - s.vaA)}s。`,
      pending:
        (structRows.length === 0 && delRows.length === 0 ? '无结构性变更与删除项。' : '') +
        structRows.map((r) => `#${r.b?.seq ?? '?'} ${normalizeDesc(r.b?.desc ?? '')}：${r.changed.join('、')} ${r.a ? `（v${vA}→v${vB}）` : ''}`).join('\n') +
        (structRows.length > 0 && delRows.length > 0 ? '\n' : '') +
        delRows.map((r) => `#${r.a?.seq ?? '?'} ${normalizeDesc(r.a?.desc ?? '')}：已删除，确认无下游依赖`).join('\n') +
        (diff.summary.warnings.length > 0 ? `\n注意：${diff.summary.warnings.join('；')}` : ''),
      improvement:
        `变更动机：〔待补：为什么改——客户需求/防错/减人/治具变更〕\n` +
        `验证数据：〔待补：改善后连续测量循环数/CV，及 CT 复测值〕\n` +
        `涉及培训：〔待补：受影响的作业者与 SOP 版本〕`,
    };
  }, [diff, station, stationId, vA, vB]);

  /* ---- CSV 导出（BOM 防 Excel 乱码）---- */
  const exportCsv = () => {
    if (!diff) return;
    const head = ['状态', 'vA序号', 'vB序号', '描述(vA)', '描述(vB)', '手别', 'VA', '起A(ms)', '起B(ms)', 'Δ起(ms)', 'ΔST(s)', '变化字段'];
    const lines = diff.rows.map((r) => {
      const c = (v: string | number | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [
        STATE_META[r.state]?.label ?? r.state,
        r.a?.seq ?? '', r.b?.seq ?? '',
        normalizeDesc(r.a?.desc ?? ''), normalizeDesc(r.b?.desc ?? ''),
        r.b?.hand ?? r.a?.hand ?? '',
        r.b?.va_class ?? r.a?.va_class ?? '',
        r.a?.start_ms ?? '', r.b?.start_ms ?? '',
        r.a && r.b ? r.b.start_ms - r.a.start_ms : '',
        r.a && r.b ? Math.round((r.b.std_time - r.a.std_time) * 100) / 100 : '',
        r.changed.join('、'),
      ].map(c).join(',');
    });
    const blob = new Blob(['\uFEFF' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `diff_${stationId}_v${vA}-v${vB}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error) {
    return <div className="container"><div className="card empty">加载失败：{error}<br /><a href={`#/workbench/${stationId}`}>← 返回分解工作台</a></div></div>;
  }
  if (!station || !diff) {
    return <div className="container"><div className="card empty">加载中…</div></div>;
  }

  const s = diff.summary;
  const maxMs = Math.max(1, ...[...diff.rows].map((r) => (r.b ? r.b.start_ms + r.b.dur_s * 1000 : r.a ? r.a.start_ms + r.a.dur_s * 1000 : 0)));
  const vaCls = (v: string) => (v === 'VA' ? 'va' : v === 'RNVA' ? 'rnva' : 'nva');

  return (
    <div className="container diffp">
      <div className="diffp-head">
        <div className="diffp-title">
          <a href={`#/workbench/${stationId}`} className="diffp-back">← 工作台</a>
          <h1>版本 Diff</h1>
          <span className="sub mono">{station.station_id} · {station.name}</span>
        </div>
        <div className="diffp-versions">
          <label>前一版
            {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
            <SelectMenu ariaLabel="前一版"
              value={String(vA)}
              onChange={(v) => switchVersion('a', Number(v))}
              options={versions.filter((v) => v.version !== vB && v.element_count > 0).map((v) => ({
                value: String(v.version),
                label: `v${v.version}（${v.element_count} 要素 / CT ${v.ct}s）`,
              }))} />
          </label>
          <span className="diffp-arrow">→</span>
          <label>当前版
            <SelectMenu ariaLabel="当前版"
              value={String(vB)}
              onChange={(v) => switchVersion('b', Number(v))}
              options={versions.filter((v) => v.version !== vA && v.element_count > 0).map((v) => ({
                value: String(v.version),
                label: `v${v.version}（${v.element_count} 要素 / CT ${v.ct}s）`,
              }))} />
          </label>
        </div>
      </div>

      {/* CT 汇总头（与引擎同口径：Σ 非异常要素 ST） */}
      <div className="diffp-ct card">
        <div className="diffp-ct-main">
          <span className="diffp-ct-v">v{vA}</span><b>{fmtS(s.ctA)}s</b>
          <span className="diffp-arrow">→</span>
          <span className="diffp-ct-v">v{vB}</span><b>{fmtS(s.ctB)}s</b>
          <em className={`diffp-delta ${s.deltaCt > 0 ? 'up' : s.deltaCt < 0 ? 'down' : ''}`}>
            {sign(s.deltaCt)}s（{s.deltaCtPct > 0 ? '+' : ''}{s.deltaCtPct}%）
          </em>
          <span className="muted">要素 {s.countA} → {s.countB}</span>
        </div>
        <div className="diffp-ct-split">
          <span className="dp nva">NVA {fmtS(s.nvaA)} → {fmtS(s.nvaB)}s</span>
          <span className="dp rnva">RNVA {fmtS(s.rnvaA)} → {fmtS(s.rnvaB)}s</span>
          <span className="dp va">VA {fmtS(s.vaA)} → {fmtS(s.vaB)}s</span>
          <span className="muted">新增 {s.adds} · 删除 {s.deletes} · 改结构 {s.structMods} · 改数值 {s.numMods} · 位移 {s.moves} · 未变 {s.unchanged}</span>
        </div>
        {s.warnings.map((w, i) => <div key={i} className="diffp-warn">注意：{w}</div>)}
      </div>

      {/* 差异表（合并排序，git-diff 式交错） */}
      <div className="diffp-table card">
        <table>
          <thead>
            <tr>
              <th>状态</th><th className="num">#A</th><th className="num">#B</th>
              <th>描述（v{vA}）</th><th>描述（v{vB}）</th>
              <th>手别</th><th>VA</th>
              <th className="num">起A</th><th className="num">起B</th><th className="num">Δ起</th><th className="num">ΔST</th>
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((r, i) => {
              const meta = STATE_META[r.state] ?? { label: r.state, cls: 'same' };
              const descChanged = r.changed.includes('描述');
              return (
                <tr key={i} className={`dr-${meta.cls}`}>
                  <td><span className={`dp-state ${meta.cls}`}>{meta.label}</span>{r.changed.length > 0 && <em className="dp-changed" title={r.changed.join('、')}>{r.changed.join('、')}</em>}</td>
                  <td className="num muted">{r.a?.seq ?? '—'}</td>
                  <td className="num muted">{r.b?.seq ?? '—'}</td>
                  <td className={r.state === 'DELETE' ? 'dp-del' : ''}>{normalizeDesc(r.a?.desc ?? '—')}</td>
                  <td className={r.state === 'ADD' ? 'dp-add' : (descChanged ? 'dp-desc-changed' : '')}>{normalizeDesc(r.b?.desc ?? '—')}</td>
                  <td>{r.changed.includes('手别') ? <span className="dp-fchg">{r.a?.hand} → {r.b?.hand}</span> : (r.b?.hand ?? r.a?.hand ?? '—')}</td>
                  <td>
                    {r.changed.includes('VA 归类')
                      ? <span className="dp-fchg">{r.a?.va_class} → {r.b?.va_class}</span>
                      : <span className={`tag ${vaCls(r.b?.va_class ?? r.a?.va_class ?? '')}`}>{r.b?.va_class ?? r.a?.va_class}</span>}
                  </td>
                  <td className="num mono">{r.a ? `${(r.a.start_ms / 1000).toFixed(2)}s` : '—'}</td>
                  <td className="num mono">{r.b ? `${(r.b.start_ms / 1000).toFixed(2)}s` : '—'}</td>
                  <td className="num mono">{r.a && r.b ? (r.b.start_ms - r.a.start_ms ? `${r.b.start_ms - r.a.start_ms > 0 ? '+' : ''}${r.b.start_ms - r.a.start_ms}` : '—') : '—'}</td>
                  <td className="num mono">{r.a && r.b ? (r.b.std_time - r.a.std_time ? sign(r.b.std_time - r.a.std_time) : '—') : '—'}</td>
                </tr>
              );
            })}
            {diff.rows.length === 0 && <tr><td colSpan={11} className="empty">两个版本均无要素</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 双轨时间线（精简静态，仅定位用） */}
      <div className="diffp-tl card">
        <div className="diffp-tl-t">时间线对照（上 v{vA} / 下 v{vB}，按 VA 三色；仅定位用，不可拖拽）</div>
        {[{ v: vA, els: elsA ?? [] }, { v: vB, els: elsB ?? [] }].map(({ v, els }) => (
          <div key={v} className="diffp-track">
            <span className="diffp-track-v mono">v{v}</span>
            <div className="diffp-lane">
              {els.map((e) => (
                <div key={e.element_id} className={`dp-blk ${vaCls(e.va_class)}${Number(e.outlier_flag) === 1 ? ' outlier' : ''}`}
                  style={{ left: `${(e.start_ms / maxMs) * 100}%`, width: `${Math.max(0.4, (e.dur_s * 1000 / maxMs) * 100)}%` }}
                  title={`#${e.seq} ${normalizeDesc(e.desc)} ${e.dur_s}s${Number(e.outlier_flag) === 1 ? '（异常）' : ''}`} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ECN 衔接：四条话术一键复制 */}
      {ecn && (
        <div className="diffp-ecn card">
          <div className="diffp-ecn-t">变更说明素材（一键复制，可直接贴进 ECN / 改善立项书）</div>
          {([
            ['summary', '① 变更摘要', ecn.summary],
            ['time', '② 工时影响', ecn.time],
            ['pending', '③ 待确认项', ecn.pending],
            ['improvement', '④ 改善说明（草稿）', ecn.improvement],
          ] as const).map(([key, label, text]) => (
            <div key={key} className="diffp-ecn-row">
              <span className="diffp-ecn-l">{label}</span>
              <code>{text}</code>
              <button className="btn sm ghost" onClick={() => void copyText(key, text)}>{copied === key ? '已复制 ✓' : '复制'}</button>
            </div>
          ))}
          <button className="btn sm" onClick={exportCsv}>导出差异 CSV（含 BOM）</button>
        </div>
      )}
    </div>
  );
}
