import { ELEMENT_TYPES, HANDS, VA_CLASSES, VA_MARKER_RE, round1, round2, stripVaMarker } from '../../core/shared/util';

/** 标准工时 = 实测时长 × 评比 × (1+宽放)（MVP computeStd，口径零变化） */
export function computeStd(durS: number, rating: number, allowance: number): number {
  return round2(Number(durS) * Number(rating) * (1 + Number(allowance)));
}

export interface ValidationIssue {
  code: string;
  element_seq?: number | null;
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateInput {
  elements: any[];
  cycle_count?: number | string | null;
  cv?: number | string | null;
}

/** 类型 → 描述格式模板（如「拿取 +对象于 +位置 +距离」）；用于判定该类型是否要求「对象」字段。
 *  由调用方从 motion_standard 规则集注入（单一来源），缺省时退化为「仅查空」的旧口径。 */
export type TypeFormats = Record<string, string | null>;

/** 描述格式模板是否要求「对象」字段（模板含 +对象 片段，即「操作对象」是该类型描述的核心语义） */
function formatRequiresObject(format: string | null | undefined): boolean {
  return !!format && /\+对象/.test(format);
}

/** 描述是否退化为「纯动词」（去 VA 标记、去空白后恰好等于类型动词本身，无任何对象/位置等实质内容）。
 *  这是「漏填操作对象/内容」的精确信号——用户只选了动素类型，没写具体作业内容。 */
function isBareVerb(type: string, desc: string): boolean {
  const stripped = stripVaMarker(desc).replace(/\s+/g, '');
  return stripped.length > 0 && stripped === type.replace(/\s+/g, '');
}

/**
 * 3 条即时校验（文档01 §7，命中即拦截提交）——MVP validation.js 1:1 平移：
 *   V1 必填完整性（seq/起点/时长/手别/类型/描述/VA类别/异常原因/评比/宽放/VA改判标记）
 *   V2 时间轴重叠（同一只手，>500ms 间隙转 W2 警告）
 *   V3 循环数不足（<15 拦截；CV>0.15 须加测至 25）
 * 返回 errors（拦截）与 warnings（黄条提示，不拦截）。
 * @param defaults 类型→默认 VA 映射，由 RulesService.getActive('va_rules') 注入（单一来源）
 */
export function validateSubmission(input: ValidateInput, defaults: Record<string, string>, typeFormats?: TypeFormats): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const { elements, cycle_count: cycleCount, cv } = input;

  if (!Array.isArray(elements) || elements.length === 0) {
    errors.push({ code: 'V1', message: '没有任何要素，无法提交' });
    return { errors, warnings };
  }

  const seqSet = new Set<number>();
  elements.forEach((el, index) => {
    const seq = Number(el.seq);
    const label = Number.isInteger(seq) ? `要素#${seq}` : `第${index + 1}行`;
    if (!Number.isInteger(seq) || seq < 1) errors.push({ code: 'V1', element_seq: null, message: `${label}：seq 必须是 ≥1 的整数` });
    else if (seqSet.has(seq)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：seq 重复` });
    else seqSet.add(seq);

    if (!Number.isFinite(Number(el.start_ms)) || Number(el.start_ms) < 0) {
      errors.push({ code: 'V1', element_seq: seq, message: `${label}：起点 start_ms 必须 ≥0` });
    }
    if (!(Number(el.dur_s) > 0)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：时长必须 >0 秒` });
    if (!HANDS.includes(el.hand)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：手别必须是 L/R/B` });
    if (!ELEMENT_TYPES.includes(el.type)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：要素类型不在动作词表（经典动素+公司动作标准）内` });
    if (!String(el.desc ?? '').trim()) errors.push({ code: 'V1', element_seq: seq, message: `${label}：描述不能为空` });
    // v3.56 描述完整性（用户反馈：多处「拿取」只有类型动词、无操作对象/内容漏填入库）：
    // 描述退化为纯动词（=类型名本身）时，若该类型格式要求「对象」字段 → 拦截；否则仅提示。
    else if (isBareVerb(el.type, el.desc)) {
      const fmt = typeFormats?.[el.type];
      if (formatRequiresObject(fmt)) {
        errors.push({
          code: 'V1',
          element_seq: seq,
          message: `${label}：描述只有动素类型「${el.type}」、缺少作业内容（对象/位置等）——请在结构化描述区补全操作对象后再提交`,
        });
      } else {
        warnings.push({
          code: 'W3',
          message: `${label}：描述仅「${el.type}」，建议补全具体内容（如 对象/距离/角度 等）`,
        });
      }
    }
    if (!VA_CLASSES.includes(el.va_class)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：VA类别必须是 VA/RNVA/NVA` });
    if (Number(el.outlier_flag) === 1 && !String(el.outlier_reason ?? '').trim()) {
      errors.push({ code: 'V1', element_seq: seq, message: `${label}：标记为异常要素时必须填写异常原因` });
    }
    const rating = Number(el.rating);
    if (!(rating >= 0.7 && rating <= 1.25)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：评比系数须在 0.70~1.25` });
    const allowance = Number(el.allowance);
    if (!(allowance >= 0.05 && allowance <= 0.3)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：宽放率须在 0.05~0.30` });

    // VA 类别与类型默认值不一致时，必须带人工裁决标记（规则默认值不允许静默覆盖）
    const def = defaults[el.type];
    if (VA_CLASSES.includes(el.va_class) && def && el.va_class !== def && !VA_MARKER_RE.test(String(el.desc ?? ''))) {
      errors.push({
        code: 'V1',
        element_seq: seq,
        message: `${label}：VA类别(${el.va_class})与类型默认值(${def})不一致，须在描述末尾追加“[VA改判|原|新|理由|人|日期]”标记`,
      });
    }
    if (Number(el.dur_s) < 0.1) warnings.push({ code: 'W1', message: `${label}：时长<0.1s，微动作建议60fps复核` });
  });

  // V2 同一只手的时间轴不得重叠（双手并行合法，不做跨手校验）
  for (const hand of HANDS) {
    const list = elements
      .filter((el) => el.hand === hand)
      .sort((a, b) => Number(a.start_ms) - Number(b.start_ms));
    for (let i = 0; i < list.length - 1; i += 1) {
      const cur = list[i];
      const next = list[i + 1];
      /* v3.29 修复"要素时间重叠"幻影误报：止点按**落库值**（round2，与 submit 的
         dur_s: round2(Number(el.dur_s)) 逐字一致）计算——"校验什么就存什么"。
         旧公式 round(dur*1000) 对 3 位小数时长（如 I/O 产生的 1.996s）判 1996ms 放行，
         落库 round2 → 2.0s 后重载即报 4ms 幻影重叠。网格化 dur（10ms）下两公式恒等。 */
      const end = Number(cur.start_ms) + Math.round(round2(Number(cur.dur_s)) * 1000);
      if (end > Number(next.start_ms)) {
        errors.push({
          code: 'V2',
          element_seq: Number(cur.seq),
          message: `${hand}手第${cur.seq}要素与第${next.seq}要素时间重叠${end - Number(next.start_ms)}ms，请拖拽边界或合并`,
        });
      } else if (Number(next.start_ms) - end > 500) {
        warnings.push({ code: 'W2', message: `${hand}手第${cur.seq}~${next.seq}要素间有${round1((Number(next.start_ms) - end) / 1000)}s未覆盖间隙，可补录“等待”要素` });
      }
    }
  }

  // V3 循环数（有效样本量，CT 可信度前提）
  const cycles = Number(cycleCount);
  const cvValue = Number(cv ?? 0);
  if (!Number.isInteger(cycles) || cycles < 15) {
    errors.push({ code: 'V3', message: `有效循环${Number.isFinite(cycles) ? cycles : 0}个，不足15个，不能提交；CV>0.15时须加测至25` });
  } else if (cvValue > 0.15 && cycles < 25) {
    errors.push({ code: 'V3', message: `CV=${round2(cvValue)}>0.15，循环数须加测至25（当前${cycles}）` });
  }

  return { errors, warnings };
}
