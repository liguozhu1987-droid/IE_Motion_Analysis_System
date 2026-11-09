import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * AI 模块键值设置（v3.31：LLM 网关配置 UI 化的存储层）。
 * 键约定：ai_enabled ('1'/'0') / llm_base_url / llm_api_key / llm_model。
 * 读取语义：DB 行存在即优先（管理员界面改的生效），缺失回落 .env（AI_SUGGEST_ENABLED / AI_LLM_*）。
 * 单行键值表，无租户列（系统级配置，仅管理员可写）。
 */
@Entity({ name: 't_ai_setting' })
export class AiSetting {
  @PrimaryColumn({ length: 64 })
  setting_key: string;

  @Column({ type: 'text' })
  setting_value: string;

  @Column({ length: 32, nullable: true })
  updated_by: string | null;

  @CreateDateColumn()
  created_at: Date;
}
