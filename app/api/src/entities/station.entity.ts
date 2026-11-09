import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

/** 工位（MVP 3 表之 t_station，扩展 tenant_id/created_by） */
@Entity({ name: 't_station' })
export class Station {
  @PrimaryColumn({ length: 32 }) station_id: string;
  @Column({ length: 32 }) tenant_id: string;
  @ManyToOne(() => Tenant) @JoinColumn({ name: 'tenant_id' }) tenant: Tenant;
  @Column({ length: 32 }) line_id: string;
  @Column({ length: 64 }) name: string;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) ct: number | null;
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true }) tt: number | null;
  @Column({ type: 'int', default: 1 }) version: number; // = 生效 bol_version 指针
  @Column({ length: 32, nullable: true }) updated_by: string | null;
  @Column({ type: 'datetime', nullable: true }) updated_at: Date | null;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @CreateDateColumn() created_at: Date;
  /** v3.42 归属人（工位级隔离/共享的判定基准）；存量=created_by（建位人，用户决策 #4） */
  @Column({ length: 32, nullable: true }) owner_user_id: string | null;
  /** CMC 项目号（cbco_records.program_number）——驾驶舱"产品项目"维度；基础信息以 CMC 为准 */
  @Column({ length: 32, nullable: true }) program_number: string | null;
  /** CMC 产线主键（production_lines.id）——反查/对账用 */
  @Column({ type: 'int', nullable: true }) cmc_line_id: number | null;
  /**
   * v3.43 AI 分解操作区 ROI（归一化 JSON 字符串 {"x","y","w","h"}，0–1）。
   * 逐工位标定：换机位/换工位必须重标（REAL-VIDEO-TEST §7.4 教训，原硬编码只适配 PA10）。
   * null = 未标定，前端算法回退内置默认值。
   */
  @Column({ length: 64, nullable: true }) roi: string | null;
  /**
   * v3.44 P2-1 ROI 功能区子区（HOI 对象层）：JSON 数组 [{"name","x","y","w","h"}]，
   * 坐标相对操作区 ROI（ROI 内再划功能子区）。质心进区停留→跟随→离开 = 拿取该区物体。
   * null = 未配置，HOI 对象推断静默关闭（分析行为与 v3.43 完全一致）。
   */
  @Column({ type: 'nvarchar', nullable: true }) roi_zones: string | null;
  /**
   * v3.44 P2-2 SOP 期望步骤序列（封闭词表自动命名）：JSON 数组 [{"verb","object"}]，
   * verb ∈ motion_standard 词表（service 层校验）。候选序列按 LCS 对齐 SOP，
   * 命中步骤自动命名；漏步/重复/顺序异常只提示不定罪。
   */
  @Column({ type: 'nvarchar', nullable: true }) sop_steps: string | null;
}
