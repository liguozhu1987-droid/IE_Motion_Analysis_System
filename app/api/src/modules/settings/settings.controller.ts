import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { RulesService } from '../../core/rules/rules.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { AuthedRequest } from '../../auth/auth-user.interface';

/**
 * 收益参数（benefit_params 规则集在线读写，写入走规则发布=可回滚）。
 * 公式固定：节省秒数 × 日产量 × 365 × 费率(元/h) ÷ 3600 × 70% 落地率；
 * 参数无默认值、未配置即阻断计算（MVP 文档03 口径延续）。
 */
@Controller('config')
export class SettingsController {
  constructor(private readonly rules: RulesService) {}

  @Get('benefit-params')
  @RequirePermission('settings:benefit-read')
  getParams() {
    const entry = this.rules.getActive('benefit_params');
    // 兼容 by_line 历史形态：合并为 lines 视图（只读派生，不落库；保存时由前端整体带回）
    const merged: any[] = [...(entry.json?.lines ?? [])];
    for (const [lineId, raw] of Object.entries<any>(entry.json?.by_line ?? {})) {
      if (!merged.some((l) => l?.line_id === lineId)) {
        merged.push({
          line_id: lineId,
          rate_yuan_per_hour: raw.rate_yuan_per_hour,
          daily_output: raw.daily_output,
          land_rate: raw.realization_rate ?? 0.7,
          configured_by: raw.configured_by,
          configured_at: raw.configured_at,
        });
      }
    }
    return {
      version: entry.version,
      source: entry.source,
      formula: 'save_s × daily_output × 365 × rate(元/h) ÷ 3600 × land_rate',
      lines: merged,
    };
  }

  @Post('benefit-params')
  @RequirePermission('settings:benefit-write')
  async putParams(@Body() body: { lines: any[] }, @Req() req: AuthedRequest) {
    const entry = this.rules.getActive('benefit_params');
    const content = { ...entry.json, lines: body.lines };
    // v3.19：publish 内部做版本号治理（同 code 撞车自动顺延），不再产同名 RV1.0 历史
    const r = await this.rules.publish('benefit_params', content, req.user!.username);
    return { rule_set_id: r.rule_set_id, version: r.version, lines: body.lines };
  }
}
