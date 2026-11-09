import { useEffect, useState } from 'react';
import { api, type AuthConfigVo } from '../api';
import { useAuth } from '../auth';

/** 装饰性仪表：IE 工时研究主题（测速表 + 节拍刻度） */
function DialBadge() {
  const ticks = Array.from({ length: 36 }, (_, i) => i);
  return (
    <svg className="la-dial" viewBox="0 0 240 150" fill="none" aria-hidden>
      <path d="M16 128 A104 104 0 0 1 224 128" stroke="rgba(233,237,240,.26)" strokeWidth="1.4" />
      {ticks.map((i) => {
        const a = Math.PI - (i / 35) * Math.PI;
        const long = i % 5 === 0;
        const r1 = long ? 82 : 92;
        return (
          <line
            key={i}
            x1={120 + Math.cos(a) * r1} y1={128 - Math.sin(a) * r1}
            x2={120 + Math.cos(a) * 104} y2={128 - Math.sin(a) * 104}
            stroke={long ? 'rgba(233,237,240,.55)' : 'rgba(233,237,240,.24)'} strokeWidth={long ? 1.6 : 1}
          />
        );
      })}
      <path d="M16 128 A104 104 0 0 1 224 128" stroke="rgba(176,112,60,.85)" strokeWidth="3"
        strokeDasharray="196 999" strokeLinecap="round" />
      <line x1="120" y1="128" x2="186" y2="88" stroke="#E5B98D" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="120" cy="128" r="6" fill="#1E272D" stroke="#E5B98D" strokeWidth="2" />
      <text x="120" y="150" textAnchor="middle" fill="rgba(233,237,240,.45)"
        fontFamily="IBM Plex Mono, Consolas, monospace" fontSize="10" letterSpacing="2.4">
        TAKT · CT · BALANCE
      </text>
    </svg>
  );
}

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

/** 登录页（/auth/login 公开接口；种子账号首次登录强制改密） */
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
      <div className="login-shell">
        {/* 左：铭牌 / 能力概览 */}
        <aside className="login-aside">
          <div className="la-head">
            <span className="brand-mark">IE</span>
            <div className="la-word">
              IE改善效率平台
              <small>Industrial Engineering Platform</small>
            </div>
          </div>

          <DialBadge />

          <ul className="la-points">
            <li><b>01</b><span>动作分解 · 19 类动素 VA / RNVA / NVA 三分法，视频帧级打点</span></li>
            <li><b>02</b><span>浪费识别 · 规则引擎出数、LLM 出建议、人工复核（三层 AI）</span></li>
            <li><b>03</b><span>改善闭环 · 建议 → 实施 → 验证 → 收益测算，全程留痕可追溯</span></li>
          </ul>

          <div className="la-foot">
            v3.56 · RBAC + ACL 双层权限 · 行级数据可见范围
          </div>
        </aside>

        {/* 右：作业单表单 */}
        <form className="login-card" onSubmit={submit}>
          <div>
            <div className="login-eyebrow">操作员登录 / Operator Sign-in</div>
            <div className="login-brand">
              登录作业台
              <small>账号由管理员统一开通，登录后可查看授权范围内的工位分析</small>
            </div>
          </div>

          {/* 统一身份入口：仅在后端开关开启时展示；关闭时页面与改造前完全一致 */}
          {ssoOn && (
            <div className="sso-entry">
              <button
                type="button"
                className="btn sso-btn"
                onClick={() => { window.location.href = api.oidcLoginUrl(); }}
              >
                <span className="sso-mark" aria-hidden>SSO</span>
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
                <button className={`btn primary login-submit${busy ? ' login-busy' : ''}`} type="submit" disabled={busy}>
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

          <ul className="login-rules">
            <li>本地账号连续输错 5 次将锁定 15 分钟；统一身份账号由 Keycloak 策略控制</li>
            <li>本地账号首次登录必须修改初始密码（至少 8 位，含字母和数字）；统一身份账号不强制本地改密</li>
            <li>数据可见范围由角色与行级授权共同决定，越权访问会被拦截并留痕</li>
          </ul>

          <div className="login-hint">
            遇到问题请联系本单位 IE 管理员或平台管理员。
          </div>
        </form>
      </div>
    </div>
  );
}
