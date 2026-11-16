// 任务与项目解耦（一）：CEO「只回话、不派卡」。
// 场景：董事会问一句「你好」「你觉得现在该盯什么」「这活能不能这么办」——
// 这类不需要员工动手。引擎必须让它直接回话结案，而不是硬派一张卡给执行席位。
// 覆盖：① report 类型 ② 没写 tasks 只写 summary ③ tasks:[] 无排班 ④ 真空白仍报错 ⑤ CEO 看得到项目近期记忆

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { memoryPath } from '../src/projects.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSpec(root, id) {
  const dir = path.join(root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), '规范：产物必须落文件。', 'utf8');
}

function makeCompany(root, { ceo, captured = null }) {
  return {
    version: 1,
    company: { name: 'ceo-report-test', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: { demo: { displayName: '演示项目' } },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 50, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              if (captured) captured.push(ctx);
              return ceo(ctx);
            },
          },
        },
      },
      {
        id: 'worker-01', displayName: '执行岗', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => ({
              schema: 'aicompany.completion/v1',
              taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
              revision: ctx.task.revision, status: 'success',
              summary: '干完了', artifacts: [],
              acceptanceResults: [{ rule: '产物非空', pass: true }],
              usage: { quotaUnits: 1 }, finishedAt: new Date().toISOString(),
            }),
          },
        },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t, ceo, { captured = null } = {}) {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const db = openDb(':memory:');
  const notifier = createNotifier('web');
  const engine = createEngine({ db, config: makeCompany(root, { ceo, captured }), notifier });
  return { root, db, engine, notifier };
}

const childCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId IS NOT NULL').get().n;
const parent = (db) => db.prepare('SELECT taskId, status FROM tasks WHERE parentTaskId IS NULL ORDER BY rowid DESC LIMIT 1').get();

test('R1 · CEO 用 report 回话：不建子卡、父卡直接结案、答复进审计和收件箱', async (t) => {
  const { db, engine, notifier } = setup(t, () => ({
    type: 'report',
    answer: '你好。三件事等你定：yitai 的周体检要不要保留、benny 的术语表要不要更新、aicompany-dev 的 G-P5 还跑不跑。',
    summary: '回董事会问好并列出待定事项',
  }));

  await engine.submit({ text: '你好', mode: 'delegate' });

  assert.equal(childCount(db), 0, '一句「你好」不该派卡给员工');
  const p = parent(db);
  assert.equal(p.status, 'done', '回完话这一单就该结案');

  const chat = engine.getAudit().filter((a) => a.action === 'ceo_report');
  assert.equal(chat.length, 1);
  assert.match(String(chat[0].newValue), /三件事等你定/, '答复原文要留在审计里，可追');

  const note = notifier.messages.find((m) => m.scene === 'answer');
  assert.ok(note, '答复要进收件箱（看板能看见、桌面会弹）');
  assert.match(String(note.body), /三件事等你定/);
  db.close();
});

test('R2 · 回归：CEO 没写 tasks、只写 summary —— 也不能被当成一张卡派下去', async (t) => {
  // 这是老实现最蠢的地方：`(tasks ?? [result])` 会把整个结果当卡，
  // 于是「你好」变成一张标题为「你好」的活派给豆包。现在必须识别为回话。
  const { db, engine } = setup(t, () => ({
    type: 'task-create',
    summary: '董事会只是打招呼，不需要派活。回：你好，随时可以让我查项目现状。',
  }));

  await engine.submit({ text: '你好', mode: 'delegate' });

  assert.equal(childCount(db), 0, '没实质卡字段的 result 不是卡');
  assert.equal(parent(db).status, 'done');
  db.close();
});

test('R3 · tasks 空数组 + 只有说明：按回话结案，不再报「等于没产出」', async (t) => {
  const { db, engine } = setup(t, () => ({
    type: 'task-create',
    summary: '现状如下：三个项目都健康，暂无需要动手的事。',
    tasks: [],
  }));

  await engine.submit({ text: '看看各项目有没有可做的事', mode: 'delegate' });

  assert.equal(childCount(db), 0);
  assert.equal(parent(db).status, 'done', '只给判断不给活，也是合法产出');
  db.close();
});

test('R4 · 真的什么都没给（无卡、无排班、无答复）：照样算失败，不能静默结案', async (t) => {
  const { db, engine } = setup(t, () => ({ type: 'task-create' }));

  await engine.submit({ text: '随便', mode: 'delegate' });

  assert.equal(childCount(db), 0);
  assert.notEqual(parent(db).status, 'done', '空白输出不能被当成「干完了」');
  db.close();
});

test('R5 · CEO 拿得到各项目近期记忆（要它出主意，就得让它看到项目最近发生了什么）', async (t) => {
  const captured = [];
  const { root, db, engine } = setup(t, () => ({ type: 'report', answer: '看完了，建议先补 benny 的术语表。' }), { captured });

  const file = memoryPath(root, 'demo');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'aicompany.memory/v1', taskId: 'T-1', project: 'demo', title: '译第四章',
    finishedAt: '2026-11-16T10:00:00.000Z', summary: '译完第四章，术语表缺三个词',
    lessons: ['术语表不全时先补表再动笔'], artifacts: [], nextHints: [],
  })}\n`, 'utf8');

  await engine.submit({ text: '各项目现在有什么该做的', mode: 'delegate' });

  const ctx = captured[0];
  const demo = ctx.availableProjects.find((p) => p.id === 'demo');
  assert.ok(demo, '项目清单要带给 CEO');
  assert.ok(Array.isArray(demo.recentMemory) && demo.recentMemory.length === 1, '要带近期记忆，不能只给项目名');
  assert.match(demo.recentMemory[0].summary, /术语表缺三个词/);
  assert.match(demo.recentMemory[0].lesson, /先补表再动笔/);
  db.close();
});

test('R6 · 提示词：项目记忆进得去、一次性任务别硬归项目、不派卡要写清', async () => {
  const { buildCeoPrompt } = await import('../src/adapter-webhook-exec.js');
  const prompt = buildCeoPrompt({
    task: { taskId: 'T-1', title: '各项目现在有什么该做的', instructions: '看看有没有可做的事' },
    workRoot: 'W:/work',
    company: { agents: [] },
    availableProjects: [{
      id: 'benny', displayName: '小王子翻译', specExists: true,
      rootDir: 'D:/Benny/20_项目/小王子翻译', deliverSubdir: '04-译稿', memoryCount: 5,
      recentMemory: [{
        at: '2026-11-16', title: '译第四章', summary: '术语表缺三个词',
        lesson: '术语表不全时先补表再动笔',
      }],
    }],
  });

  assert.match(prompt, /近事：2026-11-16｜译第四章｜术语表缺三个词/, '项目近期记忆要进提示词');
  assert.match(prompt, /教训：术语表不全时先补表再动笔/);
  assert.match(prompt, /真的一次性活（干完就散、以后不会再做）\*\*就该留空\*\*/, '一次性任务要允许不归项目');
  assert.match(prompt, /"tasks":\[\]/, '要告诉它「只回话」怎么写');
  assert.doesNotMatch(prompt, /"type":"report"/, '四类出口是冻结的，提示词里不能出现第五类');
});
