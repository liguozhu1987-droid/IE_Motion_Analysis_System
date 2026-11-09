/**
 * API 客户端（v3.0 后端契约）。
 * 契约依据：NestJS app/api（见项目根 AGENT必读.md §5）。
 * 认证：access token 存内存（15min），refresh token 存 localStorage（7d，轮换）；
 *       401 → 单航班刷新 → 重放原请求；刷新失败 → 清理 + 广播 auth:lost 事件。
 * 错误信封（顶层透传）：{ title, status, detail, errors?, warnings?, code?, requires?, allowed?, hint?, request_id }
 */

/** video/ 模块（分片上传 XHR 链路）复用：与 request 的 401 单航班刷新重放对齐 */
export const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';
const REFRESH_KEY = 'ie_refresh_token';

/* ---------------- token 存取 ---------------- */

let accessToken: string | null = null;

export function getRefreshToken(): string | null {
  try { return localStorage.getItem(REFRESH_KEY); } catch { return null; }
}

export function setTokens(access: string, refresh?: string | null): void {
  accessToken = access;
  if (refresh) { try { localStorage.setItem(REFRESH_KEY, refresh); } catch { /* 隐私模式忽略 */ } }
}

export function clearTokens(): void {
  accessToken = null;
  try { localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ }
}

/** 刷新失败/会话失效广播（AuthContext 监听后跳登录页） */
export const AUTH_LOST_EVENT = 'auth:lost';
/** v3.28：access token 刷新成功广播——服务端视频地址里的 ?token= 随之过期，工作台据此换 URL */
export const AUTH_REFRESHED_EVENT = 'auth:refreshed';
function broadcastAuthLost(): void {
  window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT));
}

/* ---------------- 刷新（单航班） ---------------- */

let refreshInFlight: Promise<boolean> | null = null;

export async function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const rt = getRefreshToken();
    if (!rt) return false;
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) { clearTokens(); return false; }
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      setTokens(data.accessToken, data.refreshToken);
      window.dispatchEvent(new CustomEvent(AUTH_REFRESHED_EVENT));
      return true;
    } catch {
      return false;
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/* ---------------- 请求核心 ---------------- */

export class ApiError extends Error {
  status: number;
  payload: Record<string, unknown>;
  /** 业务附加字段（信封顶层透传，非 MVP 的 details 嵌套） */
  code?: string;
  hint?: string;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
  requires?: { type: string; message: string }[];
  allowed?: string[];

  constructor(status: number, payload: Record<string, unknown>) {
    super(String(payload?.detail ?? `请求失败（${status}）`));
    this.status = status;
    this.payload = payload;
    if (typeof payload.code === 'string') this.code = payload.code;
    if (typeof payload.hint === 'string') this.hint = payload.hint;
    if (Array.isArray(payload.errors)) this.errors = payload.errors as ValidationIssue[];
    if (Array.isArray(payload.warnings)) this.warnings = payload.warnings as ValidationIssue[];
    if (Array.isArray(payload.requires)) this.requires = payload.requires as { type: string; message: string }[];
    if (Array.isArray(payload.allowed)) this.allowed = payload.allowed as string[];
  }
}

export async function request<T>(path: string, options: RequestInit = {}, allowRetry = true): Promise<T> {
  /* 首屏 401 噪音消除：access token 只存内存，页面重载后首个业务请求必然先打一次 401
     再刷新重放，控制台留下红色噪音。发请求前若内存无 token 但 localStorage 有 refresh token，
     先单航班刷新拿到新 token 再发请求（登录/刷新接口自身不预刷，避免环）。 */
  if (!accessToken && allowRetry && !path.startsWith('/auth/') && getRefreshToken()) {
    if (!(await refreshTokens())) {
      clearTokens();
      broadcastAuthLost();
      throw new ApiError(401, { detail: '登录已过期，请重新登录' });
    }
  }
  // FormData 不能设 Content-Type（浏览器自带 boundary）；显式传的 headers 仍优先
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(!isForm && options.body ? { 'Content-Type': 'application/json' } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  // 401：刷新一次再重放（登录/刷新接口自身不重试，避免环）
  if (res.status === 401 && allowRetry && !path.startsWith('/auth/')) {
    if (await refreshTokens()) return request<T>(path, options, false);
    clearTokens();
    broadcastAuthLost();
    throw new ApiError(401, { detail: '登录已过期，请重新登录' });
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data ?? {});
  return data as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

/* ---------------- 类型（新后端契约） ---------------- */

export interface AuthUserVo {
  userId: string; username: string; displayName: string; tenantId: string;
  roles: string[]; permissions: string[]; mustChangePwd: boolean;
  /** v3.56 行级数据可见范围（后端 /me 下发；旧版本服务可能缺字段 → 前端回落 'own' 展示） */
  dataScope?: 'own' | 'line' | 'tenant' | 'all';
  /** v3.56 全权角色标记（sys_admin/ie_admin）：不看 data_scope，实际可见范围为全租户 */
  fullAccess?: boolean;
  /** v3.57 会话认证来源（OIDC 双轨；旧服务缺字段 → 按 local 展示） */
  authSource?: 'local' | 'oidc';
  /** v3.57 关联工号（本地账号可能为空） */
  ssoEmployeeNo?: string | null;
}

/** GET /auth/config：登录页开关（公开端点，不含任何密钥/issuer 细节） */
export interface AuthConfigVo {
  oidcEnabled: boolean;
  localLoginEnabled: boolean;
  registrationEnabled: boolean;
  passwordSelfServiceEnabled: boolean;
  /** 相对 API base 的登录跳转路径，如 /auth/oidc/login */
  oidcLoginPath: string;
}

/** 源视频保留期视图（GET /videos/assets） */
export interface VideoAssetView {
  file_name: string;
  tenant_id: string;
  owner_user_id: string;
  owner_username: string | null;
  created_at: string;
  retention_status: 'auto' | 'extended' | 'permanent' | string;
  retention_until: string | null;
  /** 距离到期天数（向上取整）；永久保留为 null */
  days_left: number | null;
  notified_at: string | null;
  notify_attempts: number;
  can_manage: boolean;
  play_url: string;
}
export interface LoginResult {
  accessToken: string; refreshToken: string; mustChangePwd: boolean;
  tokenType: string; expiresIn: number;
}

/** 工位实体（后端原样返回；统计字段由前端用线分析/建议接口补齐） */
export interface Station {
  station_id: string; line_id: string; name: string;
  ct: number | null; tt: number | null; version: number;
  updated_by: string | null; updated_at: string | null;
  created_by: string | null; created_at: string; tenant_id: string;
  /** v3.42 归属人 user_id（ACL 判定 + 同名徽标） */
  owner_user_id?: string | null;
  /** v3.42 归属人展示名（列表接口 enrich；可能缺省） */
  owner_name?: string | null;
  /** v3.43 AI 分解操作区 ROI（归一化 JSON 字符串；null=未标定用内置默认） */
  roi?: string | null;
  /** v3.44 P2-1 ROI 功能区子区（JSON 数组 [{"name","x","y","w","h"}] 相对 ROI；null=HOI 关闭） */
  roi_zones?: string | null;
  /** v3.44 P2-2 SOP 期望步骤序列（JSON 数组 [{"verb","object"}]；null=未配置） */
  sop_steps?: string | null;
}
export interface StationCollaborator {
  user_id: string; display_name: string | null; username: string | null;
  acl_role: 'editor' | 'viewer'; granted_by: string | null; granted_at: string;
}
export interface LineShare {
  line_id: string; grantee_user_id: string; acl_role: 'editor' | 'viewer';
  granted_at: string; display_name: string | null;
}
export interface ShareCandidate { user_id: string; username: string; display_name: string }
export interface StationVersion {
  version: number; element_count: number; ct: number; is_current: boolean; is_sealed: boolean;
}
export interface Element {
  element_id: string; tenant_id: string; station_id: string;
  seq: number; start_ms: number; dur_s: number;
  hand: string; type: string; desc: string; va_class: string;
  outlier_flag: number; outlier_reason: string | null; video_id: string | null;
  rating: number; allowance: number; std_time: number; bol_version: number;
  created_at: string;
  /** v3.47 双线隔离：要素来源溯源。AI 自动分解写入='ai_assisted'，手工分解='manual'。
   *  工作台回写必须原样带回，否则后端会兜底为 manual，导致 AI 成果静默降级。 */
  source?: 'manual' | 'ai_assisted';
}
export interface ValidationIssue {
  code: string; element_seq?: number | null; line?: number; message: string;
}
export interface SubmitResult {
  station_id: string; version: number; ct: number; element_count: number; warnings: ValidationIssue[];
}
export interface ValidateResult { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

export interface Metrics {
  ct: number; tt: number; tt_gap: number; element_count: number; va: number; rnva: number; nva: number;
  va_pct: number; rnva_pct: number; nva_pct: number; outlier_count: number; outlier_s: number;
}
export interface Waste {
  id: string; waste: string; level: 'element' | 'station'; element_ids: string[];
  seqs: number[]; involved_s: number; pct: number; evidence: string;
}
export interface Pending {
  element_id: string; seq: number; type: string; desc: string;
  va_effective: string; va_reason: string; rule_id: string | null;
}
export interface Outlier {
  element_id: string; seq: number; type: string; desc: string; dur_s: number; std_time: number; reason: string;
}
export interface HandBlock { element_id: string; seq: number; desc: string; type: string; va: string; start_ms: number; end_ms: number }
export interface Gap { start_ms: number; end_ms: number; dur_s: number }
export interface Hands { L: HandBlock[]; R: HandBlock[]; B: HandBlock[]; cycle_ms: number; idle: { L: Gap[]; R: Gap[]; both: Gap[] } }
export interface StationAnalysis {
  station: Station; elements: Element[]; metrics: Metrics; wastes: Waste[];
  pending: Pending[]; outliers: Outlier[]; hands: Hands;
  /**
   * v3.48 动作分析明细（与「Motion analysis_改善建议.xlsx · 动作分析-VA」同构）：
   * 每个生效要素一行——分类/浪费类型/改善方向全部规则口径（waste_triggers + ecrsa_map），
   * LLM 个性化内容在「浪费识别 / AI 建议」模块页呈现，不跨模块合并。
   */
  detail?: MotionDetailRow[];
  rule_versions: { va_rules: number; waste_triggers: number };
}
/** 动作分析明细行（v3.48）：seq/ST/作业内容/分类/浪费类型/改善方向 */
export interface MotionDetailRow {
  element_id: string; seq: number; type: string; desc: string;
  va_class: string; std_time: number;
  /** 命中该要素的浪费类型名（要素级 + 工位级聚合并集，可多个） */
  waste_types: string[];
  /** ecrsa_map 措施模板（按浪费类型去重，可多个） */
  directions: string[];
}
export interface LineRow {
  station_id: string; name: string; version: number;
  ct_s: number; tt_s: number; va_s: number; rnva_s: number; nva_s: number; va_pct: number;
  element_count: number; outlier_count: number; waste_count: number; is_bottleneck: boolean;
}
export interface LineAnalysis {
  line_id: string; tt_s: number; station_count: number; balance_rate: number; rows: LineRow[];
  bottleneck: { station_id: string; name: string; ct_s: number; tt_s: number; gap_s: number; va_pct: number; waste_count: number }[];
  totals: { ct_s: number; va_s: number; rnva_s: number; nva_s: number; outlier_count: number };
  rule_versions: { va_rules: number; waste_triggers: number };
  /** v3.3 产线元数据（t_line + t_tenant enrich；无记录时降级为 lineId/null） */
  line_name?: string; process_type?: string | null; product_type?: string | null;
  product_project?: string | null; region?: string | null; company?: string | null;
}

/* ---------------- 主数据：项目 / 产线（v3.7 新建分析对象向导） ---------------- */

export interface ProjectVo {
  project_id: string; name: string; customer: string; stage: string;
}
export interface LineLite {
  line_id: string; name: string;
  process_type: string | null; product_type: string | null;
  project_id: string; project_name: string | null;
  station_count: number;
}

/* ---------------- 导航层：租户内产线概览（v3.6） ---------------- */

export interface LineSummaryRow {
  line_id: string; line_name: string;
  process_type: string | null; product_type: string | null; product_project: string | null;
  station_count: number; decomposed_count: number; retested_count: number;
  balance_rate: number; va_pct: number; bottleneck_count: number; imp_pending: number;
  updated_at: string | null;
}
export interface LinesSummary {
  company: string; region: string | null; lines: LineSummaryRow[];
}

/* ---------------- 集团综合驾驶舱（v3.3） ---------------- */

export interface DashboardFilters {
  region?: string; company?: string; process?: string; product_type?: string; project?: string;
}
export interface DashboardLineRow {
  line_id: string; line_name: string; tenant_id: string; company: string; region: string;
  process_type: string; product_type: string; product_project: string;
  station_count: number; balance_rate: number; avg_va_pct: number;
  bottleneck_count: number; imp_pending: number; updated_at: string | null;
}
export interface DashboardKpis {
  region_count: number; company_count: number; line_count: number; station_count: number;
  avg_va_pct: number; avg_balance_rate: number; bottleneck_line_count: number;
  imp_pending: number; imp_done: number; imp_verified: number; est_save_s_total: number;
}
export interface DashboardSummary {
  scope: Record<string, string>;
  kpis: DashboardKpis;
  by_region: { region: string; company_count: number; line_count: number; station_count: number; avg_va_pct: number; imp_pending: number }[];
  by_company: { company: string; region: string; line_count: number; station_count: number; avg_va_pct: number; avg_balance_rate: number; imp_pending: number; imp_verified: number }[];
  by_process: { process_type: string; line_count: number; station_count: number; avg_va_pct: number }[];
  by_product: { product_type: string; line_count: number; station_count: number; avg_va_pct: number }[];
  by_project: { project_type: string; imp_count: number; est_save_s: number; pending: number; done: number; verified: number }[];
  lines: DashboardLineRow[];
  top_bottleneck_lines: DashboardLineRow[];
  due_soon: { imp_id: string; station_id: string; measure: string; project_type: string; est_save_s: number; due: string | null; line_id: string; line_name: string; company: string; region: string }[];
  rule_versions: { va_rules: string; waste_triggers: string };
}

export interface Candidate {
  mapping_id: string | null; waste_type: string; method: string; measure: string; element_ids: string[];
  evidence: string; est_save_s: number; difficulty: number; note?: string; manual?: boolean;
  priority: number; tier: string; raw_priority: number;
}
export interface SuggestResult {
  station_id: string; station_name: string; version: number; ct: number;
  candidates: Candidate[]; freq_configured: boolean; daily_output: number | null;
  note: string | null; rule_versions: { ecrsa_map: number };
}
export interface Improvement {
  imp_id: string; station_id: string; element_ids: string; waste_type: string; method: string; measure: string;
  est_save_s: number; priority: number; status: string; owner: string | null; due: string | null;
  before_ct: number | null; after_ct: number | null; created_at: string;
  station_name?: string; line_id?: string;
  /** v3.3 维度字段（/improvements 与 /dashboard/improvements 统一返回） */
  station_version?: number; project_type?: string; line_name?: string | null;
  process_type?: string | null; product_type?: string | null; product_project?: string | null;
  tenant_id?: string; company?: string | null; region?: string | null;
}
export interface AdoptPayload {
  candidates: Candidate[];
  confirmations?: { quality?: { name: string; date?: string }; ergonomics?: { name: string; date?: string } };
}
export interface SuggestionReport {
  header: { station_id: string; station_name: string; line_id: string; version: number; imp_id: string; generated_at: string; generated_by: string };
  problem: { waste_type: string; measure: string; involved: { seq: number; type: string; desc: string; std_time: number; va_class: string }[] };
  benefit: { est_save_s: number; annual_yuan: number | null; before_ct: number | null; after_ct: number | null; params_configured: boolean; formula: string };
  steps: string[]; status: string; signatures: string[];
}

export interface PairRow {
  prev: Element | null; curr: Element | null; quality: 'success' | 'partial' | 'unmatched';
  rule: string; delta_std: number; referenced?: boolean;
}
export interface CompareBenefit {
  saved_s_per_unit: number; daily_output: number; rate_yuan_per_hour: number; realization_rate: number;
  annual_yuan: number; formula: string; configured_by: string | null; configured_at: string | null;
}
export interface CompareResult {
  station: { station_id: string; name: string; line_id: string; tt_s: number };
  prev: { version: number; ct: number; metrics: Metrics; element_count: number };
  curr: { version: number; ct: number; metrics: Metrics; element_count: number };
  delta_ct: number; pairing_rate: number; pairs: PairRow[]; added: Element[]; removed: Element[];
  benefit: CompareBenefit | null; params_configured: boolean; warnings: string[];
}
export interface BenefitParamsLine {
  line_id: string; rate_yuan_per_hour: number; daily_output: number; land_rate: number;
  configured_by?: string; configured_at?: string;
}

/* ---------------- 规则库（设置中心，v3.4） ---------------- */

export interface RuleSnapshotEntry { version: string; source: 'db' | 'file' }
export interface RuleSetMeta {
  rule_set_id: string; code: string; version: string; is_active: number;
  created_by: string | null; created_at: string;
}
export interface RuleContent {
  code: string; version: string; source: 'db' | 'file'; content: Record<string, unknown>;
}
/** 规则代码 → 中文名与用途（前端展示用，与后端 RULE_CODES 对齐） */
export const RULE_META: Record<string, { name: string; desc: string }> = {
  va_rules: { name: 'VA 归类规则', desc: '10 类要素默认 VA/RNVA/NVA + 例外条件（首个命中生效）' },
  waste_triggers: { name: '浪费触发规则', desc: '6 类浪费的要素级/工位级触发条件（DSL 表达式）' },
  ecrsa_map: { name: 'ECRSA 改善映射', desc: '浪费类型 → 改善手法（E/C/R/S/A）→ 措施模板与节省估算' },
  redline_keywords: { name: '红线关键词', desc: '质量/人因红线识别，采纳建议前须人工确认' },
  benefit_params: { name: '收益参数', desc: '按线费率/日产量/落地率（建议在「收益参数」页签维护）' },
  motion_standard: { name: '动作分解标准', desc: '一级/二级动作类型 + 描述格式 + 分界标准（起止点）+ 默认增值判定（「动作标准」配置页维护）' },
};
export interface AdminUserVo {
  userId: string; username: string; displayName: string; email: string | null;
  status: string; mustChangePwd: boolean; roles: string[]; createdAt: string;
  /** v3.50 人员档案 + 数据范围 + 方法资质 */
  department: string | null; position: string | null; employeeNo: string | null;
  dataScope: 'own' | 'line' | 'tenant' | 'all';
  certLevel: string | null; certExpiresAt: string | null;
  /** v3.58 资质状态由服务端统一计算（none/valid/expiring/expired），前端不再各算各的 */
  certStatus: 'none' | 'valid' | 'expiring' | 'expired';
}
/** v3.58 人员台账汇总 */
export interface UserSummaryVo {
  byStatus: { status: string; count: number }[];
  byRole: { code: string; count: number }[];
  byDepartment: { department: string; count: number }[];
  certExpiring: number; certExpired: number; total: number;
}
export interface AdminRoleVo {
  roleId: string; code: string; name: string; description: string | null;
  isSystem: boolean; permissions: string[]; memberCount: number;
}
/** v3.58 角色成员（角色侧授权：谁持有这个角色） */
export interface RoleMemberVo {
  userId: string; username: string; displayName: string;
  department: string | null; position: string | null; status: string;
}
export interface PermissionItemVo { code: string; name: string; module: string; roles: string[]; }
export interface PermissionGroupVo { module: string; label: string; items: PermissionItemVo[]; }
export interface RbacAuditVo {
  logId: string; action: string; entity: string; entityId: string | null;
  operator: string; operatorId: string | null; before: any; after: any; ip: string; at: string;
}
export interface UserEffectivePermVo {
  userId: string; username: string; displayName: string;
  roles: { code: string; name: string }[];
  byRole: { code: string; name: string; permissions: string[] }[];
  permissions: string[]; dataScope: string;
}
export const DATA_SCOPE_LABEL: Record<string, string> = {
  own: '仅本人', line: '本产线', tenant: '本租户', all: '全集团',
};
export const CERT_LEVEL_LABEL: Record<string, string> = {
  none: '未认证', L1: 'L1 初级', L2: 'L2 独立分析', L3: 'L3 可复核签发',
};
export const RBAC_ACTION_LABEL: Record<string, string> = {
  role_create: '新建角色', role_update: '修改角色', role_permissions: '调整角色权限',
  role_delete: '删除角色', user_create: '建号', user_update: '修改用户',
  user_roles: '调整用户角色', user_bulk_roles: '批量授权', user_approve: '审批通过',
  user_reject: '审批驳回', user_reset_password: '代置口令', user_issue_reset_code: '下发重置码',
  // v3.58
  role_members_add: '角色加入成员', role_members_remove: '角色移除成员',
  user_bulk_by_department: '按部门批量授权',
};
export const CERT_STATUS_LABEL: Record<string, string> = {
  none: '未认证', valid: '有效', expiring: '30 天内到期', expired: '已过期',
};
export interface ResetRequestVo {
  resetId: string; userId: string; username: string; displayName: string; userStatus: string;
  appliedAt: string; expiresAt: string; attempts: number; ip: string;
}
/** 角色字典（与后端 seed.ts ROLES 一致；均属 DEFAULT 租户） */
export const ROLE_OPTIONS: { code: string; name: string }[] = [
  { code: 'sys_admin', name: '系统管理员' },
  { code: 'ie_admin', name: 'IE 主管' },
  { code: 'ie_engineer', name: 'IE 工程师' },
  { code: 'line_leader', name: '产线班长' },
  { code: 'viewer', name: '只读用户' },
];
export const USER_STATUS_LABEL: Record<string, string> = {
  active: '正常', pending: '待审批', rejected: '已驳回', locked: '已锁定', disabled: '已停用',
};

export type AiUsageFeature = 'waste_analysis' | 'improvement_suggestion';
export interface AiUsageQuery {
  from?: string; to?: string; user_id?: string; line_id?: string; station_id?: string;
  feature?: AiUsageFeature | ''; model?: string; group_by?: string;
  sort?: 'total_tokens' | 'prompt_tokens' | 'completion_tokens' | 'api_call_count' | 'batch_count';
  order?: 'asc' | 'desc'; page?: number; page_size?: number;
}
export interface AiUsageTotals {
  batch_count: number; api_call_count: number; success_call_count: number; failed_call_count: number;
  prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number; cached_tokens: number | null;
  legacy_batch_count: number; usage_missing_count: number;
  data_quality: 'complete' | 'partial' | 'legacy_total_only';
}
export interface AiUsageRow extends AiUsageTotals {
  user_id: string | null; line_id: string | null; station_id: string | null;
  feature: AiUsageFeature | null; model: string | null;
  display_name: string | null; username: string | null; station_name: string | null; line_name: string | null;
}
export interface AiUsageSummary {
  range: { from: string | null; to: string | null; timezone: string; to_exclusive: boolean };
  group_by: string[]; totals: AiUsageTotals; rows: AiUsageRow[];
  page: number; page_size: number; total_rows: number; notes: string[];
}

/* ---------------- 端点 ---------------- */

export const api = {
  /* 认证 */
  login: (username: string, password: string) =>
    post<LoginResult>('/auth/login', { username, password }),
  logout: (refreshToken: string) => post<{ ok: true }>('/auth/logout', { refreshToken }),
  me: () => get<AuthUserVo>('/auth/me'),
  /** v3.57 登录页开关（OIDC 关闭时只返回本地登录） */
  authConfig: () => get<AuthConfigVo>('/auth/config'),
  /** v3.57 OTK 单次兑换本地登录态（60 秒有效，重复兑换即失效） */
  oidcExchange: (otk: string) => post<LoginResult>('/auth/oidc/token', { otk }),
  /** v3.57 统一身份登录跳转地址（整页跳转，不走 XHR） */
  oidcLoginUrl: () => `${BASE}/auth/oidc/login`,
  changePassword: (oldPassword: string, newPassword: string) =>
    post<{ ok: true }>('/auth/change-password', { oldPassword, newPassword }),
  /** 启动引导：有 refresh token 则刷新并拉当前用户；无 token 或刷新失败 → null */
  bootstrap: async (): Promise<AuthUserVo | null> => {
    if (!getRefreshToken()) return null;
    if (!(await refreshTokens())) return null;
    return api.me();
  },

  /* 工位 */
  stations: (lineId?: string) => get<Station[]>(`/stations${lineId ? `?line_id=${encodeURIComponent(lineId)}` : ''}`),
  station: (id: string) => get<Station>(`/stations/${encodeURIComponent(id)}`),
  createStation: (payload: { station_id: string; line_id: string; name: string; tt?: number }) =>
    post<Station>('/stations', payload),
  updateStation: (id: string, payload: { name?: string; tt?: number; roi?: string | null; roi_zones?: string | null; sop_steps?: string | null }) =>
    patch<Station>(`/stations/${encodeURIComponent(id)}`, payload),
  /** 删除工位（v3.21 主数据维护）：级联删除全部版本要素与改善记录，不可恢复 */
  deleteStation: (id: string) =>
    del<{ station_id: string; deleted: boolean; cascaded: { elements: number; improvements: number } }>(
      `/stations/${encodeURIComponent(id)}`),
  startRetest: (id: string) => post<Station>(`/stations/${encodeURIComponent(id)}/retest`),
  cancelRetest: (id: string) => del<Station>(`/stations/${encodeURIComponent(id)}/retest`),
  /* v3.42 共享与协作 */
  collaborators: (id: string) => get<StationCollaborator[]>(`/stations/${encodeURIComponent(id)}/collaborators`),
  shareStation: (id: string, userId: string, aclRole: 'editor' | 'viewer') =>
    post(`/stations/${encodeURIComponent(id)}/collaborators`, { user_id: userId, acl_role: aclRole }),
  unshareStation: (id: string, userId: string) =>
    del(`/stations/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(userId)}`),
  shareCandidates: () => get<ShareCandidate[]>('/stations/share-candidates'),
  myLineShares: () => get<LineShare[]>('/stations/line-shares'),
  shareLine: (lineId: string, userId: string, aclRole: 'editor' | 'viewer') =>
    post('/stations/line-shares', { line_id: lineId, user_id: userId, acl_role: aclRole }),
  unshareLine: (lineId: string, userId: string) =>
    del(`/stations/line-shares/${encodeURIComponent(lineId)}/${encodeURIComponent(userId)}`),
  stationVersions: (id: string) => get<StationVersion[]>(`/stations/${encodeURIComponent(id)}/versions`),

  /* 要素 */
  /** 取要素：version 省略=当前版本；指定则取历史版本（跨循环复用） */
  elements: (id: string, version?: number) => get<{ station_id: string; version: number; current_version: number; elements: Element[] }>(
    `/stations/${encodeURIComponent(id)}/elements${version ? `?version=${version}` : ''}`),
  validateElements: (id: string, payload: SubmitPayload) =>
    post<ValidateResult>(`/stations/${encodeURIComponent(id)}/elements/validate`, payload),
  submitElements: (id: string, payload: SubmitPayload) =>
    post<SubmitResult>(`/stations/${encodeURIComponent(id)}/elements/submit`, payload),
  importCsv: (id: string, csv: string) =>
    post<SubmitResult>(`/stations/${encodeURIComponent(id)}/elements/import`, { csv }),
  /** 导出 CSV（接口需认证，普通 <a href> 带不上 token → fetch+blob 下载） */
  exportElementsCsv: async (id: string) => {
    const res = await fetch(`${BASE}/stations/${encodeURIComponent(id)}/elements/export`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, {});
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `elements-${id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  vaOverride: (stationId: string, elementId: string, payload: { va_class: string; reason: string }) =>
    patch<{ element_id: string; va_class: string; desc: string; ct: number }>(
      `/stations/${encodeURIComponent(stationId)}/elements/${encodeURIComponent(elementId)}/va-class`, payload),
  vaConfirm: (stationId: string, elementId: string, payload: { va_class?: string }) =>
    post<{ element_id: string; va_class: string; desc: string; ct: number }>(
      `/stations/${encodeURIComponent(stationId)}/elements/${encodeURIComponent(elementId)}/va-confirm`, payload),

  /* 分析 */
  analysis: (id: string) => get<StationAnalysis>(`/stations/${encodeURIComponent(id)}/analysis`),
  lineAnalysis: (lineId: string) => get<LineAnalysis>(`/lines/${encodeURIComponent(lineId)}/analysis`),
  /** v3.53 AI 诊断：基于分析结果生成根因诊断 + 改善方向（纯文案，待审态） */
  diagnose: (id: string) =>
    post<{ report: string; status: string; generated_by: string; model: string }>(
      `/stations/${encodeURIComponent(id)}/analysis/diagnose`),
  /** 导航树数据源：本租户全部产线的名称 + 一条状态（station:read） */
  linesSummary: () => get<LinesSummary>('/lines/summary'),

  /* 主数据：项目与产线（新建分析对象向导先建线/选项目，再建工位） */
  projects: () => get<ProjectVo[]>('/projects'),
  createProject: (payload: { project_id: string; name: string; customer?: string; stage?: string }) =>
    post<ProjectVo & { existed: boolean }>('/projects', payload),
  updateProject: (id: string, payload: { name?: string; customer?: string; stage?: string }) =>
    patch<ProjectVo>(`/projects/${encodeURIComponent(id)}`, payload),
  /** 删除项目（软删除；仍被产线关联时 400，提示先解除关联） */
  deleteProject: (id: string) => del<{ project_id: string; deleted: boolean }>(`/projects/${encodeURIComponent(id)}`),
  lines: () => get<LineLite[]>('/lines'),
  createLine: (payload: { line_id: string; name: string; process_type?: string; product_type?: string; project_id?: string }) =>
    post<{ line_id: string; name: string; existed: boolean }>('/lines', payload),
  patchLine: (lineId: string, payload: { name?: string; process_type?: string; product_type?: string; project_id?: string }) =>
    patch<{ line_id: string; name: string }>(`/lines/${encodeURIComponent(lineId)}`, payload),
  /** 删除产线（有工位时 400，提示先删/迁走工位） */
  deleteLine: (lineId: string) => del<{ line_id: string; deleted: boolean }>(`/lines/${encodeURIComponent(lineId)}`),

  /* 公司（租户）信息（v3.21 主数据维护页；写权限仅管理员） */
  tenant: () => get<{ tenant_id: string; code: string; name: string; region: string; status: string }>('/tenant'),
  patchTenant: (payload: { name?: string; region?: string }) =>
    patch<{ tenant_id: string; name: string; region: string }>('/tenant', payload),

  /* CMC 产能系统（v3.21：基础信息唯一数据源，跨库实时只读；本地零维护） */
  cmc: {
    factories: () => get<{ cmc_factory_id: number; code: string; name: string; region: string | null }[]>('/cmc/factories'),
    lines: (factoryId?: number) =>
      get<{ cmc_line_id: number; factory_id: number; code: string; name: string; process_type: string; process_type_raw: string | null; line_type: string | null; factory_code: string; factory_name: string; project_count: number }[]>(
        `/cmc/lines${factoryId !== undefined ? `?factory_id=${factoryId}` : ''}`),
    lineProjects: (cmcLineId: number) =>
      get<{ program_number: string; name: string; customer: string | null; phase: string | null; product_group: string | null; ct_standard: number | null; allocation_ratio: number | null }[]>(
        `/cmc/lines/${cmcLineId}/projects`),
  },
  /** 自 CMC 创建分析工位：基础信息实时取自 CMC；v3.22 station_id 可手动维护（缺省自动生成） */
  createStationFromCmc: (payload: { cmc_line_id: number; station_id?: string; program_number?: string; name: string; tt?: number }) =>
    post<Station & { program_number: string | null; cmc_line_id: number | null }>('/stations/from-cmc', payload),

  /* 建议 */
  suggest: (id: string) => post<SuggestResult>(`/stations/${encodeURIComponent(id)}/suggestions/generate`),
  adopt: (id: string, payload: AdoptPayload) =>
    post<{ station_id: string; created: number; imp_ids: string[] }>(
      `/stations/${encodeURIComponent(id)}/suggestions/adopt`, payload),
  improvements: (query: { line_id?: string; station_id?: string; status?: string; project_type?: string; process?: string; product_type?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => Boolean(v)) as [string, string][],
    ).toString();
    return get<{ improvements: Improvement[] }>(`/improvements${qs ? `?${qs}` : ''}`);
  },
  updateImprovementStatus: (impId: string, status: string) =>
    patch<Improvement>(`/improvements/${encodeURIComponent(impId)}/status`, { status }),
  improvementReport: (impId: string) => get<SuggestionReport>(`/improvements/${encodeURIComponent(impId)}/report`),

  /* AI 改善建议模块（规格书 §4；权限 suggestion:generate / ai:governance / user:write） */
  ai: {
    usage: (query: AiUsageQuery = {}) => {
      const entries = Object.entries(query).filter(([, value]) => value !== '' && value !== undefined && value !== null);
      const qs = new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString();
      return get<AiUsageSummary>(`/ai/usage/summary${qs ? `?${qs}` : ''}`);
    },
    /** AI 服务状态只读（ai:governance 或 user:read） */
    config: () => get<AiConfigVo>('/ai-suggestions/config'),
    /** 建议列表（batches 数组倒序 + suggestions）。
     *  v3.46：source 可选（mixed=全量 legacy 口径 / manual=手工分解线 / ai_assisted=AI 分解线）；
     *  都不传则无 `?`，与 legacy 请求逐字节一致 */
    list: (stationId: string, version?: number, source?: AiSuggestElementSource) => {
      const q: string[] = [];
      if (version) q.push(`version=${version}`);
      if (source) q.push(`source=${source}`);
      const qs = q.length > 0 ? `?${q.join('&')}` : '';
      return get<AiSuggestionsResult>(`/stations/${encodeURIComponent(stationId)}/ai-suggestions${qs}`);
    },
    /** 触发生成：done/done_empty 幂等 200（idempotent_hit=true）；pending/running→409；配额尽→429；failed→重开。
     *  成功响应为扁平结构——页面刷新统一走 list()，本响应只用于 409/429/成功提示判定。
     *  v3.46：source 可选；mixed/缺省不拼 query（legacy 请求逐字节不变） */
    generate: (stationId: string, source?: AiSuggestElementSource) =>
      post<AiGenerateResult>(`/stations/${encodeURIComponent(stationId)}/ai-suggestions/generate${source && source !== 'mixed' ? `?source=${source}` : ''}`),
    /** 采纳：422 REDLINE_CONFIRM_REQUIRED 时需带 confirmations 重试（quality/ergonomics 两类红线） */
    adopt: (suggestionId: string, confirmations?: { quality?: { name: string; date?: string }; ergonomics?: { name: string; date?: string } }) =>
      post<AiAdoptResult>(`/ai-suggestions/${encodeURIComponent(suggestionId)}/adopt`, confirmations ? { confirmations } : undefined),
    /** 否决（可选 reason ≤256 字） */
    reject: (suggestionId: string, reason?: string) =>
      post<{ suggestion_id: string; status: string }>(`/ai-suggestions/${encodeURIComponent(suggestionId)}/reject`, reason ? { reason } : undefined),
    /** 自定义字典 CRUD（ai:governance） */
    dict: {
      list: () => get<{ items: AiCustomDictVo[] }>('/ai-custom-dict'),
      create: (payload: {
        dict_type: 'waste_type' | 'measure_type'; code: string; name: string;
        va_class?: string; method_hint?: string; action_class?: string; alias_of?: string;
      }) => post<AiCustomDictVo>('/ai-custom-dict', payload),
      remove: (dictId: string) => del<{ dict_id: string; deleted: boolean }>(`/ai-custom-dict/${encodeURIComponent(dictId)}`),
    },
    /** 配额管理（user:write；0 禁用 / -1 无限 / N 次） */
    quota: {
      get: (userId: string) => get<AiQuotaVo>(`/users/${encodeURIComponent(userId)}/ai-quota`),
      put: (userId: string, ai_quota: number) =>
        put<AiQuotaVo>(`/users/${encodeURIComponent(userId)}/ai-quota`, { ai_quota }),
    },
    /** LLM 网关配置（v3.31）：读=user:write 或 ai:governance（api_key 只回脱敏）；写=user:write */
    llmConfig: {
      get: () => get<AiLlmConfigVo>('/ai-suggestions/llm-config'),
      put: (payload: { enabled?: boolean; base_url?: string; api_key?: string; model?: string }) =>
        put<AiLlmConfigVo>('/ai-suggestions/llm-config', payload),
      /** 连接测试（v3.32）：零 token 探活 + 1 token 验证；表单值 dry-run 不落库；v3.40 支持按 profile_id 测 */
      test: (payload: { profile_id?: string; base_url?: string; api_key?: string; model?: string }) =>
        post<AiLlmTestVo>('/ai-suggestions/llm-config/test', payload),
      /** AI 功能端到端自测（v3.33）：真实 LLM→解析→三轮校验→计算全链；样例工位不落库不扣配额 */
      e2eTest: (payload: { profile_id?: string; base_url?: string; api_key?: string; model?: string }) =>
        post<AiLlmE2eVo>('/ai-suggestions/llm-config/e2e-test', payload),
    },
    /** 连接配置 profiles（v3.40：多配置单活，「启用」即切换生效连接；user:write） */
    llmProfiles: {
      list: () => get<LlmProfileVo[]>('/ai-suggestions/llm-profiles'),
      create: (payload: { name: string; base_url: string; api_key?: string; model: string }) =>
        post<LlmProfileVo>('/ai-suggestions/llm-profiles', payload),
      update: (id: string, payload: { name?: string; base_url?: string; api_key?: string; model?: string }) =>
        put<LlmProfileVo>(`/ai-suggestions/llm-profiles/${encodeURIComponent(id)}`, payload),
      activate: (id: string) =>
        put<LlmProfileVo>(`/ai-suggestions/llm-profiles/${encodeURIComponent(id)}/activate`, {}),
      remove: (id: string) =>
        del<{ profile_id: string; deleted: boolean }>(`/ai-suggestions/llm-profiles/${encodeURIComponent(id)}`),
    },
  },

  /* P3-9 浪费识别+改善问题清单（v3.45 双来源线；与 ai-suggest 相互独立——用户边界铁律） */
  aiWaste: {
    /** 最新批次视图（findings + issues + 批次元信息 + ct/summary；无批 → batch=null）。
     *  source 可选：不传 = 旧行为（服务端默认 ai_assisted 线，逐字节不变）。 */
    latest: (stationId: string, source?: AiWasteElementSource) =>
      get<AiWasteLatestResult>(`/stations/${encodeURIComponent(stationId)}/ai-waste/latest${source ? `?source=${source}` : ''}`),
    /** 批次历史（只读溯源；source 可选，缺省 ai_assisted 线） */
    batches: (stationId: string, source?: AiWasteElementSource) =>
      get<AiWasteBatchesResult>(`/stations/${encodeURIComponent(stationId)}/ai-waste/batches${source ? `?source=${source}` : ''}`),
    /** 识别生成·AI 分解线：done/done_empty 幂等 200（idempotent_hit=true）；running→409；无 AI 要素→400；服务关→503 */
    generate: (stationId: string) =>
      post<AiWasteLatestResult>(`/stations/${encodeURIComponent(stationId)}/ai-waste/generate`),
    /** 识别生成·手工分解线（v3.45）：基于已提交 manual 要素；幂等/409/503 与 generate 对称且按 source 隔离 */
    generateManual: (stationId: string) =>
      post<AiWasteLatestResult>(`/stations/${encodeURIComponent(stationId)}/ai-waste/generate-manual`),
    /** 问题条目状态流转：已确认→复制进 t_improvement（source=ai）；已忽略→终态 */
    settle: (issueId: string, status: '已确认' | '已忽略') =>
      post<AiWasteIssue>(`/ai-waste/issues/${encodeURIComponent(issueId)}/settle`, { status }),

    /* —— v3.51：人工录入与改善知识库 —— */

    /** 合并清单（按工位唯一索引查询；AI 关停亦可查历史批次 + 人工条目） */
    items: (stationId: string, opts?: { origin?: 'ai' | 'manual' | 'all'; scope?: 'latest' | 'all'; source?: AiWasteElementSource }) => {
      const qs = new URLSearchParams();
      if (opts?.origin) qs.set('origin', opts.origin);
      if (opts?.scope) qs.set('scope', opts.scope);
      if (opts?.source) qs.set('source', opts.source);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return get<AiWasteItemsResult>(`/stations/${encodeURIComponent(stationId)}/ai-waste/items${suffix}`);
    },
    /** 人工录入·浪费点（数字服务端算） */
    createFinding: (stationId: string, payload: { waste_type: string; evidence: string; element_seqs?: number[] }) =>
      post<AiWasteFinding>(`/stations/${encodeURIComponent(stationId)}/ai-waste/manual/findings`, payload),
    updateFinding: (id: string, payload: { waste_type?: string; evidence?: string; element_seqs?: number[] }) =>
      patch<AiWasteFinding>(`/ai-waste/findings/${encodeURIComponent(id)}`, payload),
    deleteFinding: (id: string) => del<{ finding_id: string; deleted: boolean }>(`/ai-waste/findings/${encodeURIComponent(id)}`),
    /** 人工录入·改善措施 */
    createIssue: (stationId: string, payload: {
      waste_type: string; problem: string; ecrs: string; suggestion: string;
      element_seqs?: number[]; est_save_s?: number;
    }) => post<AiWasteIssue>(`/stations/${encodeURIComponent(stationId)}/ai-waste/manual/issues`, payload),
    updateIssue: (id: string, payload: {
      waste_type?: string; problem?: string; ecrs?: string; suggestion?: string;
      element_seqs?: number[]; est_save_s?: number;
    }) => patch<AiWasteIssue>(`/ai-waste/issues/${encodeURIComponent(id)}`, payload),
    deleteIssue: (id: string) => del<{ issue_id: string; deleted: boolean }>(`/ai-waste/issues/${encodeURIComponent(id)}`),
    /** 手动整理进知识库（幂等） */
    archiveKb: (stationId: string, payload?: { kinds?: string[]; include_ai_confirmed?: boolean; general?: boolean }) =>
      post<{ station_id: string; created: number; updated: number; skipped: number }>(
        `/stations/${encodeURIComponent(stationId)}/ai-waste/kb/archive`, payload ?? {}),
    /** 知识库查询（?station_id= 时含跨工位通用条目） */
    listKb: (opts?: { station_id?: string; waste_type?: string; kind?: string; status?: string; q?: string; limit?: number }) => {
      const qs = new URLSearchParams(
        Object.entries(opts ?? {}).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
      ).toString();
      return get<{ items: AiWasteKbItem[]; total: number }>(`/ai-waste/kb${qs ? `?${qs}` : ''}`);
    },
    updateKb: (id: string, payload: { status?: 'active' | 'archived'; waste_type?: string; problem?: string; suggestion?: string; evidence?: string; ecrs?: string; general?: boolean }) =>
      patch<AiWasteKbItem>(`/ai-waste/kb/${encodeURIComponent(id)}`, payload),
    deleteKb: (id: string) => del<{ kb_id: string; deleted: boolean }>(`/ai-waste/kb/${encodeURIComponent(id)}`),
  },

  /* 集团综合驾驶舱（v3.3；group:read，仅聚合指标） */
  dashboard: {
    summary: (filters: DashboardFilters = {}) => {
      const qs = new URLSearchParams(
        Object.entries(filters).filter(([, v]) => Boolean(v)) as [string, string][],
      ).toString();
      return get<DashboardSummary>(`/dashboard/summary${qs ? `?${qs}` : ''}`);
    },
    /** 跨公司任务列表（VO 契约同 /improvements） */
    improvements: (filters: DashboardFilters & { status?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(filters).filter(([, v]) => Boolean(v)) as [string, string][],
      ).toString();
      return get<{ scope: Record<string, string>; improvements: Improvement[] }>(
        `/dashboard/improvements${qs ? `?${qs}` : ''}`);
    },
  },

  /* 对比 */
  compare: (id: string, v1?: number, v2?: number) => {
    const qs = new URLSearchParams();
    if (v1) qs.set('v1', String(v1));
    if (v2) qs.set('v2', String(v2));
    const suffix = qs.toString() ? `?${qs}` : '';
    return get<CompareResult>(`/stations/${encodeURIComponent(id)}/compare${suffix}`);
  },
  /** v3.53 AI 差异解读：前后版本对比的自然语言解读 + 倒退预警（纯文案，待审态） */
  interpret: (id: string, v1?: number, v2?: number) =>
    post<{ interpretation: string; regressionWarnings: string[]; status: string; generated_by: string; model: string }>(
      `/stations/${encodeURIComponent(id)}/compare/interpret`, { v1, v2 }),
  /** v3.53 视频场景切分：基于已上传视频文件名返回候选片段起止点（零 LLM） */
  sceneDetect: (name: string) =>
    post<{ scenes: { start_ms: number; end_ms: number; score: number }[]; durationS: number | null }>(
      `/videos/scene-detect`, { name }),

  /* 收益参数（规则集在线读写；保存须整体带回其他线，后端为整体替换） */
  benefitParams: () => get<{ version: number; source: string; formula: string; lines: BenefitParamsLine[] }>(
    '/config/benefit-params'),
  saveBenefitParams: (lines: BenefitParamsLine[]) =>
    post<{ rule_set_id: string; lines: BenefitParamsLine[] }>('/config/benefit-params', { lines }),

  /* 规则库（设置中心；只读 rule:read，发布 rule:write） */
  rules: {
    snapshot: () => get<Record<string, RuleSnapshotEntry>>('/rules'),
    sets: () => get<RuleSetMeta[]>('/rules/sets'),
    /** 生效规则完整内容（GET /rules/:code；未知码 404） */
    content: (code: string) => get<RuleContent>(`/rules/${encodeURIComponent(code)}`),
    /** 发布新版本（内容 rv 字段即版本号；发布立即全站生效。
     *  v3.19 版本号治理：版本号格式非法 → 400；同 code 版本号撞车 → 服务端自动顺延次版本，
     *  实际发布版本以 version 返回（bumped=true 表示填写的版本号已发布过） */
    publish: (code: string, content: Record<string, unknown>, operator?: string) =>
      post<{ rule_set_id: string; code: string; version?: string; bumped?: boolean }>(`/rules/${encodeURIComponent(code)}/publish`, { content, operator }),
  },

  /* 注册 / 找回密码（公开端点） */
  register: (payload: { username: string; password: string; displayName?: string; email?: string }) =>
    post<{ status: string; message: string }>('/auth/register', payload),
  /** 忘记密码：通用应答（不泄露账号存在性）；重置码由管理员人工送达 */
  forgotPassword: (username: string) =>
    post<{ ok: boolean; message: string }>('/auth/forgot-password', { username }),
  resetPassword: (username: string, code: string, newPassword: string) =>
    post<{ ok: boolean }>('/auth/reset-password', { username, code, newPassword }),

  /* 用户管理（sys_admin，user:read / user:write） */
  adminUsers: (query: {
    status?: string; keyword?: string; department?: string; role?: string; certStatus?: string;
  } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => Boolean(v)) as [string, string][],
    ).toString();
    return get<{ users: AdminUserVo[]; pendingCount: number; departments: string[]; summary: UserSummaryVo }>(
      `/admin/users${qs ? `?${qs}` : ''}`,
    );
  },
  createUser: (payload: {
    username: string; password: string; displayName?: string; email?: string; roles: string[];
    department?: string; position?: string; employeeNo?: string;
    dataScope?: string; certLevel?: string; certExpiresAt?: string;
  }) => post<AdminUserVo>('/admin/users', payload),
  updateUser: (id: string, payload: {
    displayName?: string; email?: string; status?: string;
    department?: string; position?: string; employeeNo?: string;
    dataScope?: string; certLevel?: string; certExpiresAt?: string;
    /** v3.58：停用当前登录管理员本人的显式确认位（'true' 字符串，后端 DTO 只收字符串） */
    confirmSelf?: string;
  }) => patch<AdminUserVo>(`/admin/users/${encodeURIComponent(id)}`, payload),
  setUserRoles: (id: string, roles: string[]) =>
    put<AdminUserVo>(`/admin/users/${encodeURIComponent(id)}/roles`, { roles }),
  approveUser: (id: string, roles: string[]) =>
    post<AdminUserVo>(`/admin/users/${encodeURIComponent(id)}/approve`, { roles }),
  rejectUser: (id: string, reason?: string) =>
    post<AdminUserVo>(`/admin/users/${encodeURIComponent(id)}/reject`, { reason }),
  /** 管理员代置临时口令：一次性返回明文，下次登录强制改密 */
  adminResetPassword: (id: string) =>
    post<{ tempPassword: string }>(`/admin/users/${encodeURIComponent(id)}/reset-password`),
  /** 管理员下发重置码：一次性返回 6 位明文码（30 分钟有效） */
  adminIssueResetCode: (id: string) =>
    post<{ code: string; expiresAt: string }>(`/admin/users/${encodeURIComponent(id)}/issue-reset-code`),
  /** 重置申请列表（helpdesk 视图，不含明文码） */
  resetRequests: () => get<{ requests: ResetRequestVo[] }>('/admin/password-resets'),

  /** 按部门批量授权（v3.58：组织维度整体调岗） */
  bulkSetRolesByDepartment: (department: string, roles: string[], mode: 'replace' | 'merge' = 'merge') =>
    post<{ updated: number; skipped: string[] }>('/admin/users/bulk-by-department', { department, roles, mode }),
  /* v3.50 角色与权限中心（role:read 查看 / role:write 维护 / audit:read 追溯） */
  adminRoles: () => get<{ roles: AdminRoleVo[] }>('/admin/roles'),
  adminPermissions: () => get<{ groups: PermissionGroupVo[]; total: number }>('/admin/permissions'),
  createRole: (payload: { code: string; name: string; description?: string; permissions: string[]; sourceRoleId?: string }) =>
    post<AdminRoleVo>('/admin/roles', payload),
  /** v3.58 角色侧成员管理（人员↔角色双向授权） */
  roleMembers: (roleId: string) =>
    get<{ roleId: string; code: string; name: string; members: RoleMemberVo[] }>(`/admin/roles/${encodeURIComponent(roleId)}/members`),
  addRoleMembers: (roleId: string, userIds: string[]) =>
    post<{ roleId: string; added: string[]; skipped: string[] }>(`/admin/roles/${encodeURIComponent(roleId)}/members`, { userIds }),
  removeRoleMembers: (roleId: string, userIds: string[]) =>
    post<{ roleId: string; removed: string[]; skipped: string[] }>(`/admin/roles/${encodeURIComponent(roleId)}/members/remove`, { userIds }),
  updateRole: (id: string, payload: { name?: string; description?: string }) =>
    patch<AdminRoleVo>(`/admin/roles/${encodeURIComponent(id)}`, payload),
  setRolePermissions: (id: string, permissions: string[]) =>
    put<AdminRoleVo>(`/admin/roles/${encodeURIComponent(id)}/permissions`, { permissions }),
  deleteRole: (id: string) => del<{ ok: true }>(`/admin/roles/${encodeURIComponent(id)}`),
  /** 批量授权：一次给多名用户改角色 */
  bulkSetRoles: (userIds: string[], roles: string[], mode: 'replace' | 'merge' = 'replace') =>
    post<{ updated: number; skipped: string[] }>('/admin/users/bulk-roles', { userIds, roles, mode }),
  /** 单用户生效权限（角色展开） */
  userPermissions: (id: string) =>
    get<UserEffectivePermVo>(`/admin/users/${encodeURIComponent(id)}/permissions`),
  /** 权限变更审计（v3.58：支持按动作 / 操作人 / 对象精确追溯） */
  adminAudit: (query: { entity?: string; action?: string; operator?: string; entityId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => Boolean(v)) as [string, string][],
    ).toString();
    return get<{ logs: RbacAuditVo[] }>(`/admin/audit${qs ? `?${qs}` : ''}`);
  },

  /* 工位视频（v3.28：格式兼容——浏览器不能直播的格式走后端 ffmpeg 转码） */
  videos: {
    /** 上传并（必要时）转码，返回可直接播放的 URL；失败抛 ApiError（detail 含原因） */
    upload: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      // multipart：不设 Content-Type（浏览器自带 boundary）；401 刷新重放逻辑同 request
      return request<VideoIngestResult>('/videos/upload', { method: 'POST', body: fd });
    },
    /**
     * v3.39：带进度的上传（XHR——fetch 拿不到上传进度）。
     * raw=true 时请求 ?raw=1：调用方已 canPlayType 确认浏览器能播原始编码（手机 HEVC 素材），
     * 跳过服务端转码；401 自动刷新令牌重放一次。
     */
    uploadWithProgress: (file: File, onProgress?: (pct: number) => void, raw = false) =>
      new Promise<VideoIngestResult>((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE}/videos/upload${raw ? '?raw=1' : ''}`);
        let retried = false;
        const send = () => {
          xhr.setRequestHeader('Authorization', 'Bearer ' + (accessToken ?? ''));
          if (onProgress && xhr.upload) {
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try { resolve(JSON.parse(xhr.responseText) as VideoIngestResult); }
              catch { reject(new Error('上传响应解析失败')); }
            } else if (xhr.status === 401 && !retried) {
              retried = true; // 只重放一次，避免刷新失败时死循环
              void refreshTokens().then((ok) => (ok ? send() : reject(new Error('登录已过期，请刷新页面重试'))));
            } else {
              let msg = `上传失败（HTTP ${xhr.status}）`;
              try {
                const j = JSON.parse(xhr.responseText);
                msg = (j && (j.detail || j.title || j.message)) || msg;
              } catch { /* 非 JSON 保留状态码信息 */ }
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error('网络错误：上传中断（请检查与服务器的连接）'));
          xhr.send(fd);
        };
        if (accessToken) send();
        else void refreshTokens().then((ok) => (ok ? send() : reject(new Error('未登录或登录已过期'))));
      }),
    /** 服务器 ffmpeg 可用性与格式支持清单 */
    capabilities: () => get<VideoCapabilities>('/videos/capabilities'),
    /** v3.57 视频库：保留状态与操作入口（默认只看可见范围内的源视频） */
    assets: () => get<VideoAssetView[]>('/videos/assets'),
    asset: (name: string) => get<VideoAssetView>(`/videos/assets/${encodeURIComponent(name)}`),
    setRetention: (name: string, action: 'extend' | 'permanent') =>
      post<VideoAssetView>(`/videos/assets/${encodeURIComponent(name)}/retention`, { action }),
    deleteAsset: (name: string) =>
      del<{ deleted: boolean }>(`/videos/assets/${encodeURIComponent(name)}`),
  },
};

/** v3.39：拉取服务器视频为 Blob（带 Authorization）。不用 ?token= 直播的原因：
 *  分析要把视频帧画进 canvas 取像素，跨域 <video> 会污染画布；blob 同源化后零风险。
 *  注意：ingest 返回的 url 已含 /api 前缀（如 /api/videos/file/x.mp4），
 *  不能再拼 BASE——BASE 为相对路径时取同源绝对路径，为绝对地址时取其 origin。 */
const API_ORIGIN = /^https?:\/\//.test(BASE) ? BASE.replace(/\/api\/?$/, '') : '';
export async function fetchVideoBlob(url: string): Promise<Blob> {
  const full = url.startsWith('http') ? url : `${API_ORIGIN}${url}`;
  const doFetch = () => fetch(full, { headers: { Authorization: 'Bearer ' + (accessToken ?? '') } });
  let res = await doFetch();
  if (res.status === 401 && (await refreshTokens())) res = await doFetch();
  if (!res.ok) throw new Error(`视频拉取失败（HTTP ${res.status}）`);
  return res.blob();
}

/** 当前 access token（video/ 分片上传的 XHR 链路复用；401 重放走 refreshTokens） */
export function getAccessToken(): string | null {
  return accessToken;
}

/** v3.28：服务端视频播放地址（<video> src 用）——标签发不了 Authorization 头，token 走 ?token= 查询参数。
 *  BASE 为相对（/api，同源反代）或绝对（http://host:3001）两种形态都能正确拼出。 */
export function videoFileUrl(name: string): string {
  return apiUrlWithToken(`/videos/file/${encodeURIComponent(name)}`);
}

/** 带 ?token= 的 API 地址（SPEC-VID-P0 §4-3 派生文件下发同范式：<video>/<img> 发不了 Authorization 头） */
export function apiUrlWithToken(path: string): string {
  const q = accessToken ? `?token=${encodeURIComponent(accessToken)}` : '';
  return `${BASE}${path}${q}`;
}

/** 视频上传/转码结果（POST /videos/upload） */
export interface VideoIngestResult {
  url: string;
  name: string;
  probe: { container: string; videoCodec: string; audioCodec: string | null; width: number; height: number; durationS: number | null };
  transcoded: boolean;
}
export interface VideoCapabilities {
  ffmpeg: boolean;
  native: string[];
  convertible: string[];
}

/* ---------------- AI 改善建议模块（规格书 §4 契约；后端未就绪时前端先按此开发） ---------------- */

/** AI 批次状态：pending=排队 running=生成中 done=有结果 done_empty=三轮校验后零条（已计费） failed=模型/网络失败（不计费） */
export type AiBatchStatus = 'pending' | 'running' | 'done' | 'done_empty' | 'failed';
/** 建议审前状态：铁律① AI 建议永远「待审」，采纳才进 t_improvement */
export type AiSuggestionStatus = '待审' | '已采纳' | '已否决';

/** AI 服务状态（GET /ai-suggestions/config，设置页只读区）——字段名与后端 ai-suggest.service.ts 对齐 */
export interface AiConfigVo {
  enabled: boolean;
  model: string | null;
  prompt_version: string | null;
  /** 批次节省上限系数（0.5） */
  batch_ceiling: number;
  /** 配额维度：station | station+version */
  quota_scope: string;
  /** 月度 token 用量 / 上限 */
  monthly_tokens_used: number;
  monthly_token_limit: number | null;
  /** 当前用户当日配额：0=禁用 -1=无限 N=次数 */
  quota: number;
  quota_used: number;
  /** 配额无限标记（持 user:write 或 quota=-1） */
  quota_unlimited: boolean;
  /** LLM 网关熔断中 */
  llm_circuit_open: boolean;
}

/** LLM 网关配置（v3.31 GET/PUT /ai-suggestions/llm-config；api_key 永不回传明文只回脱敏值） */
export interface AiLlmConfigVo {
  enabled: boolean;
  /** 值来源：db（管理员界面写入，优先）| env（.env 回落） */
  enabled_source: 'db' | 'env';
  base_url: string;
  base_url_source: 'db' | 'env';
  api_key_masked: string;
  api_key_source: 'db' | 'env';
  model: string;
  model_source: 'db' | 'env';
  /** v3.40：当前启用的连接配置（无启用项为 null） */
  active_profile: { profile_id: string; name: string } | null;
}

/** LLM 连接配置（v3.40 GET/POST/PUT/DELETE /ai-suggestions/llm-profiles；api_key 只回脱敏值） */
export interface LlmProfileVo {
  profile_id: string;
  name: string;
  base_url: string;
  api_key_masked: string;
  model: string;
  /** 1=启用中（同一时刻仅一条） */
  enabled: number;
  created_at: string;
}

/** LLM 连接测试结果（v3.32 POST /ai-suggestions/llm-config/test） */
export interface AiLlmTestVo {
  ok: boolean;
  base_url: string;
  model: string;
  api_key_set: boolean;
  /** 两级探测总耗时（ms） */
  latency_ms: number;
  /** 最小 token 调用实测消耗（通常 1~3） */
  tokens_used: number | null;
  /** 模型是否出现在 /models 清单（null=/models 不可用或无法解析） */
  model_listed: boolean | null;
  models_sample: string[];
  checks: {
    /** ① 零 token 探活：GET /models */
    models: { ok: boolean; http_status: number; latency_ms: number; reason: string | null; suggestion: string | null; sample: string | null };
    /** ② 最小 token 验证：POST /chat/completions（max_tokens=1） */
    chat: { ok: boolean; http_status: number; latency_ms: number; reason: string | null; suggestion: string | null; sample: string | null };
  };
  /** 失败主因（人话） */
  diagnosis: string | null;
  /** 修复建议 */
  suggestion: string | null;
  /** 非致命提示（/models 未开放、模型不在清单、未设 Key 等） */
  warnings: string[];
}

/** AI 功能端到端自测结果（v3.33 POST /ai-suggestions/llm-config/e2e-test） */
export interface AiLlmE2eVo {
  ok: boolean;
  /** 失败阶段：llm_call=调用失败 | parse=输出不可解析 | validation=校验剔除 | done=全链通过 */
  stage: 'llm_call' | 'parse' | 'validation' | 'done';
  latency_ms: number;
  tokens_used: number;
  model: string;
  base_url: string;
  /** LLM 原始候选数 / 校验通过数 / 被剔除数 */
  raw_count: number;
  accepted_count: number;
  dropped_count: number;
  batch_blocked: string | null;
  /** 通过校验的建议（数字全部服务端重算） */
  suggestions: {
    element_seqs: number[];
    waste_type: string;
    method: string;
    factor: number | null;
    measure: string;
    est_save_s: number | null;
    priority: number | null;
    tier: string | null;
    risk_flags: string[];
    trace_rounds: string[];
  }[];
  validation_blocked: { message: string } | null;
  error: string | null;
  suggestion: string | null;
  /** parse/validation 失败时附输出头部，便于定位模型问题 */
  raw_head?: string;
}

/** v3.46 AI 建议来源线：mixed=全量（AI+手工混合，legacy 默认口径）/ manual=手工分解线 / ai_assisted=AI 分解线 */
export type AiSuggestElementSource = 'mixed' | 'manual' | 'ai_assisted';

/** AI 建议批次（GET list 返回 batches 数组，按 created_at DESC；页面取 [0] 为当前批次） */
export interface AiBatch {
  batch_id: string;
  station_id: string;
  version: number;
  user_id: string;
  /** v3.46 来源线（mixed=全量 legacy / manual=手工分解线 / ai_assisted=AI 分解线） */
  element_source: AiSuggestElementSource;
  status: AiBatchStatus;
  attempt: number;
  suggestion_count: number;
  tokens_used: number;
  model: string | null;
  prompt_version: string | null;
  cache_from: string | null;
  error: string | null;
  created_at: string;
  /** 生成完成时间（需求②：done 时展示） */
  completed_at: string | null;
  /** 幂等命中标记（POST generate 200 且命中既有槽位时 true；仅 generate 响应顶层） */
  idempotent_hit?: boolean;
}

/** AI 建议（审前态；est_save_s/priority/tier 全部服务端计算——铁律②） */
export interface AiSuggestion {
  suggestion_id: string;
  batch_id: string;
  station_id: string;
  version: number;
  element_ids: string;
  /** 中文名直存（裁决 6） */
  waste_type: string;
  method: 'E' | 'C' | 'R' | 'S';
  measure: string;
  /** E 类必填：消除的产生条件依据（裁决 3） */
  eliminate_basis: string | null;
  est_save_s: number;
  priority: number;
  tier: 'P1' | 'P2' | 'P3';
  difficulty: number;
  /** 可验证性 1/2/3（次级排序键） */
  verif: number;
  /** v3.46：后端 suggestionVo 实际返回数组（legacy DB 存 '|' 分隔字符串，VO 层已拆分） */
  risk_flags: string[];
  status: AiSuggestionStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** 三轮校验处置轨迹（JSON 字符串或对象） */
  validation_trace: string | Record<string, unknown> | null;
  created_at: string;
}

/** 建议列表响应（GET /stations/:id/ai-suggestions?version=）——batches 数组按时间倒序，页面取 [0] */
export interface AiSuggestionsResult {
  station_id: string;
  version: number;
  batches: AiBatch[];
  suggestions: AiSuggestion[];
}

/** POST generate 成功响应（扁平结构，无嵌套 batch；幂等命中 idempotent_hit=true） */
export interface AiGenerateResult {
  idempotent_hit?: boolean;
  batch_id: string;
  status: AiBatchStatus;
  /** v3.46 来源线（additive 字段；旧字段不受影响） */
  element_source?: AiSuggestElementSource;
  suggestion_count?: number;
  completed_at?: string | null;
  station_id: string;
  version: number;
  suggestions: AiSuggestion[];
}

/** 采纳响应（写 t_improvement source='ai'） */
export interface AiAdoptResult {
  imp_id: string;
  suggestion_id: string;
  station_id: string;
  /** params 未配置时为 null（永无假金额）；note 带解释文案 */
  annual_yuan: number | null;
  note: string | null;
}

/** 自定义浪费/措施类型（t_ai_custom_dict） */
export interface AiCustomDictVo {
  dict_id: string;
  dict_type: 'waste_type' | 'measure_type';
  code: string;
  name: string;
  /** waste_type 必填 */
  va_class: string | null;
  /** measure_type 必填 */
  method_hint: string | null;
  action_class: string | null;
  alias_of: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
}

/** 用户 AI 配额行（GET /users/:id/ai-quota；0=禁用 -1=无限 N=次数） */
export interface AiQuotaVo {
  userId: string;
  username: string;
  displayName: string;
  ai_quota: number;
  ai_quota_used: number;
  is_unlimited: boolean;
}

/** 解析 validation_trace：后端可能存 JSON 字符串也可能已是对象 */
export function parseValidationTrace(t: AiSuggestion['validation_trace']): unknown {
  if (t == null) return null;
  if (typeof t === 'object') return t;
  try { return JSON.parse(t); } catch { return t; }
}

export interface SubmitPayload {
  bol_version?: number; cycle_count: number; cv: number; video_id?: string;
  elements: {
    seq: number; start_ms: number; dur_s: number; hand: string; type: string; desc: string;
    va_class: string; outlier_flag: number; outlier_reason: string; rating: number; allowance: number;
    /** v3.33 来源溯源：'ai_assisted' = AI 候选接受而来；缺省视为 manual */
    source?: 'manual' | 'ai_assisted';
  }[];
}

/* ───────────────── P3-9 浪费识别+改善问题清单（AI 自动分解线专用） ───────────────── */

export type AiWasteBatchStatus = 'running' | 'done' | 'done_empty' | 'failed';
export type AiWasteIssueStatus = '待处理' | '已确认' | '已忽略';
export type AiWasteTier = 'P1' | 'P2' | 'P3';
/** 要素来源线（v3.45 手工分解线）：manual=手工分解写入 / ai_assisted=AI 自动分解写入 */
export type AiWasteElementSource = 'manual' | 'ai_assisted';

/** v3.51 条目来源：ai=AI 识别产出 / manual=人工录入 */
export type AiWasteOrigin = 'ai' | 'manual';

/** 浪费点（W1-W3 校验后落库；involved_s/pct_of_ct/severity 全服务端算——铁律②） */
export interface AiWasteFinding {
  finding_id: string;
  batch_id: string;
  station_id: string;
  version: number;
  element_seqs: number[];
  waste_type: string;
  /** 1 轻微 / 2 一般 / 3 严重（pct_of_ct ≥15→3 / ≥8→2） */
  severity: number;
  involved_s: number;
  pct_of_ct: number;
  evidence: string;
  created_at: string;
  /** v3.51：ai=AI 识别产出 / manual=人工录入（人工条目可编辑删除，AI 条目不可改） */
  origin?: AiWasteOrigin;
  created_by?: string | null;
  updated_at?: string | null;
  /** v3.57：路由——finding=确定性命中计收益 / pool=待标定观察项仍进清单、est 不计值 */
  route?: AiWasteRoute;
}

/** v3.57 浪费点路由（两轴规则落地）：finding 确定性 / pool 待标定观察 */
export type AiWasteRoute = 'finding' | 'pool';

/** 问题清单条目（审前态；确认→t_improvement source=ai 溯源 issue_id） */
export interface AiWasteIssue {
  issue_id: string;
  batch_id: string;
  finding_id: string | null;
  station_id: string;
  version: number;
  element_seqs: number[];
  waste_type: string;
  problem: string;
  ecrs: 'E' | 'C' | 'R' | 'S';
  suggestion: string;
  est_save_s: number;
  priority: number;
  tier: AiWasteTier;
  status: AiWasteIssueStatus;
  imp_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  validation_trace: unknown;
  created_at: string;
  /** v3.51：ai=AI 识别产出 / manual=人工录入 */
  origin?: AiWasteOrigin;
  created_by?: string | null;
  updated_at?: string | null;
}

/** v3.51 合并清单查询响应（AI 批次条目 + 人工条目；AI 关停亦可查） */
export interface AiWasteItemsResult {
  station_id: string;
  version: number;
  origin: string;
  scope: string;
  source: string;
  batch_ids: string[];
  /** 动态浪费白名单（人工录入下拉用） */
  waste_types: string[];
  summary: AiWasteSummary;
  findings: AiWasteFinding[];
  issues: AiWasteIssue[];
}

/** v3.51 知识库条目 */
export interface AiWasteKbItem {
  kb_id: string;
  station_id: string | null;
  kind: 'finding' | 'issue';
  waste_type: string;
  ecrs: string | null;
  problem: string | null;
  suggestion: string | null;
  evidence: string | null;
  keywords: string | null;
  element_types: string | null;
  source_origin: AiWasteOrigin;
  source_ref: string | null;
  hit_count: number;
  last_hit_at: string | null;
  status: 'active' | 'archived';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** 批次元信息（生成/查询共用） */
export interface AiWasteBatchVo {
  batch_id: string;
  status: AiWasteBatchStatus;
  version: number;
  element_source: string;
  element_count: number;
  finding_count: number;
  issue_count: number;
  tokens_used: number;
  model: string | null;
  prompt_version: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  /** 幂等命中标记（仅 generate 响应顶层） */
  idempotent_hit?: boolean;
}

/** GET latest / POST generate 响应 */
export interface AiWasteLatestResult extends AiWasteBatchVo {
  station_id: string;
  version: number;
  batch: null | true;
  /** 要素来源线（v3.45：latest/batches 按 source 隔离，两线清单不混淆） */
  element_source: AiWasteElementSource;
  /** 当前版本该来源子集 CT（服务端现场复算的只读值；无批时缺省） */
  ct?: number;
  /**
   * v3.48 来源可用性：当前版本各来源线的非异常要素数。
   * 空态时据此提示「切换到有数据的那条线」——修复手工分解工位落在默认 AI 线页签
   * 看到空列表却无处可点的问题（BJFA1/ST010 实测）。
   */
  source_availability?: { manual: number; ai_assisted: number };
  /** 识别结果摘要（P1-3：数字全部服务端口径汇总，前端零计算） */
  summary?: AiWasteSummary;
  findings: AiWasteFinding[];
  issues: AiWasteIssue[];
}

/** 识别结果摘要（P1-3：by_type 分布 + 预计总节省 + 占 CT 比，服务端算） */
export interface AiWasteSummary {
  /** 浪费类型分布计数（findings 按 waste_type 计数） */
  by_type: Record<string, number>;
  /** 预计总节省 Σest_save_s（秒） */
  total_est_save_s: number;
  /** 预计总节省占该来源线 CT 比（%） */
  est_pct_of_ct: number;
}

/** GET batches 响应 */
export interface AiWasteBatchesResult {
  station_id: string;
  batches: AiWasteBatchVo[];
}
