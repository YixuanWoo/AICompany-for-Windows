// 总经理（外部 agent，按量计费那个）的会话复用。
//
// 为什么要有这个：以前每次唤醒都按「卡号-轮次」新建一个会话，等于每一轮都把系统提示词、
// 名册、项目清单从头喂一遍，前缀缓存一次都命中不了。按量计费的席位，缓存命中价差很大。
// 现在改成：**所有工作共用一个会话**，前缀稳定 → 命中缓存；会话变脏/太长时再换。
//
// 一条硬约束：同一个会话不能并发跑两轮。插件按 sessionId 反查任务，两个任务同时挂一个会话会串台
// （后投放的会顶掉前一个的文本收集）。所以这里带一把按 sessionId 的进程内锁，串行投放。
//
// 状态存 <workRoot>/sessions/<agentId>.json：人可以打开看，删掉就等于「下次重开一个」。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SESSION_POLICY = {
  reuse: true, // false = 回到旧行为（每轮新会话），留给排查用
  warnTurns: 30, // 到这个轮次提醒董事会「该考虑换一个了」
  maxTurns: 60, // 到这个轮次自动换新（不换会越跑越贵，也让上下文越来越脏）
};

const locks = new Map();

function nowIso() {
  return new Date().toISOString();
}

export function sessionsDir(workRoot) {
  return path.join(workRoot ?? '.', 'sessions');
}

export function sessionPath(workRoot, agentId) {
  return path.join(sessionsDir(workRoot), `${String(agentId ?? 'ceo').replace(/[^\w.-]/g, '_')}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

/** 会话 id：人和日志里都认得出「谁的、什么时候开的」。插件会再套一层自己的前缀。 */
export function newSessionId(agentId = 'ceo') {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${String(agentId).replace(/[^\w.-]/g, '_')}-${stamp}-${rand}`;
}

export function readCeoSession(workRoot, agentId) {
  return readJson(sessionPath(workRoot, agentId));
}

/**
 * 拿当前会话；没有（或要求换新）就开一个。
 * 换新会保留上一段的摘要（轮次 / 起止时间 / 为什么换），方便回看「这段聊了多久」。
 */
export function ensureCeoSession(workRoot, agentId, policy = {}) {
  const p = { ...DEFAULT_SESSION_POLICY, ...policy };
  const file = sessionPath(workRoot, agentId);
  const cur = readCeoSession(workRoot, agentId);
  if (p.reuse !== false && cur?.sessionId) {
    if (Number(cur.turns ?? 0) < Number(p.maxTurns)) return cur;
    return rotateCeoSession(workRoot, agentId, {
      reason: `轮次到上限（${cur.turns} ≥ ${p.maxTurns}），自动换新`,
      actor: 'control-plane',
    });
  }
  return rotateCeoSession(workRoot, agentId, {
    reason: cur?.sessionId ? '已关闭复用（policy.reuse=false）' : '首次开会话',
    actor: 'control-plane',
  });
}

export function rotateCeoSession(workRoot, agentId, { reason = '手动新建', actor = 'board' } = {}) {
  const file = sessionPath(workRoot, agentId);
  const prev = readCeoSession(workRoot, agentId);
  const state = {
    schema: 'aicompany.ceo-session/v1',
    agentId,
    sessionId: newSessionId(agentId),
    startedAt: nowIso(),
    turns: 0,
    lastUsedAt: null,
    lastTaskId: null,
    // 上一段留个尾巴：换会话不等于抹掉历史，只是不再往那个上下文里追加。
    previous: prev?.sessionId
      ? {
        sessionId: prev.sessionId,
        startedAt: prev.startedAt ?? null,
        closedAt: nowIso(),
        turns: prev.turns ?? 0,
        reason,
        actor,
      }
      : null,
    warnAts: [],
  };
  return writeJson(file, state);
}

/** 一轮跑完记一次账。返回最新状态（含轮次，供引擎判断要不要提醒）。 */
export function recordSessionTurn(workRoot, agentId, { taskId = null, at = nowIso() } = {}) {
  const file = sessionPath(workRoot, agentId);
  const cur = readCeoSession(workRoot, agentId);
  if (!cur?.sessionId) return null;
  const next = {
    ...cur,
    turns: Number(cur.turns ?? 0) + 1,
    lastUsedAt: at,
    lastTaskId: taskId,
  };
  return writeJson(file, next);
}

/** 把「已在第 N 轮提醒过」记在会话上，避免每次唤醒都弹一遍。 */
export function markSessionWarned(workRoot, agentId, turns) {
  const file = sessionPath(workRoot, agentId);
  const cur = readCeoSession(workRoot, agentId);
  if (!cur?.sessionId) return null;
  const warnAts = Array.isArray(cur.warnAts) ? cur.warnAts : [];
  return writeJson(file, { ...cur, warnAts: [...new Set([...warnAts, Number(turns)])].slice(-20) });
}

/** 给看板和通知用的人话摘要。 */
export function describeCeoSession(state) {
  if (!state?.sessionId) return { exists: false, text: '还没开过会话（下一轮会自动开一个）' };
  // 会话 id 形如 ceo-202611162012-bqrh：给人看的是「时间+随机」，前缀是席位名，不必重复。
  const parts = String(state.sessionId).split('-');
  const short = parts.length >= 2 ? parts.slice(-2).join('-') : String(state.sessionId);
  const started = state.startedAt ? new Date(state.startedAt) : null;
  const hours = started ? Math.max(0, Math.round((Date.now() - started.getTime()) / 36e5)) : null;
  return {
    exists: true,
    sessionId: state.sessionId,
    short,
    turns: Number(state.turns ?? 0),
    startedAt: state.startedAt,
    lastUsedAt: state.lastUsedAt,
    lastTaskId: state.lastTaskId,
    ageHours: hours,
    previous: state.previous ?? null,
    text: `会话 ${short}｜已 ${Number(state.turns ?? 0)} 轮${hours === null ? '' : `｜开了 ${hours} 小时`}`,
  };
}

/**
 * 同一会话串行投放：上一轮没结束，下一轮排队等。
 * 这不是性能优化，是正确性要求——一个会话并发跑两轮，结果会串台。
 */
export function withSessionLock(key, fn) {
  const name = String(key ?? 'ceo');
  const prev = locks.get(name) ?? Promise.resolve();
  // 上一轮失败也要放行：否则一次异常就把这个会话永久堵死。
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => {}, () => {});
  locks.set(name, tail);
  tail.then(() => { if (locks.get(name) === tail) locks.delete(name); });
  return run;
}
