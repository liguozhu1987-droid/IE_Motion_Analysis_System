import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APP_CONFIG } from '../config/configuration';
import { AppConfig } from '../config/configuration';
import { BaseRepository } from './base.repository';
import { AiTask } from '../../entities/ai-task.entity';
import { AiUsageEvent } from '../../entities/ai-usage-event.entity';
import { AuditLog } from '../../entities/audit-log.entity';
import { StationCollaborator, LineShare } from '../../entities/collaboration.entity';
import { Element } from '../../entities/element.entity';
import { Improvement } from '../../entities/improvement.entity';
import { Line } from '../../entities/line.entity';
import { PasswordReset } from '../../entities/password-reset.entity';
import { Project } from '../../entities/project.entity';
import { Role, Permission, UserRole, RolePermission } from '../../entities/rbac.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { RuleSet } from '../../entities/rule-set.entity';
import { SsoUser, SsoUserMap } from '../../entities/sso.entity';
import { Station } from '../../entities/station.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { VideoAsset } from '../../entities/video-asset.entity';
import { VideoDerivative } from '../../entities/video-derivative.entity';
import { AiCustomDict } from '../../modules/ai-suggest/entities/ai-custom-dict.entity';
import { AiLlmProfile } from '../../modules/ai-suggest/entities/ai-llm-profile.entity';
import { AiSetting } from '../../modules/ai-suggest/entities/ai-setting.entity';
import { AiSuggestionBatch } from '../../modules/ai-suggest/entities/ai-suggestion-batch.entity';
import { AiSuggestion } from '../../modules/ai-suggest/entities/ai-suggestion.entity';
import { AiWasteBatch } from '../../modules/ai-waste/entities/ai-waste-batch.entity';
import { AiWasteFinding } from '../../modules/ai-waste/entities/ai-waste-finding.entity';
import { AiWasteIssue } from '../../modules/ai-waste/entities/ai-waste-issue.entity';
import { AiWasteKb } from '../../modules/ai-waste/entities/ai-waste-kb.entity';

/**
 * 全部实体（29 个类 / 25 文件）。必须显式列出而非 glob 路径：
 * 打包形态（Node SEA 单文件可执行程序）下实体类内联在 bundle 里，磁盘上不存在
 * entities/*.entity.js 文件，glob 会静默匹配 0 个 → TypeORM 无元数据直接崩。
 * 显式数组在 dev（node 直跑 dist）与 SEA 两种形态下行为完全一致。
 */
export const ENTITIES = [
  AiTask, AiUsageEvent, AuditLog, StationCollaborator, LineShare, Element, Improvement, Line,
  PasswordReset, Project, Role, Permission, UserRole, RolePermission, RefreshToken,
  RuleSet, Station, Tenant, User, VideoAsset, VideoDerivative,
  SsoUser, SsoUserMap,
  AiCustomDict, AiLlmProfile, AiSetting, AiSuggestionBatch, AiSuggestion,
  AiWasteBatch, AiWasteFinding, AiWasteIssue, AiWasteKb,
] as const;

/** 双数据源：DB_TYPE=mssql（SQL Server 生产）/ sqlite（开发演示）。
 *  synchronize 仅开发期开启；生产走 migrations（scripts/migrate.ts）。 */
export const typeOrmConfigFactory = (cfg: AppConfig) => {
  const common = {
    entities: [...ENTITIES],
    synchronize: cfg.nodeEnv !== 'production',
    logging: false as const,
    extra: { trustServerCertificate: true },
  };
  if (cfg.dbType === 'mssql') {
    return {
      ...common,
      type: 'mssql' as const,
      host: cfg.dbHost,
      port: cfg.dbPort,
      username: cfg.dbUser,
      password: cfg.dbPass,
      database: cfg.dbName,
      options: { encrypt: cfg.dbEncrypt, trustServerCertificate: true, requestTimeout: 60000 },
      pool: { min: 2, max: cfg.dbPoolMax, idleTimeoutMillis: 30000 },
    };
  }
  return {
    ...common,
    type: 'sqlite' as const,
    database: cfg.dbPath,
  };
};

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => typeOrmConfigFactory(cfg),
    }),
  ],
  providers: [{ provide: BaseRepository, useFactory: (ds: DataSource) => new BaseRepository(ds), inject: [DataSource] }],
  exports: [TypeOrmModule, BaseRepository],
})
export class DatabaseModule {}
