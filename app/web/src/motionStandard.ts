/**
 * 公司动作分解标准（motion_standard 规则集）的解析与运行时加载。
 * 结构源：《动作分解标准.xlsx》（一级/二级/描述格式/起止点/影响因素）+
 *         《VA N-VA Defination v00 20190429.xlsx》（默认增值判定）。
 * 加载优先级：DB 发布版（GET /api/rules/motion_standard）→ 内置兜底副本。
 * 「动作标准」配置页（#/standard）发布后全站即时生效。
 */
import { useEffect, useState } from 'react';
import { MOTION_STANDARD_DEFAULT } from './motionStandardDefault';
import { api } from './api';

/** 一个可选动作类型的完整属性（type=该条目本身：无二级时/有二级的分组一级均为可选，v3.49） */
export interface MotionEntry {
  type: string;
  level1: string;
  level2: string | null;
  desc: string;
  /** 分界标准：起 / 止（融合进软件提示） */
  sp: string;
  ep: string;
  /** 描述格式模板，如「拿取 +对象于 +位置 +距离」；null=无标准格式（如机器自动），描述手写 */
  format: string | null;
  factors: string | null;
  /** 默认增值判定（VA/RNVA/NVA）；null=不参与（不产生默认） */
  va: string | null;
  vaNote?: string | null;
}

export interface MotionGroup {
  level1: string;
  desc: string;
  sp: string;
  ep: string;
  format: string | null;
  factors: string | null;
  va: string | null;
  vaNote?: string | null;
  subs: MotionEntry[];
}

export interface MotionStandard {
  rv: string;
  source: string;
  groups: MotionGroup[];
  /** 全部可选类型（展开后），顺序=配置顺序 */
  entries: MotionEntry[];
  byType: Record<string, MotionEntry>;
}

/** 描述格式的一个字段：对象/位置/距离/属性…；prep=该字段前固定的介词（于/至）；hint=括号说明（如 数量）
 *  kind=字段语义（决定渲染成文本输入还是分段选择）；options=分段选择项（kind 为 angle/steps/depth 时） */
export type FieldKind = 'text' | 'distance' | 'angle' | 'steps' | 'depth';
export interface MotionField {
  name: string;
  prep: string | null;
  hint: string | null;
  kind: FieldKind;
  options?: string[];
}

const PREPS = ['于', '至', '到', '自', '向'];

/** 行程语义化选项集（用户反馈 v3.18：视频场景用部位/角度/步数/程度标识行程，不必逐条量距离）：
 *  - 部位档对应动作等级（IE 手册）：手指1×/手腕2×/前臂3×（黄金作业域）/上臂4×/肩·躯干5×；
 *    正常作业域=前臂半径 35~40cm，最大作业域=全臂约 60cm，超出即起身/弯腰/走步=布局问题
 *  - 转身/弯腰/走动 对应 MODAPTS 身体动作 R2 / B17 / W5，行程单位分别是角度/程度/步数 */
export const BODY_REACH = ['手指', '手腕', '小臂', '大臂', '肩'];
export const TURN_ANGLES = ['90°', '180°', '360°', '多圈'];
export const WALK_STEPS = ['1步', '2步', '3步以上'];
export const BEND_DEPTHS = ['浅弯', '深弯', '蹲起'];

/** 显示「动作行程（部位）」行的类型：手伸向对象执行的动作（拿取/放置/装配/操作系/检查系/清洁/扫描/翻转/拆 +
 *  经典动素里的伸手/握取/移物/定位/装配/拆卸/使用/放手/检查）。转身/弯腰/走动/移物/等待/机器自动 不用部位（各有自己的行程单位）。
 *  v3.49 一级要素可选后补 操作/检查（与其二级 按~拔/目检~检测 行为一致）；移动=走动语义不加 */
export const BODY_REACH_TYPES = new Set<string>([
  '拿取', '放置', '装配', '粘贴', '涂', '按', '压', '抬', '推', '拉', '插', '拔',
  '目检', '点检', '检测', '清洁', '扫描', '翻转', '拆', '操作', '检查',
  '伸手', '握取', '移物', '定位', '装配', '拆卸', '使用', '放手', '检查',
]);

/** 字段语义推断：距离→（走动/移物=步数，其余=mm 选填）；角度→转身；程度→弯腰 */
function inferKind(name: string, type: string): { kind: FieldKind; options?: string[] } {
  if (name === '距离') {
    return type === '走动' || type === '移物' ? { kind: 'steps', options: WALK_STEPS } : { kind: 'distance' };
  }
  if (name === '角度') return { kind: 'angle', options: TURN_ANGLES };
  if (name === '程度') return { kind: 'depth', options: BEND_DEPTHS };
  return { kind: 'text' };
}

/** 解析描述格式模板：「拿取 +对象于 +位置 +距离」→ 字段序列 [对象, 位置(前缀介词于), 距离]。
 *  语义（公司描述实例「拿取 后横梁 于 料箱 150」）：token 尾缀的介词归属**下一个字段**的前缀；
 *  括号说明（如 属性（数量））是该字段的填写提示。type 用于推断字段语义（行程部位化 v3.18）。 */
export function parseFormat(format: string, type = ''): MotionField[] {
  const tokens = String(format ?? '')
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(1) // 首段是动词（=类型名），不是字段
    .map((token) => {
      let rest = token;
      let hint: string | null = null;
      const hm = /^(.+?)（(.+?)）$/.exec(rest);
      if (hm) { rest = hm[1]; hint = hm[2]; }
      let prep: string | null = null;
      if (rest.length > 1 && PREPS.includes(rest.slice(-1))) {
        prep = rest.slice(-1);
        rest = rest.slice(0, -1);
      }
      const { kind, options } = inferKind(rest, type);
      return { name: rest, prep, hint, kind, options };
    })
    .filter((f) => f.name.length > 0);
  // 介词移交给下一个字段作前缀（对象于 + 位置 → 位置 带前缀 于）；kind/options 原样带上
  const fields: MotionField[] = [];
  let pendingPrep: string | null = null;
  for (const f of tokens) {
    fields.push({ name: f.name, prep: pendingPrep, hint: f.hint, kind: f.kind, options: f.options });
    pendingPrep = f.prep;
  }
  return fields;
}

/**
 * 描述联想的标准骨架：直接取运行时 motion_standard.format，不另存一份词表。
 * 例如「拿取 对象 于 位置 距离」；它只是录入提示，选中后仍须按现场替换字段值。
 * 无标准格式的类型（机器自动等）不编造提示。
 */
export function motionFormatHint(entry: Pick<MotionEntry, 'type' | 'format'>): string | null {
  if (!entry.format) return null;
  const fields = parseFormat(entry.format, entry.type);
  const values = Object.fromEntries(fields.map((f) => [f.name, f.name]));
  return buildPreview(entry.type, fields, values, '');
}

/** 由草稿值组合描述预览：动词 +（介词+值）…，空值字段整体跳过；行程以括号紧缀（无空格） */
export function buildPreview(verb: string, fields: MotionField[], values: Record<string, string>, reach: string): string {
  const parts = [verb];
  for (const f of fields) {
    const v = (values[f.name] ?? '').trim();
    if (!v) continue;
    parts.push(f.prep ? `${f.prep} ${v}` : v);
  }
  return parts.join(' ') + (reach ? `（${reach}）` : '');
}

/** 反向解析：把已落库的 desc 拆回结构化字段值 + 行程部位（buildPreview 的逆运算，唯一解析来源）。
 *  用于「切换选中要素时把存储描述完整回填到结构化编辑器」，如实反映数据。
 *  解析规则（按 2026-10-30 ST010 真实语料归纳）：
 *   1. 剥 [VA改判|…] 标记；剥末位行程：全/半角括号「（大臂）」或逗号缀「，小臂」（须命中 BODY_REACH）；
 *   2. 剥句首动词；整句无空格且非「动词开头连写」时不猜字段（返回空）；
 *   3. 文本字段后随介词字段 → 在剩余 token 中找边界：独立介词 token（于/至/到/自/向 任意）→
 *      其前全部 token 归本字段（多词对象 "Dual lock" 完整保留）；无独立介词 → token 内找介词
 *      切点（下标 0 仅当等于下一字段介词，下标 >0 任意介词且其后仍有内容，防「相当于」误切，
 *      覆盖「滑轮支架至导轨安装孔」无空格连写）；仍无边界：全部 token 整体归入本字段
 *      （宁欠勿错：绝不把对象词错放进位置字段）；
 *   4. 介词字段的介词可能已被上一字段作为边界消耗（prepTaken），值默认取 1 个 token（位置通常是单词）；
 *      介词与值粘连（「于物料盒」）按 startsWith 拆开；
 *   5. 末字段吸收全部剩余 token（压/清洁/拆 单字段长描述「导轨上的dual locks，共8个」不丢字；
 *      拿取的额外备注落进距离字段由用户自行清理）。
 *  人工在标题框手写的非标准描述无法对号入座时宁可留空字段，不强行塞值。 */
export function parseDescToFields(format: string | null, type: string, desc: string): { values: Record<string, string>; reach: string } {
  const values: Record<string, string> = {};
  let reach = '';
  if (!desc) return { values, reach };
  let s = desc.replace(/\s*\[VA改判[^\]]*\]\s*$/g, '').trim();
  // 末位行程部位：全/半角括号（大臂），或逗号缀，小臂（须命中 BODY_REACH，避免吞字段值里的括号）
  const pm = /[（(]([^（）()]{1,4})[)）]\s*$/.exec(s);
  if (pm && BODY_REACH.includes(pm[1])) {
    reach = pm[1];
    s = s.slice(0, pm.index).trim();
  } else {
    const cm = /[,，]\s*(手指|手腕|小臂|大臂|肩)\s*$/.exec(s);
    if (cm) { reach = cm[1]; s = s.slice(0, cm.index).trim(); }
  }
  if (type && s.startsWith(type)) s = s.slice(type.length).trim();
  else {
    const sp = s.search(/\s/);
    if (sp < 0) return { values, reach }; // 手写动词与类型不符且无空格：不猜字段
    s = s.slice(sp + 1).trim();
  }
  if (!s) return { values, reach };
  const fields = parseFormat(format ?? '', type);
  if (fields.length === 0) return { values, reach };
  let toks = s.split(/\s+/).filter(Boolean);
  /** token 内找介词切点：下标 0 仅当该介词=下一字段介词（「于物料盒」粘连）；下标>0 任意介词
   *  且介词后仍有内容（「滑轮支架至导轨安装孔」可切；「相当于」介词在词尾、切后为空，不认） */
  const inTokenSplit = (ts: string[], np: string | null): { before: string[]; after: string[] } | null => {
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i];
      for (let j = 0; j < t.length; j += 1) {
        const c = t[j];
        if (!PREPS.includes(c)) continue;
        if (!(j > 0 || c === np)) continue;
        if (j + 1 >= t.length) continue;
        return {
          before: [...ts.slice(0, i), t.slice(0, j)],
          after: [t.slice(j + 1), ...ts.slice(i + 1)],
        };
      }
    }
    return null;
  };
  let prepTaken = false; // 上一字段切割时已把本字段的介词一并消耗
  for (let fi = 0; fi < fields.length && toks.length > 0; fi += 1) {
    const f = fields[fi];
    const isLast = fi === fields.length - 1;
    const np = !isLast ? fields[fi + 1].prep : null;
    if (isLast) { values[f.name] = toks.join(' '); toks = []; break; }
    if (f.prep) {
      if (prepTaken) { prepTaken = false; } // 介词已被消耗，直接取值
      else if (toks[0] === f.prep) { toks = toks.slice(1); }
      else if (toks[0].startsWith(f.prep) && toks[0].length > f.prep.length) {
        values[f.name] = toks[0].slice(f.prep.length); toks = toks.slice(1); continue; // 「于物料盒」粘连
      }
      if (toks.length) { values[f.name] = toks[0]; toks = toks.slice(1); } // 位置通常是单词；剩余归后续字段
      continue;
    }
    if (np) {
      // 文本字段且下一字段带介词：先找独立介词 token（任意介词，兼容标准写「于」用户手写「至/在」）
      const st = toks.findIndex((t) => PREPS.includes(t));
      if (st > 0) { values[f.name] = toks.slice(0, st).join(' '); toks = toks.slice(st + 1); prepTaken = true; continue; }
      if (st === 0) { toks = toks.slice(1); prepTaken = true; continue; } // 对象缺省：只消耗介词
      const split = inTokenSplit(toks, np);
      if (split) {
        const before = split.before.join(' ');
        if (before) values[f.name] = before;
        toks = split.after; prepTaken = true; continue;
      }
      // 无任何介词边界：全部 token 归入本字段（不猜后续字段，防错位）
      values[f.name] = toks.join(' '); toks = []; break;
    }
    // 文本字段且下一字段无介词（目检[对象,属性]、移物[对象,距离]）：取 1 个 token，其余留给后续
    values[f.name] = toks[0]; toks = toks.slice(1);
  }
  return { values, reach };
}

/** 校验并解析标准 JSON（配置页发布内容 / 内置兜底）；结构非法返回 null（调用方回退默认） */
export function parseMotionStandard(json: unknown): MotionStandard | null {
  try {
    const j = json as any;
    if (!j || !Array.isArray(j.groups) || j.groups.length === 0) return null;
    const groups: MotionGroup[] = [];
    const entries: MotionEntry[] = [];
    const byType: Record<string, MotionEntry> = {};
    for (const g of j.groups) {
      if (!g?.level1 || typeof g.level1 !== 'string') return null;
      const base = {
        desc: String(g.desc ?? ''), sp: String(g.sp ?? ''), ep: String(g.ep ?? ''),
        format: g.format ?? null, factors: g.factors ?? null,
        va: g.va ?? null, vaNote: g.vaNote ?? null,
      };
      const subs: MotionEntry[] = Array.isArray(g.subs)
        ? g.subs
            .filter((s: any) => s?.level2)
            .map((s: any) => {
              const entry: MotionEntry = {
                type: String(s.level2), level1: g.level1, level2: String(s.level2),
                desc: String(s.desc ?? base.desc), sp: String(s.sp ?? base.sp), ep: String(s.ep ?? base.ep),
                format: s.format ?? base.format, factors: s.factors ?? base.factors,
                va: s.va ?? base.va, vaNote: s.vaNote ?? base.vaNote,
              };
              return entry;
            })
        : [];
      groups.push({ level1: g.level1, ...base, subs });
      /* v3.49 一级要素可选（用户需求）：有二级的分组，其一级也入可选词表——
       * 条目用分组自身的标准属性（desc/sp/ep/format/va），与二级条目同源同构，
       * 因此选一级生成的标准化描述与选其下二级走完全相同的 parseFormat/buildPreview
       * 链路、字段结构一致（装配：「装配 +对象于 +位置 +距离」与「粘贴 +对象至 +位置 +距离」
       * 同为 对象/位置/距离 三字段）；format 为 null 的分组（移动/检查）与「机器自动」
       * 同语义：无标准格式、描述手写。同名冲突时二级覆盖一级（后写胜出）。 */
      const entry: MotionEntry = { type: g.level1, level1: g.level1, level2: null, ...base };
      entries.push(entry);
      byType[entry.type] = entry;
      for (const s of subs) {
        entries.push(s);
        byType[s.type] = s;
      }
    }
    if (entries.length === 0) return null;
    return { rv: String(j.rv ?? 'MS?'), source: String(j.source ?? ''), groups, entries, byType };
  } catch {
    return null;
  }
}

/** 运行时标准（WorkbenchPage / 配置页共用）：挂载时拉 DB 发布版，失败静默用内置兜底 */
export function useMotionStandard(): MotionStandard {
  const [std, setStd] = useState<MotionStandard>(
    () => parseMotionStandard(MOTION_STANDARD_DEFAULT) as MotionStandard,
  );
  useEffect(() => {
    let alive = true;
    api.rules
      .content('motion_standard')
      .then((res) => {
        const parsed = parseMotionStandard((res as any)?.content);
        if (alive && parsed) setStd(parsed);
      })
      .catch(() => { /* 无 rule:read / 未发布 → 内置兜底 */ });
    return () => { alive = false; };
  }, []);
  return std;
}
