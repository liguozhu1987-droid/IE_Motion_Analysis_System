import { Controller, Get, Param } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { StationsService } from '../stations/stations.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';

/**
 * 分析接口（MVP routes.js /api/stations/:id/analysis、/api/lines/:lineId/analysis 平移）。
 * GET 为即时计算（纯读，无副作用）→ 权限取 analysis:read。
 *
 * v3.55：读端点补资源级 ACL 守卫——分析结果含 CT/VA 判定/浪费类型，
 * 此前任何同租户用户可直接按 id 读取他人工位（产线级更是一次拿到整条线全部工位 CT）。
 */
@Controller('stations/:id/analysis')
export class StationAnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly stations: StationsService,
  ) {}

  @Get()
  @RequirePermission('analysis:read')
  async analyze(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.stations.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.analysis.analyzeStation(id);
  }
}

@Controller('lines/:lineId/analysis')
export class LineAnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly stations: StationsService,
  ) {}

  /**
   * 产线分析（v3.55：按可见工位收口）。
   * 过滤发生在引擎计算之前 → balance_rate / totals / bottleneck 全部基于可见工位重算，
   * 不会以聚合值形式泄露他人工位结果。产线内无一工位可见 → 404。
   */
  @Get()
  @RequirePermission('analysis:read')
  async analyzeLine(@Param('lineId') lineId: string, @CurrentUser() user: AuthUser) {
    const visibleIds = await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope);
    return this.analysis.analyzeLine(lineId, visibleIds);
  }
}
