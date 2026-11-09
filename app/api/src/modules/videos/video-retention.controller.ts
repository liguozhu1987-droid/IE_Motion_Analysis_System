import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Req,
} from '@nestjs/common';
import { AuthedRequest, AuthUser } from '../../auth/auth-user.interface';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { RetentionAction, VideoRetentionService } from './video-retention.service';

/**
 * 源视频保留管理（站内可见的状态与操作入口）。
 * 前端现有页面没有「视频库列表」，本契约先保证列表/详情都可取到
 * retention_status / retention_until / days_left / can_manage，
 * 工作台详情提示按同一契约渲染（见 docs/deployment/DEPLOY-CONFIG.md §12）。
 */
@Controller('videos/assets')
export class VideoRetentionController {
  constructor(private readonly retention: VideoRetentionService) {}

  private userOf(req: AuthedRequest): AuthUser {
    const user = (req as unknown as { user?: AuthUser }).user;
    if (!user) throw new BadRequestException('缺少登录用户上下文');
    return user;
  }

  @Get()
  @RequirePermission('station:read')
  async list(@Req() req: AuthedRequest) {
    return { items: await this.retention.listAssets(this.userOf(req)) };
  }

  @Get(':name')
  @RequirePermission('station:read')
  async detail(@Req() req: AuthedRequest, @Param('name') name: string) {
    return this.retention.getAsset(name, this.userOf(req));
  }

  /**
   * 保留决定：extend=再保留 N 天 / permanent=永久保留。
   * 权限在 service 内收口：上传者本人或全权管理员，其余返回 404（不暴露存在性）。
   */
  @Post(':name/retention')
  @RequirePermission('station:read')
  async decide(
    @Req() req: AuthedRequest,
    @Param('name') name: string,
    @Body() body: { action?: string },
  ) {
    const action = (body?.action ?? '').trim();
    if (action !== 'extend' && action !== 'permanent') {
      throw new BadRequestException("action 只能是 'extend'（再保留）或 'permanent'（永久保留）");
    }
    const user = this.userOf(req);
    return this.retention.setDecision(name, action as RetentionAction, user, req.ip ?? '');
  }

  /**
   * 立即硬删（不做回收站）：源文件 + 派生文件/行一并删除，写审计（来源 manual）。
   * 权限：上传者本人或全权管理员。
   */
  @Delete(':name')
  @RequirePermission('station:read')
  async remove(@Req() req: AuthedRequest, @Param('name') name: string) {
    return this.retention.deleteNow(name, this.userOf(req), req.ip ?? '');
  }
}
