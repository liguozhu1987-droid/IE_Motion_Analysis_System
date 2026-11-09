/**
 * W3 前端构建门禁：路由拆包不回退 + 首屏 JS gzip 预算。
 * 只检查 dist 构建产物，不等同于 Lighthouse LCP/INP/CLS 或时间线真实帧率。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIST = path.resolve(__dirname, 'dist');
const OUT = path.resolve(__dirname, '../../deliverables/PST-frontend-bundle.json');
const INDEX = path.join(DIST, 'index.html');
const INITIAL_GZIP_LIMIT = 120 * 1024;
const REQUIRED_CHUNKS = ['DashboardPage', 'WorkbenchPage', 'AnalysisPage'];

if (!fs.existsSync(INDEX)) {
  console.error('dist/index.html 不存在，请先执行 npm run build');
  process.exit(1);
}
const html = fs.readFileSync(INDEX, 'utf8');
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
const assets = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
const sizeOf = (file) => {
  const raw = fs.readFileSync(file);
  return { file: path.basename(file), raw_bytes: raw.length, gzip_bytes: zlib.gzipSync(raw, { level: 9 }).length };
};
const initial = scripts.map((src) => sizeOf(path.join(DIST, src)));
const chunks = Object.fromEntries(REQUIRED_CHUNKS.map((name) => {
  const file = assets.find((f) => f.startsWith(`${name}-`));
  return [name, file ? sizeOf(path.join(DIST, 'assets', file)) : null];
}));
const initialGzip = initial.reduce((sum, f) => sum + f.gzip_bytes, 0);
const checks = [
  { name: '首屏只有一个入口 script', pass: scripts.length === 1, evidence: scripts },
  { name: '首屏 JS gzip ≤120KB', pass: initialGzip > 0 && initialGzip <= INITIAL_GZIP_LIMIT, evidence: { gzip_bytes: initialGzip, limit: INITIAL_GZIP_LIMIT } },
  ...REQUIRED_CHUNKS.map((name) => ({ name: `${name} 独立路由 chunk`, pass: Boolean(chunks[name]), evidence: chunks[name]?.file || null })),
  { name: '首屏 HTML 不预载重工作台', pass: !scripts.some((s) => s.includes('WorkbenchPage')), evidence: scripts },
];
const report = {
  generated_at: new Date().toISOString(), dist: 'app/web/dist', initial, initial_gzip_bytes: initialGzip,
  route_chunks: chunks, total_js_chunks: assets.length,
  passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length, checks,
  not_covered: ['Lighthouse LCP/INP/CLS', '真实 Chrome 时间线拖拽帧率与长任务'],
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
console.log(`前端构建门禁: ${report.passed}/${checks.length} 通过；报告 ${OUT}`);
process.exit(report.failed ? 1 : 0);
