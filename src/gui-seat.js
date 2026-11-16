// P6-3：GUI 席位「全局只能有一份」的占位文件。
//
// 为什么必须有：GUI 席位靠抢键鼠干活，两份控制面同时带 GUI 席位就会互相抢——
// A 刚把窗口顶到前台，B 又顶走，两边都在往同一个输入框里贴提示词，产物还会串单。
// 进程内互斥锁管不住这个，必须落到**跨进程**的公共文件上。
//
// 判定规则（宁可误拦，不可双开）：
//   - 没有占位文件 → 直接拿下
//   - 占位者 pid 还活着且不是自己 → 冲突，**拒绝启动**（说清是谁、哪个端口）
//   - 占位者 pid 已死 / 已标记 released → 接管（所以崩溃不会把席位永久锁死）
//
// 与 gui-lock 的分工：这里管「谁有权带 GUI 席位」（进程级，启动时判一次）；
// gui-lock 管「同一时刻只能有一个 GUI 任务在跑」（运行级，每次派活判）。

import fs from 'node:fs';
import path from 'node:path';

export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function createSeatClaim({
  file, owner = 'control-plane', now = () => new Date(), isAlive = defaultIsAlive,
} = {}) {
  function read() {
    if (!file || !fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { corrupt: true }; }
  }

  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 纯 ASCII：这个文件可能被 PowerShell 读，中文会被按 GBK 解坏。
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  function status() {
    const state = read();
    if (!state) return { held: false, state: null };
    if (state.released) return { held: false, state, released: true };
    const alive = isAlive(state.pid);
    return { held: alive, alive, state };
  }

  function claim({ pid = process.pid, port = null, configPath = null, extra = {} } = {}) {
    const current = status();
    if (current.held && current.state?.pid !== pid) {
      return {
        ok: false,
        conflict: true,
        holder: current.state,
        reason: `GUI 席位已被另一个控制面占用（pid ${current.state?.pid}，端口 ${current.state?.port ?? '-'}，`
          + `配置文件 ${current.state?.configPath ?? '未知'}）；同一台机器只能有一个实例带 GUI 席位`,
      };
    }
    const state = {
      owner, pid, port, configPath, released: false,
      acquiredAt: now().toISOString(), ...extra,
    };
    write(state);
    return { ok: true, state };
  }

  function release({ pid = process.pid } = {}) {
    const current = read();
    if (!current) return { released: false, reason: '没有占位文件' };
    if (current.pid !== pid) {
      return { released: false, reason: `席位属于 pid ${current.pid}，不越权释放` };
    }
    write({ ...current, released: true, releasedAt: now().toISOString() });
    return { released: true };
  }

  return { file, claim, release, status, read };
}

// 配置里只要有一个 gui-template 席位，就需要占位；返回占位结果与席位名，方便启动日志说清楚。
export function guiSeatAgents(config) {
  const agents = Array.isArray(config?.agents) ? config.agents : [];
  return agents.filter((a) => a?.adapter?.type === 'gui-template').map((a) => a.id);
}
