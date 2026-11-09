/**
 * 动作切分算法（v3.33）—— 手部轨迹 → 候选止点
 * 依据 ADR-AI-SEG-001 §Algorithm。纯函数式，不碰 React，不碰 draft。
 *
 * 语义对齐：IE 的「止点」= 手停止运动的那一刻。
 * 因此本算法只找【运动 → 准静态】的拐点，不做动素分类（一期不承诺）。
 */

import {
  Candidate,
  AnalyzeOptions,
  AnalyzeResult,
  ReservedRange,
  tierOf,
} from './types';
import {
  SAMPLE_MS,
  createSampler,
  loadLandmarker,
  FrameObs,
} from './landmark';

/** 静止持续帧数 → 判为止点（4 帧 = 400ms） */
const STILL_MIN_FRAMES = 4;
/** 速度阈值系数：0.03 × 画面对角线（px/s），自适应分辨率 */
const V_COEF = 0.03;
/** 开合度变化阈值（px/帧），抓取/释放事件 */
const A_THRESH = 4;
/** R1 时长护栏 */
const MIN_SEG_MS = 300;
const MAX_SEG_MS = 6000;
/** R3 与人工块边界最小间隔 */
const EDGE_GAP_MS = 80;

interface RawSeg {
  start_ms: number;
  end_ms: number;
  hand: 'L' | 'R';
  conf: number;
  bothRatio: number;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function overlaps(a: ReservedRange, start: number, end: number, gap: number): boolean {
  return start < a.end_ms + gap && end > a.start_ms - gap;
}

function covered(a: ReservedRange, start: number, end: number): boolean {
  return start < a.end_ms && end > a.start_ms;
}

/** 单侧手轨迹 → 原始分段 */
function segmentSide(
  frames: FrameObs[],
  side: 'L' | 'R',
  vThresh: number,
): RawSeg[] {
  const segs: RawSeg[] = [];
  let run: FrameObs[] = [];
  let still = 0;
  let prev: { cx: number; cy: number; aperture: number } | null = null;

  const emit = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    const confs = run.map((f) => f[side]!.conf);
    segs.push({
      start_ms: run[0].t,
      end_ms: run[run.length - 1].t,
      hand: side,
      conf: median(confs),
      bothRatio: run.filter((f) => f.both).length / run.length,
    });
    run = [];
  };

  for (const f of frames) {
    const o = f[side];
    if (!o) {
      // 手出画 / 遮挡：收尾当前段，避免把空档并进动作
      emit();
      still = 0;
      prev = null;
      continue;
    }
    let moving = false;
    if (prev) {
      const v = (Math.hypot(o.cx - prev.cx, o.cy - prev.cy) / SAMPLE_MS) * 1000;
      const dA = Math.abs(o.aperture - prev.aperture);
      moving = v > vThresh || dA > A_THRESH;
    } else {
      moving = true;
    }
    prev = { cx: o.cx, cy: o.cy, aperture: o.aperture };

    if (moving) {
      run.push(f);
      still = 0;
    } else {
      still += 1;
      if (still >= STILL_MIN_FRAMES) {
        emit();
        still = 0;
      }
    }
  }
  emit();
  return segs;
}

/** 双手段合并：两侧时间重叠且双手占比过半 → 合并为一个 B 段 */
function mergeBoth(segs: RawSeg[]): RawSeg[] {
  const both = segs.filter((s) => s.bothRatio >= 0.5);
  const singles = segs.filter((s) => s.bothRatio < 0.5);
  const merged: RawSeg[] = [];
  const used = new Set<RawSeg>();
  for (const a of both) {
    if (used.has(a)) continue;
    let start = a.start_ms;
    let end = a.end_ms;
    const confs = [a.conf];
    used.add(a);
    for (const b of both) {
      if (used.has(b)) continue;
      if (b.start_ms < end + SAMPLE_MS * 2 && b.end_ms > start - SAMPLE_MS * 2) {
        start = Math.min(start, b.start_ms);
        end = Math.max(end, b.end_ms);
        confs.push(b.conf);
        used.add(b);
      }
    }
    merged.push({ start_ms: start, end_ms: end, hand: 'L', conf: median(confs), bothRatio: 1 });
  }
  return [...singles, ...merged];
}

/** 主流程：视频 → 候选分段（不落库，不写 start_ms） */
export async function analyzeVideo(
  video: HTMLVideoElement,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const t0 = Date.now();
  const signal = opts.signal;
  const reserved = opts.reserved ?? [];

  opts.onProgress?.({ phase: 'load', processedMs: 0, totalMs: 0, detected: 0 });
  const lm = await loadLandmarker();
  const sampler = createSampler(lm, video);
  const vThresh = V_COEF * Math.hypot(sampler.canvas.width, sampler.canvas.height);
  const totalMs = sampler.totalMs;

  const frames: FrameObs[] = [];
  const totalFrames = Math.max(1, Math.floor(totalMs / SAMPLE_MS));

  for (let i = 0; i < totalFrames; i += 1) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const f = await sampler.next(i);
    frames.push(f);
    if (i % 5 === 0) {
      opts.onProgress?.({
        phase: 'scan',
        processedMs: Math.min(totalMs, i * SAMPLE_MS),
        totalMs,
        detected: frames.filter((x) => x.L || x.R).length,
      });
    }
  }

  opts.onProgress?.({ phase: 'segment', processedMs: totalMs, totalMs, detected: frames.length });

  const raw = mergeBoth([
    ...segmentSide(frames, 'L', vThresh),
    ...segmentSide(frames, 'R', vThresh),
  ]).sort((a, b) => a.start_ms - b.start_ms);

  const candidates: Candidate[] = [];
  let seq = 0;
  for (const s of raw) {
    const dur = s.end_ms - s.start_ms;
    // R4：已被人工块覆盖 → 不生成
    if (reserved.some((r) => covered(r, s.start_ms, s.end_ms))) continue;
    // R3：与人工块边界过近 → 不生成
    if (reserved.some((r) => overlaps(r, s.start_ms, s.end_ms, EDGE_GAP_MS))) continue;

    let tier = tierOf(s.conf);
    let reason: string | undefined;
    // R1：时长越界 → 强制低置信且不预勾选
    if (dur < MIN_SEG_MS || dur > MAX_SEG_MS) {
      tier = 'low';
      reason = dur < MIN_SEG_MS ? '时长过短' : '时长过长';
    }
    // R2：手别置信不足 → 强制低置信
    if (s.conf < 0.6) {
      tier = 'low';
      reason = reason ? `${reason}，手别不确定` : '手别不确定';
    }
    seq += 1;
    candidates.push({
      id: `c${seq}`,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      hand: s.hand === 'L' && s.bothRatio >= 0.5 ? 'B' : s.hand,
      conf: Math.round(s.conf * 100) / 100,
      tier,
      type: '其他',
      status: 'pending',
      checked: tier !== 'low',
      reason,
    });
  }

  return {
    candidates,
    elapsedMs: Date.now() - t0,
    sampleMs: SAMPLE_MS,
    frames: frames.length,
  };
}
