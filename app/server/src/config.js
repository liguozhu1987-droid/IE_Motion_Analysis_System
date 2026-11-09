import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`环境变量 ${name} 必须是数字，当前值：${raw}`);
  return value;
}

/**
 * 集中配置：所有环境变量只在此处读取并做类型转换，缺失/非法值启动即失败（fail fast）。
 * 见《MVP系统架构设计》§2 配置策略。
 */
export const config = Object.freeze({
  appRoot,
  env: process.env.NODE_ENV ?? 'development',
  port: intEnv('PORT', 3001),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? path.join(appRoot, 'data', 'ie.db'),
  rulesDir: process.env.RULES_DIR ?? path.join(appRoot, 'config', 'rules'),
  configDir: process.env.CONFIG_DIR ?? path.join(appRoot, 'config'),
  webDist: process.env.WEB_DIST ?? path.join(appRoot, 'web', 'dist'),
  /** 允许的前端来源（显式白名单，不使用 *） */
  origin: process.env.ORIGIN ?? 'http://localhost:5173',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** 空库时自动灌入试点线演示数据；生产部署置 SEED=0 */
  seed: process.env.SEED !== '0',
  maxBodyBytes: intEnv('MAX_BODY_BYTES', 5 * 1024 * 1024),
});
