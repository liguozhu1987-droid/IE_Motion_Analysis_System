import { useEffect, useMemo, useState } from 'react';
import {
  api, ApiError,
  type LineShare, type ShareCandidate, type Station, type StationCollaborator,
} from '../api';
import SelectMenu from './SelectMenu';

interface Props {
  open: boolean;
  /** 被共享的工位（owner/admin 入口）；null = 只管理整线共享 */
  station: Station | null;
  /** 当前产线（整线共享 tab 用） */
  lines: string[];
  onClose: () => void;
  /** 授权变更后通知外层刷新工位/对象树 */
  onChanged: () => void;
}

type Tab = 'station' | 'line';

/**
 * v3.42 共享弹窗：工位级协作者（editor/viewer）+ 产线级批量授权。
 * 仅 owner/admin 可操作；授权人清单来自本租户 active 用户（share-candidates）。
 */
export default function ShareDialog({ open, station, lines, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('station');
  const [candidates, setCandidates] = useState<ShareCandidate[]>([]);
  const [collaborators, setCollaborators] = useState<StationCollaborator[]>([]);
  const [lineShares, setLineShares] = useState<LineShare[]>([]);
  const [pickUser, setPickUser] = useState('');
  const [pickRole, setPickRole] = useState<'editor' | 'viewer'>('editor');
  const [pickLine, setPickLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab(station ? 'station' : 'line');
    setError(null); setMsg(null); setPickUser(''); setPickRole('editor');
    setPickLine(lines[0] ?? '');
    let alive = true;
    (async () => {
      setBusy(true);
      try {
        const [cs, ls] = await Promise.all([
          api.shareCandidates().catch(() => [] as ShareCandidate[]),
          api.myLineShares().catch(() => [] as LineShare[]),
        ]);
        if (!alive) return;
        setCandidates(cs);
        setLineShares(ls);
        if (station) {
          const cols = await api.collaborators(station.station_id).catch(() => [] as StationCollaborator[]);
          if (alive) setCollaborators(cols);
        } else if (alive) setCollaborators([]);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [open, station, lines]);

  /** 已授权/拥有人从候选里剔除 */
  const available = useMemo(() => {
    const taken = new Set<string>(collaborators.map((c) => c.user_id));
    if (station?.owner_user_id) taken.add(station.owner_user_id);
    return candidates.filter((c) => !taken.has(c.user_id));
  }, [candidates, collaborators, station]);

  const doShare = async () => {
    setError(null); setMsg(null);
    if (tab === 'station') {
      if (!station) { setError('未选中工位'); return; }
      if (!pickUser) { setError('请选择要授权的用户'); return; }
      setBusy(true);
      try {
        const r = await api.shareStation(station.station_id, pickUser, pickRole) as { user_id: string; acl_role: string; display_name: string | null };
        setCollaborators((prev) => [...prev, {
          user_id: r.user_id, acl_role: r.acl_role === 'viewer' ? 'viewer' : 'editor', display_name: r.display_name ?? null,
          username: null, granted_by: null, granted_at: new Date().toISOString(),
        }]);
        setPickUser(''); setMsg('已授权'); onChanged();
      } catch (err) { setError(errText(err)); } finally { setBusy(false); }
    } else {
      if (!pickLine) { setError('请选择产线'); return; }
      if (!pickUser) { setError('请选择要授权的用户'); return; }
      setBusy(true);
      try {
        await api.shareLine(pickLine, pickUser, pickRole);
        setLineShares(await api.myLineShares());
        setPickUser(''); setMsg('整线共享已生效（名下该线现有与未来新建工位均共享）'); onChanged();
      } catch (err) { setError(errText(err)); } finally { setBusy(false); }
    }
  };

  const doUnshare = async (userId: string) => {
    setError(null); setMsg(null);
    setBusy(true);
    try {
      if (tab === 'station' && station) {
        await api.unshareStation(station.station_id, userId);
        setCollaborators((prev) => prev.filter((c) => c.user_id !== userId));
      } else {
        await api.unshareLine(pickLine || lineShares.find((s) => s.grantee_user_id === userId)?.line_id || '', userId);
        setLineShares(await api.myLineShares());
      }
      setMsg('已移除授权'); onChanged();
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal share-dlg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>共享与协作</h3>
            <p className="muted" style={{ margin: '2px 0 0' }}>
              {station ? `工位：${station.name}（${station.station_id}）` : '产线级批量授权'}
            </p>
          </div>
          <button className="btn ghost sm" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="row tight" style={{ margin: '12px 0' }}>
          {station && (
            <button className={`btn sm${tab === 'station' ? ' primary' : ''}`} onClick={() => setTab('station')}>本工位协作者</button>
          )}
          <button className={`btn sm${tab === 'line' ? ' primary' : ''}`} onClick={() => setTab('line')}>整线共享</button>
        </div>

        {busy && <div className="muted">处理中…</div>}

        {tab === 'station' && station && (
          <>
            <table className="panel-table">
              <thead><tr><th>用户</th><th>角色</th><th /></tr></thead>
              <tbody>
                {collaborators.length === 0 && <tr><td colSpan={3} className="muted">尚未共享给任何人</td></tr>}
                {collaborators.map((c) => (
                  <tr key={c.user_id}>
                    <td>{c.display_name || c.username || c.user_id}<div className="muted mono">{c.username ?? c.user_id}</div></td>
                    <td><span className={`tag ${c.acl_role === 'editor' ? 't-blue' : 't-gray'}`}>{c.acl_role === 'editor' ? '可编辑' : '只读'}</span></td>
                    <td className="num"><button className="btn ghost sm" disabled={busy} onClick={() => void doUnshare(c.user_id)}>移除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 12 }}>
              {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
              <SelectMenu ariaLabel="选择用户" triggerStyle={{ flex: 1 }}
                value={pickUser}
                onChange={(v) => setPickUser(v)}
                options={[{ value: '', label: '选择用户…' }, ...available.map((c) => ({ value: c.user_id, label: `${c.display_name}（${c.username}）` }))]} />
              <SelectMenu ariaLabel="选择角色" triggerStyle={{ width: 110 }}
                value={pickRole}
                onChange={(v) => setPickRole(v as 'editor' | 'viewer')}
                options={[{ value: 'editor', label: '可编辑' }, { value: 'viewer', label: '只读' }]} />
              <button className="btn primary sm" disabled={busy || !pickUser} onClick={() => void doShare()}>授权</button>
            </div>
          </>
        )}

        {tab === 'line' && (
          <>
            <p className="muted" style={{ marginTop: 4 }}>
              把<b>您名下</b>该产线的现有与未来新建工位一并共享给对方（对方对该线您的工位获得对应权限）。
            </p>
            <table className="panel-table">
              <thead><tr><th>产线</th><th>被授权人</th><th>角色</th><th /></tr></thead>
              <tbody>
                {lineShares.length === 0 && <tr><td colSpan={4} className="muted">暂无整线共享</td></tr>}
                {lineShares.map((s) => (
                  <tr key={`${s.line_id}-${s.grantee_user_id}`}>
                    <td className="mono">{s.line_id}</td>
                    <td>{s.display_name || s.grantee_user_id}</td>
                    <td><span className={`tag ${s.acl_role === 'editor' ? 't-blue' : 't-gray'}`}>{s.acl_role === 'editor' ? '可编辑' : '只读'}</span></td>
                    <td className="num"><button className="btn ghost sm" disabled={busy} onClick={() => { setPickLine(s.line_id); void doUnshare(s.grantee_user_id); }}>移除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 12 }}>
              {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
              <SelectMenu ariaLabel="选择产线" triggerStyle={{ width: 140 }}
                value={pickLine}
                onChange={(v) => setPickLine(v)}
                options={[...(lines.length === 0 ? [{ value: '', label: '暂无产线' }] : []), ...lines.map((l) => ({ value: l, label: l }))]} />
              <SelectMenu ariaLabel="选择用户" triggerStyle={{ flex: 1 }}
                value={pickUser}
                onChange={(v) => setPickUser(v)}
                options={[{ value: '', label: '选择用户…' }, ...candidates.map((c) => ({ value: c.user_id, label: `${c.display_name}（${c.username}）` }))]} />
              <SelectMenu ariaLabel="选择角色" triggerStyle={{ width: 110 }}
                value={pickRole}
                onChange={(v) => setPickRole(v as 'editor' | 'viewer')}
                options={[{ value: 'editor', label: '可编辑' }, { value: 'viewer', label: '只读' }]} />
              <button className="btn primary sm" disabled={busy || !pickUser || !pickLine} onClick={() => void doShare()}>整线授权</button>
            </div>
          </>
        )}

        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        {msg && <div className="success-banner" style={{ marginTop: 10 }}>{msg}</div>}
      </div>
    </div>
  );
}

function errText(err: unknown): string {
  if (err instanceof ApiError && (err.errors?.length ?? 0) > 0) {
    return `${err.message}：${err.errors!.map((e) => `[${e.code}] ${e.message}`).join('；')}`;
  }
  return err instanceof Error ? err.message : String(err);
}
