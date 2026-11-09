import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/** 租户（法人/事业部）。MVP 种子：DEFAULT。
 *  region：区域维度（v3.3 挂公司）——按区域汇总 = GROUP BY region。 */
@Entity({ name: 't_tenant' })
export class Tenant {
  @PrimaryColumn({ length: 32 }) tenant_id: string;
  @Column({ length: 32 }) code: string;
  @Column({ length: 64 }) name: string;
  @Column({ length: 32, default: '总部' }) region: string;
  @Column({ length: 16, default: 'active' }) status: string;
  @CreateDateColumn() created_at: Date;
}
