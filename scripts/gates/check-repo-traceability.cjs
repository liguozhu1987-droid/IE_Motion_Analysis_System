#!/usr/bin/env node
/**
 * 版本可追溯门禁（0b 三项可判死判据）
 *
 * 1. `git status --porcelain` 为空；
 * 2. 仓库已打 tag；
 * 3. **存在一个 tag**，其指向的 commit 含 `scripts/gates/` 全部文件。
 *
 * 注意：不要求 tag 永远停在 HEAD——基线打 tag 后允许再补文档提交（tag 仍须可追溯）。
 * 禁止按「未提交文件数」核对：95/96/98 都是成文时点快照（见 todo.md）。
 *
 * 用法：
 *   node scripts/gates/check-repo-traceability.cjs                  # 严格（0b 验收口径）
 *   node scripts/gates/check-repo-traceability.cjs --ignore-gate-artifacts
 *       # 日常跑门禁时忽略 deliverables/gates/ 产物（报告本身是门禁输出，不是源码改动）
 *
 * 说明：本门禁默认 advisory（见 gates.config.cjs），因为 0a 落地时尚未到 0b。
 *       0b 验收必须用严格模式并人工确认三项全部 PASS。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GATE_DIR = path.join(ROOT, 'scripts', 'gates');

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, out: (r.stderr || r.stdout || '').trim() };
  return { ok: true, out: r.stdout.trim() };
}

function main() {
  const ignoreArtifacts = process.argv.includes('--ignore-gate-artifacts');

  // 1) 工作区干净
  const status = git(['status', '--porcelain']);
  const dirtyLines = status.ok ? status.out.split(/\r?\n/).filter(Boolean) : ['<git status 失败>'];
  const relevantDirty = ignoreArtifacts
    ? dirtyLines.filter((l) => !/^\?\?\s+deliverables\/gates\//.test(l) && !/^\s*[MADRCU?!]{1,2}\s+deliverables\/gates\//.test(l))
    : dirtyLines;
  const dirtyOk = relevantDirty.length === 0;

  // 2) 已打 tag（不要求 tag 停在 HEAD）
  const tagsResult = git(['tag', '--list']);
  const tags = tagsResult.ok ? tagsResult.out.split(/\r?\n/).filter(Boolean) : [];
  const tagOk = tagsResult.ok && tags.length > 0;

  // 3) 存在一个 tag，其指向的 commit 含 scripts/gates 全部文件
  const localFiles = fs.existsSync(GATE_DIR)
    ? fs.readdirSync(GATE_DIR).filter((f) => fs.statSync(path.join(GATE_DIR, f)).isFile()).map((f) => `scripts/gates/${f}`)
    : [];
  let bestTag = null;
  let bestMissing = localFiles;
  for (const tag of tags) {
    const tree = git(['ls-tree', '-r', '--name-only', tag, '--', 'scripts/gates']);
    const inTag = new Set(tree.ok ? tree.out.split(/\r?\n/).filter(Boolean) : []);
    const missing = localFiles.filter((f) => !inTag.has(f));
    if (missing.length === 0 && localFiles.length > 0) { bestTag = tag; bestMissing = []; break; }
    if (localFiles.length - missing.length > localFiles.length - bestMissing.length) {
      bestTag = tag;
      bestMissing = missing;
    }
  }
  const filesOk = localFiles.length > 0 && bestTag !== null && bestMissing.length === 0;
  const tagWithGates = filesOk ? bestTag : null;

  const checks = [dirtyOk, tagOk, filesOk];
  const passed = checks.filter(Boolean).length;

  console.log(`TRACE_DIRTY_COUNT=${relevantDirty.length}`);
  console.log(`TRACE_TAGS=${tags.join(',') || '(none)'}`);
  console.log(`TRACE_TAG_WITH_GATES=${tagWithGates ?? '(none)'}`);
  console.log(`TRACE_GATE_FILES_IN_TAG=${localFiles.length - bestMissing.length}/${localFiles.length}`);
  console.log(`TRACE_CHECKS=${passed}/${checks.length}`);
  if (dirtyLines.length) {
    console.log(`\n=== 未提交文件（${ignoreArtifacts ? '已忽略 deliverables/gates/ 产物' : '严格模式'}）===`);
    for (const line of relevantDirty.slice(0, 20)) console.log(`  ${line}`);
    if (relevantDirty.length > 20) console.log(`  ... 另 ${relevantDirty.length - 20} 行（完整清单: git status --porcelain）`);
  }
  if (!tagOk) console.log('\n=== 2. 仓库无 tag ===');
  if (!filesOk) {
    console.log(`\n=== 3. 没有 tag 含 scripts/gates 全部文件（最近候选: ${bestTag ?? '无'}）===`);
    for (const f of bestMissing) console.log(`  MISSING in ${bestTag ?? 'all tags'}: ${f}`);
  }
  console.log(`\nRESULT=${passed === checks.length ? 'PASS' : 'FAIL'}`);
  if (passed !== checks.length) {
    console.log('0b 尚未达成：先 git add -A 提交全部文件并打 tag，且 tag 必须指向含 scripts/gates 全部文件的 commit。');
    console.log('本项为 advisory，不改变门禁退出码；0b 验收须严格模式人工确认。');
  }
  return passed === checks.length ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`TRACE_CHECKS=0/3\nFAIL: ${e.message ?? e}`);
  process.exitCode = 1;
}
