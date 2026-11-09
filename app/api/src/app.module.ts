import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health/health.controller';
import { AppConfigModule } from './core/config/config.module';
import { DatabaseModule } from './core/database/database.module';
import { RulesModule } from './core/rules/rules.module';
import { AuthModule } from './auth/auth.module';
import { AuthOidcModule } from './auth/oidc/oidc.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { TenantGuard } from './tenant/tenant.guard';
import { TenantInterceptor } from './tenant/tenant.interceptor';
import { AuditModule } from './audit/audit.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AiModule } from './ai/ai.module';
import { AlertModule } from './core/alert/alert.module';
import { StationsModule } from './modules/stations/stations.module';
import { ElementsModule } from './modules/elements/elements.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { SuggestionsModule } from './modules/suggestions/suggestions.module';
import { CompareModule } from './modules/compare/compare.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { LinesModule } from './modules/lines/lines.module';
import { CmcModule } from './modules/cmc/cmc.module';
import { VideosModule } from './modules/videos/videos.module';
import { AiSuggestModule } from './modules/ai-suggest/ai-suggest.module';
import { AiWasteModule } from './modules/ai-waste/ai-waste.module';
import { AiInsightModule } from './modules/ai-insight/ai-insight.module';
import { AllExceptionsFilter } from './core/all-exceptions.filter';
import { MetricsInterceptor } from './core/metrics.interceptor';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RulesModule,   // 全局：规则双源加载+自检（启动 fail-fast）
    AuthModule,    // 全局：JwtAuthGuard + AuthUserLoader
    AuditModule,   // 全局：AuditService + AuditInterceptor
    AuthOidcModule, // v3.57 统一身份认证 OIDC 双轨（默认关；开关关闭时四个 OIDC 端点 404）
    AiModule,      // 全局：AI 任务队列 + LLM 网关
    AlertModule,   // 全局：告警监控（登录锁定/ai_task 堆积/错误率 → 日志 + 可选 SMTP 邮件）
    StationsModule,
    ElementsModule,
    AnalysisModule,
    SuggestionsModule,
    CompareModule,
    SettingsModule,
    UsersModule,
    RolesModule,      // 角色与权限中心（v3.50：角色CRUD + 权限矩阵分配 + 权限变更审计）
    DashboardModule,  // 集团综合驾驶舱（v3.3 跨租户聚合）
    LinesModule,      // 产线概览（v3.6 导航层：名称+状态徽标）
    CmcModule,        // CMC 产能系统集成（v3.21 跨库实时查询：工厂/产线/项目/分配关系）
    VideosModule,     // 工位视频上传/转码/播放（v3.28：ffmpeg 探测+MP4 归一化，覆盖 AVI/MKV/FLV/MOV-HEVC 等）
    AiSuggestModule,  // AI 改善建议（v3.30：三轮校验+幂等槽位+配额；AI_SUGGEST_ENABLED 默认关）
    AiWasteModule,    // P3-9 浪费识别+改善问题清单（AI 自动分解线专用；与 ai-suggest 相互独立）
    AiInsightModule,  // v3.53 AI 洞察：诊断/解读纯文案（复用全局 LlmGatewayService + Analysis/Compare）
  ],
  controllers: [HealthController],
  providers: [
    // 全局守卫链：JWT 认证 → 租户一致性 → RBAC 权限（顺序即执行序）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // 全局拦截器：指标 → 审计 → 租户上下文
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    AllExceptionsFilter,
  ],
})
export class AppModule {}
