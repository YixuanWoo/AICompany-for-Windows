// P6-3：GUI 席位「全局只能有一份」的占位文件。
//
// 为什么必须有：GUI 席位靠抢键鼠干活，两份控制面同时带 GUI 席位就会互相抢——
// A 刚把窗口顶到前台，B 又顶走，两边都在往同一个输入框里贴提示词，产物还会串单。
// 进程内互斥锁管不住这个，必须落到**跨进程**的公共文件上。
//
// 判定规则（宁可误拦，不可双开）：
//   - 没有占位文件 → 直接拿下
//   - 占位者 pid 还活着、**且是同一次开机**、且不是自己 → 冲突，拒绝启动（说清是谁、哪个端口）
//   - 占位者 pid 已死 / 已标记 released / **是上一轮开机的遗留** → 接管（崩溃、重启都不会把席位永久锁死）
//
// 2026-11-19 真机事故（开机自启失效）：占位文件记着上一轮的 pid，电脑重启后 Windows 把那个号
// 分给了 `svchost.exe`。`kill(pid, 0)` 对它抛 EPERM，老代码把 EPERM 当成「它还活着」，
// 于是新控制面认定席位被占，以 code=5 拒绝启动，runner 又对 code=5 直接收摊 —— 开机永远起不来。
// 两次教训写进判定里：① EPERM 不是「活着」，是「这压根不是我的进程」；② pid 会跨开机复用，
// 必须拿开机时刻当指纹，跨开机的占位一律视为遗留。
//
// 与 gui-lock 的分工：这里管「谁有权带 GUI 席位」（进程级，启动时判一次）；
// gui-lock 管「同一时刻只能有一个 GUI 任务在跑」（运行级，每次派活判）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 开机时刻（秒）。同一次开机里的两个进程算出来的值只差几秒，所以比对时留 2 分钟容差。
export function bootAtSeconds(nowMs = Date.now(), uptimeSec = os.uptime()) {
  return Math.floor((nowMs - uptimeSec * 1000) / 1000);
}

// 跨进程比 pid 是否活着。
// EPERM 一律判「不是我们的进程」：控制面永远以当前登录用户身份跑，
// 同用户自己的 node 进程 `kill(pid,0)` 不会 EPERM；会 EPERM 的只有系统进程 / 别的账户 ——
// 那更可能是重启后被复用的号，不能拿来拦自己。
export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

export function createSeatClaim({
  file, owner = 'control-plane', now = () => new Date(), isAlive = defaultIsAlive,
  bootAt = bootAtSeconds,
} = {}) {
  // 两次开机之间必然差几分钟以上；同一次开机内两次计算只差几秒。120 秒足够宽且不会误判。
  const BOOT_SKEW_SEC = 120;
  const sameBoot = (recorded) => {
    if (recorded == null) return null; // 老文件没这个字段：未知
    return Math.abs(Number(recorded) - bootAt()) <= BOOT_SKEW_SEC;
  };

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
    // 跨开机的占位一定是上一轮的遗留：哪怕那个 pid 现在被别的活进程占着，也不是「另一个我」。
    if (sameBoot(state.bootAt) === false) {
      return { held: false, alive, state, staleBoot: true };
    }
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
    // 接管时要能说清「接管了谁」，否则下次再出事没人知道上一条命是怎么没的。
    const tookOver = current.state && !current.held
      ? {
        pid: current.state.pid ?? null,
        port: current.state.port ?? null,
        reason: current.staleBoot ? 'cross-boot' : (current.released ? 'released' : 'dead'),
      }
      : null;
    if (tookOver?.reason === 'cross-boot') {
      // 顺手擦掉上一轮的残留证据文件，别让下一个人再被同一个号骗一次。
      try {
        const prevPid = Number(current.state.pid);
        if (Number.isInteger(prevPid) && prevPid > 0) fs.rmSync(file, { force: true });
      } catch { /* 清理失败不影响启动 */ }
    }
    const state = {
      owner, pid, port, configPath, released: false, bootAt: bootAt(),
      acquiredAt: now().toISOString(), ...extra,
    };
    write(state);
    return { ok: true, state, tookOver };
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
