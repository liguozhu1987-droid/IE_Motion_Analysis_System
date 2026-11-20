#!/usr/bin/env node
/**
 * 统一门禁执行器（QA 解禁路径 0a）
 *
 * 用法：
 *   node scripts/gates/run-gates.cjs                 # fast（默认）
 *   node scripts/gates/run-gates.cjs --profile full  # fast + 全量隔离套件 + 依赖审计
 *   node scripts/gates/run-gates.cjs --only api:typecheck,web:css-classes
 *   node scripts/gates/run-gates.cjs --list
 *   node scripts/gates/run-gates.cjs --no-report
 *
 * 语义：
 * - 严格串行（隔离/UI 回归禁并行）；
 * - SKIPPED（退出码 78 或输出含「总判定: SKIPPED」）不计为 PASS，也不拉低总判定，
 *   但必须至少有一个阻断门真正执行；
 * - advisory 门禁失败只记录，不改变退出码；
 * - 报告落盘 deliverables/gates/，含 git HEAD / 未提交数 / tag，保证基线可追溯。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./gates.config.cjs');

const ROOT = config.root;
const SKIP_EXIT = config.skipExitCode ?? 78;
const DEFAULT_REPORT_DIR = path.join(ROOT, 'deliverables', 'gates');

function parseArgs(argv) {
  const opts = { profile: 'fast', only: null, list: false, report: true, failOnAdvisory: false, reportDir: DEFAULT_REPORT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' && argv[i + 1]) { opts.profile = argv[i + 1]; i += 1; }
    else if (arg === '--only' && argv[i + 1]) { opts.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (arg === '--list') { opts.list = true; }
    else if (arg === '--no-report') { opts.report = false; }
    else if (arg === '--fail-on-advisory') { opts.failOnAdvisory = true; }
    else if (arg === '--report-dir' && argv[i + 1]) { opts.reportDir = path.resolve(argv[i + 1]); i += 1; }
    else { throw new Error(`未知参数: ${arg}`); }
  }
  if (!config.profiles[opts.profile]) {
    throw new Error(`未知 profile: ${opts.profile}（可用: ${Object.keys(config.profiles).join(', ')}）`);
  }
  return opts;
}

function gatesFor(opts) {
  const byId = new Map(config.gates.map((g) => [g.id, g]));
  const ids = opts.only ?? config.profiles[opts.profile];
  for (const id of ids) if (!byId.has(id)) throw new Error(`未登记的门禁: ${id}`);
  return ids.map((id) => byId.get(id));
}

function resolveCommand(gate) {
  const { command } = gate;
  const cwd = path.resolve(ROOT, command.cwd || '.');
  if (command.kind === 'npm') {
    const npmCli = process.env.npm_execpath
      || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error(`找不到 npm-cli.js: ${npmCli}`);
    return { file: process.execPath, args: [npmCli, 'run', command.script], cwd, display: `npm run ${command.script}` };
  }
  if (command.kind === 'node') {
    const absolute = path.isAbsolute(command.script) ? command.script : null;
    const fromCwd = absolute ?? path.resolve(cwd, command.script);
    const fromRoot = absolute ?? path.resolve(ROOT, command.script);
    const scriptPath = fs.existsSync(fromCwd) ? fromCwd : fromRoot;
    if (!fs.existsSync(scriptPath)) throw new Error(`找不到脚本: ${scriptPath}（cwd=${cwd}）`);
    return {
      file: process.execPath,
      args: [scriptPath, ...(command.args ?? [])],
      cwd,
      display: `node ${command.script}${command.args?.length ? ' ' + command.args.join(' ') : ''}`,
    };
  }
  throw new Error(`不支持的命令类型: ${command.kind}`);
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function repoSmeta() {
  const head = git(['rev-parse', 'HEAD']) ?? 'unknown';
  const headShort = git(['rev-parse', '--short', 'HEAD']) ?? 'unknown';
  const porcelain = git(['status', '--porcelain']) ?? '';
  const dirty = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
  const tags = (git(['tag', '--points-at', 'HEAD']) ?? '').split(/\r?\n/).filter(Boolean);
  return { head, headShort, dirtyCount: dirty.length, tags, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown' };
}

function timestampForFile(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function classify(gate, run) {
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const skippedByRunner = /总判定:\s*SKIPPED/.test(output);
  const skipped = run.status === SKIP_EXIT || skippedByRunner;
  let parsed = null;
  if (gate.parse) {
    try { parsed = gate.parse(output); } catch (e) { parsed = null; }
  }
  const counts = skipped
    ? { pass: 0, fail: 0, unit: parsed?.unit ?? '命令' }
    : (parsed ?? { pass: run.status === 0 ? 1 : 0, fail: run.status === 0 ? 0 : 1, unit: '命令' });
  const exitedOk = run.status === 0;
  const passed = !skipped && exitedOk && Number(counts.fail ?? 0) === 0;
  return {
    status: skipped ? 'SKIP' : (passed ? 'PASS' : 'FAIL'),
    counts,
    output,
    skipReason: skipped
      ? (run.status === SKIP_EXIT ? extractSkipReason(output) : '套件全部 SKIPPED（不是 PASS）')
      : null,
    signal: run.signal ?? null,
    error: run.error ? String(run.error.message ?? run.error) : null,
  };
}

function extractSkipReason(output) {
  const line = output.split(/\r?\n/).find((l) => /SKIPPED|EVAL_REASON/.test(l));
  return line?.trim() || 'SKIPPED';
}

function formatCounts(counts) {
  return `通过 ${counts.pass ?? '-'} / 失败 ${counts.fail ?? '-'}（${counts.unit ?? '命令'}）`;
}

function runGate(gate, logDir) {
  const resolved = resolveCommand(gate);
  const started = Date.now();
  console.log(`\n[RUN ] ${gate.id}  ${gate.title}`);
  console.log(`       $ ${resolved.display}   (cwd=${path.relative(ROOT, resolved.cwd) || '.'})`);
  const r = spawnSync(resolved.file, resolved.args, {
    cwd: resolved.cwd,
    encoding: 'utf8',
    timeout: gate.timeoutMs ?? 300000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    shell: false,
  });
  const durationMs = Date.now() - started;
  const result = classify(gate, {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    signal: r.signal,
    error: r.error,
  });
  const durationSec = Math.round(durationMs / 100) / 10;
  const label = result.status === 'SKIP' ? 'SKIP' : (result.status === 'PASS' ? 'PASS' : 'FAIL');
  console.log(`[${label}] ${gate.id}  ${formatCounts(result.counts)}  ${durationSec}s`
    + `${gate.blocking ? '' : '  [advisory]'}`
    + `${result.skipReason ? `  (${result.skipReason})` : ''}`);
  if (result.error) console.log(`       执行错误: ${result.error}`);
  if (result.status === 'FAIL') {
    const tail = result.output.trim().split(/\r?\n/).slice(-12).join('\n');
    if (tail) console.log('       输出尾部:\n' + tail.split('\n').map((l) => '         ' + l).join('\n'));
  }
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `${gate.id.replace(/[^a-z0-9]+/gi, '_')}.log`),
      `# ${gate.id}\n# command: ${resolved.display}\n# cwd: ${path.relative(ROOT, resolved.cwd).replace(/\\/g, '/') || '.'}\n# exit: ${r.status}\n# duration_ms: ${durationMs}\n\n${result.output}`,
      'utf8',
    );
  }
  return {
    id: gate.id,
    title: gate.title,
    blocking: Boolean(gate.blocking),
    status: result.status,
    exitCode: r.status,
    durationMs,
    counts: { pass: result.counts.pass ?? null, fail: result.counts.fail ?? null, unit: result.counts.unit ?? '命令' },
    skipReason: result.skipReason,
    error: result.error,
    note: gate.note ?? null,
    command: resolved.display,
    log: logDir ? path.relative(ROOT, path.join(logDir, `${gate.id.replace(/[^a-z0-9]+/gi, '_')}.log`)).replace(/\\/g, '/') : null,
  };
}

function buildReport({ opts, gates, results, repo, startedAt, finishedAt, reportBase }) {
  const blocking = results.filter((r) => r.blocking);
  const advisory = results.filter((r) => !r.blocking);
  const executedBlocking = blocking.filter((r) => r.status !== 'SKIP');
  const blockingFailed = executedBlocking.filter((r) => r.status === 'FAIL');
  const advisoryFailed = advisory.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const overall = blockingFailed.length
    ? 'FAIL'
    : (executedBlocking.length === 0 ? 'SKIPPED' : 'PASS');
  return {
    schema: 'ie-gate-report/v1',
    generatedAt: new Date().toISOString(),
    startedAt,
    finishedAt,
    profile: opts.profile,
    overall,
    blocking: {
      total: blocking.length,
      executed: executedBlocking.length,
      failed: blockingFailed.length,
      passed: executedBlocking.filter((r) => r.status === 'PASS').length,
    },
    advisory: {
      total: advisory.length,
      failed: advisoryFailed.length,
      failedIds: advisoryFailed.map((r) => r.id),
    },
    skipped: skipped.map((r) => ({ id: r.id, reason: r.skipReason })),
    noGo: {
      maintained: true,
      note: '门禁基线不等于解禁声明；QA No-Go 仍以 todo.md §一 与 risk_log.md §四 为准。',
    },
    repo,
    gates: results,
    reportBase: path.relative(ROOT, reportBase).replace(/\\/g, '/'),
  };
}

function renderMarkdown(report) {
  const pct = (n) => String(n);
  const lines = [];
  lines.push(`# 门禁基线报告（${report.reportBase}）`);
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- profile：\`${report.profile}\``);
  lines.push(`- 总判定：**${report.overall}**（阻断门执行 ${report.blocking.executed}/${report.blocking.total}，`
    + `通过 ${report.blocking.passed}，失败 ${report.blocking.failed}；advisory 失败 ${report.advisory.failed}）`);
  lines.push(`- 分支：\`${report.repo.branch}\` ｜ HEAD：\`${report.repo.headShort}\` ｜ 未提交文件数：${report.repo.dirtyCount}`);
  lines.push(`- HEAD tag：${report.repo.tags.length ? report.repo.tags.map((t) => `\`${t}\``).join('、') : '**无**（0b 未达成）'}`);
  lines.push('');
  lines.push('> 本报告只记录实际执行结果；SKIPPED 不是 PASS。门禁基线不等于解禁声明。');
  lines.push('');
  lines.push('| 门 | 阻断 | 状态 | 通过/失败 | 耗时 | 命令 | 备注 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const g of report.gates) {
    const status = g.status === 'PASS' ? '✅ PASS' : (g.status === 'FAIL' ? '❌ FAIL' : '⏭ SKIP');
    const note = g.skipReason ? `SKIPPED：${g.skipReason}` : (g.note ?? '');
    lines.push(`| ${g.id} | ${g.blocking ? '是' : '否'} | ${status} | ${pct(g.counts.pass)}/${pct(g.counts.fail)}（${g.counts.unit}） | ${g.durationMs}ms | \`${g.command}\` | ${note.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (report.advisory.failed) {
    lines.push('## advisory 未通过项（不改变退出码，但须在解禁路径中闭环）');
    lines.push('');
    for (const id of report.advisory.failedIds) {
      const g = report.gates.find((x) => x.id === id);
      lines.push(`- \`${id}\`：${g?.note ?? '见日志'}`);
    }
    lines.push('');
  }
  if (report.skipped.length) {
    lines.push('## SKIPPED（不计为通过）');
    lines.push('');
    for (const s of report.skipped) lines.push(`- \`${s.id}\`：${s.reason}`);
    lines.push('');
  }
  lines.push('## 报告与日志');
  lines.push('');
  lines.push(`- JSON：\`${report.reportBase}.json\``);
  lines.push(`- 日志目录：\`${path.dirname(report.reportBase)}/logs/${path.basename(report.reportBase)}\``);
  return lines.join('\n') + '\n';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    console.log(`profiles: ${Object.keys(config.profiles).join(' / ')}`);
    for (const g of config.gates) {
      const profiles = Object.keys(config.profiles).filter((p) => config.profiles[p].includes(g.id));
      console.log(`${g.id.padEnd(28)} ${g.blocking ? 'blocking' : 'advisory'}  [${profiles.join(',')}]  ${g.title}`);
    }
    return 0;
  }

  const gates = gatesFor(opts);
  const startedAt = new Date().toISOString();
  const repo = repoSmeta();
  const reportBase = path.join(opts.reportDir, `gate-report-${timestampForFile()}`);
  const logDir = opts.report ? path.join(opts.reportDir, 'logs', path.basename(reportBase)) : null;

  console.log('='.repeat(78));
  console.log(`门禁执行器 ｜ profile=${opts.profile} ｜ ${gates.length} 个门 ｜ 串行`);
  console.log(`HEAD=${repo.headShort} ｜ 分支=${repo.branch} ｜ 未提交=${repo.dirtyCount} ｜ tag=${repo.tags.join(',') || '无'}`);
  console.log('='.repeat(78));

  const results = [];
  for (const gate of gates) {
    let result;
    try {
      result = runGate(gate, logDir);
    } catch (e) {
      result = {
        id: gate.id, title: gate.title, blocking: Boolean(gate.blocking), status: 'FAIL',
        exitCode: null, durationMs: 0, counts: { pass: 0, fail: 1, unit: '命令' },
        skipReason: null, error: String(e.message ?? e), note: gate.note ?? null,
        command: '(启动失败)', log: null,
      };
      console.error(`[FAIL] ${gate.id}  启动失败: ${result.error}`);
    }
    results.push(result);
  }

  const report = buildReport({
    opts, gates, results, repo, startedAt, finishedAt: new Date().toISOString(), reportBase,
  });

  console.log('\n' + '='.repeat(78));
  console.log(`门禁总计: ${report.overall}`);
  console.log(`阻断门: 执行 ${report.blocking.executed}/${report.blocking.total} ｜ 通过 ${report.blocking.passed} ｜ 失败 ${report.blocking.failed}`);
  if (report.advisory.failed) console.log(`advisory 失败: ${report.advisory.failedIds.join(', ')}（不改变退出码）`);
  if (report.skipped.length) console.log(`SKIPPED: ${report.skipped.map((s) => s.id).join(', ')}（不计为通过）`);
  console.log('QA No-Go 不因本报告改变；解禁路径见 handoff/明细/project_management/todo.md §一。');

  if (opts.report) {
    fs.mkdirSync(opts.reportDir, { recursive: true });
    fs.writeFileSync(`${reportBase}.json`, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(`${reportBase}.md`, renderMarkdown(report), 'utf8');
    console.log(`报告: ${path.relative(ROOT, `${reportBase}.json`)}`);
    console.log(`      ${path.relative(ROOT, `${reportBase}.md`)}`);
  }

  const blockingFailed = results.some((r) => r.blocking && r.status === 'FAIL');
  const executedBlocking = results.filter((r) => r.blocking && r.status !== 'SKIP');
  const advisoryFailed = results.some((r) => !r.blocking && r.status === 'FAIL');
  if (blockingFailed) return 1;
  if (executedBlocking.length === 0) { console.log('阻断门全部 SKIPPED → 判为未执行（非 PASS）'); return 1; }
  if (opts.failOnAdvisory && advisoryFailed) return 1;
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`门禁执行器异常: ${e.message ?? e}`);
  process.exitCode = 1;
}
