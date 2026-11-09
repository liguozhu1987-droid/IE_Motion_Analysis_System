import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * AI 自定义字典（租户级；规格书 §1/§4）。
 * dict_type：waste_type（必填 va_class）| measure_type（必填 method_hint+action_class）。
 * code `^[a-z][a-z0-9_]{2,31}$`；name≤16 字；UQ(tenant,dict_type,code) 撞名拒绝。
 * 未声明 va_class 按 RNVA 保守处理（宁可误压不可误删）。
 */
@Entity({ name: 't_ai_custom_dict' })
export class AiCustomDict {
  @PrimaryColumn({ length: 36 }) dict_id: string;
  @Column({ length: 32, default: 'DEFAULT' }) tenant_id: string;
  @Column({ length: 16 }) dict_type: string; // waste_type|measure_type
  @Column({ length: 32 }) code: string;
  @Column({ length: 16 }) name: string;
  /** waste_type 必填：VA|RNVA|NVA */
  @Column({ length: 8, nullable: true }) va_class: string | null;
  /** measure_type 必填：E|C|R|S */
  @Column({ length: 4, nullable: true }) method_hint: string | null;
  /** measure_type 必填：取消|合并|压缩|重排|自动化|简化 */
  @Column({ length: 8, nullable: true }) action_class: string | null;
  /** 指向内置 code 的别名（按内置语义校验、展示用自定义名） */
  @Column({ length: 32, nullable: true }) alias_of: string | null;
  @Column({ length: 16, default: 'active' }) status: string;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @CreateDateColumn() created_at: Date;
}
