// 卡间依赖：CEO 一次拆多张卡时，可以写「第 2 张等第 1 张」。
//   ① 有前置的卡只建不派：库里在、但一个 issue_assigned 事件都不给
//   ② 前置 done 后自动放行，下游接着跑完
//   ③ 前置被取消 → 下游永远不放行（不能假装依赖满足了）
//   ④ 重启 / 事件丢了 → 维护心跳兜底补投
//   ⑤ 不写 after 的老行为不变：多张卡直接并行
// 全部用 mock 席位，零外部依赖、不抢键鼠、不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// hold=true 时执行席位一律「抢不到前台」（deferred），用来把链停在半路观察。
function company(root, { tasks, hold = { value: true } } = {}) {
  return {
    version: 1,
    company: { name: 'deps-company', timezone: 'Asia/Shanghai' },
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
              : { type: 'task-create', summary: '按依赖顺序推进', tasks }),
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
              if (hold.value) return { status: 'deferred', sessionParams: { deferredReason: 'user-active' } };
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, `done:${ctx.task.title}`, 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: `完成：${ctx.task.title}`,
                artifacts: ['output/note.md'],
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

function setup(t, tasks, holdRef = { value: true }) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const cfg = company(root, { tasks, hold: holdRef });
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine, hold: holdRef };
}

const childrenOf = (db, parentId) => db.prepare('SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY rowid').all(parentId);
const assignEvents = (db, taskId) => db.prepare("SELECT * FROM events WHERE taskId = ? AND type = 'issue_assigned'").all(taskId);
const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };

test('D1 · 有前置的卡只建不派：库里在、依赖已写、一个派活事件都没有', async (t) => {
  const hold = { value: true };
  const { db, engine } = setup(t, [
    { title: '接管仓库', assignee: 'worker-01' },
    { title: '写发布脚本', assignee: 'worker-01', after: [1] },
  ], hold);

  await engine.submit({ text: '接管并发布', mode: 'delegate' });
  await pumpAll(engine);

  const rows = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid").all();
  assert.equal(rows.length, 2, '该拆出两张卡');
  const [first, second] = rows;

  assert.deepEqual(JSON.parse(second.dependsOn), [first.taskId], '依赖要落成真实 taskId');
  assert.ok(assignEvents(db, first.taskId).length > 0, '第一张要派出去');
  assert.equal(assignEvents(db, second.taskId).length, 0, '第二张在前置完成前不许派');
  assert.equal(second.status, 'todo');
});

test('D2 · 前置 done 后自动放行，下游接着跑完', async (t) => {
  const hold = { value: true };
  const { db, engine } = setup(t, [
    { title: '接管仓库', assignee: 'worker-01' },
    { title: '写发布脚本', assignee: 'worker-01', after: [1] },
  ], hold);

  await engine.submit({ text: '接管并发布', mode: 'delegate' });
  await pumpAll(engine);
  const [first, second] = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid").all();
  assert.equal(assignEvents(db, second.taskId).length, 0);

  // 模拟第一张真跑完（deferred 恢复要等短延迟自检，测试里不等它，直接推进状态机）
  hold.value = false;
  db.prepare("UPDATE tasks SET status = 'done' WHERE taskId = ?").run(first.taskId);
  await engine.reconcile({ olderThanMs: 15_000 });
  await pumpAll(engine);

  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(first.taskId).status, 'done');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(second.taskId).status, 'done',
    '前置完成后下游必须自己跑完，不需要人再点一次');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'dependency_released' AND taskId = ?").get(second.taskId));
});

test('D3 · 前置被取消：下游永远不放行，也不误报完成', async (t) => {
  const hold = { value: true };
  const { db, engine } = setup(t, [
    { title: '接管仓库', assignee: 'worker-01' },
    { title: '写发布脚本', assignee: 'worker-01', after: [1] },
  ], hold);

  await engine.submit({ text: '接管并发布', mode: 'delegate' });
  await pumpAll(engine);
  const [first, second] = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid").all();

  engine.cancelTask(first.taskId, { reason: '方向不对' });
  await engine.reconcile({ olderThanMs: 15_000 });
  await pumpAll(engine);

  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(first.taskId).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(second.taskId).status, 'todo',
    '前置没 done，下游必须原地等着');
  assert.equal(assignEvents(db, second.taskId).length, 0);
});

test('D4 · 事件丢了（重启）：维护心跳把该放行的补投出去', async (t) => {
  const hold = { value: false };
  const { db, engine } = setup(t, [{ title: '任意', assignee: 'worker-01' }], hold);
  // 手工造现场：上游已 done、下游 todo 且依赖满足，但一个事件都没有（重启后常见）
  db.prepare(`INSERT INTO tasks (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt)
    VALUES ('T-up', 'REQ-x', '上游', 'worker-01', 'done', 'delegate', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0)`).run();
  db.prepare(`INSERT INTO tasks (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt, dependsOn)
    VALUES ('T-down', 'REQ-x', '下游', 'worker-01', 'todo', 'delegate', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0, ?)`).run(JSON.stringify(['T-up']));

  const out = await engine.reconcile({ olderThanMs: 15_000 });
  assert.equal(out.releasedDeps, 1, '兜底扫描要认出这张卡该放行了');
  assert.ok(assignEvents(db, 'T-down').length > 0);
});

test('D5 · 不写 after 的老行为不变：多张卡并行派出', async (t) => {
  const hold = { value: true };
  const { db, engine } = setup(t, [
    { title: '甲', assignee: 'worker-01' },
    { title: '乙', assignee: 'worker-01' },
  ], hold);

  await engine.submit({ text: '两件互不相干的事', mode: 'delegate' });
  await pumpAll(engine);

  const rows = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.dependsOn, null, '没写 after 就不该有依赖');
    assert.ok(assignEvents(db, row.taskId).length > 0, '两张都该派出去');
  }
});

test('D6 · 写标题当依赖也认：按同批卡标题匹配', async (t) => {
  const hold = { value: true };
  const { db, engine } = setup(t, [
    { title: '接管仓库', assignee: 'worker-01' },
    { title: '写发布脚本', assignee: 'worker-01', after: ['接管仓库'] },
  ], hold);

  await engine.submit({ text: '接管并发布', mode: 'delegate' });
  await pumpAll(engine);

  const [first, second] = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid").all();
  assert.deepEqual(JSON.parse(second.dependsOn), [first.taskId]);
  assert.equal(assignEvents(db, second.taskId).length, 0);
});

test('D7 · 停着的卡给一句话原因：等前置卡 / 等你拍板', async (t) => {
  const hold = { value: true };
  const { db, engine } = setup(t, [
    { title: '接管仓库', assignee: 'worker-01' },
    { title: '写发布脚本', assignee: 'worker-01', after: [1] },
  ], hold);

  await engine.submit({ text: '接管并发布', mode: 'delegate' });
  await pumpAll(engine);
  const [first, second] = db.prepare("SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid").all();

  const hints = engine.holdReasons();
  assert.match(hints[second.taskId], /等前置卡/, '下游卡要说清在等谁');

  db.prepare("UPDATE tasks SET status = 'awaiting_decision' WHERE taskId = ?").run(first.taskId);
  assert.equal(engine.holdReasons()[first.taskId], '等你拍板');
});
