// 重启收尸：进程死了，库里还挂着 status='running' 的 run 会把两个闸一起占死 ——
// ① runPolicy.maxConcurrent 的全局并发名额；② 「这台席位正忙」的判断（新卡因此永远派不下去）。
// 收尸只改 run 的账，不动任务卡状态：卡该怎么等还怎么等，由 reconcile 去补投。

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';

function cfg(workRoot) {
  return {
    version: 1,
    company: { name: 'orphan-run', timezone: 'Asia/Shanghai' },
    workRoot,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 50, reportsTo: null,
        adapter: { type: 'mock', config: { result: { type: 'decision', verdict: 'done' } } },
      },
      {
        id: 'worker-01', displayName: '执行席', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { result: { type: 'decision', verdict: 'done' } } },
      },
    ],
  };
}

function seedTask(db, taskId) {
  db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, role, assignee, status, mode, revision, attempt, priority,
     difficulty, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    taskId, `REQ-${taskId}`, '测试卡', 'execute', 'worker-01', 'in_review', 'delegate', 1, 0,
    'normal', 'normal', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z',
  );
}

test('启动收尸：上次进程留下的 running run 记为 interrupted，并释放并发名额', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  seedTask(db, 'T-orphan-1');
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
    'R-orphan-1', 'T-orphan-1', 'worker-01', 'assigned', 'running', 1, 1, '2026-11-17T10:34:39.704Z',
  );

  const engine = createEngine({ db, config: cfg(process.cwd()), notifier: createNotifier('noop') });
  const cleaned = engine.recoverOrphanRuns();
  assert.equal(cleaned, 1, '要收掉那条僵尸 run');

  const run = db.prepare('SELECT status, finishedAt FROM runs WHERE runId = ?').get('R-orphan-1');
  assert.equal(run.status, 'interrupted', '僵尸 run 要改成 interrupted，不能继续算 running');
  assert.ok(run.finishedAt, '要补 finishedAt，否则统计里它还是一条「没结束」的 run');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n, 0,
    '收完不能再有 running，否则并发闸与「席位正忙」判断都被占死');
  // 任务卡状态不动：卡该怎么等还怎么等。
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-orphan-1').status, 'in_review');
  // 要留审计，事后能查到「这条是被重启收的」，而不是被当成失败去追责。
  const audit = db.prepare("SELECT newValue FROM audit WHERE action = 'run_orphaned'").get();
  assert.ok(audit, '收尸要留痕');
  assert.match(audit.newValue, /R-orphan-1/);

  // 再跑一次是幂等的：没有 running 就什么都不做。
  assert.equal(engine.recoverOrphanRuns(), 0);
});
