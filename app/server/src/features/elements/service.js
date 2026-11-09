import { getDb } from '../../db/index.js';
import { ConflictError, NotFoundError } from '../../errors.js';
import { ValidationError } from '../../errors.js';
import { defaultVaMap } from '../../rules/rules.js';
import { parseCsv, toCsv } from '../../shared/csv.js';
import { ELEMENT_TYPES, HANDS, VA_CLASSES, elementId, round1, round2, round3, today } from '../../shared/util.js';
import { computeCt, elementsOf, getStationRow } from '../stations/service.js';
import { computeStd, validateSubmission } from './validation.js';

/** 提交分解（事务：清当前版本 → 写入 → 重算CT；文档01 §10） */
export function submitElements(stationId, payload, user = 'IE') {
  const station = getStationRow(stationId);
  const version = station.version;
  if (payload.bol_version !== undefined && Number(payload.bol_version) !== version) {
    throw new ConflictError(`只能提交当前版本 v${version}（封存版本只读）`, { current_version: version });
  }
  const { errors, warnings } = validateSubmission(payload);
  if (errors.length) throw new ValidationError('提交被拦截：请修正以下问题后重新提交', errors, warnings);

  const sorted = [...payload.elements].sort((a, b) => Number(a.start_ms) - Number(b.start_ms));
  const defaults = defaultVaMap();

  const result = (() => {
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM t_element WHERE station_id = ? AND bol_version = ?').run(stationId, version);
      const insert = db.prepare(`INSERT INTO t_element
        (element_id, station_id, seq, start_ms, dur_s, hand, type, "desc", va_class, outlier_flag, outlier_reason, video_id, rating, allowance, std_time, bol_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      sorted.forEach((el, index) => {
        const seq = index + 1;
        const rating = round3(Number(el.rating ?? 1));
        const allowance = round3(Number(el.allowance ?? 0.15));
        insert.run(
          elementId(stationId, version, seq), stationId, seq, Math.round(Number(el.start_ms)),
          round2(el.dur_s), el.hand, el.type, String(el.desc).trim().slice(0, 120),
          el.va_class ?? defaults[el.type] ?? 'NNVA',
          Number(el.outlier_flag) === 1 ? 1 : 0,
          Number(el.outlier_flag) === 1 ? String(el.outlier_reason ?? '').slice(0, 100) : null,
          payload.video_id ?? 'manual', rating, allowance, computeStd(el.dur_s, rating, allowance), version,
        );
      });
      const { ct } = computeCt(stationId, version);
      db.prepare('UPDATE t_station SET CT = ?, updated_by = ?, updated_at = ? WHERE station_id = ?')
        .run(ct, user, nowIsoSafe(), stationId);
      db.exec('COMMIT');
      return { ct, count: sorted.length };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  })();

  return { station_id: stationId, version, ct: result.ct, element_count: result.count, warnings: warnings ?? [] };
}

function nowIsoSafe() {
  return new Date().toISOString();
}

/** Excel/CSV 导入：任一行失败整批不入库（文档01 §9.3）；import 的 cycle_count 按15计 */
export function importCsv(stationId, csvText, user = 'IE') {
  const station = getStationRow(stationId);
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new ValidationError('CSV 为空或缺少表头', [{ code: 'IMPORT', message: '至少需要表头+1行数据' }]);
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const find = (names) => header.findIndex((h) => names.some((n) => h === n.toLowerCase()));
  const iSeq = find(['序号', 'seq']);
  const iHand = find(['手别', 'hand']);
  const iType = find(['类型', 'type']);
  const iDesc = find(['描述', 'desc']);
  const iDur = find(['时长s', '时长(秒)', '时长', 'dur_s']);
  if ([iSeq, iHand, iType, iDesc, iDur].some((i) => i < 0)) {
    throw new ValidationError('CSV 缺少必需列：序号 / 手别 / 类型 / 描述 / 时长s', [{ code: 'IMPORT', message: `实际表头：${rows[0].join(', ')}` }]);
  }
  const iVa = find(['va类别', 'va_class']);
  const iOut = find(['异常标记', 'outlier_flag']);
  const iReason = find(['异常原因', 'outlier_reason']);
  const iRating = find(['评比', 'rating']);
  const iAllowance = find(['宽放', 'allowance']);

  const defaults = defaultVaMap();
  const errors = [];
  const parsed = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const line = r + 1;
    const dur = Number(cells[iDur]);
    const type = String(cells[iType] ?? '').trim();
    const hand = String(cells[iHand] ?? 'R').trim().toUpperCase();
    if (!Number.isFinite(dur) || dur <= 0) { errors.push({ code: 'IMPORT', line, message: `第${line}行：时长必须是>0的数字` }); continue; }
    if (!ELEMENT_TYPES.includes(type)) { errors.push({ code: 'IMPORT', line, message: `第${line}行：类型「${type}」不在10类词表` }); continue; }
    if (!HANDS.includes(hand)) { errors.push({ code: 'IMPORT', line, message: `第${line}行：手别必须是 L/R/B` }); continue; }
    let va = iVa >= 0 ? String(cells[iVa] ?? '').trim() : '';
    if (!VA_CLASSES.includes(va)) va = defaults[type];
    parsed.push({
      seq: Number(cells[iSeq]) || parsed.length + 1,
      hand,
      type,
      desc: String(cells[iDesc] ?? '').trim(),
      dur_s: dur,
      va_class: va,
      outlier_flag: iOut >= 0 && ['1', '是', 'y', 'yes'].includes(String(cells[iOut]).trim().toLowerCase()) ? 1 : 0,
      outlier_reason: iReason >= 0 ? String(cells[iReason] ?? '').trim() : '',
      rating: iRating >= 0 && Number(cells[iRating]) ? Number(cells[iRating]) : 1.0,
      allowance: iAllowance >= 0 && Number(cells[iAllowance]) ? Number(cells[iAllowance]) : 0.15,
    });
  }
  if (errors.length) throw new ValidationError('CSV 导入整批失败（任一行不合法则整批不入库）', errors);

  parsed.sort((a, b) => a.seq - b.seq);
  let cursor = 0;
  const elements = parsed.map((row, index) => {
    const el = {
      seq: index + 1,
      start_ms: cursor,
      dur_s: row.dur_s,
      hand: row.hand,
      type: row.type,
      desc: row.desc,
      va_class: row.va_class,
      outlier_flag: row.outlier_flag,
      outlier_reason: row.outlier_reason,
      rating: row.rating,
      allowance: row.allowance,
    };
    cursor += Math.round(row.dur_s * 1000);
    return el;
  });

  return submitElements(stationId, { bol_version: station.version, cycle_count: 15, cv: 0, video_id: 'excel-import', elements }, user);
}

export function exportCsv(stationId) {
  const station = getStationRow(stationId);
  const elements = elementsOf(station);
  const header = ['工位编码', '版本', '序号', '手别', '类型', '描述', '时长s', 'VA类别', '异常标记', '异常原因', '评比', '宽放', '标准工时', '起点ms'];
  const rows = [header, ...elements.map((el) => [
    station.station_id, station.version, el.seq, el.hand, el.type, el.desc, el.dur_s, el.va_class,
    el.outlier_flag, el.outlier_reason ?? '', el.rating, el.allowance, el.std_time, el.start_ms,
  ])];
  return toCsv(rows);
}

/** 人工改判：写 va_class + desc 结构化标记（与文档02 §2.2 同格式），封存版本拒绝写入 */
export function updateVAClass(elementIdValue, payload, user = 'IE') {
  const db = getDb();
  const element = db.prepare('SELECT * FROM t_element WHERE element_id = ?').get(elementIdValue);
  if (!element) throw new NotFoundError('要素', elementIdValue);
  const station = getStationRow(element.station_id);
  if (element.bol_version !== station.version) throw new ConflictError(`v${element.bol_version} 已封存只读，不能改判`, { sealed_version: element.bol_version });
  const next = payload.va_class;
  if (!VA_CLASSES.includes(next)) throw new ConflictError('VA类别必须是 VA/NNVA/NVA');
  const reason = String(payload.reason ?? '').trim();
  if (reason.length < 5) throw new ConflictError('改判理由至少5个字');
  const who = String(payload.user ?? user).slice(0, 20);
  const marker = `[VA改判|原:${element.va_class}|新:${next}|理由:${reason}|人:${who}|${today()}]`;
  const desc = `${String(element.desc).replace(/\[VA(改判|确认)\|[^\]]*\]/g, '').trim()} ${marker}`.slice(0, 120);
  db.prepare('UPDATE t_element SET va_class = ?, "desc" = ? WHERE element_id = ?').run(next, desc, elementIdValue);
  const { ct } = computeCt(station.station_id, station.version);
  db.prepare('UPDATE t_station SET CT = ?, updated_at = ? WHERE station_id = ?').run(ct, nowIsoSafe(), station.station_id);
  return { element_id: elementIdValue, va_class: next, desc, ct };
}

/** 确认暂定归类（接受规则建议值并留痕） */
export function confirmVAClass(elementIdValue, payload, user = 'IE') {
  const db = getDb();
  const element = db.prepare('SELECT * FROM t_element WHERE element_id = ?').get(elementIdValue);
  if (!element) throw new NotFoundError('要素', elementIdValue);
  const station = getStationRow(element.station_id);
  if (element.bol_version !== station.version) throw new ConflictError(`v${element.bol_version} 已封存只读，不能确认`);
  const value = VA_CLASSES.includes(payload.va_class) ? payload.va_class : element.va_class;
  const who = String(payload.user ?? user).slice(0, 20);
  const marker = `[VA确认|类:${value}|人:${who}|${today()}]`;
  const desc = `${String(element.desc).replace(/\[VA(改判|确认)\|[^\]]*\]/g, '').trim()} ${marker}`.slice(0, 120);
  db.prepare('UPDATE t_element SET va_class = ?, "desc" = ? WHERE element_id = ?').run(value, desc, elementIdValue);
  const { ct } = computeCt(station.station_id, station.version);
  db.prepare('UPDATE t_station SET CT = ?, updated_at = ? WHERE station_id = ?').run(ct, nowIsoSafe(), station.station_id);
  return { element_id: elementIdValue, va_class: value, desc, ct };
}
