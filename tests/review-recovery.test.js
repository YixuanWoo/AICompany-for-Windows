// 验收不能丢：review_requested 是一次性事件，被「同一张卡的僵尸 Run」让路后会永远没人审，
// 卡就停在 in_review（干完了、看板一直「待验收」）。这里锁住两条兜底：
//   ① 维护心跳给超时 run 收尸（running > maxRunHours → interrupted）；
//   ② 维护心跳给「待验收但没人被叫过」的卡补发验收事件，CEO 审完就真的 done。

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';

function cfg(workRoot, runPolicy = {}) {
  return {
    version: 1,
    company: { name: 'review-recovery', timezone: 'Asia/Shanghai' },
    workRoot,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy: { maxConcurrent: 2, cooldownSec: 0, maxRunHours: 2, ...runPolicy },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 50, reportsTo: null,
        adapter: {
          type: 'mock',
          config: { result: () => ({ type: 'review', verdict: 'pass', reason: '看过了，符合验收条件' }) },
        },
      },
      {
        id: 'worker-01', displayName: '执行席', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { result: { type: 'decision', verdict: 'done' } } },
      },
    ],
  };
}

function seedReviewTask(db, taskId, updatedAt) {
  db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, role, assignee, reviewBy, status, mode, revision, attempt, priority,
     difficulty, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    taskId, `REQ-${taskId}`, '已经干完的卡', 'execute', 'worker-01', 'ceo', 'in_review', 'delegate',
    1, 0, 'normal', 'normal', '2026-11-17T10:00:00.000Z', updatedAt,
  );
}

test('心跳补审：僵尸 Run 收尸 + 补发验收 → 卡真的到 done', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  // 3 小时前开跑、一直没结束的 Run —— 就是它把验收让路挡掉的。
  const staleIso = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  seedReviewTask(db, 'T-stuck-review', staleIso);
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
    'R-stale-1', 'T-stuck-review', 'worker-01', 'checkout', 'running', 1, 1, staleIso,
  );

  const engine = createEngine({ db, config: cfg(process.cwd()), notifier: createNotifier('noop') });
  const out = await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(out.recoveredRuns, 1, '超时 Run 要被收尸');
  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-stale-1').status, 'interrupted');
  const audit = db.prepare("SELECT newValue FROM audit WHERE action = 'run_timeout'").get();
  assert.ok(audit && /R-stale-1/.test(audit.newValue), '收尸要留痕');

  assert.ok(out.reviewRequeued >= 1, '待验收的卡要补审');
  // mock CEO 当场给 pass：卡要真的到 done，而不是再挂一次「待验收」。
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-stuck-review').status, 'done',
    '补审走完就该 done');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n, 1,
    'CEO 要真的被叫起来审一次');
});

test('补审不是无限烧额度：补满 5 次就停手并报给董事会', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedReviewTask(db, 'T-review-stuck', '2026-11-17T10:00:00.000Z');
  // 先把「已经补过 5 次」写在审计里：模拟 CEO 席位长期不可用。
  for (let i = 0; i < 5; i += 1) {
    db.prepare('INSERT INTO audit (actor, action, newValue, taskId, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      'scheduler', 'review_requeued', `第 ${i + 1} 次补审`, 'T-review-stuck', new Date().toISOString(),
    );
  }
  const engine = createEngine({ db, config: cfg(process.cwd()), notifier: createNotifier('noop') });
  const out = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(out.reviewRequeued, 0, '满 5 次就不再自动补审');
  const stuck = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_stuck'").get('T-review-stuck').n;
  assert.equal(stuck, 1, '要留一条「卡住了，请人处理」的账');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId = ? AND type = 'review_requested'").get('T-review-stuck').n, 0,
    '不再自动叫 CEO，避免无限烧额度');

  // 2026-11-22 真机事故：心跳每 60 秒跑一次，卡一直挂在 in_review，
  // 原来这两条账每分钟各记一遍（一张卡两天记了 1600 多条）。再跑几趟必须静默。
  for (let i = 0; i < 3; i += 1) await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_stuck'").get('T-review-stuck').n, 1,
    '卡住了只记一次，不许每个心跳都刷一条');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_fallback_ceo'").get('T-review-stuck').n, 0,
    '没真去补审，就不该记「转 CEO」的账');
});

test('你在用电脑让路不算补审额度：让路几次都还继续补审', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedReviewTask(db, 'T-review-yield', '2026-11-17T10:00:00.000Z');
  // 场景就是 T-faf7ddf8 真机：补审派出去了 5 次，但每次都被「你正在用键鼠」让路。
  for (let i = 0; i < 5; i += 1) {
    db.prepare('INSERT INTO audit (auditId, actor, action, newValue, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      `A-req-${i}`, 'scheduler', 'review_requeued', `第 ${i + 1} 次补审`, 'T-review-yield', new Date().toISOString(),
    );
  }
  for (let i = 0; i < 3; i += 1) {
    db.prepare('INSERT INTO audit (auditId, actor, action, newValue, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      `A-yie-${i}`, 'scheduler', 'review_yielded', `T-review-yield|ceo|user-active|你 ${i + 2} 秒前还在操作键鼠`,
      'T-review-yield', new Date().toISOString(),
    );
  }
  const engine = createEngine({ db, config: cfg(process.cwd()), notifier: createNotifier('noop') });
  const out = await engine.reconcile({ olderThanMs: 60_000 });

  // 5 次里 3 次是让路 → 真失败只有 2 次，还没到上限，必须继续补审。
  assert.ok(out.reviewRequeued >= 1, '让路不算额度，所以还要接着补审');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_stuck'").get('T-review-yield').n, 0,
    '让路不算额度，就不该判「卡住了」');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_requeued'
    AND newValue LIKE '%让路 3 次未计额度%'`).get('T-review-yield').n, 1,
    '补审记要写明让路了几次、没算额度');
});

test('让路再多也不会无声拖下去：等太久就报董事会，而且只报一次', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  // 3 小时没人审，阈值 60 分钟 → 该报人。
  seedReviewTask(db, 'T-review-longwait', new Date(Date.now() - 3 * 3600 * 1000).toISOString());
  for (let i = 0; i < 8; i += 1) {
    db.prepare('INSERT INTO audit (auditId, actor, action, newValue, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      `A-req-${i}`, 'scheduler', 'review_requeued', `第 ${i + 1} 次补审`, 'T-review-longwait', new Date().toISOString(),
    );
    db.prepare('INSERT INTO audit (auditId, actor, action, newValue, taskId, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      `A-yie-${i}`, 'scheduler', 'review_yielded', 'T-review-longwait|ceo|user-active|你在用键鼠',
      'T-review-longwait', new Date().toISOString(),
    );
  }
  const engine = createEngine({
    db,
    config: cfg(process.cwd(), { reviewEscalateMinutes: 60 }),
    notifier: createNotifier('noop'),
  });
  const out = await engine.reconcile({ olderThanMs: 60_000 });

  // 额度因为让路一直用不完，但「等太久」这道兜底必须报人，同时自动补审不因此停。
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_escalated'").get('T-review-longwait').n, 1,
    '等超过阈值要报一次董事会');
  assert.ok(out.reviewRequeued >= 1, '报人的同时，自动补审不能停');

  for (let i = 0; i < 2; i += 1) await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_escalated'").get('T-review-longwait').n, 1,
    '只报一次，不许每个心跳都刷');
});

test('手动重派验收：卡住之后还有出口，真的能审完', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedReviewTask(db, 'T-manual-review', '2026-11-17T10:00:00.000Z');
  for (let i = 0; i < 5; i += 1) {
    db.prepare('INSERT INTO audit (actor, action, newValue, taskId, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      'scheduler', 'review_requeued', `第 ${i + 1} 次补审`, 'T-manual-review', new Date().toISOString(),
    );
  }
  const engine = createEngine({ db, config: cfg(process.cwd()), notifier: createNotifier('noop') });

  const out = await engine.retryReview('T-manual-review', { reason: '董事会在看板上点了重派' });
  assert.equal(out.ok, true);
  assert.equal(out.reviewer, 'ceo');

  // 重派之后 CEO 那趟要真的跑起来并给出结论，卡才能到 done。
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-manual-review').status, 'done',
    '手动重派验收之后，卡要能真的收尾');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'review_retried' AND taskId = ?").get('T-manual-review').n, 1,
    '谁点的重派、为什么点，要留账');
});
