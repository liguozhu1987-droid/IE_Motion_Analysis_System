import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

/**
 * 项目（v3.7 新增主数据）：工厂/产线之外的项目维度，供「新建分析对象」向导下拉选择。
 * 复合主键 (tenant_id, project_id)——项目编号按公司各自唯一（如 P-2026-007）。
 * 与产线的关联：t_line.product_project 存项目编号（不建外键，保持"薄"；后续可升级为 FK）。
 * stage：NPI导入 | 量产 | 结项（与改善任务的 project_type 不是同一口径，勿混用）
 */
@Entity({ name: 't_project' })
export class Project {
  @PrimaryColumn({ length: 32 }) tenant_id: string;
  @PrimaryColumn({ length: 32 }) project_id: string;
  @ManyToOne(() => Tenant) @JoinColumn({ name: 'tenant_id' }) tenant: Tenant;
  @Column({ length: 64 }) name: string;
  @Column({ length: 64, default: '' }) customer: string;
  @Column({ length: 16, default: '量产' }) stage: string;
  @Column({ length: 16, default: 'active' }) status: string;
  @CreateDateColumn() created_at: Date;
}
