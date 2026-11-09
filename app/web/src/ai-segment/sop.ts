/**
 * SOP 规则对齐 v3.44 —— P2-2 封闭词表自动命名（纯函数，可单测）
 *
 * 行业模式 B（有 SOP 的推荐路径，动作命名与物体识别-行业手段分析.md §二）：
 *   SOP（步骤序列 + 期望动作词）→ AI 候选段 → **序列对齐（LCS）** → 段 × 步骤匹配
 *   → 自动填名称（动词来自 SOP、对象来自 SOP/HOI）→ 人工只处理「对不上」的少数段。
 *
 * 对齐 = 最长公共子序列（LCS）：保留顺序一致的最大匹配；其余落四类——
 *   漏步（SOP 有候选无）/ 重复·多段（动词在 SOP 里但多出的候选段）/
 *   SOP 外动作（词表内但 SOP 没排）/ 待分类（「其他」不参与对齐，不算异常）。
 * 输出只做**提示**（不自动定罪、不动用户手改的描述）——三铁律同源。
 */

export interface SopStep {
  /** 动作动词（封闭词表 = motion_standard 一级/二级名，服务端已校验） */
  verb: string;
  /** 期望对象（可选；对齐命中后填进描述「对象」字段） */
  object?: string;
}

/** 参与对齐的候选（按时间排序后传入） */
export interface SopCand {
  id: string;
  type: string;
  start_ms: number;
}

export type SopKind = 'match' | 'miss' | 'dup' | 'extra' | 'unclassified';

export interface SopAlignItem {
  kind: SopKind;
  /** 候选侧条目才有 */
  candId?: string;
  /** 步骤侧条目才有（0 起） */
  stepIdx?: number;
  /** 候选表/面板直接展示的短句 */
  label: string;
}

export interface SopAlignResult {
  items: SopAlignItem[];
  /** 候选 id → 对齐条目（候选表逐行标注用） */
  byCand: Map<string, SopAlignItem>;
  /** 漏掉的步骤下标（SOP 面板标红用） */
  missedSteps: number[];
  /** 命中的步骤下标 */
  matchedSteps: number[];
  matched: number;
  summary: string;
}

const norm = (s: string) => (s ?? '').trim();

export function alignSop(cands: SopCand[], steps: SopStep[]): SopAlignResult {
  const cs = cands.map((c) => norm(c.type));
  const ss = steps.map((s) => norm(s.verb));
  const n = cs.length;
  const m = ss.length;

  // ---- LCS（序列都很短，O(nm) 无压力） ----
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = cs[i] === ss[j] && cs[i] !== ''
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** 配对结果：candIdx → stepIdx */
  const pair = new Map<number, number>();
  const stepHit = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (cs[i] === ss[j] && cs[i] !== '') {
      pair.set(i, j);
      stepHit.add(j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  const items: SopAlignItem[] = [];
  const byCand = new Map<string, SopAlignItem>();
  const missedSteps: number[] = [];
  const matchedSteps: number[] = [];
  let dupN = 0;
  let uncls = 0;

  // 候选侧
  for (let k = 0; k < n; k += 1) {
    const hit = pair.get(k);
    if (hit !== undefined) {
      matchedSteps.push(hit);
      const it: SopAlignItem = {
        kind: 'match', candId: cands[k].id, stepIdx: hit,
        label: `SOP ✓ 第${hit + 1}步「${ss[hit]}」`,
      };
      items.push(it);
      byCand.set(cands[k].id, it);
      continue;
    }
    if (cs[k] === '' || cs[k] === '其他') {
      uncls += 1;
      const it: SopAlignItem = { kind: 'unclassified', candId: cands[k].id, label: '待分类（SOP 对齐跳过）' };
      items.push(it);
      byCand.set(cands[k].id, it);
    } else if (ss.includes(cs[k])) {
      dupN += 1;
      const it: SopAlignItem = { kind: 'dup', candId: cands[k].id, label: `重复/多段「${cs[k]}」（SOP 含该步骤，确认是否拆细）` };
      items.push(it);
      byCand.set(cands[k].id, it);
    } else {
      const it: SopAlignItem = { kind: 'extra', candId: cands[k].id, label: `SOP 外动作「${cs[k]}」（词表内但未排入步骤）` };
      items.push(it);
      byCand.set(cands[k].id, it);
    }
  }

  // 步骤侧（漏步按 SOP 原顺序）
  for (let k = 0; k < m; k += 1) {
    if (stepHit.has(k)) continue;
    missedSteps.push(k);
    items.push({ kind: 'miss', stepIdx: k, label: `漏步 第${k + 1}步「${ss[k]}」（候选中未找到）` });
  }

  const extraN = items.filter((it) => it.kind === 'extra').length;
  const summary = m === 0
    ? 'SOP 未配置步骤'
    : `对齐 ${matchedSteps.length}/${m} 步 · 漏步 ${missedSteps.length} · 重复 ${dupN} · SOP外 ${extraN} · 待分类 ${uncls}`;

  return { items, byCand, missedSteps, matchedSteps, matched: matchedSteps.length, summary };
}
