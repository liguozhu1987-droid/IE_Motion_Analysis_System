/**
 * 词表 / 取整 / 编号 / 描述归一化（MVP shared/util.js 1:1 平移，计算口径零变化）。
 * 规则类词表以 config/rules/va_rules.json 为单一来源；此处常量仅用于输入侧校验与兜底。
 */

/** 动素三分法词表（用户 2026-10-22 审定，Therblig 18 类 + 其他兜底）：
 *  有效动素(VA)：伸手/握取/移物/定位/装配/拆卸/使用/放手
 *  辅助动素(RNVA)：寻找/发现/选择/思考/预置/检查
 *  无效动素(NVA)：持住/可避免延迟/不可避免延迟/休息
 *  「检查」原列有效动素=VA，2026-10-28 用户裁定收敛为 RNVA：检查一般不增值，客户/规范要求时属
 *  必要非增值，须持续改善检查方法与技术、逐步减少。经典动素与公司检查分组（目检/点检/检测）口径统一。
 *  va_rules.json 的 types 必须与此一致（启动自检保证 ≥10 类） */
export const ELEMENT_TYPES_CLASSIC = [
  '伸手', '握取', '移物', '定位', '装配', '拆卸', '使用', '放手', '检查',
  '寻找', '发现', '选择', '思考', '预置',
  '持住', '可避免延迟', '不可避免延迟', '休息',
  '其他',
];
/** 公司动作标准类型（《动作分解标准.xlsx》一级/二级展开；判定表 VA N-VA Defination v00）。
 *  与经典动素并成联合词表：旧数据零迁移，新记录按公司标准选择。装配/移物 两词共用。
 *  v3.49 一级要素可选（分解工作台 TypeSelect）：有二级的分组一级也入词表——
 *  移动/操作 为新增（此前仅可选其二级）；装配/检查 已在经典动素词表（同词共用）。 */
export const COMPANY_MOTION_TYPES = [
  '拿取', '放置', '走动', '粘贴', '涂', '按', '压', '抬', '推', '拉', '插', '拔',
  '目检', '点检', '检测', '清洁', '扫描', '翻转', '拆', '转身', '弯腰', '等待', '机器自动',
  '移动', '操作',
];
export const ELEMENT_TYPES = [...ELEMENT_TYPES_CLASSIC, ...COMPANY_MOTION_TYPES];
/** 类型 → 默认 VA 类别（经典动素=三分法分组；公司类型=VA N-VA Defination 判定表。与 va_rules RV3.0 一致） */
export const TYPE_DEFAULT_VA: Record<string, string> = {
  伸手: 'VA', 握取: 'VA', 移物: 'VA', 定位: 'VA', 装配: 'VA', 拆卸: 'VA', 使用: 'VA', 放手: 'VA', 检查: 'RNVA',
  寻找: 'RNVA', 发现: 'RNVA', 选择: 'RNVA', 思考: 'RNVA', 预置: 'RNVA',
  持住: 'NVA', 可避免延迟: 'NVA', 不可避免延迟: 'NVA', 休息: 'NVA',
  其他: 'RNVA',
  拿取: 'NVA', 放置: 'RNVA', 走动: 'NVA', 粘贴: 'VA', 涂: 'VA',
  按: 'RNVA', 压: 'RNVA', 抬: 'RNVA', 推: 'RNVA', 拉: 'RNVA', 插: 'RNVA', 拔: 'RNVA',
  目检: 'RNVA', 点检: 'RNVA', 检测: 'RNVA', 清洁: 'RNVA', 扫描: 'VA', 翻转: 'RNVA',
  拆: 'RNVA', 转身: 'NVA', 弯腰: 'RNVA', 等待: 'NVA', 机器自动: 'RNVA',
};
export const HANDS = ['L', 'R', 'B'];
export const VA_CLASSES = ['VA', 'RNVA', 'NVA'];
export const WASTE_TYPES = ['持住', '重复取放', '搬运', '等待', '寻找选择', '检验冗余', '动作浪费'];
export const STATUSES = ['待实施', '已完成', '已验证'];

/** desc 末尾的 VA 人工裁决标记：[VA改判|原:X|新:Y|理由:Z|人:W|日期] / [VA确认|类:X|人:W|日期] */
export const VA_MARKER_RE = /\[VA(改判|确认)\|/;

export function round1(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
}

export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function round3(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

/** 四层一码之要素编码：工位-版本-序号（如 L01-ST01-V2-003） */
export function elementId(stationId: string, version: number, seq: number): string {
  return `${stationId}-V${version}-${String(seq).padStart(3, '0')}`;
}

/** 描述归一化：剥 VA 标记 / 去空白 / 小写（用于相似度比对） */
export function normalizeDesc(desc: string): string {
  return String(desc ?? '')
    .replace(/\[VA(改判|确认)\|[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 提取 desc 中的 VA 裁决标记（无则 null） */
export function extractMarker(desc: string): { type: string; fields: Record<string, string>; raw: string } | null {
  const match = /\[VA(改判|确认)\|([^\]]*)\]/.exec(String(desc ?? ''));
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const part of match[2].split('|')) {
    const idx = part.indexOf(':');
    if (idx > 0) fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return { type: match[1], fields, raw: match[0] };
}

/** 剥掉 desc 末尾旧 VA 标记（改判/确认前调用，保证标记唯一） */
export function stripVaMarker(desc: string): string {
  return String(desc ?? '').replace(/\[VA(改判|确认)\|[^\]]*\]/g, '').trim();
}

/**
 * 编辑距离相似度（0~1），用于前后要素配对 L2 规则（MVP 口径）。
 * 包含关系（如"锁附4颗螺丝"⊂"锁附4颗螺丝(治具夹持)"）给 0.85。
 */
export function similarity(a: string, b: string): number {
  const s = normalizeDesc(a);
  const t = normalizeDesc(b);
  if (s === t) return 1;
  if (!s.length || !t.length) return 0;
  if (s.includes(t) || t.includes(s)) return 0.85;
  const dp: number[][] = Array.from({ length: s.length + 1 }, (_, i) => [i, ...new Array(t.length).fill(0)]);
  for (let j = 1; j <= t.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
  }
  const dist = dp[s.length][t.length];
  return 1 - dist / Math.max(s.length, t.length);
}

/** 今日日期（ISO，用于 VA 标记留痕） */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
