import { useEffect, useState } from 'react';
import { api, type AuthConfigVo } from '../api';
import { useAuth } from '../auth';

const IconUser = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
const IconLock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

/**
 * 登录页（/auth/login 公开接口；种子账号首次登录强制改密）。
 * 视觉按《MSIA 风格登录页技术交底书》实现：本地背景图 + 深蓝蒙层 + 居中玻璃卡片。
 * 认证逻辑、OIDC/本地双轨开关、注册/找回密码、错误处理均保持原实现不变。
 */
export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* 双轨开关：配置拉取失败时按「本地登录可用、SSO 不展示」兜底，绝不因 SSO 故障挡住本地登录 */
  const [cfg, setCfg] = useState<AuthConfigVo | null>(null);
  const ssoOn = Boolean(cfg?.oidcEnabled);
  const localOn = cfg === null ? true : cfg.localLoginEnabled;

  useEffect(() => { document.title = '登录 · IE改善效率平台'; }, []);
  useEffect(() => {
    let alive = true;
    api.authConfig().then((v) => { if (alive) setCfg(v); }).catch(() => { if (alive) setCfg(null); });
    return () => { alive = false; };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!localOn) return;
    if (!username.trim() || !password) { setError('请输入用户名和密码'); return; }
    setBusy(true); setError(null);
    try {
      const res = await login(username.trim(), password);
      // 成功：mustChangePwd 由 App 路由拦截到改密页；
      // 否则按权限分流——有 group:read 落集团驾驶舱，否则落产线驾驶舱（v3.3）
      if (!window.location.hash || window.location.hash === '#/login') {
        window.location.hash = res.permissions.includes('group:read') ? '#/dashboard' : '#/stations';
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-glow" aria-hidden />

      <form className="login-card login-card--auth" onSubmit={submit}>
        <div className="login-brand-block">
          <div className="login-logo">
            <img src="/login-logo.png" alt="Inalfa Roof Systems" />
          </div>
          <div className="login-brand">
            IE 改善效率平台
            <small>Industrial Engineering Improvement Platform</small>
          </div>
          <div className="login-prompt">操作员登录 / Operator Sign-in</div>
          <p className="login-subprompt">账号由管理员统一开通，登录后可查看授权范围内的工位分析</p>
        </div>

        {/* 统一身份入口：仅在后端开关开启时展示；关闭时页面与改造前完全一致 */}
        {ssoOn && (
          <div className="sso-entry">
            <button
              type="button"
              className="sso-btn"
              onClick={() => { window.location.href = api.oidcLoginUrl(); }}
            >
              统一身份登录
            </button>
            <span className="sso-note">使用企业统一账号登录；本地账号与统一账号双轨并存</span>
          </div>
        )}

        {ssoOn && localOn && <div className="sso-divider"><span>或使用本地账号</span></div>}

        {localOn ? (
          <>
            <div className="field">
              <label>用户名</label>
              <span className="lf-wrap">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="如：ie1"
                  autoFocus
                  autoComplete="username"
                />
                <IconUser />
              </span>
            </div>

            <div className="field">
              <label>密码</label>
              <span className="lf-wrap">
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="初始口令 123456"
                  autoComplete="current-password"
                />
                <IconLock />
                <button type="button" className="login-peek" onClick={() => setShowPwd((v) => !v)}
                  aria-label={showPwd ? '隐藏密码' : '显示密码'}>
                  {showPwd ? '隐藏' : '显示'}
                </button>
              </span>
            </div>

            {error && <div className="error-banner">{error}</div>}

            <div className="login-actions">
              <button
                className={`btn login-submit ${ssoOn ? 'login-submit--secondary' : 'login-submit--primary'}${busy ? ' login-busy' : ''}`}
                type="submit"
                disabled={busy}
              >
                {busy ? '校验中' : '登 录'}
              </button>
              {(cfg?.registrationEnabled || cfg?.passwordSelfServiceEnabled !== false) && (
                <div className="login-links">
                  {cfg?.registrationEnabled && <a href="#/register">注册新账号</a>}
                  {cfg?.registrationEnabled && cfg?.passwordSelfServiceEnabled !== false && <span className="sep">·</span>}
                  {cfg?.passwordSelfServiceEnabled !== false && <a href="#/forgot-password">忘记密码</a>}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="login-hint">本地账号登录已关闭，请使用上方「统一身份登录」。</div>
        )}

        <details className="login-notice">
          <summary>登录须知</summary>
          <ul className="login-rules">
            <li>本地账号连续输错 5 次将锁定 15 分钟；统一身份账号由 Keycloak 策略控制</li>
            <li>本地账号首次登录必须修改初始密码（至少 8 位，含字母和数字）；统一身份账号不强制本地改密</li>
            <li>数据可见范围由角色与行级授权共同决定，越权访问会被拦截并留痕</li>
          </ul>
        </details>

        <div className="login-hint login-contact">
          遇到问题请联系本单位 IE 管理员或平台管理员。
        </div>
      </form>
    </div>
  );
}
