/**
 * 隔离库结构初始化（仅 sqlite）：用 TypeORM synchronize 建表。
 * 生产 mssql 的表结构由 scripts/migrate.ts 负责；本脚本拒绝在 mssql 下运行，
 * 避免误把迁移逻辑指向正式库。
 */
const { DataSource } = require('typeorm');
const { loadConfig } = require('../dist/src/core/config/configuration');
const { typeOrmConfigFactory } = require('../dist/src/core/database/database.module');

(async () => {
  const cfg = loadConfig();
  if (cfg.dbType !== 'sqlite') {
    console.error('isolated-schema 仅用于 sqlite；mssql 请执行 dist/scripts/migrate.js');
    process.exit(1);
  }
  const ds = new DataSource({ ...typeOrmConfigFactory(cfg), synchronize: true });
  await ds.initialize();
  await ds.destroy();
  console.log(`隔离库结构就绪: ${cfg.dbPath}`);
})().catch((e) => {
  console.error('隔离库结构初始化失败:', e);
  process.exit(1);
});
