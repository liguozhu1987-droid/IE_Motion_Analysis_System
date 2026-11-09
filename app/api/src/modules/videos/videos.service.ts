import { Injectable, Logger, BadRequestException, ForbiddenException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { VideoAsset } from '../../entities/video-asset.entity';
import { AuthUser } from '../../auth/auth-user.interface';
import { StationsService } from '../stations/stations.service';
import { DerivativeService } from './derivative.service';
import { loadCapacityConfig } from './derivative-capacity';

/** 上传/转码结果 */
export interface VideoHandle {
  /** 前端 <video> 可用的播放地址（同源 API 路径） */
  url: string;
  /** 存储文件名（uuid.mp4） */
  name: string;
  /** 源文件探测信息 */
  probe: VideoProbe;
  /** 是否经过了转码（false=直通播放） */
  transcoded: boolean;
}

export interface VideoProbe {
  /** ffmpeg 报告的容器名（mov,mp4,m4a,3gp,3g2,mj2 / avi / matroska,webm / flv …） */
  container: string;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  durationS: number | null;
}

/** 单文件大小上限（IE 现场视频一般 30s~10min；2GB 足够且防磁盘打爆） */
const MAX_UPLOAD_BYTES = Number(process.env.VIDEO_MAX_MB ?? 2048) * 1024 * 1024;
/** 时长上限：超过 3 小时的"工位视频"没有分解意义，且转码会长时间占 CPU */
const MAX_DURATION_S = Number(process.env.VIDEO_MAX_MIN ?? 180) * 60;
/** 转码输出宽度封顶：IE 分解看动作，720p 足够，且转码耗时/体积减半 */
const MAX_OUT_WIDTH = Number(process.env.VIDEO_MAX_WIDTH ?? 1280);

@Injectable()
export class VideosService {
  private readonly log = new Logger('VideosService');
  private readonly dir = path.resolve(process.cwd(), 'storage', 'videos');
  private ffmpegPath: string | null | undefined;
  /** 转码串行队列：libx264 是多线程CPU密集活，并发只会互相抢核还容易OOM */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ds: DataSource,
    private readonly stations: StationsService,
    private readonly derivatives: DerivativeService,
  ) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * ffmpeg 可执行文件解析（v3.28）：
   *  ① 环境变量 FFMPEG_BIN（部署显式指定，最高优先）
   *  ② 项目内置 bin/ffmpeg.exe（随项目分发的静态构建）
   *  ③ ffmpeg-static npm 包（其 postinstall 需要直连 GitHub，内网可能失败——装了就有）
   *  ④ 系统 PATH 上的 ffmpeg
   * 全部落空返回 null：上传接口会明确告知"服务器未配置 ffmpeg，该格式无法自动转换"，
   * 并给出原生支持格式清单（宁缺勿错，不静默失败）。
   */
  resolveFfmpeg(): string | null {
    if (this.ffmpegPath !== undefined) return this.ffmpegPath;
    const candidates: (string | null)[] = [
      process.env.FFMPEG_BIN || null,
      path.resolve(process.cwd(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    ];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      candidates.push(require('ffmpeg-static') as string);
    } catch { /* 包未安装/二进制缺失时静默跳过 */ }
    candidates.push('ffmpeg'); // PATH 兜底
    for (const c of candidates) {
      if (!c) continue;
      try {
        if (fs.existsSync(c)) { this.ffmpegPath = c; return c; }
      } catch { /* existsSync 对 PATH 名字不抛，继续 */ }
    }
    // PATH 兜底：existsSync('ffmpeg') 为 false（相对当前目录），需实跑验证
    const ok = this.probeVersion('ffmpeg');
    this.ffmpegPath = ok ? 'ffmpeg' : null;
    return this.ffmpegPath;
  }

  private probeVersion(bin: string): boolean {
    // 必须实跑：spawn 对 ENOENT 不抛同步异常（错误走 async 'error' 事件），不能用来探测 PATH
    try {
      const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 8000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * 保存上传的源文件并返回播放句柄（必要时转码）。
   * allowRaw=true 时跳过转码判定、直接落盘——**仅当调用方已用 canPlayType 确认浏览器
   * 能解该原始编码时传入**（v3.39 AI 自动分解页对手机 HEVC 素材走此路，省去分钟级
   * 转码等待；拿不准的容器如 MKV 仍会转码）。分解工作台上传不传该参数，
   * 保持 v3.28 「一律规范化为浏览器友好 MP4」策略不变。
   */
  async ingest(
    sourcePath: string,
    originalName: string,
    allowRaw = false,
    owner?: { userId: string; username: string; tenantId: string },
  ): Promise<VideoHandle> {
    const size = fs.statSync(sourcePath).size;
    if (size > MAX_UPLOAD_BYTES) {
      this.cleanup(sourcePath);
      throw new PayloadTooLargeException(`视频文件过大（>${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB），请压缩或裁剪后重试`);
    }
    const probe = await this.probe(sourcePath);
    if (probe.durationS != null && probe.durationS > MAX_DURATION_S) {
      this.cleanup(sourcePath);
      throw new BadRequestException(`视频时长超过上限（>${Math.round(MAX_DURATION_S / 60)} 分钟）：工位分解请按循环节拍裁剪`);
    }
    const ffmpeg = this.resolveFfmpeg();
    const need = allowRaw ? false : this.needsTranscode(probe, path.extname(sourcePath).toLowerCase());
    if (!need) {
      // 浏览器原生可播：直接落盘为最终文件（零转码、零等待）
      const name = `${this.newId()}.mp4`;
      fs.renameSync(sourcePath, path.join(this.dir, name));
      await this.registerAsset(name, owner);
      this.autoDerive(name, allowRaw);
      return { url: `/api/videos/file/${name}`, name, probe, transcoded: false };
    }
    if (!ffmpeg) {
      this.cleanup(sourcePath);
      throw new ServiceUnavailableException(
        `该视频格式（${probe.container} / ${probe.videoCodec}）浏览器无法直接播放，且服务器未配置 ffmpeg 无法自动转换。`
        + `请先用格式工厂等工具转为 MP4(H.264+AAC)，或让管理员在服务器安装 ffmpeg 后重试。`,
      );
    }
    const name = `${this.newId()}.mp4`;
    const outPath = path.join(this.dir, name);
    // 串行执行：排队期间源文件保留，完成后无论成败都清理
    const job = this.queue.then(() => this.transcode(ffmpeg, sourcePath, outPath, probe));
    this.queue = job.then(() => undefined, () => undefined);
    await job;
    this.cleanup(sourcePath);
    await this.registerAsset(name, owner);
    this.autoDerive(name, allowRaw);
    return { url: `/api/videos/file/${name}`, name, probe, transcoded: true };
  }

  /**
   * P0.5 派生自动触发（Spec §10 backlog 落地）：上传/转码成功后服务端自动入队预热，
   * 用户打开工作台时代理/精灵图/索引多半已 ready（50 人口径下队尾等待显著缩短）。
   *  - fire-and-forget：预热失败只记日志，绝不阻断上传响应（幂等由唯一键+状态机保证，
   *    前端载入时的 POST /derive 兜底仍在）；
   *  - allowRaw=true（AI 自动分解页直通路径）跳过：该线视频仅浏览器内存分析、
   *    不进帧级工作台（OPEN-DECISIONS「现场视频不上传对分析代理不放开」口径）；
   *  - VIDEO_AUTO_DERIVE=0 可关闭（磁盘紧张环境留手动口）。
   */
  private autoDerive(name: string, allowRaw: boolean): void {
    if (allowRaw || process.env.VIDEO_AUTO_DERIVE === '0') return;
    void this.derivatives.derive(name).catch((e) => {
      this.log.warn(`上传后自动派生入队失败（不影响上传，前端载入时会兜底重试）: ${name} ${(e as Error).message}`);
    });
  }

  /**
   * 登记视频归属（v3.55）。
   * 失败不阻断上传——归属登记是加固项，登记不了只是少一层判定，不该让用户传不上去。
   */
  private async registerAsset(name: string, owner?: { userId: string; username: string; tenantId: string }): Promise<void> {
    if (!owner?.userId) return;
    try {
      // 2026-11-06 保留策略：新上传默认 auto，到期日 = 上传时刻 + VIDEO_RETENTION_DAYS（默认 10 天）
      const { retentionDays } = loadCapacityConfig();
      await this.ds.getRepository(VideoAsset).save({
        file_name: name,
        tenant_id: owner.tenantId,
        owner_user_id: owner.userId,
        owner_username: owner.username,
        retention_status: 'auto',
        retention_until: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
        notify_attempts: 0,
      } as any);
    } catch (e) {
      this.log.warn(`视频归属登记失败（不影响播放）: ${name} ${(e as Error).message}`);
    }
  }

  /**
   * 视频可读性判定（v3.55）。
   *
   * 背景：工位视频原为「上传即入全局目录、文件名=uuid」的裸文件池，下载端点只校验
   * `station:read` 权限点 → 任何登录用户凭文件名即可取任意租户的视频（含其他产线现场画面）。
   *
   * 放行口径（任一满足）：
   *   ① 全权角色（sys_admin / ie_admin）
   *   ② 上传者本人
   *   ③ 该视频关联的工位（t_element.video_id → station_id）中任一工位对调用者可见
   *   ④ 同租户且 data_scope ∈ {tenant, all}
   * 历史文件（迁移前上传、无归属登记）→ 保持既有行为放行，不做破坏性收紧。
   */
  async assertReadable(name: string, user: AuthUser): Promise<void> {
    const asset = await this.ds.getRepository(VideoAsset).findOne({ where: { file_name: name } } as any) as any;
    if (!asset) return; // 历史文件：无归属信息，维持既有行为
    if (this.stations.hasFullAccess(user.roles)) return;
    if (asset.owner_user_id === user.userId) return;

    // ③ 关联工位可见权（视频常被多工位引用；任一可见即放行）
    // 注：mssql 驱动用 @0 位置参数（项目既有写法），不支持 @p0 具名形式
    const linked = await this.ds.query(
      `SELECT DISTINCT station_id FROM t_element WHERE video_id = @0`,
      [name],
    ) as any[];
    if (linked.length > 0) {
      const visible = await this.stations.visibleStationIds(user.userId, user.roles, user.tenantId, user.dataScope);
      if (visible === null) return;
      const allow = new Set(visible);
      if (linked.some((r) => allow.has(r.station_id))) return;
    }

    // ④ 数据范围：同租户 + 租户级可见
    if (asset.tenant_id === user.tenantId && (user.dataScope === 'tenant' || user.dataScope === 'all')) return;

    throw new ForbiddenException('该视频不在你的可见范围（仅本人上传或关联工位可见者可播放）');
  }

  /** ffmpeg 探测：容器/视频编码/音频编码/分辨率/时长（解析 `ffmpeg -i` 的 stderr） */
  async probe(filePath: string): Promise<VideoProbe> {
    const ffmpeg = this.resolveFfmpeg();
    if (!ffmpeg) {
      // 无 ffmpeg 时按扩展名兜底（直通判断会偏保守：未知容器一律转码→但转码也不可用→明确报错）
      const ext = path.extname(filePath).toLowerCase();
      return { container: ext.replace('.', '') || 'unknown', videoCodec: 'unknown', audioCodec: null, width: 0, height: 0, durationS: null };
    }
    const stderr = await this.runCapture(ffmpeg, ['-i', filePath]);
    const container = /Input #0, ([^,]+),/.exec(stderr)?.[1]?.trim() ?? 'unknown';
    const videoCodec = /Video:\s*([a-zA-Z0-9]+)/.exec(stderr)?.[1]?.toLowerCase() ?? 'unknown';
    const audioCodec = /Audio:\s*([a-zA-Z0-9]+)/.exec(stderr)?.[1]?.toLowerCase() ?? null;
    const wh = /(\d{2,5})x(\d{2,5})/.exec(stderr);
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
    const durationS = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
    return { container, videoCodec, audioCodec, width: wh ? Number(wh[1]) : 0, height: wh ? Number(wh[2]) : 0, durationS };
  }

  /**
   * 场景镜头切分检测（v3.53 提速）：复用 ffmpeg 的 select='gt(scene,0.3)' 滤镜 + showinfo，
   * 解析选中帧的 pts_time 作为切分点，输出候选片段起止（毫秒）。
   * 不自动落要素——仅给前端候选起止，人工确认后才进分解流程（人拆 AI 校）。
   * 阈值 0.3 为保守默认（镜头切换明显的工位视频）；过近(<500ms)与首尾(<300ms)噪声段被过滤/合并。
   * 无 ffmpeg 时明确报错（宁缺勿错），不静默失败。零 LLM 成本。
   */
  async detectScenes(videoPath: string): Promise<{ scenes: { start_ms: number; end_ms: number; score: number }[]; durationS: number | null }> {
    const ffmpeg = this.resolveFfmpeg();
    if (!ffmpeg) {
      throw new ServiceUnavailableException('服务器未配置 ffmpeg，无法自动切分场景。请管理员安装 ffmpeg 后重试。');
    }
    const probe = await this.probe(videoPath);
    const durMs = probe.durationS != null ? Math.round(probe.durationS * 1000) : null;
    const args = ['-hide_banner', '-i', videoPath, '-filter_complex', "[0:v]select='gt(scene,0.3)',showinfo", '-f', 'null', '-'];
    let stderr = '';
    try {
      stderr = await this.runCapture(ffmpeg, args);
    } catch {
      throw new ServiceUnavailableException('场景切分失败：ffmpeg 执行异常');
    }
    const cuts: number[] = [];
    for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
      cuts.push(Math.round(Number(m[1]) * 1000));
    }
    const uniq = [...new Set(cuts)].sort((a, b) => a - b)
      .filter((t) => t > 300 && (durMs == null || t < durMs - 300));
    const bounds = [0, ...uniq, ...(durMs != null ? [durMs] : [])];
    const scenes: { start_ms: number; end_ms: number; score: number }[] = [];
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const s = bounds[i];
      const e = bounds[i + 1];
      if (e - s < 500) continue; // 过短段跳过（已并入相邻候选）
      scenes.push({ start_ms: s, end_ms: e, score: 0 });
    }
    // 全部过短（如单一镜头视频）→ 退化为整段，避免空结果
    if (scenes.length === 0 && durMs != null && durMs > 500) {
      scenes.push({ start_ms: 0, end_ms: durMs, score: 0 });
    }
    return { scenes, durationS: probe.durationS };
  }

  /**
   * 是否需要转码（以 Chrome 实际可解为口径）：
   *  - mp4 家族（mp4/mov/m4v/3gp）+ h264/vp8/vp9/av1 + aac/mp3/无音轨 → 直通
   *  - webm（扩展名 .webm）+ vp8/vp9/av1 + vorbis/opus → 直通
   *  - matroska（mkv）、avi、flv、wmv/asf、mpegts、rmvb 等 → 转码
   *    （Chrome 对 MKV 只认 VP8/VP9/AV1，H.264-in-MKV 不可播；其余容器基本不可播）
   * 注意：ffmpeg 对 mkv 和 webm 都报容器名 "matroska,webm"——**必须靠扩展名区分**，
   * 否则 MKV(H.264) 会被误判直通，改名 .mp4 后 Chrome 解不了（v3.28 实测坑）。
   */
  needsTranscode(p: VideoProbe, ext: string): boolean {
    const vOk = ['h264', 'vp8', 'vp9', 'av1'].includes(p.videoCodec);
    const aOk = p.audioCodec == null || ['aac', 'mp3', 'vorbis', 'opus'].includes(p.audioCodec);
    if (!vOk || !aOk) return true;
    if (/mp4|mov|m4v|3gp/.test(p.container) && /\.(mp4|mov|m4v|3gp)$/.test(ext)) return false; // iPhone MOV(H.264) 在内
    if (/webm/.test(p.container) && /\.webm$/.test(ext) && ['vp8', 'vp9', 'av1'].includes(p.videoCodec)) return false;
    return true;
  }

  /** 转码为浏览器友好的 MP4：H.264 + yuv420p + AAC + faststart；宽度封顶 MAX_OUT_WIDTH */
  private async transcode(ffmpeg: string, input: string, output: string, probe: VideoProbe): Promise<void> {
    const args = ['-y', '-hide_banner', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
    if (probe.width > MAX_OUT_WIDTH) args.push('-vf', `scale=${MAX_OUT_WIDTH}:-2`);
    args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', output);
    const t0 = Date.now();
    await this.run(ffmpeg, args);
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new ServiceUnavailableException('视频转换失败：输出文件为空（源文件可能损坏）');
    }
    this.log.log(`转码完成: ${path.basename(input)} → ${path.basename(output)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  /** 文件名安全解析：仅接受 <uuid>.mp4，杜绝路径穿越 */
  filePathOf(name: string): string | null {
    if (!/^[0-9a-f-]{36}\.mp4$/.test(name)) return null;
    const p = path.join(this.dir, name);
    return p;
  }

  private newId(): string {
    return (require('crypto') as typeof import('crypto')).randomUUID();
  }

  private cleanup(p: string): void {
    try { fs.unlinkSync(p); } catch { /* 已删/不存在 */ }
  }

  /** spawn 执行，stderr 全量捕获；退出码非 0 抛错（ffmpeg 的进度信息都走 stderr） */
  private run(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr?.on('data', (d) => { err += String(d); });
      child.on('error', (e) => reject(new ServiceUnavailableException(`ffmpeg 启动失败: ${e.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve(err);
        else reject(new ServiceUnavailableException(`ffmpeg 退出码 ${code}: ${err.slice(-600)}`));
      });
    });
  }

  private runCapture(bin: string, args: string[]): Promise<string> {
    // 探测专用：`ffmpeg -i file`（无输出文件）本来就以非零退出，stderr 里的 Input #0 信息照样有效——
    // 因此退出码无关，只回收 stderr 文本（早期版本把 close≠0 当失败丢弃，导致 probe 全 unknown、
    // MP4 被无谓转码——v3.28 实测坑）
    return new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr?.on('data', (d) => { err += String(d); });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(err));
    });
  }
}
