import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    if (code !== 0) console.log(`[dev] ${name} 退出，退出码 ${code}`);
    stopAll();
  });
  children.push(child);
  return child;
}

run('server', process.execPath, ['--watch', 'server/src/index.js'], appRoot);
run('web', 'npm', ['--workspace', 'web', 'run', 'dev'], appRoot);

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
