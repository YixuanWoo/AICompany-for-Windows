// P3-1：全局 GUI 互斥锁。GUI 不可并发，这条必须硬编码串行（任务书 §8.3 第 2 条）。
// 两种形态：默认进程内内存锁；给了 lockPath 就是跨进程文件锁（wx 独占创建）。
// 安全约定：释放时只改锁文件内容为 released，**不删除任何文件**。

import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './ids.js';

export function createGuiLock({ lockPath = null, now = nowIso, staleMs = 30 * 60 * 1000 } = {}) {
  let memory = null;

  function readLock() {
    if (!lockPath || !fs.existsSync(lockPath)) return null;
    try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return {}; }
  }

  function writeLock(state) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify(state)}\n`, 'utf8');
  }

  function isHeld() {
    if (!lockPath) return memory?.owner ?? null;
    const state = readLock();
    if (!state || state.released) return null;
    if (!state.acquiredAt || Date.parse(now()) - Date.parse(state.acquiredAt) > staleMs) return null;
    return state.owner ?? null;
  }

  function acquire(owner) {
    if (!owner) return { ok: false, reason: '缺 owner（一般用 runId）' };
    const holder = isHeld();
    if (holder && holder !== owner) {
      return { ok: false, busy: true, holder, reason: `GUI 正被 ${holder} 占用；同一时刻只允许一个 GUI 任务` };
    }
    if (!lockPath) {
      memory = { owner, acquiredAt: now() };
      return { ok: true, owner };
    }
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ owner, acquiredAt: now(), released: false })}\n`, 'utf8');
      } finally { fs.closeSync(fd); }
      return { ok: true, owner };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const state = readLock();
      const stale = !state?.acquiredAt || Date.parse(now()) - Date.parse(state.acquiredAt) > staleMs;
      if (!state?.released && !stale) {
        return {
          ok: false, busy: true, holder: state?.owner ?? 'unknown',
          reason: `GUI 正被 ${state?.owner ?? 'unknown'} 占用；同一时刻只允许一个 GUI 任务`,
        };
      }
      writeLock({ owner, acquiredAt: now(), released: false }); // 接管 stale / 已释放的锁
      return { ok: true, owner, tookOver: true };
    }
  }

  function release(owner) {
    const holder = isHeld();
    if (holder && holder !== owner) return { released: false, reason: `锁属于 ${holder}，不能越权释放` };
    if (!lockPath) { memory = null; return { released: true }; }
    writeLock({ owner, released: true, releasedAt: now() });
    return { released: true };
  }

  async function withLock(owner, fn) {
    const got = acquire(owner);
    if (!got.ok) return { ok: false, ...got, result: null };
    try { return { ok: true, result: await fn() }; }
    finally { release(owner); }
  }

  return {
    acquire, release, isHeld, withLock,
    mode: lockPath ? 'file' : 'memory', lockPath,
  };
}
