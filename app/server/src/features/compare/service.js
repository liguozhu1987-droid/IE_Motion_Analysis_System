import { getDb } from '../../db/index.js';
import { ConflictError, NotFoundError } from '../../errors.js';
import { normalizeDesc, round1, round2, similarity } from '../../shared/util.js';
import { analyzeStation } from '../analysis/engine.js';
import { elementsOfVersion, getStationRow } from '../stations/service.js';
import { getParams } from '../settings/service.js';

function slim(el) {
  return {
    element_id: el.element_id,
    seq: el.seq,
    type: el.type,
    desc: el.desc,
    hand: el.hand,
    dur_s: el.dur_s,
    std_time: el.std_time,
    va_class: el.va_effective ?? el.va_class,
  };
}

/**
 * 前后对比（文档03 §3）：配对三层 L1建议精确关联 / L2同类型+描述相似度≥0.75 / L3未匹配=消除
 * 工位级 ΔCT 为权威口径，要素级做归因。
 */
export function compareVersions(stationId, query = {}) {
  const station = getStationRow(stationId);
  const db = getDb();
  const versions = db.prepare('SELECT DISTINCT bol_version AS v FROM t_element WHERE station_id = ? ORDER BY v DESC')
    .all(stationId).map((r) => r.v);
  if (versions.length < 2) throw new ConflictError('该工位尚无复测版本，无法对比', { versions });

  const currV = Number(query.v1 ?? versions[0]);
  const prevV = Number(query.v2 ?? versions[1]);
  if (!versions.includes(prevV) || !versions.includes(currV)) throw new NotFoundError('版本', `${prevV}/${currV}`);

  const prevAnalysis = analyzeStation(station, elementsOfVersion(stationId, prevV));
  const currAnalysis = analyzeStation(station, elementsOfVersion(stationId, currV));
  const prevActive = prevAnalysis.elements.filter((el) => el.outlier_flag === 0);
  const currActive = currAnalysis.elements.filter((el) => el.outlier_flag === 0);

  const improvements = db.prepare('SELECT * FROM t_improvement WHERE station_id = ?').all(stationId);
  const referenced = new Set();
  for (const imp of improvements) {
    for (const id of String(imp.element_ids ?? '').split(',')) if (id.trim()) referenced.add(id.trim());
  }

  const used = new Set();
  const pairs = [];
  for (const prevEl of prevActive) {
    let match = currActive.find((c) => !used.has(c.element_id)
      && c.type === prevEl.type && normalizeDesc(c.desc) === normalizeDesc(prevEl.desc));
    let quality = 'success';
    let rule = 'exact';
    if (!match) {
      const candidates = currActive
        .filter((c) => !used.has(c.element_id) && c.type === prevEl.type)
        .map((c) => ({ el: c, sim: similarity(c.desc, prevEl.desc) }))
        .sort((a, b) => b.sim - a.sim);
      if (candidates[0] && candidates[0].sim >= 0.75) {
        match = candidates[0].el;
        quality = 'partial';
        rule = `similarity:${round2(candidates[0].sim)}`;
      }
    }
    if (!match) {
      pairs.push({ prev: slim(prevEl), curr: null, quality: 'unmatched', rule: 'removed', delta_std: round2(prevEl.std_time), referenced: referenced.has(prevEl.element_id) });
      continue;
    }
    used.add(match.element_id);
    pairs.push({
      prev: slim(prevEl),
      curr: slim(match),
      quality,
      rule,
      delta_std: round2(prevEl.std_time - match.std_time),
      referenced: referenced.has(prevEl.element_id),
    });
  }

  const added = currActive.filter((c) => !used.has(c.element_id)).map(slim);
  const removed = pairs.filter((p) => p.quality === 'unmatched').map((p) => p.prev);
  const ctPrev = prevAnalysis.metrics.ct;
  const ctCurr = currAnalysis.metrics.ct;
  const deltaCt = round2(ctPrev - ctCurr);
  const params = getParams(station.line_id);

  let benefit = null;
  if (params) {
    benefit = {
      saved_s_per_unit: deltaCt,
      daily_output: params.daily_output,
      rate_yuan_per_hour: params.rate_yuan_per_hour,
      realization_rate: params.realization_rate,
      annual_yuan: round2((deltaCt * params.daily_output * 365 * params.rate_yuan_per_hour / 3600) * params.realization_rate),
      formula: '节省秒数×日产量×365×费率(元/工时)÷3600×落地率',
      configured_by: params.configured_by,
      configured_at: params.configured_at,
    };
  }

  const matched = pairs.filter((p) => p.quality !== 'unmatched').length;
  const pairingRate = pairs.length > 0 ? Math.round((matched / pairs.length) * 100) : 0;

  return {
    station: { station_id: station.station_id, name: station.name, line_id: station.line_id, tt_s: station.TT },
    prev: { version: prevV, ct: ctPrev, metrics: prevAnalysis.metrics, element_count: prevActive.length },
    curr: { version: currV, ct: ctCurr, metrics: currAnalysis.metrics, element_count: currActive.length },
    delta_ct: deltaCt,
    pairing_rate: pairingRate,
    pairs,
    added,
    removed,
    benefit,
    params_configured: Boolean(params),
    warnings: pairingRate < 60 ? ['前后要素配对率低于60%，建议以工位级对比（ΔCT）为准'] : [],
  };
}

/** 一页对比报告数据（前端 window.print 导出 PDF/PPT 截图） */
export function buildCompareReport(stationId, query = {}) {
  const data = compareVersions(stationId, query);
  const improvementStats = (() => {
    const db = getDb();
    const rows = db.prepare(`SELECT status, COUNT(*) AS c FROM t_improvement WHERE station_id = ? GROUP BY status`).all(stationId);
    const map = { 待实施: 0, 已完成: 0, 已验证: 0 };
    for (const row of rows) map[row.status] = row.c;
    return map;
  })();
  const wasteRemoved = data.pairs.filter((p) => p.quality === 'unmatched' && /持住|等待|寻找选择|检验|搬运|取放/.test(p.prev.desc)).length;
  return {
    header: {
      line_id: data.station.line_id,
      station_id: data.station.station_id,
      station_name: data.station.name,
      prev_version: data.prev.version,
      curr_version: data.curr.version,
      generated_at: new Date().toISOString(),
    },
    kpi: {
      prev_ct: data.prev.ct,
      curr_ct: data.curr.ct,
      delta_ct: data.delta_ct,
      delta_pct: data.prev.ct > 0 ? round1((data.delta_ct / data.prev.ct) * 100) : 0,
      va_pct_prev: data.prev.metrics.va_pct,
      va_pct_curr: data.curr.metrics.va_pct,
      nva_pct_prev: data.prev.metrics.nva_pct,
      nva_pct_curr: data.curr.metrics.nva_pct,
      pairing_rate: data.pairing_rate,
      improvement_stats: improvementStats,
      removed_elements: wasteRemoved,
    },
    pairs: data.pairs,
    added: data.added,
    removed: data.removed,
    benefit: data.benefit,
    warnings: data.warnings,
    signatures: ['IE工程师：', '主管抽审：', '日期：'],
  };
}
