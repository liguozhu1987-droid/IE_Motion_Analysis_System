import { Controller, Get, Param, Query } from '@nestjs/common';
import { CompareService } from './compare.service';
import { StationsService } from '../stations/stations.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';

/**
 * 对比接口（MVP routes.js /api/stations/:id/compare、/compare/report 平移）。
 * v1=当前版（默认最新）、v2=对比版（默认次新）；历史版本可查看不可再对比。
 *
 * v3.55：读端点补资源级 ACL 守卫——对比结果含两版 CT/VA/收益估算。
 */
@Controller('stations/:id/compare')
export class CompareController {
  constructor(
    private readonly compare: CompareService,
    private readonly stations: StationsService,
  ) {}

  @Get()
  @RequirePermission('compare:read')
  async compareVersions(@Param('id') id: string, @CurrentUser() user: AuthUser, @Query('v1') v1?: string, @Query('v2') v2?: string) {
    await this.stations.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.compare.compareVersions(id, { v1, v2 });
  }

  @Get('report')
  @RequirePermission('compare:export')
  async report(@Param('id') id: string, @CurrentUser() user: AuthUser, @Query('v1') v1?: string, @Query('v2') v2?: string) {
    await this.stations.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.compare.buildCompareReport(id, { v1, v2 });
  }
}
