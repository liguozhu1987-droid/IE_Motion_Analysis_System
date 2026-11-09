import { getDb, nowIso } from '../../db/index.js';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../../errors.js';
import { loadRules } from '../../rules/rules.js';
import { round2, today } from '../../shared/util.js';
import { analyzeStation } from '../analysis/engine.js';
import { computeCt, elementsOf, getStationRow } from '../stations/service.js';
import { getParams } from '../settings/service.js';

/** 生成候选建议（不落库，IE确认采纳后才写 t_improvement —— 铁律①） */
export function generateCandidates(stationId) {
  const station = getStationRow(stationId);
  const elements = elementsOf(station);
  const analysis = analyzeStation(station, elements);
  const rules = loadRules();
  const params = getParams(station.line_id);
  const freq = params?.daily_output ?? null;
  const byId = new Map(analysis.elements.map((el) => [el.element_id, el]));
  const candidates = [];
  const push = (candidate) => {
    const dup = candidates.some((c) => c.mapping_id === candidate.mapping_id
      && c.element_ids.join(',') === candidate.element_ids.join(','));
    if (!dup) candidates.push(candidate);
  };

  for (const waste of analysis.wastes) {
    const mappings = rules.ecrsa.mappings.filter((m) => m.waste === waste.waste);
    const involvedStd = round2(waste.element_ids.reduce((acc, id) => acc + (byId.get(id)?.std_time ?? 0), 0));
    if (mappings.length === 0) {
      // 检验冗余无标准映射：按需追加人工评估项（并在建议书上标注）
      if (waste.waste === '检验冗余') {
        push({
          mapping_id: null,
          waste_type: waste.waste,
          method: 'E',
          measure: '取消重复确认/合并检验（须品质确认）',
          element_ids: waste.element_ids,
          evidence: waste.evidence,
          est_save_s: round2(involvedStd * 0.5),
          difficulty: 1,
          note: '无标准ECRSA映射，需人工评估（红线：须品质确认）',
          manual: true,
        });
      }
      continue;
    }
    for (const mapping of mappings) {
      push({
        mapping_id: mapping.id,
        waste_type: waste.waste,
        method: mapping.method,
        measure: mapping.measure,
        element_ids: waste.element_ids,
        evidence: waste.evidence,
        est_save_s: round2(involvedStd * mapping.factor),
        difficulty: mapping.difficulty,
        note: mapping.note,
      });
    }
  }

  // 预对专项（M06 对称防呆 / M09 来料定向）：预对要素ST≥2s（文档04 §1 M09）
  const preAlign = analysis.elements.filter((el) => el.outlier_flag === 0 && el.type === '预对' && el.std_time >= 2);
  if (preAlign.length > 0) {
    const sum = round2(preAlign.reduce((acc, el) => acc + el.std_time, 0));
    for (const mapping of rules.ecrsa.mappings.filter((m) => m.id === 'M06' || m.id === 'M09')) {
      push({
        mapping_id: mapping.id,
        waste_type: '预对',
        method: mapping.method,
        measure: mapping.measure,
        element_ids: preAlign.map((el) => el.element_id),
        evidence: `预对要素${preAlign.length}个、ST合计${sum}s（单个≥2s）`,
        est_save_s: round2(sum * mapping.factor),
        difficulty: mapping.difficulty,
        note: mapping.note,
      });
    }
  }

  const freqValue = freq ?? 1;
  for (const candidate of candidates) {
    candidate.raw_priority = round2((candidate.est_save_s * freqValue) / candidate.difficulty);
  }
  const max = candidates.length > 0 ? Math.max(...candidates.map((c) => c.raw_priority), 0.01) : 1;
  for (const candidate of candidates) {
    candidate.priority = Math.round((candidate.raw_priority / max) * 100);
    candidate.tier = candidate.priority >= 60 ? 'P1' : candidate.priority >= 30 ? 'P2' : 'P3';
  }
  candidates.sort((a, b) => b.priority - a.priority);

  return {
    station_id: station.station_id,
    station_name: station.name,
    version: station.version,
    ct: analysis.metrics.ct,
    candidates,
    freq_configured: Boolean(params),
    daily_output: freq,
    note: params ? null : '日产量未配置：优先级按频次=1计算，配置后重算（对比页→参数设置）',
  };
}

/** 采纳候选建议：2条红线=提示+确认后放行，确认标记写 measure 尾部（文档04 §5） */
export function adoptCandidates(stationId, payload) {
  const station = getStationRow(stationId);
  const list = Array.isArray(payload.candidates) ? payload.candidates : [];
  if (list.length === 0) throw new BadRequestError('没有选中任何建议');
  const rules = loadRules();

  const qualityHits = list.filter((c) => c.waste_type === '检验冗余'
    && rules.redline.quality.keywords.some((k) => String(c.measure).includes(k)));
  const ergoHits = list.filter((c) => rules.redline.ergonomics.keywords.some((k) => String(c.measure).includes(k)));

  const requires = [];
  if (qualityHits.length > 0 && !payload.confirmations?.quality) {
    requires.push({ type: 'quality', message: `本批${qualityHits.length}条措施取消/弱化检验，须品质确认（填写确认人+日期）` });
  }
  if (ergoHits.length > 0 && !payload.confirmations?.ergonomics) {
    requires.push({ type: 'ergonomics', message: `本批${ergoHits.length}条措施涉及弯腰/扭转/高举等人因风险，须人因复核` });
  }
  if (requires.length > 0) {
    throw new AppError('红线确认未完成，暂不能采纳', 'REDLINE_CONFIRM_REQUIRED', 422, { requires });
  }

  const markers = [];
  if (payload.confirmations?.quality) markers.push(`[品质确认:${payload.confirmations.quality.name} ${payload.confirmations.quality.date ?? today()}]`);
  if (payload.confirmations?.ergonomics) markers.push(`[人因复核:${payload.confirmations.ergonomics.name} ${payload.confirmations.ergonomics.date ?? today()}]`);

  const db = getDb();
  const created = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT INTO t_improvement
      (imp_id, station_id, element_ids, waste_type, method, measure, est_save_s, priority, status, owner, due, before_ct, after_ct, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    list.forEach((candidate, index) => {
      const impId = `IMP-${stationId}-${Date.now()}-${String(index + 1).padStart(2, '0')}`;
      const measure = `${String(candidate.measure)}${markers.length ? ` ${markers.join(' ')}` : ''}`.slice(0, 300);
      insert.run(
        impId, stationId, (candidate.element_ids ?? []).join(','), candidate.waste_type, candidate.method, measure,
        Number(candidate.est_save_s) || 0, Number(candidate.priority) || 0, '待实施',
        candidate.owner ?? null, candidate.due ?? null, station.CT, null, nowIso(),
      );
      created.push(impId);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { station_id: stationId, created: created.length, imp_ids: created };
}

export function listImprovements(filters = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];
  if (filters.station_id) { conditions.push('i.station_id = ?'); params.push(filters.station_id); }
  if (filters.status) { conditions.push('i.status = ?'); params.push(filters.status); }
  if (filters.line_id) { conditions.push('s.line_id = ?'); params.push(filters.line_id); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT i.*, s.name AS station_name, s.line_id, s.version AS station_version
    FROM t_improvement i JOIN t_station s ON s.station_id = i.station_id
    ${where} ORDER BY i.priority DESC, i.created_at DESC`).all(...params);
}

/** 三态流转：待实施→已完成→已验证（已验证要求存在复测版本，文档04 §4） */
export function updateStatus(impId, payload) {
  const db = getDb();
  const imp = db.prepare('SELECT * FROM t_improvement WHERE imp_id = ?').get(impId);
  if (!imp) throw new NotFoundError('改善建议', impId);
  const next = payload.status;
  const allowed = { 待实施: ['已完成'], 已完成: ['已验证'], 已验证: [] };
  if (!allowed[imp.status]?.includes(next)) {
    throw new ConflictError(`状态不能从「${imp.status}」直接变为「${next}」`, { allowed: allowed[imp.status] });
  }
  if (next === '已验证') {
    const station = getStationRow(imp.station_id);
    const versions = db.prepare('SELECT COUNT(DISTINCT bol_version) AS c FROM t_element WHERE station_id = ?').get(imp.station_id).c;
    if (versions < 2) throw new ConflictError('尚未复测（不存在v(n+1)），不能置为已验证', { hint: '先在该工位点“开始复测”并提交复测分解' });
    const { ct } = computeCt(imp.station_id, station.version);
    db.prepare('UPDATE t_improvement SET status = ?, after_ct = ? WHERE imp_id = ?').run(next, ct, impId);
    return { ...imp, status: next, after_ct: ct };
  }
  db.prepare('UPDATE t_improvement SET status = ? WHERE imp_id = ?').run(next, impId);
  return { ...imp, status: next };
}

/** 建议书一页数据（前端 window.print 导出） */
export function buildReport(impId) {
  const db = getDb();
  const imp = db.prepare('SELECT * FROM t_improvement WHERE imp_id = ?').get(impId);
  if (!imp) throw new NotFoundError('改善建议', impId);
  const station = getStationRow(imp.station_id);
  const elements = elementsOf(station);
  const byId = new Map(elements.map((el) => [el.element_id, el]));
  const involved = String(imp.element_ids ?? '').split(',').filter(Boolean)
    .map((id) => byId.get(id)).filter(Boolean)
    .map((el) => ({ seq: el.seq, type: el.type, desc: el.desc, std_time: el.std_time, va_class: el.va_class }));
  const params = getParams(station.line_id);
  const annual = params && imp.est_save_s > 0
    ? round2((imp.est_save_s * params.daily_output * 365 * params.rate_yuan_per_hour / 3600) * params.realization_rate)
    : null;
  return {
    header: {
      station_id: station.station_id, station_name: station.name, line_id: station.line_id,
      version: station.version, imp_id: imp.imp_id, generated_at: nowIso(), generated_by: 'IE',
    },
    problem: { waste_type: imp.waste_type, measure: imp.measure, involved },
    benefit: {
      est_save_s: imp.est_save_s,
      annual_yuan: annual,
      before_ct: imp.before_ct,
      after_ct: imp.after_ct,
      params_configured: Boolean(params),
      formula: '节省秒数×日产量×365×费率(元/工时)÷3600×落地率',
    },
    steps: ['按措施实施（IE+班长现场）', '现场确认一次：作业员照做/旧浪费动作消失', '重导SOP（带版本号）', '点“开始复测”并提交新分解', '前后对比页验证，状态置“已验证”'],
    status: imp.status,
    signatures: ['改善责任人：', '班长确认：', 'IE主管抽审：', '日期：'],
  };
}
