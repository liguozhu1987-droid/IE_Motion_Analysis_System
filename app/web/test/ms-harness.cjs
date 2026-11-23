/**
 * 动作标准离线回归共享装配（v3.66）：esbuild 打包 motionStandard.ts 为 CJS + 统一断言计数器。
 * 打包产物写入系统临时目录，避免在源码树留下 .built.cjs。
 */
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ENTRY = path.join(__dirname, 'ms-entry.mjs');
const BUILT = path.join(os.tmpdir(), `ie-ms-${process.pid}.cjs`);

function buildAndRequire() {
  const esbuild = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'esbuild.cmd');
  execSync(`"${esbuild}" "${ENTRY}" --bundle --platform=node --format=cjs --outfile="${BUILT}" --log-level=error "--define:import.meta.env={}"`, { stdio: 'inherit' });
  return require(BUILT);
}

function makeReporter() {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  ok  ', name); }
    else { fail++; console.error('FAIL  ', name, extra ? ' // ' + extra : ''); }
  };
  const done = () => {
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  };
  return { ok, done };
}

module.exports = { buildAndRequire, makeReporter };