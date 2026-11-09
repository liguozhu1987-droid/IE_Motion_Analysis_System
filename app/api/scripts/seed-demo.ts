/**
 * 集团驾驶舱演示数据（v3.3）：3 区域 / 4 公司 / 13 产线 / ~96 工位 / ~35 建议。
 * 用法：SEED_DEMO=true npm run seed:demo   （与正式 seed 分离，可反复执行——幂等跳过已存在工位）
 * 清理：脚本执行完会打印清理 SQL（按 created_by='seed-demo' / demo_ 前缀 / 演示租户删除）。
 * 数据特征：固定随机种子（20261022）可复现；产线覆盖 5 种工艺、产品类型+项目编号、平衡率好/中/差三档；
 *           约 20% 工位为 v2 复测态（v1 高负荷 → v2 改善），供对比页与"已复测"状态演示。
 */
import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadConfig } from '../src/core/config/configuration';
import { typeOrmConfigFactory } from '../src/core/database/database.module';

/** mulberry32 定种子 PRNG（可复现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261022);
const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface LineCfg {
  line_id: string; tenant_id: string; name: string;
  process_type: string; product_type: string; product_project: string;
  tt: number; va_ratio: number; stations: number; balance: 'good' | 'mid' | 'bad';
}

/** 演示产线（L01/L02 为既有数据不重复造；OTHER/L02 保留作隔离验证） */
const TENANTS: { tenant_id: string; code: string; name: string; region: string }[] = [
  { tenant_id: 'SUZ', code: 'SUZ', name: '苏州精密制造', region: '华东' },
  { tenant_id: 'SZX', code: 'SZX', name: '深圳智造科技', region: '华南' },
  { tenant_id: 'BJD', code: 'BJD', name: '北京装配工厂', region: '华北' },
];

const LINES: LineCfg[] = [
  { line_id: 'L20', tenant_id: 'DEFAULT', name: '包装一线', process_type: '包装', product_type: '电机', product_project: 'P-2025-001', tt: 60, va_ratio: 0.50, stations: 6, balance: 'good' },
  { line_id: 'L21', tenant_id: 'SUZ', name: '注塑一线', process_type: '注塑', product_type: '壳体', product_project: 'P-2026-007', tt: 75, va_ratio: 0.35, stations: 6, balance: 'bad' },
  { line_id: 'L22', tenant_id: 'SUZ', name: '冲压一线', process_type: '冲压', product_type: '壳体', product_project: 'P-2026-007', tt: 45, va_ratio: 0.45, stations: 5, balance: 'mid' },
  { line_id: 'L23', tenant_id: 'SUZ', name: '注塑二线', process_type: '注塑', product_type: '壳体', product_project: 'P-2026-007', tt: 75, va_ratio: 0.40, stations: 5, balance: 'mid' },
  { line_id: 'L24', tenant_id: 'SZX', name: 'SMT一线', process_type: 'SMT', product_type: '控制板', product_project: 'P-2026-012', tt: 60, va_ratio: 0.60, stations: 7, balance: 'good' },
  { line_id: 'L25', tenant_id: 'SZX', name: '装配二线', process_type: '装配', product_type: '控制板', product_project: 'P-2026-012', tt: 55, va_ratio: 0.50, stations: 6, balance: 'mid' },
  { line_id: 'L26', tenant_id: 'SZX', name: '包装一线', process_type: '包装', product_type: '控制板', product_project: 'P-2026-012', tt: 50, va_ratio: 0.45, stations: 5, balance: 'good' },
  { line_id: 'L27', tenant_id: 'SZX', name: 'SMT二线', process_type: 'SMT', product_type: '控制板', product_project: 'P-2026-019', tt: 60, va_ratio: 0.55, stations: 6, balance: 'mid' },
  { line_id: 'L28', tenant_id: 'BJD', name: '焊接一线', process_type: '焊接', product_type: '连接器', product_project: 'P-2025-033', tt: 65, va_ratio: 0.30, stations: 5, balance: 'bad' },
  { line_id: 'L29', tenant_id: 'BJD', name: '装配三线', process_type: '装配', product_type: '连接器', product_project: 'P-2025-033', tt: 60, va_ratio: 0.42, stations: 6, balance: 'mid' },
  { line_id: 'L30', tenant_id: 'DEFAULT', name: '包装二线', process_type: '包装', product_type: '电机', product_project: 'P-2025-001', tt: 60, va_ratio: 0.48, stations: 5, balance: 'good' },
];

const LOADS: Record<LineCfg['balance'], number[]> = {
  good: [1.00, 0.98, 1.02, 0.97, 1.01, 1.00, 0.99],
  mid: [1.15, 1.05, 1.22, 1.00, 1.10, 1.02, 1.08],
  bad: [1.45, 1.10, 1.25, 1.15, 1.05, 1.30, 1.18],
};

/** 要素描述词库（按动素三分法类型） */
const DESCS: Record<string, string[]> = {
  装配: ['装前壳到位', '装后盖', '插接线束', '贴标签', '装轴承', '合箱体'],
  使用: ['电批锁螺丝', '点胶固定', '压合端子', '热压焊'],
  移物: ['取前壳', '取螺丝包', '放成品到流水线', '取料箱', '搬料箱到工位', '移半成品到下一站'],
  定位: ['配件预摆', '预对位', '对准卡槽'],
  检查: ['外观自检', '尺寸抽检', '功能点测'],
  寻找: ['找螺丝盒', '换批找料', '翻找工具'],
  选择: ['混料挑拣', '挑合格品'],
  思考: ['确认作业步骤', '判断加工参数'],
  预置: ['预摆下一件料', '摆好工具'],
  持住: ['扶住壳体', '按住线束', '扶正产品'],
  可避免延迟: ['等上件', '等压机信号', '等传送带'],
  休息: ['中场休息', '喝水'],
  其他: ['记录产量', '换刀具', '清点物料'],
};
const VA_OF: Record<string, string> = {
  装配: 'VA', 使用: 'VA', 移物: 'VA', 定位: 'VA', 检查: 'VA',
  寻找: 'RNVA', 选择: 'RNVA', 思考: 'RNVA', 预置: 'RNVA', 其他: 'RNVA',
  持住: 'NVA', 可避免延迟: 'NVA', 休息: 'NVA',
};
const WASTES: [string, string][] = [ // waste_type → 建议措施模板
  ['持住', '增加定位夹具替代人工扶住，释放双手'],
  ['重复取放', '合并取放动作，一次取料完成多件装配'],
  ['搬运', '调整工位布局，物料就近摆放缩短搬运距离'],
  ['等待', '实行看板补料，消除等料停机'],
  ['寻找选择', '定置管理+形迹管理，工具料盒定位标识'],
  ['检验冗余', '检验项合并至关键工序，取消重复全检'],
];
const METHODS = ['E', 'C', 'R', 'S'];
const PROJECT_TYPES = ['NPI导入', '量产改善', '自动化改造', '布局优化', '质量改善'];
const OWNERS = ['王工', '李班长', '张工', '赵工', '陈工'];

interface GenEl {
  element_id: string; tenant_id: string; station_id: string; seq: number; start_ms: number;
  dur_s: number; hand: string; type: string; desc: string; va_class: string;
  outlier_flag: number; outlier_reason: string | null; video_id: string;
  rating: number; allowance: number; std_time: number; bol_version: number;
}

/** 生成一个版本的全部要素；返回要素数组与该版本 CT（非异常 std 合计） */
function genVersion(stationId: string, tenantId: string, version: number, tt: number, load: number, vaRatio: number): { elements: GenEl[]; ct: number } {
  const n = 8 + Math.floor(rng() * 5); // 8-12 个要素
  const durAvg = (tt * load) / 1.15 / n; // std=dur×1.15 → CT≈tt×load
  const elements: GenEl[] = [];
  let start = 0;
  for (let i = 1; i <= n; i += 1) {
    const r = rng();
    let type: string;
    if (r < vaRatio) type = pick(['装配', '使用']);
    else if (r < vaRatio + 0.22) type = pick(['移物', '定位', '检查', '其他']);
    else type = pick(['可避免延迟', '寻找', '持住']);
    const dur = round1(Math.max(0.8, durAvg * (0.6 + rng() * 0.8)));
    const outlier = rng() < 0.04 ? 1 : 0;
    elements.push({
      element_id: `${stationId}-V${version}-${String(i).padStart(3, '0')}`,
      tenant_id: tenantId, station_id: stationId, seq: i, start_ms: start,
      dur_s: dur, hand: rng() < 0.15 ? 'B' : pick(['L', 'R']),
      type, desc: pick(DESCS[type] ?? DESCS.其他), va_class: VA_OF[type] ?? 'RNVA',
      outlier_flag: outlier,
      outlier_reason: outlier ? pick(['视频遮挡待复核', '异常停顿待复核']) : null,
      video_id: `${stationId.replace(/-/g, '_')}_demo.mp4`,
      rating: 1.0, allowance: 0.15,
      std_time: round2(dur * 1.0 * 1.15), bol_version: version,
    });
    start += Math.round(dur * 1000) + 200 + Math.floor(rng() * 600);
  }
  const ct = round2(elements.filter((e) => e.outlier_flag === 0).reduce((a, e) => a + e.std_time, 0));
  return { elements, ct };
}

async function main() {
  const cfg = loadConfig();
  const ds = new DataSource({ ...(typeOrmConfigFactory(cfg) as any), synchronize: cfg.nodeEnv !== 'production' });
  await ds.initialize();
  console.log(`演示数据灌入中（库 ${cfg.dbType}）…`);

  // 1. 演示租户（upsert 幂等）
  await ds.getRepository('t_tenant').upsert(TENANTS.map((t) => ({ ...t, status: 'active' })) as any, ['tenant_id']);
  // DEFAULT 区域口径统一（seed.ts 已设华东；此处兜底）
  await ds.getRepository('t_tenant').update({ tenant_id: 'DEFAULT' } as any, { region: '华东' } as any);

  // 2. 产线元数据（upsert；既有 L01 补元数据，不覆盖用户已改值——upsert 会覆盖，故先查后插）
  const lineRepo = ds.getRepository('t_line');
  for (const l of LINES) {
    const exists = await lineRepo.countBy({ tenant_id: l.tenant_id, line_id: l.line_id } as any);
    if (exists === 0) {
      await lineRepo.save({ tenant_id: l.tenant_id, line_id: l.line_id, name: l.name, process_type: l.process_type, product_type: l.product_type, product_project: l.product_project } as any);
    }
  }
  // L01 既有线补元数据（仅当仍是默认值时）
  const l01 = await lineRepo.findOneBy({ tenant_id: 'DEFAULT', line_id: 'L01' } as any);
  if (l01 && (l01.product_type === '待补充' || !l01.product_type)) {
    await lineRepo.update({ tenant_id: 'DEFAULT', line_id: 'L01' } as any, { name: '装配一线', process_type: '装配', product_type: '电机', product_project: 'P-2025-001' } as any);
  }

  // 3-5. 工位 + 要素 + 建议（按线遍历；已存在工位整体跳过→幂等）
  let stationCount = 0; let elementCount = 0; let impCount = 0;
  const stationRepo = ds.getRepository('t_station');
  const elementRepo = ds.getRepository('t_element');
  const impRepo = ds.getRepository('t_improvement');

  for (const line of LINES) {
    const loads = LOADS[line.balance];
    for (let i = 1; i <= line.stations; i += 1) {
      const stationId = `${line.line_id}-ST${String(i).padStart(2, '0')}`;
      if (await stationRepo.countBy({ station_id: stationId } as any) > 0) continue;
      const load = loads[(i - 1) % loads.length];
      const isV2 = i % 5 === 0; // 每线第 5 个工位为复测态
      const v1 = genVersion(stationId, line.tenant_id, 1, line.tt, isV2 ? load * 1.18 : load, line.va_ratio);
      const v2 = isV2 ? genVersion(stationId, line.tenant_id, 2, line.tt, load, line.va_ratio) : null;
      const all = [...v1.elements, ...(v2?.elements ?? [])];
      const ct = v2 ? v2.ct : v1.ct;
      await stationRepo.save({
        station_id: stationId, tenant_id: line.tenant_id, line_id: line.line_id,
        name: `${line.name.replace(/[一二三]/g, '')}工位${i}`.replace('工位工位', '工位'),
        ct, tt: line.tt, version: isV2 ? 2 : 1,
        updated_by: 'seed-demo', updated_at: new Date(), created_by: 'seed-demo',
      } as any);
      await elementRepo.save(all.map((e) => ({ ...e, created_at: new Date() })) as any, { chunk: 100 });
      stationCount += 1; elementCount += all.length;

      // 建议：每工位 0-2 条；已验证仅限复测工位（口径：已验证要求已存在复测版本）
      const impN = rng() < 0.55 ? 2 : rng() < 0.5 ? 1 : 0;
      const cur = v2 ?? v1;
      for (let k = 0; k < impN; k += 1) {
        const [waste, measureTpl] = pick(WASTES);
        const estSave = round1(2 + rng() * 18);
        const status = isV2 ? pick(['待实施', '已完成', '已验证']) : pick(['待实施', '待实施', '已完成']);
        const elIds = cur.elements.filter((e) => e.outlier_flag === 0).slice(0, 1 + Math.floor(rng() * 2)).map((e) => e.element_id).join(',');
        const days = 3 + Math.floor(rng() * 38);
        await impRepo.save({
          imp_id: `demo_${line.tenant_id}_${line.line_id}_${i}${k}`,
          tenant_id: line.tenant_id, station_id: stationId, element_ids: elIds,
          waste_type: waste, method: pick(METHODS),
          measure: measureTpl, est_save_s: estSave,
          priority: 40 + Math.floor(rng() * 55), status,
          project_type: pick(PROJECT_TYPES),
          owner: pick(OWNERS),
          due: new Date(Date.now() + days * 86400000),
          before_ct: ct,
          after_ct: status === '已验证' ? round2(Math.max(1, ct - estSave)) : null,
          created_at: new Date(),
        } as any);
        impCount += 1;
      }
    }
  }

  await ds.destroy();
  console.log(`演示数据完成：租户${TENANTS.length} / 产线${LINES.length} / 工位${stationCount} / 要素${elementCount} / 建议${impCount}`);
  console.log('清理 SQL（演示数据全部带 seed-demo / demo_ 标记）：');
  console.log(`  DELETE FROM t_element WHERE station_id LIKE 'L2_-ST%' OR station_id LIKE 'L30-ST%';`);
  console.log(`  DELETE FROM t_improvement WHERE imp_id LIKE 'demo[_]%';`);
  console.log(`  DELETE FROM t_station WHERE created_by = 'seed-demo';`);
  console.log(`  DELETE FROM t_line WHERE tenant_id IN ('SUZ','SZX','BJD') OR (tenant_id='DEFAULT' AND line_id IN ('L20','L30'));`);
  console.log(`  DELETE FROM t_tenant WHERE tenant_id IN ('SUZ','SZX','BJD');`);
}

main().catch((e) => { console.error('演示数据失败:', e.message); process.exit(1); });
