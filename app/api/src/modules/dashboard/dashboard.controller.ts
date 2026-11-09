import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { StationsService } from '../stations/stations.service';

/**
 * 综合看板（v3.3 集团驾驶舱；v3.42 改名并全角色开放，决策 #1）。
 * 聚合指标 + 多维分布 + 产线横评；只含聚合指标，不含要素明细（铁律）。
 * 维度筛选：region / company / process / product_type / project。
 *
 * v3.42 租户收口（SEC-13 实锤）：group:read 开放全角色后，
 * 跨租户聚合仅保留给 sys_admin / ie_admin（与 stations FULL_ACCESS_ROLES 同口径）；
 * 其他角色锁定本租户聚合——缓存键按 scope 分区（'ALL' vs tenantId），互不串味。
 *
 * v3.55 个人可见范围收口（关键修复）：「看板全角色开放」≠「看板显示全公司数据」。
 * 非全权角色的聚合只统计其可见工位（owner / 协作者 / 产线共享 / data_scope），
 * 平衡率、VA%、瓶颈清单等全部基于可见工位重算——这才是「个人工作台」视角的看板。
 */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly stations: StationsService,
  ) {}

  /** v3.42：跨租户权限 = 与工位 ACL 的全权角色集一致 */
  private crossTenant(user: AuthUser | null): boolean {
    const roles = user?.roles ?? [];
    return roles.includes('sys_admin') || roles.includes('ie_admin');
  }

  @Get('summary')
  @RequirePermission('group:read')
  async summary(
    @Query('region') region: string | undefined,
    @Query('company') company: string | undefined,
    @Query('process') process: string | undefined,
    @Query('product_type') product_type: string | undefined,
    @Query('project') project: string | undefined,
    @CurrentUser() user: AuthUser | null,
  ) {
    const visibleIds = user
      ? await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope)
      : null;
    return this.dashboard.summary(
      { region, company, process, product_type, project },
      user?.tenantId ?? 'DEFAULT',
      this.crossTenant(user),
      visibleIds,
    );
  }

  /** 跨公司改善任务列表（维度链与 summary 一致；VO 契约同 /improvements） */
  @Get('improvements')
  @RequirePermission('group:read')
  async improvements(
    @Query('region') region: string | undefined,
    @Query('company') company: string | undefined,
    @Query('process') process: string | undefined,
    @Query('product_type') product_type: string | undefined,
    @Query('project') project: string | undefined,
    @Query('status') status: string | undefined,
    @CurrentUser() user: AuthUser | null,
  ) {
    const visibleIds = user
      ? await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope)
      : null;
    return this.dashboard.improvements(
      { region, company, process, product_type, project, status },
      user?.tenantId ?? 'DEFAULT',
      this.crossTenant(user),
      visibleIds,
    );
  }
}
