/**
 * 单文件可执行程序打包管线（Node SEA + esbuild）。
 *
 *   node scripts/package-sea.mjs
 *
 * 产物：build/sea/IE-Platform.exe（自包含 Node 运行时 + 全站 bundle，
 *       目标机器无需 Node/npm/源码，双击即跑）。
 *
 * 前置：已执行 npx tsc -p tsconfig.json（dist/ 就绪）且 web/dist 已构建
 *      （前端由 exe 在运行期托管，不内嵌，见 src/core/web-assets.ts）。
 *
 * 原理：
 *  ① esbuild 把 dist/src/cli.js 及全部纯 JS 依赖打成单 CJS bundle
 *     （keepNames：NestJS/TypeORM 元数据依赖类名，禁改名）；
 *  ② node --experimental-sea-config 生成 sea-prep.blob；
 *  ③ 复制当前 node.exe 为 IE-Platform.exe，postject 把 blob 注入
 *     NODE_SEA_BLOB 哨兵段并翻闸 FUSE。
 *
 * 已知边界：
 *  - 原生 .node 模块无法内联（SEA 只能读 PE 内 blob，不能 dlopen 其中文件）。
 *    本生产链路（mssql/tedious/bcryptjs/prom-client…）全为纯 JS，不涉及；
 *    ffmpeg-static 标记 external——其 require 在 videos.service.ts 有
 *    try/catch 兜底，运行期缺失即跳过，转码改由随包 bin/ffmpeg.exe 提供。
 *  - 产出 exe 未做代码签名：目标机首次运行可能有 SmartScreen 提示，
 *    需管理员放行（或改用自有证书签名，见交付文档）。
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postject = require('postject');

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.join(apiRoot, 'build', 'sea');
const bundleFile = path.join(workDir, 'ie-platform.bundle.cjs');
const blobFile = path.join(workDir, 'sea-prep.blob');
const exeName = 'IE-Platform.exe';
const exeFile = path.join(workDir, exeName);

function fail(msg) {
  console.error(`[package-sea] ${msg}`);
  process.exit(1);
}

if (process.platform !== 'win32') fail('本打包脚本面向 Windows Server 部署，仅支持 win32');
if (process.arch !== 'x64') fail(`仅支持 x64，当前 ${process.arch}`);
if (!fs.existsSync(path.join(apiRoot, 'dist', 'src', 'cli.js'))) fail('缺少 dist/src/cli.js，请先执行 npx tsc -p tsconfig.json');

// 0) 清理工作目录（幂等重打）
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

// 1) esbuild：整站单 bundle
console.log('[package-sea] 1/4 esbuild 打包单 bundle …');
await build({
  entryPoints: [path.join(apiRoot, 'dist', 'src', 'cli.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundleFile,
  keepNames: true,
  // ffmpeg-static：videos.service.ts 有 try/catch 兜底，缺失即跳过（转码改由随包 bin/ffmpeg.exe 提供）；
  // @nestjs 三个可选适配器：@nestjs/core 经 optionalRequire/loadPackage 惰性加载且 try/catch 兜底，
  // 本项目纯 HTTP 服务不启用 websockets/microservices，外置后运行期 require 失败即静默回落。
  external: [
    'ffmpeg-static',
    '@nestjs/websockets/socket-module',
    '@nestjs/microservices/microservices-module',
    '@nestjs/microservices',
  ],
  logLevel: 'warning',
  logLimit: 50,
}).catch((e) => fail(`esbuild 失败：${e.message}`));
if (!fs.existsSync(bundleFile)) fail('esbuild 未产出 bundle');

// 2) SEA 配置 + blob
console.log('[package-sea] 2/4 生成 SEA blob …');
const seaConfigPath = path.join(workDir, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: bundleFile,
  output: blobFile,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
if (!fs.existsSync(blobFile)) fail('node 未产出 sea-prep.blob');

// 3) node.exe 副本 + postject 注入
console.log('[package-sea] 3/4 注入 SEA blob 到 node 副本 …');
fs.copyFileSync(process.execPath, exeFile);
await postject.inject(exeFile, 'NODE_SEA_BLOB', fs.readFileSync(blobFile), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

// 4) 自检：产物能跑 version 子命令（不碰数据库/网络，最轻量验证）
console.log('[package-sea] 4/4 自检 …');
const out = execFileSync(exeFile, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (!/^IE-Platform /.test(String(out).trim())) fail(`自检异常输出：${out}`);
const sizeMb = (fs.statSync(exeFile).size / 1024 / 1024).toFixed(1);
console.log(`[package-sea] 完成：${exeFile}（${sizeMb} MB）`);
console.log(`[package-sea] 自检输出：${String(out).trim()}`);

// 5) 组装发布包（deliverables/IE-Platform-v1.0.0/）
console.log('[package-sea] 5/5 组装发布包 …');
const projectRoot = path.resolve(apiRoot, '..', '..');
const releaseName = 'IE-Platform-v1.0.0';
const releaseDir = path.join(projectRoot, 'deliverables', releaseName);
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
const cpTree = (src, dest) => fs.cpSync(src, dest, { recursive: true });
const cpFile = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};

cpFile(exeFile, path.join(releaseDir, exeName));                                    // 主程序
cpFile(path.join(apiRoot, 'bin', 'ffmpeg.exe'), path.join(releaseDir, 'bin', 'ffmpeg.exe'));
cpTree(path.join(apiRoot, '..', 'config', 'rules'), path.join(releaseDir, 'config', 'rules'));
cpFile(path.join(apiRoot, '..', 'config', 'benefit_params.json'), path.join(releaseDir, 'config', 'benefit_params.json'));
cpTree(path.join(apiRoot, '..', 'web', 'dist'), path.join(releaseDir, 'web', 'dist')); // 前端（exe 托管）
for (const d of ['storage/videos', 'logs']) {
  fs.mkdirSync(path.join(releaseDir, d), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, d, '.gitkeep'), '');
}
cpFile(path.join(apiRoot, 'packaging', 'env.template'), path.join(releaseDir, '.env')); // 含真实值，开箱即跑
for (const f of ['start.bat', 'stop.bat', 'install-service.bat', 'uninstall-service.bat', '部署与使用说明.md']) {
  cpFile(path.join(apiRoot, 'packaging', f), path.join(releaseDir, f));
}

const pkgSizeMb = (fs.statSync(exeFile).size + fs.statSync(path.join(releaseDir, 'bin', 'ffmpeg.exe')).size
  + dirSize(path.join(releaseDir, 'web', 'dist'))) / 1024 / 1024;
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
console.log(`[package-sea] 发布包就绪：${releaseDir}（约 ${pkgSizeMb.toFixed(0)} MB）`);
