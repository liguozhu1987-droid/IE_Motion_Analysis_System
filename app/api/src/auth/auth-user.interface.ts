/**
 * 个人数据范围（行级，t_user.data_scope）：
 *   own=仅本人相关（我建立的 + 共享给我的）｜ line=本人负责产线 ｜ tenant=本租户 ｜ all=全集团
 * v3.55 起真正参与可见性判定（此前为空转字段）。
 */
export type DataScope = 'own' | 'line' | 'tenant' | 'all';

export interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
  tenantId: string;
  roles: string[];
  permissions: Set<string>;
  /** 首次登录强制改密标记（前端据此拦截全站路由直到改密完成） */
  mustChangePwd: boolean;
  /** 个人数据范围（行级可见性；v3.55 激活） */
  dataScope: DataScope;
  /** 工号（统一身份关联键；本地建号可为空） */
  employeeNo?: string | null;
  /** 账号来源：local=本地建号 / oidc=统一身份自动建档或已绑定 SSO 工号 */
  authSource?: 'local' | 'oidc';
}

export interface AuthedRequest {
  user?: AuthUser;
  /** 本次会话的认证来源（来自 JWT 的 src 声明；本地密码登录=local，SSO=oidc） */
  authSource?: 'local' | 'oidc';
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  path?: string;
  method?: string;
  body?: any;
}
