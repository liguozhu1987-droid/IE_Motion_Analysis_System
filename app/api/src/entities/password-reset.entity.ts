import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * 密码重置码（helpdesk 模式：无 SMTP 环境，由管理员人工下发/送达重置码）。
 * 安全设计：
 *  - 不明文存储：code_hash = sha256(code + ':' + user_id)，管理员可下发新码但库内无可逆明文；
 *  - 30 分钟有效、一次性（used=1 后作废）、尝试上限 5 次（attempts>=5 自动作废）；
 *  - 新码生成即作废旧码（每用户同时仅一个有效码）；
 *  - 重置成功 → 吊销该用户全部 refresh 会话。
 */
@Entity({ name: 't_password_reset' })
export class PasswordReset {
  @PrimaryColumn({ length: 36 }) reset_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @Column({ length: 32 }) user_id: string;
  @Column({ length: 64 }) code_hash: string;
  @Column({ type: 'datetime' }) expires_at: Date;
  @Column({ type: 'int', default: 0 }) used: number;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ length: 45, nullable: true }) ip: string | null;
  @CreateDateColumn() created_at: Date;
}
