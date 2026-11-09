import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * 工位协作者（v3.42 工位级共享）。
 * ACL 资源级授权：owner 天然有全权；协作者按 acl_role 上限 × RBAC 取交集。
 * station_id FK 指向 t_station——新增引用 t_station 的子表必须同步进 stations.remove() 级联链（铁律）。
 */
@Entity({ name: 't_station_collaborator' })
export class StationCollaborator {
  @PrimaryColumn({ length: 32 }) station_id: string;
  @PrimaryColumn({ length: 32 }) user_id: string;
  /** 'editor'（可写）| 'viewer'（只读）；最终能力 = acl_role × RBAC 取交集 */
  @Column({ length: 16 }) acl_role: string;
  @Column({ length: 32 }) granted_by: string;
  @CreateDateColumn() granted_at: Date;
}

/**
 * 产线级批量授权（v3.42）：grantor 名下该产线现有+未来新建工位共享给 grantee。
 * 可见性判定优先级：owner > 工位级协作者 > 产线级授权（并集）。
 * 不做 FK（grantor 工位集是动态集合，删工位无需清理本表——授权随工位消失自然失效）。
 */
@Entity({ name: 't_line_share' })
export class LineShare {
  @PrimaryColumn({ length: 32 }) tenant_id: string;
  @PrimaryColumn({ length: 32 }) line_id: string;
  @PrimaryColumn({ length: 32 }) grantor_user_id: string;
  @PrimaryColumn({ length: 32 }) grantee_user_id: string;
  @Column({ length: 16 }) acl_role: string;
  @CreateDateColumn() granted_at: Date;
}
