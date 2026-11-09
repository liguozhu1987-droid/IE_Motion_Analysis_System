import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, ROLE_OPTIONS, USER_STATUS_LABEL, DATA_SCOPE_LABEL, CERT_LEVEL_LABEL, CERT_STATUS_LABEL,
  type AdminRoleVo, type AdminUserVo, type ResetRequestVo, type UserEffectivePermVo, type UserSummaryVo,
} from '../api';
import { useAuth } from '../auth';
import RolePermissionPanel from './RolePermissionPanel';
import RbacAuditPanel from './RbacAuditPanel';
import SelectMenu from '../components/SelectMenu';

/**
 * 用户与权限中心（v3.50，#/admin-users）：三页签
 *  ① 用户管理——注册审批 / 建号 / 人员档案 / 角色分配 / 批量授权 / 停启用 / 口令处置
 *  ② 角色权限——角色 CRUD + 权限矩阵分配（role:read 查看 / role:write 维护）
 *  ③ 变更审计——权限与账号变更全留痕（audit:read）
 */
export default function UserManagementPage() {
  const { can, user: me } = useAuth();
  const canWrite = can('user:write');
  /** v3.58：停用当前登录管理员本人需二次确认（后端强制要求 confirmSelf） */
  const [selfDisableTarget, setSelfDisableTarget] = useState<AdminUserVo | null>(null);
  const canRoleRead = can('role:read') || can('role:write');
  const canAudit = can('audit:read');

  const [tab, setTab] = useState<'users' | 'roles' | 'audit'>('users');

  const [users, setUsers] = useState<AdminUserVo[]>([]);
  const [roles, setRoles] = useState<AdminRoleVo[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [departments, setDepartments] = useState<string[]>([]);
  const [requests, setRequests] = useState<ResetRequestVo[]>([]);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  /** v3.58：角色维度 + 资质状态维度筛选与台账汇总 */
  const [roleFilter, setRoleFilter] = useState('');
  const [certFilter, setCertFilter] = useState('');
  const [summary, setSummary] = useState<UserSummaryVo | null>(null);
  const [deptBulkOpen, setDeptBulkOpen] = useState(false);
  const [deptBulkRoles, setDeptBulkRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* 多选批量授权 */
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRoles, setBulkRoles] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<'replace' | 'merge'>('replace');

  /* 弹窗状态（独立 state，一次只开一个） */
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    username: '', password: '', displayName: '', email: '', roles: ['ie_engineer'],
    department: '', position: '', employeeNo: '', dataScope: 'own', certLevel: '', certExpiresAt: '',
  });
  const [profileTarget, setProfileTarget] = useState<AdminUserVo | null>(null);
  const [profileForm, setProfileForm] = useState({
    department: '', position: '', employeeNo: '', dataScope: 'own', certLevel: '', certExpiresAt: '',
  });
  const [approveTarget, setApproveTarget] = useState<AdminUserVo | null>(null);
  const [approveRoles, setApproveRoles] = useState<string[]>([]);
  const [rejectTarget, setRejectTarget] = useState<AdminUserVo | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rolesTarget, setRolesTarget] = useState<AdminUserVo | null>(null);
  const [rolesSel, setRolesSel] = useState<string[]>([]);
  const [permTarget, setPermTarget] = useState<AdminUserVo | null>(null);
  const [permVo, setPermVo] = useState<UserEffectivePermVo | null>(null);
  const [tempPwdTarget, setTempPwdTarget] = useState<AdminUserVo | null>(null);
  const [tempPwdResult, setTempPwdResult] = useState<string | null>(null);
  const [codeTarget, setCodeTarget] = useState<AdminUserVo | null>(null);
  const [codeResult, setCodeResult] = useState<{ code: string; expiresAt: string } | null>(null);

  useEffect(() => { document.title = '用户与权限中心 · IE改善效率平台'; }, []);

  const roleOptions = useMemo(() => {
    const dyn = roles.map((r) => ({ code: r.code, name: r.name }));
    const merged = new Map(ROLE_OPTIONS.map((r) => [r.code, r]));
    dyn.forEach((r) => { if (!merged.has(r.code)) merged.set(r.code, r); });
    return [...merged.values()];
  }, [roles]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, r] = await Promise.all([
        api.adminUsers({
          status: status || undefined,
          keyword: keyword.trim() || undefined,
          department: deptFilter || undefined,
          role: roleFilter || undefined,
          certStatus: certFilter || undefined,
        }),
        api.resetRequests(),
      ]);
      setUsers(u.users);
      setPendingCount(u.pendingCount);
      setDepartments(u.departments ?? []);
      setRequests(r.requests);
      setSummary(u.summary ?? null);
      if (canRoleRead) {
        const rr = await api.adminRoles().catch(() => ({ roles: [] as AdminRoleVo[] }));
        setRoles(rr.roles);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [status, keyword, deptFilter, roleFilter, certFilter, canRoleRead]);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (arr: string[], v: string, set: (a: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const statusTag = (s: string) => {
    const cls = s === 'active' ? 't-teal' : s === 'pending' ? 't-amber' : s === 'rejected' || s === 'locked' ? 't-red' : 't-gray';
    return <span className={`tag ${cls}`}>{USER_STATUS_LABEL[s] ?? s}</span>;
  };

  /** v3.58：资质状态以服务端 certStatus 为准（前端不再各自算日期，避免展示口径漂移） */
  const certExpired = (u: AdminUserVo) => u.certStatus === 'expired';
  const certStatusTag = (u: AdminUserVo) => {
    const cls = u.certStatus === 'expired' ? 't-red' : u.certStatus === 'expiring' ? 't-amber'
      : u.certStatus === 'valid' ? 't-teal' : 't-gray';
    return <span className={`tag ${cls}`}>{CERT_STATUS_LABEL[u.certStatus] ?? u.certStatus}</span>;
  };

  const closeAll = () => {
    setCreateOpen(false); setApproveTarget(null); setRejectTarget(null); setRolesTarget(null);
    setTempPwdTarget(null); setTempPwdResult(null); setCodeTarget(null); setCodeResult(null);
    setProfileTarget(null); setPermTarget(null); setPermVo(null); setBulkOpen(false);
  };

  const tabBtn = (key: 'users' | 'roles' | 'audit', label: string, show = true) =>
    show ? (
      <button className={`btn sm${tab === key ? ' primary' : ''}`} onClick={() => setTab(key)}>{label}</button>
    ) : null;

  return (
    <div>
      <div className="page-head">
        <h1>用户与权限中心</h1>
        <span className="sub">人员 · 角色 · 权限 · 变更留痕（DEFAULT 租户）</span>
        <div className="spacer" />
        <div className="row tight">
          {tabBtn('users', '用户管理')}
          {tabBtn('roles', '角色权限', canRoleRead)}
          {tabBtn('audit', '变更审计', canAudit)}
        </div>
        {tab === 'users' && pendingCount > 0 && <span className="tag t-amber">待审批 {pendingCount}</span>}
        {tab === 'users' && <button className="btn sm" onClick={() => void load()} disabled={busy}>刷新</button>}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      {tab === 'roles' && canRoleRead && <RolePermissionPanel />}
      {tab === 'audit' && canAudit && <RbacAuditPanel />}
      {tab === 'roles' && !canRoleRead && <div className="card empty">当前角色无权查看角色权限（缺少 role:read）。</div>}
      {tab === 'audit' && !canAudit && <div className="card empty">当前角色无权查看审计（缺少 audit:read）。</div>}

      {tab === 'users' && (
        <>
          {/* 重置申请面板（helpdesk：谁在申请/申请时间/过期时间；明文码仅在下发时一次性可见） */}
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>
              重置码申请
              {requests.length > 0 && <span className="tag t-amber" style={{ marginLeft: 8 }}>{requests.length} 个待处理</span>}
            </h3>
            {requests.length === 0 ? (
              <div className="hint">暂无有效重置申请。用户在登录页提交"忘记密码"后会在此列出（不含明文码，需管理员下发或线下获取）。</div>
            ) : (
              <table>
                <thead>
                  <tr><th>用户</th><th>显示名</th><th>账号状态</th><th>申请时间</th><th>过期时间</th><th>已尝试</th><th>来源 IP</th></tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.resetId}>
                      <td>{r.username}</td>
                      <td>{r.displayName}</td>
                      <td>{statusTag(r.userStatus)}</td>
                      <td>{new Date(r.appliedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                      <td>{new Date(r.expiresAt).toLocaleString('zh-CN', { hour12: false })}</td>
                      <td>{r.attempts} / 5</td>
                      <td>{r.ip || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 筛选（v3.59 全部 SelectMenu 自绘，根治原生 popup 漂移飞走） */}
          <div className="row" style={{ marginBottom: 12 }}>
            <SelectMenu ariaLabel="按状态筛选" value={status} triggerStyle={{ width: 140 }}
              onChange={(v) => setStatus(v)}
              options={[
                { value: '', label: '全部状态' },
                { value: 'active', label: '正常' },
                { value: 'pending', label: '待审批' },
                { value: 'rejected', label: '已驳回' },
                { value: 'locked', label: '已锁定' },
                { value: 'disabled', label: '已停用' },
              ]} />
            {departments.length > 0 && (
              <SelectMenu ariaLabel="按部门筛选" value={deptFilter} triggerStyle={{ width: 160 }}
                onChange={(v) => setDeptFilter(v)}
                options={[{ value: '', label: '全部部门' }, ...departments.map((d) => ({ value: d, label: d }))]} />
            )}
            {/* v3.58：按角色 / 资质状态筛选 */}
            <SelectMenu ariaLabel="按角色筛选" value={roleFilter} triggerStyle={{ width: 170 }}
              onChange={(v) => setRoleFilter(v)}
              options={[{ value: '', label: '全部角色' }, ...roleOptions.map((r) => ({ value: r.code, label: r.name }))]} />
            <SelectMenu ariaLabel="按资质状态筛选" value={certFilter} triggerStyle={{ width: 150 }}
              onChange={(v) => setCertFilter(v)}
              options={[
                { value: '', label: '全部资质状态' },
                { value: 'valid', label: '有效' },
                { value: 'expiring', label: '30 天内到期' },
                { value: 'expired', label: '已过期' },
                { value: 'none', label: '未认证' },
              ]} />
            {canWrite && deptFilter && (
              <button className="btn sm" disabled={busy}
                onClick={() => { setDeptBulkRoles(['ie_engineer']); setDeptBulkOpen(true); }}>
                按部门批量授权
              </button>
            )}
            <input
              placeholder="搜索用户名 / 显示名 / 工号 / 岗位"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: 240 }}
            />
            {canWrite && (
              <button className="btn primary sm" onClick={() => { setCreateForm({ username: '', password: '', displayName: '', email: '', roles: ['ie_engineer'], department: '', position: '', employeeNo: '', dataScope: 'own', certLevel: '', certExpiresAt: '' }); setCreateOpen(true); }}>+ 新建用户</button>
            )}
          </div>

          {/* v3.58 人员台账汇总：一眼看清有多少人待审批、资质是否临期 */}
          {summary && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                <span>共 <b>{summary.total}</b> 人</span>
                {summary.byStatus.filter((s) => s.status === 'pending').map((s) => (
                  <span key="p" className="tag t-amber">待审批 {s.count}</span>
                ))}
                {summary.byStatus.filter((s) => s.status === 'disabled').map((s) => (
                  <span key="d" className="tag t-gray">已停用 {s.count}</span>
                ))}
                {summary.certExpired > 0 && <span className="tag t-red">资质过期 {summary.certExpired}</span>}
                {summary.certExpiring > 0 && <span className="tag t-amber">资质临期 {summary.certExpiring}</span>}
                {summary.byRole.slice(0, 6).map((r) => (
                  <span key={r.code} className="tag t-blue">
                    {roleOptions.find((o) => o.code === r.code)?.name ?? r.code} {r.count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 批量授权条 */}
          {canWrite && selected.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>已选 <b>{selected.length}</b> 人</span>
                <div className="row tight">
                  <button className="btn sm primary" disabled={busy} onClick={() => { setBulkRoles(['ie_engineer']); setBulkMode('replace'); setBulkOpen(true); }}>批量授权</button>
                  <button className="btn sm" onClick={() => setSelected([])}>取消选择</button>
                </div>
              </div>
            </div>
          )}

          {/* 用户表 */}
          <div className="card">
            {users.length === 0 ? (
              <div className="empty">没有符合条件的用户</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    {canWrite && <th style={{ width: 32 }}><input type="checkbox"
                      checked={selected.length > 0 && selected.length === users.filter((u) => u.status !== 'pending').length}
                      onChange={(e) => setSelected(e.target.checked ? users.filter((u) => u.status !== 'pending').map((u) => u.userId) : [])} /></th>}
                    <th>用户名</th><th>显示名</th><th>部门 / 岗位</th><th>角色</th>
                    <th>数据范围</th><th>方法资质</th><th>状态</th><th style={{ minWidth: 260 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.userId}>
                      {canWrite && <td><input type="checkbox" disabled={u.status === 'pending'}
                        checked={selected.includes(u.userId)}
                        onChange={() => toggle(selected, u.userId, setSelected)} /></td>}
                      <td>{u.username}{u.employeeNo && <div className="muted" style={{ fontSize: 11 }}>工号 {u.employeeNo}</div>}</td>
                      <td>{u.displayName}<div className="muted" style={{ fontSize: 11 }}>{u.email ?? ''}</div></td>
                      <td>
                        {u.department ?? <span className="muted">未填</span>}
                        {u.position && <div className="muted" style={{ fontSize: 11 }}>{u.position}</div>}
                      </td>
                      <td>
                        {u.roles.length === 0
                          ? <span className="muted">未分配</span>
                          : u.roles.map((r) => <span className="tag t-blue" key={r} style={{ marginRight: 4 }}>{roleOptions.find((o) => o.code === r)?.name ?? r}</span>)}
                      </td>
                      <td><span className="tag t-gray">{DATA_SCOPE_LABEL[u.dataScope] ?? u.dataScope}</span></td>
                      <td>
                        {u.certLevel && u.certLevel !== 'none'
                          ? <span className="row tight" style={{ gap: 4 }}>
                              <span className="tag t-gray">{CERT_LEVEL_LABEL[u.certLevel] ?? u.certLevel}</span>
                              {certStatusTag(u)}
                              {u.certExpiresAt && <span className="muted" style={{ fontSize: 11 }}>
                                {certExpired(u) ? '已于' : '至'} {new Date(u.certExpiresAt).toLocaleDateString('zh-CN')}
                              </span>}
                            </span>
                          : <span className="muted">未认证</span>}
                      </td>
                      <td>{statusTag(u.status)}{u.mustChangePwd && <span className="tag t-gray" style={{ marginLeft: 4 }}>待改密</span>}</td>
                      <td>
                        <div className="row tight">
                          {canWrite && u.status === 'pending' && (
                            <>
                              <button className="btn sm primary" disabled={busy}
                                onClick={() => { setApproveTarget(u); setApproveRoles(['ie_engineer']); }}>审批</button>
                              <button className="btn sm danger" disabled={busy}
                                onClick={() => { setRejectTarget(u); setRejectReason(''); }}>驳回</button>
                            </>
                          )}
                          {canWrite && u.status === 'active' && (
                            <>
                              <button className="btn sm" disabled={busy}
                                onClick={() => { setRolesTarget(u); setRolesSel([...u.roles]); }}>角色</button>
                              <button className="btn sm" disabled={busy}
                                onClick={() => { setProfileTarget(u); setProfileForm({ department: u.department ?? '', position: u.position ?? '', employeeNo: u.employeeNo ?? '', dataScope: u.dataScope ?? 'own', certLevel: u.certLevel ?? '', certExpiresAt: u.certExpiresAt ? String(u.certExpiresAt).slice(0, 10) : '' }); }}>档案</button>
                              <button className="btn sm" disabled={busy}
                                onClick={() => { setPermTarget(u); setPermVo(null); void api.userPermissions(u.userId).then(setPermVo).catch((e) => setError((e as Error).message)); }}>权限</button>
                              <button className="btn sm danger" disabled={busy}
                                onClick={() => {
                                  if (me?.userId && u.userId === me.userId) { setSelfDisableTarget(u); return; }
                                  void run(async () => {
                                    await api.updateUser(u.userId, { status: 'disabled' });
                                    setNotice(`已停用 ${u.username}，其会话已吊销`);
                                  });
                                }}>停用</button>
                            </>
                          )}
                          {canWrite && u.status === 'disabled' && (
                            <>
                              <button className="btn sm" disabled={busy}
                                onClick={() => void run(async () => { await api.updateUser(u.userId, { status: 'active' }); setNotice(`已启用 ${u.username}`); })}>启用</button>
                              <button className="btn sm" disabled={busy}
                                onClick={() => { setRolesTarget(u); setRolesSel([...u.roles]); }}>角色</button>
                            </>
                          )}
                          {canWrite && u.status === 'locked' && (
                            <button className="btn sm" disabled={busy}
                              onClick={() => void run(async () => { await api.updateUser(u.userId, { status: 'active' }); setNotice(`已解锁 ${u.username}`); })}>解锁</button>
                          )}
                          {canWrite && (
                            <>
                              <button className="btn sm" disabled={busy}
                                onClick={() => { setTempPwdTarget(u); setTempPwdResult(null); }}>代置口令</button>
                              <button className="btn sm" disabled={busy}
                                onClick={() => { setCodeTarget(u); setCodeResult(null); }}>下发重置码</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* —— 弹窗：新建用户 —— */}
      {createOpen && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3>新建用户</h3>
            <div className="form">
              <div className="row">
                <div className="field" style={{ flex: 1 }}>
                  <label>用户名（登录名，全局唯一）</label>
                  <input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                    placeholder="3-32 位字母、数字、._-" autoFocus />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>显示名</label>
                  <input value={createForm.displayName} onChange={(e) => setCreateForm({ ...createForm, displayName: e.target.value })} placeholder="如：王工" />
                </div>
              </div>
              <div className="field">
                <label>初始密码（至少 8 位含字母数字；首次登录强制改密）</label>
                <input type="text" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
              </div>
              <div className="row">
                <div className="field" style={{ flex: 1 }}>
                  <label>部门（选填）</label>
                  <input value={createForm.department} onChange={(e) => setCreateForm({ ...createForm, department: e.target.value })} placeholder="如：IE 部" />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>岗位（选填）</label>
                  <input value={createForm.position} onChange={(e) => setCreateForm({ ...createForm, position: e.target.value })} placeholder="如：IE 工程师" />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>工号（选填）</label>
                  <input value={createForm.employeeNo} onChange={(e) => setCreateForm({ ...createForm, employeeNo: e.target.value })} />
                </div>
              </div>
              <div className="row">
                <div className="field" style={{ flex: 1 }}>
                  <label>数据范围</label>
                  {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
                  <SelectMenu ariaLabel="数据范围"
                    value={createForm.dataScope}
                    onChange={(v) => setCreateForm({ ...createForm, dataScope: v })}
                    options={[
                      { value: 'own', label: '仅本人创建' },
                      { value: 'line', label: '本产线' },
                      { value: 'tenant', label: '本租户' },
                      { value: 'all', label: '全集团' },
                    ]} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>方法资质等级</label>
                  <SelectMenu ariaLabel="方法资质等级"
                    value={createForm.certLevel}
                    onChange={(v) => setCreateForm({ ...createForm, certLevel: v })}
                    options={[
                      { value: '', label: '未认证' },
                      { value: 'L1', label: 'L1 初级' },
                      { value: 'L2', label: 'L2 独立分析' },
                      { value: 'L3', label: 'L3 可复核签发' },
                    ]} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>资质有效期（选填）</label>
                  <input type="date" value={createForm.certExpiresAt} onChange={(e) => setCreateForm({ ...createForm, certExpiresAt: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>邮箱（选填）</label>
                <input value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
              </div>
              <div className="field">
                <label>角色（至少一个）</label>
                <div className="row">
                  {roleOptions.map((r) => (
                    <label key={r.code} className="row tight" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={createForm.roles.includes(r.code)}
                        onChange={() => toggle(createForm.roles, r.code, (a) => setCreateForm({ ...createForm, roles: a }))} />
                      {r.name}
                    </label>
                  ))}
                </div>
              </div>
              {error && <div className="error-banner">{error}</div>}
              <div className="row">
                <button className="btn primary" disabled={busy || !createForm.username.trim() || !createForm.password || createForm.roles.length === 0}
                  onClick={() => void run(async () => {
                    await api.createUser({
                      username: createForm.username.trim(), password: createForm.password,
                      displayName: createForm.displayName.trim() || undefined,
                      email: createForm.email.trim() || undefined, roles: createForm.roles,
                      department: createForm.department.trim() || undefined,
                      position: createForm.position.trim() || undefined,
                      employeeNo: createForm.employeeNo.trim() || undefined,
                      dataScope: createForm.dataScope,
                      certLevel: createForm.certLevel || undefined,
                      certExpiresAt: createForm.certExpiresAt || undefined,
                    });
                    setNotice(`已创建 ${createForm.username}（首次登录需改密）`);
                    closeAll();
                  })}>创建</button>
                <button className="btn" onClick={closeAll}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：人员档案（部门/岗位/工号/数据范围/资质） —— */}
      {profileTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
            <h3>人员档案：{profileTarget.username}</h3>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label>部门</label>
                <input value={profileForm.department} onChange={(e) => setProfileForm({ ...profileForm, department: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>岗位</label>
                <input value={profileForm.position} onChange={(e) => setProfileForm({ ...profileForm, position: e.target.value })} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>工号</label>
                <input value={profileForm.employeeNo} onChange={(e) => setProfileForm({ ...profileForm, employeeNo: e.target.value })} />
              </div>
            </div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <label>数据范围</label>
                {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
                <SelectMenu ariaLabel="数据范围"
                  value={profileForm.dataScope}
                  onChange={(v) => setProfileForm({ ...profileForm, dataScope: v })}
                  options={[
                    { value: 'own', label: '仅本人创建' },
                    { value: 'line', label: '本产线' },
                    { value: 'tenant', label: '本租户' },
                    { value: 'all', label: '全集团' },
                  ]} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>方法资质等级</label>
                <SelectMenu ariaLabel="方法资质等级"
                  value={profileForm.certLevel}
                  onChange={(v) => setProfileForm({ ...profileForm, certLevel: v })}
                  options={[
                    { value: '', label: '未认证' },
                    { value: 'none', label: '未认证（显式）' },
                    { value: 'L1', label: 'L1 初级' },
                    { value: 'L2', label: 'L2 独立分析' },
                    { value: 'L3', label: 'L3 可复核签发' },
                  ]} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>资质有效期</label>
                <input type="date" value={profileForm.certExpiresAt} onChange={(e) => setProfileForm({ ...profileForm, certExpiresAt: e.target.value })} />
              </div>
            </div>
            <div className="hint">数据范围与资质等级目前为「标注 + 排序/提醒」用途，用于人员分工与复训提醒；后续接入行级过滤时据此生效。</div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy}
                onClick={() => void run(async () => {
                  await api.updateUser(profileTarget.userId, {
                    department: profileForm.department.trim(),
                    position: profileForm.position.trim(),
                    employeeNo: profileForm.employeeNo.trim(),
                    dataScope: profileForm.dataScope,
                    certLevel: profileForm.certLevel || undefined,
                    certExpiresAt: profileForm.certExpiresAt || undefined,
                  });
                  setNotice(`已更新 ${profileTarget.username} 的人员档案`);
                  closeAll();
                })}>保存</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：生效权限 —— */}
      {permTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
            <h3>生效权限：{permTarget.username}</h3>
            {!permVo ? (
              <div className="hint">加载中…</div>
            ) : (
              <>
                <div className="hint">
                  数据范围：<b>{DATA_SCOPE_LABEL[permVo.dataScope] ?? permVo.dataScope}</b>　·　
                  持有角色：{permVo.roles.map((r) => r.name).join('、') || '无'}
                </div>
                <div style={{ marginTop: 8 }}>
                  <b style={{ fontSize: 13 }}>并集（{permVo.permissions.length} 项）</b>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {permVo.permissions.map((p) => <span className="tag t-teal" key={p}>{p}</span>)}
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <b style={{ fontSize: 13 }}>按角色展开</b>
                  {permVo.byRole.map((r) => (
                    <div key={r.code} style={{ marginTop: 6 }}>
                      <div className="muted" style={{ fontSize: 12 }}>{r.name}（{r.code}）· {r.permissions.length} 项</div>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                        {r.permissions.map((p) => <span className="tag t-gray" key={p}>{p}</span>)}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={closeAll}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：批量授权 —— */}
      {bulkOpen && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <h3>批量授权（{selected.length} 人）</h3>
            <div className="field">
              <label>模式</label>
              {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
              <SelectMenu ariaLabel="批量授权模式"
                value={bulkMode}
                onChange={(v) => setBulkMode(v as 'replace' | 'merge')}
                options={[
                  { value: 'replace', label: '全量替换（以所选角色为准）' },
                  { value: 'merge', label: '追加（保留原有角色）' },
                ]} />
            </div>
            <div className="field">
              <label>角色（至少一个）</label>
              <div className="row">
                {roleOptions.map((r) => (
                  <label key={r.code} className="row tight" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={bulkRoles.includes(r.code)}
                      onChange={() => toggle(bulkRoles, r.code, setBulkRoles)} />
                    {r.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="hint">为防误操作，系统不会把当前登录管理员自己的管理员角色移除（该账号会被跳过并在结果中提示）。</div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || bulkRoles.length === 0}
                onClick={() => void run(async () => {
                  const r = await api.bulkSetRoles(selected, bulkRoles, bulkMode);
                  setNotice(`已更新 ${r.updated} 人${r.skipped.length ? `，跳过 ${r.skipped.length} 人` : ''}`);
                  setSelected([]);
                  closeAll();
                })}>确认授权</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：按部门批量授权（v3.58 组织维度） —— */}
      {deptBulkOpen && deptFilter && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
            <h3>按部门批量授权：{deptFilter}</h3>
            <div className="note">
              以「部门」为粒度整体追加角色（merge 模式，保留每人原有角色）。适用于组织调整、新线开线时的一次性赋权。
            </div>
            <div className="field">
              <label>角色（至少一个）</label>
              <div className="row">
                {roleOptions.map((r) => (
                  <label key={r.code} className="row tight" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={deptBulkRoles.includes(r.code)}
                      onChange={() => toggle(deptBulkRoles, r.code, setDeptBulkRoles)} />
                    {r.name}
                  </label>
                ))}
              </div>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || deptBulkRoles.length === 0}
                onClick={() => void run(async () => {
                  const r = await api.bulkSetRolesByDepartment(deptFilter, deptBulkRoles, 'merge');
                  setNotice(`已为部门「${deptFilter}」更新 ${r.updated} 人${r.skipped.length ? `，跳过 ${r.skipped.length} 人` : ''}`);
                  closeAll();
                })}>确认授权</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：停用自己（二次确认，后端要求 confirmSelf） —— */}
      {selfDisableTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>停用当前登录账号：{selfDisableTarget.username}</h3>
            <div className="law">
              这是<b>你本人正在使用的账号</b>。停用后你会立即被登出，且若系统内没有其他具备用户/角色管理权限的
              在用账号，本次操作会被后端拒绝。确认继续？
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn danger" disabled={busy}
                onClick={() => void run(async () => {
                  await api.updateUser(selfDisableTarget.userId, { status: 'disabled', confirmSelf: 'true' });
                  setNotice(`已停用 ${selfDisableTarget.username}，请由其他管理员恢复`);
                  closeAll();
                })}>确认停用本人</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：审批（批准赋角色） —— */}
      {approveTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>审批通过：{approveTarget.username}</h3>
            <div className="note">审批后账号立即生效。请按岗位分配角色（至少一个，无角色账号看不到任何数据）。</div>
            <div className="field">
              <label>角色</label>
              <div className="row">
                {roleOptions.map((r) => (
                  <label key={r.code} className="row tight" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={approveRoles.includes(r.code)}
                      onChange={() => toggle(approveRoles, r.code, setApproveRoles)} />
                    {r.name}
                  </label>
                ))}
              </div>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || approveRoles.length === 0}
                onClick={() => void run(async () => {
                  await api.approveUser(approveTarget.userId, approveRoles);
                  setNotice(`已批准 ${approveTarget.username}`);
                  closeAll();
                })}>批准并分配角色</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：驳回 —— */}
      {rejectTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>驳回注册申请：{rejectTarget.username}</h3>
            <div className="field">
              <label>驳回理由（选填，记入审计）</label>
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="如：非本部人员" />
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn danger" disabled={busy}
                onClick={() => void run(async () => {
                  await api.rejectUser(rejectTarget.userId, rejectReason.trim() || undefined);
                  setNotice(`已驳回 ${rejectTarget.username}`);
                  closeAll();
                })}>确认驳回</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：角色维护 —— */}
      {rolesTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>角色维护：{rolesTarget.username}</h3>
            <div className="field">
              <label>角色（全量替换，至少一个）</label>
              <div className="row">
                {roleOptions.map((r) => (
                  <label key={r.code} className="row tight" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={rolesSel.includes(r.code)}
                      onChange={() => toggle(rolesSel, r.code, setRolesSel)} />
                    {r.name}
                  </label>
                ))}
              </div>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={busy || rolesSel.length === 0}
                onClick={() => void run(async () => {
                  await api.setUserRoles(rolesTarget.userId, rolesSel);
                  setNotice(`已更新 ${rolesTarget.username} 的角色`);
                  closeAll();
                })}>保存</button>
              <button className="btn" onClick={closeAll}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* —— 弹窗：代置临时口令（一次性明文） —— */}
      {tempPwdTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>代置临时口令：{tempPwdTarget.username}</h3>
            {!tempPwdResult ? (
              <>
                <div className="law">
                  将生成 12 位随机临时口令，<b>仅本次展示一次</b>，请立即复制并通过可信通道告知用户。
                  用户下次登录必须修改密码，且其全部会话将被吊销。
                </div>
                {error && <div className="error-banner">{error}</div>}
                <div className="row">
                  <button className="btn danger" disabled={busy}
                    onClick={() => void run(async () => {
                      const r = await api.adminResetPassword(tempPwdTarget.userId);
                      setTempPwdResult(r.tempPassword);
                    })}>确认生成</button>
                  <button className="btn" onClick={closeAll}>取消</button>
                </div>
              </>
            ) : (
              <>
                <div className="ok">
                  临时口令（仅此一次，关闭后不可再查）：<br />
                  <b style={{ fontSize: 18, letterSpacing: 1 }}>{tempPwdResult}</b>
                </div>
                <div className="row">
                  <button className="btn primary" onClick={() => { void navigator.clipboard?.writeText(tempPwdResult); setNotice('已复制到剪贴板'); }}>复制</button>
                  <button className="btn" onClick={closeAll}>关闭</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* —— 弹窗：下发重置码（一次性明文） —— */}
      {codeTarget && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3>下发重置码：{codeTarget.username}</h3>
            {!codeResult ? (
              <>
                <div className="note">
                  将生成 6 位重置码，<b>仅本次展示一次</b>，请立即复制并电话/企业微信告知用户（30 分钟内有效，输错 5 次作废）。
                </div>
                {error && <div className="error-banner">{error}</div>}
                <div className="row">
                  <button className="btn primary" disabled={busy}
                    onClick={() => void run(async () => {
                      const r = await api.adminIssueResetCode(codeTarget.userId);
                      setCodeResult(r);
                    })}>生成重置码</button>
                  <button className="btn" onClick={closeAll}>取消</button>
                </div>
              </>
            ) : (
              <>
                <div className="ok">
                  重置码（仅此一次）：<b style={{ fontSize: 22, letterSpacing: 3 }}>{codeResult.code}</b><br />
                  <span className="muted">有效期至 {new Date(codeResult.expiresAt).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
                <div className="row">
                  <button className="btn primary" onClick={() => { void navigator.clipboard?.writeText(codeResult.code); setNotice('已复制到剪贴板'); }}>复制</button>
                  <button className="btn" onClick={closeAll}>关闭</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
