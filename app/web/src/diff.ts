/**
 * 版本 Diff 纯函数（三堂会审 P1：相邻版本要素结构对比，作业专家苏定标设计规范）。
 *
 * 设计要点（与设计文档逐条对应）：
 * - 匹配主链：LCS，匹配键 = 规范化描述 + 类型（element_id 必然变，不用）
 * - 前处理：无描述要素单独走"按起始时间就近贪心"配对（≤50ms），避免拖累 LCS
 * - 未配对：MODIFY 优先（就近 ≤200ms），其余按侧判 ADD/DELETE
 * - 变更判定：结构字段（手别/VA/异常）> 数值字段（时长/评比/宽放/ST，阈值 0.01）> 位移（>50ms）
 * - 汇总：CT 口径与引擎逐字一致 = Σ 非异常要素 std_time
 *
 * 本文件零依赖（不 import 任何运行时模块），可在 Node 下单测：见 test/diff.test.ts。
 */

/** Diff 消费的最小要素形状（Element 的结构子集） */
export interface DiffElement {
  seq: number;
  start_ms: number;
  dur_s: number;
  hand: string;
  type: string;
  desc: string;
  va_class: string;
  outlier_flag: number;
  rating: number;
  allowance: number;
  std_time: number;
}

export type DiffState = 'ADD' | 'DELETE' | 'MODIFY-结构' | 'MODIFY-数值' | 'MOVE' | 'UNCHANGED';

export interface DiffRow {
  state: DiffState;
  /** 前一版侧（DELETE / 修改行为旧值） */
  a?: DiffElement;
  /** 当前版侧（ADD / 修改行为新值） */
  b?: DiffElement;
  /** 发生变化的字段键（展示名，如「手别」「时长」） */
  changed: string[];
}

export interface DiffSummary {
  countA: number;
  countB: number;
  ctA: number;
  ctB: number;
  deltaCt: number;
  deltaCtPct: number;
  /** 三类 CT（s）：A 侧 / B 侧 */
  nvaA: number; nvaB: number;
  rnvaA: number; rnvaB: number;
  vaA: number; vaB: number;
  adds: number;
  deletes: number;
  structMods: number;
  numMods: number;
  moves: number;
  unchanged: number;
  /** 配对质量提示（无描述要素按位置近似配对时产生） */
  warnings: string[];
}

export interface DiffResult {
  rows: DiffRow[];
  summary: DiffSummary;
}

/* ---- 常量阈值（设计规范 §3）---- */
const NODESC_WINDOW_MS = 50;   // 无描述要素按起始时间就近配对窗口
const MODIFY_WINDOW_MS = 200;  // 未配对要素判 MODIFY 的就近窗口
const MOVE_THRESHOLD_MS = 50;  // 起始位移超过此值且无字段变化 → MOVE
const NUM_EPS = 0.01;          // 数值字段变化阈值

/** 结构字段（变化即 MODIFY-结构）与展示名 */
const STRUCT_FIELDS: Array<{ key: keyof DiffElement; label: string }> = [
  { key: 'hand', label: '手别' },
  { key: 'va_class', label: 'VA 归类' },
  { key: 'outlier_flag', label: '异常标记' },
];

/** 数值字段（变化即 MODIFY-数值）与展示名 */
const NUM_FIELDS: Array<{ key: keyof DiffElement; label: string }> = [
  { key: 'dur_s', label: '时长' },
  { key: 'rating', label: '评比' },
  { key: 'allowance', label: '宽放' },
  { key: 'std_time', label: 'ST' },
];

/** 剥离描述中的 [VA改判|…] 留痕后缀，还原"操作者看到的描述" */
export function normalizeDesc(desc: string): string {
  return String(desc ?? '')
    .replace(/\[VA改判\|[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 标准 LCS 回溯（匹配函数可定制） */
function lcsPairs(a: DiffElement[], b: DiffElement[], match: (x: DiffElement, y: DiffElement) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = match(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (match(a[i], b[j])) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** 数值字段是否有变化（阈值 0.01，规避浮点噪声） */
function numDiff(a: DiffElement, b: DiffElement): string[] {
  const changed: string[] = [];
  for (const f of NUM_FIELDS) {
    const va = Number(a[f.key]) || 0;
    const vb = Number(b[f.key]) || 0;
    if (Math.abs(va - vb) > NUM_EPS) changed.push(f.label);
  }
  return changed;
}

/**
 * 描述兼容性（MODIFY 就近配对的前置守卫）：
 * 完全不同的描述（"装后盖" vs "锁螺丝"）不得静默并成 MODIFY——按规范判 DELETE + ADD 交人工复核；
 * 仅"同描述的改写/包含"（"装后盖" vs "装后盖（左）"）允许配对。宁可人工复核，不可静默错配。
 */
function descCompatible(x: string, y: string): boolean {
  const nx = normalizeDesc(x);
  const ny = normalizeDesc(y);
  if (!nx || !ny) return false;
  if (nx === ny) return true;
  if (nx.includes(ny) || ny.includes(nx)) return true;
  const setX = new Set(nx);
  const setY = new Set(ny);
  let inter = 0;
  for (const c of setY) if (setX.has(c)) inter++;
  const sim = inter / Math.max(setX.size, setY.size);
  return sim >= 0.6 && Math.abs(nx.length - ny.length) <= 4;
}

/** 结构字段是否有变化 */
function structDiff(a: DiffElement, b: DiffElement): string[] {
  const changed: string[] = [];
  for (const f of STRUCT_FIELDS) {
    if (String(a[f.key] ?? '') !== String(b[f.key] ?? '')) changed.push(f.label);
  }
  return changed;
}

/** 单侧 CT 口径：Σ 非异常要素 std_time（与引擎逐字一致） */
function sideCt(els: DiffElement[]): number {
  return r2(els.filter((e) => Number(e.outlier_flag) !== 1).reduce((s, e) => s + (Number(e.std_time) || 0), 0));
}

function sideClassCt(els: DiffElement[], va: string): number {
  return r2(els.filter((e) => Number(e.outlier_flag) !== 1 && e.va_class === va).reduce((s, e) => s + (Number(e.std_time) || 0), 0));
}

/**
 * 计算相邻两版要素结构 Diff。
 * @param prev 前一版要素（按 start_ms 升序）
 * @param curr 当前版要素（按 start_ms 升序）
 */
export function computeDiff(prev: DiffElement[], curr: DiffElement[]): DiffResult {
  const a = [...prev].sort((x, y) => x.start_ms - y.start_ms);
  const b = [...curr].sort((x, y) => x.start_ms - y.start_ms);
  const warnings: string[] = [];

  /* 1. 拆分：有描述（LCS 主链） / 无描述（位置贪心前处理） */
  const aHas: number[] = [];
  const aNo: number[] = [];
  a.forEach((e, i) => (normalizeDesc(e.desc) ? aHas : aNo).push(i));
  const bHas: number[] = [];
  const bNo: number[] = [];
  b.forEach((e, i) => (normalizeDesc(e.desc) ? bHas : bNo).push(i));

  const pairA = new Map<number, number>(); // aIdx → bIdx
  const pairB = new Map<number, number>(); // bIdx → aIdx

  /* 2. 有描述：LCS（规范化描述 + 类型） */
  for (const [ia, ib] of lcsPairs(aHas.map((i) => a[i]), bHas.map((i) => b[i]),
    (x, y) => normalizeDesc(x.desc) === normalizeDesc(y.desc) && x.type === y.type)) {
    pairA.set(aHas[ia], bHas[ib]);
    pairB.set(bHas[ib], aHas[ia]);
  }

  /* 3. 无描述：按起始时间就近贪心（≤50ms，各消费一次） */
  const usedB = new Set<number>();
  for (const ia of aNo) {
    let best = -1;
    let bestDist = NODESC_WINDOW_MS;
    for (const ib of bNo) {
      if (usedB.has(ib)) continue;
      const dist = Math.abs(a[ia].start_ms - b[ib].start_ms);
      if (dist <= bestDist) { best = ib; bestDist = dist; }
    }
    if (best >= 0) {
      pairA.set(ia, best);
      pairB.set(best, ia);
      usedB.add(best);
    }
  }
  if (aNo.length > 0 || bNo.length > 0) {
    warnings.push(`有 ${aNo.length + bNo.length} 个要素无描述，按时间位置近似配对，请人工复核`);
  }

  /* 4. 未配对 → MODIFY 优先（就近 ≤200ms 且描述兼容），其余 ADD/DELETE */
  const unmatchedA = a.map((_, i) => i).filter((i) => !pairA.has(i));
  const unmatchedB = b.map((_, i) => i).filter((i) => !pairB.has(i));
  const takenB = new Set<number>();
  for (const ia of unmatchedA) {
    let best = -1;
    let bestDist = MODIFY_WINDOW_MS;
    for (const ib of unmatchedB) {
      if (takenB.has(ib)) continue;
      if (!descCompatible(a[ia].desc, b[ib].desc)) continue;
      const dist = Math.abs(a[ia].start_ms - b[ib].start_ms);
      if (dist <= bestDist) { best = ib; bestDist = dist; }
    }
    if (best >= 0) {
      pairA.set(ia, best);
      pairB.set(best, ia);
      takenB.add(best);
    }
  }

  /* 5. 生成行 */
  const rows: DiffRow[] = [];
  let adds = 0;
  let deletes = 0;
  let structMods = 0;
  let numMods = 0;
  let moves = 0;
  let unchanged = 0;

  for (let ib = 0; ib < b.length; ib++) {
    const ia = pairB.get(ib);
    if (ia === undefined) {
      rows.push({ state: 'ADD', b: b[ib], changed: [] });
      adds++;
      continue;
    }
    const x = a[ia];
    const y = b[ib];
    const struct = structDiff(x, y);
    const num = numDiff(x, y);
    // 描述变化：仅 MODIFY 就近配对（描述兼容）时才可能出现——LCS 等描述不配对。
    // 规格细化：desc 变化必须显式标注，否则"装后盖→装后盖（左）"会被误显示为 UNCHANGED。
    const descChanged = normalizeDesc(x.desc) !== normalizeDesc(y.desc);
    const moved = Math.abs(x.start_ms - y.start_ms) > MOVE_THRESHOLD_MS;
    let state: DiffState;
    if (struct.length > 0) { state = 'MODIFY-结构'; structMods++; }
    else if (num.length > 0 || descChanged) { state = 'MODIFY-数值'; numMods++; }
    else if (moved) { state = 'MOVE'; moves++; }
    else { state = 'UNCHANGED'; unchanged++; }
    const changed = [...struct, ...(descChanged ? ['描述'] : []), ...num];
    rows.push({ state, a: x, b: y, changed: state === 'MOVE' ? ['起点'] : changed });
  }
  for (let ia = 0; ia < a.length; ia++) {
    if (!pairA.has(ia)) {
      rows.push({ state: 'DELETE', a: a[ia], changed: [] });
      deletes++;
    }
  }

  /* 6. 合并排序：按"当前侧优先"的生效起点交错；DELETE 用旧侧起点；同点稳定（当前侧在前） */
  rows.sort((r1, r2) => {
    const t1 = r1.b ? r1.b.start_ms : r1.a!.start_ms;
    const t2 = r2.b ? r2.b.start_ms : r2.a!.start_ms;
    if (t1 !== t2) return t1 - t2;
    const s1 = r1.b ? 0 : 1;
    const s2 = r2.b ? 0 : 1;
    return s1 - s2;
  });

  const ctA = sideCt(a);
  const ctB = sideCt(b);
  const deltaCt = r2(ctB - ctA);
  const summary: DiffSummary = {
    countA: a.length,
    countB: b.length,
    ctA,
    ctB,
    deltaCt,
    deltaCtPct: ctA > 0 ? Math.round((deltaCt / ctA) * 1000) / 10 : 0,
    nvaA: sideClassCt(a, 'NVA'), nvaB: sideClassCt(b, 'NVA'),
    rnvaA: sideClassCt(a, 'RNVA'), rnvaB: sideClassCt(b, 'RNVA'),
    vaA: sideClassCt(a, 'VA'), vaB: sideClassCt(b, 'VA'),
    adds, deletes, structMods, numMods, moves, unchanged,
    warnings,
  };
  return { rows, summary };
}
