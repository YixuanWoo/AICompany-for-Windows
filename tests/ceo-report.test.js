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
    answer: '你好。三件事等你定：demo-editor 的周体检要不要保留、demo 的词条表要不要更新、aicompany-dev 的 G-P5 还跑不跑。',
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
  const { root, db, engine } = setup(t, () => ({ type: 'report', answer: '看完了，建议先补 demo 的词条表。' }), { captured });

  const file = memoryPath(root, 'demo');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'aicompany.memory/v1', taskId: 'T-1', project: 'demo', title: '处理第四章',
    finishedAt: '2026-11-16T10:00:00.000Z', summary: '处理完第四章，词条表缺三个词',
    lessons: ['词条表不全时先补表再动笔'], artifacts: [], nextHints: [],
  })}\n`, 'utf8');

  await engine.submit({ text: '各项目现在有什么该做的', mode: 'delegate' });

  const ctx = captured[0];
  const demo = ctx.availableProjects.find((p) => p.id === 'demo');
  assert.ok(demo, '项目清单要带给 CEO');
  assert.ok(Array.isArray(demo.recentMemory) && demo.recentMemory.length === 1, '要带近期记忆，不能只给项目名');
  assert.match(demo.recentMemory[0].summary, /词条表缺三个词/);
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
      id: 'demo', displayName: '文档处理项目', specExists: true,
      rootDir: 'D:/Demo/文档处理项目', deliverSubdir: '04-out', memoryCount: 5,
      recentMemory: [{
        at: '2026-11-16', title: '处理第四章', summary: '词条表缺三个词',
        lesson: '词条表不全时先补表再动笔',
      }],
    }],
  });

  assert.match(prompt, /近事：2026-11-16｜处理第四章｜词条表缺三个词/, '项目近期记忆要进提示词');
  assert.match(prompt, /教训：词条表不全时先补表再动笔/);
  assert.match(prompt, /真的一次性活（干完就散、以后不会再做）\*\*就该留空\*\*/, '一次性任务要允许不归项目');
  assert.match(prompt, /"tasks":\[\]/, '要告诉它「只回话」怎么写');
  assert.doesNotMatch(prompt, /"type":"report"/, '四类出口是冻结的，提示词里不能出现第五类');
});

test('R7 · 提示词：CEO 写的是验收单，不是施工图（禁止工序 + 验收条数上限 + 自检）', async () => {
  const { buildCeoPrompt } = await import('../src/adapter-webhook-exec.js');
  const prompt = buildCeoPrompt({
    task: { taskId: 'T-1', title: '修个 bug', instructions: '省略号被切成三句' },
    workRoot: 'W:/work',
    company: { agents: [] },
    availableProjects: [],
  });
  // 真机教训：CEO 在没有仓库细节的情况下写了两千字的实现工序（先复现、定位 文件:行、补 N 条断言），
  // 工程岗照着抄，执行岗连卡都没见过。必须把「验收单 vs 施工图」讲死。
  assert.match(prompt, /你写的是验收单，不是施工图/);
  assert.match(prompt, /禁止写方法 \/ 工序/);
  assert.match(prompt, /先写失败断言/, '反面清单要举出真机上出现过的越界写法');
  assert.match(prompt, /验收条件 3–6 条/, '验收条数要有上限；十几条说明该拆卡');
  assert.match(prompt, /自检三问/);
  assert.match(prompt, /写方法是有代价的/, '要讲清「会被原样转发给执行岗」这个后果');
  // 反过来也不能只剩空话：派活三要素与 after 语义必须还在。
  assert.match(prompt, /instructions（要什么结果、产物放哪、什么不要碰）/);
  assert.match(prompt, /写 after/);
});

test('R8 · 提示词：CEO 要知道全公司每个人的职责边界，且每张卡必须带授权话术', async () => {
  const { buildCeoPrompt } = await import('../src/adapter-webhook-exec.js');
  const roster = [
    {
      id: 'ceo', postTitle: '总经理', isCEO: true, status: 'active', reportsTo: null,
      adapter: 'mock',
      duties: '定方向与结果标准、拆解任务、验收，不自己拆实现',
      boundaries: ['不写代码 / 不改文件 / 不产出交付物', '不替工程岗拆实现步骤'],
    },
    {
      id: 'doubao', postTitle: '执行', isCEO: false, status: 'active', reportsTo: 'engineering',
      adapter: 'gui-template', capabilities: ['execute'],
      duties: '开发写代码、写文档、改稿',
      boundaries: ['不自行 git 提交、不推送'],
    },
    {
      id: 'engineering', postTitle: '工程执行', isCEO: false, status: 'active', reportsTo: 'ceo',
      adapter: 'gui-template', capabilities: ['execute', 'delegate', 'review'],
      duties: '技术负责人（CTO）：定技术方案、拆卡派活、评审、管仓库',
      boundaries: ['默认不亲自写实现代码：只有单点小改可以自己做，且必须留痕'],
    },
  ];
  const prompt = buildCeoPrompt({
    task: { taskId: 'T-1', title: '修个 bug', instructions: '省略号被切成三句' },
    workRoot: 'W:/work',
    company: { agents: roster },
    availableProjects: [],
  });
  // 真机反差：下级拿到完整组织树（含 CEO 的职责与边界），CEO 自己的提示词里一个字都没有。
  // 上级必须比下级更了解公司，否则谈不上「派活前先判断这活归谁的地盘」。
  assert.match(prompt, /【你是谁】/);
  assert.match(prompt, /不写代码 \/ 不改文件 \/ 不产出交付物/, 'CEO 自己的边界要注入');
  assert.match(prompt, /【公司长什么样（组织树：谁归谁管）】/);
  assert.match(prompt, /技术负责人（CTO）/, '工程岗的职责要能看见');
  assert.match(prompt, /默认不亲自写实现代码/, '别人的边界也要能看见，否则不知道哪件事不该派给它');
  // 授权话术：不写这句，承接人只能照抄或者原样顶回来（2026-11-17 第二轮结论）。
  assert.match(prompt, /技术方案与拆分由你定；拿不准先给判断再动手/);
  assert.match(prompt, /必须带一句授权/);
  // GUI 席位不能再被写成「本地脚本」：运行时 roster 的 adapter 是字符串，判定要两种形态都认。
  assert.equal(/engineering（工程执行）｜本地脚本/.test(prompt), false);
  assert.match(prompt, /engineering（工程执行）｜桌面应用/);
});

test('R9 · adapter 类型判定：配置对象形态与运行时字符串形态结论一致', async () => {
  const { ceoRoutingBriefing } = await import('../src/org-chart.js');
  const asObject = ceoRoutingBriefing({
    agents: [
      { id: 'ceo', postTitle: '总经理', isCEO: true, adapter: { type: 'webhook-exec', config: {} } },
      { id: 'eng', postTitle: '工程', adapter: { type: 'gui-template', config: {} }, reportsTo: 'ceo' },
    ],
  });
  const asString = ceoRoutingBriefing({
    agents: [
      { id: 'ceo', postTitle: '总经理', isCEO: true, adapter: 'webhook-exec' },
      { id: 'eng', postTitle: '工程', adapter: 'gui-template', reportsTo: 'ceo' },
    ],
  });
  assert.match(asObject, /eng（工程）｜桌面应用/);
  assert.match(asString, /eng（工程）｜桌面应用/, '字符串形态曾误判成「本地脚本」');
});
