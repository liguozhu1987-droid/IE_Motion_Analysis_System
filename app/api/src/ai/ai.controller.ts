import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsNumber, IsString, Length } from 'class-validator';
import { AiTaskService } from './ai-task.service';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { Public } from '../rbac/public.decorator';
import { AuthedRequest } from '../auth/auth-user.interface';
import { AiUsageService, AiUsageQuery } from './ai-usage.service';

/** 每个字段必须带装饰器：全局 ValidationPipe(whitelist:true) 会剥离无装饰器属性 */
class PolishDto {
  @IsArray() @IsString({ each: true }) element_ids!: string[];
  @IsString() @Length(1, 32) waste_type!: string;
  @IsString() @Length(1, 200) measure!: string;
  @IsNumber() est_save_s!: number;
  @IsString() @Length(1, 1) method!: string;
}

/**
 * AI 接口：提交润色任务 / 查任务状态。
 * AI_ENABLED=false → submit 返回 503，前端保持本地模板文案（降级路径）。
 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiTaskService,
    private readonly usageService: AiUsageService,
  ) {}

  /** 正式业务 AI 用量：按用户/产线/工位/功能聚合；服务端叠加租户与工位数据范围。 */
  @Get('usage/summary')
  @RequirePermission('suggestion:generate')
  async usageSummary(@Query() query: AiUsageQuery, @Req() req: AuthedRequest) {
    return this.usageService.summary(query, req.user!);
  }

  @Post('polish')
  @RequirePermission('ai:use')
  async polish(@Body() dto: PolishDto, @Req() req: AuthedRequest) {
    const task = await this.ai.submit('suggestion_polish', dto as unknown as Record<string, unknown>, req.user!.username);
    return task;
  }

  @Get('tasks/:id')
  @RequirePermission('ai:use')
  async task(@Param('id') id: string) {
    return this.ai.get(id);
  }

  @Get('tasks')
  @RequirePermission('ai:use')
  async tasks(@Req() req: AuthedRequest) {
    return this.ai.listByTenant(req.user!.tenantId);
  }

  /** 熔断/开关状态（前端展示"AI 不可用"角标） */
  @Public()
  @Get('status')
  status() {
    return this.ai.status();
  }
}
