import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { StationsService } from './stations.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { AuthedRequest } from '../../auth/auth-user.interface';

/** 每个字段必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性 */
class CreateStationDto {
  @IsString() @Matches(/^[A-Za-z0-9]+-ST\d{2}$/, { message: 'station_id 须符合 L01-ST01 / BJFA1-ST01 形式（产线码-ST序号）' })
  station_id!: string;
  @IsString() @Matches(/^[A-Za-z0-9]+$/, { message: 'line_id 须与产线码一致（L01 / BJFA1）' })
  line_id!: string;
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(600) tt?: number;
}

/**
 * 自 CMC 创建工位（v3.21 向导唯一入口）：基础信息全部实时取自 CMC。
 * v3.22：station_id 改为可选——用户可自行维护（如 PA10），不传则按
 * {CMC产线码}-ST{序号} 自动生成。两种路径共用既有校验（格式/前缀/唯一性在 service 层）。
 */
class CreateStationFromCmcDto {
  @IsNumber() cmc_line_id!: number;
  @IsOptional() @IsString() @MaxLength(32) station_id?: string;
  @IsOptional() @IsString() @MaxLength(32) program_number?: string;
  @IsString() @MaxLength(64) name!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(600) tt?: number;
}

class PatchStationDto {
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(600) tt?: number;
  /**
   * v3.43 AI 分解操作区 ROI：归一化 JSON 字符串 {"x":0.18,"y":0.30,"w":0.60,"h":0.50}（0–1，x+w≤1、y+h≤1）。
   * 传 null 清除标定（回退内置默认）。service 层做 JSON 结构与取值范围校验。
   * v3.44 放宽到 128：拖拽坐标的浮点噪声（0.6000000000000001）曾把 JSON 顶过 64 字符（400 实锤），
   * service 层会四舍五入到 4 位小数后再落库。
   */
  @IsOptional() @IsString() @MaxLength(128) roi?: string | null;
  /**
   * v3.44 P2-1 ROI 功能区子区：JSON 数组字符串 [{"name":"扫码枪卡位","x":0.1,"y":0.2,"w":0.3,"h":0.4}]，
   * 坐标相对操作区 ROI（0–1）。传 null 清除。service 层做结构与取值校验（≤8 区、名称唯一）。
   */
  @IsOptional() @IsString() @MaxLength(4000) roi_zones?: string | null;
  /**
   * v3.44 P2-2 SOP 期望步骤序列：JSON 数组字符串 [{"verb":"拿取","object":"后横梁"}]，
   * verb 必须在 motion_standard 封闭词表内（service 层用 RulesService 校验）。传 null 清除。
   */
  @IsOptional() @IsString() @MaxLength(4000) sop_steps?: string | null;
}

/** v3.42 共享 DTO */
class ShareDto {
  @IsString() @MaxLength(32) user_id!: string;
  @IsString() @Matches(/^(editor|viewer)$/, { message: 'acl_role 仅允许 editor / viewer' })
  acl_role!: string;
}

class ShareLineDto extends ShareDto {
  @IsString() @MaxLength(32) line_id!: string;
}

@Controller('stations')
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  /** v3.42：列表按 ACL 过滤——admin/全权角色全量；普通用户 = 我的 + 共享给我（v3.55 叠加 data_scope） */
  @Get()
  @RequirePermission('station:read')
  list(@Query('line_id') lineId: string, @Req() req: AuthedRequest) {
    return this.stations.listVisible(lineId || undefined, req.user!.userId, req.user!.roles, req.user!.dataScope);
  }

  /** 共享弹窗用户候选——必须挂在 @Get(':id') 之前，否则 'share-candidates' 被当工位 id 吃掉（404 实锤 v3.42） */
  @Get('share-candidates')
  @RequirePermission('station:write')
  shareCandidates(@Req() req: AuthedRequest) {
    return this.stations.shareCandidates(req.user!.tenantId);
  }

  /** 我共享出去的整线授权清单——同上，静态段先于 :id */
  @Get('line-shares')
  @RequirePermission('station:read')
  myLineShares(@Req() req: AuthedRequest) {
    return this.stations.myLineShares(req.user!.tenantId, req.user!.userId);
  }

  /**
   * 工位详情（v3.55：读端点补资源级 ACL 守卫）。
   * 此前只受 RBAC「station:read」保护 → 任何同租户用户可直接按 id 拉取他人工位主数据。
   * 现按可见范围判定（owner / 协作者 / 产线共享 / data_scope），不可见 → 403。
   */
  @Get(':id')
  @RequirePermission('station:read')
  async get(@Param('id') id: string, @Req() req: AuthedRequest) {
    await this.stations.assertReadable(id, req.user!.userId, req.user!.roles, req.user!.dataScope);
    return this.stations.get(id);
  }

  @Post()
  @RequirePermission('station:write')
  create(@Body() dto: CreateStationDto, @Req() req: AuthedRequest) {
    return this.stations.create({
      ...dto, operator: req.user!.username, tenantId: req.user!.tenantId,
      ownerUserId: req.user!.userId,
    });
  }

  /**
   * 自 CMC 创建工位（v3.21）：向导唯一建工位入口。
   * CMC 全程只读（产线存在性/项目分配/cbco 项目信息均为 SELECT）；写入只落本地库。
   * v3.22：station_id 可选手动录入（为空自动生成）。v3.42：owner = 操作人。
   */
  @Post('from-cmc')
  @RequirePermission('station:write')
  createFromCmc(@Body() dto: CreateStationFromCmcDto, @Req() req: AuthedRequest) {
    return this.stations.createFromCmc({
      cmc_line_id: dto.cmc_line_id,
      station_id: dto.station_id?.trim() || undefined,
      program_number: dto.program_number?.trim() || undefined,
      name: dto.name.trim(),
      tt: dto.tt,
      operator: req.user!.username,
      tenantId: req.user!.tenantId,
      ownerUserId: req.user!.userId,
    });
  }

  /** v3.42：编辑走资源级 ACL（owner/editor/admin），RBAC 的 station:write 仍由守卫把关 */
  @Patch(':id')
  @RequirePermission('station:write')
  patch(@Param('id') id: string, @Body() dto: PatchStationDto, @Req() req: AuthedRequest) {
    return this.stations.patch(id, { ...dto, operator: req.user!.username }, { userId: req.user!.userId, roles: req.user!.roles });
  }

  @Post(':id/retest')
  @RequirePermission('station:retest')
  async startRetest(@Param('id') id: string, @Req() req: AuthedRequest) {
    // v3.47 P0-B6：开复测会产生新版本并改写工位指针，属写操作，须过资源级校验
    await this.stations.assertWritable(id, req.user!.userId, req.user!.roles);
    return this.stations.startRetest(id, req.user!.username);
  }

  /** 作废复测：删当前版本草稿 + 版本指针回退（旧版天然只读不受影响） */
  @Delete(':id/retest')
  @RequirePermission('station:retest')
  async cancelRetest(@Param('id') id: string, @Req() req: AuthedRequest) {
    // v3.47 P0-B6：作废复测会物理删除当前版本全部要素，是全系统破坏性最强的操作之一
    await this.stations.assertWritable(id, req.user!.userId, req.user!.roles);
    return this.stations.cancelRetest(id, req.user!.username);
  }

  /** 版本清单（工作台"已封存版本"；版本自 t_element.bol_version 聚合推导） */
  @Get(':id/versions')
  @RequirePermission('station:read')
  async versions(@Param('id') id: string, @Req() req: AuthedRequest) {
    // v3.55：版本清单含各版 CT 汇总 → 属工位级敏感数据，须过可见范围
    await this.stations.assertReadable(id, req.user!.userId, req.user!.roles, req.user!.dataScope);
    return this.stations.versions(id);
  }

  /**
   * 删除工位（v3.21 主数据维护页）：级联删除全部版本要素与改善记录，不可恢复。
   * 前端必须先弹确认框（列出要素/改善条数）——本接口不设软删除，工位是分析对象根节点。
   * v3.42：仅 owner / admin 可删（用户决策 #2），资源级 ACL 校验。
   */
  @Delete(':id')
  @RequirePermission('station:write')
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.stations.remove(id, { userId: req.user!.userId, roles: req.user!.roles });
  }

  // ---------------- v3.42 共享与协作 ----------------

  /** 共享工位给同租户用户（editor/viewer）——仅 owner/admin */
  @Post(':id/collaborators')
  @RequirePermission('station:write')
  share(@Param('id') id: string, @Body() dto: ShareDto, @Req() req: AuthedRequest) {
    return this.stations.shareStation(id, dto.user_id, dto.acl_role, req.user!.username, { userId: req.user!.userId, roles: req.user!.roles });
  }

  /** 移除工位协作者 */
  @Delete(':id/collaborators/:userId')
  @RequirePermission('station:write')
  unshare(@Param('id') id: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.stations.unshareStation(id, userId, { userId: req.user!.userId, roles: req.user!.roles });
  }

  /** 工位协作者清单 */
  @Get(':id/collaborators')
  @RequirePermission('station:read')
  async collaborators(@Param('id') id: string, @Req() req: AuthedRequest) {
    // v3.55：协作者清单含他人工位归属信息 → 须过可见范围
    await this.stations.assertReadable(id, req.user!.userId, req.user!.roles, req.user!.dataScope);
    return this.stations.collaborators(id);
  }

  /** 整线共享（grantor 名下该线现有+未来工位） */
  @Post('line-shares')
  @RequirePermission('station:write')
  shareLine(@Body() dto: ShareLineDto, @Req() req: AuthedRequest) {
    return this.stations.shareLine(dto.line_id, dto.user_id, dto.acl_role, req.user!.username,
      { userId: req.user!.userId, roles: req.user!.roles, tenantId: req.user!.tenantId });
  }

  /** 取消整线共享 */
  @Delete('line-shares/:lineId/:userId')
  @RequirePermission('station:write')
  unshareLine(@Param('lineId') lineId: string, @Param('userId') userId: string, @Req() req: AuthedRequest) {
    return this.stations.unshareLine(lineId, userId, { userId: req.user!.userId, roles: req.user!.roles, tenantId: req.user!.tenantId });
  }
}
