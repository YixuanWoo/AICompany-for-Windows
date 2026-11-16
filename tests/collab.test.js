// 三人协作：仓库台账 / 产物分类 / 交付路由 / 代码审查 / 子派活。
// 全部用 mock 席位与临时目录，不联网、不碰真仓库。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { normalizeRepos, assertRepo, findRepoForPath } from '../src/repos.js';
import { seatBriefing, orgTreeLines } from '../src/org-chart.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-collab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 三个岗位：总经理（mock 拆卡）/ 执行（mock 交活）/ 工程（pull，测试里直接调方法）。
function company(root, { report = {}, tasks = null } = {}) {
  return {
    version: 1,
    company: { name: 'collab', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    repos: normalizeRepos({
      demo: { path: root, remote: null, reviewer: 'engineering', allowPush: false },
    }),
    artifacts: {
      defaultReviewer: 'engineering',
      defaultHandoff: 'ceo',
      requireRepoForManagedCode: true,
      codeExtensions: ['.js', '.py', '.md'],
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
              : {
                type: 'task-create', summary: '派一张',
                tasks: tasks ?? [{ title: '干活', assignee: 'doubao' }],
              }),
          },
        },
      },
      {
        id: 'doubao', postTitle: '执行', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 99, reportsTo: 'engineering',
        duties: '写文档、翻译', boundaries: ['不改代码仓库'],
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
                ...report,
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
        duties: '写代码、审代码、提交推送',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t, opts = {}) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const cfg = company(root, opts);
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine, cfg };
}

const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };
const childOf = (db) => db.prepare('SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid').get();

test('R1 · 仓库台账：不写 path 直接拒，未知仓库拒，路径归属取最长前缀', () => {
  assert.throws(() => normalizeRepos({ x: { remote: 'a/b' } }), /缺 path/);
  assert.throws(() => normalizeRepos({ X: { path: 'D:/x' } }), /只允许小写/);
  assert.throws(() => normalizeRepos({ x: { path: 'D:/x', remote: 'not a remote !!' } }), /remote/);

  const config = {
    repos: normalizeRepos({
      outer: { path: 'D:/code' },
      inner: { path: 'D:/code/inner' },
    }),
  };
  assert.throws(() => assertRepo({ config, requested: 'nope' }), /未登记的仓库/);
  assert.equal(findRepoForPath(config, 'D:/code/a.js').id, 'outer');
  assert.equal(findRepoForPath(config, 'D:/code/inner/a.js').id, 'inner');
  assert.equal(findRepoForPath(config, 'D:/other/a.js'), null);
});

test('R2 · 组织图与席位身份：豆包的上级是工程，工程的上级是总经理', (t) => {
  const { cfg } = setup(t);
  const tree = orgTreeLines(cfg).join('\n');
  assert.match(tree, /总经理（ceo/);
  assert.match(tree, /工程执行（engineering/);
  const doubao = seatBriefing(cfg, 'doubao');
  assert.match(doubao, /上级：工程执行（engineering）/);
  assert.match(doubao, /必须上报/);
  assert.match(doubao, /managed-code/);
  const eng = seatBriefing(cfg, 'engineering');
  assert.match(eng, /下级：执行（doubao）/);
  assert.match(eng, /永不 force push|force push/);
});

test('R3 · 判成受管代码却没写 repo：打回两次后进 blocked，审计留痕', async (t) => {
  const { db, engine } = setup(t, { report: { artifactKind: 'managed-code', handoff: 'review' } });
  await engine.submit({ text: '写个脚本' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'blocked');
  const hit = db.prepare("SELECT * FROM audit WHERE action = 'code_repo_missing' AND taskId = ?").get(card.taskId);
  const seen = db.prepare('SELECT action FROM audit').all().map((a) => a.action).join(',');
  assert.ok(hit, `必须留下「代码没登记仓库」的审计，否则查无可查；实际审计：${seen}`);
});

test('R4 · 受管代码 + 仓库 + 工程审：卡停在 in_review，审过才 done', async (t) => {
  const { db, engine } = setup(t, {
    tasks: [{ title: '改引擎', assignee: 'doubao', repo: 'demo' }],
    report: { artifactKind: 'managed-code' },
  });
  await engine.submit({ text: '改引擎' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'in_review');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'review_queued' AND taskId = ?").get(card.taskId),
    '审查人不是总经理时要排队等它来审，不能直调拉模式席位');

  const pending = engine.pendingReviews('engineering');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].taskId, card.taskId);

  engine.reviewTask(card.taskId, { reviewer: 'engineering', verdict: 'pass', reason: '看过，没问题' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'done');
});

test('R5 · 一次性脚本（scratch-code）走直接落盘：不建审查、不叫 CEO', async (t) => {
  const { db, engine } = setup(t, {
    report: { artifactKind: 'scratch-code', handoff: 'land' },
  });
  await engine.submit({ text: '渲染一段视频' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'done');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'handoff_land' AND taskId = ?").get(card.taskId));
  const ceoRuns = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n;
  assert.equal(ceoRuns, 0, '落盘结案不该再烧一次 CEO 的额度');
});

test('R6 · 主动上报：卡转 blocked、不重试，并给上级建一张「处理升级」的卡', async (t) => {
  const { db, engine } = setup(t, {
    report: { status: 'blocked', handoff: 'escalate', reason: '这条路会让整个项目偏离' },
  });
  await engine.submit({ text: '按旧方案做完' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'blocked');
  const rescue = db.prepare("SELECT * FROM tasks WHERE role = 'escalation'").get();
  assert.ok(rescue, '必须有人接手这个上报，不能只写一行日志');
  assert.equal(rescue.assignee, 'engineering');
  assert.equal(rescue.parentTaskId, card.taskId);
  assert.match(db.prepare('SELECT * FROM task_payload WHERE taskId = ?').get(rescue.taskId).instructions, /你要决定的一件事/);
  const retries = db.prepare("SELECT COUNT(*) AS n FROM events WHERE taskId = ? AND type = 'issue_assigned'").get(card.taskId).n;
  assert.equal(retries, 1, '方向错了不许自动重试');
});

test('R7 · 子派活：工程可以派给豆包，豆包不能越级派给总经理', async (t) => {
  const { db, engine } = setup(t);
  const parent = await engine.submit({ text: '加个功能', mode: 'direct', addressedTo: 'engineering' });
  const child = engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'engineering',
    title: '实现导出按钮', instructions: '按方案实现，产物写到 output/', assignee: 'doubao',
    acceptance: ['按钮能点，导出文件非空'],
  });
  assert.equal(child.assignee, 'doubao');
  assert.equal(child.parentTaskId, parent.taskId);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(parent.taskId).status, 'todo',
    '父卡不受影响：拆出来的子卡是另一件活');

  assert.throws(() => engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'doubao',
    title: '越级', instructions: 'x', assignee: 'ceo',
  }), /只有这张卡的承接人/);

  assert.throws(() => engine.spawnChild({
    parentTaskId: parent.taskId, assignerId: 'engineering',
    title: '往上派', instructions: 'x', assignee: 'ceo',
  }), /跨子树派活被拒绝/);
});

test('R8 · 打回必须写原因；写成 pass 才收账', async (t) => {
  const { db, engine } = setup(t, {
    tasks: [{ title: '改引擎', assignee: 'doubao', repo: 'demo' }],
    report: { artifactKind: 'managed-code' },
  });
  await engine.submit({ text: '改引擎' });
  await pumpAll(engine);
  const card = childOf(db);
  assert.throws(() => engine.reviewTask(card.taskId, { reviewer: 'engineering', verdict: 'reject' }),
    /必须写 reason/);
  engine.reviewTask(card.taskId, { reviewer: 'engineering', verdict: 'reject', reason: '少了错误处理' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'in_progress');
  const rework = db.prepare("SELECT * FROM events WHERE taskId = ? AND processed = 0 AND type = 'issue_assigned'")
    .get(card.taskId);
  assert.ok(rework, '打回要重投给执行人');
});
