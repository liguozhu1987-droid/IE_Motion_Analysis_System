import { closeDb, getDb, openDb } from '../db/index.js';
import { log } from '../logger.js';
import { defaultVaMap } from '../rules/rules.js';
import { round2 } from '../shared/util.js';

/**
 * 演示数据：1 条试点线 L01、6 个工位、其中 ST03 已完成一次复测（v2）
 * 覆盖：异常要素、待复核（低置信度）、6类浪费中的多类、3条建议（含已验证）
 */
const STATIONS = [
  {
    id: 'L01-ST01', name: '上料取件', tt: 13.5, version: 1,
    elements: [
      ['取放', '伸手取前壳', 2.1, 'R'],
      ['搬运', '料箱移至台面', 3.2, 'B'],
      ['预对', '壳体定向', 1.8, 'R'],
      ['等待', '等上工位供料', 2.5, 'B'],
    ],
  },
  {
    id: 'L01-ST02', name: '插装', tt: 13.5, version: 1,
    elements: [
      ['取放', '取排线', 1.8, 'R'],
      ['寻找选择', '挑颜色找线序', 2.2, 'L'],
      ['装配', '插入排线', 4.5, 'L'],
      ['持住', '扶住壳体', 3.1, 'L'],
      ['检验', '目视线序', 1.6, 'L'],
    ],
  },
  {
    id: 'L01-ST03', name: '锁螺丝', tt: 13.5, version: 2,
    v1: [
      ['取放', '取螺丝批', 1.2, 'R'],
      ['取放', '取螺丝4颗', 2.4, 'R'],
      ['持住', '扶件定位', 4.2, 'L'],
      ['使用', '锁附4颗螺丝', 6.5, 'R'],
      ['检验', '目视锁附', 1.4, 'L'],
      ['等待', '等下一件', 0.8, 'B'],
    ],
    v2: [
      ['取放', '取螺丝批', 1.4, 'R'],
      ['取放', '取螺丝4颗', 2.0, 'R'],
      ['使用', '锁附4颗螺丝(治具夹持)', 8.2, 'R'],
      ['检验', '目视锁附', 1.2, 'L'],
    ],
  },
  {
    id: 'L01-ST04', name: '检验', tt: 13.5, version: 1,
    elements: [
      ['取放', '取检具', 1.0, 'R'],
      ['检验', '目视外观', 2.5, 'L'],
      ['检验', '重复确认外观', 1.8, 'L'],
      ['使用', '扫码录入', 1.6, 'R'],
    ],
  },
  {
    id: 'L01-ST05', name: '贴标', tt: 13.5, version: 1,
    elements: [
      ['取放', '取标签', 1.1, 'R'],
      ['预对', '标签对位', 2.4, 'R'],
      ['装配', '贴标签', 1.8, 'R'],
      ['检验', '确认标签', 1.2, 'L'],
    ],
  },
  {
    id: 'L01-ST06', name: '包装', tt: 13.5, version: 1,
    elements: [
      ['取放', '取纸箱', 2.2, 'R'],
      ['搬运', '装箱', 3.5, 'B'],
      ['装配', '封箱', 2.4, 'B'],
      ['寻找选择', '找说明书', 1.9, 'R'],
    ],
  },
];

const RATING = 1.0;
const ALLOWANCE = 0.15;

function stdTime(durS) {
  return round2(durS * RATING * (1 + ALLOWANCE));
}

function insertVersion(db, stationId, version, rows, updatedAt) {
  const defaults = defaultVaMap();
  const insert = db.prepare(`INSERT INTO t_element
    (element_id, station_id, seq, start_ms, dur_s, hand, type, "desc", va_class, outlier_flag, outlier_reason, video_id, rating, allowance, std_time, bol_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let cursor = 0;
  rows.forEach((row, index) => {
    const [type, desc, dur, hand] = row;
    const seq = index + 1;
    insert.run(
      `${stationId}-V${version}-${String(seq).padStart(3, '0')}`, stationId, seq, cursor, dur, hand, type, desc,
      defaults[type] ?? 'NNVA', 0, null, `${stationId.replace(/-/g, '_')}_${updatedAt.slice(0, 10).replace(/-/g, '')}`,
      RATING, ALLOWANCE, stdTime(dur), version,
    );
    cursor += Math.round(dur * 1000);
  });
}

export function seedIfEmpty() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS c FROM t_station').get().c;
  if (existing > 0) return { seeded: false, stations: existing };

  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertStation = db.prepare(`INSERT INTO t_station
      (station_id, line_id, name, CT, TT, version, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)`);

    for (const station of STATIONS) {
      let ct = 0;
      if (station.version === 1) {
        ct = round2(station.elements.reduce((acc, row) => acc + stdTime(row[2]), 0));
      } else {
        ct = round2(station.v2.reduce((acc, row) => acc + stdTime(row[2]), 0));
      }
      insertStation.run(station.id, 'L01', station.name, ct, station.tt, station.version, 'IE-张三', now);
      if (station.version === 1) insertVersion(db, station.id, 1, station.elements, now);
      else {
        insertVersion(db, station.id, 1, station.v1, '2026-10-01T09:00:00.000Z');
        insertVersion(db, station.id, 2, station.v2, now);
      }
    }

    const insertImp = db.prepare(`INSERT INTO t_improvement
      (imp_id, station_id, element_ids, waste_type, method, measure, est_save_s, priority, status, owner, due, before_ct, after_ct, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertImp.run('IMP-L01-ST02-01', 'L01-ST02', 'L01-ST02-V1-004', '持住', 'E', '治具代手持住（夹持/磁吸/真空）',
      2.85, 85, '待实施', '张三', '2026-11-15', 15.18, null, now);
    insertImp.run('IMP-L01-ST03-01', 'L01-ST03', 'L01-ST03-V1-003', '持住', 'E', '治具代手持住（夹持/磁吸/真空）',
      3.86, 90, '已验证', '张三', '2026-10-15', 18.98, 14.72, '2026-10-01T10:00:00.000Z');
    insertImp.run('IMP-L01-ST04-01', 'L01-ST04', 'L01-ST04-V1-003', '检验冗余', 'E', '取消重复确认，并入一次目视检验 [品质确认:李品质 2026-10-20]',
      1.04, 70, '待实施', '李四', '2026-11-20', 7.94, null, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { seeded: true, stations: STATIONS.length };
}

// CLI: npm run seed
const isCli = process.argv[1] ? process.argv[1].replace(/\\/g, '/').endsWith('db/seed.js') : false;
if (isCli) {
  openDb();
  const result = seedIfEmpty();
  log.info('seed 完成', result);
  closeDb();
}
