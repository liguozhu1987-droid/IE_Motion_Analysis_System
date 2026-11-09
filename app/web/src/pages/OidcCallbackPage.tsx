import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

/** 回调错误码 → 运营可读文案（与后端 SsoRejectedError.code 一一对应） */
const ERROR_TEXT: Record<string, string> = {
  state_invalid: '登录请求已失效（可能超时、或已在另一个标签页完成）。请重新发起统一身份登录。',
  oidc_unavailable: '统一身份服务暂时不可用。请稍后重试，或改用本地账号登录。',
  sso_denied: '你在统一身份服务上取消了本次登录。',
  code_missing: '回调缺少授权码。请重新发起统一身份登录。',
  id_token_invalid: '统一身份返回的令牌校验未通过（nonce/签名/有效期）。请重新登录。',
  group_denied: '你的统一账号未加入本系统准入组（app-ie）。请联系管理员将你加入该组后再登录。',
  central_not_found: '中央人员库中没有你的账号。请联系管理员完成建档后重试。',
  account_disabled: '你的账号已停用（离职或管理员停用）。如有疑问请联系管理员。',
  account_inactive: '你的本地账号当前不可用（待审批/已驳回/已停用）。请联系管理员。',
  employee_conflict: '该用户名已绑定其它工号，存在账号冲突。请联系管理员核对映射后重试。',
  account_not_provisioned: '你的账号尚未在本地建档，且系统未开启自动建档。请联系管理员开通。',
  username_invalid: '自动建档失败：统一账号名不符合本系统命名规则。请联系管理员处理。',
  provision_failed: '自动建档失败（角色或数据写入异常）。请联系管理员处理。',
  oidc_callback_failed: '统一身份登录未能完成。请稍后重试，或改用本地账号登录。',
};

export default function OidcCallbackPage() {
  const { completeSsoLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    document.title = '统一身份登录 · IE改善效率平台';
    if (started.current) return;
    started.current = true;

    const raw = window.location.hash;
    const qi = raw.indexOf('?');
    const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    const code = params.get('error') ?? '';
    const otk = params.get('otk') ?? '';

    if (code) { setError(ERROR_TEXT[code] ?? `统一身份登录失败（${code}）`); return; }
    if (!otk) { setError('回调缺少一次性登录码。请重新发起统一身份登录。'); return; }

    void (async () => {
      try {
        /* OTK 60 秒单次有效：这里是一次性兑换，失败不再重试（重试只会拿到同一个已消费的码） */
        const result = await completeSsoLogin(otk);
        const home = result.permissions.includes('group:read') ? '#/dashboard' : '#/stations';
        window.location.replace(home);
      } catch (e: any) {
        setError(e?.detail ?? e?.message ?? '登录态兑换失败。请重新发起统一身份登录。');
      }
    })();
  }, [completeSsoLogin]);

  return (
    <div className="login-wrap">
      <div className="login-card sso-callback-card">
        <div className="login-eyebrow">统一身份认证 / SSO Callback</div>
        {error ? (
          <>
            <div className="login-brand">
              未能完成登录
              <small>{error}</small>
            </div>
            <div className="login-actions">
              <a className="btn primary login-submit" href="#/login">返回登录页</a>
            </div>
            <div className="login-hint">
              若统一身份入口持续失败，可先使用本地账号登录；管理员可在「用户管理」中核对准入组与人员建档。
            </div>
          </>
        ) : (
          <>
            <div className="login-brand">
              正在完成统一身份登录
              <small>正在校验令牌并建立本地会话，请稍候…</small>
            </div>
            <div className="login-hint">若长时间无响应，请返回登录页重试。</div>
          </>
        )}
      </div>
    </div>
  );
}
