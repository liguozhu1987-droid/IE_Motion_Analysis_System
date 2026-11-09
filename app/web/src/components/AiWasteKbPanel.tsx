import { useCallback, useEffect, useState } from 'react';
import { api, type AiWasteKbItem } from '../api';
import SelectMenu from './SelectMenu';

/**
 * v3.51 改善知识库面板：手动整理 + 检索维护。
 *
 * 定位：把「人工录入条目」与「已确认的 AI 条目」沉淀为可检索经验，
 * 后续 AI 识别时按 waste_type / 要素类型 / 关键词轻量打分取 Top-N 注入 prompt（零向量依赖）。
 * 整理是手动触发（不引入后台定时作业），可按 source_ref 幂等重复整理。
 */

export interface AiWasteKbPanelProps {
  stationId: string;
  onClosed?: () => void;
}

export default function AiWasteKbPanel({ stationId, onClosed }: AiWasteKbPanelProps) {
  const [items, setItems] = useState<AiWasteKbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'finding' | 'issue'>('all');
  const [general, setGeneral] = useState(false);
  const [includeAi, setIncludeAi] = useState(true);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.aiWaste.listKb({
        station_id: stationId,
        ...(kind !== 'all' ? { kind } : {}),
        ...(q.trim() !== '' ? { q: q.trim() } : {}),
        status: 'all',
      });
      setItems(res.items ?? []);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [stationId, kind, q]);

  useEffect(() => { void load(); }, [load]);

  const archive = async () => {
    setArchiving(true); setErr(null); setMsg(null);
    try {
      const r = await api.aiWaste.archiveKb(stationId, { general, include_ai_confirmed: includeAi });
      setMsg(`整理完成：新增 ${r.created} 条 / 更新 ${r.updated} 条 / 跳过 ${r.skipped} 条`
        + (r.created === 0 ? '（重复整理幂等，未产生重复行）' : ''));
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setArchiving(false);
    }
  };

  const toggleStatus = async (it: AiWasteKbItem) => {
    try {
      await api.aiWaste.updateKb(it.kb_id, { status: it.status === 'active' ? 'archived' : 'active' });
      await load();
    } catch (e) { setErr((e as Error).message); }
  };

  const remove = async (it: AiWasteKbItem) => {
    if (!window.confirm(`删除该知识条目？\n\n${(it.problem ?? it.evidence ?? '').slice(0, 60)}`)) return;
    try {
      await api.aiWaste.deleteKb(it.kb_id);
      await load();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="card aw-kb" style={{ marginBottom: 12, padding: 12 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>改善知识库</b>
        <span className="tag t-gray">{items.length} 条</span>
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={() => { void load(); if (onClosed) onClosed(); }}>
          刷新
        </button>
      </div>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label className="wb-field" style={{ minWidth: 140 }}>
          <span>关键词</span>
          <input value={q} placeholder="检索问题/措施/证据" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="wb-field" style={{ minWidth: 130 }}>
          <span>类型</span>
          {/* v3.59 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
          <SelectMenu ariaLabel="按类型筛选" value={kind}
            onChange={(v) => setKind(v as 'all' | 'finding' | 'issue')}
            options={[
              { value: 'all', label: '全部' },
              { value: 'finding', label: '浪费识别' },
              { value: 'issue', label: '改善措施' },
            ]} />
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={includeAi} onChange={(e) => setIncludeAi(e.target.checked)} />
          纳入「已确认」AI 条目
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
          <input type="checkbox" checked={general} onChange={(e) => setGeneral(e.target.checked)} />
          整理为跨工位通用
        </label>
        <button type="button" className="btn primary sm" disabled={archiving} onClick={() => void archive()}>
          {archiving ? '整理中…' : '整理进知识库'}
        </button>
      </div>

      {err && <div className="error-banner">{err}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {loading && <div className="muted">加载中…</div>}
      {!loading && items.length === 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          暂无知识条目：点「整理进知识库」，把本工位人工录入条目（及已确认 AI 条目）沉淀为可检索经验。
        </div>
      )}

      {items.length > 0 && (
        <div className="table-scroll">
          <table className="dash-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 90 }}>浪费</th>
                <th>内容</th>
                <th style={{ width: 120 }}>关键词</th>
                <th style={{ width: 70 }}>命中</th>
                <th style={{ width: 90 }}>状态</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.kb_id}>
                  <td>
                    <span className={`tag ${it.kind === 'finding' ? 't-blue' : 't-teal'}`}>
                      {it.kind === 'finding' ? '浪费识别' : '改善措施'}
                    </span>
                  </td>
                  <td>
                    <span className="tag t-gray">{it.waste_type}</span>
                    {it.ecrs && <> <span className="mono">{it.ecrs}</span></>}
                  </td>
                  <td className="muted">
                    {it.kind === 'finding'
                      ? it.evidence
                      : <>{it.problem} <span style={{ opacity: 0.7 }}>→ {it.suggestion}</span></>}
                    {it.station_id === null && <span className="tag t-amber" style={{ marginLeft: 6 }}>通用</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{String(it.keywords ?? '').slice(0, 24)}</td>
                  <td className="num">{it.hit_count}</td>
                  <td>
                    <span className={`tag ${it.status === 'active' ? 't-teal' : 't-gray'}`}>
                      {it.status === 'active' ? '启用' : '停用'}
                    </span>
                  </td>
                  <td>
                    <button type="button" className="btn sm ghost" onClick={() => void toggleStatus(it)}>
                      {it.status === 'active' ? '停用' : '启用'}
                    </button>
                    <button type="button" className="btn sm ghost" onClick={() => void remove(it)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        后续 AI 识别会按「浪费类型 + 要素类型 + 关键词」检索命中的启用条目注入提示词（仅供启发，不得照抄），
        命中次数越多说明该经验被复用得越多。
      </div>
    </div>
  );
}
