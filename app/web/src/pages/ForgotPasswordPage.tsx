import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * 忘记密码页（公开路由 #/forgot-password，helpdesk 模式）：
 *  第一步：输入用户名 → 申请重置码（通用应答，不泄露账号是否存在）；
 *          重置码由管理员在用户管理页生成并通过电话/企业微信等可信通道告知；
 *  第二步：输入 6 位码 + 新密码 → 重置成功（全部会话吊销，需重新登录）。
 */
export default function ForgotPasswordPage() {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { document.title = '忘记密码 · IE改善效率平台'; }, []);

  const apply = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim()) { setError('请输入用户名'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.forgotPassword(username.trim());
      setNotice(r.message);
      setStep(2);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setError('新密码至少 8 位且包含字母和数字'); return;
    }
    setBusy(true); setError(null);
    try {
      await api.resetPassword(username.trim(), code.trim(), password);
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
            重置成功
            <small>请使用新密码登录</small>
          </div>
          <div className="ok">密码已重置，所有已登录会话已吊销，请重新登录。</div>
          <a className="btn primary" href="#/login" style={{ width: '100%', justifyContent: 'center' }}>返回登录</a>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={step === 1 ? apply : reset}>
        <div className="login-brand">
          忘记密码
          <small>重置码由管理员人工送达（30 分钟内有效）</small>
        </div>

        {step === 1 ? (
          <>
            <div className="field">
              <label>用户名</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="如：ie1" autoFocus autoComplete="username" />
            </div>
            {notice && <div className="success-banner">{notice}</div>}
            {error && <div className="error-banner">{error}</div>}
            <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? '提交中…' : '申请重置码'}
            </button>
            <div className="login-hint">
              本平台未接入邮件服务，重置码由管理员生成后通过电话/企业微信告知。<br />
              如管理员可代为重置，也可直接在用户管理页生成临时口令。
            </div>
          </>
        ) : (
          <>
            <div className="note">
              重置申请已记录。请向管理员获取 6 位重置码后填写下方表单；
              连续输错 5 次重置码作废，需重新申请。
            </div>
            <div className="field">
              <label>用户名</label>
              <input value={username} readOnly />
            </div>
            <div className="field">
              <label>6 位重置码</label>
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="如：123456" autoFocus inputMode="numeric" />
            </div>
            <div className="field">
              <label>新密码</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位，含字母和数字" autoComplete="new-password" />
            </div>
            <div className="field">
              <label>确认新密码</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输一次" autoComplete="new-password" />
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy} style={{ flex: 1, justifyContent: 'center' }}>
                {busy ? '重置中…' : '重 置'}
              </button>
              <button className="btn" type="button" onClick={() => { setStep(1); setNotice(null); setError(null); }}>上一步</button>
            </div>
          </>
        )}
        <div className="login-hint">
          <a href="#/login">返回登录</a>
        </div>
      </form>
    </div>
  );
}
