import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 自助注册页（公开路由 #/register）。
 * 注册成功进入 pending 待审批态（无角色看不到任何数据），管理员审批赋角色后生效。
 */
export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { document.title = '注册 · IE改善效率平台'; }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) { setError('请输入用户名和密码'); return; }
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setError('密码至少 8 位且包含字母和数字'); return;
    }
    setBusy(true); setError(null);
    try {
      await api.register({
        username: username.trim(), password,
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
      });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-brand">
            注册成功
            <small>账号已进入待审批队列</small>
          </div>
          <div className="ok">
            注册成功！账号状态为<b>待审批</b>，管理员审批并分配角色后才能登录使用。
            审批结果请联系系统管理员确认。
          </div>
          <a className="btn primary" href="#/login" style={{ width: '100%', justifyContent: 'center' }}>返回登录</a>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          注册新账号
          <small>提交后需管理员审批赋角色</small>
        </div>
        <div className="field">
          <label>用户名（登录名，全局唯一）</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)}
            placeholder="3-32 位字母、数字、._-" autoFocus autoComplete="username" />
        </div>
        <div className="field">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位，含字母和数字" autoComplete="new-password" />
        </div>
        <div className="field">
          <label>确认密码</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            placeholder="再输一次" autoComplete="new-password" />
        </div>
        <div className="field">
          <label>显示名（选填）</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如：王工" />
        </div>
        <div className="field">
          <label>邮箱（选填，仅作联系备注）</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </div>
        {error && <div className="error-banner">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? '提交中…' : '注 册'}
        </button>
        <div className="login-hint">
          已有账号？<a href="#/login">直接登录</a><br />
          注册仅创建账号，权限由管理员按岗位分配
        </div>
      </form>
    </div>
  );
}
