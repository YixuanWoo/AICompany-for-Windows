// 事件泵「单条事件超时」：一条派发挂死（GUI 抢不到窗口 / 服务不返回），
// 不能把整条事件队列一起拖死。
//
// 2026-11-20 真机事故：CEO 单两次派发都挂着没回执 → 看门狗判死上报董事会 →
// 董事会点「通过」触发返工事件 → 事件泵却还堵在那条挂死的派发上（activePumps 里
// 那一条永不摘除），于是「点通过像没反应」，手动重派三次也没动静。
//
// 这里守两条：
//   P1 · 派发挂死时，pumpOnce 到点放泵，后面的卡照常被派出去（队列不陪葬）；
//   P2 · 放泵这件事必须留审计，事后能查清「谁把泵占住了」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { registerAdapter } from '../src/adapters.js';
import { nowIso } from '../src/ids.js';

const completion = (ctx) => ({
  schema: 'aicompany/completion/v1'.replace('/', '.'), taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(),
});

// 测试专用适配器：result 返回什么就等什么 —— 可以用来造「永远不返回的派发」。
// 挂死时返回一条永不 resolve 的 promise；正常时按适配器契约包一层（raw 会被当成 completion）。
registerAdapter('hang-test', {
  type: 'hang-test',
  testEnvironment() { return { ok: true, detail: '测试用挂死适配器' }; },
  async execute(ctx) {
    const raw = await ctx.adapterConfig.result(ctx);
    return { status: 'success', usage: { quotaUnits: 1 }, result: raw, agentId: ctx.agent.id, runId: ctx.runId };
  },
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-pump-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(root) {
  const agents = [
    {
      id: 'ceo', displayName: '总经理', isCEO: true,
      capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active', quotaDaily: 30,
      reportsTo: null, adapter: { type: 'mock', config: { result: (ctx) => (ctx.wakeReason === 'review_requested' ? { type: 'review', verdict: 'pass', reason: '可以' } : { type: 'message', text: '看过' }) } },
    },
    {
      id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 30, reportsTo: 'ceo',
      adapter: {
        type: 'hang-test',
        config: {
          result: (ctx) => (String(ctx.task.title ?? '').includes('挂死')
            ? new Promise(() => {}) // 永不返回：模拟 GUI 派发挂死
            : completion(ctx)),
        },
      },
    },
  ];
  return {
    version: 1,
    company: { name: 'pump-timeout-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {},
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'direct', defaultTarget: 'worker-01', autoAssign: false },
    // 单并发：一张卡把泵占住，后面的卡就只能排队 —— 事故现场就是这个形状。
    runPolicy: { maxConcurrent: 2 },
    agents,
    clients: ['web'], notifier: ['noop'],
    workRoot: root,
  };
}

function engineFor(t) {
  const root = tmpDir(t);
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: config(root), notifier: createNotifier('web'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* 已关 */ } });
  return { engine, db, root };
}

const waitFor = async (fn, { timeoutMs = 2000, stepMs = 50 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = fn();
    if (out) return out;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
};

test('P1 · 一条派发挂死，泵到点放行，后面的卡照常跑完', async (t) => {
  const prevEvent = process.env.AICOMPANY_PUMP_EVENT_TIMEOUT_MS;
  const prevStale = process.env.AICOMPANY_PUMP_STALE_MS;
  process.env.AICOMPANY_PUMP_EVENT_TIMEOUT_MS = '150';
  process.env.AICOMPANY_PUMP_STALE_MS = '200';
  t.after(() => {
    if (prevEvent === undefined) delete process.env.AICOMPANY_PUMP_EVENT_TIMEOUT_MS;
    else process.env.AICOMPANY_PUMP_EVENT_TIMEOUT_MS = prevEvent;
    if (prevStale === undefined) delete process.env.AICOMPANY_PUMP_STALE_MS;
    else process.env.AICOMPANY_PUMP_STALE_MS = prevStale;
  });

  const { engine, db } = engineFor(t);

  // 泵的超时计时器是 unref 的（生产里不该为一个 3 分钟的等待拖着进程不让退），
  // 测试里那条挂死的 promise 又不会自己醒，所以这里留一个心跳把事件循环撑住。
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));

  const hangTask = await engine.submit({ requestId: 'REQ-HANG', text: '这活会挂死', mode: 'direct', addressedTo: 'worker-01' });
  // 事故里最致命的一点：submit 自己也卡在泵上，接口不返回、看板转圈。
  assert.ok(hangTask.taskId, '派发挂死也不许把调用方一起卡死');

  // 等过僵尸泵阈值：这时候再来一张卡，pump() 应该能丢掉那条挂死的 entry 重新开泵。
  await new Promise((r) => setTimeout(r, 320));
  const okTask = await engine.submit({ requestId: 'REQ-OK', text: '这活正常干完', mode: 'direct', addressedTo: 'worker-01' });

  const done = await waitFor(() => {
    const row = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(okTask.taskId);
    return row?.status === 'done' ? row : null;
  });
  assert.ok(done, `挂死的那一趟不能把后面排队的卡一起憋死：`
    + `\nA=${db.prepare('SELECT status, attempt FROM tasks WHERE taskId = ?').get(hangTask.taskId).status}`
    + `\nB=${db.prepare('SELECT status, attempt FROM tasks WHERE taskId = ?').get(okTask.taskId).status}`
    + `\nruns=${JSON.stringify(db.prepare('SELECT runId, agentId, status, wakeReason, interruptedReason FROM runs').all())}`
    + `\naudit=${JSON.stringify(db.prepare('SELECT action, taskId, newValue FROM audit ORDER BY createdAt').all())}`);
  assert.notEqual(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(hangTask.taskId).status, 'done');

  const timeoutAudit = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'pump_event_timeout'").get().n;
  assert.ok(timeoutAudit >= 1, '放泵必须留审计，事后能查清谁把泵占住了');
});



