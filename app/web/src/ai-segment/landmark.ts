/**
 * MediaPipe HandLandmarker 加载 + 定步长抽帧（v3.33）
 *
 * 关键工程约束（踩坑实录，勿改）：
 * 1) detectForVideo 的时间戳必须【严格单调递增】，绝不能用 performance.now()
 *    —— 跨阶段会回退，报 Packet timestamp mismatch 后整条图崩掉（实测踩过）。
 *    这里一律用 frameIndex * SAMPLE_MS 生成的单调计数器。
 * 2) node_modules 里 @mediapipe/tasks-vision 装不上（npm 当可选依赖跳过），
 *    因此运行时动态 import public/models 下的本地 bundle，并 @vite-ignore。
 * 3) 模型与 wasm 必须离线随包分发：源站经代理仅约 12KB/s，车间内网现拉必然失败。
 */

/** 采样步长：100ms = 10Hz（ADR-AI-SEG-001 实测 110ms/帧，10Hz 时分析耗时≈视频时长 1~1.5×） */
export const SAMPLE_MS = 100;

/** 推理画布长边上限，超过则等比下采样（提速，坐标按画布尺寸计算） */
const MAX_SIDE = 640;

/**
 * MediaPipe handedness 假定输入为镜像图像（前置摄像头语义）。
 * 工位视频通常是普通机位，左右会反 → 默认翻转。
 * 待真实工位视频验证后确认此常量（已列入 DESIGN §12 已知限制）。
 */
export const FLIP_HANDEDNESS = true;

export interface HandObs {
  /** 掌质心像素坐标（画布坐标系） */
  cx: number;
  cy: number;
  /** 拇指-食指开合度（像素） */
  aperture: number;
  /** 检测置信度 0–1 */
  conf: number;
}

export interface FrameObs {
  /** 视频时间（ms） */
  t: number;
  L: HandObs | null;
  R: HandObs | null;
  /** 本帧是否双手同时出现 */
  both: boolean;
}

type Landmarker = {
  detectForVideo: (canvas: HTMLCanvasElement, tsMs: number) => any;
  close: () => void;
};

let landmarkerPromise: Promise<Landmarker> | null = null;

/**
 * 加载 MediaPipe 的 ESM bundle。
 *
 * 为什么不用 `import('/models/vision_bundle.mjs')`：
 * Vite 开发服务器会把动态 import 的 public 路径重写为 `?import`，随后按模块图处理该静态文件，
 * 结果报 `Failed to fetch dynamically imported module ...vision_bundle.mjs?import`（实测踩过）。
 * 这里改为 fetch 文本 → Blob URL → 原生 import，彻底绕过 Vite 的模块改写；
 * 生产构建下 public 资源原样拷贝，同样成立。
 */
async function loadVisionBundle(): Promise<any> {
  const res = await fetch('/models/vision_bundle.mjs');
  if (!res.ok) throw new Error(`视觉模型包加载失败（HTTP ${res.status}）`);
  const code = await res.text();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  // 模块求值后即可释放；延迟释放避免 bundle 内部懒加载被打断
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return import(/* @vite-ignore */ url);
}

/** 模型加载单例：多次分析共用，避免重复 1.87s 冷启动 */
export function loadLandmarker(): Promise<Landmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision: any = await loadVisionBundle();
      const { HandLandmarker, FilesetResolver } = vision;
      const fileset = await FilesetResolver.forVisionTasks('/models/wasm');
      return HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }) as Promise<Landmarker>;
    })().catch((e) => {
      // 失败不缓存，允许用户重试（例如 GPU 不可用时改 CPU）
      landmarkerPromise = null;
      throw e;
    });
  }
  return landmarkerPromise;
}

export function resetLandmarker(): void {
  const p = landmarkerPromise;
  landmarkerPromise = null;
  p?.then((l) => l.close()).catch(() => undefined);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, Math.round(w * scale));
  cv.height = Math.max(2, Math.round(h * scale));
  return cv;
}

/** seek 到指定秒并等待 seeked；带超时保护，避免卡死分析 */
function seekTo(video: HTMLVideoElement, tSec: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    setTimeout(finish, 800);
    try {
      video.currentTime = tSec;
    } catch {
      finish();
    }
  });
}

function pickHand(label: string): 'L' | 'R' {
  const isLeft = label.toLowerCase().indexOf('left') >= 0;
  const asLeft = FLIP_HANDEDNESS ? !isLeft : isLeft;
  return asLeft ? 'L' : 'R';
}

/** 单帧推理 → FrameObs（纯观测，不含任何切割判断） */
export async function observeFrame(
  lm: Landmarker,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  tMs: number,
  frameIndex: number,
): Promise<FrameObs> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { t: tMs, L: null, R: null, both: false };
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // 单调时间戳：frameIndex 递增，绝不回退
  const res = lm.detectForVideo(canvas, frameIndex * SAMPLE_MS);
  const out: FrameObs = { t: tMs, L: null, R: null, both: false };
  const lms: any[] = res?.landmarks ?? [];
  const handed: any[] = res?.handedness ?? res?.handednesses ?? [];

  for (let i = 0; i < lms.length && i < 2; i += 1) {
    const pts = lms[i];
    if (!pts || pts.length < 21) continue;
    const conf = Number(handed[i]?.[0]?.score ?? handed[i]?.score ?? 0);
    const rawLabel = String(handed[i]?.[0]?.categoryName ?? handed[i]?.categoryName ?? 'Right');
    const side = pickHand(rawLabel);

    const wrist = pts[0];
    const mid = pts[9];
    const thumb = pts[4];
    const index = pts[8];
    const w = canvas.width;
    const h = canvas.height;
    const obs: HandObs = {
      cx: ((wrist.x + mid.x) / 2) * w,
      cy: ((wrist.y + mid.y) / 2) * h,
      aperture: Math.hypot((thumb.x - index.x) * w, (thumb.y - index.y) * h),
      conf: Number.isFinite(conf) ? conf : 0.5,
    };
    if (out[side]) {
      // 同侧重复检出：取置信度更高的一个
      if (obs.conf > out[side]!.conf) out[side] = obs;
    } else {
      out[side] = obs;
    }
  }
  out.both = !!(out.L && out.R);
  return out;
}

export interface Sampler {
  canvas: HTMLCanvasElement;
  totalMs: number;
  /** 采集下一帧；返回 null 表示已到片尾 */
  next: (frameIndex: number) => Promise<FrameObs>;
}

export function createSampler(lm: Landmarker, video: HTMLVideoElement): Sampler {
  const canvas = makeCanvas(video.videoWidth || 1280, video.videoHeight || 720);
  /* 时长必须有限：MediaRecorder/录屏产出的 WebM 常见 duration=Infinity。
     若直接乘 1000 得到 Infinity，抽帧循环 `t < totalMs` 永不结束（整页卡死）。
     兜底顺序：duration → seekable 末尾 → 抛错由上层给用户明确提示。 */
  const rawDur = video.duration;
  const seekEnd = video.seekable && video.seekable.length
    ? video.seekable.end(video.seekable.length - 1) : NaN;
  const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur
    : Number.isFinite(seekEnd) && seekEnd > 0 ? seekEnd : 0;
  if (!(dur > 0)) {
    throw new Error('无法读取视频时长（该文件可能未正确封装时长信息）');
  }
  const totalMs = Math.max(0, Math.floor(dur * 1000));
  return {
    canvas,
    totalMs,
    async next(frameIndex: number) {
      const tMs = Math.min(frameIndex * SAMPLE_MS, Math.max(0, totalMs - 1));
      await seekTo(video, tMs / 1000);
      return observeFrame(lm, video, canvas, tMs, frameIndex);
    },
  };
}
