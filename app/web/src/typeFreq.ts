/**
 * v3.20 动作要素录入加速（IE 动作经济原理落地到 UI）：
 * 冗长下拉 = 用户每次选类型都在做「寻找 + 选择」——按 Therblig 分类这正是 **RNVA 浪费**。
 * 本模块提供三件工具把它压到接近零：
 *  ① 模糊匹配：中文子串 + 拼音首字母 + 车间口语别名（输入"转身"或"转"或"zs"都直达）；
 *  ② 频次排序：选过的类型记频次（localStorage），无查询时常用置顶——最高频选项永远路径最短；
 *  ③ 动词识别：手动录入一句话，自动剥离句首动词归类到对应类型，残留文本回填字段/描述。
 */

/** 全部可选类型的拼音首字母（43 项：公司动作标准 + 经典动素兼容 + 其他） */
const PINYIN: Record<string, string> = {
  // 公司动作标准（motion_standard）
  拿取: 'nq', 放置: 'fz', 走动: 'zd', 移物: 'yw', 粘贴: 'zt', 涂: 'tu', 按: 'an',
  压: 'ya', 抬: 'tai', 推: 'tui', 拉: 'la', 插: 'cha', 拔: 'ba', 目检: 'mj',
  点检: 'dj', 检测: 'jc', 清洁: 'qj', 扫描: 'sm', 翻转: 'fz', 拆: 'chai',
  转身: 'zs', 弯腰: 'wy', 等待: 'dd', 机器自动: 'jqzd',
  // 经典动素（旧数据兼容）
  伸手: 'ss', 握取: 'wq', 定位: 'dw', 拆卸: 'cx', 使用: 'sy', 放手: 'fs',
  检查: 'jc', 寻找: 'xz', 发现: 'fx', 选择: 'xz', 思考: 'sk', 预置: 'yz',
  持住: 'cz', 可避免延迟: 'kbmyc', 不可避免延迟: 'bkbmyc', 休息: 'xx', 其他: 'qt',
};

/** 车间口语别名（不依赖拼音输入法，口头怎么说就怎么打） */
const ALIAS: Record<string, string[]> = {
  转身: ['转', '旋', '转过身'],
  弯腰: ['弯', '哈腰'],
  等待: ['等', '等候'],
  走动: ['走', '走路'],
  移物: ['搬', '搬运', '挪'],
  拿取: ['拿', '拿起'],
  放置: ['放', '放下', '摆放'],
  握取: ['抓', '抓起'],
  伸手: ['伸'],
  检查: ['查看', '检验'],
  目检: ['目测', '看'],
  寻找: ['找'],
  装配: ['装', '安装', '拧'],
  拆卸: ['卸', '拆下'],
  使用: ['开机', '开动'],
  涂: ['刷', '涂抹'],
  按: ['摁'],
  清洁: ['擦', '清理'],
  扫描: ['扫码', '扫'],
  翻转: ['翻'],
  持住: ['握住', '夹持'],
  休息: ['歇'],
  定位: ['对位', '预对'],
  预置: ['预摆'],
  思考: ['想', '判断'],
  选择: ['挑', '拣'],
  发现: ['看到'],
};

/* ---------------- 模糊匹配 ---------------- */

/** 匹配层级（越小越准，排序用）：0 精确 / 1 前缀·别名精确 / 2 子串·别名子串 / 3 拼音首字母 / -1 不匹配 */
export function matchType(type: string, q: string): number {
  const s = q.trim();
  if (!s) return 1; // 空查询 = 全部可显示
  if (type === s) return 0;
  if (type.startsWith(s)) return 1;
  if (type.includes(s)) return 2;
  const lower = s.toLowerCase();
  const py = PINYIN[type];
  if (py && (py.startsWith(lower) || lower.startsWith(py))) return 3;
  const al = ALIAS[type] ?? [];
  if (al.includes(s)) return 1;
  if (al.some((a) => a.includes(s))) return 2;
  return -1;
}

/** 查询串是否命中标签可见部分（用于高亮；拼音/别名命中不画高亮） */
export function visibleHit(label: string, q: string): number {
  const s = q.trim();
  if (!s) return -1;
  return label.indexOf(s);
}

/* ---------------- 频次排序 ---------------- */

const FREQ_KEY = 'wb-type-freq-v1';

export interface TypeFreq {
  /** 选用次数 */
  n: number;
  /** 最近选用时间戳 */
  t: number;
}

export function loadFreq(): Record<string, TypeFreq> {
  try {
    const raw = localStorage.getItem(FREQ_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 选用一次即记频次（隐私模式/超容等写入失败静默跳过，不影响录入） */
export function bumpFreq(type: string): void {
  try {
    const f = loadFreq();
    const cur = f[type] ?? { n: 0, t: 0 };
    f[type] = { n: cur.n + 1, t: Date.now() };
    localStorage.setItem(FREQ_KEY, JSON.stringify(f));
  } catch {
    /* 忽略 */
  }
}

/** 频次分 = 次数 + 3 天内新近加成（老高频让位于新近常用） */
export function freqScore(type: string): number {
  const f = loadFreq()[type];
  if (!f || f.n <= 0) return 0;
  const recent = Date.now() - f.t < 3 * 864e5 ? 1.5 : 0;
  return f.n + recent;
}

/** 常用类型（按分降序）；无历史返回空数组——调用方据此决定是否渲染「常用」区 */
export function topFreqTypes(limit = 5): string[] {
  return Object.keys(loadFreq())
    .filter((t) => (loadFreq()[t]?.n ?? 0) > 0)
    .sort((a, b) => freqScore(b) - freqScore(a))
    .slice(0, limit);
}

/* ---------------- 手动录入：动词识别 + 残留回填 ---------------- */

export interface VerbHit {
  /** 识别出的类型（= 描述句首动词） */
  verb: string;
  /** 剥离动词后的残留文本（对象/位置/行程…） */
  rest: string;
}

/**
 * 从自由文本识别句首动词：类型名与别名一起参与，最长优先
 * （"拆卸后盖" → 拆卸；"拆下后盖" → 拆卸；"拆后盖" → 拆；"转身180度" → 转身 + "180度"）。
 * 识别不出返回 null（调用方归入「其他」）。
 */
export function identifyVerb(text: string, known: string[]): VerbHit | null {
  const s = text.trim();
  if (!s) return null;
  const cands: { verb: string; word: string }[] = [];
  for (const t of known) {
    cands.push({ verb: t, word: t });
    for (const a of ALIAS[t] ?? []) cands.push({ verb: t, word: a });
  }
  cands.sort((a, b) => b.word.length - a.word.length);
  for (const c of cands) {
    if (s.startsWith(c.word)) {
      return { verb: c.verb, rest: s.slice(c.word.length).trim() };
    }
  }
  return null;
}

/** 规范化比较用：去 °/度/步/个/mm/空白（"180度" ≡ "180°"） */
const norm = (s: string) => s.toLowerCase().replace(/[°度步个mm\s]/g, '');

/**
 * 残留文本 → 字段分段选项（先精确后包含，长选项优先）：
 * "180" / "180度" → "180°"；"两步" → "2步"；"浅" → "浅弯"。
 * 命中返回选项原值，未命中返回 null。
 */
export function matchFieldOption(rest: string, options: string[]): string | null {
  const r = norm(rest.trim());
  if (!r) return null;
  const exact = options.find((o) => norm(o) === r);
  if (exact) return exact;
  const contained = options
    .filter((o) => r.includes(norm(o)))
    .sort((a, b) => norm(b).length - norm(a).length)[0];
  return contained ?? null;
}
