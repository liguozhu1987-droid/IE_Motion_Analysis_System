import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, ApiError, RULE_META,
  type RuleContent, type RuleSetMeta, type RuleSnapshotEntry,
} from '../api';
import { useAuth } from '../auth';

/** 规则展示顺序（与后端 RULE_CODES 对齐） */
const RULE_ORDER = ['va_rules', 'waste_triggers', 'ecrsa_map', 'redline_keywords', 'benefit_params', 'motion_standard'];

interface ParamRow {
  line_id: string;
  rate: number;
  output: number;
  land: number;
  configured_by?: string;
  configured_at?: string;
}

const toRows = (lines: { line_id: string; rate_yuan_per_hour: number; daily_output: number; land_rate: number; configured_by?: string; configured_at?: string }[]): ParamRow[] =>
  lines.map((l) => ({
    line_id: l.line_id, rate: l.rate_yuan_per_hour, output: l.daily_output, land: l.land_rate,
    configured_by: l.configured_by, configured_at: l.configured_at,
  }));

/**
 * 设置中心（v3.4 · #/settings）：解决信息架构诊断中的"入口埋没"。
 *  - 收益参数：全线参数表格化维护（行内编辑 + 新增产线 + 整体替换保存）；公式固定，参数无默认值。
 *  - 规则库：5 组规则的版本/来源总览 + 生效内容查看/编辑 + 发布新版本（发布立即全站生效，可追溯）。
 * 权限：settings:benefit-read/write（收益参数）、rule:read/write（规则库），按权限显示页签与按钮。
 */
export default function SettingsPage() {
  const { can, user } = useAuth();
  const canParams = can('settings:benefit-read');
  const canParamsWrite = can('settings:benefit-write');
  const canRules = can('rule:read');
  const canRuleWrite = can('rule:write');

  const [tab, setTab] = useState<'params' | 'rules'>(canParams ? 'params' : 'rules');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---------- 收益参数 ---------- */
  const [version, setVersion] = useState('');
  const [source, setSource] = useState('');
  const [formula, setFormula] = useState('');
  const [rows, setRows] = useState<ParamRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const loadParams = useCallback(async () => {
    const res = await api.benefitParams();
    setVersion(String(res.version));
    setSource(res.source);
    setFormula(res.formula);
    setRows(toRows(res.lines));
    setDirty(false);
    setRowErrors({});
  }, []);

  /* ---------- 规则库 ---------- */
  const [snapshot, setSnapshot] = useState<Record<string, RuleSnapshotEntry> | null>(null);
  const [sets, setSets] = useState<RuleSetMeta[]>([]);
  const [code, setCode] = useState<string>('va_rules');
  const [rule, setRule] = useState<RuleContent | null>(null);
  const [text, setText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    const [snap, list] = await Promise.all([api.rules.snapshot(), api.rules.sets()]);
    setSnapshot(snap);
    setSets(list);
  }, []);

  const loadContent = useCallback(async (target: string) => {
    setJsonErr(null);
    try {
      const res = await api.rules.content(target);
      setRule(res);
      setText(JSON.stringify(res.content, null, 2));
    } catch (err) {
      setRule(null); setText('');
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (canParams) loadParams().catch((err) => setError((err as Error).message));
  }, [canParams, loadParams]);

  useEffect(() => {
    if (canRules) loadRules().catch((err) => setError((err as Error).message));
  }, [canRules, loadRules]);

  useEffect(() => {
    if (canRules) loadContent(code).catch(() => { /* loadContent 内已提示 */ });
  }, [canRules, code, loadContent]);

  /* ---------- 收益参数：校验与保存 ---------- */
  const patchRow = (index: number, patch: Partial<ParamRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setDirty(true);
    const next = { ...rows[index], ...patch };
    setRowErrors((prev) => {
      const copy = { ...prev };
      const err = validateRow(next);
      if (err) copy[index] = err; else delete copy[index];
      return copy;
    });
  };

  const validateRow = (r: ParamRow): string | null => {
    if (!r.line_id.trim()) return '产线编码必填（如 L01）';
    if (!Number.isFinite(r.rate) || r.rate <= 0) return '费率须 > 0（元/工时）';
    if (!Number.isFinite(r.output) || r.output <= 0) return '日产量须 > 0（件/日）';
    if (!Number.isFinite(r.land) || r.land <= 0 || r.land > 1) return '落地率须在 0~1 之间（默认 0.7）';
    return null;
  };

  const saveParams = async () => {
    setBusy(true); setError(null); setMsg(null);
    const errs: Record<number, string> = {};
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      const err = validateRow(r);
      if (err) errs[i] = err;
      else if (seen.has(r.line_id.trim())) errs[i] = '产线编码重复';
      else seen.add(r.line_id.trim());
    });
    setRowErrors(errs);
    if (Object.keys(errs).length > 0) {
      setError(`有 ${Object.keys(errs).length} 行参数不合法，已标红（参数无默认值，非法值不会被采用）`);
      setBusy(false);
      return;
    }
    try {
      const payload = rows.map((r) => ({
        line_id: r.line_id.trim(),
        rate_yuan_per_hour: r.rate,
        daily_output: Math.round(r.output),
        land_rate: r.land,
        configured_by: user?.displayName || user?.username || 'IE主管',
        configured_at: new Date().toISOString().slice(0, 10),
      }));
      const res = await api.saveBenefitParams(payload);
      setMsg(`已发布参数版本（${res.rule_set_id}）：${payload.length} 条产线参数即刻生效`);
      await loadParams();
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addRow = () => {
    const used = new Set(rows.map((r) => r.line_id));
    let candidate = '';
    for (let i = 1; i <= 99; i += 1) {
      const id = `L${String(i).padStart(2, '0')}`;
      if (!used.has(id)) { candidate = id; break; }
    }
    setRows((prev) => [...prev, { line_id: candidate, rate: 45, output: 1200, land: 0.7 }]);
    setDirty(true);
  };

  /* ---------- 规则库：发布 ---------- */
  const publish = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
      setJsonErr(null);
    } catch (err) {
      setJsonErr(`JSON 语法错误：${(err as Error).message}`);
      return;
    }
    const rv = typeof parsed.rv === 'string' ? parsed.rv : '(未写 rv，将沿用旧版本号)';
    if (!window.confirm(`发布「${RULE_META[code]?.name ?? code}」新版本？\n\n版本号：${rv}\n影响：发布后立即全站生效（分析/建议/对比引擎随即使用新规则），旧版本仅保留元数据记录。`)) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const res = await api.rules.publish(code, parsed, user?.displayName || user?.username);
      // v3.19：服务端版本号治理——rv 格式非法 400；撞车自动顺延（如 RV1.0→RV1.1）并如实回告
      setMsg(res.bumped
        ? `规则已发布：「${rv}」已发布过，版本号自动顺延为 ${res.version} → ${res.rule_set_id}`
        : `规则已发布：${res.code} → ${res.version ?? res.rule_set_id}`);
      await loadRules();
      await loadContent(code);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const historyOfCode = useMemo(() => sets.filter((s) => s.code === code), [sets, code]);
  /** v3.19：版本历史按版本号分组合并——治理前 rv 不递增也放行，收益参数堆积了 56 条同名
   *  RV1.0，逐行平铺既是噪音也掩盖真实版本脉络；合并后一行 = 一个版本号 + 发布次数。 */
  const historyGroups = useMemo(() => {
    const byVer = new Map<string, { version: string; count: number; latest: string; active: boolean; by: string }>();
    for (const s of historyOfCode) {
      const cur = byVer.get(s.version);
      if (!cur) byVer.set(s.version, { version: s.version, count: 1, latest: String(s.created_at), active: s.is_active === 1, by: s.created_by ?? '—' });
      else {
        cur.count += 1;
        if (String(s.created_at) > cur.latest) cur.latest = String(s.created_at);
        if (s.is_active === 1) cur.active = true;
      }
    }
    return [...byVer.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  }, [historyOfCode]);
  const activeSets = useMemo(() => sets.filter((s) => s.is_active === 1), [sets]);

  const tabs = [
    canParams && { key: 'params' as const, label: '收益参数', hint: '全线费率/日产量/落地率' },
    canRules && { key: 'rules' as const, label: '规则库', hint: '查看与发布生效规则' },
  ].filter(Boolean) as { key: 'params' | 'rules'; label: string; hint: string }[];

  return (
    <div>
      <div className="page-head">
        <h1>设置中心</h1>
        <span className="sub">收益参数与规则库的唯一入口（发布即生效、版本可追溯；公式与口径由规则集统一管理）</span>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      <div className="set-tabs no-print">
        {tabs.map((t) => (
          <button key={t.key} className={`set-tab${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}<small>{t.hint}</small>
          </button>
        ))}
      </div>

      {tab === 'params' && canParams && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: 0 }}>收益参数（按产线一条）</h3>
                <p className="muted" style={{ margin: '2px 0 0' }}>
                  公式固定：年化收益 = 节省秒数 × 日产量 × 365 × 费率 ÷ 3600 × 落地率。
                  <b>未配置的产线不计算收益（不猜默认值）</b>。当前版本 {version || '—'}（来源 {source || '—'}）。
                </p>
              </div>
              <div className="row">
                {canParamsWrite && <button className="btn sm" onClick={addRow}>+ 新增产线</button>}
                {canParamsWrite && (
                  <button className="btn primary sm" disabled={busy || !dirty} onClick={() => void saveParams()}>
                    {busy ? '保存中…' : dirty ? '保存并发布' : '无改动'}
                  </button>
                )}
                <button className="btn sm" disabled={busy || !dirty} onClick={() => void loadParams()}>撤销</button>
              </div>
            </div>

            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>产线</th>
                    <th style={{ width: 150 }}>费率（元/工时）</th>
                    <th style={{ width: 150 }}>日产量（件/日）</th>
                    <th style={{ width: 130 }}>落地率</th>
                    <th>配置人 / 时间</th>
                    <th style={{ width: 70 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.line_id}-${i}`}>
                      <td>
                        <input className={rowErrors[i] ? 'in-err' : ''} value={r.line_id} disabled={!canParamsWrite}
                          style={{ width: 100 }} onChange={(e) => patchRow(i, { line_id: e.target.value })} />
                      </td>
                      <td>
                        <input className={rowErrors[i] ? 'in-err' : ''} type="number" value={r.rate} disabled={!canParamsWrite}
                          style={{ width: 110 }} onChange={(e) => patchRow(i, { rate: Number(e.target.value) })} />
                      </td>
                      <td>
                        <input className={rowErrors[i] ? 'in-err' : ''} type="number" value={r.output} disabled={!canParamsWrite}
                          style={{ width: 120 }} onChange={(e) => patchRow(i, { output: Number(e.target.value) })} />
                      </td>
                      <td>
                        <input className={rowErrors[i] ? 'in-err' : ''} type="number" step="0.05" min={0} max={1} value={r.land} disabled={!canParamsWrite}
                          style={{ width: 90 }} onChange={(e) => patchRow(i, { land: Number(e.target.value) })} />
                      </td>
                      <td className="muted">
                        {r.configured_by ?? '—'} · {r.configured_at ?? '—'}
                        {rowErrors[i] && <div style={{ color: 'var(--red)', fontWeight: 600 }}>{rowErrors[i]}</div>}
                      </td>
                      <td>
                        {canParamsWrite && (
                          <button className="btn sm ghost" onClick={() => { setRows((prev) => prev.filter((_, x) => x !== i)); setDirty(true); }}>移除</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="empty">还没有任何产线参数：点「+ 新增产线」为第一条线配置费率与日产量，否则对比页不显示年化收益。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {!canParamsWrite && <div className="muted" style={{ marginTop: 8 }}>当前角色只读（缺少 settings:benefit-write）</div>}
          </div>
          <div className="note" style={{ marginTop: 12 }}>
            保存即发布为新的规则版本（rule_set 留痕，可追溯）；对比页仍保留单线快捷编辑（场景化），两处写入同一个规则集。
          </div>
        </>
      )}

      {tab === 'rules' && canRules && (
        <div className="grid" style={{ gridTemplateColumns: '1fr 1.6fr', alignItems: 'start' }}>
          <div className="card">
            <h3>规则集（{activeSets.length} 组生效）</h3>
            <div className="rule-list">
              {RULE_ORDER.map((c) => {
                const meta = RULE_META[c] ?? { name: c, desc: '' };
                const snap = snapshot?.[c];
                return (
                  <div key={c} className={`rule-row${code === c ? ' on' : ''}`}
                    onClick={() => { setCode(c); void loadContent(c); }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="rule-name">{meta.name}<span className="mono muted"> {c}</span></div>
                      <div className="rule-desc">{meta.desc}</div>
                    </div>
                    <div className="rule-badges">
                      <span className="tag t-blue">{snap?.version ?? '—'}</span>
                      <span className={`tag ${snap?.source === 'db' ? 't-teal' : 't-gray'}`}>{snap?.source === 'db' ? 'DB' : '文件'}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
              启动自检：5 组规则全部可加载、DSL 表达式全部可编译，否则服务拒绝启动（fail-fast）。
            </p>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{RULE_META[code]?.name ?? code} · 生效内容</h3>
              <div className="row">
                <span className="tag t-gray">{rule?.version ?? '—'}</span>
                <button className="btn sm" onClick={() => void loadContent(code)}>重新载入</button>
                {canRuleWrite && (
                  <button className="btn primary sm" disabled={busy || !text} onClick={() => void publish()}>发布新版本</button>
                )}
              </div>
            </div>
            <p className="muted" style={{ margin: '4px 0 8px', fontSize: 12 }}>
              直接编辑 JSON（<b>rv 字段即版本号</b>，发布前请递增，如 RV1.0 → RV1.1）。发布立即全站生效。
            </p>
            <textarea
              className={`json-editor mono${jsonErr ? ' in-err' : ''}`}
              value={text}
              readOnly={!canRuleWrite}
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value);
                try { JSON.parse(e.target.value); setJsonErr(null); }
                catch (err) { setJsonErr(`JSON 语法错误：${(err as Error).message}`); }
              }}
              rows={18}
            />
            {jsonErr && <div className="error-banner" style={{ marginTop: 8 }}>{jsonErr}</div>}
            {!canRuleWrite && <div className="muted" style={{ marginTop: 8 }}>当前角色只读（缺少 rule:write）</div>}

            <h4 style={{ marginTop: 14 }}>版本历史（{historyGroups.length} 个版本号{historyOfCode.length !== historyGroups.length ? ` · 共 ${historyOfCode.length} 次发布` : ''}）</h4>
            {historyGroups.length === 0 ? (
              <div className="muted">暂无发布记录（当前生效内容来自文件源或种子）</div>
            ) : (
              <div className="table-scroll">
                <table className="dash-table">
                  <thead><tr><th>版本</th><th>状态</th><th>发布人</th><th>时间</th></tr></thead>
                  <tbody>
                    {historyGroups.map((s) => (
                      <tr key={s.version}>
                        <td className="mono">{s.version}{s.count > 1 && <span className="tag t-gray" style={{ marginLeft: 6 }} title="治理前的同名重复发布（已修复：撞车自动顺延）">×{s.count}</span>}</td>
                        <td>{s.active ? <span className="tag t-teal">生效</span> : <span className="tag t-gray">历史</span>}</td>
                        <td>{s.by}</td>
                        <td className="muted">{s.latest.slice(0, 16).replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
              历史版本不再提供内容读取（仅元数据）；回滚 = 手动发布旧内容或从文件恢复后重新发布。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
