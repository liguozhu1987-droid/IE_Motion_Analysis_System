import { useState } from 'react';
import { useAuth } from '../auth';

/**
 * 强制改密页（must_change_pwd=1 时全站唯一可访问页面）。
 * 规则与服务端一致：≥8 位且包含字母和数字（服务端 auth.service.changePassword 同口径）。
 */
export default function ChangePasswordPage({ forced }: { forced: boolean }) {
  const { changePassword, user } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clientIssue =
    newPassword && newPassword.length < 8 ? '新密码至少 8 位'
    : newPassword && !/[a-zA-Z]/.test(newPassword) ? '新密码须包含字母'
    : newPassword && !/\d/.test(newPassword) ? '新密码须包含数字'
    : confirm && newPassword !== confirm ? '两次输入的新密码不一致'
    : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (clientIssue) { setError(clientIssue); return; }
    setBusy(true); setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      if (forced) window.location.hash = '#/stations';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          修改密码
          <small>{forced ? '首次登录必须修改初始密码，完成后进入系统' : '修改当前账号密码'}</small>
        </div>
        {/* 账号提示：强制改密时用户可能不知道自己在给哪个账号设密码 */}
        {user?.username && (
          <div className="field" style={{ marginBottom: 0 }}>
            <label>当前账号</label>
            <input value={user.username} readOnly style={{ background: 'var(--bg)', color: 'var(--ink2)' }} />
          </div>
        )}
        <div className="field">
          <label>原密码</label>
          <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoFocus autoComplete="current-password" />
        </div>
        <div className="field">
          <label>新密码（≥8 位，含字母和数字）</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="field">
          <label>确认新密码</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
        {(error || clientIssue) && <div className="error-banner">{error ?? clientIssue}</div>}
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? '提交中…' : '确认修改'}
        </button>
        {!forced && <div className="login-hint">修改成功后当前会话保持登录。</div>}
      </form>
    </div>
  );
}
