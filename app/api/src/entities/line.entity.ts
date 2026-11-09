import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

/**
 * 产线（v3.3 新增一等实体）：承载工艺/产品元数据 + 集团驾驶舱维度。
 * 复合主键 (tenant_id, line_id)——跨公司各自可有 L01；
 * 工位创建时 upsert 本表记录（无独立产线管理页，MVP 薄哲学）。
 * process_type：装配|注塑|冲压|SMT|焊接|包装（前端受控下拉）
 * product_type：产品类型（电机/控制板/连接器…）；product_project：产品项目编号（P-2026-018）
 */
@Entity({ name: 't_line' })
export class Line {
  @PrimaryColumn({ length: 32 }) tenant_id: string;
  @PrimaryColumn({ length: 32 }) line_id: string;
  @ManyToOne(() => Tenant) @JoinColumn({ name: 'tenant_id' }) tenant: Tenant;
  @Column({ length: 64 }) name: string;
  @Column({ length: 32, default: '装配' }) process_type: string;
  @Column({ length: 64, default: '待补充' }) product_type: string;
  @Column({ length: 64, default: '-' }) product_project: string;
  @CreateDateColumn() created_at: Date;
  /** CMC 产线主键（production_lines.id）——v3.21 起新工位的产线元数据快照自 CMC，按此关联刷新 */
  @Column({ type: 'int', nullable: true }) cmc_line_id: number | null;
  /** CMC 工厂码（factories.code，如 GZ）——按工厂筛选/对账 */
  @Column({ length: 32, nullable: true }) factory_code: string | null;
}
