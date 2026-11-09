import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, USER_STATUS_LABEL, type AdminRoleVo, type PermissionGroupVo, type RoleMemberVo,
} from '../api';
import { useAuth } from '../auth';
import SelectMenu from '../components/SelectMenu';

/**
 * 角色权限面板（v3.50，页签二）：角色左栏 + 权限矩阵右栏。
 * 只读（role:read）可浏览矩阵，改动需 role:write。
 * 关键约束：系统角色（is_system=1）不可删除；sys_admin 的用户与权限类权限由后端锁定不可摘除。
 */
export default function RolePermissionPanel() {
  const { can } = useAuth();
  const canWrite = can('role:write');

  const [roles, setRoles] = useState<AdminRoleVo[]>([]);
  const [groups, setGroups] = useState<PermissionGroupVo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ code: '', name: '', description: '', permissions: ['station:read'] });
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameForm, setRenameForm] = useState({ name: '', description: '' });
  // v3.58 角色侧成员：谁持有这个角色 + 从角色侧增删成员
  const [members, setMembers] = useState<RoleMemberVo[]>([]);
  const [candidates, setCandidates] = useState<{ userId: string; username: string; displayName: string }[]>([]);
  const [addUserId, setAddUserId] = useState('');

  const active = useMemo(() => roles.find((r) => r.roleId === activeId) ?? null, [roles, activeId]);

  const loadMembers = useCallback(async (roleId: string | null) => {
    if (!roleId) { setMembers([]); return; }
    try {
      const m = await api.roleMembers(roleId);
      setMembers(m.members ?? []);
    } catch { setMembers([]); }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, p] = await Promise.all([api.adminRoles(), api.adminPermissions()]);
      setRoles(r.roles);
      setGroups(p.groups);
      setActiveId((cur) => (cur && r.roles.some((x) => x.roleId === cur) ? cur : (r.roles[0]?.roleId ?? null)));
      // 候选用户（用于角色侧加入成员）：一次取回，内网量小
      const u = await api.adminUsers().catch(() => ({ users: [] as any[] }));
      setCandidates((u.users ?? []).map((x: any) => ({ userId: x.userId, username: x.username, displayName: x.displayName })));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setDraft(active ? [...active.permissions] : []);
    setDirty(false);
    void loadMembers(active?.roleId ?? null);
  }, [active?.roleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePerm = (code: string) => {
    setDraft((d) => (d.includes(code) ? d.filter((x) => x !== code) : [...d, code]));
    setDirty(true);
  };

  const toggleModule = (mod: string, on: boolean) => {
    const codes = groups.find((g) => g.module === mod)?.items.map((i) => i.code) ?? [];
    setDraft((d) => (on ? [...new Set([...d, ...codes])] : d.filter((c) => !codes.includes(c))));
    setDirty(true);
  };

  const save = async () => {
    if (!active) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.setRolePermissions(active.roleId, draft);
      setNotice(`已更新「${active.name}」的权限（${draft.length} 项），相关成员即时生效`);
      setDirty(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addMember = async () => {
    if (!active || !addUserId) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.addRoleMembers(active.roleId, [addUserId]);
      setNotice(`已加入 ${r.added.length} 人${r.skipped.length ? `，跳过 ${r.skipped.length} 人` : ''}`);
      setAddUserId('');
      await loadMembers(active.roleId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const removeMember = async (userId: string) => {
    if (!active) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.removeRoleMembers(active.roleId, [userId]);
      setNotice('已移除该成员');
      await loadMembers(active.roleId);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const removeRole = async () => {
    if (!active) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.deleteRole(active.roleId);
      setNotice(`已删除角色「${active.name}」`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        {/* 左栏：角色列表 */}
        <div className="card" style={{ width: 280, flex: '0 0 280px' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>角色</h3>
            {canWrite && <button className="btn primary sm" onClick={() => setCreateOpen(true)}>+ 新建</button>}
          </div>
          {roles.length === 0 ? (
            <div className="hint">暂无角色</div>
          ) : (
            <div>
              {roles.map((r) => (
                <div
                  key={r.roleId}
                  onClick={() => setActiveId(r.roleId)}
                  style={{
                    padding: '8px 10px', cursor: 'pointer', borderRadius: 6, marginBottom: 4,
                    background: r.roleId === activeId ? 'var(--c-accent-soft,#eef4ff)' : 'transparent',
                    border: r.roleId === activeId ? '1px solid var(--c-accent,#3b6fd4)' : '1px solid transparent',
                  }}
                >
                  <div className="row tight" style={{ justifyContent: 'space-between' }}>
                    <b>{r.name}</b>
                    <span className="tag t-gray">{r.memberCount} 人</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {r.code}{r.isSystem && <span className="tag t-blue" style={{ marginLeft: 6 }}>系统</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="hint" style={{ marginTop: 10 }}>
            系统角色（蓝标）为内置岗位角色，不可删除；自定义角色可改权限、改名、删除（需先解除成员）。
          </div>
        </div>

        {/* 右栏：权限矩阵 */}
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          {!active ? (
            <div className="empty">请选择一个角色</div>
          ) : (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ margin: 0 }}>
                    {active.name}
                    <span className="tag t-gray" style={{ marginLeft: 8 }}>{active.permissions.length} 项权限</span>
                    {dirty && <span className="tag t-amber" style={{ marginLeft: 6 }}>未保存</span>}
                  </h3>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {active.description ?? '（无说明）'}
                  </div>
                </div>
                <div className="row tight">
                  {canWrite && <button className="btn sm" onClick={() => { setRenameForm({ name: active.name, description: active.description ?? '' }); setRenameOpen(true); }}>改名/说明</button>}
                  {canWrite && <button className="btn sm danger" disabled={busy || active.isSystem} onClick={() => void removeRole()}>删除</button>}
                  {canWrite && <button className="btn primary sm" disabled={busy || !dirty} onClick={() => void save()}>保存权限</button>}
                </div>
              </div>

              {active.isSystem && active.code === 'sys_admin' && (
                <div className="law" style={{ marginTop: 10 }}>
                  系统管理员的「用户与权限」四类权限（user:read / user:write / role:read / role:write）为
                  <b>防锁死保留项</b>，即使取消勾选，服务端也会强制保留。
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                {groups.map((g) => {
                  const codes = g.items.map((i) => i.code);
                  const on = codes.filter((c) => draft.includes(c)).length;
                  return (
                    <div key={g.module} style={{ marginBottom: 14 }}>
                      <div className="row tight" style={{ marginBottom: 6 }}>
                        <b style={{ fontSize: 13 }}>{g.label}</b>
                        <span className="muted" style={{ fontSize: 12 }}>{on}/{codes.length}</span>
                        {canWrite && (
                          <button className="btn sm" disabled={busy}
                            onClick={() => toggleModule(g.module, on < codes.length)}>
                            {on === codes.length ? '取消全选' : '全选'}
                          </button>
                        )}
                      </div>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                        {g.items.map((p) => (
                          <label
                            key={p.code}
                            className="row tight"
                            style={{ cursor: canWrite ? 'pointer' : 'default', minWidth: 200 }}
                            title={p.roles?.length ? `已被角色引用：${p.roles.join('、')}` : '暂无角色引用'}
                          >
                            <input
                              type="checkbox"
                              disabled={!canWrite || busy}
                              checked={draft.includes(p.code)}
                              onChange={() => togglePerm(p.code)}
                            />
                            <span>{p.name}</span>
                            <span className="muted" style={{ fontSize: 11 }}>{p.code}</span>
                            {p.roles?.length > 0 && (
                              <span className="tag t-gray" style={{ fontSize: 10 }}>{p.roles.length} 个角色</span>
                            )}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* v3.58 角色成员：人员↔角色双向授权（此前只能从用户侧改角色） */}
              <div style={{ marginTop: 16, borderTop: '1px solid var(--c-border,#e2e5ea)', paddingTop: 12 }}>
                <div className="row tight" style={{ justifyContent: 'space-between' }}>
                  <b style={{ fontSize: 13 }}>角色成员（{members.length} 人）</b>
                  {canWrite && (
                    <div className="row tight">
                      {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
                      <SelectMenu ariaLabel="选择要加入的用户" triggerStyle={{ width: 200 }}
                        value={addUserId}
                        onChange={(v) => setAddUserId(v)}
                        options={[
                          { value: '', label: '选择要加入的用户…' },
                          ...candidates
                            .filter((c) => !members.some((m) => m.userId === c.userId))
                            .map((c) => ({ value: c.userId, label: `${c.username}（${c.displayName}）` })),
                        ]} />
                      <button className="btn sm primary" disabled={busy || !addUserId} onClick={() => void addMember()}>加入</button>
                    </div>
                  )}
                </div>
                {members.length === 0 ? (
                  <div className="hint" style={{ marginTop: 6 }}>该角色暂无成员。无成员账号看不到任何数据，请按岗位分配。</div>
                ) : (
                  <table style={{ marginTop: 6 }}>
                    <thead>
                      <tr><th>用户名</th><th>显示名</th><th>部门 / 岗位</th><th>状态</th>{canWrite && <th style={{ width: 80 }}>操作</th>}</tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.userId}>
                          <td>{m.username}</td>
                          <td>{m.displayName}</td>
                          <td className="muted" style={{ fontSize: 12 }}>
                            {m.department ?? '—'}{m.position ? ` / ${m.position}` : ''}
                          </td>
                          <td><span className="tag t-gray">{USER_STATUS_LABEL[m.status] ?? m.status}</span></td>
                          {canWrite && (
                            <td>
                              <button className="btn sm danger" disabled={busy} onClick={() => void removeMember(m.userId)}>移除</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="hint" style={{ marginTop: 6 }}>
                  从角色侧移除成员时，系统不允许摘掉最后一名具备用户/角色管理权限的在用账号（防锁死）。
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 新建角色 */}
      {createOpen && (
        <div className="modal-mask" onClick={() => setCreateOpen(false)}>
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3>新建自定义角色</h3>
            <div className="field">
              <label>角色标识 code（小写字母开头，2-24 位，建后不可改）</label>
              <input value={createForm.code} onChange={(e) => setCreateForm({ ...createForm, code: e.target.value })} placeholder="如 quality_auditor" autoFocus />
            </div>
            <div className="field">
              <label>角色名称</label>
              <input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="如 质量审核员" />
            </div>
            <div className="field">
              <label>说明（选填，写清楚这个角色是给谁用的）</label>
              <input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} />
            </div>
            <div className="field">
              <label>初始权限（可在创建后于矩阵中调整）</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {groups.flatMap((g) => g.items).map((p) => (
                  <label key={p.code} className="row tight" style={{ cursor: 'pointer', minWidth: 190 }}>
                    <input type="checkbox" checked={createForm.permissions.includes(p.code)}
                      onChange={() => setCreateForm((f) => ({
                        ...f,
                        permissions: f.permissions.includes(p.code)
                          ? f.permissions.filter((x) => x !== p.code) : [...f.permissions, p.code],
                      }))} />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || !createForm.code.trim() || !createForm.name.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.createRole({
                      code: createForm.code.trim(), name: createForm.name.trim(),
                      description: createForm.description.trim() || undefined,
                      permissions: createForm.permissions,
                    });
                    setNotice(`已创建角色「${createForm.name.trim()}」`);
                    setCreateOpen(false);
                    await load();
                  } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
                }}>创建</button>
              <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 改名/说明 */}
      {renameOpen && active && (
        <div className="modal-mask" onClick={() => setRenameOpen(false)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>修改角色：{active.code}</h3>
            <div className="field">
              <label>名称{active.isSystem && <span className="muted">（系统角色名称不可改）</span>}</label>
              <input value={renameForm.name} disabled={active.isSystem}
                onChange={(e) => setRenameForm({ ...renameForm, name: e.target.value })} />
            </div>
            <div className="field">
              <label>说明</label>
              <input value={renameForm.description} onChange={(e) => setRenameForm({ ...renameForm, description: e.target.value })} />
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.updateRole(active.roleId, {
                      ...(active.isSystem ? {} : { name: renameForm.name.trim() }),
                      description: renameForm.description.trim() || undefined,
                    });
                    setNotice('已更新角色信息');
                    setRenameOpen(false);
                    await load();
                  } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
                }}>保存</button>
              <button className="btn" onClick={() => setRenameOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
