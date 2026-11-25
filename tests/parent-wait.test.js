// 父子交接规范（2026-11-17 真机父子互卡）：
//   现场：工程岗派了子卡给执行席，然后留在自己的会话里等下级接单 —— 可它占着的那趟会话
//   正是引擎唯一的执行槽，下级的唤醒事件只能排在它后面。等了 6 分钟，它自己判定「叫不起来」，
//   把子卡取消、改由自己实施。
//
// 这里守两条界线：
//   P1 发布者不许自己作废子卡（作废是治理动作，得由上级 / 董事会来）；
//   P2 父卡派了子卡却还占着会话干等，超时后由引擎把 run 按中断收账、把父卡置为「等子卡」，
//      让子卡真的排得上队 —— 规矩被无视时，引擎自己动手。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { nowIso } from '../src/ids.js';

const completion = (ctx, extra = {}) => ({
  schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(), ...extra,
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-parentwait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeConfig(runPolicy = {}) {
  return {
    version: 1,
    company: { name: 'parent-wait-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {},
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy,
    agents: [
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
        status: 'active', quotaDaily: 20, reportsTo: 'lead', adapter: { type: 'mock', config: {} },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function engineFor(t, runPolicy = {}) {
  const root = tmpDir(t);
  const c = { ...makeConfig(runPolicy), workRoot: root };
  for (const agent of c.agents) {
    agent.adapter.config.result = (ctx) => completion(ctx);
  }
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: c, notifier: createNotifier('web'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* 已关 */ } });
  return { engine, db, c };
}

// 造一张「父卡 + 一张还没收尾的子卡」的现场，父卡自己还挂着一趟 run。
async function parentWithOpenChild(engine, db, { parentRunStartedMinutesAgo = 0 } = {}) {
  const r = await engine.submit({ requestId: 'REQ-P', text: '把这事拆下去', mode: 'direct', addressedTo: 'lead' });
  db.prepare("UPDATE tasks SET status = 'in_progress', waitingChildren = 0, updatedAt = ? WHERE taskId = ?")
    .run(nowIso(), r.taskId);
  const child = engine.spawnChild({
    parentTaskId: r.taskId, assignerId: 'lead', assignee: 'worker-01',
    title: '实现第一部分', instructions: '按方案实现第一部分', acceptance: ['测试通过'],
  });
  db.prepare("UPDATE tasks SET status = 'todo', updatedAt = ? WHERE taskId = ?").run(nowIso(), child.taskId);
  const startedAt = new Date(Date.now() - parentRunStartedMinutesAgo * 60_000).toISOString();
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-parent', ?, 'lead', 'issue_assigned', 'running', 1, 1, ?, NULL)`).run(r.taskId, startedAt);
  return { parent: r.taskId, child: child.taskId };
}

test('P1 · 发布者不能自己把子卡作废（作废是治理动作）', async (t) => {
  const { engine, db } = engineFor(t);
  const { child } = await parentWithOpenChild(engine, db, { parentRunStartedMinutesAgo: 5 });

  const refused = engine.cancelTask(child, { reason: '下级叫不起来，我改自己干', actor: 'lead' });
  assert.equal(refused.cancelled, false, '发布者自己取消子卡必须被拒');
  assert.equal(refused.code, 'PARENT_CANNOT_CANCEL');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(child).status, 'todo',
    '被拒之后子卡必须还在队列里');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE action = 'cancel_child_rejected'`).get().n, 1,
    '被拒这件事要留账，事后才知道有人试过绕过流程');

  // 上级 / 董事会来取消是允许的：治理动作本来就该由他们做。
  const ok = engine.cancelTask(child, { reason: '方向变了', actor: 'ceo' });
  assert.equal(ok.cancelled, true);
});

test('P2 · 父卡派了子卡却占着会话干等：超时由引擎中断该 run 并置为等子卡', async (t) => {
  const { engine, db } = engineFor(t, { parentWaitMinutes: 8 });
  const { parent } = await parentWithOpenChild(engine, db, { parentRunStartedMinutesAgo: 20 });

  const out = await engine.reconcile({ olderThanMs: 0 });
  assert.equal(out.parentWaitCut, 1, '父卡占着会话超时，必须被引擎收掉');

  assert.equal(db.prepare("SELECT status FROM runs WHERE runId = 'R-parent'").get().status, 'interrupted',
    '那趟 run 要按中断收账，否则它一直占着唯一的执行槽');
  assert.equal(db.prepare('SELECT waitingChildren FROM tasks WHERE taskId = ?').get(parent).waitingChildren, 1,
    '父卡要正式置为「等子卡」，子卡收尾后才会自动汇总送审');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE action = 'parent_wait_cut'`).get().n, 1);
});

test('P3 · 没到点的父卡不动：正常跑着的会话不许被误伤', async (t) => {
  const { engine, db } = engineFor(t, { parentWaitMinutes: 8 });
  await parentWithOpenChild(engine, db, { parentRunStartedMinutesAgo: 2 });

  const out = await engine.reconcile({ olderThanMs: 0 });
  assert.equal(out.parentWaitCut, 0);
  assert.equal(db.prepare("SELECT status FROM runs WHERE runId = 'R-parent'").get().status, 'running');
});

test('P4 · 父卡有子卡没收尾：改为等子卡，不许再被重投叫起来重复派活', async (t) => {
  const { engine, db } = engineFor(t);
  const { parent } = await parentWithOpenChild(engine, db, { parentRunStartedMinutesAgo: 3 });
  // 现场形状：那一趟跑完（交活失败被判退），卡回到 todo，子卡还在排队。
  db.prepare("UPDATE runs SET status = 'blocked', finishedAt = ? WHERE runId = 'R-parent'").run(nowIso());
  db.prepare("UPDATE tasks SET status = 'todo', waitingChildren = 0, updatedAt = ? WHERE taskId = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), parent);

  const out = await engine.reconcile({ olderThanMs: 0 });
  assert.equal(db.prepare('SELECT waitingChildren FROM tasks WHERE taskId = ?').get(parent).waitingChildren, 1,
    '有子卡没收尾的父卡必须被置为「等子卡」');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'parent_marked_waiting'").get(parent).n, 1);
  assert.equal(out.requeued, 0, '父卡不该再被投一次派活事件（那会让它照原指令再拆一遍）');
});
