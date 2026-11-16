// P2-6：内置定时例程，零依赖（不引入 node-cron / pm2）。
// 控制面自己按 rrule 算触发点；本地单机和远程服务器跑的是同一套代码。

import { nowIso } from './ids.js';

export function createScheduler({
  recurring, intervalMs = 15000, now = nowIso, onTick = null, logger = null,
}) {
  let timer = null;
  let ticks = 0;

  function runOnce({ now: atArg } = {}) {
    const result = recurring.tick({ now: atArg ?? now() });
    ticks += 1;
    if (logger) logger.info('scheduler_tick', { at: result.at, fired: result.fired });
    if (onTick) onTick(result);
    return result;
  }

  function start() {
    if (timer) return { started: false, reason: '已在运行' };
    timer = setInterval(() => {
      try { runOnce(); } catch (error) {
        if (logger) logger.error('scheduler_tick_failed', { error: String(error.message ?? error) });
      }
    }, intervalMs);
    // 定时例程不应阻止进程退出（本地演示关掉就关掉）。
    if (typeof timer.unref === 'function') timer.unref();
    return { started: true, intervalMs };
  }

  function stop() {
    if (!timer) return { stopped: false };
    clearInterval(timer);
    timer = null;
    return { stopped: true };
  }

  return {
    runOnce, start, stop,
    get running() { return timer !== null; },
    get ticks() { return ticks; },
  };
}
