// 席位（人/外部 agent）自助领取与回写 —— 复用 P2 的 bridge 协议，不另造一套。
//
// 为什么需要它：有些席位的「担任者」不是一个能被控制面直调的进程，而是「人叫才醒」的交互式 agent。
// 控制面在其离线时派活只会白烧一次 Run，所以这类席位配成 `dispatch: pull`：卡留在 todo，由它自己来 checkout 领走。
//
// 这里只做四件事：心跳 / 看队列 / 领卡（拿 lease）/ 交报告（带 lease）。
// 干活的人是谁、用什么工具，本模块不关心 —— 它只保证「领了不会重复领、交了不会被判过期」。
//
// 复用点：HTTP 客户端直接借 bridge.js 的 request（同一套端点、同一套 token 规则）。

import fs from 'node:fs';
import path from 'node:path';

import { createBridge } from './bridge.js';
import { listOutputFiles } from './deliver.js';

/** 手上那张卡落在哪：交互式席位会被反复叫醒，必须有个地方记住「我还没交」。 */
export function handoffPath(workRoot, agentId) {
  return path.join(workRoot, 'seats', agentId, 'current.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function createSeat({
  baseUrl = 'http://127.0.0.1:3100',
  agentId,
  token = null,
  fetchImpl = globalThis.fetch,
  workRoot = null,
} = {}) {
  if (!agentId) throw new Error('席位必须有 agentId（= 岗位 id）');
  // 只借它的 request：同一套 baseUrl / token / JSON 解析，不重复实现协议。
  const client = createBridge({ baseUrl, agentId, token, fetchImpl });

  async function call(method, urlPath, body) {
    const res = await client.request(method, urlPath, body);
    if (res.status >= 400) {
      const error = new Error(res.data?.error ?? `HTTP ${res.status}`);
      error.status = res.status;
      error.data = res.data;
      throw error;
    }
    return res.data;
  }

  async function heartbeat(meta = {}) {
    return call('POST', '/api/bridge/heartbeat', { agentId, meta: { kind: 'seat', ...meta } });
  }

  async function status() {
    const data = await call('GET', '/api/bridge/status');
    const mine = (data.bridges ?? []).find((b) => b.agentId === agentId) ?? null;
    const queuedForMe = await inbox().catch(() => ({ tasks: [] }));
    return {
      ...data,
      me: mine,
      myQueued: queuedForMe.tasks?.length ?? 0,
    };
  }

  async function inbox() {
    return call('GET', `/api/bridge/inbox?agentId=${encodeURIComponent(agentId)}`);
  }

  /** 领卡：不给 taskId 就取队列里最早的一张。抢到了就把「手上有什么」落盘。 */
  async function claim({ taskId = null, ttlSec = 3600 } = {}) {
    // 手上还压着一张没交，就不许再领：两张同时占着一双手，必然漏交一张。
    // 租约已经过期的除外 —— 那种「手里那张」实际已经作废，不该把人卡死。
    const held = holding();
    if (held && Date.parse(held.leaseExpiresAt ?? 0) > Date.now()) {
      return {
        ok: false,
        reason: `手上还有一张没交：${held.taskId}（${held.title}）；先交活或等它过期`,
        holding: held,
      };
    }
    const box = await inbox();
    const target = taskId
      ? (box.tasks ?? []).find((t) => t.taskId === taskId)
      : (box.tasks ?? [])[0];
    if (!target) {
      return { ok: false, reason: taskId ? `队列里没有 ${taskId}` : '队列里没有待领的卡', queued: box.tasks?.length ?? 0 };
    }
    const out = await call('POST', '/api/bridge/checkout', {
      taskId: target.taskId, agentId, ttlSec,
    });
    const snapshot = {
      agentId, taskId: target.taskId, title: target.title, project: target.project ?? null,
      revision: target.revision ?? 1, runId: out.runId, leaseToken: out.leaseToken,
      leaseExpiresAt: out.leaseExpiresAt, claimedAt: new Date().toISOString(),
      instructions: target.instructions ?? null, acceptance: target.acceptance ?? [],
    };
    if (workRoot) writeJson(handoffPath(workRoot, agentId), snapshot);
    return { ok: true, ...snapshot, queuedLeft: Math.max(0, (box.tasks?.length ?? 1) - 1) };
  }

  /** 手上那张卡（跨会话可查：被重新叫醒时先看这个，别重复领）。 */
  function holding() {
    if (!workRoot) return null;
    return readJson(handoffPath(workRoot, agentId));
  }

  async function renew({ taskId, leaseToken, ttlSec = 3600 } = {}) {
    const held = holding();
    const id = taskId ?? held?.taskId;
    const lease = leaseToken ?? held?.leaseToken;
    if (!id || !lease) return { ok: false, reason: '没有在手任务，也没有给 taskId + leaseToken' };
    const out = await call('POST', '/api/bridge/renew', { taskId: id, leaseToken: lease, ttlSec });
    const fresh = readJson(handoffPath(workRoot, agentId));
    if (fresh && fresh.taskId === id && out.leaseExpiresAt) {
      writeJson(handoffPath(workRoot, agentId), { ...fresh, leaseExpiresAt: out.leaseExpiresAt });
    }
    return out;
  }

  /** 产物清单：与控制面同一口径（相对 output/ 的路径，带 output/ 前缀）。 */
  function artifactsOf(taskId) {
    if (!workRoot) return [];
    return listOutputFiles(workRoot, taskId).map((f) => `output/${f.name}`);
  }

  async function complete({
    taskId, leaseToken, runId, status = 'success', summary,
    artifacts = null, acceptanceResults = [], usage = {}, reason,
  } = {}) {
    const held = holding();
    const id = taskId ?? held?.taskId;
    const lease = leaseToken ?? held?.leaseToken;
    const run = runId ?? held?.runId;
    if (!id || !lease || !run) {
      return { ok: false, reason: '没有在手任务，也没有给 taskId + leaseToken + runId' };
    }
    if (status === 'success' && !String(summary ?? '').trim()) {
      return { ok: false, reason: '交活必须写 summary：一句话说清干了什么，验收的人只看这个' };
    }
    const report = {
      schema: 'aicompany.completion/v1',
      taskId: id, runId: run, agent: agentId,
      revision: held?.revision ?? 1,
      status,
      summary: String(summary ?? '').slice(0, 4000),
      artifacts: artifacts ?? artifactsOf(id),
      checksum: {},
      acceptanceResults,
      usage,
      ...(reason ? { reason: String(reason).slice(0, 1000) } : {}),
      finishedAt: new Date().toISOString(),
    };
    const out = await call('POST', '/api/bridge/complete', {
      taskId: id, agentId, runId: run, leaseToken: lease, report,
    });
    // 交完就清掉「手上有什么」，避免下次被叫醒以为自己还欠一张。
    if (workRoot) {
      try { fs.rmSync(handoffPath(workRoot, agentId), { force: true }); } catch { /* 已经没了就没事 */ }
    }
    return { ok: true, ...out, report };
  }

  async function progress(note) {
    const held = holding();
    if (!held) return { ok: false, reason: '没有在手任务' };
    return call('POST', '/api/bridge/progress', {
      taskId: held.taskId, agentId, leaseToken: held.leaseToken, note,
    });
  }

  return { agentId, heartbeat, status, inbox, claim, holding, renew, complete, progress, artifactsOf, request: call };
}
