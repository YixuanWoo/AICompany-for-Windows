// P2-1 / P2-3：本机 bridge 客户端（拉模式）。
// 只做四件事：领卡 → 翻译成 adapter 动作 → 回写报告 → 心跳；不认任何具体产品。
// 依据：任务书 §9.1 / §9.3。断线自然退化为「任务留在控制面队列」，开机后补领。

export function createBridge({
  baseUrl, agentId, token = null, adapter, adapterConfig = {},
  fetchImpl = globalThis.fetch, pollMs = 500, maxLoops = Infinity,
}) {
  let stopped = false;
  let loops = 0;

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-bridge-token'] = token;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = {};
    try { data = await response.json(); } catch { /* 空响应保持空对象 */ }
    return { status: response.status, data };
  }

  async function pollOnce() {
    const hb = await request('POST', '/api/bridge/heartbeat', {
      agentId, meta: { kind: 'bridge', transport: 'pull' },
    });
    if (hb.status >= 400) return { online: false, done: [], error: hb.data.error };

    const inbox = await request('GET', `/api/bridge/inbox?agentId=${encodeURIComponent(agentId)}`);
    if (inbox.status >= 400) return { online: true, done: [], error: inbox.data.error };

    const done = [];
    for (const task of inbox.data.tasks ?? []) {
      const co = await request('POST', '/api/bridge/checkout', { taskId: task.taskId, agentId });
      if (co.status === 409) continue; // 别的 bridge 抢到了，按 §9.4 排队即可
      if (co.status >= 400) {
        done.push({ taskId: task.taskId, ok: false, reason: co.data.error });
        continue;
      }
      let outcome;
      try {
        outcome = await adapter.execute({
          runId: co.data.runId,
          taskId: task.taskId,
          task,
          agent: { id: agentId, isCEO: false, capabilities: ['execute'] },
          wakeReason: 'checkout',
          company: { agents: [] },
          // adapter 的命令 / 参数全部来自调用方配置，源码不写死任何产品名与本机路径。
          adapterConfig: { ...adapterConfig, ...(task.adapterConfig ?? {}) },
        });
      } catch (error) {
        // adapter 崩了也要回写失败报告，不能把任务永久锁在 lease 里。
        outcome = {
          result: {
            schema: 'aicompany.completion/v1',
            taskId: task.taskId, runId: co.data.runId, agent: agentId,
            revision: task.revision ?? 1, status: 'failed',
            reason: `adapter 失败：${String(error.message ?? error)}`,
            summary: '执行失败', artifacts: [], checksum: {},
            acceptanceResults: [], usage: { quotaUnits: 0 },
            finishedAt: new Date().toISOString(),
          },
        };
      }
      const cp = await request('POST', '/api/bridge/complete', {
        taskId: task.taskId, agentId, runId: co.data.runId,
        leaseToken: co.data.leaseToken, report: outcome?.result ?? {},
      });
      done.push({ taskId: task.taskId, ok: cp.status < 400, status: cp.status });
    }
    return { online: true, done, queued: inbox.data.count ?? 0 };
  }

  async function start(onTick) {
    while (!stopped && loops < maxLoops) {
      loops += 1;
      const tick = await pollOnce();
      if (onTick) onTick(tick);
      if (stopped || loops >= maxLoops) break;
      if (pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { loops, stopped };
  }

  return {
    request,
    pollOnce,
    start,
    stop: () => { stopped = true; },
    get loops() { return loops; },
  };
}
