/** 动素三分法（Therblig，用户 2026-10-22 审定替代原 10 类粗分）：
 *  有效动素 → VA（直接改变产品形态/性能，改善靠"简"不靠"删"）
 *  辅助动素 → RNVA（当前工艺条件下必需，只能压缩不能直接删）
 *  无效动素 → NVA（纯浪费，优先直接消除）
 *  类型的默认 VA 类别即由所属分组决定；va_rules.json 的词表必须与此一致（后端启动自检）。 */
export const THERBLIG_GROUPS: { id: string; name: string; va: string; hint: string; types: string[] }[] = [
  {
    id: 'effective', name: '有效动素', va: 'VA',
    hint: '直接改变产品形态或性能——改善靠简化（动作经济），不靠删除',
    types: ['伸手', '握取', '移物', '定位', '装配', '拆卸', '使用', '放手'],
  },
  {
    id: 'auxiliary', name: '辅助动素', va: 'RNVA',
    hint: '当前工艺条件下必需（找料/搬运/预置/检查）——只能压缩，不能直接删',
    types: ['寻找', '发现', '选择', '思考', '预置', '检查'],
  },
  {
    id: 'ineffective', name: '无效动素', va: 'NVA',
    hint: '纯浪费——优先直接消除（治具/目视化/布局/自动化）',
    types: ['持住', '可避免延迟', '不可避免延迟', '休息'],
  },
];

/** 全量类型词表（18 动素 + 其他兜底）；顺序即下拉分组顺序 */
export const TYPES: string[] = [...THERBLIG_GROUPS.flatMap((g) => g.types), '其他'];

/** 类型默认 VA 类别（经典动素=三分法分组；公司动作类型=VA N-VA Defination 判定表。
 *  运行时以 motion_standard 规则集（DB 发布版）为准，此处为兜底——两者一致（RV3.0/MS1.0）。
 *  MS1.2 勘误：补 移动/操作 一级分组兜底（原为空，v3.49 一级可选后不能无默认）；
 *  MS1.3 收敛（用户 2026-10-28 裁定）：「检查」统一为 RNVA——检查一般不增值，客户/规范要求时属
 *  必要非增值，须持续改善检查方法与技术、逐步减少。原经典动素「检查=VA」口径作废（自有效动素组
 *  移入辅助动素组），与公司检查分组（目检/点检/检测）口径统一，两处兜底同值不再冲突。 */
export const TYPE_DEFAULTS: Record<string, string> = Object.fromEntries(
  THERBLIG_GROUPS.flatMap((g) => g.types.map((t) => [t, g.va] as [string, string])),
);
TYPE_DEFAULTS['其他'] = 'RNVA';
// 公司动作标准（《动作分解标准.xlsx》+《VA N-VA Defination v00》判定表；装配/移物 与经典动素共用同值）
Object.assign(TYPE_DEFAULTS, {
  拿取: 'NVA', 放置: 'RNVA', 走动: 'NVA', 粘贴: 'VA', 涂: 'VA',
  按: 'RNVA', 压: 'RNVA', 抬: 'RNVA', 推: 'RNVA', 拉: 'RNVA', 插: 'RNVA', 拔: 'RNVA',
  目检: 'RNVA', 点检: 'RNVA', 检测: 'RNVA', 清洁: 'RNVA', 扫描: 'VA', 翻转: 'RNVA',
  拆: 'RNVA', 转身: 'NVA', 弯腰: 'RNVA', 等待: 'NVA', 机器自动: 'RNVA',
  移动: 'RNVA', 操作: 'RNVA',
} as Record<string, string>);

/** 类型的一行释义（下拉 title / 帮助浮层用；帮新手选对类型） */
export const TYPE_HINT: Record<string, string> = {
  伸手: '空手伸向目标（不含取物）',
  握取: '合上手指、拿起对象',
  移物: '手持对象移动位置（取放中的"运"）',
  定位: '对准/半搭/预留，不上紧',
  装配: '最终装上、拧紧、连接',
  拆卸: '拆下、松开已装部件',
  使用: '开动设备、加工、设备运转',
  放手: '放开对象、放到目的地',
  检查: '动手量/看/测，验证符合',
  寻找: '眼睛或手在找目标（不知道在哪）',
  发现: '搜索结束、看到目标（寻找的终点）',
  选择: '多个目标中挑一个（混料/挑拣）',
  思考: '判断、决定、回忆作业方法',
  预置: '事前摆好工具/料，为下一动作做准备',
  持住: '手当夹具握住不放（哪怕只有 1 秒）',
  可避免延迟: '人等料/找不到/无谓等待——可消除',
  不可避免延迟: '节拍设计/人机配合/工艺固化的等待',
  休息: '休息、喝水、如厕（生理宽放已含）',
  其他: '规则无法判定的类型，请人工归类',
};

export const HAND_LABEL: Record<string, string> = { L: '左手', R: '右手', B: '双手' };

/** VA 三段式符号释义（tooltip/图例/说明文字统一取此表，避免各处措辞不一致） */
export const VA_CLASS_LABEL: Record<string, { full: string; short: string; hint: string }> = {
  VA: { short: 'VA', full: 'Value Added（增值）', hint: '直接改变产品形态或性能的作业' },
  RNVA: { short: 'RNVA', full: 'Required Non-Value Added（必要非增值）', hint: '当前工艺条件下必需：有规范依据的检查、物流所必需的移物、人机配合所需的等待。改善靠取消/合并/重排压缩，不能直接删除；检查类还须持续改善检查方法与技术、逐步减少' },
  NVA: { short: 'NVA', full: 'Non-Value Added（非增值/纯浪费）', hint: '延迟、寻找、持住、冗余检查、往返移物。优先直接消除' },
};

export const VA_COLOR: Record<string, string> = {
  VA: '#0e8074',
  RNVA: '#c9a227',
  NVA: '#c2544b',
};

export const METHOD_LABEL: Record<string, string> = { E: 'E 取消', C: 'C 合并', R: 'R 重排', S: 'S 简化' };

export const FRAME_MS = 33; // 30fps 一帧
export const PX_PER_SEC = 60;

export function stdTime(dur: number, rating: number, allowance: number): number {
  return Math.round(dur * rating * (1 + allowance) * 100) / 100;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
