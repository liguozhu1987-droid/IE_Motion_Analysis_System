/**
 * 动作类型 → 四类时间桶（批量导出派生列）。
 *
 * 来源：deliverables/批量导出_产线工位VA与动作分析表单_设计方案.md §6.1
 * 与公司《VA Template》的 Work / Machine / Walk / Wait time 四列一一对应。
 *
 * Phase 2（MS1.4）：判定入口升级为 **motion_standard 规则集**的 `time_bucket` 字段，
 * 在「动作标准」配置页（#/standard）随类型维护、随 MS 版本发布，导出每次请求实时读取。
 * 优先级：规则集显式配置 → 内置 44 类映射（未在规则集登记的经典动素） → `manual`。
 * 后两级在 `99_说明` 分别列出「内置兜底清单」与「回落清单」，保证可审计、可追溯。
 *
 * 已知口径风险（定稿 §6.1 / §6.6）：
 *   经典动素「移物」= 手部搬运物件，公司词表「移物」= 负载走动，平台共用同一词条。
 *   本版统一按 walk 处理，若为手部移物则 Walk time 会高估；不引入基于 desc 的猜测规则。
 *   转身/弯腰/持住 = manual（躯干动作但无脚步位移），不新设第五桶以免列膨胀。
 */

export type TimeBucket = 'manual' | 'machine' | 'walk' | 'wait';

export const TIME_BUCKET_LABELS: Record<TimeBucket, string> = {
  manual: '手作业(s)',
  machine: '机器(s)',
  walk: '走动(s)',
  wait: '等待(s)',
};

/** 内置映射：显式归桶的类型（覆盖 va_rules 44 类中未在 motion_standard 登记的经典动素） */
const BUCKETED_TYPES: Record<Exclude<TimeBucket, 'manual'>, readonly string[]> = {
  machine: ['机器自动'],
  walk: ['走动', '移物', '移动'],
  wait: ['等待', '可避免延迟', '不可避免延迟', '休息'],
};

const TYPE_TO_BUCKET: Record<string, TimeBucket> = (() => {
  const map: Record<string, TimeBucket> = {};
  for (const bucket of ['machine', 'walk', 'wait'] as const) {
    for (const type of BUCKETED_TYPES[bucket]) map[type] = bucket;
  }
  return map;
})();

const BUCKETS = new Set<string>(['manual', 'machine', 'walk', 'wait']);
export const isBucket = (v: unknown): v is TimeBucket =>
  typeof v === 'string' && BUCKETS.has(v);

/** 内置兜底判定（未配置的类型一律回落 manual） */
export function bucketOf(type: string): TimeBucket {
  return TYPE_TO_BUCKET[String(type ?? '').trim()] ?? 'manual';
}

export interface BucketResolver {
  (type: string): TimeBucket;
  /** 规则集里显式配置了 time_bucket 的类型（供 99_说明 列配置来源，可审计） */
  ruleConfigured?: ReadonlyMap<string, TimeBucket>;
}

/**
 * 从生效的 motion_standard 规则集构造解析器。
 * 规则集结构与「动作标准」配置页一致：groups[].level1 / groups[].subs[].type|level2，
 * 两者均可带 time_bucket；一级与二级同名时二级覆盖（与配置页 byType 同规则）。
 */
export function makeBucketResolver(motionJson: any): BucketResolver {
  const fromRules = new Map<string, TimeBucket>();
  for (const g of motionJson?.groups ?? []) {
    if (!g) continue;
    const l1 = String(g.level1 ?? '').trim();
    if (l1 && isBucket(g.time_bucket)) fromRules.set(l1, g.time_bucket);
    for (const s of g.subs ?? []) {
      const name = String(s?.type ?? s?.level2 ?? '').trim();
      if (name && isBucket(s?.time_bucket)) fromRules.set(name, s.time_bucket);
    }
  }
  const resolve: BucketResolver = (type: string) => fromRules.get(String(type ?? '').trim()) ?? bucketOf(type);
  resolve.ruleConfigured = fromRules;
  return resolve;
}

/**
 * 生成「类型 → 时间桶」完整映射表（供 99_说明）。
 * @param knownTypes 规则集 va_rules.types[].type（44 类），保证说明页覆盖实际启用词表
 * @param resolve    由生效 motion_standard 构造的解析器；省略时用内置兜底（离线契约兼容）
 * @returns 分组清单 + 内置兜底清单 + 回落 manual 清单
 */
export function bucketTable(knownTypes: string[], resolve: BucketResolver = bucketOf): {
  groups: Record<TimeBucket, string[]>;
  fallback: string[];
  builtin: string[];
  ruleConfigured: string[];
} {
  const groups: Record<TimeBucket, string[]> = { manual: [], machine: [], walk: [], wait: [] };
  const seen = new Set<string>();
  const builtin: string[] = [];
  const ruleConfigured: string[] = [];
  for (const raw of knownTypes) {
    const type = String(raw ?? '').trim();
    if (!type || seen.has(type)) continue;
    seen.add(type);
    groups[resolve(type)].push(type);
  }
  // 显式归桶但 va_rules 词表里没有的类型也列出（词表可能与规则集不完全同步）
  for (const bucket of ['machine', 'walk', 'wait'] as const) {
    for (const type of BUCKETED_TYPES[bucket]) {
      if (!seen.has(type)) { groups[resolve(type)].push(type); seen.add(type); }
    }
  }
  // 区分「规则集显式配置」「内置兜底」「完全回落 manual」——便于审计配置覆盖率
  const ruleMap = resolve?.ruleConfigured;
  for (const t of seen) {
    if (ruleMap?.has(t)) ruleConfigured.push(t);
    else if (t in TYPE_TO_BUCKET) builtin.push(t);
  }
  return {
    groups,
    // 回落 = 既不在规则集显式配置、也不在内置映射内的类型
    fallback: groups.manual.filter((t) => !ruleMap?.has(t) && !(t in TYPE_TO_BUCKET)),
    builtin,
    ruleConfigured,
  };
}
