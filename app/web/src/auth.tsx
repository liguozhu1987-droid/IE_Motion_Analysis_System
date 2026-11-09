import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  api, setTokens, clearTokens, getRefreshToken, AUTH_LOST_EVENT,
  type AuthUserVo,
} from './api';

/**
 * 认证上下文：启动引导（refresh token → /me）、登录/登出/改密、权限判定。
 * 会话失效（401 刷新失败）由 api.ts 广播 auth:lost 事件 → 这里清空用户跳登录。
 */
interface AuthState {
  user: AuthUserVo | null;
  booting: boolean;
  login: (username: string, password: string) => Promise<{ mustChangePwd: boolean; permissions: string[] }>;
  /** v3.57 统一身份回调：用一次性码（OTK）兑换本地登录态并落地当前用户 */
  completeSsoLogin: (otk: string) => Promise<{ mustChangePwd: boolean; permissions: string[] }>;
  logout: () => Promise<void>;
  changePassword: (oldPwd: string, newPwd: string) => Promise<void>;
  /** 单权限判定；roles 含 sys_admin 时后端已下发全量 permissions，无需前端特判 */
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUserVo | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let alive = true;
    api.bootstrap()
      .then((u) => { if (alive) setUser(u); })
      .catch(() => { if (alive) setUser(null); })
      .finally(() => { if (alive) setBooting(false); });
    const onLost = () => setUser(null);
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => { alive = false; window.removeEventListener(AUTH_LOST_EVENT, onLost); };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    setTokens(res.accessToken, res.refreshToken);
    const me = await api.me();
    setUser(me);
    // permissions 随返回值透出：登录成功瞬间的落地分流用（此时 can() 仍是旧闭包）
    return { mustChangePwd: res.mustChangePwd || me.mustChangePwd, permissions: me.permissions };
  }, []);

  const completeSsoLogin = useCallback(async (otk: string) => {
    /* OTK 60 秒单次有效：兑换失败（过期/重复）交给回调页展示，不做静默重试 */
    const res = await api.oidcExchange(otk);
    setTokens(res.accessToken, res.refreshToken);
    const me = await api.me();
    setUser(me);
    return { mustChangePwd: res.mustChangePwd || me.mustChangePwd, permissions: me.permissions };
  }, []);

  const logout = useCallback(async () => {
    const rt = getRefreshToken();
    try { if (rt) await api.logout(rt); } catch { /* 网络异常也以本地清理为准 */ }
    clearTokens();
    setUser(null);
  }, []);

  const changePassword = useCallback(async (oldPwd: string, newPwd: string) => {
    await api.changePassword(oldPwd, newPwd);
    const me = await api.me(); // mustChangePwd 已置 0，拉新态解除强制改密
    setUser(me);
  }, []);

  const can = useCallback((permission: string) => Boolean(user?.permissions.includes(permission)), [user]);
  const canAny = useCallback(
    (...permissions: string[]) => permissions.some((p) => Boolean(user?.permissions.includes(p))),
    [user],
  );

  return (
    <AuthContext.Provider value={{ user, booting, login, completeSsoLogin, logout, changePassword, can, canAny }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
