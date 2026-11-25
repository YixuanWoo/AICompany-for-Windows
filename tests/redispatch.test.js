// 手动重新派单（看板「重派」按钮 / POST /api/tasks/:id/redispatch / CLI）：
// 卡停在 in_progress、blocked 而自动补偿（补投 / 看门狗）还没到点时，人要能立刻让它再跑一趟。
//
// 这里守的几条界线，正是「重派」不能乱用的地方：
//   · 终态不给派；
//   · 还有子卡没做完不给派（事在子卡手里）；
//   · 正在跑的卡默认不给派，要打断必须显式 force（INLINE 模式下没人能真掐断那趟）；
//   · 被 force 打断的那一趟，后来要是还回来了，只留档、不许推进状态机。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { nowIso } from '../src/ids.js';

const completion = (ctx, extra = {}) => ({
  schema: 'aicompany/completion/v1'.replace('/', '.'), taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(), ...extra,
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-redispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config() {
  const agents = [
    {
      id: 'ceo', displayName: '总经理', isCEO: true,
      capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active', quotaDaily: 30,
      reportsTo: null, adapter: { type: 'mock', config: {} },
    },
    {
      id: 'lead', displayName: '技术主管', isCEO: false,
      capabilities: ['plan', 'review', 'delegate', 'execute'], status: 'active', quotaDaily: 20,
      reportsTo: 'ceo', adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'lead',
      adapter: { type: 'mock', config: {} },
    },
  ];
  return {
    version: 1,
    company: { name: 'redispatch-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {},
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy: {},
    agents,
    clients: ['web'], notifier: ['noop'],
  };
}

// worker-01 第一趟「临时条件没派出去」（deferred），之后每次都正常交活。
function engineFor(t, { workerResult = null } = {}) {
  const root = tmpDir(t);
  const c = { ...config(), workRoot: root };
  let calls = 0;
  for (const agent of c.agents) {
    if (agent.id === 'worker-01') {
      agent.adapter.config.result = workerResult ?? ((ctx) => {
        calls += 1;
        if (calls === 1) {
          return { status: 'deferred', sessionParams: { deferredReason: 'user-active' } };
        }
        return completion(ctx);
      });
    }
    if (agent.id === 'lead') agent.adapter.config.result = (ctx) => completion(ctx);
    if (agent.id === 'ceo') {
      agent.adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
        ? { type: 'review', verdict: 'pass', reason: '可以' }
        : { type: 'message', text: '看过' });
    }
  }
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: c, notifier: createNotifier('web'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* 已关 */ } });
  return { engine, db, c };
}

const count = (db, taskId, action) => db.prepare('SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = ?')
  .get(taskId, action).n;

test('R1 · 卡停在 in_progress 却没有 Run：重派把它推回队列，并真的跑完', async (t) => {
  const { engine, db } = engineFor(t);
  const r = await engine.submit({ requestId: 'REQ-R1', text: '把这活干了', mode: 'direct', addressedTo: 'worker-01' });
  // 第一趟是 deferred → 卡退回 todo，没有 Run 在跑。
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');
  // 造出真机上见过的形状：配额刚好触顶那一下，卡落在 in_progress，但没有任何 Run 在跑。
  db.prepare("UPDATE tasks SET status = 'in_progress', updatedAt = ? WHERE taskId = ?").run(nowIso(), r.taskId);

  const out = await engine.redispatchTask(r.taskId, { reason: '看板手动重派', actor: 'board' });
  assert.equal(out.ok, true, '停着的卡必须能被重派');
  assert.equal(out.from, 'in_progress');
  assert.equal(count(db, r.taskId, 'manual_redispatch'), 1, '重派这件事要留账，不能是暗箱操作');
  assert.equal(db.prepare("SELECT attempt FROM tasks WHERE taskId = ?").get(r.taskId).attempt, 0,
    '重派要重置失败计数，否则下一次失败立刻被判死');

  const runs = db.prepare('SELECT status FROM runs WHERE taskId = ?').all(r.taskId);
  assert.equal(runs.filter((x) => x.status === 'success').length, 1, '重派之后必须真的跑出一趟成功的 Run');
  const final = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status;
  assert.ok(['in_review', 'done'].includes(final), `重派后卡应推进到验收/终态，实际 ${final}`);
});

test('R2 · 已经做完的卡不给重派', async (t) => {
  const { engine, db } = engineFor(t);
  const r = await engine.submit({ requestId: 'REQ-R2', text: '做完这活', mode: 'direct', addressedTo: 'worker-01' });
  await engine.redispatchTask(r.taskId, { reason: '先把它跑完' });
  // 直接把它推到终态，再试一次：必须被拒（终态就是终态）。
  db.prepare("UPDATE tasks SET status = 'done', updatedAt = ? WHERE taskId = ?").run(nowIso(), r.taskId);
  const refused = await engine.redispatchTask(r.taskId, { reason: '再派一次', force: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TASK_TERMINAL');
});

test('R3 · 真有一趟 Run 在跑：默认拒绝，force 才打断并重派', async (t) => {
  const { engine, db } = engineFor(t);
  const r = await engine.submit({ requestId: 'REQ-R3', text: '这活要跑一阵', mode: 'direct', addressedTo: 'worker-01' });
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE taskId = ?").run(r.taskId);
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES (?, ?, ?, ?, 'running', 1, 1, ?, NULL)`).run('R-fakehung', r.taskId, 'worker-01', 'issue_assigned', nowIso());

  const refused = await engine.redispatchTask(r.taskId, { reason: '看板手动重派' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'RUNNING');
  assert.match(refused.message, /R-fakehung/, '拒绝时必须告诉他卡在哪一趟上');

  const forced = await engine.redispatchTask(r.taskId, { reason: '确认卡死了', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.interruptedRun, 'R-fakehung');
  assert.equal(db.prepare("SELECT status FROM runs WHERE runId = 'R-fakehung'").get().status, 'interrupted');
  assert.equal(count(db, r.taskId, 'run_interrupted_by_redispatch'), 1);
  assert.equal(count(db, r.taskId, 'manual_redispatch'), 1, '真派下去的那一次要留账（被拒的那次不记账）');
});

test('R4 · 连点两下重派：已经有一条没消费的派活事件时不再叠一条', async (t) => {
  const { engine, db } = engineFor(t);
  const r = await engine.submit({ requestId: 'REQ-R4', text: '这活先别跑', mode: 'direct', addressedTo: 'worker-01' });
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE taskId = ?").run(r.taskId);
  // 模拟「已经排着一条还没被消费的派活事件」（泵正忙着别的卡时的真实形状）。
  db.prepare(`INSERT INTO events (eventId, type, agentId, taskId, payloadJson, processed, createdAt)
    VALUES (?, 'issue_assigned', ?, ?, ?, 0, ?)`)
    .run('E-pending-redispatch', 'worker-01', r.taskId, JSON.stringify({ wakeReason: 'issue_assigned' }), nowIso());

  const out = await engine.redispatchTask(r.taskId, { reason: '连点第一下' });
  assert.equal(out.ok, true);
  assert.equal(out.deduped, true, '还有一条待消费的派活事件，就不该再叠一条');
  // 现场那条事件会被泵消费掉（说明它被用上了），而不是被我们新叠的那条顶掉。
  const mine = db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId = ? AND payloadJson LIKE '%manual_redispatch%'")
    .get(r.taskId).n;
  assert.equal(mine, 0, '重派不该在生产队列里多塞一条重复的派活事件');
});
