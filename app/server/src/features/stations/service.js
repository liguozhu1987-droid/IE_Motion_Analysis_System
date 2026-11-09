import { getDb, nowIso, tx } from '../../db/index.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors.js';
import { elementId, round2 } from '../../shared/util.js';

const STATION_ID_RE = /^[A-Za-z0-9_-]{3,24}$/;

export function getStationRow(stationId) {
  const row = getDb().prepare('SELECT * FROM t_station WHERE station_id = ?').get(stationId);
  if (!row) throw new NotFoundError('工位', stationId);
  return row;
}

export function elementsOf(station) {
  return getDb()
    .prepare('SELECT * FROM t_element WHERE station_id = ? AND bol_version = ? ORDER BY seq ASC')
    .all(station.station_id, station.version);
}

export function elementsOfVersion(stationId, version) {
  return getDb()
    .prepare('SELECT * FROM t_element WHERE station_id = ? AND bol_version = ? ORDER BY seq ASC')
    .all(stationId, version);
}

export function computeCt(stationId, version) {
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(std_time), 0) AS ct, COUNT(*) AS count
              FROM t_element WHERE station_id = ? AND bol_version = ? AND outlier_flag = 0`)
    .get(stationId, version);
  return { ct: round2(row.ct), count: row.count };
}

export function listLines() {
  const rows = getDb()
    .prepare(`SELECT line_id, COUNT(*) AS station_count, MAX(updated_at) AS updated_at
              FROM t_station GROUP BY line_id ORDER BY line_id`)
    .all();
  return rows;
}

export function listStations(lineId) {
  const db = getDb();
  const stations = lineId
    ? db.prepare('SELECT * FROM t_station WHERE line_id = ? ORDER BY station_id').all(lineId)
    : db.prepare('SELECT * FROM t_station ORDER BY line_id, station_id').all();
  return stations.map((st) => {
    const agg = db.prepare(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN outlier_flag = 0 THEN std_time ELSE 0 END), 0) AS ct,
        COALESCE(SUM(CASE WHEN outlier_flag = 0 AND va_class = 'VA' THEN std_time ELSE 0 END), 0) AS va
      FROM t_element WHERE station_id = ? AND bol_version = ?`).get(st.station_id, st.version);
    const versions = db.prepare('SELECT COUNT(DISTINCT bol_version) AS c FROM t_element WHERE station_id = ?').get(st.station_id).c;
    return {
      ...st,
      element_count: agg.total,
      ct_calc: round2(agg.ct),
      va_pct: agg.ct > 0 ? Math.round((agg.va / agg.ct) * 1000) / 10 : 0,
      version_count: versions,
      status_label: agg.total === 0 ? '待分解' : st.version > 1 ? '已复测' : '已分解',
    };
  });
}

export function getStationDetail(stationId) {
  const station = getStationRow(stationId);
  const elements = elementsOf(station);
  const versions = listVersions(stationId);
  return { ...station, elements, versions, ct_calc: computeCt(stationId, station.version).ct };
}

export function listVersions(stationId) {
  const station = getStationRow(stationId);
  const rows = getDb().prepare(`SELECT bol_version AS version, COUNT(*) AS element_count,
      COALESCE(SUM(CASE WHEN outlier_flag = 0 THEN std_time ELSE 0 END), 0) AS ct
    FROM t_element WHERE station_id = ? GROUP BY bol_version ORDER BY bol_version DESC`).all(stationId);
  return rows.map((r) => ({
    ...r,
    ct: round2(r.ct),
    is_current: r.version === station.version,
    is_sealed: r.version < station.version,
  }));
}

export function createStation(payload) {
  const db = getDb();
  const stationId = String(payload.station_id ?? '').trim();
  const lineId = String(payload.line_id ?? '').trim();
  const name = String(payload.name ?? '').trim();
  if (!STATION_ID_RE.test(stationId)) throw new BadRequestError('工位编码只允许字母/数字/下划线/短横线，长度3~24');
  if (!STATION_ID_RE.test(lineId)) throw new BadRequestError('产线编码格式不合法');
  if (!name) throw new BadRequestError('工位名称不能为空');
  const tt = Number(payload.TT ?? 0);
  if (!Number.isFinite(tt) || tt < 0 || tt > 600) throw new BadRequestError('TT 须在 0~600 秒之间');
  if (db.prepare('SELECT 1 FROM t_station WHERE station_id = ?').get(stationId)) {
    throw new ConflictError(`工位已存在：${stationId}`);
  }
  db.prepare(`INSERT INTO t_station (station_id, line_id, name, CT, TT, version, updated_by, updated_at)
              VALUES (?,?,?,?,?,1,?,?)`)
    .run(stationId, lineId, name, 0, round2(tt), payload.updated_by ?? 'IE', nowIso());
  return getStationDetail(stationId);
}

export function updateStation(stationId, patch) {
  const station = getStationRow(stationId);
  const name = patch.name === undefined ? station.name : String(patch.name).trim();
  const tt = patch.TT === undefined ? station.TT : Number(patch.TT);
  if (!name) throw new BadRequestError('工位名称不能为空');
  if (!Number.isFinite(tt) || tt < 0 || tt > 600) throw new BadRequestError('TT 须在 0~600 秒之间');
  getDb().prepare('UPDATE t_station SET name = ?, TT = ?, updated_by = ?, updated_at = ? WHERE station_id = ?')
    .run(name, round2(tt), patch.updated_by ?? station.updated_by, nowIso(), stationId);
  return getStationDetail(stationId);
}

/** 开始复测：点击瞬间推进 version（旧版因指针移开天然只读），新版本为空草稿（文档01 §8 / 文档03 S1） */
export function startRetest(stationId, user = 'IE') {
  const station = getStationRow(stationId);
  const current = computeCt(stationId, station.version);
  if (current.count === 0) throw new ConflictError('当前版本还没有分解数据，不能开始复测', { version: station.version });
  const next = station.version + 1;
  tx((db) => {
    db.prepare('UPDATE t_station SET version = ?, updated_by = ?, updated_at = ? WHERE station_id = ?')
      .run(next, user, nowIso(), stationId);
  });
  return { station_id: stationId, sealed_version: station.version, version: next };
}

/** 作废复测：删除当前版本草稿 + 回退 version + 按恢复版本重算 CT（同事务） */
export function cancelRetest(stationId, user = 'IE') {
  const station = getStationRow(stationId);
  if (station.version <= 1) throw new ConflictError('没有可作废的复测版本');
  const target = station.version;
  return tx((db) => {
    db.prepare('DELETE FROM t_element WHERE station_id = ? AND bol_version = ?').run(stationId, target);
    const restored = target - 1;
    const agg = db.prepare(`SELECT COALESCE(SUM(std_time),0) AS ct FROM t_element
      WHERE station_id = ? AND bol_version = ? AND outlier_flag = 0`).get(stationId, restored);
    db.prepare('UPDATE t_station SET version = ?, CT = ?, updated_by = ?, updated_at = ? WHERE station_id = ?')
      .run(restored, round2(agg.ct), user, nowIso(), stationId);
    return { station_id: stationId, version: restored, deleted_version: target, ct: round2(agg.ct) };
  });
}

export function makeElementId(stationId, version, seq) {
  return elementId(stationId, version, seq);
}
