#!/usr/bin/env node
/**
 * AI 分解评测门（0c / P0-4）
 *
 * 目的：把 `app/web/tools/eval-ai-segment.cjs` 绑进单命令回归门，并保证每次结果
 * 都以结构化 JSON 留档（可对比上一版），而不是只在终端滚过去。
 *
 * 用法：
 *   node scripts/gates/run-eval-gate.cjs
 *   node scripts/gates/run-eval-gate.cjs <candidates.json> <ground-truth.json>
 *   node scripts/gates/run-eval-gate.cjs --enforce     # 三项验收未全达标则退出码 1
 *
 * 查找顺序：
 *   1) 命令行两个位置参数；
 *   2) `deliverables/ai-segment/eval/fixtures.json` 清单（candidates / ground_truth）；
 *   3) `deliverables/ai-segment/eval/candidates.json` + `ground-truth.json`。
 *
 * 真值纪律（不可绕过）：
 *   - 真值必须由人独立标注，**不得用 AI 候选反向生成真值**；
 *   - 模板占位（labeler 仍是“填写标注人姓名” / segments 只有示例）一律判 SKIPPED，
 *     不冒充基线。
 *
 * 退出码：0 基线已留档；1 配置了真值但评测失败/未达标（仅 --enforce）；78 SKIPPED。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_TOOL = path.join(ROOT, 'app', 'web', 'tools', 'eval-ai-segment.cjs');
const FIXTURE_DIR = path.join(ROOT, 'deliverables', 'ai-segment', 'eval');
const MANIFEST = path.join(FIXTURE_DIR, 'fixtures.json');
const REPORT_DIR = path.join(ROOT, 'deliverables', 'gates', 'eval');
const SKIP_EXIT = 78;

const PLACEHOLDER_LABELERS = new Set(['', '填写标注人姓名', '待填写', 'TBD', 'placeholder']);

function fileTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function fail(message) {
  console.error(`EVAL_FAIL=1`);
  console.error(`EVAL_REASON=${message}`);
  console.error(message);
  return 1;
}

function skip(message) {
  console.log(`EVAL_SKIP=1`);
  console.log(`EVAL_REASON=${message}`);
  console.log(`SKIPPED: ${message}`);
  console.log('真值模板: app/web/docs/ai-segment-ground-truth.template.json');
  console.log('操作指南: app/web/docs/AI-SEGMENT-EVAL.md');
  console.log('注意：真值必须由人独立标注，不得用 AI 候选反向生成。');
  return SKIP_EXIT;
}

function resolveFixture() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const enforce = process.argv.includes('--enforce');
  let candidates = positional[0] ? path.resolve(positional[0]) : null;
  let groundTruth = positional[1] ? path.resolve(positional[1]) : null;

  if ((!candidates || !groundTruth) && fs.existsSync(MANIFEST)) {
    try {
      const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      if (!candidates && m.candidates) candidates = path.resolve(path.dirname(MANIFEST), m.candidates);
      if (!groundTruth && m.ground_truth) groundTruth = path.resolve(path.dirname(MANIFEST), m.ground_truth);
    } catch (e) {
      return { error: `fixtures.json 无法解析: ${e.message}` };
    }
  }
  if (!candidates) candidates = path.join(FIXTURE_DIR, 'candidates.json');
  if (!groundTruth) groundTruth = path.join(FIXTURE_DIR, 'ground-truth.json');
  return { candidates, groundTruth, enforce };
}

function validateGroundTruth(gtPath) {
  let gt;
  try {
    gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
  } catch (e) {
    return `真值 JSON 无法解析: ${e.message}`;
  }
  const segments = gt.segments;
  if (!Array.isArray(segments) || segments.length === 0) return '真值 segments 为空';
  if (PLACEHOLDER_LABELERS.has(String(gt.labeler ?? '').trim())) return '真值 labeler 仍是占位值（须填写实际标注人）';
  if (/^(selftest|self-test|fixture|synthetic|demo)/i.test(String(gt.labeler).trim())) {
    return '真值 labeler 标记为测试夹具，不得作为生产基线留档';
  }
  const bad = segments.filter((s) => !Number.isFinite(s.start_ms) || !Number.isFinite(s.end_ms) || s.end_ms < s.start_ms);
  if (bad.length) return `真值有 ${bad.length} 段缺少数值型 start_ms/end_ms 或 end_ms<start_ms`;
  return null;
}

function validateCandidates(candPath) {
  let cand;
  try {
    cand = JSON.parse(fs.readFileSync(candPath, 'utf8'));
  } catch (e) {
    return `候选 JSON 无法解析: ${e.message}`;
  }
  if (!Array.isArray(cand.candidates) || cand.candidates.length === 0) return '候选 candidates 为空';
  const bad = cand.candidates.filter((c) => !Number.isFinite(c.start_ms) || !Number.isFinite(c.end_ms) || c.end_ms < c.start_ms);
  if (bad.length) return `候选有 ${bad.length} 条缺少数值型 start_ms/end_ms 或 end_ms<start_ms`;
  return null;
}

function main() {
  const fixture = resolveFixture();
  if (fixture.error) return fail(fixture.error);
  const { candidates, groundTruth, enforce } = fixture;

  if (!fs.existsSync(candidates) || !fs.existsSync(groundTruth)) {
    const missing = [candidates, groundTruth].filter((p) => !fs.existsSync(p)).map((p) => path.relative(ROOT, p));
    return skip(`未配置评测真值/候选对（缺: ${missing.join('、')}）`);
  }
  const gtError = validateGroundTruth(groundTruth);
  if (gtError) {
    // 模板/占位真值属于「尚未配置」，不是评测失败
    if (/模板|占位|segments 为空|夹具/.test(gtError)) return skip(gtError);
    return fail(gtError);
  }
  const candError = validateCandidates(candidates);
  if (candError) return fail(candError);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = fileTimestamp();
  const outJson = path.join(REPORT_DIR, `ai-segment-${stamp}.json`);
  console.log(`[eval] 候选: ${path.relative(ROOT, candidates)}`);
  console.log(`[eval] 真值: ${path.relative(ROOT, groundTruth)}`);
  console.log(`[eval] 输出: ${path.relative(ROOT, outJson)}`);

  const run = spawnSync(process.execPath, [EVAL_TOOL, candidates, groundTruth, '--iou', '0.5', '--json', outJson, ...(enforce ? ['--gate'] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
    shell: false,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  if (run.error) return fail(`评测脚本执行失败: ${run.error.message ?? run.error}`);
  if (run.status !== 0 && !fs.existsSync(outJson)) {
    return fail(`评测脚本退出码 ${run.status}，且未生成结构化报告`);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  } catch (e) {
    return fail(`结构化报告无法解析: ${e.message}`);
  }
  const accepted = Number(report.acceptance?.accepted ?? 0);
  const total = Number(report.acceptance?.total ?? 3);
  console.log(`EVAL_ACCEPTED=${accepted}/${total}`);
  console.log(`EVAL_REPORT=${path.relative(ROOT, outJson)}`);

  // 便于对比上一版：时间戳留档 + latest 指针（同一真值重跑即可覆盖 latest）
  const latest = path.join(REPORT_DIR, 'latest.json');
  try { fs.copyFileSync(outJson, latest); } catch (e) { console.warn(`latest.json 复制失败: ${e.message}`); }

  if (enforce && accepted !== total) {
    console.error(`EVAL_ENFORCE=FAIL（${accepted}/${total} 达标）`);
    return 1;
  }
  console.log('EVAL_BASELINE=RECORDED');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`EVAL_FAIL=1\nEVAL_REASON=${e.message ?? e}`);
  process.exitCode = 1;
}
