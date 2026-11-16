// 拉模式席位的「叫醒」缺口：卡排给「人叫才醒」的席位时，必须主动出声。
//
// 事故背景（2026-11-16 真机）：董事会直投一张卡给工程执行岗，看板上一直显示「排队中」，
// 他没收到任何提示，以为链路不通。实际是 pull 席位在等他开口叫人 —— 系统只写了一条审计，
// 人一个字也看不到。这组测试锁住三件事：出声、说清怎么动、不刷屏。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-pull-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function company(root) {
  return {
    version: 1,
    company: { name: 'pull', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'direct', defaultTarget: 'engineering', autoAssign: false },
    artifacts: {
      defaultReviewer: 'engineering', defaultHandoff: 'byAssigner',
      requireRepoForManagedCode: false, codeExtensions: ['.js'],
    },
    agents: [
      {
        id: 'ceo', postTitle: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active',
        quotaDaily: 99, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '通过' }
              : { type: 'task-create', summary: '派一张', tasks: [{ title: '干活', assignee: 'doubao' }] }),
          },
        },
      },
      {
        id: 'doubao', postTitle: '执行', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 99, reportsTo: 'engineering',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, 'x', 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'doubao',
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
      {
        // 拉模式：控制面不直调，卡留队列等人来领。
        id: 'engineering', postTitle: '工程执行', isCEO: false,
        capabilities: ['execute', 'review', 'delegate', 'plan'], status: 'active',
        quotaDaily: 99, reportsTo: 'ceo', dispatch: 'pull',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
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
const pullNotes = (db) => db.prepare(
  "SELECT * FROM board_messages WHERE kind = 'notice' AND title LIKE '等你领%' ORDER BY rowid",
).all();

test('W1 · 直投给拉模式席位：消息区必须出声，讲清「为什么停着、怎么让它动」', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '测试链路是否连通', mode: 'direct', addressedTo: 'engineering' });
  await pumpAll(engine);

  const card = db.prepare("SELECT * FROM tasks WHERE assignee = 'engineering' ORDER BY rowid DESC").get();
  assert.equal(card.status, 'todo', '拉模式席位不直调，卡应停在 todo 等它来领');

  const notes = pullNotes(db);
  assert.equal(notes.length, 1, '排队必须留一条消息，不能静默');
  const note = notes[0];
  assert.equal(note.fromAgent, 'system');
  assert.equal(note.taskId, card.taskId);
  assert.match(note.body, /人叫才醒/, '要说清这不是坏了，是这个席位不会自己醒');
  assert.match(note.body, /领活/, '要给出让卡动起来的动作');
  assert.match(note.title, /测试链路是否连通/, '标题要带卡名，一眼知道是哪张');
});

test('W2 · 看板要说明白「在等谁来领」，不能只显示「排队中」', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '跑一遍连通检查', mode: 'direct', addressedTo: 'engineering' });
  await pumpAll(engine);
  const card = db.prepare("SELECT * FROM tasks WHERE assignee = 'engineering' ORDER BY rowid DESC").get();

  const hints = engine.holdReasons();
  assert.ok(hints[card.taskId], '拉模式排队中的卡必须有 holdReason');
  assert.match(hints[card.taskId], /工程执行/, '要写出在等哪个岗位');
  assert.match(hints[card.taskId], /人叫才醒/, '要写出为什么它不会自己动');
});

test('W3 · 重复投递不刷屏：同一张卡只提醒一次', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '只该提醒一次', mode: 'direct', addressedTo: 'engineering' });
  await pumpAll(engine);
  const card = db.prepare("SELECT * FROM tasks WHERE assignee = 'engineering' ORDER BY rowid DESC").get();
  assert.equal(pullNotes(db).length, 1);

  // 模拟重投：维护心跳 / 退回队列都会再发一次 issue_assigned，消息区不该跟着长草。
  db.prepare(`INSERT INTO events (eventId, type, taskId, agentId, payloadJson, dedupeKey, processed, createdAt)
    VALUES (?, 'issue_assigned', ?, 'engineering', ?, NULL, 0, ?)`).run(
    `EV-test-${Date.now()}`, card.taskId, JSON.stringify({ wakeReason: 'reconcile' }),
    new Date().toISOString(),
  );
  await pumpAll(engine);
  assert.equal(pullNotes(db).length, 1, '重投不该再写一条');
});

test('W4 · 不误报：常驻席位（push）的卡不产生「等你领」', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '豆包直接干', mode: 'direct', addressedTo: 'doubao' });
  await pumpAll(engine);
  assert.equal(pullNotes(db).length, 0, '常驻席位自己会跑，不该打扰董事会');
  const card = db.prepare("SELECT * FROM tasks WHERE assignee = 'doubao' ORDER BY rowid DESC").get();
  assert.equal(card.status, 'done');
});
