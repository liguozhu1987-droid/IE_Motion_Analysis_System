import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { loadConfig } from '../src/core/config/configuration';
import { collectStartupChecks, logStartupChecks } from '../src/core/startup/startup-check';

/**
 * 启动自检干跑（P0-3）：不启动服务、不连数据库，只打印「生产必需配置是否齐全」。
 * 用法：node dist/scripts/startup-check.js
 * 退出码：存在 fail 项（安全问题）→ 1；只有 warn → 0。
 */
const cfg = loadConfig();
const items = collectStartupChecks(process.env, cfg);
console.log(`自检环境: NODE_ENV=${cfg.nodeEnv} DB_TYPE=${cfg.dbType} cwd=${process.cwd()}`);
const ok = logStartupChecks(items, new Logger('StartupCheck'));
process.exitCode = ok ? 0 : 1;
