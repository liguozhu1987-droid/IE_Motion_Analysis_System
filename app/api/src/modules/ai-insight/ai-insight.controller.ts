import { Body, Controller, Param, Post } from '@nestjs/common';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { AiInsightService } from './ai-insight.service';
import { StationsService } from '../stations/stations.service';

/**
 * AI 洞察接口（v3.53）。
 * 路由复用既有前缀：stations/:id/analysis/diagnose 与 stations/:id/compare/interpret，
 * 与 analysis / compare 模块同前缀但不同 HTTP 方法/子路径，互不冲突。
 * 租户隔离由全局 TenantGuard / TenantInterceptor 保证（与现有 analyze / compare 一致）。
 *
 * v3.55：洞察内容基于该工位的要素与对比结果 → 补可见范围守卫（防读取他人工位的诊断文案）。
 */
@Controller('stations/:id')
export class AiInsightController {
  constructor(
    private readonly insight: AiInsightService,
    private readonly stations: StationsService,
  ) {}

  @Post('analysis/diagnose')
  @RequirePermission('analysis:read')
  async diagnose(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.stations.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.insight.diagnose(id);
  }

  @Post('compare/interpret')
  @RequirePermission('compare:read')
  async interpret(@Param('id') id: string, @Body() body: { v1?: string; v2?: string }, @CurrentUser() user: AuthUser) {
    await this.stations.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.insight.interpretDiff(id, body?.v1, body?.v2);
  }
}
