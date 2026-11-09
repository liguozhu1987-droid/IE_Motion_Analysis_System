/**
 * HOI（Human-Object Interaction）状态机 v3.44 —— P2-1 对象层（纯算法，零训练零模型）
 *
 * 行业手段分析（deliverables/ai-segment/动作命名与物体识别-行业手段分析.md §一.3 手段③）：
 *   「手接近→接触→物体跟随手→离开原位」= 拿取；反向 = 放置。
 * 本系统没有检测框（YOLO 是 P3），用**运动质心 × 功能区子区**近似：
 *   - 子区（ROI 内的功能矩形，如「扫码枪卡位」「料箱」）= 物体的"家"；
 *   - 段起点质心在某子区**驻留**（≥2 帧且占比过半）→ 物体在该区（手来拿它/在它上面作业）；
 *   - 段终点驻留在另一子区 → 物体被带到了那里（拿取 A → 放到 B）；
 *   - 起终同区 → 区内作业（装配/目检对象=该区）；只终点有区 → 放置（对象未知）。
 *
 * 铁律不变：推断结果只是**建议**（object/dest 填进描述骨架，人工可改）；
 * 依据字符串可展示（可解释性）；未配置子区时整体静默关闭（分析行为与 v3.43 完全一致）。
 */
import type { Roi, RoiZone } from './types';

/** 质心轨迹点（与 motion.ts EnergyPoint 的 t/cx/cy 对齐；cx/cy 为画布归一化坐标） */
export interface HoiPoint { t: number; cx: number | null; cy: number | null }

export interface HoiOut {
  /** 起点"家"子区名（对象建议） */
  object?: string;
  /** 终点"家"子区名（位置建议） */
  dest?: string;
  /** 可解释依据（进候选 reason 展示） */
  basis?: string;
}

/** 驻留判定：窗口内最少命中帧数（≈200ms @10Hz）与最低占比 */
const DWELL_MIN_FRAMES = 2;
const DWELL_MIN_RATIO = 0.5;
/** 起/终窗口长度：段时长 × 40%，封顶 600ms（长段的"起点"不该看太远） */
const WINDOW_CAP_MS = 600;
const WINDOW_RATIO = 0.4;

/**
 * 判断画布归一化坐标落在哪个子区（返回下标；不在任何区返回 -1）。
 * 子区坐标（相对 ROI）换算到画布空间一次完成。
 */
export function zoneAt(cx: number, cy: number, zones: RoiZone[], roi: Roi): number {
  for (let i = 0; i < zones.length; i += 1) {
    const z = zones[i];
    const x0 = roi.x + z.x * roi.w;
    const y0 = roi.y + z.y * roi.h;
    if (cx >= x0 && cx <= x0 + z.w * roi.w && cy >= y0 && cy <= y0 + z.h * roi.h) return i;
  }
  return -1;
}

/**
 * HOI 状态机主入口：一段的质心轨迹 → { object, dest, basis }。
 * pts 只取 (startMs, endMs] 内的帧（与 segFeat 的口径一致）。
 */
export function hoiInfer(
  pts: HoiPoint[],
  startMs: number,
  endMs: number,
  zones: RoiZone[],
  roi: Roi,
): HoiOut {
  const traj = pts.filter((p) => p.t > startMs && p.t <= endMs && p.cx !== null && p.cy !== null);
  if (!traj.length || !zones.length) return {};

  const durMs = endMs - startMs;
  const win = Math.min(WINDOW_CAP_MS, durMs * WINDOW_RATIO);
  const earlyEnd = startMs + win;
  const lateStart = endMs - win;

  /** 窗口内子区驻留判定：返回 { idx, frames } —— idx=-1 表示窗口无驻留 */
  const dwell = (from: number, to: number): { idx: number; frames: number } => {
    const counts = new Map<number, number>();
    let inWin = 0;
    for (const p of traj) {
      if (p.t < from || p.t > to) continue;
      inWin += 1;
      const zi = zoneAt(p.cx as number, p.cy as number, zones, roi);
      if (zi >= 0) counts.set(zi, (counts.get(zi) ?? 0) + 1);
    }
    if (inWin < DWELL_MIN_FRAMES) return { idx: -1, frames: 0 };
    let best = -1;
    let bestN = 0;
    for (const [zi, n] of counts) if (n > bestN) { best = zi; bestN = n; }
    if (best < 0 || bestN < DWELL_MIN_FRAMES || bestN / inWin < DWELL_MIN_RATIO) return { idx: -1, frames: bestN };
    return { idx: best, frames: bestN };
  };

  const start = dwell(startMs - 1, earlyEnd);
  const end = dwell(lateStart, endMs + 1);
  const sName = start.idx >= 0 ? zones[start.idx].name : null;
  const eName = end.idx >= 0 ? zones[end.idx].name : null;

  // 状态机四种结局（依据字符串全部可展示，不捏造检测细节）
  if (sName && eName && sName !== eName) {
    return { object: sName, dest: eName, basis: `HOI:起于「${sName}」→止于「${eName}」（拿取该区物体放至目的区）` };
  }
  if (sName && eName) {
    return { object: sName, dest: sName, basis: `HOI:全程在「${sName}」内作业（对象=该区）` };
  }
  if (eName) {
    return { dest: eName, basis: `HOI:止于「${eName}」（起于区外，对象未知——放置类候选）` };
  }
  if (sName) {
    return { object: sName, basis: `HOI:起于「${sName}」（去向不在任何子区）` };
  }
  return {};
}
