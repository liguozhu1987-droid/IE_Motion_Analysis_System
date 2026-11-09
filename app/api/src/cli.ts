/**
 * 统一入口：既是开发态 `node dist/src/cli.js`，也是打包态 IE平台.exe 的主脚本。
 *
 *   IE平台.exe            启动服务（默认命令，等价 run）
 *   IE平台.exe run        同上
 *   IE平台.exe migrate    SQL Server 生产迁移（幂等 DDL，见 scripts/migrate.ts）
 *   IE平台.exe seed       灌入种子/演示数据（见 scripts/seed.ts）
 *
 * 为什么启动即 chdir 到可执行文件所在目录：
 *   .env / storage/videos / bin/ffmpeg.exe / logs / config/rules 全部按"工作目录"
 *   相对解析。双击 exe 时 cwd 恰为 exe 目录，但 Windows 服务（sc create）默认把
 *   工作目录设成 System32——不纠正则配置读不到、上传目录落错地方，全部静默跑偏。
 *   开发态（node.exe 直跑）保持原行为，用 IE_KEEP_CWD=1 可显式跳过纠正。
 */
import fs from 'node:fs';
import path from 'node:path';

const runningUnderNode = /(^|[\\/])node(\.exe)?$/i.test(process.execPath);
if (!runningUnderNode && process.env.IE_KEEP_CWD !== '1') {
  process.chdir(path.dirname(process.execPath));
}

const cmd = (process.argv[2] ?? 'run').toLowerCase();

void (async () => {
  switch (cmd) {
    case 'migrate':
      await import('../scripts/migrate.js');
      return;
    case 'seed':
      await import('../scripts/seed.js');
      return;
    case 'version':
      console.log(`IE-Platform 1.0.0 (node ${process.version}, sea)`);
      return;
    case 'stop': {
      // 自带停止命令：读 PID 文件 + process.kill，不依赖 taskkill/PATH，
      // 服务场景与前台场景行为一致（Windows 下 SIGTERM 即进程终止）。
      const pidFile = path.resolve('ie-platform.pid');
      if (!fs.existsSync(pidFile)) {
        console.error('未发现运行中的实例（ie-platform.pid 不存在）');
        process.exit(1);
      }
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) {
        console.error(`PID 文件内容异常：${pid}`);
        process.exit(1);
      }
      try {
        process.kill(pid);
      } catch (e) {
        console.error(`停止失败（PID ${pid}）：${(e as Error).message}`);
        process.exit(1);
      }
      try { fs.unlinkSync(pidFile); } catch { /* 已被进程退出钩子清理 */ }
      console.log(`已停止 IE-Platform（PID ${pid}）`);
      return;
    }
    case 'run':
    case 'start':
      break;
    default:
      console.error(`未知命令：${cmd}（可用命令：run | migrate | seed）`);
      process.exit(2);
  }

  // PID 文件：停止脚本据此精准结束进程，避免按镜像名 taskkill 误伤同机其他 node。
  const pidFile = path.resolve('ie-platform.pid');
  try {
    // 带换行符：CMD 的 set /p 对无换行文件读取行为不稳，停止脚本依赖此文件
    fs.writeFileSync(pidFile, process.pid + '\n', 'utf8');
  } catch { /* 只读文件系统等场景不阻塞启动 */
  }
  process.on('exit', () => {
    try { fs.unlinkSync(pidFile); } catch { /* 已删除/不存在即无需清理 */ }
  });

  await import('./main.js');
})();
