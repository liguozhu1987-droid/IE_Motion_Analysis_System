#!/usr/bin/env node
/**
 * 静态门禁：app/web/src 中禁止出现原生 <select>（复发≥3 轮）
 *
 * 原因（AGENT必读.md 铁律）：Chromium 在高 DPI / 页面缩放 / transform 下，
 * 原生 select 的 popup 与控件会发生坐标漂移，CSS 无解。必须使用自绘
 * SelectMenu / FilterSelect / TypeSelect（portal + JS 坐标 + Flip）。
 *
 * 判定：剥掉注释后仍出现 <select ...> 或 </select> 即失败，并输出 文件:行:片段。
 * 说明：本脚本只做静态扫描；它不能证明运行时全部走了自绘组件，但能拦住新引入的原生控件。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'app', 'web', 'src');
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const NATIVE_SELECT_RE = /<\/?select\b/gi;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 逐行剥离 // 与块注释，保留行号（足够用于静态扫描，不追求完整 JS 词法分析）。 */
function stripComments(text) {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  return lines.map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '/') break;
      out += line[i];
      i += 1;
    }
    return out;
  });
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`NATIVE_SELECT=1\nFAIL: 源码目录不存在: ${SRC}`);
    return 1;
  }
  const files = walk(SRC);
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = stripComments(fs.readFileSync(file, 'utf8'));
    lines.forEach((line, idx) => {
      const matches = [...line.matchAll(NATIVE_SELECT_RE)];
      for (const m of matches) {
        hits.push({ file: rel, line: idx + 1, snippet: line.trim().slice(0, 120) });
      }
    });
  }

  console.log(`FILES_SCANNED=${files.length}`);
  console.log(`NATIVE_SELECT=${hits.length}`);
  if (hits.length) {
    console.log('\n=== 原生 <select> 使用（必须改为自绘 SelectMenu / FilterSelect / TypeSelect）===');
    for (const h of hits) console.log(`${h.file}:${h.line}: ${h.snippet}`);
    console.log('\nRESULT=FAIL');
    return 1;
  }
  console.log('PASS：app/web/src 中未发现原生 <select>（注释已剥离）');
  console.log('RESULT=PASS');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`NATIVE_SELECT=1\nFAIL: 静态扫描异常: ${e.message ?? e}`);
  process.exitCode = 1;
}
