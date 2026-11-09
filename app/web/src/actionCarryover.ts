/**
 * 动作衔接与对象继承（v3.26 用户反馈：动作对象智能预填）。
 * 专业底稿：IE 专家团劳永逸（动作经济/动素分析）《动作衔接与对象继承映射表》
 * （依据：动素链 握取G→移物M→装配A→放手RL、动作经济四原则、ECRS、人机联作与防错原理）。
 *
 * 三级预填策略（专家落地建议①）：
 *   yes         = 自动预填对象（在手链铁律：对象自拿取进入在手状态，至放置交出，期间加工/移送/检查类默认同对象）；
 *   conditional = 预填 + 「请确认」标注（检查后分流/设备边界/工具耗材等软件不可预知情形）；
 *   no          = 一律留空（新循环断点：下一为拿取/握取，或上一条为放置/放手）。
 * 设计原则：只预填不代填；宁缺勿滥（错填比不填更伤效率与数据可信度）；未收录类型对默认 no。
 */

/** 继承判定：yes=在手链内自动继承；conditional=预填待确认；no=不继承 */
export type CarryLevel = 'yes' | 'conditional' | 'no';

/** yes 级：上一动作 → 允许自动继承对象的紧接动作（在手组合链） */
const CARRY_YES: Record<string, string[]> = {
  // 取放链中段：对象在手，移送/落位/施工/检查同对象，直到放置
  拿取: ['移物', '放置', '插', '按', '压', '涂', '粘贴', '扫描', '清洁'],
  移物: ['放置', '插', '按', '压', '涂', '粘贴', '扫描', '清洁', '目检', '点检', '检测', '翻转'],
  // 施工链：贴附/涂布/压合/插入后针对同一工件继续
  粘贴: ['按', '压', '清洁', '目检', '点检', '检测'],
  涂: ['粘贴', '按', '压', '清洁', '目检', '点检', '检测'],
  插: ['按', '压', '点检', '目检', '检测', '拔'], // 拔=返工分支同对象
  拔: ['放置', '检测', '目检', '点检', '清洁'], // 拔出物在手；拔→拿取（新件）不继承
  抬: ['移物', '放置'], // 抬起后移送/落位同对象
  翻转: ['目检', '点检', '检测', '清洁'], // 翻面后检/清另一面
  // 经典动素（旧数据兼容，等同 MS 链）
  伸手: ['握取', '移物', '拿取'],
  握取: ['移物', '放置', '插', '按', '压', '涂', '粘贴', '扫描', '清洁', '装配'],
  定位: ['插', '按', '压', '粘贴', '放置', '装配'],
  装配: ['放置', '目检', '点检', '检测', '按', '压'],
  拆卸: ['移物', '放置', '目检', '点检', '检测', '拔'],
  使用: ['放置', '目检', '点检', '检测', '清洁', '按', '压'],
  持住: ['移物', '放置', '插', '按', '压', '涂', '粘贴', '扫描', '清洁', '目检', '点检', '检测', '翻转', '拔', '拉', '推', '抬'], // 在手对象延续（持住本身=浪费，另由分析层提示）
};

/** conditional 级：预填但必须人工确认（检查后 OK/NG 分流、设备边界、对象语义切换） */
const CARRY_CONDITIONAL: Record<string, string[]> = {
  放置: ['按', '压', '目检'], // 对象已交接；仅针对刚落位件时成立
  按: ['目检', '点检'],
  压: ['目检', '点检'],
  推: ['拉', '目检'],
  拉: ['目检', '放置', '点检', '检测'],
  目检: ['翻转', '清洁', '按', '压', '涂', '粘贴'], // OK→放置（断）由 no 覆盖；此处仅 NG 返工路
  点检: ['翻转', '清洁', '按', '压', '涂', '粘贴'],
  检测: ['拔', '点检', '目检', '按', '压'],
  清洁: ['目检', '点检', '涂', '粘贴', '按', '压'],
  扫描: ['放置', '插', '按', '涂', '压', '粘贴'],
  拆: ['放置', '清洁', '拆'], // 拆的对象=包装；仅对包装续作成立；拆→拿取（内容物）不继承
  弯腰: ['放置', '移物'], // 待取件→否、手持搬运姿态→是，人工确认
  检查: ['按', '压', '清洁', '翻转', '涂', '粘贴'], // OK→放手（断）、NG→返工（继）
  寻找: ['握取', '拿取'], // 偏是：找到物即握取物
  发现: ['握取', '拿取'],
  选择: ['握取', '拿取'],
  预置: ['使用', '按', '压', '涂', '清洁', '扫描'], // 对象=治具/工具而非工件，需确认
};

/** 无对象语义类型：既不作继承源也不作继承目标（行走/姿态/迟延/设备段；手持携带由"在手状态"概念承载，本版不建模） */
const NO_OBJECT_TYPES = new Set<string>(['转身', '走动', '等待', '机器自动', '思考', '可避免延迟', '不可避免延迟', '休息']);

/** 经典动素 → MS1.1 等价类型（旧数据兼容：继承关系统一按新版语义判定） */
const CLASSIC_EQUIV: Record<string, string> = {
  伸手: '拿取', 握取: '拿取', 定位: '放置', 装配: '插', 拆卸: '拔', 使用: '按', 放手: '放置', 检查: '目检',
};

/** 判定上一动作 → 下一动作的对象继承级别 */
export function carryLevel(prevType: string, nextType: string): CarryLevel {
  if (!prevType || !nextType || prevType === nextType) {
    // 同型相接默认断链（拿取→拿取=新循环取新件；放置→放置=连续落位两件）；
    // 唯一例外：拆→拆（嵌套包装）、翻转后连续检查已由各自集合显式列出
    if (prevType === '拆' && nextType === '拆') return 'conditional';
    return 'no';
  }
  if (NO_OBJECT_TYPES.has(prevType) || NO_OBJECT_TYPES.has(nextType)) return 'no';
  const prev = CLASSIC_EQUIV[prevType] ?? prevType;
  const next = CLASSIC_EQUIV[nextType] ?? nextType;
  if ((CARRY_YES[prev] ?? []).includes(next)) return 'yes';
  if ((CARRY_CONDITIONAL[prev] ?? []).includes(next)) return 'conditional';
  return 'no';
}

/** 新循环断点判定（专家总则②）：下一为拿取/握取，或上一条为放置/放手 → 提示"新对象/新循环" */
export function isNewCycleBreak(prevType: string, nextType: string): boolean {
  const next = CLASSIC_EQUIV[nextType] ?? nextType;
  const prev = CLASSIC_EQUIV[prevType] ?? prevType;
  return next === '拿取' || prev === '放置';
}

/** 该类型描述格式中的对象字段名（首个 对象/对象包装 字段）；无则 null */
export function objectFieldName(fields: { name: string }[]): string | null {
  const f = fields.find((x) => x.name === '对象' || x.name.startsWith('对象'));
  return f ? f.name : null;
}

/**
 * 从描述文本提取对象值（继承预填的数据源）：
 *  描述语序 = 动词 + 对象（+介词+位置/距离/属性…）（+（行程）），末可带 [VA改判|…] 标记。
 *  剥标记/行程 → 剥句首动词 → 遇介词（于/至/到/自/向）止；
 *  singleField=true（单字段格式：按/压/拆…）整段即对象；false（次字段无介词：目检/点检/检测）只取首个 token。
 */
export function extractObject(desc: string, verb: string, singleField: boolean): string | null {
  if (!desc) return null;
  let s = desc
    .replace(/\s*\[VA改判[^\]]*\]\s*$/g, '')
    .replace(/（[^）]*）\s*$/g, '')
    .trim();
  if (verb && s.startsWith(verb)) s = s.slice(verb.length).trim();
  else { const sp = s.search(/\s/); if (sp > 0) s = s.slice(sp + 1).trim(); }
  if (!s) return null;
  const m = /^(.+?)\s+(?:于|至|到|自|向)\s+/.exec(s);
  if (m) return m[1].trim() || null;
  if (singleField) return s.trim() || null;
  return s.split(/\s+/)[0] || null;
}
