import {
  BadRequestException, Body, Controller, Get, Logger, Param, Post, Query, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import { UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express/multer';
import * as fs from 'fs';
import * as path from 'path';
import * as multer from 'multer';
import type { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { AuthUserLoader } from '../../auth/auth-user.loader';
import { AuthedRequest, AuthUser } from '../../auth/auth-user.interface';
import { Public } from '../../rbac/public.decorator';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { VideosService } from './videos.service';
import { ChunkUploadService } from './chunk-upload.service';
import { resolveAuthUser, sendFileSafe } from './video-auth.helper';

/** 上传临时目录：转码/直通完成后即删除，只留 storage/videos/<uuid>.mp4 终态 */
const TMP_DIR = path.resolve(process.cwd(), 'storage', 'videos', 'tmp');

@Controller('videos')
export class VideosController {
  private readonly log = new Logger('VideosController');

  constructor(
    private readonly videos: VideosService,
    private readonly chunks: ChunkUploadService,
    private readonly jwt: JwtService,
    private readonly loader: AuthUserLoader,
  ) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  /**
   * 上传视频（分解工作台「格式不支持直播」时的回退入口 + AI 自动分解页服务器载入入口）：
   * 直存 → ffmpeg 探测 → 原生可播则直通、否则转 MP4 → 返回播放 URL。
   * 鉴权走常规 Bearer（上传是前端 fetch，带得了头）。
   * ?raw=1：调用方已确认浏览器能播原始编码（AI 页 canPlayType 预检），跳过转码；
   *          工作台不传，行为与 v3.28 一致。
   * 分片模式（SPEC-VID-P0 §7.1，契约锁定）：查询参数 uploadId/chunkIndex/chunkTotal
   *          三者齐全即分片（>8MB 规避 IIS maxAllowedContentLength 413）；逻辑下沉
   *          ChunkUploadService，末片返回与单文件上传完全相同的 ingest 结果。
   */
  @Post('upload')
  @RequirePermission('element:write') // 上传视频=分解工作台的写入动作（仅能写分解的人需要转码）
  @UseInterceptors(FileInterceptor('file', {
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        cb(null, TMP_DIR);
      },
      filename: (_req, file, cb) => {
        // 原名只进日志/探测，落盘用随机名（防中文名/特殊字符/穿越）
        const ext = (path.extname(file.originalname || '') || '.bin').toLowerCase().slice(0, 8);
        cb(null, `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: Number(process.env.VIDEO_MAX_MB ?? 2048) * 1024 * 1024, files: 1 },
  }))
  async upload(
    @Req() req: Request,
    @Query('raw') raw?: string,
    @Query('uploadId') uploadId?: string,
    @Query('chunkIndex') chunkIndex?: string,
    @Query('chunkTotal') chunkTotal?: string,
  ) {
    const file = req.file; // multer 落盘文件（@types/multer 增强）
    if (!file) throw new BadRequestException('未收到视频文件');
    const q = (req as unknown as { query?: Record<string, string> }).query ?? {};
    const hasChunkParams = q.uploadId !== undefined || q.chunkIndex !== undefined || q.chunkTotal !== undefined;
    try {
      // 上传者身份用于登记视频归属（v3.55：下载端点据此做跨租户收口）
      const uploader = (req as unknown as { user?: AuthUser }).user;
      const owner = uploader
        ? { userId: uploader.userId, username: uploader.username, tenantId: uploader.tenantId }
        : undefined;
      if (hasChunkParams) {
        // 分片模式：uploadId/chunkIndex/chunkTotal 三者必须齐全（契约 §7.1）
        if (!q.uploadId || q.chunkIndex === undefined || q.chunkTotal === undefined) {
          throw new BadRequestException('分片参数不齐全：需要 uploadId / chunkIndex / chunkTotal');
        }
        const body = (req as unknown as { body?: Record<string, unknown> }).body ?? {};
        return await this.chunks.handle(file, {
          uploadId: String(q.uploadId),
          chunkIndex: Number(q.chunkIndex),
          chunkTotal: Number(q.chunkTotal),
        }, {
          originalname: typeof body.originalname === 'string' ? body.originalname : undefined,
          raw: typeof body.raw === 'string' ? body.raw : undefined,
        }, owner);
      }
      this.log.log(`视频上传: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)}MB) → ${file.filename}`);
      // raw=1：调用方（AI 自动分解页）已 canPlayType 确认浏览器能播原始编码，免转码等待
      return await this.videos.ingest(file.path, file.originalname, raw === '1', owner);
    } catch (e) {
      // 失败即清临时文件，不留垃圾（分片模式下 file.path 已移走，unlink 为 no-op）
      try { fs.unlinkSync(file.path); } catch { /* 已删 */ }
      throw e;
    }
  }

  /**
   * 播放终态文件（Range 支持由 res.sendFile 原生提供——<video> 拖动进度依赖 206）。
   * @Public + 手动鉴权：<video> 标签发不了 Authorization 头，token 走 ?token= 查询参数
   * （内网工具可接受；也可用 Authorization 头直连调试）。校验 access token + station:read 权限。
   *
   * v3.55：补资源级归属校验——此前任何登录用户凭文件名即可下载任意租户视频。
   */
  @Public()
  @Get('file/:name')
  async file(@Param('name') name: string, @Req() req: AuthedRequest, @Res() res: Response) {
    const user = await this.authenticate(req);
    if (!user) throw new UnauthorizedException('无效或缺失的访问令牌');
    if (!user.permissions.has('station:read')) throw new UnauthorizedException('权限不足：需要 station:read');
    const filePath = this.videos.filePathOf(name);
    if (!filePath || !fs.existsSync(filePath)) throw new BadRequestException('视频文件不存在或名称非法');
    await this.videos.assertReadable(name, user);
    // §7.2：sendFileSafe 带 callback——416 等裸 Error 不再被 AllExceptionsFilter 转 500
    sendFileSafe(this.log, res, filePath, {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
    });
  }

  /** ffmpeg 可用性与格式支持清单（工作台据此给用户明确提示，而非黑屏） */
  @Public()
  @Get('capabilities')
  async capabilities(@Req() req: AuthedRequest) {
    const user = await this.authenticate(req);
    if (!user) throw new UnauthorizedException('无效或缺失的访问令牌');
    return {
      ffmpeg: !!this.videos.resolveFfmpeg(),
      native: ['MP4(H.264/AAC)', 'WebM(VP8/VP9)', 'MOV(H.264)', 'M4V', '3GP'],
      convertible: this.videos.resolveFfmpeg()
        ? ['AVI', 'MKV', 'FLV', 'WMV', 'TS/MTS', 'HEVC/H.265', 'ProRes', 'RMVB 等（自动转 MP4）']
        : [],
    };
  }

  /**
   * 场景镜头切分（v3.53 提速）：输入已上传视频文件名（uuid.mp4），返回候选片段起止点（毫秒）。
   * 人工确认后才进分解流程（人拆 AI 校）。无 ffmpeg 时 service 层明确报错（宁缺勿错）。
   */
  @Post('scene-detect')
  @RequirePermission('element:write')
  async sceneDetect(@Body() body: { name?: string }, @Req() req: AuthedRequest) {
    const name = body?.name;
    if (!name || !/^[0-9a-f-]{36}\.mp4$/.test(name)) throw new BadRequestException('非法视频名称');
    const filePath = this.videos.filePathOf(name);
    if (!filePath || !fs.existsSync(filePath)) throw new BadRequestException('视频文件不存在');
    // v3.55：归属校验——不可对他人不可见视频跑切分（既是防越权，也是防算力盗用）
    const user = req.user;
    if (user) await this.videos.assertReadable(name, user);
    return this.videos.detectScenes(filePath);
  }

  /** Bearer 头优先，回退 ?token= 查询参数（视频标签场景） */
  private async authenticate(req: AuthedRequest) {
    const header = req.headers?.['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    let token = raw?.startsWith('Bearer ') ? raw.slice(7) : null;
    const q = typeof (req as unknown as { query?: Record<string, unknown> }).query?.token === 'string'
      ? (req as unknown as { query: Record<string, unknown> }).query.token as string
      : null;
    if (!token && q) token = q;
    if (!token) return null;
    try {
      const payload = this.jwt.verify(token);
      return await this.loader.load(payload.sub);
    } catch {
      return null;
    }
  }
}
