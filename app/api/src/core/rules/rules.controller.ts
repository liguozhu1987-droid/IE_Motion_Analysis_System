import { Controller, Get, Post, Body, Param, NotFoundException } from '@nestjs/common';
import { RulesService } from './rules.service';
import { RequirePermission } from '../../rbac/require-permission.decorator';

/** 规则管理：查看/发布/列表。GET 需 rule:read；发布需 rule:write（安全默认：不标注=拒绝）。 */
@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  @RequirePermission('rule:read')
  snapshot() {
    return this.rules.snapshot();
  }

  @Get('sets')
  @RequirePermission('rule:read')
  async listSets() {
    return this.rules.listAll();
  }

  /**
   * 读取某组生效规则的完整内容（规则管理页的编辑基础）。
   * 声明在 'sets' 之后：Nest 按声明顺序匹配，字面量路由优先于参数路由。
   */
  @Get(':code')
  @RequirePermission('rule:read')
  content(@Param('code') code: string) {
    try {
      const entry = this.rules.getActive(code);
      return { code, version: entry.version, source: entry.source, content: entry.json };
    } catch {
      throw new NotFoundException(`规则集 ${code} 不存在（DB 与文件均无）`);
    }
  }

  @Post(':code/publish')
  @RequirePermission('rule:write')
  async publish(@Param('code') code: string, @Body() body: { content: any; operator?: string }) {
    const r = await this.rules.publish(code, body.content, body.operator ?? 'unknown');
    // version=实际发布版本（撞车时已自动顺延）；bumped=true 表示调用方填的版本号已发布过
    return { rule_set_id: r.rule_set_id, code, version: r.version, bumped: r.bumped };
  }
}
