import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AiWasteService } from './ai-waste.service';
import {
  ArchiveKbDto, CreateManualFindingDto, CreateManualIssueDto, ListKbQuery, ListWasteBatchesQuery,
  UpdateKbDto, UpdateManualFindingDto, UpdateManualIssueDto, UpdateWasteIssueDto,
  WasteItemsQuery, WasteLatestQuery,
} from './dto';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { StationsService } from '../stations/stations.service';

/**
 * P3-9 浪费识别 + 改善问题清单接口（v3.45 起双来源线；全局前缀 /api）。
 *
 * 边界铁律：与分解工作台 AI 建议接口（/ai-suggestions）完全独立——
 * 路由前缀 /ai-waste、独立控制器、独立 service；权限沿用 suggestion:generate 权限点
 * （同一权限域：都是「让 AI 产出待审建议」，用户角色模型不变）。
 *
 * 双线端点（设计 D1）：generate = AI 自动分解线（source 缺省 ai_assisted，契约零改动）；
 * generate-manual = 手工分解线（新端点，不动现有端点形态——规避 body DTO 与 whitelist 兼容风险）。
 */
@Controller('stations/:stationId/ai-waste')
export class AiWasteStationController {
  constructor(
    private readonly svc: AiWasteService,
    private readonly stations: StationsService,
  ) {}

  /** 识别生成·AI 分解线（幂等 200 / 进行中 409 / 无 AI 要素 400 / 服务关 503）
   *  v3.55：生成会写入该工位批次 → 按可写范围校验 */
  @Post('generate')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async generate(@Param('stationId') stationId: string, @CurrentUser() user: AuthUser) {
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    return this.svc.generate(stationId, user.userId).then((r) => r.payload);
  }

  /**
   * 识别生成·手工分解线（v3.45 新增；P0-1）。
   * 载荷同 generate（element_source='manual'、prompt_version='WV2'、含 ct/summary）；
   * 幂等/409/503 语义与 generate 完全对称，且按 source 相互隔离。
   * v3.55：按可写范围校验。
   */
  @Post('generate-manual')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async generateManual(@Param('stationId') stationId: string, @CurrentUser() user: AuthUser) {
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    return this.svc.generate(stationId, user.userId, 'manual').then((r) => r.payload);
  }

  /** 最新批次视图（findings + issues + 批次元信息 + ct/summary；无批 → 空结构）。
   *  ?source=manual|ai_assisted 可选，缺省 ai_assisted（不传即旧行为逐字节不变）。
   *  v3.55：按可见范围校验。 */
  @Get('latest')
  @RequirePermission('suggestion:generate')
  async latest(@Param('stationId') stationId: string, @Query() query: WasteLatestQuery, @CurrentUser() user: AuthUser) {
    await this.stations.assertReadable(stationId, user.userId, user.roles, user.dataScope);
    return this.svc.latest(stationId, query.source);
  }

  /** 批次历史（只读溯源；?source= 可选，缺省 ai_assisted）
   *  v3.55：按可见范围校验。 */
  @Get('batches')
  @RequirePermission('suggestion:generate')
  async batches(@Param('stationId') stationId: string, @Query() query: ListWasteBatchesQuery, @CurrentUser() user: AuthUser) {
    await this.stations.assertReadable(stationId, user.userId, user.roles, user.dataScope);
    return this.svc.listBatches(stationId, query.source);
  }

  // ─────────────────── v3.51：清单查询（AI 关停亦可查）+ 人工录入 + 知识库 ───────────────────

  /**
   * 合并清单查询（按工位唯一索引 station_id 检索）。
   * 与 latest 的差异：不依赖 AI 开关（AI 关闭时历史批次与人工清单照常返回）；
   * scope=all 跨全部历史批次；origin 可只看 AI 或只看人工。
   * v3.55：按可见范围校验。
   */
  @Get('items')
  @RequirePermission('suggestion:generate')
  async items(@Param('stationId') stationId: string, @Query() query: WasteItemsQuery, @CurrentUser() user: AuthUser) {
    await this.stations.assertReadable(stationId, user.userId, user.roles, user.dataScope);
    return this.svc.items(stationId, query.origin ?? 'all', query.scope ?? 'latest', query.source ?? 'ai_assisted');
  }

  /** 人工录入·浪费点（数字服务端计算；与 AI 产出同表并存，origin='manual'）
   *  v3.55：写入他人工位 → 按可写范围校验。 */
  @Post('manual/findings')
  @RequirePermission('suggestion:generate')
  async createFinding(
    @Param('stationId') stationId: string,
    @Body() body: CreateManualFindingDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    return this.svc.createManualFinding(stationId, body, user.username);
  }

  /** 人工录入·改善措施（v3.55：按可写范围校验） */
  @Post('manual/issues')
  @RequirePermission('suggestion:generate')
  async createIssue(
    @Param('stationId') stationId: string,
    @Body() body: CreateManualIssueDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    return this.svc.createManualIssue(stationId, body, user.username);
  }

  /** 手动整理进知识库（人工条目 + 可选已确认 AI 条目；按 source_ref 幂等）
   *  v3.55：按可写范围校验。 */
  @Post('kb/archive')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async archiveKb(
    @Param('stationId') stationId: string,
    @Body() body: ArchiveKbDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    return this.svc.archiveKb(stationId, body ?? {}, user.username);
  }

}

@Controller('ai-waste')
export class AiWasteManualController {
  constructor(
    private readonly svc: AiWasteService,
    private readonly stations: StationsService,
  ) {}

  /**
   * v3.55 对象级写守卫：按条目所属工位反查 → assertWritable。
   * 这些端点路径参数是 finding_id / issue_id 而非 station_id，此前无任何资源级校验。
   */
  private async assertFindingWritable(id: string, user: AuthUser) {
    const stationId = await this.svc.stationIdOfFinding(id);
    await this.stations.assertWritable(stationId, user.userId, user.roles);
  }

  private async assertIssueWritable(id: string, user: AuthUser) {
    const stationId = await this.svc.stationIdOfIssue(id);
    await this.stations.assertWritable(stationId, user.userId, user.roles);
  }

  /** 编辑人工浪费点（AI 产出不可编辑 → 409） */
  @Patch('findings/:id')
  @RequirePermission('suggestion:generate')
  async updateFinding(@Param('id') id: string, @Body() body: UpdateManualFindingDto, @CurrentUser() user: AuthUser) {
    await this.assertFindingWritable(id, user);
    return this.svc.updateManualFinding(id, body, user.username);
  }

  @Delete('findings/:id')
  @RequirePermission('suggestion:generate')
  async deleteFinding(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertFindingWritable(id, user);
    return this.svc.deleteManualFinding(id);
  }

  /** 编辑人工改善措施（AI 产出不可编辑 → 409） */
  @Patch('issues/:id')
  @RequirePermission('suggestion:generate')
  async updateIssue(@Param('id') id: string, @Body() body: UpdateManualIssueDto, @CurrentUser() user: AuthUser) {
    await this.assertIssueWritable(id, user);
    return this.svc.updateManualIssue(id, body, user.username);
  }

  @Delete('issues/:id')
  @RequirePermission('suggestion:generate')
  async deleteIssue(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertIssueWritable(id, user);
    return this.svc.deleteManualIssue(id);
  }

  /**
   * 知识库查询（全局控制器：?station_id= 时含跨工位通用条目；不传则本租户全部）。
   * v3.55：通用条目（station_id 为 NULL）属租户级公共资产，全租户可见；
   * 绑定具体工位的条目仅在该工位可见范围内可见——防止通过知识库列表反查他人工位的问题描述。
   */
  @Get('kb')
  @RequirePermission('suggestion:generate')
  async listKb(@Query() query: ListKbQuery, @CurrentUser() user: AuthUser) {
    const visibleIds = await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope);
    return this.svc.listKb({ ...query, tenant_id: user.tenantId, visibleStationIds: visibleIds });
  }

  /**
   * 知识库条目编辑（v3.55：按归属判写权）。
   * 绑定工位的条目 → 该工位可写者；通用条目（NULL）→ 创建者或管理员。
   */
  @Patch('kb/:id')
  @RequirePermission('suggestion:generate')
  async updateKb(@Param('id') id: string, @Body() body: UpdateKbDto, @CurrentUser() user: AuthUser) {
    await this.assertKbWritable(id, user);
    return this.svc.updateKb(id, body);
  }

  @Delete('kb/:id')
  @RequirePermission('suggestion:generate')
  async deleteKb(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.assertKbWritable(id, user);
    return this.svc.deleteKb(id);
  }

  /** 知识库写守卫：绑定工位 → 工位写权；通用条目 → 创建者或管理员 */
  private async assertKbWritable(id: string, user: AuthUser) {
    const info = await this.svc.kbGuardInfo(id);
    if (info.station_id) {
      await this.stations.assertWritable(info.station_id, user.userId, user.roles);
      return;
    }
    const isFull = user.roles.includes('sys_admin') || user.roles.includes('ie_admin');
    if (!isFull && info.created_by && info.created_by !== user.username) {
      throw new ForbiddenException(`通用知识条目 ${id} 仅创建者或管理员可修改`);
    }
  }
}

@Controller('ai-waste')
export class AiWasteIssueController {
  constructor(
    private readonly svc: AiWasteService,
    private readonly stations: StationsService,
  ) {}

  /**
   * 问题条目状态流转：已确认 → 复制进 t_improvement（source=ai，溯源 issue_id）；
   * 已忽略 → 终态。只有「待处理」可流转（重复流转 409）。
   * v3.55：结算会写入改善任务（他人工位）→ 按条目所属工位判写权。
   */
  @Post('issues/:id/settle')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async settle(
    @Param('id') id: string,
    @Body() body: UpdateWasteIssueDto,
    @CurrentUser() user: AuthUser,
  ) {
    const stationId = await this.svc.stationIdOfIssue(id);
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    return this.svc.settle(id, body.status, user.username);
  }
}
