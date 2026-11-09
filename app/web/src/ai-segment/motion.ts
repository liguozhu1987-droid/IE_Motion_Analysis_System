/**
 * 运动能量切分 v3.38 —— 分级止点 + 合并回路 + 运动学分类
 *
 * v3.37 实测暴露的两个问题（见 deliverables/ai-segment/REAL-VIDEO-TEST-v1.md 与本次分析）：
 *
 * 1. 「时长大量挤在 1–2s」：183 段里 51.9% 落在 1.0–1.9s。根因不是固定 1.1s 切分，
 *    而是「静止 ≥200ms 即切」把换手/调握姿/取向这类 **微停顿** 全当了动素边界
 *    （原始运动爆发只有 56 个、中位 0.8s，33.9% 是 <0.3s 微爆发 —— 被切成了 183 段）。
 *    对策：止点分级 —— 只有「长静止」才是确定边界；微停顿只作为**合并候选**，
 *    由合并回路按「同手别相邻 + 合并后节奏连贯」回填，把 56 个真实动作节奏还原出来。
 *
 * 2. 「没有动作类型」：候选恒为「其他」。v3.33 一期裁决是「切分先行」，但帧差法丢掉了
 *    空间语义，分类无从做起。v3.38 在采样时**保留运动质心轨迹**（每帧的运动像素质心 +
 *    活跃面积），段内轨迹给出 6 个运动学特征，按规则映射到公司标准库（motion_standard
 *    MS1.1）的类型子集 —— 规则全部可解释，AI 不产数字（铁律），分类只是建议、人可改。
 *
 * 铁律不变：候选只是草稿；分类/手别永远是建议值；不碰 React / draft / start_ms。
 */

import { Candidate, AnalyzeOptions, AnalyzeResult, ReservedRange, Roi, DEFAULT_ROI, tierOf } from './types';
import { hoiInfer } from './hoi';

/** 采样步长（10Hz） */
export const MOTION_SAMPLE_MS = 100;

/** 分析画布 */
const GW = 240;
const GH = 135;

/** 左右半区分界（归一化，相对 ROI）：SPLIT_X 以画布为参照 */
const SPLIT_X = 0.45;

/** 静止判据（不变，v3.37 已验证） */
const STILL_RATIO = 0.75;
const STILL_CAP = 6;
const STILL_WIN = 8;

/**
 * 分级止点（v3.38 核心）：
 *  - LONG  ≥500ms：动素级边界（伸手完→握取完 的自然停顿），确定切。
 *  - MICRO 200–500ms：可能是边界也可能是微停顿，只记为「合并候选」，
 *    由合并回路决定去留 —— 这是消除「1–2s 碎段」的关键。
 */
const LONG_STILL_POINTS = 5;   // 500ms
const MICRO_STILL_POINTS = 2;  // 200ms

/** 相邻止点最小间隔 */
const CUT_GAP_MS = 400;

/**
 * 合并回路（v3.38 核心）：
 * 「拿取」在视频里的真实形态 = 伸手(0.5s) + 调握姿(0.2s) + 合指(0.4s)，
 * 中间微停顿把能量曲线断开。合并判据：
 *  - 两段由 **微止点**（<500ms 静止）分隔 —— 长静止分隔的不并（那是真换动作）
 *  - 合并后时长 ≤ MAX_SEG_MS（IE 单动作生理上限）
 *  - 合并后「运动时长占比」更高（合并消掉的静置 > 疑似噪声），防止把长休息并进动作
 *  - 左右半区主导一致（左手拿 + 右手装的中间停顿不能并成一段）
 */
const MERGE_MAX_MS = 4000;

/** R1 时长护栏 */
const MIN_SEG_MS = 300;
const MAX_SEG_MS = 6000;
/** R3 与人工块边界最小间隔 */
const EDGE_GAP_MS = 80;

/** 手别建议比值阈值 */
const HAND_RATIO = 1.3;
/** 「段内几乎无动作」噪声基线（实测该视频帧差低位 1.8–2.9） */
const DEAD_SEG_CAP = 3;

/**
 * 分类特征阈值（v3.38，全部来自本视频实测标定，换工位复测）：
 * 分类只认「运动学上可区分」的 6 类，不确定的留给人工 —— 宁缺勿错（CMC 铁律同源）。
 */
const CLS = {
  /** 静止（等待/持住候选）：段内能量峰值都低于噪声基线 */
  stillPeak: 4.5,
  /** 位移显著的移物类：运动质心净位移 / 画面对角线 */
  moveDisp: 0.045,
  /** 长时低幅（检查/目视类）：时长下限 + 能量上限 */
  inspectMinMs: 1500,
  inspectMaxEnergy: 9,
  /** 高能量短动作（装配/操作类）：能量下限 + 时长上限 */
  actMinEnergy: 8,
  actMaxMs: 2500,
} as const;

interface EnergyPoint {
  t: number;
  roi: number;
  left: number;
  right: number;
  /** 本帧运动像素的质心（归一化坐标，相对 ROI）；无运动时为 null */
  cx: number | null;
  cy: number | null;
  /** 运动像素数 / ROI 像素数（活跃面积比 0–1） */
  area: number;
}

/** 段的运动学特征（分类输入） */
interface SegFeat {
  durMs: number;
  eMean: number;
  ePeak: number;
  /** 运动质心净位移 / 画面对角线 */
  disp: number;
  /** 质心路径长度 / 画面对角线 */
  path: number;
  /** 活跃面积比均值 */
  area: number;
  /** 左/右半区相对基线能量比 */
  rL: number;
  rR: number;
}

/** 分类结果：类型 + 依据（依据必须可展示给用户，可解释性是铁律） */
interface ClsOut {
  type: string;
  basis: string;
  confAdj: number; // 分类置信修正（乘到 conf 上）
}

function overlaps(a: ReservedRange, start: number, end: number, gap: number): boolean {
  return start < a.end_ms + gap && end > a.start_ms - gap;
}

function covered(a: ReservedRange, start: number, end: number): boolean {
  return start < a.end_ms && end > a.start_ms;
}

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

function resolveDuration(video: HTMLVideoElement): number {
  const raw = video.duration;
  if (Number.isFinite(raw) && raw > 0) return raw;
  const seekEnd = video.seekable && video.seekable.length
    ? video.seekable.end(video.seekable.length - 1) : NaN;
  return Number.isFinite(seekEnd) && seekEnd > 0 ? seekEnd : 0;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * 主流程：视频 → 候选分段（带类型建议与描述骨架）
 */
export async function analyzeMotion(
  video: HTMLVideoElement,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const t0 = Date.now();
  const signal = opts.signal;
  const reserved = opts.reserved ?? [];
  /** v3.43：ROI 逐工位标定（工位 roi 列 / 框选校准），缺省回退 PA10 默认值 */
  const ROI: Roi = opts.roi ?? DEFAULT_ROI;
  /** v3.44 P2-1：功能区子区（HOI 对象层）；未配置 = 整条 HOI 链静默关闭，行为与 v3.43 一致 */
  const ZONES = opts.zones ?? [];

  const dur = resolveDuration(video);
  if (!(dur > 0)) {
    throw new Error('无法读取视频时长（该文件可能未正确封装时长信息）');
  }
  const totalMs = Math.max(0, Math.floor(dur * 1000));
  const totalFrames = Math.max(1, Math.floor(totalMs / MOTION_SAMPLE_MS));

  const cv = document.createElement('canvas');
  cv.width = GW;
  cv.height = GH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建分析画布（浏览器拒绝 2D 上下文）');

  const rx0 = Math.round(GW * ROI.x);
  const rx1 = Math.round(GW * (ROI.x + ROI.w));
  const ry0 = Math.round(GH * ROI.y);
  const ry1 = Math.round(GH * (ROI.y + ROI.h));
  const sx = Math.round(GW * SPLIT_X);
  const roiArea = (rx1 - rx0) * (ry1 - ry0);
  /** 运动像素判定阈值：帧差超过此值算「动了」（滤噪，实测噪声基线 ~3） */
  const PX_THRESH = 6;
  const diag = Math.hypot(GW, GH);

  opts.onProgress?.({ phase: 'load', processedMs: 0, totalMs, detected: 0 });

  const points: EnergyPoint[] = [];
  let prev: Float32Array | null = null;

  for (let i = 0; i < totalFrames; i += 1) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const tMs = Math.min(i * MOTION_SAMPLE_MS, Math.max(0, totalMs - 1));
    await seekTo(video, tMs / 1000);
    ctx.drawImage(video, 0, 0, GW, GH);
    const px = ctx.getImageData(0, 0, GW, GH).data;

    const gray = new Float32Array(GW * GH);
    for (let k = 0, j = 0; k < px.length; k += 4, j += 1) {
      gray[j] = px[k] * 0.299 + px[k + 1] * 0.587 + px[k + 2] * 0.114;
    }

    if (prev) {
      let sr = 0, nr = 0, sl = 0, nl = 0, srr = 0, nrr = 0;
      let sumX = 0, sumY = 0, nMov = 0;
      for (let y = ry0; y < ry1; y += 1) {
        const row = y * GW;
        for (let x = rx0; x < rx1; x += 1) {
          const d = Math.abs(gray[row + x] - prev[row + x]);
          sr += d;
          nr += 1;
          if (x < sx) { sl += d; nl += 1; } else { srr += d; nrr += 1; }
          if (d > PX_THRESH) { sumX += x; sumY += y; nMov += 1; }
        }
      }
      points.push({
        t: tMs,
        roi: nr ? sr / nr : 0,
        left: nl ? sl / nl : 0,
        right: nrr ? srr / nrr : 0,
        cx: nMov ? sumX / nMov / GW : null,
        cy: nMov ? sumY / nMov / GH : null,
        area: nMov / roiArea,
      });
    }
    prev = gray;

    if (i % 5 === 0) {
      opts.onProgress?.({ phase: 'scan', processedMs: tMs, totalMs, detected: 0 });
    }
  }

  opts.onProgress?.({ phase: 'segment', processedMs: totalMs, totalMs, detected: points.length });

  if (points.length < 4) {
    return { candidates: [], elapsedMs: Date.now() - t0, sampleMs: MOTION_SAMPLE_MS, frames: points.length };
  }

  // ---- 静止判定（不变） ----
  const still = points.map((p, i) => {
    const lo = Math.max(0, i - STILL_WIN);
    const hi = Math.min(points.length, i + STILL_WIN + 1);
    const med = median(points.slice(lo, hi).map((x) => x.roi));
    return p.roi < med * STILL_RATIO && p.roi < STILL_CAP;
  });

  // ---- 分级止点：收集所有静止区间，按长度分级 ----
  const runs: { startIdx: number; endIdx: number; len: number }[] = [];
  let run = 0, runStart = 0;
  for (let i = 0; i < still.length; i += 1) {
    if (still[i]) {
      if (run === 0) runStart = i;
      run += 1;
    } else if (run > 0) {
      runs.push({ startIdx: runStart, endIdx: i - 1, len: run });
      run = 0;
    }
  }
  if (run > 0) runs.push({ startIdx: runStart, endIdx: still.length - 1, len: run });

  /** kind: 'long' = 确定边界；'micro' = 合并候选 */
  interface Stop { t: number; idx: number; kind: 'long' | 'micro' }
  const stops: Stop[] = [];
  for (const r of runs) {
    if (r.len >= LONG_STILL_POINTS) {
      stops.push({ idx: r.startIdx + Math.floor(r.len / 2), t: points[r.startIdx + Math.floor(r.len / 2)].t, kind: 'long' });
    } else if (r.len >= MICRO_STILL_POINTS) {
      stops.push({ idx: r.startIdx + Math.floor(r.len / 2), t: points[r.startIdx + Math.floor(r.len / 2)].t, kind: 'micro' });
    }
  }
  // 去重（间隔过近只留一个，保留更高级别）
  stops.sort((a, b) => a.t - b.t);
  const uniq: Stop[] = [];
  for (const s of stops) {
    const last = uniq[uniq.length - 1];
    if (!last || s.t - last.t >= CUT_GAP_MS) uniq.push(s);
    else if (s.kind === 'long') last.kind = 'long';
  }

  // ---- 止点 → 原始段（全部按边界切，微止点也先切） ----
  interface RawSeg { start: number; end: number; endKind: 'long' | 'micro' | 'eof' }
  const rawSegs: RawSeg[] = [];
  let prevEnd = 0;
  for (const c of uniq) {
    if (c.t - prevEnd >= MIN_SEG_MS) {
      rawSegs.push({ start: prevEnd, end: c.t, endKind: c.kind });
      prevEnd = c.t;
    }
  }
  if (totalMs - prevEnd >= MIN_SEG_MS) rawSegs.push({ start: prevEnd, end: totalMs, endKind: 'eof' });

  // ---- 合并回路：微止点分隔的相邻段，按判据回填 ----
  // 设计教训：v3.38 首版判据写成「两段都 <1.2s 才并」，而本片段中位段长
  // 1.7s、51.9% 的段落在 1.0–1.9s —— bothShort 永远不成立，合并回路空转
  // （183→178 只并掉 5 条）。修正为按「合并后仍是合理单动作」判断：
  //   ① 同主导侧（B 与谁都能并，L/R 必须同侧）
  //   ② 合并后 ≤ MERGE_MAX_MS（比 MAX_SEG_MS 更紧，宁少并勿过度）
  //   ③ 两侧都不是死段（至少一侧有真实运动事件）—— 防止把休息并进动作
  // 性能：baseOf(points) 是对全序列取中位数（O(n log n)），v3.38 曾在循环内
  // 每段调 2 次导致全片耗时 +30%（527s→684s）。提到循环外算一次，结果不变。
  const mergeBase = baseOf(points);
  const merged: RawSeg[] = [];
  for (const seg of rawSegs) {
    const last = merged[merged.length - 1];
    if (
      last
      && last.endKind === 'micro'
      && seg.start - last.end < 300
      && seg.end - last.start <= MERGE_MAX_MS
    ) {
      const a = segFeat(last.start, last.end, points, diag, mergeBase);
      const b = segFeat(seg.start, seg.end, points, diag, mergeBase);
      // 主导侧一致才并（左手拿完 ≠ 右手装）：B 与谁都能并，L/R 必须同侧
      const sideA = a.rL > a.rR * HAND_RATIO ? 'L' : a.rR > a.rL * HAND_RATIO ? 'R' : 'B';
      const sideB = b.rL > b.rR * HAND_RATIO ? 'L' : b.rR > b.rL * HAND_RATIO ? 'R' : 'B';
      const sideOk = sideA === 'B' || sideB === 'B' || sideA === sideB;
      // 至少一侧有真实运动（两侧皆死 = 两段等待，不该并成一个动作）
      const hasMotion = (a.eMean > DEAD_SEG_CAP || a.ePeak > CLS.stillPeak)
        || (b.eMean > DEAD_SEG_CAP || b.ePeak > CLS.stillPeak);
      if (sideOk && hasMotion) {
        last.end = seg.end;
        last.endKind = seg.endKind;
        continue;
      }
    }
    merged.push({ ...seg });
  }

  // ---- 段特征 + 分类 + 候选 ----
  const baseL = Math.max(0.5, median(points.map((p) => p.left)));
  const baseR = Math.max(0.5, median(points.map((p) => p.right)));

  const candidates: Candidate[] = [];
  let seq = 0;
  for (const s of merged) {
    const durMs = s.end - s.start;
    if (reserved.some((r) => covered(r, s.start, s.end))) continue;
    if (reserved.some((r) => overlaps(r, s.start, s.end, EDGE_GAP_MS))) continue;

    const feat = segFeat(s.start, s.end, points, diag, { baseL, baseR });

    // 手别建议（不变）
    let hand: 'L' | 'R' | 'B' = 'B';
    let handSure = false;
    if (feat.rL > feat.rR * HAND_RATIO) { hand = 'L'; handSure = true; }
    else if (feat.rR > feat.rL * HAND_RATIO) { hand = 'R'; handSure = true; }

    // 分类（规则可解释，只认运动学上可区分的 6 类）
    const cls = classify(feat);

    // ---- v3.44 P2-1：HOI 状态机（对象/位置建议） ----
    // 只在有功能区子区时启用；结果仅填充 object/dest 建议与依据，永不降档（铁律：只建议不裁决）。
    const hoi = ZONES.length ? hoiInfer(points, s.start, s.end, ZONES, ROI) : {};

    // ---- 置信度分层（v3.38b 修正）：段置信与类型置信解耦 ----
    // 设计教训：v3.38 曾把「类型置信」confAdj 当段置信起点，导致
    // 「等待」类(0.4) 全被压 low、「目检/装配」(0.75) 全变 mid ——
    // 类型判得准不准 ≠ 这个段该不该纳入，两者必须分开：
    //   conf   = 段置信（边界/时长/能量质量）→ 决定 tier 与默认纳入
    //   cls    = 类型建议（运动学可解释）  → 只做标记，永不降档
    let conf = 0.9;
    let tier = tierOf(conf);
    const reasons: string[] = [];
    if (durMs < MIN_SEG_MS) { conf = Math.min(conf, 0.45); reasons.push('时长过短'); }
    else if (durMs > MAX_SEG_MS) { conf = Math.min(conf, 0.5); reasons.push('时长过长'); }
    // 合并而来的边界（原本只是 200–500ms 微停顿）不如长静止边界确定 → 中档提示核对
    if (s.endKind === 'micro') { conf = Math.min(conf, 0.75); reasons.push('边界为微停顿合并，建议核对'); }
    // 段内几乎无运动事件：帧差法分不清「人在等」还是「机器自动加工」，
    // 两者处置不同（前者是 NVA 要素、后者该并进上一条），必须人工确认。
    if (feat.eMean < DEAD_SEG_CAP && feat.ePeak < CLS.stillPeak) {
      conf = durMs >= 1500 ? 0.4 : 0.5;
      reasons.push(durMs >= 1500 ? '疑似长等待/机器自动' : '疑似短等待/持住');
    }
    tier = tierOf(conf);
    // 手别不确定 → 只标记（人工一键确认），不降档
    if (!handSure) reasons.push('手别待确认');
    // 类型是建议：运动学不可区分的给「其他」，等待类见上 —— 只提示不降档
    if (cls.type === '其他') reasons.push(`类型待确认（${cls.basis}）`);
    // v3.44 P2-1：配置了子区但拿取/移物类没摸到任何区 → 对象只能人工填
    if (ZONES.length && !hoi.object && !hoi.dest && (cls.type === '拿取' || cls.type === '移物')) {
      reasons.push('未命中任何功能区子区（对象待人工填）');
    }

    seq += 1;
    // ---- v3.43 浪费规则直判（推荐方案 §8 规则化思想落地；规则读段特征，零 LLM 成本）----
    // 只提示不定罪：AI 标记疑似浪费 + 依据，采纳/忽略由人工终裁（三铁律同源）。
    const wasteHints: string[] = [];
    // 等待浪费：整段近静止且 ≥1.5s（等待/持住/机器自动仍需人工分辨，此处只提示）
    if (feat.eMean < DEAD_SEG_CAP && feat.ePeak < CLS.stillPeak && durMs >= 1500) {
      wasteHints.push(`疑似等待浪费（静置 ${(durMs / 1000).toFixed(1)}s，考虑并入循环或重排）`);
    }
    // 双手不平衡：单手能量低于基线（近闲置）而另手显著活跃，持续 ≥2s（行业规则：idle<20%/busy>70% 的能量比等价形式）
    if (durMs >= 2000 && ((feat.rL < 0.6 && feat.rR > 1.3) || (feat.rR < 0.6 && feat.rL > 1.3))) {
      wasteHints.push(`疑似双手不平衡（${feat.rL < feat.rR ? '左' : '右'}手仅基线 ${Math.min(feat.rL, feat.rR).toFixed(2)}×，另手 ${Math.max(feat.rL, feat.rR).toFixed(2)}×）`);
    }
    candidates.push({
      id: `c${seq}`,
      start_ms: s.start,
      end_ms: s.end,
      hand,
      conf: Math.round(conf * 100) / 100,
      tier,
      type: cls.type,
      status: 'pending',
      checked: tier !== 'low',
      reason: reasons.length ? reasons.join('，') : undefined,
      wasteHints: wasteHints.length ? wasteHints : undefined,
      object: hoi.object,
      dest: hoi.dest,
      // 描述骨架挂在 reason 之后由页面拼装（types.Candidate 无此字段，走 desc 规范）
    });
    // 把分类依据放进 reason 尾部（前端候选表直接展示，用户可核）
    const c = candidates[candidates.length - 1];
    if (cls.basis) c.reason = c.reason ? `${c.reason}｜${cls.basis}` : cls.basis;
    // HOI 依据排最后（对象/位置怎么来的，一眼可核）
    if (hoi.basis) c.reason = c.reason ? `${c.reason}｜${hoi.basis}` : hoi.basis;
  }

  return {
    candidates,
    elapsedMs: Date.now() - t0,
    sampleMs: MOTION_SAMPLE_MS,
    frames: points.length,
  };

  // ---- 内部工具 ----

  function baseOf(pts: EnergyPoint[]) {
    return {
      baseL: Math.max(0.5, median(pts.map((p) => p.left))),
      baseR: Math.max(0.5, median(pts.map((p) => p.right))),
    };
  }

  /** 段运动学特征 */
  function segFeat(
    start: number, end: number,
    pts: EnergyPoint[],
    diagonal: number,
    base: { baseL: number; baseR: number },
  ): SegFeat {
    const inSeg = pts.filter((p) => p.t > start && p.t <= end);
    const eMean = mean(inSeg.map((p) => p.roi));
    const ePeak = Math.max(...inSeg.map((p) => p.roi), 0);
    const withC = inSeg.filter((p) => p.cx !== null) as (EnergyPoint & { cx: number; cy: number })[];
    let disp = 0, path = 0;
    if (withC.length >= 2) {
      const f = withC[0], l = withC[withC.length - 1];
      disp = Math.hypot((l.cx - f.cx) * GW, (l.cy - f.cy) * GH) / diagonal;
      for (let i = 1; i < withC.length; i += 1) {
        path += Math.hypot((withC[i].cx - withC[i - 1].cx) * GW, (withC[i].cy - withC[i - 1].cy) * GH);
      }
      path /= diagonal;
    }
    return {
      durMs: end - start,
      eMean,
      ePeak,
      disp,
      path,
      area: mean(inSeg.map((p) => p.area)),
      rL: mean(inSeg.map((p) => p.left)) / base.baseL,
      rR: mean(inSeg.map((p) => p.right)) / base.baseR,
    };
  }

  /**
   * 运动学规则分类 → 公司标准库类型（motion_standard MS1.1 的子集）。
   * 只输出「运动学上可区分」的，分不清的给「其他」让人工定 —— 宁缺勿错。
   * 依据字符串直接进候选表（可解释性）。
   */
  function classify(f: SegFeat): ClsOut {
    // 1) 静置类：整段几乎没有运动 → 等待/持住（两者分不清，默认等待，人工可改持住）
    if (f.eMean < DEAD_SEG_CAP && f.ePeak < CLS.stillPeak) {
      return { type: '等待', basis: '整段能量≈静止', confAdj: 0.4 };
    }
    // 2) 移物类：质心显著位移（拿起来搬到别处）
    if (f.disp >= CLS.moveDisp) {
      return { type: '移物', basis: `质心位移 ${(f.disp * 100).toFixed(0)}% 画面`, confAdj: 0.9 };
    }
    // 3) 检查/目检类：长时间低幅度（看/翻找，不是搬）
    if (f.durMs >= CLS.inspectMinMs && f.eMean < CLS.inspectMaxEnergy && f.disp < CLS.moveDisp) {
      return { type: '目检', basis: `长时(${(f.durMs / 1000).toFixed(1)}s)低幅`, confAdj: 0.75 };
    }
    // 4) 高能短动作：装配/按/压类（原地爆发式）
    if (f.eMean >= CLS.actMinEnergy && f.durMs <= CLS.actMaxMs && f.disp < CLS.moveDisp) {
      return { type: '装配', basis: '原地高能短动作', confAdj: 0.75 };
    }
    // 5) 常规取放：中等能量 + 有位移路径（伸手→握取→收回 的复合）
    if (f.disp >= CLS.moveDisp * 0.5 || f.path >= CLS.moveDisp * 1.5) {
      return { type: '拿取', basis: `中等位移(净${(f.disp * 100).toFixed(0)}%/路径${(f.path * 100).toFixed(0)}%)`, confAdj: 0.85 };
    }
    // 6) 分不清 → 人工定（铁律：宁缺勿错）
    return { type: '其他', basis: `运动学特征不典型(位移${(f.disp * 100).toFixed(0)}%/能量${f.eMean.toFixed(1)})`, confAdj: 0.85 };
  }
}
