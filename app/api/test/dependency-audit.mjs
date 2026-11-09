/**
 * W4 生产依赖审计门禁：high/critical 阻断，moderate/low 记账。
 * npm audit 发现漏洞时自身退出 1，这不是脚本异常；JSON 仍须解析归档。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const OUT = resolve(ROOT, 'deliverables');
const npmCli = process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const command = process.platform === 'win32' ? process.execPath : 'npm';
const commandArgs = process.platform === 'win32' ? [npmCli, 'audit'] : ['audit'];
const targets = [
  { name: 'api', cwd: resolve(ROOT, 'app/api') },
  { name: 'web', cwd: resolve(ROOT, 'app/web') },
];
const results = [];

for (const target of targets) {
  const run = spawnSync(command, [...commandArgs, '--omit=dev', '--json'], {
    cwd: target.cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' }, shell: false,
  });
  let audit;
  try {
    audit = JSON.parse(run.stdout);
  } catch (e) {
    console.error(`${target.name}: npm audit 未返回可解析 JSON`, run.stderr || run.error || e);
    results.push({ name: target.name, execution_error: true, pass: false });
    continue;
  }
  writeFileSync(resolve(OUT, `PST-npm-audit-${target.name}.json`), JSON.stringify(audit, null, 2));
  const counts = audit.metadata?.vulnerabilities ?? {};
  const result = {
    name: target.name, npm_exit_code: run.status, counts,
    pass: Number(counts.high || 0) === 0 && Number(counts.critical || 0) === 0,
    policy: '生产依赖 high/critical=0 才通过；moderate/low 记录但不阻断',
  };
  results.push(result);
  console.log(`${target.name}: ${JSON.stringify(counts)} -> ${result.pass ? 'PASS' : 'FAIL'}`);
}

const summary = {
  generated_at: new Date().toISOString(),
  command: 'npm audit --omit=dev --json（app/api 与 app/web 分别执行）',
  passed: results.length === targets.length && results.every((r) => r.pass),
  results,
  note: '不使用 npm audit fix --force 自动跨 major 升级；依赖修复须单独评估 NestJS/sqlite3 兼容性。',
};
writeFileSync(resolve(OUT, 'PST-dependency-audit.json'), JSON.stringify(summary, null, 2));
console.log(`依赖门禁: ${summary.passed ? 'PASS' : 'FAIL'}；报告 ${resolve(OUT, 'PST-dependency-audit.json')}`);
process.exit(summary.passed ? 0 : 1);
