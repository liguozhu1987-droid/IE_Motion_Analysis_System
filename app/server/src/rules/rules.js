import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { RuleError } from '../errors.js';
import { compileCondition } from './dsl.js';

let cache = null;

function readJson(file) {
  const full = path.join(config.rulesDir, file);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    throw new RuleError(`规则文件读取失败：${file}`, { file: full, error: err.message });
  }
}

/**
 * 规则集加载与启动期自检（文档00 §2 / 文档02 §9）：
 * - 10 类要素必须有默认归类
 * - 所有条件表达式必须可编译（DSL 语法错误在启动时暴露，而不是运行到某个工位才炸）
 */
export function loadRules(force = false) {
  if (cache && !force) return cache;
  const va = readJson('va_rules.json');
  const waste = readJson('waste_triggers.json');
  const ecrsa = readJson('ecrsa_map.json');
  const redline = readJson('redline_keywords.json');

  const problems = [];
  const TYPES = ['装配', '使用', '取放', '预对', '检验', '搬运', '等待', '寻找选择', '持住', '其他'];
  for (const type of TYPES) {
    if (!va.types?.some((t) => t.type === type)) problems.push(`va_rules 缺少要素类型：${type}`);
  }
  const checkExpr = (expr, where) => {
    if (!expr) return;
    try { compileCondition(expr); } catch (err) { problems.push(`${where} 条件语法错误：${err.message}`); }
  };
  for (const t of va.types ?? []) {
    for (const ex of t.exceptions ?? []) checkExpr(ex.when, `${t.id} 例外`);
  }
  for (const trig of waste.triggers ?? []) {
    if (trig.level === 'element') checkExpr(trig.when, trig.id);
    else checkExpr(trig.agg?.filter, trig.id);
  }
  if (problems.length) throw new RuleError('规则集自检未通过', { problems });

  cache = { va, waste, ecrsa, redline, rv: va.rv ?? 'RV?', wasteRv: waste.rv ?? 'RV?', ecrsaRv: ecrsa.rv ?? 'RV?' };
  return cache;
}

export function defaultVaMap() {
  const map = {};
  for (const t of loadRules().va.types) map[t.type] = t.default;
  return map;
}

export function ruleSnapshot() {
  const rules = loadRules();
  return {
    rv: rules.rv,
    waste_rv: rules.wasteRv,
    ecrsa_rv: rules.ecrsaRv,
    va_types: rules.va.types.map((t) => ({ id: t.id, type: t.type, default: t.default, confidence: t.confidence, exceptions: t.exceptions })),
    waste_triggers: rules.waste.triggers,
    ecrsa: rules.ecrsa.mappings,
    redline: rules.redline,
  };
}
