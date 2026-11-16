// 父卡收束：拆出去的活全干完了，总任务才交到发布者手里。
//
// 这条链是三人协作里最容易断的一节：
//   CEO 派一张总卡 → 工程岗拆成 N 张给豆包 → 豆包干完 → 工程岗逐张审
//   → N 张全收尾 → 父卡收束、拼总汇报 → 交 CEO 验收 → CEO 通过 = 总任务完成。
// 断在「父卡拆完就交活」上，CEO 会在第一张子卡还没动的时候被请来验收一张写着
// 「我拆了 8 张」的空壳卡。这里把两端都钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-parent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function company(root, { ceoTasks = [{ title: '给项目加导出功能', assignee: 'engineering' }] } = {}) {
  return {
    version: 1,
    company: { name: 'parent', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    artifacts: {
      defaultReviewer: 'engineering', defaultHandoff: 'ceo',
      requireRepoForManagedCode: false, codeExtensions: ['.js', '.py', '.md'],
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
              ? { type: 'review', verdict: 'pass', reason: '通过', summary: '总任务验收通过' }
              : { type: 'task-create', summary: '派一张', tasks: ceoTasks }),
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
              fs.writeFileSync(file, `done:${ctx.task.title}`, 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'doubao',
                revision: ctx.task.revision, status: 'success',
                summary: `完成：${ctx.task.title}`,
                artifacts: ['output/note.md'],
                checksum: { 'output/note.md': sha256File(file) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1 },
                boardNote: `${ctx.task.title} 已经做完`,
                finishedAt: new Date().toISOString(),
              };
            },
          },
        },
      },
      {
        id: 'engineering', postTitle: '工程执行', isCEO: false,
        capabilities: ['execute', 'review', 'delegate', 'plan'], status: 'active',
        quotaDaily: 99, reportsTo: 'ceo', escalationTo: 'ceo', dispatch: 'pull',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t, opts = {}) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: company(root, opts), notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine };
}

const pumpAll = async (engine, rounds = 12) => { for (let i = 0; i < rounds; i += 1) await engine.pump(); };
const statusOf = (db, id) => db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(id)?.status;

/** 领到 CEO 派下来的那张总卡（CEO 拆出来的、承接人是工程岗那张）。 */
function parentCard(db) {
  return db.prepare(`SELECT * FROM tasks WHERE parentTaskId IS NOT NULL AND assignee = 'engineering'`).get();
}

async function spawnTwo(engine, parentId) {
  const a = engine.spawnChild({
    parentTaskId: parentId, assignerId: 'engineering', assignee: 'doubao',
    title: '写导出模块', instructions: '实现导出，产物写 output/', acceptance: ['能导出非空文件'],
  });
  const b = engine.spawnChild({
    parentTaskId: parentId, assignerId: 'engineering', assignee: 'doubao',
    title: '补导出说明', instructions: '写一页使用说明，产物写 output/', acceptance: ['说明覆盖导出用法'],
  });
  return [a, b];
}

async function reportParent(engine, parentId, summary = '拆成两张，交给执行岗做') {
  return engine.acceptCompletion({
    taskId: parentId, agentId: 'engineering', runId: `R-${parentId}`,
    report: {
      schema: 'aicompany.completion/v1',
      taskId: parentId, runId: `R-${parentId}`, agent: 'engineering', revision: 1,
      status: 'success', summary, artifacts: [],
      checksum: {}, acceptanceResults: [], usage: { quotaUnits: 1 },
      finishedAt: new Date().toISOString(),
    },
  });
}

test('C1 · 子卡没干完就交父卡：挂起等子卡，不惊动总经理', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '给项目加导出功能', mode: 'delegate', addressedTo: 'ceo' });
  await pumpAll(engine);
  const parent = parentCard(db);
  assert.equal(parent.status, 'todo', '拉模式席位：卡留着等它来领');

  await spawnTwo(engine, parent.taskId);
  await reportParent(engine, parent.taskId);

  const after = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(parent.taskId);
  assert.equal(after.status, 'in_progress', '父卡必须留在 in_progress 等子卡，不能进 in_review');
  assert.equal(after.waitingChildren, 1, '要留下「正在等子卡」的位，否则子卡齐了没人收束');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'parent_waiting_children' AND taskId = ?").get(parent.taskId),
    '挂起要留痕，否则以后查不出这张卡为什么停着');
  const askedCeo = db.prepare("SELECT 1 FROM events WHERE type = 'review_requested' AND taskId = ?").get(parent.taskId);
  assert.ok(!askedCeo, '子卡一张都没做完，绝不能请总经理验收');
});

test('C2 · 子卡全部收尾：自动拼总汇报、交总经理验收，通过才算总任务完成', async (t) => {
  const { root, db, engine } = setup(t);
  await engine.submit({ text: '给项目加导出功能', mode: 'delegate', addressedTo: 'ceo' });
  await pumpAll(engine);
  const parent = parentCard(db);
  const kids = await spawnTwo(engine, parent.taskId);
  await reportParent(engine, parent.taskId);

  // 豆包干完两张，卡停在工程岗手上等审（pull 席位）。
  await pumpAll(engine);
  for (const kid of kids) {
    assert.equal(statusOf(db, kid.taskId), 'in_review', '子卡做完先等工程岗审');
  }
  // 工程岗逐张审：审完第一张，父卡还不该动。
  engine.reviewTask(kids[0].taskId, { reviewer: 'engineering', verdict: 'pass' });
  assert.equal(statusOf(db, parent.taskId), 'in_progress', '还差一张，总任务不能收');
  // 第二张审完 → 父卡收束。
  engine.reviewTask(kids[1].taskId, { reviewer: 'engineering', verdict: 'pass' });

  const settled = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(parent.taskId);
  assert.equal(settled.status, 'in_review', '子卡齐了，父卡进 in_review 等发布者（总经理）验收');
  assert.equal(settled.waitingChildren, 0, '收束后清掉等待位');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'children_settled' AND taskId = ?").get(parent.taskId));

  // 总汇报必须落到父卡目录：总经理验收时读的就是这里。
  const paths = buildTaskPaths(root, parent.taskId);
  const summaryFile = path.join(paths.outputDir, '总任务汇总.md');
  assert.ok(fs.existsSync(summaryFile), '总汇报要写成文件，否则总经理只看到「我拆了两张」');
  const md = fs.readFileSync(summaryFile, 'utf8');
  assert.match(md, /写导出模块/);
  assert.match(md, /补导出说明/);
  const card = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8'));
  assert.equal(card.children.length, 2, 'completion.json 要能看出下面挂了几张子卡');
  assert.match(card.summary, /总任务收束/);

  // 总经理验收通过 → 父卡 done，消息区有一条「总任务收束」。
  await pumpAll(engine);
  assert.equal(statusOf(db, parent.taskId), 'done', '发布者验收通过，总任务才算完成');
  const msg = db.prepare("SELECT * FROM board_messages WHERE taskId = ? AND kind = 'done'").get(parent.taskId);
  assert.ok(msg, '总任务收账要在消息区说一句');
  assert.match(msg.title, /总经理汇报/, '总任务是总经理派的、他验的，就该由他对董事会汇报');
  assert.equal(msg.fromAgent, 'ceo', '消息署名不能是干活的工程岗');
  assert.match(msg.body, /2 张子卡/);
});

test('C3 · 有一张子卡没成：照样收束，但如实写明，不假装全齐', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '给项目加导出功能', mode: 'delegate', addressedTo: 'ceo' });
  await pumpAll(engine);
  const parent = parentCard(db);
  const kids = await spawnTwo(engine, parent.taskId);
  await reportParent(engine, parent.taskId);
  await pumpAll(engine);

  // 一张审过，一张被取消（相当于中途发现不需要 / 做不下去）。
  engine.reviewTask(kids[0].taskId, { reviewer: 'engineering', verdict: 'pass' });
  engine.cancelTask(kids[1].taskId, { reason: '董事会决定这版不要说明了' });

  const settled = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(parent.taskId);
  assert.equal(settled.status, 'in_review', '取消也算收尾，父卡要收');
  const card = JSON.parse(fs.readFileSync(buildTaskPaths(engine.workDir ?? engine.workRoot, parent.taskId).reportPath, 'utf8'));
  assert.match(card.summary, /1 张没成/, '有一个没成必须写在总汇报里，不能拿完成数糊过去');
});

test('C4 · 董事会直投的总卡：子卡齐了直接落盘，不惊动总经理', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '给项目加导出功能', mode: 'direct', addressedTo: 'engineering' });
  await pumpAll(engine);
  const parent = db.prepare(`SELECT * FROM tasks WHERE parentTaskId IS NULL AND assignee = 'engineering'`).get();
  assert.equal(parent.assignerId ?? parent.assignedBy, 'human', '直投的发布者是董事会');

  const kids = await spawnTwo(engine, parent.taskId);
  await reportParent(engine, parent.taskId);
  await pumpAll(engine);
  for (const kid of kids) engine.reviewTask(kid.taskId, { reviewer: 'engineering', verdict: 'pass' });

  assert.equal(statusOf(db, parent.taskId), 'done', '董事会自己发布 = 默认落盘，子卡齐了直接收账');
});
