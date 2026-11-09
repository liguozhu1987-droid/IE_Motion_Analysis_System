/**
 * 门禁：CSS 类名「用了但没定义」审计（v3.60）
 * ------------------------------------------------------------
 * 起因：v3.60 全量扫描发现 16 个类名在 JSX 里被使用、CSS 里却零定义
 *   ——aw-*（浪费识别整页）、aip-scene*（镜头切分）、print-area、share-dlg、
 *     std-row-l1、wb-converting-txt、wb-tbx-g——区块长期靠 inline style 裸奔，
 *     其中 .aw-issue-card 因 .card 无外边距导致相邻卡片零间距粘连。
 *   这类问题在页面上「看起来没报错」，只能靠静态扫描发现，故固化为门禁。
 *
 * 用法：node test-css-classes.cjs   （已接 npm run test:css-classes）
 * 判定：出现新的未定义类名即失败（白名单内的动态前缀族除外）。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const STYLES = path.join(SRC, 'styles');

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p, out); }
    else out.push(p);
  }
  return out;
}

const files = walk(SRC);
const tsx = files.filter(f => /\.tsx?$/.test(f));
const cssFiles = fs.readdirSync(STYLES).filter(f => f.endsWith('.css'));

// 1) CSS 中已定义的类名
const defined = new Set();
for (const cf of cssFiles) {
  const t = fs.readFileSync(path.join(STYLES, cf), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of t.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
}

// 2) JSX 中使用的类名：className="..." / className={`...`} / className={'...'}
const used = new Map(); // cls -> Set(file)
for (const f of tsx) {
  const t = fs.readFileSync(f, 'utf8');
  const pats = [
    /className\s*=\s*"([^"]*)"/g,
    /className\s*=\s*\{`([^`]*)`\}/g,
    /className\s*=\s*\{'([^']*)'\}/g,
    /className\s*:\s*"([^"]*)"/g,
  ];
  for (const p of pats) {
    for (const m of t.matchAll(p)) {
      let s = m[1];
      // 去掉 ${...} 插值
      s = s.replace(/\$\{[^}]*\}/g, ' ');
      for (const c of s.split(/\s+/)) {
        if (!c || /[^A-Za-z0-9_-]/.test(c)) continue;
        if (!used.has(c)) used.set(c, new Set());
        used.get(c).add(path.relative(SRC, f).replace(/\\/g, '/'));
      }
    }
  }
  // 也抓取字符串拼接里的 ' on' / ' decided' 等片段
  for (const m of t.matchAll(/className=\{`([^`]*)`\}/g)) { /* 已在上面覆盖 */ }
}

// 3) 差集（排除动态前缀族：这些是 `className={`xx-${v}`}` 拼出来的，取值已在 CSS 中覆盖）
const DYNAMIC_PREFIX = new Set(['banner-', 'dot-', 'dr-', 'hand-', 'sop-', 'tier-']);
const missing = [...used.entries()].filter(([c]) => !defined.has(c) && !DYNAMIC_PREFIX.has(c));
missing.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

console.log('CSS 已定义类名数:', defined.size);
console.log('JSX 使用类名数:', used.size);
console.log('\n=== 使用但未定义（按影响文件数排序）===');
for (const [c, fs2] of missing) {
  console.log(`  ${c.padEnd(24)} ${fs2.size} 文件  ${[...fs2].slice(0, 3).join(', ')}${fs2.size > 3 ? ' …' : ''}`);
}
console.log('\n合计未定义:', missing.length);
if (missing.length > 0) {
  console.error('\nFAIL：存在「用了但没定义」的类名，请补样式或确认是否应加入 DYNAMIC_PREFIX 白名单');
  process.exit(1);
}
console.log('PASS：JSX 中使用的类名全部有 CSS 定义（动态前缀族已白名单）');
