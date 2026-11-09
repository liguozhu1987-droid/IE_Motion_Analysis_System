import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth';

/** 行级数据可见范围（v3.55 起后端真正生效，此处只做展示） */
const SCOPE_LABEL: Record<string, { text: string; tip: string }> = {
  own: { text: '仅本人', tip: '只能看自己建立的、以及被共享给你的工位' },
  line: { text: '本产线', tip: '本人负责产线上的全部工位' },
  tenant: { text: '本租户', tip: '本公司（租户）内全部工位' },
  all: { text: '全集团', tip: '跨租户全部工位' },
};
/** 全权角色（sys_admin/ie_admin）：服务端不看 data_scope，实际范围即全租户 */
const FULL_SCOPE = { text: '全集团', tip: '管理员全权角色：不受数据范围限制，可见全部工位' };

/** 权限码前缀 → 中文模块名（用于权限浮层分组，不参与任何判定） */
const MODULE_LABEL: Record<string, string> = {
  station: '工位与对象',
  element: '动素分解',
  suggestion: '改善建议',
  analysis: '产线分析',
  compare: '版本对比',
  rule: '规则与标准',
  settings: '系统设置',
  user: '用户与角色',
  group: '综合看板',
  tenant: '租户',
  ai: 'AI 能力',
  auth: '认证',
  audit: '审计日志',
  video: '视频资产',
};

const groupPermissions = (perms: string[]) => {
  const map = new Map<string, string[]>();
  for (const p of perms) {
    const key = p.includes(':') ? p.split(':')[0] : p;
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, label: MODULE_LABEL[key] ?? key, list: list.sort() }))
    .sort((a, b) => b.list.length - a.list.length);
};

/**
 * 顶栏用户区（v3.56）：头像 + 姓名 + 角色/可见范围徽标 → 点击展开权限浮层。
 * 只展示，不判定：所有权限判定仍以服务端为准（can() 读后端下发的 permissions）。
 */
export default function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const scope = user.fullAccess ? FULL_SCOPE : (SCOPE_LABEL[user.dataScope ?? 'own'] ?? SCOPE_LABEL.own);
  const initial = (user.displayName || user.username || '?').trim().slice(0, 1).toUpperCase();
  const groups = useMemo(() => groupPermissions(user.permissions), [user.permissions]);

  return (
    <div className={`userchip${open ? ' uc-open' : ''}`} ref={ref}>
      <button type="button" className="uc-trigger" onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog" aria-expanded={open} title="查看我的角色与权限">
        <span className="uc-avatar">{initial}</span>
        <span className="uc-meta">
          <span className="uc-name">{user.displayName || user.username}</span>
          <span className="uc-sub">
            <span className="uc-scope">{scope.text}</span>
          </span>
        </span>
        <span className="uc-caret" aria-hidden>▾</span>
      </button>
      <button className="userchip-logout" onClick={() => void logout()}>退出</button>

      {open && (
        <div className="uc-pop" role="dialog" aria-label="我的权限">
          <div className="uc-pop-head">
            <h4>{user.displayName || user.username}</h4>
            <div className="uc-pop-id">{user.username} · {user.roles.join(' / ') || '—'}</div>
          </div>

          <dl className="uc-kv">
            <dt>数据范围</dt>
            <dd>
              <b>{scope.text}</b>
              <div className="muted" style={{ fontSize: 11.5 }}>{scope.tip}</div>
            </dd>
            <dt>权限项</dt>
            <dd>{user.permissions.length} 项（{groups.length} 个模块）</dd>
          </dl>

          {groups.map((g) => (
            <div className="uc-pop-sec" key={g.key}>
              <span>{g.label} · {g.list.length}</span>
              <div className="uc-perm-grid">
                {g.list.map((p) => <span className="uc-perm" key={p}>{p}</span>)}
              </div>
            </div>
          ))}

          <div className="uc-pop-foot">
            权限由角色决定，数据范围决定同公司内你能看到谁的工位；越权访问由服务端拦截。
            需要调整请联系管理员。
          </div>
        </div>
      )}
    </div>
  );
}
