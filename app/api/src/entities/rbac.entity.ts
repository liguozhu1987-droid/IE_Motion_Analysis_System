import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

/** 角色（按租户隔离）。系统角色 is_system=1 不可删除 */
@Entity({ name: 't_role' })
export class Role {
  @PrimaryColumn({ length: 32 }) role_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @ManyToOne(() => Tenant) @JoinColumn({ name: 'tenant_id' }) tenant: Tenant;
  @Column({ length: 32 }) code: string; // sys_admin|ie_admin|ie_engineer|line_leader|viewer
  @Column({ length: 32 }) name: string;
  /** 角色说明（v3.50：自定义角色用途标注，便于交接与审计追溯） */
  @Column({ length: 128, nullable: true }) description: string | null;
  @Column({ type: 'int', default: 0 }) is_system: number;
}

/** 权限点字典（系统级） */
@Entity({ name: 't_permission' })
export class Permission {
  @PrimaryColumn({ length: 32 }) perm_id: string;
  @Column({ length: 48, unique: true }) code: string; // station:read ...
  @Column({ length: 32 }) module: string;
  @Column({ length: 32 }) name: string;
}

@Entity({ name: 't_user_role' })
export class UserRole {
  @PrimaryColumn({ length: 32 }) user_id: string;
  @PrimaryColumn({ length: 32 }) role_id: string;
}

@Entity({ name: 't_role_permission' })
export class RolePermission {
  @PrimaryColumn({ length: 32 }) role_id: string;
  @PrimaryColumn({ length: 32 }) perm_id: string;
}
