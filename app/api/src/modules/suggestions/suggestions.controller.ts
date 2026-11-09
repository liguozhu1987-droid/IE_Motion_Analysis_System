import { Controller, Get, Param, Patch, Post, Body, Query } from '@nestjs/common';
import { SuggestionsService } from './suggestions.service';
import { AdoptCandidatesDto, UpdateStatusDto, ImprovementQuery } from './dto';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { StationsService } from '../stations/stations.service';

/**
 * 建议接口（MVP routes.js /api/stations/:id/suggestions/* 平移）。
 * 候选生成为即时计算（不落库）→ suggestion:generate；
 * 采纳写库 + 红线确认 → suggestion:adopt。
 */
@Controller('stations/:id/suggestions')
export class SuggestionsController {
  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly stations: StationsService,
  ) {}

  /**
   * 候选建议生成（v3.55：按可写范围校验）。
   * 该接口基于工位当前版本的要素做 ECRSA 映射，会暴露他人工位的浪费判定与收益估算；
   * 且采纳路径会落库 → 与 elements 提交同口径（可写范围）。
   */
  @Post('generate')
  @RequirePermission('suggestion:generate')
  async generate(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.stations.assertWritable(id, user.userId, user.roles);
    return this.suggestions.generateCandidates(id);
  }

  /** 采纳候选建议（落库 t_improvement）→ v3.55：按可写范围校验 */
  @Post('adopt')
  @RequirePermission('suggestion:adopt')
  async adopt(@Param('id') id: string, @Body() body: AdoptCandidatesDto, @CurrentUser() user: AuthUser) {
    await this.stations.assertWritable(id, user.userId, user.roles);
    return this.suggestions.adoptCandidates(id, body);
  }
}

/**
 * 改善建议清单/流转/建议书（MVP routes.js /api/improvements/* 平移）。
 * 清单按 suggestion:generate（读侧）；流转 suggestion:status。
 */
@Controller('improvements')
export class ImprovementsController {
  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly stations: StationsService,
  ) {}

  /** 改善任务清单（v3.55：按可见工位收口——只返回调用者可见工位的任务） */
  @Get()
  @RequirePermission('suggestion:generate')
  async list(
    @CurrentUser() user: AuthUser,
    @Query('station_id') stationId?: string,
    @Query('status') status?: string,
    @Query('line_id') lineId?: string,
    @Query('project_type') projectType?: string,
    @Query('process') process?: string,
    @Query('product_type') productType?: string,
  ) {
    const query: ImprovementQuery = {};
    if (stationId) query.station_id = stationId;
    if (status) query.status = status;
    if (lineId) query.line_id = lineId;
    if (projectType) query.project_type = projectType;
    if (process) query.process = process;
    if (productType) query.product_type = productType;
    const visibleIds = await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope);
    return this.suggestions.listImprovements(query, visibleIds);
  }

  /**
   * 状态流转（v3.55：补资源级写权校验）。
   * 此前只受 RBAC「suggestion:status」保护 → 同租户任意用户可改他人工位的任务状态
   * （实测曾把他人任务从「待实施」改成「已完成」，且状态机单向不可回退）。
   * 现按任务所属工位反查，走 assertWritable（owner / editor 协作者 / admin）。
   */
  @Patch(':impId/status')
  @RequirePermission('suggestion:status')
  async updateStatus(@Param('impId') impId: string, @Body() body: UpdateStatusDto, @CurrentUser() user: AuthUser) {
    await this.suggestions.assertImprovementWritable(impId, user.userId, user.roles);
    return this.suggestions.updateStatus(impId, body.status);
  }

  /** 建议书一页数据（v3.55：按可见范围校验——含问题描述与收益估算） */
  @Get(':impId/report')
  @RequirePermission('suggestion:generate')
  async report(@Param('impId') impId: string, @CurrentUser() user: AuthUser) {
    await this.suggestions.assertImprovementReadable(impId, user.userId, user.roles, user.dataScope);
    return this.suggestions.buildReport(impId, user.username);
  }
}
