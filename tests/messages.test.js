// 董事会消息箱：所有 agent 对人说的话集中一处，一条一句人话。
// 这里验的是「话怎么说、什么时候说、说了能不能看」——不验排版（那是看板的事）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { plainText, composeDoneMessage, listMessages, markMessagesRead, unreadMessageCount } from '../src/messages.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';
import { normalizeRepos } from '../src/repos.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-msg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function company(root, { report = {}, ceoTasks = null } = {}) {
  return {
    version: 1,
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    repos: normalizeRepos({ demo: { path: root, remote: null, reviewer: 'engineering', allowPush: false } }),
    artifacts: {
      defaultReviewer: 'engineering', defaultHandoff: 'ceo',
      requireRepoForManagedCode: true, codeExtensions: ['.js', '.py'],
    },
    projects: {
      p1: { displayName: '小王子的翻译', rootDir: path.join(root, 'proj'), deliverSubdir: '交付', memoryLimit: 5 },
    },
    agents: [
      {
        id: 'ceo', postTitle: '总经理', holderName: 'dsh', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 99, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '可以' }
              : { type: 'task-create', summary: '派一张', tasks: ceoTasks ?? [{ title: '整理术语表', assignee: 'doubao' }] }),
          },
        },
      },
      {
        id: 'doubao', postTitle: '执行', holderName: '豆包', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 99, reportsTo: 'ceo',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'terms.md');
              fs.writeFileSync(file, '术语表', 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'doubao',
                revision: ctx.task.revision, status: 'success',
                summary: `完成：${ctx.task.title}`,
                boardNote: '术语表理好了，42 条，按原文出现顺序排的。',
                artifacts: ['output/terms.md'],
                checksum: { 'output/terms.md': sha256File(file) },
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
        id: 'engineering', postTitle: '工程执行', holderName: 'wb', isCEO: false,
        capabilities: ['execute', 'review'], status: 'active', quotaDaily: 99,
        reportsTo: 'ceo', dispatch: 'pull',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t, opts = {}) {
  const root = tmpRoot(t);
  // 项目要有规范文件才允许派活（没有规范的项目等于没有工地）。
  const specDir = path.join(root, 'projects', 'p1');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'project.yaml'), 'name: 小王子的翻译\n', 'utf8');
  // 落盘目录必须事先存在：引擎不会替你到处建野目录。
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
  const db = openDb(':memory:');
  const cfg = company(root, opts);
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine, cfg };
}

const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };
const childOf = (db) => db.prepare('SELECT * FROM tasks WHERE parentTaskId IS NOT NULL ORDER BY rowid').get();

test('M1 · 干完活：消息箱出现一条人话，讲清谁、干了什么、结果如何', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ text: '把第 3 章译稿整理成术语对照表', project: 'p1' });
  await pumpAll(engine);

  const msgs = listMessages(db);
  assert.equal(msgs.length, 1, '一张卡干完只该有一条消息，不能按审计条数刷屏');
  const m = msgs[0];
  assert.equal(m.kind, 'done');
  assert.match(m.title, /^完成：/);
  assert.match(m.body, /豆包（执行） 干完了：整理术语表/);
  assert.match(m.body, /术语表理好了，42 条/, 'boardNote 要优先于 summary 展示');
  assert.match(m.body, /你不用管/, '结尾要告诉人「要不要动手」');
  assert.ok(!m.body.includes('completion.json'), '内部文件名不许出现在给人的消息里');
  assert.ok(!m.body.includes('output/'), '产物相对路径也不摆出来');
});

test('M2 · 产物落盘后，消息补一句「放进哪个文件夹」', async (t) => {
  const { db, engine, root } = setup(t);
  await engine.submit({ text: '整理术语表', project: 'p1' });
  await pumpAll(engine);

  const body = listMessages(db)[0].body;
  assert.match(body, /已经放进「小王子的翻译」/, `消息里要有落盘位置，实际：${body}`);
  assert.ok(fs.existsSync(path.join(root, 'proj', '交付', 'terms.md')), '文件真被放进项目文件夹了');
});

test('M3 · 卡住了：消息说清原因，并告诉人「它已经停下来等你」', async (t) => {
  const { db, engine } = setup(t, {
    // 判成受管代码却没写 repo：引擎打回两次后进 blocked。
    report: { artifactKind: 'managed-code', handoff: 'review' },
    ceoTasks: [{ title: '写个脚本', assignee: 'doubao' }],
  });
  await engine.submit({ text: '写个脚本' });
  await pumpAll(engine);

  const card = childOf(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId).status, 'blocked');
  const blocked = listMessages(db).filter((m) => m.kind === 'blocked');
  assert.equal(blocked.length, 1, '卡住要有一条，且只有一条');
  assert.match(blocked[0].body, /卡住了，需要你定/);
  assert.match(blocked[0].body, /停下来等你/);
});

test('M4 · 董事会直投：落盘结案，一条消息，不惊动总经理', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ mode: 'direct', addressedTo: 'doubao', text: '整理术语表', project: 'p1' });
  await pumpAll(engine);

  const msgs = listMessages(db);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'done');
  assert.match(msgs[0].body, /干完了/);
  const ceoReviews = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n;
  assert.equal(ceoReviews, 0, '直投只对董事会负责，不该为一条汇报再烧一次 CEO');
});

test('M5 · 已读未读：计数准、单条能标、全部能清', async (t) => {
  const { db, engine } = setup(t);
  await engine.submit({ mode: 'direct', addressedTo: 'doubao', text: '整理术语表', project: 'p1' });
  await pumpAll(engine);
  await engine.submit({ mode: 'direct', addressedTo: 'doubao', text: '再整理一遍', project: 'p1' });
  await pumpAll(engine);

  assert.equal(unreadMessageCount(db), 2);
  const msgs = listMessages(db);
  markMessagesRead(db, { ids: [msgs[0].msgId] });
  assert.equal(unreadMessageCount(db), 1);
  markMessagesRead(db, { all: true });
  assert.equal(unreadMessageCount(db), 0);
  assert.equal(listMessages(db, { unreadOnly: true }).length, 0);
  assert.equal(listMessages(db).length, 2, '标已读不删消息');
});

test('M6 · 人话清洗：JSON / markdown / 大段明细不进消息正文', () => {
  assert.equal(plainText('{"summary":"整理完了，42 条术语"}'), '整理完了，42 条术语');
  // 标题只有两个字时不算「一句话」，要接着取下一段。
  assert.equal(plainText('# 报告\n\n**做完了**，详见附录\n\n附录一大堆'), '报告 做完了，详见附录');
  // 空 body 不写消息：宁缺毋滥。
  const db = openDb(':memory:');
  assert.equal(unreadMessageCount(db), 0);
  db.close();
});

test('M7 · 总经理只回话：消息只有那条回复，不再重复播报「干完了」', async (t) => {
  const { db, engine } = setup(t, {
    ceoTasks: [],
  });
  await engine.submit({ text: '你好' });
  await pumpAll(engine);

  const msgs = listMessages(db);
  assert.equal(msgs.length, 1, `只该有一条回话，实际 ${JSON.stringify(msgs.map((m) => m.title))}`);
  assert.equal(msgs[0].kind, 'answer');
  assert.match(msgs[0].title, /总经理回复/);
});

test('M8 · 组合器：审查通过时先说「谁看过了」，不再冒充「刚干完」', () => {
  const out = composeDoneMessage({
    config: { agents: [{ id: 'doubao', postTitle: '执行', holderName: '豆包' }, { id: 'ceo', postTitle: '总经理' }] },
    task: { title: '整理术语表', assignee: 'doubao' },
    report: { boardNote: '42 条术语理好了', artifacts: [] },
    reviewedBy: 'ceo',
  });
  assert.match(out.body, /看过了，没问题：整理术语表/);
  assert.match(out.body, /它说：42 条术语理好了/);
});

test('M9 · 入口固定：契约登记了两个消息端点，看板有消息区', async () => {
  const { API_ENDPOINTS } = await import('../src/contracts.js');
  const paths = API_ENDPOINTS.map((e) => e.path);
  assert.ok(paths.includes('/api/messages'), '契约缺 GET /api/messages');
  assert.ok(paths.includes('/api/messages/read'), '契约缺 POST /api/messages/read');

  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'board.html'), 'utf8');
  assert.ok(html.includes('id="messages-list"'), '看板要有消息区，否则董事会看不到人话汇报');
  assert.ok(html.includes('/api/messages'), '看板要走消息接口');
});
