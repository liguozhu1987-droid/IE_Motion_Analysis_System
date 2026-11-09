import * as fs from 'fs';
import * as path from 'path';
import { runFfmpeg, captureStderr, VideoMeta, EncoderKind } from './derivative-ffmpeg';

/**
 * 派生构建命令（SPEC-VID-P0 §2，ADR-VID-001 决策 2 写死）：
 * 分析代理（all-intra）/ 精灵图 + sprite.json / 帧索引 index.json。
 * 纯函数模块：调用方（worker）负责目录创建与状态落库。
 */

/** 派生构建结果（worker 据此回填 t_video_derivative 的 meta 列） */
export interface BuildResult {
  /** 派生文件磁盘路径（proxy=proxy.mp4 / sprite=sprite.jpg / index=index.json） */
  path: string;
  size: number;
  frames: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vfr: boolean | null;
}

/**
 * 编码器差异化的 all-intra 参数。Spec §2.2 命令为 libx264 口径；
 * QSV/NVENC 没有 -tune fastdecode / -sc_threshold / -crf 这些 x264 私有选项
 * （传了直接报 Option not found），按等价语义适配——硬前提 -g 1（全 I 帧）三者一致，
 * GOP=1 下场景切换检测天然失效，-keyint_min/-sc_threshold 仅对 libx264 有意义。
 */
const ENC_ARGS: Record<EncoderKind, string[]> = {
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-g', '1', '-global_quality', '26'],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-g', '1', '-cq', '26'],
  libx264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0', '-crf', '26'],
};

/** 分析代理（all-intra）：Web 帧级消费的硬前提，非优化（Spec §2.2） */
export async function buildProxy(
  ffmpeg: string, src: string, outDir: string, enc: EncoderKind, meta: VideoMeta,
): Promise<BuildResult> {
  if (!meta.width || !meta.height) throw new Error('无法解析源视频分辨率');
  const out = path.join(outDir, 'proxy.mp4');
  const args = [
    '-y', '-i', src, '-an', ...ENC_ARGS[enc],
    '-pix_fmt', 'yuv420p', '-vf', 'scale=854:-2',
    '-movflags', '+faststart', '-progress', 'pipe:1', out,
  ];
  await runFfmpeg(ffmpeg, args);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error('代理输出为空（编码器失败或源文件损坏）');
  }
  const h = Math.round((meta.height * 854) / meta.width);
  return {
    path: out,
    size: fs.statSync(out).size,
    frames: meta.fps != null && meta.durationMs != null ? Math.round((meta.durationMs * meta.fps) / 1000) : null,
    durationMs: meta.durationMs,
    width: 854,
    height: h % 2 ? h + 1 : h,
    fps: meta.fps,
    vfr: meta.vfr,
  };
}

/**
 * 精灵图 + sprite.json（Spec §2.3）。
 * 铁律：索引必须携带实际 cols/rows/count，禁止用 cols×rows 推算——
 * count 由 fps=1 采样实跑 showinfo 统计（tile 不补格，尾部空格是黑块）。
 */
export async function buildSprite(
  ffmpeg: string, src: string, outDir: string, meta: VideoMeta,
): Promise<BuildResult> {
  if (!meta.width || !meta.height) throw new Error('无法解析源视频分辨率');
  const countEst = meta.durationS != null ? Math.floor(meta.durationS) : 0;
  if (countEst < 1) throw new Error('视频时长不足 1 秒，无法生成精灵图');
  // 第一遍：fps=1 采样实跑统计实际帧数（探测，非推算；时长小数边界不猜）
  const info = await captureStderr(ffmpeg, ['-i', src, '-vf', 'fps=1,showinfo', '-f', 'null', '-']);
  const count = [...info.matchAll(/pts_time:/g)].length;
  if (count < 1) throw new Error('精灵图采样为空（fps=1 未取到帧）');
  const rows = Math.max(1, Math.ceil(count / 10));
  const out = path.join(outDir, 'sprite.jpg');
  await runFfmpeg(ffmpeg, [
    '-y', '-i', src, '-vf', `fps=1,scale=160:-2,tile=10x${rows}`,
    '-frames:v', '1', '-update', '1', '-q:v', '3', out,
  ]);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('精灵图输出为空');
  const h = Math.round((meta.height * 160) / meta.width);
  const tileH = h % 2 ? h + 1 : h;
  // sprite.json 服务生成（非 ffmpeg 产出）：携带实际 cols/rows/count
  fs.writeFileSync(path.join(outDir, 'sprite.json'), JSON.stringify({
    cols: 10, rows, count, tileW: 160, tileH, fps: 1, srcW: meta.width, srcH: meta.height,
  }));
  return {
    path: out,
    size: fs.statSync(out).size,
    frames: count,
    durationMs: meta.durationMs,
    width: 160,
    height: tileH,
    fps: meta.fps,
    vfr: meta.vfr,
  };
}

/**
 * 帧索引 index.json（Spec §2.4 + §10 P0.5 增补）：
 * CFR 只存 fps/frames（前端按 t = n / fps 换算）；VFR 才存逐帧 entries（避免大数组）。
 * keyframes（P0.5 新增可选字段）：**源视频** I 帧时刻清单（毫秒，升序）——
 * 前端非代理回退路径的吸附基准（useVideoEngine keyframeList，秒 = 值/1000）。
 * refPath 建议传代理（all-intra 解码快）；代理未就绪时由调用方回退源文件（时间戳转码保持不变）。
 * srcPath = 源视频路径（keyframes 必须取自源视频——代理是 all-intra，每帧都是 I 帧无参考价值）。
 */
export async function buildIndex(
  ffmpeg: string, refPath: string, outDir: string, meta: VideoMeta, srcPath?: string,
): Promise<BuildResult> {
  const fps = meta.fps;
  const durationMs = meta.durationMs;
  // 无 fps 无法按 CFR 换算 → 按逐帧口径处理
  const vfr = meta.vfr || fps == null;
  let frames: number | null = null;
  let entries: number[] | undefined;
  if (vfr) {
    const info = await captureStderr(ffmpeg, ['-i', refPath, '-vf', 'showinfo', '-f', 'null', '-']);
    entries = [...info.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
    frames = entries.length;
  } else {
    frames = durationMs != null ? Math.round((durationMs * (fps as number)) / 1000) : null;
  }
  if (frames == null) throw new Error('无法计算帧数（fps/时长缺失）');
  // 关键帧清单（可选增强，失败不阻断索引）：-skip_frame nokey 只解码 I 帧（远快于全片解码）；
  // showinfo 只见到存活的解码帧 → pts_time 即关键帧时刻。>50000 条不存（防 index.json 膨胀；
  // 全 I 帧源视频 keyframes 无吸附价值，恰好被此上限挡掉）。
  let keyframes: number[] | undefined;
  if (srcPath && fs.existsSync(srcPath)) {
    try {
      const kf = await captureStderr(ffmpeg, ['-skip_frame', 'nokey', '-i', srcPath, '-vf', 'showinfo', '-f', 'null', '-']);
      const uniq = [...new Set([...kf.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000)))]
        .sort((a, b) => a - b);
      if (uniq.length > 0 && uniq.length <= 50000) keyframes = uniq;
    } catch { /* 关键帧提取失败：index.json 不带该字段，前端回退 1/fps 网格 */ }
  }
  const payload: Record<string, unknown> = { fps, frames, durationMs, vfr: vfr ? 1 : 0 };
  if (vfr) payload.entries = entries;
  if (keyframes) payload.keyframes = keyframes;
  const out = path.join(outDir, 'index.json');
  fs.writeFileSync(out, JSON.stringify(payload));
  return {
    path: out,
    size: fs.statSync(out).size,
    frames,
    durationMs,
    width: meta.width || null,
    height: meta.height || null,
    fps,
    vfr,
  };
}
