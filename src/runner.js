// P6-1：Windows 常驻 runner（零依赖，替代 pm2 / nssm 那层壳）。
//
// 为什么需要它：`npm start` 是前台进程，挂机时窗口一关就死；`scripts/daemon.js` 用
// `stdio: 'inherit'`，而隐藏窗口启动时根本没有控制台，日志会一起丢掉 —— 出问题查无可查。
// 所以这里自己持有一个日志文件描述符，把子进程的 stdout / stderr 全接过来。
//
// 三件事：写日志（按天分文件）、崩溃重启（指数退避）、留 pid（可查可停）。
// 一条纪律：**不删任何文件**。日志超限只告警并换新分片，清理必须由人显式执行 --prune。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProfile } from './profiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SHARD_BYTES = 8 * 1024 * 1024;

export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function formatLogLine(text, { level = 'info', at = new Date() } = {}) {
  const body = String(text).replace(/\r?\n$/, '');
  return `[${stamp(at)}] [${level}] ${body}\n`;
}

export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// 按天分文件；单日超 8MB 换分片（server-2026-11-15.2.log），不覆盖、不删除。
export function pickLogFile(logDir, { date = new Date(), maxShard = MAX_SHARD_BYTES } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const base = path.join(logDir, `server-${dayKey(date)}`);
  for (let shard = 1; shard < 100; shard += 1) {
    const file = shard === 1 ? `${base}.log` : `${base}.${shard}.log`;
    if (!fs.existsSync(file)) return file;
    if (fs.statSync(file).size < maxShard) return file;
  }
  return `${base}.99.log`;
}

export function createLogger({ logDir, echo = false, onWarn = null } = {}) {
  let stream = null;
  let currentFile = null;
  let written = 0;

  function ensure() {
    const file = pickLogFile(logDir);
    if (file !== currentFile) {
      if (stream) stream.end();
      stream = fs.createWriteStream(file, { flags: 'a' });
      currentFile = file;
      if (onWarn) onWarn(`日志切换到 ${file}`);
    }
    return stream;
  }

  return {
    get file() { return currentFile; },
    write(text, level = 'info') {
      const line = formatLogLine(text, { level });
      written += Buffer.byteLength(line);
      ensure().write(line);
      if (echo) process.stdout.write(line);
      return line;
    },
    close() { if (stream) { stream.end(); stream = null; } },
  };
}

// pid 文件是「谁在跑」的唯一凭据；stale 的 pid 绝不能当成活的（否则永远起不来）。
export function pidFilePath(runDir) {
  return path.join(runDir, 'aicompany.pid');
}

export function readPid(runDir) {
  const file = pidFilePath(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && Number.isInteger(data.pid) ? data : null;
  } catch {
    return null;
  }
}

export function writePid(runDir, info) {
  // pid 文件是给「别的工具」读的（PowerShell 5.1 默认按 GBK 读 UTF-8，中文会被解坏并吞掉
  // 字节，JSON 直接报废）。所以这里一律写纯 ASCII：中文只留给 node 自己读写的日志。
  // 路径不进这个文件 —— 项目路径可能含中文，写进去就会变问号；要找路径看日志第一行。
  const safe = {
    pid: info.pid,
    runnerPid: info.runnerPid,
    startedAt: info.startedAt,
    reasonCode: info.reasonCode ?? 'unknown',
    port: Number(info.port ?? 0) || null,
  };
  fs.mkdirSync(runDir, { recursive: true });
  const file = pidFilePath(runDir);
  fs.writeFileSync(file, `${JSON.stringify(safe, null, 2)}\n`, 'ascii');
  return file;
}

export function clearPid(runDir) {
  const file = pidFilePath(runDir);
  // 只删自己写的那一个文件（不是用户文件），且要在确认是自己的 pid 之后再调。
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows 上对「别人起的同权限进程」可能抛 EPERM，那也说明它活着。
    return error.code === 'EPERM';
  }
}

export function runningInfo(runDir) {
  const info = readPid(runDir);
  if (!info) return { running: false, reason: '没有 pid 文件' };
  if (!isAlive(info.pid)) return { running: false, reason: `pid ${info.pid} 已不在`, stale: true, info };
  return { running: true, info };
}

// 退避策略与 daemon.js 一致，但「稳定跑够一段时间后计数归零」，
// 否则挂机几天遇到几次偶发崩溃就会永久放弃重启。
export function nextDelay({ restarts, maxRestarts = 20, baseMs = 1000, maxMs = 60000 }) {
  if (restarts >= maxRestarts) return { restart: false, reason: `连续崩溃 ${restarts} 次，已停止重启` };
  return { restart: true, delayMs: Math.min(baseMs * (2 ** Math.max(0, restarts - 1)), maxMs) };
}

// 「再起一次也一样」的退出码：重试没有意义，只会把日志刷满。
//   5 = GUI 席位已被另一个控制面占用（server.js 的占位判定）。
export const FATAL_EXIT_CODES = Object.freeze([5]);

export function isFatalExit(code) {
  return FATAL_EXIT_CODES.includes(code);
}

export function createRunner({
  root = ROOT, entry = path.join(ROOT, 'src', 'server.js'),
  logDir = path.join(ROOT, 'work', 'logs'), runDir = path.join(ROOT, 'work', 'run'),
  env = process.env, echo = false, maxRestarts = 20, stableMs = 60000,
  onEvent = () => {},
} = {}) {
  let child = null;
  let restarts = 0;
  let startedAt = null;
  let stopping = false;
  const log = createLogger({ logDir, echo, onWarn: (m) => log.write(m, 'warn') });

  const already = runningInfo(runDir);
  if (already.running) {
    // 关键区分：server 活着不代表「有守护在管它」。
    // 如果 runner 已经死了（被系统杀 / 任务管理器结束），那个 server 就是孤儿 ——
    // 新 runner 无法 wait 一个不是自己起的进程，只能先送走它再接管。
    // 只按「server 活着」就拒绝启动，会导致守护永久缺失、崩溃后无人重启。
    const runnerAlive = Number.isInteger(already.info.runnerPid) && isAlive(already.info.runnerPid);
    if (runnerAlive) {
      log.write(`已有实例在跑（runner ${already.info.runnerPid} / 控制面 ${already.info.pid}），不重复启动。`, 'warn');
      return { refused: true, info: already.info, log };
    }
    log.write(`发现孤儿控制面（pid ${already.info.pid}，其守护 ${already.info.runnerPid} 已不在），先结束它再接管。`, 'warn');
    try { process.kill(already.info.pid, 'SIGTERM'); } catch (error) {
      log.write(`结束孤儿控制面失败：${error.message}`, 'warn');
    }
    clearPid(runDir);
  } else if (already.stale) {
    log.write(`发现残留 pid（${already.info.pid} 已退出），接手续跑。`, 'warn');
  }

  function launch(reasonCode) {
    const reasonText = reasonCode === 'first-start' ? '首次启动' : `第 ${restarts} 次重启`;
    startedAt = Date.now();
    child = spawn(process.execPath, [entry], {
      cwd: root,
      env,
      // 关键：不用 inherit。隐藏窗口下没有控制台，inherit 等于把日志扔进黑洞。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const relay = (level) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        // SQLite 实验性警告每次启动必来一行，落成 error 会把真故障埋在噪音里。
        const noisy = /ExperimentalWarning|trace-warnings/.test(line);
        log.write(line, noisy ? 'warn' : level);
      }
    };
    child.stdout.on('data', relay('info'));
    child.stderr.on('data', relay('error'));
    child.on('error', (error) => log.write(`子进程启动失败：${error.message}`, 'error'));
    writePid(runDir, {
      pid: child.pid, runnerPid: process.pid, startedAt: new Date().toISOString(), reasonCode,
      port: Number(env.AICOMPANY_PORT ?? 3100),
    });
    log.write(`控制面已启动 pid=${child.pid}（${reasonText}）`);
    onEvent({ type: 'started', pid: child.pid, reason: reasonCode });

    child.on('exit', (code, signal) => {
      child = null;
      clearPid(runDir);
      if (stopping) {
        log.write(`收到停止指令，控制面已退出（code=${code}）。`);
        onEvent({ type: 'stopped', code });
        log.close();
        return;
      }
      const livedMs = Date.now() - startedAt;
      // 有些退出码代表「再起一次也一样」，不该当崩溃重试：
      //   5 = GUI 席位已被另一个控制面占用。此时重试 20 次只会把日志刷满，
      //       而真正该做的事是让用户去停那个占位实例（或确认自己没开两份）。
      // 这类码直接收摊并说清楚原因，不进入退避循环。
      if (code === 5) {
        log.write('控制面拒绝启动（code=5）：GUI 席位已被另一个控制面占用。不再重试，去停掉那个实例或换一份配置。', 'error');
        onEvent({ type: 'fatal', code });
        log.close();
        return;
      }      if (livedMs >= stableMs && restarts > 0) {
        log.write(`上一轮稳定运行 ${Math.round(livedMs / 1000)} 秒，崩溃计数归零。`);
        restarts = 0;
      }
      restarts += 1;
      const decision = nextDelay({ restarts, maxRestarts });
      log.write(`控制面退出 code=${code} signal=${signal ?? '-'}，已活 ${Math.round(livedMs / 1000)} 秒`, 'error');
      if (!decision.restart) {
        log.write(`放弃重启：${decision.reason}`, 'error');
        onEvent({ type: 'given_up', reason: decision.reason });
        log.close();
        return;
      }
      // 退避是 setTimeout，挂机时不能用「睡循环」；等待期间仍响应停止指令。
      log.write(`${decision.delayMs}ms 后第 ${restarts} 次重启`);
      setTimeout(() => { if (!stopping) launch(`restart-${restarts}`); }, decision.delayMs);
    });
  }

  function stop(signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    log.write(`收到 ${signal}，准备停止控制面。`);
    if (child) {
      try { child.kill(); } catch (error) { log.write(`kill 失败：${error.message}`, 'warn'); }
    } else {
      log.close();
    }
  }

  launch('first-start');
  return { stop, log, get pid() { return child?.pid ?? null; }, get restarts() { return restarts; } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flagValue = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] ?? null : null;
  };
  const profileName = flagValue('--profile') ?? process.env.AICOMPANY_PROFILE ?? null;
  let profile = null;
  if (profileName) {
    try { profile = resolveProfile(profileName); } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  }
  // PowerShell 侧不再自己拼路径：让它读这里输出的绝对路径，两边只有一个真相。
  // 输出转成纯 ASCII（中文 → \uXXXX）：PS 5.1 捕获原生命令输出时按控制台代码页解码，
  // 「D:\开源\...」这种路径会被解坏，转义后就没有解码问题，ConvertFrom-Json 照样能还原。
  if (args.includes('--print-profile')) {
    if (!profile) { console.error('--print-profile 需要同时给 --profile <档位名>'); process.exit(2); }
    const ascii = JSON.stringify(profile).replace(
      /[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    console.log(ascii);
    process.exit(0);
  }

  const env = { ...process.env };
  const runDir = env.AICOMPANY_RUN_DIR ?? profile?.runDir ?? path.join(ROOT, 'work', 'run');
  if (profile) {
    // ??= 而不是 =：显式传进来的环境变量优先级最高（临时排查时用得上）。
    env.AICOMPANY_PORT ??= String(profile.port);
    env.AICOMPANY_CONFIG ??= profile.config;
    env.AICOMPANY_DB ??= profile.db;
    env.AICOMPANY_GUI_SEAT ??= profile.guiSeatFile;
    env.AICOMPANY_GUI_PAUSE ??= profile.guiPauseFile;
    env.AICOMPANY_MAINTENANCE_SEC ??= String(profile.maintenanceSec);
    if (profile.requestAsync) env.AICOMPANY_REQUEST_ASYNC ??= '1';
    env.AICOMPANY_RUN_DIR = runDir;
    env.AICOMPANY_LOG_DIR ??= profile.logDir;
    env.AICOMPANY_PROFILE = profile.name;
  }

  if (args.includes('--status')) {
    const info = runningInfo(runDir);
    const tag = profile ? `[${profile.name}] ` : '';
    console.log(info.running
      ? `${tag}运行中：pid=${info.info.pid} 端口=${info.info.port ?? '-'} 起始=${info.info.startedAt}`
      : `${tag}未运行（${info.reason}）`);
    process.exit(info.running ? 0 : 3);
  }
  const runner = createRunner({
    logDir: env.AICOMPANY_LOG_DIR ?? path.join(ROOT, 'work', 'logs'),
    runDir,
    env,
    echo: args.includes('--echo'),
  });
  if (runner.refused) process.exit(4);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => runner.stop(sig)); } catch { /* 平台不支持就跳过 */ }
  }
  // 父进程不能因事件循环空转退出：子进程退出等待重启期间仍需存活。
  setInterval(() => {}, 1 << 30);
}
