import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * 规则集（规则库入库）。content = RV1.0 JSON 原文（va_rules/waste_triggers/
 * ecrsa_map/redline_keywords/benefit_params 五类），与 config/rules/*.json 完全兼容。
 * 每个 code 仅一条 is_active=1；发布新版本=插入+切换，可回滚。
 */
@Entity({ name: 't_rule_set' })
export class RuleSet {
  @PrimaryColumn({ length: 36 }) rule_set_id: string;
  @Column({ length: 32 }) code: string;
  @Column({ length: 16 }) version: string; // RV1.0
  @Column({ type: 'text' }) content: string; // JSON
  @Column({ type: 'int', default: 1 }) is_active: number;
  @Column({ type: 'int', default: 0 }) is_frozen: number; // W8 冻结标记
  @Column({ type: 'datetime', nullable: true }) effective_from: Date | null;
  @Column({ length: 32, nullable: true }) created_by: string | null;
  @CreateDateColumn() created_at: Date;
}
