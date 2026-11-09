/**
 * AI 动作切分候选层 —— 类型定义（v3.33）
 * 铁律：候选只是「草稿」，永不直接写入 draft / start_ms。
 */

export type Hand = 'L' | 'R' | 'B';

/** UI 三档呈现；数据层保留连续 conf */
export type Tier = 'high' | 'mid' | 'low';

export type CandStatus = 'pending' | 'accepted' | 'rejected';

export interface Candidate {
  /** 会话内唯一，形如 c1 / c2 */
  id: string;
  start_ms: number;
  end_ms: number;
  hand: Hand;
  /** 连续置信度 0–1，两位小数 */
  conf: number;
  tier: Tier;
  /** 一期不承诺分类，恒为「其他」；仅作弱建议 */
  type: string;
  status: CandStatus;
  /** 批量确认预勾选：低置信默认 false */
  checked: boolean;
  /** 低置信原因（R1 时长越界 / R2 手别不确定） */
  reason?: string;
  /** v3.43 浪费规则直判提示（规则读段特征，零 LLM 成本；只提示不定罪，人工终裁） */
  wasteHints?: string[];
  /** v3.44 P2-1 HOI 对象建议：段起点驻留的功能子区名（=拿取的物体所在区） */
  object?: string;
  /** v3.44 P2-1 HOI 位置建议：段终点驻留的功能子区名（=放置的目的区） */
  dest?: string;
}

export type AnalyzePhase = 'load' | 'scan' | 'segment';

export interface AnalyzeProgress {
  phase: AnalyzePhase;
  /** 已处理的视频时间（ms），用于真实进度，不用假百分比 */
  processedMs: number;
  totalMs: number;
  /** 已检出候选数 */
  detected: number;
}

/** 已存在的人工要素区间，用于 R3/R4 去重 */
export interface ReservedRange {
  start_ms: number;
  end_ms: number;
}

export interface AnalyzeOptions {
  /** 人工已有区间，命中则不生成候选 */
  reserved?: ReservedRange[];
  /** v3.43 操作区 ROI（归一化，逐工位标定）；缺省用 DEFAULT_ROI */
  roi?: Roi;
  /** v3.44 P2-1 功能区子区（相对 ROI 的矩形 + 名称）；配置后启用 HOI 对象推断，缺省关闭 */
  zones?: RoiZone[];
  signal?: AbortSignal;
  onProgress?: (p: AnalyzeProgress) => void;
}

/** v3.43 操作区 ROI（归一化 0–1）：换工位/换机位必须重标（PA10 实测教训） */
export interface Roi { x: number; y: number; w: number; h: number }

/**
 * v3.44 P2-1 功能区子区（HOI 对象层）：操作区 ROI 内再划的功能矩形。
 * 坐标相对 ROI（0–1）——质心本来就只在 ROI 内产生，子区出 ROI 永远不会命中。
 * name 是「对象」词源：质心进区停留→跟随→离开 = 拿取该区物体（如「扫码枪卡位」）。
 */
export interface RoiZone { name: string; x: number; y: number; w: number; h: number }

/** 内置默认 ROI：PA10 机位标定值，未配置工位时的回退 */
export const DEFAULT_ROI: Roi = { x: 0.18, y: 0.30, w: 0.60, h: 0.50 };

export interface AnalyzeResult {
  candidates: Candidate[];
  /** 分析消耗的真实墙钟时间（ms），用于向用户如实报告 */
  elapsedMs: number;
  sampleMs: number;
  frames: number;
}

/** 三档阈值：换模型只调这里 */
export const TIER_HIGH = 0.8;
export const TIER_MID = 0.55;

export function tierOf(conf: number): Tier {
  if (conf >= TIER_HIGH) return 'high';
  if (conf >= TIER_MID) return 'mid';
  return 'low';
}

export const HAND_LABEL: Record<Hand, string> = {
  L: '左手',
  R: '右手',
  B: '双手',
};
