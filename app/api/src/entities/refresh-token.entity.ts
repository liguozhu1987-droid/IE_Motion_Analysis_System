import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { User } from './user.entity';

/** Refresh Token：轮换 + 复用检测（重放旧 token → 全族吊销） */
@Entity({ name: 't_refresh_token' })
export class RefreshToken {
  @PrimaryColumn({ length: 36 }) token_id: string;
  @Column({ length: 32 }) user_id: string;
  @ManyToOne(() => User) @JoinColumn({ name: 'user_id' }) user: User;
  @Column({ length: 128 }) token_hash: string; // sha256(token)
  @Column({ type: 'datetime' }) expires_at: Date;
  @Column({ type: 'int', default: 0 }) revoked: number;
  @Column({ length: 36, nullable: true }) replaced_by: string | null;
  @Column({ length: 45, nullable: true }) ip: string | null;
  /** 签发来源：local=本地密码登录｜oidc=统一身份登录（刷新后仍保持同一来源） */
  @Column({ length: 8, default: 'local' }) source: string;
  @CreateDateColumn() created_at: Date;
}
