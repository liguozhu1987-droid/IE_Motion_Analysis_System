import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { BadRequestError } from '../../errors.js';
import { log } from '../../logger.js';
import { round3, today } from '../../shared/util.js';

const FILE = () => path.join(config.configDir, 'benefit_params.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return { by_line: {} };
  }
}

/** 收益参数：线级一条；费率/日产量无默认值，未配置则阻止收益计算（文档03 §4.3） */
export function getParams(lineId) {
  const data = readAll();
  return data.by_line?.[lineId] ?? null;
}

export function saveParams(lineId, payload) {
  if (!lineId) throw new BadRequestError('缺少 line_id');
  const rate = Number(payload.rate_yuan_per_hour);
  const output = Number(payload.daily_output);
  const realization = payload.realization_rate === undefined ? 0.7 : Number(payload.realization_rate);
  const errors = [];
  if (!Number.isFinite(rate) || rate < 10 || rate > 500) errors.push('综合费率须在 10~500 元/工时之间');
  if (!Number.isFinite(output) || output < 1 || output > 100000) errors.push('日产量须在 1~100000 件/日之间');
  if (!Number.isFinite(realization) || realization <= 0 || realization > 1) errors.push('落地率须在 (0,1] 之间');
  if (errors.length) throw new BadRequestError('收益参数校验未通过', { errors });
  if (!payload.configured_by) throw new BadRequestError('缺少配置人 configured_by');

  const data = readAll();
  data.by_line = data.by_line ?? {};
  const saved = {
    rate_yuan_per_hour: round3(rate),
    daily_output: Math.round(output),
    realization_rate: round3(realization),
    configured_by: String(payload.configured_by).slice(0, 30),
    configured_at: today(),
  };
  data.by_line[lineId] = saved;
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE());
  log.info('收益参数已保存', { line_id: lineId, rate, output, realization });
  return saved;
}

/** 参数一致性提示（不拦截，返回 warnings） */
export function consistencyWarnings(params, ttSeconds) {
  const warnings = [];
  if (!params || !ttSeconds) return warnings;
  const theoretical = (3600 * 8 / ttSeconds); // 按8h有效工时与TT估算理论产能
  if (params.daily_output > theoretical * 1.05) {
    warnings.push(`日产量 ${params.daily_output} 件/日 高于TT理论产能 ${Math.round(theoretical)} 件/日，请在报告脚注注明`);
  }
  return warnings;
}
