import {
  BadRequestException, Body, Controller, Get, Logger, NotFoundException, Param, Post, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { JwtService } from '@nestjs/jwt';
import { AuthUserLoader } from '../../auth/auth-user.loader';
import { AuthedRequest, AuthUser } from '../../auth/auth-user.interface';
import { Public } from '../../rbac/public.decorator';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { VideosService } from './videos.service';
import { DerivativeService, DerivativeKind, DERIVATIVE_KINDS } from './derivative.service';
import { requireStationRead, sendFileSafe } from './video-auth.helper';

/**
 * 视频派生端点（SPEC-VID-P0 §4，鉴权复用现有范式：
 * Bearer+station:read+assertReadable / @Public()+?token= 手动鉴权）。
 * :name = 源视频文件名 uuid.mp4（沿用 file/:name 参数风格）。
 */
@Controller('videos')
export class DerivativeController {
  private readonly log = new Logger('DerivativeController');

  constructor(
    private readonly videos: VideosService,
    private readonly derivatives: DerivativeService,
    private readonly jwt: JwtService,
    private readonly loader: AuthUserLoader,
  ) {}

  /**
   * P0-1 容量观测：派生目录实际占用 + 参数是否已配置 + 最近一次告警/淘汰。
   * 只回显总量，不暴露磁盘布局；用于上线前确认"VIDEO_DERIVED_MAX_GB 还没配"。
   */
  @Get('storage')
  @RequirePermission('station:read')
  async storage() {
    return this.derivatives.capacitySnapshot();
  }

  /** §4-1：入队派生（幂等；kinds 缺省 = proxy/sprite/index 全三种） */
  @Post(':name/derive')
  @RequirePermission('station:read')
  async derive(
    @Param('name') name: string,
    @Body() body: { kinds?: string[] },
    @Req() req: AuthedRequest,
  ) {
    const user = this.requireUser(req);
    await this.assertVideo(name, user);
    const kinds = (body?.kinds ?? undefined) as DerivativeKind[] | undefined;
    return this.derivatives.derive(name, kinds);
  }

  /** §4-2：该视频全部派生 meta 数组（status/fps/frames/duration_ms/size/retry） */
  @Get(':name/derivatives')
  @RequirePermission('station:read')
  async list(@Param('name') name: string, @Req() req: AuthedRequest) {
    const user = this.requireUser(req);
    await this.assertVideo(name, user);
    return this.derivatives.listMeta(name);
  }

  /**
   * §4-3：派生文件下发（<video>/<img> 用；token 走 ?token=）。
   * Range 206 由 sendFile 原生提供；callback 防 416 被全局过滤器转 500（§7.2）。
   */
  @Public()
  @Get(':name/derivative/:kind')
  async file(
    @Param('name') name: string,
    @Param('kind') kind: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const user = await requireStationRead(this.jwt, this.loader, req);
    if (kind !== 'proxy' && kind !== 'sprite') {
      throw new BadRequestException('kind 仅支持 proxy / sprite');
    }
    await this.assertVideo(name, user);
    const filePath = await this.derivatives.fileOf(name, kind);
    if (!filePath) throw new NotFoundException('派生未就绪或不存在');
    sendFileSafe(this.log, res, filePath, {
      'Accept-Ranges': 'bytes',
      'Content-Type': kind === 'proxy' ? 'video/mp4' : 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
    });
  }

  /** §4-4：单 kind JSON meta（预载前探活，不暴露列表；sprite/index 附带 json 载荷） */
  @Public()
  @Get(':name/derivative/:kind/meta')
  async meta(
    @Param('name') name: string,
    @Param('kind') kind: string,
    @Req() req: AuthedRequest,
  ) {
    const user = await requireStationRead(this.jwt, this.loader, req);
    if (!DERIVATIVE_KINDS.includes(kind as DerivativeKind)) {
      throw new BadRequestException('kind 仅支持 proxy / sprite / index');
    }
    await this.assertVideo(name, user);
    const meta = await this.derivatives.metaPayload(name, kind as DerivativeKind);
    if (!meta) throw new NotFoundException('派生记录不存在');
    return meta;
  }

  private requireUser(req: AuthedRequest): AuthUser {
    const user = (req as { user?: AuthUser }).user;
    if (!user) throw new UnauthorizedException('未登录');
    return user;
  }

  /** 名称白名单（仅 uuid.mp4）+ 存在性 + 资源级归属校验（防越权取他人视频派生） */
  private async assertVideo(name: string, user: AuthUser): Promise<void> {
    const filePath = this.videos.filePathOf(name);
    if (!filePath || !fs.existsSync(filePath)) throw new BadRequestException('视频文件不存在或名称非法');
    await this.videos.assertReadable(name, user);
  }
}
