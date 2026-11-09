import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { AiSuggestService } from './ai-suggest.service';
import {
  AdoptAiSuggestionDto, CreateDictDto, CreateLlmProfileDto, GenerateSuggestionsQuery, ListSuggestionsQuery,
  RejectAiSuggestionDto, SetQuotaDto, TestLlmConfigDto, UpdateDictDto, UpdateLlmConfigDto, UpdateLlmProfileDto,
} from './dto';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser, AuthedRequest } from '../../auth/auth-user.interface';
import { StationsService } from '../stations/stations.service';

/**
 * AI 改善建议接口（规格书 §4；全局前缀 /api）。
 * 开关 AI_SUGGEST_ENABLED=false → 服务层 503；权限不足 → 守卫 403。
 * v3.46 双来源线：generate/list 均可带 ?source=mixed|manual|ai_assisted（缺省 mixed=legacy 全量口径，
 * 与存量批次默认值一致——无 query 参数的 legacy 契约逐字节不变）；幂等/409/缓存按 source 隔离。
 */
@Controller('stations/:stationId/ai-suggestions')
export class AiSuggestStationController {
  constructor(
    private readonly svc: AiSuggestService,
    private readonly stations: StationsService,
  ) {}

  /** 生成（幂等槽位 200/409/429；失败重开不计费）——幂等语义统一 200。
   *  v3.46：source 可选（缺省 mixed=legacy 全量口径，与存量批次默认值相同）
   *  v3.55：生成会消耗 LLM 配额并写入该工位批次 → 按可写范围校验（与 elements 提交同口径） */
  @Post('generate')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async generate(
    @Param('stationId') stationId: string,
    @Query() query: GenerateSuggestionsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    await this.stations.assertWritable(stationId, user.userId, user.roles);
    this.svc.setUserFlags(user.userId, user.roles, user.permissions);
    return this.svc.generate(stationId, user.userId, (query.source as any) ?? 'mixed').then((r) => r.payload);
  }

  /** 建议列表（含 validation_trace、批次状态与生成时间）。
   *  v3.46：source 可选（缺省=legacy 全量不过滤；传了按来源线过滤批次与建议）
   *  v3.55：按可见范围校验（读端点，防读取他人工位的建议与批次） */
  @Get()
  @RequirePermission('suggestion:generate')
  async list(
    @Param('stationId') stationId: string,
    @Query() query: ListSuggestionsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    await this.stations.assertReadable(stationId, user.userId, user.roles, user.dataScope);
    return this.svc.list(stationId, query.version, undefined, query.source as any);
  }
}

@Controller('ai-suggestions')
export class AiSuggestionController {
  constructor(
    private readonly svc: AiSuggestService,
    private readonly stations: StationsService,
  ) {}

  /**
   * v3.55 对象级写守卫：按建议所属工位反查 → assertWritable。
   * 采纳会写入 t_improvement（改善任务），否决会改写建议状态——
   * 路径参数是 suggestion_id 而非 station_id，此前无任何资源级校验，
   * 同租户任意有 suggestion:generate 的人都能采纳/否决**他人工位**的 AI 建议。
   */
  private async assertSuggestionWritable(id: string, user: AuthUser) {
    const stationId = await this.svc.stationIdOfSuggestion(id);
    await this.stations.assertWritable(stationId, user.userId, user.roles);
  }

  /** 采纳：红线未确认 422 REDLINE_CONFIRM_REQUIRED → 事务双写 t_improvement(source=ai) */
  @Post(':id/adopt')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async adopt(
    @Param('id') id: string,
    @Body() body: AdoptAiSuggestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertSuggestionWritable(id, user);
    return this.svc.adopt(id, user.username, body.confirmations);
  }

  /** 否决 */
  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('suggestion:generate')
  async reject(
    @Param('id') id: string,
    @Body() body: RejectAiSuggestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.assertSuggestionWritable(id, user);
    return this.svc.reject(id, user.username, body.reason);
  }
}

/** AI 治理（配额 + 自定义类型 + config 只读） */
@Controller('ai-custom-dict')
export class AiDictController {
  constructor(private readonly svc: AiSuggestService) {}

  @Get()
  @RequirePermission('ai:governance')
  list() {
    return this.svc.dictList();
  }

  @Post()
  @RequirePermission('ai:governance')
  create(@Body() body: CreateDictDto, @CurrentUser() user: AuthUser) {
    return this.svc.dictCreate(body, user.username, user.tenantId);
  }

  @Put(':id')
  @RequirePermission('ai:governance')
  update(@Param('id') id: string, @Body() body: UpdateDictDto) {
    return this.svc.dictUpdate(id, body);
  }

  @Delete(':id')
  @RequirePermission('ai:governance')
  remove(@Param('id') id: string) {
    return this.svc.dictRemove(id);
  }
}

@Controller('users/:id/ai-quota')
export class AiQuotaController {
  constructor(private readonly svc: AiSuggestService) {}

  @Get()
  @RequirePermission('user:write')
  get(@Param('id') id: string) {
    return this.svc.quotaGet(id);
  }

  @Put()
  @RequirePermission('user:write')
  set(@Param('id') id: string, @Body() body: SetQuotaDto, @CurrentUser() user: AuthUser) {
    return this.svc.quotaSet(id, body.ai_quota, user.username);
  }
}

@Controller('ai-suggestions')
export class AiConfigController {
  constructor(private readonly svc: AiSuggestService) {}

  /** config 只读（供设置页；ai:governance 或 user:read） */
  @Get('config')
  @RequirePermission('ai:governance', 'user:read')
  config(@CurrentUser() user: AuthUser) {
    return this.svc.config(user.userId);
  }

  /** LLM 网关配置读取（v3.31；api_key 只回脱敏值） */
  @Get('llm-config')
  @RequirePermission('user:write', 'ai:governance')
  llmConfig() {
    return this.svc.llmConfigGet();
  }

  /** LLM 网关配置写入（v3.31；服务开关/Base URL/Model/API Key——仅 user:write） */
  @Put('llm-config')
  @HttpCode(200)
  @RequirePermission('user:write')
  setLlmConfig(@Body() body: UpdateLlmConfigDto, @CurrentUser() user: AuthUser) {
    return this.svc.llmConfigSet(body, user.username);
  }

  /** LLM 连接测试（v3.32；零 token 探活 + 1 token 验证，表单值 dry-run 不落库） */
  @Post('llm-config/test')
  @HttpCode(200)
  @RequirePermission('user:write')
  testLlmConfig(@Body() body: TestLlmConfigDto) {
    return this.svc.llmConfigTest(body);
  }

  /** AI 功能端到端自测（v3.35；真实 LLM→解析→三轮校验→数字计算全链，样例工位不落库不扣配额） */
  @Post('llm-config/e2e-test')
  @HttpCode(200)
  @RequirePermission('user:write')
  e2eTestLlmConfig(@Body() body: TestLlmConfigDto) {
    return this.svc.llmE2eTest(body);
  }

  // ───────────── 连接配置 profiles（v3.40：多配置单活，「启用」即切换生效连接） ─────────────

  /** 连接配置清单（api_key 只回脱敏值；启用的排最前） */
  @Get('llm-profiles')
  @RequirePermission('user:write', 'ai:governance')
  llmProfiles() {
    return this.svc.llmProfilesList();
  }

  /** 新增连接配置（当前无启用项时自动启用为首条） */
  @Post('llm-profiles')
  @RequirePermission('user:write')
  createLlmProfile(@Body() body: CreateLlmProfileDto, @CurrentUser() user: AuthUser) {
    return this.svc.llmProfileCreate(body, user.username);
  }

  /** 更新连接配置（api_key 缺省=不改；空串=清空回落 .env） */
  @Put('llm-profiles/:id')
  @HttpCode(200)
  @RequirePermission('user:write')
  updateLlmProfile(@Param('id') id: string, @Body() body: UpdateLlmProfileDto) {
    return this.svc.llmProfileUpdate(id, body);
  }

  /** 启用（切换生效配置；同一时刻仅一条启用） */
  @Put('llm-profiles/:id/activate')
  @HttpCode(200)
  @RequirePermission('user:write')
  activateLlmProfile(@Param('id') id: string) {
    return this.svc.llmProfileActivate(id);
  }

  /** 删除连接配置（启用中的 409——先启用其他配置再删） */
  @Delete('llm-profiles/:id')
  @RequirePermission('user:write')
  removeLlmProfile(@Param('id') id: string) {
    return this.svc.llmProfileRemove(id);
  }
}
