import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * 统一身份认证中央表（只读映射）。
 *
 * 权威定义在交底书《统一身份认证技术交底书_MSIA与BOL实施实录.md》§4 / `scripts/sql/01_create_sso_tables.sql`：
 * 五张表前缀 `CN_AME_SSO_`，本系统只读 `User` 与 `UserMap`，不写不同步（人员事实来源由 AD → 中央表单向同步）。
 *
 * 这里只声明集成必读字段，不声明全表：生产 `synchronize=false`，读列子集即可；
 * 若现场 DDL 与本文件字段名不一致，登录会明确失败而不是静默放行——属于期望中的 fail-fast。
 * 表结构变更一律走 `deploy/sql/manual/` 手工脚本，不进入自动 migrate。
 */
@Entity({ name: 'CN_AME_SSO_User' })
export class SsoUser {
  /** 稳定人员主键（MERGE 匹配键），唯一 */
  @PrimaryColumn({ length: 32 }) employee_no: string;
  /** Keycloak username（= id_token.preferred_username），唯一且禁止被 MERGE 改写 */
  @Column({ length: 64 }) login_name: string;
  @Column({ length: 128, nullable: true }) display_name: string | null;
  @Column({ length: 128, nullable: true }) email: string | null;
  /** 1=在职 / 0=停用；永不物理删除 */
  @Column({ type: 'int', default: 1 }) status: number;
  /** AD=同步 / MANUAL=手工例外 */
  @Column({ length: 16, nullable: true }) source: string | null;
}

/** 跨系统本地用户名映射：本地用户名与中央 login_name 不一致时必填 */
@Entity({ name: 'CN_AME_SSO_UserMap' })
export class SsoUserMap {
  @PrimaryColumn({ length: 32 }) employee_no: string;
  /** 系统编码（本系统固定 'ie'，见 AUTH_OIDC_SYSTEM_CODE） */
  @PrimaryColumn({ length: 32 }) system_code: string;
  @Column({ length: 64 }) local_username: string;
}
