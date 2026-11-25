// 2026-11-25 真机事故回归（T-82f1f5ce）：
//   同一张卡被连续派了三趟 CLI，三倍 token，活还卡在同一个「等人拍板」上。
// 这里钉住三条底线，谁改坏了就红：
//   A1 同一张卡已有 Run 在跑时，再来派单事件必须让路（不产生第二趟）
//   A2 blocked 卡（被挡住 / 等人决策）不许被自动唤醒派活
//   A3 变更请求中的「等人拍板」这条路，卡最终会停下，不再被自动重投
// 全用 mock 席位，零外部依赖、不抢键鼠、不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-nowake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function company(root) {
  return {
    version: 1,
    company: { name: 'nowake-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active',
        quotaDaily: 99, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '通过' }
              : { type: 'task-create', summary: '派一张卡', tasks: [{ title: '出一份 PDF', assignee: 'worker-01' }] }),
          },
        },
      },
      {
        id: 'worker-01', displayName: '执行席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 99, reportsTo: 'ceo',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, 'ok', 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: '完成', artifacts: ['output/note.md'],
                checksum: { 'output/note.md': sha256File(file) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1 },
                finishedAt: new Date().toISOString(),
              };
            },
          },
        },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: company(root), notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine };
}

const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };

async function oneTask(t) {
  const { root, db, engine } = setup(t);
  await engine.submit({ text: '出一份 PDF', mode: 'delegate' });
  await pumpAll(engine);
  const task = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(task, '应该拆出一张子卡');
  return { root, db, engine, taskId: task.taskId };
}

function seedRunning(db, taskId, runId) {
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt)
    VALUES (?, ?, 'worker-01', 'test', 'running', 1, 1, ?)`).run(runId, taskId, new Date().toISOString());
}

function seedAssignEvent(db, taskId, key) {
  db.prepare(`INSERT INTO events (eventId, type, taskId, agentId, payloadJson, dedupeKey, processed, createdAt)
    VALUES (?, 'issue_assigned', ?, 'worker-01', '{"wakeReason":"issue_assigned"}', ?, 0, ?)`)
    .run(`E-${key}`, taskId, key, new Date().toISOString());
}

test('A1 · 同一张卡已有 Run 在跑：再派一次必须让路，不会冒出第二趟', async (t) => {
  const { db, engine, taskId } = await oneTask(t);
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE taskId = ?").run(taskId);
  seedRunning(db, taskId, 'R-dup0001');
  seedAssignEvent(db, taskId, `dup-${taskId}`);

  await pumpAll(engine);

  const running = db.prepare("SELECT runId FROM runs WHERE taskId = ? AND status = 'running'").all(taskId);
  assert.equal(running.length, 1, '同一张卡只允许一条 Run 在跑');
  assert.equal(running[0].runId, 'R-dup0001', '后来那条事件不许抢跑');
  const deferred = db.prepare("SELECT * FROM audit WHERE action = 'wake_deferred' AND taskId = ?").get(taskId);
  assert.ok(deferred, '让路要留账：wake_deferred');
});

test('A2 · blocked 卡不许被自动唤醒派活（等人决策的卡不该被事件叫起来重做）', async (t) => {
  const { db, engine, taskId } = await oneTask(t);
  db.prepare("UPDATE tasks SET status = 'blocked', humanWait = 1 WHERE taskId = ?").run(taskId);
  const before = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE taskId = ?').get(taskId).n;
  seedAssignEvent(db, taskId, `blk-${taskId}`);

  await pumpAll(engine);

  const after = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE taskId = ?').get(taskId).n;
  assert.equal(after, before, 'blocked 卡不该再多跑一趟');
  const rejected = db.prepare("SELECT * FROM audit WHERE action = 'wake_rejected' AND taskId = ?").get(taskId);
  assert.ok(rejected, '拒绝要留账：wake_rejected');
  assert.match(String(rejected.newValue), /blocked/, '拒绝原因要写明 blocked');
});

test('A3 · 变更请求后卡会停下来，维护心跳不会把它再投一遍', async (t) => {
  const { db, engine, taskId } = await oneTask(t);
  // 模拟席位交了「要人拍板」的变更请求后，引擎把卡停在等人状态
  db.prepare("UPDATE tasks SET status = 'blocked', humanWait = 1 WHERE taskId = ?").run(taskId);
  const runsBefore = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE taskId = ?').get(taskId).n;
  await engine.reconcile({ olderThanMs: 30_000 });
  await pumpAll(engine);
  const runsAfter = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE taskId = ?').get(taskId).n;
  assert.equal(runsAfter, runsBefore, '维护心跳只扫 todo/in_progress，blocked 卡不该被补投');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId).status, 'blocked');
});
