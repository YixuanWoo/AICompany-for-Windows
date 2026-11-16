// P2-6：结构化日志 + 按天轮转。零依赖。
// 安全约定：只在本模块自己创建的 logs 目录里按 YYYY-MM-DD.log 追加写，
// **不自动删除任何文件**（清理旧日志必须由使用者显式决定，且只限本白名单目录）。

import fs from 'node:fs';
import path from 'node:path';

export const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}\.log$/;

export function createLogger({ dir, now = () => new Date(), stdout = false }) {
  function log(level, message, meta = {}) {
    const stamp = now().toISOString();
    const line = `${JSON.stringify({ at: stamp, level, message, ...meta })}\n`;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${stamp.slice(0, 10)}.log`), line, 'utf8');
    if (stdout) process.stdout.write(line);
    return line;
  }

  return {
    log,
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    listFiles: () => (fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => LOG_FILE_RE.test(name)).sort()
      : []),
    readDay: (day) => {
      const file = path.join(dir, `${day}.log`);
      if (!LOG_FILE_RE.test(`${day}.log`) || !fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
