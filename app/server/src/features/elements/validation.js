import { defaultVaMap } from '../../rules/rules.js';
import { ELEMENT_TYPES, HANDS, VA_CLASSES, round1, round2 } from '../../shared/util.js';

const MARK_RE = /\[VA(改判|确认)\|/;

export function computeStd(durS, rating, allowance) {
  return round2(Number(durS) * Number(rating) * (1 + Number(allowance)));
}

/**
 * 3条即时校验（文档01 §7，命中即拦截提交）
 * V1 必填完整性 / V2 时间轴重叠（同手）/ V3 循环数<15
 * 返回 errors（拦截）与 warnings（黄条提示，不拦截）。
 */
export function validateSubmission({ elements, cycle_count, cv }) {
  const errors = [];
  const warnings = [];
  const defaults = defaultVaMap();

  if (!Array.isArray(elements) || elements.length === 0) {
    errors.push({ code: 'V1', message: '没有任何要素，无法提交' });
    return { errors, warnings };
  }

  const seqSet = new Set();
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
    if (!ELEMENT_TYPES.includes(el.type)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：要素类型不在10类词表内` });
    if (!String(el.desc ?? '').trim()) errors.push({ code: 'V1', element_seq: seq, message: `${label}：描述不能为空` });
    if (!VA_CLASSES.includes(el.va_class)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：VA类别必须是 VA/NNVA/NVA` });
    if (Number(el.outlier_flag) === 1 && !String(el.outlier_reason ?? '').trim()) {
      errors.push({ code: 'V1', element_seq: seq, message: `${label}：标记为异常要素时必须填写异常原因` });
    }
    const rating = Number(el.rating);
    if (!(rating >= 0.7 && rating <= 1.25)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：评比系数须在 0.70~1.25` });
    const allowance = Number(el.allowance);
    if (!(allowance >= 0.05 && allowance <= 0.3)) errors.push({ code: 'V1', element_seq: seq, message: `${label}：宽放率须在 0.05~0.30` });

    const def = defaults[el.type];
    if (VA_CLASSES.includes(el.va_class) && def && el.va_class !== def && !MARK_RE.test(String(el.desc ?? ''))) {
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
      const end = Number(cur.start_ms) + Math.round(Number(cur.dur_s) * 1000);
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

  // V3 循环数
  const cycles = Number(cycle_count);
  const cvValue = Number(cv ?? 0);
  if (!Number.isInteger(cycles) || cycles < 15) {
    errors.push({ code: 'V3', message: `有效循环${Number.isFinite(cycles) ? cycles : 0}个，不足15个，不能提交；CV>0.15时须加测至25` });
  } else if (cvValue > 0.15 && cycles < 25) {
    errors.push({ code: 'V3', message: `CV=${round2(cvValue)}>0.15，循环数须加测至25（当前${cycles}）` });
  }

  return { errors, warnings };
}
