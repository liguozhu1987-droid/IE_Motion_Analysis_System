import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** 结构化 JSON 日志（禁止 console.log 散落输出） */
export const log = {
  debug: (msg, fields = {}) => emit('debug', msg, fields),
  info: (msg, fields = {}) => emit('info', msg, fields),
  warn: (msg, fields = {}) => emit('warn', msg, fields),
  error: (msg, fields = {}) => emit('error', msg, fields),
};

export function createLogger(bindings) {
  return {
    debug: (msg, fields = {}) => emit('debug', msg, { ...bindings, ...fields }),
    info: (msg, fields = {}) => emit('info', msg, { ...bindings, ...fields }),
    warn: (msg, fields = {}) => emit('warn', msg, { ...bindings, ...fields }),
    error: (msg, fields = {}) => emit('error', msg, { ...bindings, ...fields }),
  };
}
