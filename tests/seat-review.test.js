// 验收归属（2026-11-17 董事会反馈）：中层派的活，验收人默认是中层。
//
// 现场问题：子卡交活后只写一条 review_queued 就撒手 —— 拉模式席位不会被叫醒，
// 而心跳补审一分钟后又把卡塞给了 CEO。结果是「中层名义上是审查人，实际从没审过」，
// CEO 的额度却被代审吃掉。
//
// 这里锁住五条：
//   S1 中层派的卡，验收请求要发给中层，不是 CEO；
//   S2 中层给出 verdict=pass → 卡真的到 done，账记在中层头上；
//   S3 中层跑完却没给结论 → 不替它判，卡留在待验收（心跳继续兜底）；
//   S4 中层超时仍未审 → 才转 CEO，并留一条 review_fallback_ceo 的账；
//   S5 人审的卡不许补审给 CEO（否则人还没拍板，卡已经被判过）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';

const completion = (ctx, extra = {}) => ({
  schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: new Date().toISOString(), ...extra,
});

function cfg({ leadResult, ceoResult, runPolicy } = {}) {
  return {
    version: 1,
    company: { name: 'seat-review', timezone: 'Asia/Shanghai' },
    workRoot: process.cwd(),
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy: { maxConcurrent: 2, cooldownSec: 0, maxRunHours: 2, seatReviewFallbackMinutes: 20, ...runPolicy },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 50, reportsTo: null,
        adapter: {
          type: 'mock',
          config: { result: ceoResult ?? (() => ({ type: 'review', verdict: 'pass', reason: '看过，符合条件' })) },
        },
      },
      {
        id: 'lead', displayName: '技术主管', isCEO: false,
        capabilities: ['plan', 'review', 'delegate', 'execute'], status: 'active',
        quotaDaily: 50, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { result: leadResult ?? ((ctx) => completion(ctx)) } },
      },
      {
        id: 'worker-01', displayName: '执行席', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'lead',
        adapter: { type: 'mock', config: { result: (ctx) => completion(ctx) } },
      },
    ],
  };
}

// 造一张「中层派的、已经交上来的卡」：状态 in_review，发布者 lead。
function seedCard(db, {
  taskId = 'T-child', assignee = 'worker-01', assignerId = 'lead',
  reviewBy = null, updatedAt = new Date().toISOString(),
} = {}) {
  db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, role, assignee, assignerId, reviewBy, status, mode, assignedBy,
     revision, attempt, priority, difficulty, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'in_review', 'delegate', 'seat', 1, 0, 'normal', 'normal', ?, ?)`)
    .run(taskId, `REQ-${taskId}`, '把写盘收成一个原子入口', 'execute',
      assignee, assignerId, reviewBy, updatedAt, updatedAt);
  db.prepare('INSERT INTO task_payload (taskId, revision, instructions, acceptanceJson) VALUES (?, ?, ?, ?)')
    .run(taskId, 1, '把写盘收成唯一入口，别动接口', '["写入成功即可重放"]');
}

function engineFor(t, overrides = {}) {
  const db = openDb(':memory:');
  const c = cfg(overrides);
  const engine = createEngine({ db, config: c, notifier: createNotifier('noop') });
  t.after(() => { try { db.close(); } catch { /* 已关 */ } });
  return { engine, db };
}

const audits = (db, action) => db.prepare('SELECT * FROM audit WHERE action = ? ORDER BY rowid').all(action);

test('S1/S2 · 中层派的卡：验收请求发给中层，它判过才算收账', async (t) => {
  const { engine, db } = engineFor(t, {
    leadResult: (ctx) => ({ ...completion(ctx), verdict: 'pass' }),
  });
  seedCard(db, {});
  // 一分钟前交的活：够触发补审，但还没超兜底时间。
  db.prepare("UPDATE tasks SET updatedAt = ? WHERE taskId = 'T-child'")
    .run(new Date(Date.now() - 90_000).toISOString());

  const out = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(out.reviewRequeued, 1, '待验收的卡要补审');

  const queued = audits(db, 'review_requeued')[0];
  assert.match(queued.newValue, /lead/, '补审要发给中层，不是一律发给 CEO');
  const fallback = audits(db, 'review_fallback_ceo');
  assert.equal(fallback.length, 0, '中层还在兜底时间内，不该抢给 CEO');

  // 中层真的被叫起来审了一趟（不是 CEO 代审）。
  const leadRun = db.prepare("SELECT * FROM runs WHERE agentId = 'lead' AND wakeReason = 'review_requested'").get();
  assert.ok(leadRun, '中层要被叫醒来审这张卡');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo'").get().n, 0,
    '这一轮 CEO 一次都不该跑（代审就是这么把钱烧掉的）');

  // 结论记在中层头上，卡到 done。
  const passed = audits(db, 'review_passed');
  assert.equal(passed.length, 1);
  assert.equal(passed[0].actor, 'lead', '谁的结论谁是账上的人');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE taskId = 'T-child'").get().status, 'done');
});

test('S3 · 中层审完没给结论：不替它判，卡留在待验收等下一次兜底', async (t) => {
  const { engine, db } = engineFor(t, { leadResult: (ctx) => completion(ctx) });
  seedCard(db, {});
  db.prepare("UPDATE tasks SET updatedAt = ? WHERE taskId = 'T-child'")
    .run(new Date(Date.now() - 90_000).toISOString());

  await engine.reconcile({ olderThanMs: 60_000 });

  const noVerdict = audits(db, 'seat_review_no_verdict');
  assert.equal(noVerdict.length, 1, '跑完没结论要留账');
  assert.equal(noVerdict[0].actor, 'lead');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE taskId = 'T-child'").get().status, 'in_review',
    '没有结论就不许自动通过（谁审谁负责）');
  assert.equal(audits(db, 'review_passed').length, 0);
});

test('S4 · 中层超时还没审：才转 CEO 兜底，并留一条转交的账', async (t) => {
  const { engine, db } = engineFor(t, { runPolicy: { seatReviewFallbackMinutes: 20 } });
  // 30 分钟前交的活 —— 中层早该审完了。
  seedCard(db, { updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });

  const out = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(out.reviewRequeued, 1);

  const fallback = audits(db, 'review_fallback_ceo');
  assert.equal(fallback.length, 1, '超时才转 CEO，而且要看得见');
  assert.match(fallback[0].newValue, /lead/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'lead'").get().n, 0,
    '超时之后不必再把中层叫起来跑一趟');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE taskId = 'T-child'").get().status, 'done',
    'CEO 兜底审过就收账');
});

test('S5 · 人审的卡不许任何 agent 代审（审批单已经出了）', async (t) => {
  const { engine, db } = engineFor(t, {});
  seedCard(db, { taskId: 'T-human', reviewBy: 'human', updatedAt: new Date(Date.now() - 60 * 60_000).toISOString() });

  const out = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId = 'T-human' AND type = 'review_requested'").get().n, 0,
    '人审的卡不许补审给 agent');
  assert.equal(out.reviewRequeued, 0);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE taskId = 'T-human'").get().status, 'in_review',
    '卡要停在那儿等人拍板');
});

test('S6 · 中层打回：意见原样带到执行人，卡不许直接算完', async (t) => {
  const { engine, db } = engineFor(t, {
    leadResult: (ctx) => ({ ...completion(ctx), verdict: 'reject', reason: '失败分支没测，补一条重放断言' }),
  });
  seedCard(db, {});
  db.prepare("UPDATE tasks SET updatedAt = ? WHERE taskId = 'T-child'")
    .run(new Date(Date.now() - 90_000).toISOString());

  await engine.reconcile({ olderThanMs: 60_000 });

  const rejected = audits(db, 'review_rejected');
  assert.equal(rejected.length >= 1, true, '中层打回要留账');
  assert.equal(rejected[0].actor, 'lead');
  assert.match(rejected[0].newValue, /失败分支没测/, '打回理由不能丢：执行人只看这一句');
  assert.equal(audits(db, 'review_passed').length, 0);
  assert.notEqual(db.prepare("SELECT status FROM tasks WHERE taskId = 'T-child'").get().status, 'done');
});
