import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * LLM 连接配置（v3.40：多配置 profiles，同一时刻仅一条启用）。
 * 「启用」= 正式生效的 API 连接；切换走事务（全清 0 后目标置 1），
 * 另有过滤唯一索引 UX_t_ai_llm_profile_single（WHERE enabled=1）在库层硬保证单活。
 * api_key 存原文（与 t_ai_setting 同口径），对外只回脱敏值；空串=未设（回落 .env）。
 * 系统级配置（无租户列），直接用原始仓库，不走 BaseRepository（其强制注入 tenant_id）。
 */
@Entity({ name: 't_ai_llm_profile' })
export class AiLlmProfile {
  @PrimaryColumn({ length: 36 })
  profile_id: string;

  @Column({ length: 64 })
  name: string;

  @Column({ length: 256 })
  base_url: string;

  @Column({ length: 256, default: '' })
  api_key: string;

  @Column({ length: 128 })
  model: string;

  /** 不写死 type——交给 TypeORM 按方言推断：mssql→BIT（与 migrate.ts 的 `enabled BIT NOT NULL DEFAULT 0` 一致），
   *  sqlite→BOOLEAN（隔离测试用）。写 `type:'boolean'` 时 mssql 驱动不认该类型名，DataSource 建不起来。 */
  @Column({ default: false })
  enabled: boolean;

  @Column({ length: 32, nullable: true })
  created_by: string | null;

  @CreateDateColumn()
  created_at: Date;
}
