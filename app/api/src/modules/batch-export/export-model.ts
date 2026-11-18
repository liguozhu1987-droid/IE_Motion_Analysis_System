import type { BucketResolver, TimeBucket } from './time-buckets';

/** 单个工位在导出中的全部派生数据（事实层 + 分类层，不落库） */
export interface StationExportRow {
  stationId: string;
  stationName: string;
  version: number;
  /** 当前生效版本全部要素（含异常），已按 seq 升序 */
  elements: any[];
  /** analyzeStation 归类后的要素（含 va_effective / va_confidence） */
  classified: any[];
  /** 有效要素（outlier_flag=0），CT/合计只认这些 */
  active: any[];
  metrics: {
    ct: number; tt: number; element_count: number;
    va: number; rnva: number; nva: number;
    va_pct: number; nva_pct: number;
    outlier_count: number; outlier_s: number;
  };
  wastes: any[];
  /** 本工位四类时间合计（仅有效要素） */
  buckets: Record<TimeBucket, number>;
  /** 命中焦点规则的 element_id（03 表 ★ / 04 表行一一对应） */
  focusIds: Set<string>;
  isBottleneck: boolean;
  /** manual 回落类型占 CT 比（>20% 时 03 表头给配置不足提示） */
  fallbackPct: number;
}

/** 04_动作分析 一行（仅焦点要素；每要素 1 浪费 / 1 ECRS / 1 措施）。
 *  elementId / potential 仅用于 03 表 ★ 关联与排序，不写入 Excel。 */
export interface FocusRow {
  elementId: string;
  stationId: string;
  seq: number;
  desc: string;
  vaLabel: string;
  stdTime: number;
  waste: string;
  ecrs: string;
  measure: string;
  compressible: number | null;
  /** 改善潜力 = ST × factor，排序用，不进表 */
  potential: number;
  ctPct: number;
}

export interface ExportRuleVersions {
  va_rules: string;
  waste_triggers: string;
  ecrsa_map: string;
  motion_standard: string;
}

export interface ExportOptions {
  includeOutliers: boolean;
  includeUndecomposed: boolean;
  withFocus: boolean;
  focusTop: number;
}

export interface ExportModel {
  meta: {
    lineId: string;
    lineName: string;
    company: string;
    region: string;
    productProject: string;
    processType: string;
    /** 范围说明：按任务 / 按产线兼容模式，封面如实标注，不冒充任务号 */
    scopeNote: string;
    /** Phase 2：指定分解任务时带出任务号 + 时间段（封面/各表信息区/文件名三处同现） */
    taskId: string | null;
    taskNo: string | null;
    taskName: string | null;
    periodStart: string;
    periodEnd: string;
    roundType: string | null;
    taskStatus: string | null;
    exportedAt: Date;
    exporter: string;
    ruleVersions: ExportRuleVersions;
    stationCount: number;
    decomposedCount: number;
    elementCount: number;
    activeElementCount: number;
    focusCount: number;
  };
  totals: {
    ct: number; tt: number; balanceRate: number;
    va: number; rnva: number; nva: number;
    vaPct: number; nvaPct: number;
    manual: number; machine: number; walk: number; wait: number;
    outlierCount: number;
    /** 操作工口径 VA% = VA / (CT − 机器时间)，仅 03 合计区与 99_说明 */
    operatorVaPct: number;
  };
  stations: StationExportRow[];
  focus: FocusRow[];
  options: ExportOptions;
  /** Phase 2：由生效 motion_standard 构造的四类时间解析器；离线契约可不传（回落内置映射） */
  bucketResolver?: BucketResolver;
  bucketTable: {
    groups: Record<TimeBucket, string[]>;
    fallback: string[];
    builtin: string[];
    ruleConfigured: string[];
  };
}
