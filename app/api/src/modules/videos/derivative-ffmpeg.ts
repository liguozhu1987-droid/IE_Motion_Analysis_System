import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadCapacityConfig } from './derivative-capacity';

/**
 * 派生层 ffmpeg 基础设施（SPEC-VID-P0 §2）：
 * 元数据探测（解析 `ffmpeg -i` stderr，不引 ffprobe 二进制硬依赖）+ 执行器 + 硬件编码探测。
 * 纯函数模块（无 Nest 状态）；ffmpeg 路径由 VideosService.resolveFfmpeg() 多路径解析后传入。
 */

/** 视频元数据（Spec §2.1） */
export interface VideoMeta {
  durationS: number | null;
  durationMs: number | null;
  /** canonical fps（29.97 不得硬钉成 30） */
  fps: number | null;
  /** 估算平均帧率（tbr），与 fps 交叉校验判 VFR */
  tbr: number | null;
  width: number;
  height: number;
  /** 可变帧率标记（差异超阈值 → 前端须用逐帧 entries） */
  vfr: boolean;
  codec: string;
  bitRateKbps: number | null;
}

/**
 * 元数据探测：捕获 `ffmpeg -i <SRC>` 的 stderr 并解析。
 * 退出码无关（无输出文件的 -i 本就以非零退出，stderr 里的 Input #0 照样有效）。
 */
export async function probeVideoMeta(ffmpeg: string, filePath: string): Promise<VideoMeta> {
  const stderr = await captureStderr(ffmpeg, ['-i', filePath]);
  const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const durationS = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
  const durationMs = durationS != null ? Math.round(durationS * 1000) : null;
  const fps = /([\d.]+)\s+fps/.exec(stderr) ? Number(/([\d.]+)\s+fps/.exec(stderr)![1]) : null;
  const tbr = /([\d.]+)\s+tbr/.exec(stderr) ? Number(/([\d.]+)\s+tbr/.exec(stderr)![1]) : null;
  const wh = /(\d{2,5})x(\d{2,5})/.exec(stderr);
  const codec = /Video:\s*([a-zA-Z0-9]+)/.exec(stderr)?.[1]?.toLowerCase() ?? 'unknown';
  const br = /(\d+)\s+kb\/s/.exec(stderr);
  // VFR 检测：`ffmpeg -i` 不输出 avg_frame_rate/r_frame_rate（那是 ffprobe 字段），
  // 等价口径 = fps（容器标称帧率）与 tbr（估算平均）交叉校验，差异超 5% 判 VFR。
  // 边界残留由前端 rVFC 采样交叉校验兜底（Spec §2.1）。
  const vfr = fps != null && tbr != null && Math.abs(fps - tbr) / Math.max(fps, tbr) > 0.05;
  return {
    durationS, durationMs, fps, tbr,
    width: wh ? Number(wh[1]) : 0,
    height: wh ? Number(wh[2]) : 0,
    vfr, codec,
    bitRateKbps: br ? Number(br[1]) : null,
  };
}

export type EncoderKind = 'h264_qsv' | 'h264_nvenc' | 'libx264';

/** 探测顺序（ADR-VID-001 决策 2）：QSV 本机可用约快 2.4× → NVENC → libx264 兜底 */
export const ENCODER_SEQ: readonly EncoderKind[] = ['h264_qsv', 'h264_nvenc', 'libx264'];
/** 进程内缓存：undefined=未探测；null=全部失败 */
let encoderCache: EncoderKind | null | undefined;

/**
 * 硬件编码探测：必须实跑 1 帧并校验输出非空——
 * NVENC 不可用时可能不报错但产 0 字节文件（ADR-VID-001 实测坑），仅看退出码不够。
 * 探测条件与正式代理命令一致（含 scale/pix_fmt），避免"探测通过、实跑失败"。
 */
export async function resolveEncoder(ffmpeg: string, srcPath: string): Promise<EncoderKind | null> {
  if (encoderCache !== undefined) return encoderCache;
  const tmpDir = path.resolve(process.cwd(), 'storage', 'videos', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const enc of ENCODER_SEQ) {
    const out = path.join(tmpDir, `encprobe_${Date.now()}_${enc}.mp4`);
    try {
      await runFfmpeg(ffmpeg, ['-y', '-i', srcPath, '-an', '-frames:v', '1', '-c:v', enc, '-pix_fmt', 'yuv420p', '-vf', 'scale=854:-2', out]);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        encoderCache = enc;
        return enc;
      }
    } catch {
      // 该编码器不可用（启动失败/驱动缺失/不支持源格式），继续下一个
    } finally {
      try { fs.unlinkSync(out); } catch { /* 已删 */ }
    }
  }
  // P0-1 实测暴露：失败不缓存。探测可能因瞬时原因失败（源文件损坏、临时目录被占），
  // 若把 null 缓存进 encoderCache，则整个进程后续所有派生都会永久失败，只能重启服务。
  return null;
}

/**
 * 运行时回退顺序（Spec §2.2 兜底语义的落实）：
 * 硬件编码器「探测通过、实跑翻车」是实测坑（本机 QSV 单帧探测过、全片第 24 帧
 * MFX_ERR_UNDEFINED_BEHAVIOR）——探测只证明能用，不证明稳。从解析出的编码器起，
 * 按 ENCODER_SEQ 展开后续候选，交给调用方逐个试错。
 */
export function encoderOrderFrom(resolved: EncoderKind): EncoderKind[] {
  const i = ENCODER_SEQ.indexOf(resolved);
  return i < 0 ? [...ENCODER_SEQ] : ENCODER_SEQ.slice(i);
}

/** 运行时失败后作废探测缓存：下次 resolveEncoder 重新探测（硬件状态可能已变） */
export function invalidateEncoderCache(): void {
  encoderCache = undefined;
}

/** 单任务超时（P0-1）：防 ffmpeg 卡死导致 in-flight 永久占用并发、任务永久不收敛 */
function jobTimeoutMs(): number {
  return loadCapacityConfig().deriveTimeoutMin * 60_000;
}

/**
 * spawn 执行：退出码非 0 抛错（stderr 尾部进消息）；超时 SIGKILL 并抛错。
 * stdout（-progress pipe:1）只排水不解析。
 */
export function runFfmpeg(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let timedOut = false;
    const limit = jobTimeoutMs();
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
    }, limit);
    timer.unref?.();
    child.stdout?.on('data', () => { /* progress 行排水，防背压阻塞 */ });
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg 启动失败: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg 超时（>${Math.round(limit / 60_000)} 分钟），已终止: ${err.slice(-300)}`));
      else if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg 退出码 ${code}: ${err.slice(-600)}`));
    });
  });
}

/** 捕获 stderr（探测专用：`ffmpeg -i` / showinfo 均以非零退出但 stderr 信息有效，退出码无关） */
export function captureStderr(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let timedOut = false;
    const limit = jobTimeoutMs();
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
    }, limit);
    timer.unref?.();
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ffmpeg 启动失败: ${e.message}`)); });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`ffmpeg 超时（>${Math.round(limit / 60_000)} 分钟），已终止`));
      else resolve(err);
    });
  });
}
