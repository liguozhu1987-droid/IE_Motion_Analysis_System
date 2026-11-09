import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ElementsService } from './elements.service';
import { ConfirmVaClassDto, ImportCsvDto, SubmitElementsDto, UpdateVaClassDto } from './dto';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';

/**
 * 要素分解接口（MVP features/elements 平移）。
 * 权限契约：读 element:read / 写 element:write / VA 改判 element:va-override。
 */
@Controller('stations/:id/elements')
export class ElementsController {
  constructor(private readonly elements: ElementsService) {}

  /**
   * 要素明细（v3.55：读端点补资源级 ACL 守卫）。
   * 要素明细是最敏感的一层（含 ST/VA 判定/浪费类型）——此前只受 RBAC 保护，
   * 任何同租户用户可直接按 id 拉取他人工位全部要素。
   */
  @Get()
  @RequirePermission('element:read')
  async list(@Param('id') id: string, @CurrentUser() user: AuthUser, @Query('version') version?: string) {
    await this.elements.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.elements.list(id, version ? Number(version) : undefined);
  }

  @Post('validate')
  @RequirePermission('element:write')
  async validate(@Param('id') id: string, @Body() body: SubmitElementsDto, @CurrentUser() user: AuthUser) {
    // v3.55：纯校验（不落库）但会暴露工位存在性并返回该工位的校验规则 → 按读权限收口
    await this.elements.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.elements.validate(id, body);
  }

  @Post('submit')
  @RequirePermission('element:write')
  async submit(@Param('id') id: string, @Body() body: SubmitElementsDto, @CurrentUser() user: AuthUser) {
    // v3.47 P0-B6：RBAC 之上补资源级校验（这个工位归不归你管）
    await this.elements.assertWritable(id, user.userId, user.roles);
    return this.elements.submit(id, body, user.username);
  }

  @Post('import')
  @RequirePermission('element:write')
  async importCsv(@Param('id') id: string, @Body() body: ImportCsvDto, @CurrentUser() user: AuthUser) {
    await this.elements.assertWritable(id, user.userId, user.roles);
    return this.elements.importCsv(id, body.csv, user.username);
  }

  @Get('export')
  @RequirePermission('element:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="elements.csv"')
  async exportCsv(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    // v3.55：导出与列表同敏感度，须过可见范围
    await this.elements.assertReadable(id, user.userId, user.roles, user.dataScope);
    return this.elements.exportCsv(id);
  }

  /**
   * VA 改判（v3.55：对象级写守卫）。
   * 路径参数是 element_id → 按要素反查所属工位判写权。
   * 此前任何持 element:va-override 的用户都能改判他人工位的 VA 分类，
   * 且会连带触发该工位 CT 重算（等于间接改写他人工位的分析结论）。
   */
  @Patch(':elementId/va-class')
  @RequirePermission('element:va-override')
  async updateVAClass(@Param('elementId') elementId: string, @Body() body: UpdateVaClassDto, @CurrentUser() user: AuthUser) {
    await this.elements.assertElementWritable(elementId, user.userId, user.roles);
    return this.elements.updateVAClass(elementId, body, user.username);
  }

  /** VA 确认（v3.55：同 va-class，按要素反查工位判写权） */
  @Post(':elementId/va-confirm')
  @RequirePermission('element:va-override')
  async confirmVAClass(@Param('elementId') elementId: string, @Body() body: ConfirmVaClassDto, @CurrentUser() user: AuthUser) {
    await this.elements.assertElementWritable(elementId, user.userId, user.roles);
    return this.elements.confirmVAClass(elementId, body, user.username);
  }
}
