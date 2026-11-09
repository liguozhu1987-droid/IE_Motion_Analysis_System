import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Station } from '../api';
import { useAuth } from '../auth';

interface CmcFactory { cmc_factory_id: number; code: string; name: string; region: string | null }
interface CmcLine {
  cmc_line_id: number; code: string; name: string;
  process_type: string; process_type_raw: string | null; line_type: string | null;
  factory_code: string; factory_name: string; project_count: number;
}
interface CmcProject {
  program_number: string; name: string; customer: string | null; phase: string | null;
  product_group: string | null; ct_standard: number | null; allocation_ratio: number | null;
}

/**
 * 主数据（v3.21）：只读总览 + 本地工位维护。
 * 为什么公司/产线/项目没有增删改入口：它们是产能系统（CMC）的资产——
 * factories / production_lines / project_line_allocations / cbco_records 跨库实时只读，
 * 本系统绝不写 CMC（铁律），也不做同步表——单一数据源天然一致。
 * 本系统权限内的可维护项只有：①工位（名称/TT/删除）②本租户公司名称与区域。
 */
export default function MasterDataPage() {
  const { user, can } = useAuth();
  const canWriteStation = can('station:write');
  const canWriteTenant = can('settings:benefit-write');
  const isAdmin = (user?.roles ?? []).includes('admin');

  const [tenant, setTenant] = useState<{ name: string; region: string; code: string } | null>(null);
  const [factories, setFactories] = useState<CmcFactory[]>([]);
  const [lines, setLines] = useState<CmcLine[]>([]);
  const [projects, setProjects] = useState<CmcProject[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [qLine, setQLine] = useState('');
  const [qStation, setQStation] = useState('');
  const [selectedLineCode, setSelectedLineCode] = useState<string>(''); /* 点产线行 → 联动项目与工位 */
  const [expandedProjects, setExpandedProjects] = useState(false);

  /* 工位行内编辑 */
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editTt, setEditTt] = useState('');
  const [deleting, setDeleting] = useState<Station | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  /* 公司（租户）编辑 */
  const [editingTenant, setEditingTenant] = useState(false);
  const [tenantName, setTenantName] = useState('');
  const [tenantRegion, setTenantRegion] = useState('');

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [t, fs, ls, ss] = await Promise.all([
        api.tenant().catch(() => null),
        api.cmc.factories().catch((e) => { throw cmcHint(e); }),
        api.cmc.lines().catch((e) => { throw cmcHint(e); }),
        api.stations(),
      ]);
      setTenant(t); setFactories(fs); setLines(ls); setStations(ss);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  /* 点产线 → 拉该项目分配清单（实时） */
  useEffect(() => {
    if (!selectedLineCode) { setProjects([]); return; }
    const line = lines.find((l) => l.code === selectedLineCode);
    if (!line) { setProjects([]); return; }
    let alive = true;
    api.cmc.lineProjects(line.cmc_line_id)
      .then((ps) => { if (alive) setProjects(ps); })
      .catch(() => { if (alive) setProjects([]); });
    return () => { alive = false; };
  }, [selectedLineCode, lines]);

  const filteredLines = useMemo(() => {
    const k = qLine.trim().toLowerCase();
    if (!k) return lines;
    return lines.filter((l) =>
      [l.code, l.name, l.process_type, l.factory_name, l.factory_code, l.line_type ?? '']
        .join(' ').toLowerCase().includes(k));
  }, [lines, qLine]);

  const filteredStations = useMemo(() => {
    const k = qStation.trim().toLowerCase();
    return stations
      .filter((s) => !selectedLineCode || s.line_id === selectedLineCode)
      .filter((s) => !k || [s.station_id, s.name, s.line_id].join(' ').toLowerCase().includes(k));
  }, [stations, qStation, selectedLineCode]);

  const startEdit = (s: Station) => {
    setEditing(s.station_id);
    setEditName(s.name);
    setEditTt(s.tt === null || s.tt === undefined ? '' : String(s.tt));
    setMsg(null);
  };

  const saveEdit = async (s: Station) => {
    const tt = editTt === '' ? null : Number(editTt);
    if (tt !== null && (Number.isNaN(tt) || tt < 0)) { setError('TT 须为非负数字'); return; }
    try {
      await api.updateStation(s.station_id, { name: editName.trim() || s.name, tt: tt ?? undefined });
      setEditing(null);
      setMsg(`已更新工位 ${s.station_id}`);
      void reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await api.deleteStation(deleting.station_id);
      setMsg(`已删除工位 ${deleting.station_id}（含全部版本要素与改善记录）`);
      setDeleting(null); setDeleteConfirm('');
      window.dispatchEvent(new CustomEvent('stations:changed'));
      void reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const saveTenant = async () => {
    try {
      await api.patchTenant({ name: tenantName.trim(), region: tenantRegion.trim() });
      setEditingTenant(false);
      setMsg('已更新公司信息');
      void reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  if (loading) return <div className="card empty">加载主数据…</div>;

  return (
    <div>
      {/* 数据来源与一致性口径 */}
      <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent, #2563eb)' }}>
        <h3>主数据来源</h3>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
          公司/产线/项目及产线-项目分配关系 <b>实时只读</b> 自产能系统（CMC：factories / production_lines /
          project_line_allocations / cbco_records），本系统不做同步、不提供修改入口——
          在产能系统变更后，下次查询即自动生效，天然一致。
          本平台仅维护 <b>分析工位</b>（创建向导自动生成编码）。
        </p>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>{error}</div>}
      {msg && <div className="success-banner" onClick={() => setMsg(null)}>{msg}</div>}

      {/* 公司：本地租户（可改名称/区域） + CMC 工厂清单（只读） */}
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>公司</h3>
        <div className="row" style={{ alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{tenant?.name ?? '—'}</div>
            <div className="muted" style={{ fontSize: 12 }}>编码 {tenant?.code ?? '—'} · 区域 {tenant?.region ?? '—'}</div>
          </div>
          {canWriteTenant && !editingTenant && (
            <button className="btn sm" onClick={() => { setTenantName(tenant?.name ?? ''); setTenantRegion(tenant?.region ?? ''); setEditingTenant(true); }}>
              编辑名称/区域
            </button>
          )}
          {editingTenant && (
            <span className="row" style={{ gap: 8 }}>
              <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="公司名称" style={{ width: 180 }} />
              <input value={tenantRegion} onChange={(e) => setTenantRegion(e.target.value)} placeholder="区域" style={{ width: 120 }} />
              <button className="btn sm primary" onClick={() => void saveTenant()}>保存</button>
              <button className="btn sm" onClick={() => setEditingTenant(false)}>取消</button>
            </span>
          )}
        </div>
        <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>
          CMC 工厂清单（只读 · {factories.length} 家）：
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {factories.map((f) => (
            <span key={f.cmc_factory_id} className="tag" title={`${f.name}（${f.code}）${f.region ? ` · ${f.region}` : ''}`}>
              {f.name}（{f.code}）{f.region ? ` · ${f.region}` : ''}
            </span>
          ))}
          {factories.length === 0 && <span className="muted">产能系统暂不可联或无数据</span>}
        </div>
      </div>

      {/* 产线：CMC 只读 + 检索 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>产线（CMC · 只读 {lines.length} 条）</h3>
          <input value={qLine} onChange={(e) => setQLine(e.target.value)} placeholder="搜索 编码/名称/工艺/工厂…" style={{ width: 240 }} />
        </div>
        <div className="table-scroll" style={{ marginTop: 10, maxHeight: 320 }}>
          <table className="dash-table">
            <thead><tr>
              <th>产线编码</th><th>产线名称</th><th>工厂</th><th>工艺</th><th>线体类型</th><th className="num">已分配项目</th>
            </tr></thead>
            <tbody>
              {filteredLines.map((l) => (
                <tr key={l.cmc_line_id} className={`pick${selectedLineCode === l.code ? ' on' : ''}`}
                  onClick={() => setSelectedLineCode(selectedLineCode === l.code ? '' : l.code)}
                  title="点击查看该线的项目分配并过滤工位">
                  <td><code>{l.code}</code></td><td>{l.name}</td>
                  <td>{l.factory_name}（{l.factory_code}）</td>
                  <td>{l.process_type}</td><td>{l.line_type ?? '—'}</td>
                  <td className="num">{l.project_count}</td>
                </tr>
              ))}
              {filteredLines.length === 0 && <tr><td colSpan={6} className="muted">{lines.length === 0 ? '产能系统暂不可联' : '无匹配产线'}</td></tr>}
            </tbody>
          </table>
        </div>
        {selectedLineCode && (
          <div style={{ marginTop: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="muted" style={{ fontSize: 13 }}>
                产线 <b>{selectedLineCode}</b> 的项目分配（CMC 实时 · {projects.length} 个）
                {selectedLineCode && lines.find((l) => l.code === selectedLineCode)?.project_count === 0 ? ' · 该产线暂无分配' : ''}
              </div>
              {projects.length > 4 && (
                <button className="btn sm" onClick={() => setExpandedProjects((v) => !v)}>{expandedProjects ? '收起' : `展开全部 ${projects.length} 项`}</button>
              )}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              {(expandedProjects ? projects : projects.slice(0, 4)).map((p) => (
                <span key={p.program_number} className="tag" title={[p.phase, p.customer, p.ct_standard !== null ? `CT=${p.ct_standard}s` : ''].filter(Boolean).join(' · ')}>
                  {p.program_number} · {p.name}{p.ct_standard !== null && p.ct_standard !== undefined ? ` · CT ${p.ct_standard}s` : ''}
                </span>
              ))}
              {projects.length === 0 && <span className="muted">该产线在产能系统中暂无项目分配</span>}
            </div>
          </div>
        )}
      </div>

      {/* 工位：本系统唯一可维护对象 */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>
            分析工位（本地 {stations.length} 个{selectedLineCode ? ` · 限产线 ${selectedLineCode}` : ''}）
          </h3>
          <div className="row" style={{ gap: 8 }}>
            {selectedLineCode && <button className="btn sm" onClick={() => setSelectedLineCode('')}>清除产线过滤</button>}
            <input value={qStation} onChange={(e) => setQStation(e.target.value)} placeholder="搜索 编码/名称/产线…" style={{ width: 220 }} />
          </div>
        </div>
        <div className="table-scroll" style={{ marginTop: 10, maxHeight: 380 }}>
          <table className="dash-table">
            <thead><tr>
              <th>工位编码</th><th>名称</th><th>产线</th><th className="num">TT(s)</th><th className="num">版本</th><th>更新时间</th><th style={{ width: 150 }}>操作</th>
            </tr></thead>
            <tbody>
              {filteredStations.map((s) => (
                <tr key={s.station_id}>
                  <td><code>{s.station_id}</code></td>
                  {editing === s.station_id ? (
                    <>
                      <td><input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: 150 }} /></td>
                      <td>{s.line_id}</td>
                      <td className="num"><input value={editTt} onChange={(e) => setEditTt(e.target.value)} style={{ width: 70 }} /></td>
                      <td className="num">{s.version}</td><td>{s.updated_at ?? '—'}</td>
                      <td>
                        <span className="row" style={{ gap: 6 }}>
                          <button className="btn sm primary" disabled={!canWriteStation} onClick={() => void saveEdit(s)}>保存</button>
                          <button className="btn sm" onClick={() => setEditing(null)}>取消</button>
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{s.name}</td><td>{s.line_id}</td>
                      <td className="num">{s.tt ?? '—'}</td>
                      <td className="num">{s.version}</td><td>{s.updated_at ?? '—'}</td>
                      <td>
                        {canWriteStation && (
                          <span className="row" style={{ gap: 6 }}>
                            <button className="btn sm" onClick={() => startEdit(s)}>编辑</button>
                            {isAdmin && <button className="btn sm danger" onClick={() => { setDeleting(s); setDeleteConfirm(''); }}>删除</button>}
                          </span>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {filteredStations.length === 0 && <tr><td colSpan={7} className="muted">无匹配工位</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          工位编码由创建向导按 CMC 产线码自动生成，不可改；删除为级联删除（该工位全部版本要素与改善记录），仅管理员可用且需二次确认。
        </p>
      </div>

      {/* 删除确认（级联） */}
      {deleting && (
        <div className="modal-mask" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="wz-head">
              <div><h3>删除工位 {deleting.station_id}</h3></div>
              <button className="wz-x" onClick={() => setDeleting(null)} aria-label="关闭">×</button>
            </div>
            <div style={{ padding: '4px 20px 16px' }}>
              <p style={{ marginTop: 0 }}>
                将<b>级联删除</b>该工位的全部内容，<b>不可恢复</b>：
              </p>
              <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
                <li>全部分解版本及动作要素（含视频标注）</li>
                <li>全部改善记录（{deleting.name}）</li>
              </ul>
              <p className="muted" style={{ fontSize: 13 }}>请输入工位编码 <code>{deleting.station_id}</code> 以确认：</p>
              <input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} style={{ width: '100%' }} placeholder={deleting.station_id} />
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
                <button className="btn" onClick={() => setDeleting(null)}>取消</button>
                <button className="btn danger" disabled={deleteConfirm !== deleting.station_id} onClick={() => void doDelete()}>确认删除</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** CMC 连接失败话术统一（与向导一致） */
function cmcHint(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|ETIMEDOUT|ECONNREFUSED|数据库/i.test(msg)) {
    return new Error(`产能系统（CMC）暂不可联：${msg}。公司/产线/项目为实时只读，恢复后自动可用。`);
  }
  return err instanceof Error ? err : new Error(msg);
}
