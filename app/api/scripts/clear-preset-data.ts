/**
 * 清空预置业务数据（v3.22 #75，用户指示）：
 *   清  t_element / t_improvement / t_station / t_line / t_project
 *   留  t_tenant（区域/公司框架，名称可在主数据页改）、t_user、t_rule_set、RBAC、参数表
 *   不动 CMC 库（SELECT-only 铁律）。
 *
 * 用法：node dist/scripts/clear-preset-data.js   （或 npx ts-node scripts/clear-preset-data.ts）
 * 可选 --keep-l01：保留 L01 线与 L01-ST01 工位（回归测试依赖；默认清空全部）。
 *
 * 安全：仅删除（先子表后主表），无任何写入；执行前打印将删行数，--yes 跳过确认。
 */
import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadConfig } from '../src/core/config/configuration';
import { typeOrmConfigFactory } from '../src/core/database/database.module';

const keepL01 = process.argv.includes('--keep-l01');
const yes = process.argv.includes('--yes');

async function main() {
  const ds = new DataSource(typeOrmConfigFactory(loadConfig()) as any);
  await ds.initialize();

  const count = async (sql: string) => (await ds.query(sql))[0]?.n ?? 0;
  const tables = ['t_element', 't_improvement', 't_station', 't_line', 't_project'];
  console.log('=== 清空预置数据（先子表后主表）===');
  for (const t of tables) {
    const n = await count(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`  ${t}: ${n} 行`);
  }

  if (!yes) {
    console.log('\n预览模式（未删除）。加 --yes 真正执行；加 --keep-l01 保留 L01/L01-ST01 供回归。');
    await ds.destroy();
    return;
  }

  console.log('\n执行删除…');
  if (keepL01) {
    await ds.query(`DELETE FROM t_element WHERE station_id NOT IN ('L01-ST01')`);
    await ds.query(`DELETE FROM t_improvement WHERE station_id NOT IN ('L01-ST01')`);
    await ds.query(`DELETE FROM t_station WHERE station_id <> 'L01-ST01'`);
    await ds.query(`DELETE FROM t_line WHERE line_id NOT IN ('L01')`);
  } else {
    await ds.query('DELETE FROM t_element');
    await ds.query('DELETE FROM t_improvement');
    await ds.query('DELETE FROM t_station');
    await ds.query('DELETE FROM t_line');
  }
  await ds.query('DELETE FROM t_project');

  console.log('删除完成，核验：');
  for (const t of tables) {
    const n = await count(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`  ${t}: ${n} 行`);
  }
  await ds.destroy();
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
