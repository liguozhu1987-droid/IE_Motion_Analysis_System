import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/** 写操作审计。保留策略 2 年，异步落库不阻塞响应 */
@Entity({ name: 't_audit_log' })
export class AuditLog {
  @PrimaryColumn({ length: 36 }) log_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @Column({ length: 32, nullable: true }) user_id: string | null;
  @Column({ length: 32, nullable: true }) username: string | null; // 系统动作（无登录用户）时为空
  @Column({ length: 64 }) action: string; // login|create_station|submit_elements...（v3.58.1: 64→128 对齐扩容后 DB 列，path 派生 action 更长）
  @Column({ length: 64 }) entity: string; // v3.58.1: 32→64 对齐扩容后 DB 列（拦截器写完整请求路径，55+ 字符；NVARCHAR(32) 参数装不下 → TDS 审计写入全灭）
  @Column({ length: 64, nullable: true }) entity_id: string | null;
  @Column({ type: 'text', nullable: true }) before_json: string | null;
  @Column({ type: 'text', nullable: true }) after_json: string | null;
  @Column({ length: 45, nullable: true }) ip: string | null;
  @CreateDateColumn() created_at: Date;
}
