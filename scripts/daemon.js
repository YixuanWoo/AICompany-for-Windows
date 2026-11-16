#!/usr/bin/env node
// P2-6：可选的零依赖进程守护，替代 pm2 / systemd 的「崩溃自动重启」那部分。
// 本地单机也能用：npm run start:daemon。默认 npm start 不需要它。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'server.js');

export function shouldRestart({ restarts, maxRestarts = 10, backoffMs = 1000 }) {
  if (restarts >= maxRestarts) {
    return { restart: false, reason: `连续重启已达上限 ${maxRestarts} 次` };
  }
  return {
    restart: true,
    backoffMs: Math.min(backoffMs * (2 ** restarts), 60000),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let restarts = 0;
  const run = () => {
    const child = spawn(process.execPath, [ENTRY], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      const decision = shouldRestart({ restarts });
      if (!decision.restart) {
        console.error(`[daemon] 停止重启：${decision.reason}`);
        process.exit(code ?? 1);
      }
      restarts += 1;
      console.error(`[daemon] 控制面退出（code=${code}），${decision.backoffMs}ms 后第 ${restarts} 次重启`);
      setTimeout(run, decision.backoffMs);
    });
  };
  run();
}
