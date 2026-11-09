import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

/**
 * 用户。密码 bcrypt 哈希；登录锁定：failed_count>=5 → locked_until=now+15min。
 * status：active|pending|rejected|locked|disabled（pending=注册待审批，无角色不泄数据）。
 * username 全局唯一（登录仅凭用户名，跨租户不得重名）。
 */
@Entity({ name: 't_user' })
export class User {
  @PrimaryColumn({ length: 32 }) user_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @ManyToOne(() => Tenant) @JoinColumn({ name: 'tenant_id' }) tenant: Tenant;
  @Column({ length: 64, unique: true }) username: string;
  @Column({ length: 128, select: false }) password_hash: string;
  @Column({ length: 32 }) display_name: string;
  @Column({ length: 128, nullable: true }) email: string | null;
  @Column({ length: 16, default: 'active' }) status: string; // active|pending|rejected|locked|disabled
  @Column({ type: 'int', default: 0 }) failed_count: number;
  @Column({ type: 'datetime', nullable: true }) locked_until: Date | null;
  @Column({ type: 'int', default: 0 }) must_change_pwd: number;
  /** AI 建议配额：0=禁用 / -1=无限 / N=可成功生成 N 个槽位（v3.30） */
  @Column({ type: 'int', default: 1 }) ai_quota: number;
  @Column({ type: 'int', default: 0 }) ai_quota_used: number;
  // —— v3.50 用户与权限中心：人员档案 + 数据范围 + 方法资质 ——
  /** 所属部门/科室（组织维度，用于按部门批量授权与花名册导出） */
  @Column({ length: 64, nullable: true }) department: string | null;
  /** 岗位（如 IE 工程师 / 产线班长 / 工艺员） */
  @Column({ length: 64, nullable: true }) position: string | null;
  /** 工号（HR 主数据对齐用，可空） */
  @Column({ length: 32, nullable: true }) employee_no: string | null;
  /** 数据范围（行级）：own=仅本人 / line=本产线 / tenant=本租户 / all=全集团 */
  @Column({ length: 16, default: 'own' }) data_scope: string;
  /** 方法资质等级（借鉴 MTM Blue Card / MOST 分级认证）：none|L1|L2|L3 */
  @Column({ length: 16, nullable: true }) cert_level: string | null;
  /** 资质有效期（到期仅提示不阻断；复训后再认证由管理员更新） */
  @Column({ type: 'datetime', nullable: true }) cert_expires_at: Date | null;
  /**
   * 账号来源（v3.57 统一身份认证）：
   *  local=本地建号（可用本地密码登录）｜oidc=统一身份自动建档或已绑定 SSO 工号。
   *  仅用于展示与离职状态回写范围，不参与登录判定；本地登录只看 password_hash 是否有效。
   */
  @Column({ length: 8, default: 'local' }) auth_source: string;
  @CreateDateColumn() created_at: Date;
}
