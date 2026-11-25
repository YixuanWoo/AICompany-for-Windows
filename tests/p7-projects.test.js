// P7 自主验收（第一步：P7-1 ~ P7-4）：项目层与项目记忆。
//   ① 项目注册表（id 安全、rootDir 绝对路径、deliverSubdir 不出项目、memoryLimit 范围）
//   ② 项目可选（未指定放行交 agent 判断；显式指定时未知 / 缺规范仍拒，报出可用列表与路径）
//   ③ 规范注入 brief（在硬性要求之前）
//   ④ 记忆写入：卡到 done 才落，元数据由引擎补，员工只能影响「这一条」
//   ⑤ 记忆读取：第二单 brief 里能看到第一单的教训；memoryLimit 生效
// 全部零外部依赖、不激活真实窗口、不联网、不烧额度。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createRecurring } from '../src/recurring.js';
import { loadConfig, ConfigError } from '../src/config.js';
import {
  assertProject, buildProjectContext, readRecentMemory, memoryPath, ProjectError, createProject,
} from '../src/projects.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

const noWait = async () => {};

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p7-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSpec(root, id, text = '规范：产物必须落文件，术语先统一。') {
  const dir = path.join(root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'project.yaml');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// ---------------------------------------------------------------- ① 配置规则

test('P7-1 · 项目配置：id 必须是安全目录名；rootDir 必须绝对路径；deliverSubdir 不许跑出项目外；memoryLimit 有范围', (t) => {
  const root = tmpRoot(t);
  const base = [
    'version: 1',
    'workRoot: ' + root.replace(/\\/g, '/'),
    'agents:',
    '  - id: ceo',
    '    isCEO: true',
    '    capabilities: [plan, review]',
    '    status: active',
    '    adapter:',
    '      type: process',
    '      config:',
    '        command: node -e "process.exit(0)"',
    'clients: [web]',
    'notifier: [noop]',
  ];
  const load = (extra) => {
    const file = path.join(root, `c-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(file, [...base, ...extra].join('\n'), 'utf8');
    return loadConfig(file, {}, { overridesPath: null });
  };

  const bad = [
    [['projects:', '  ../evil:', '    displayName: x'], /项目 id/],
    [['projects:', '  demo:', '    rootDir: demo/out'], /绝对路径/],
    [['projects:', '  demo:', '    deliverSubdir: D:/elsewhere'], /相对子目录/],
    [['projects:', '  demo:', '    deliverSubdir: ../out'], /相对子目录/],
    [['projects:', '  demo:', '    memoryLimit: 999'], /0–50/],
  ];
  for (const [extra, pattern] of bad) {
    assert.throws(() => load(extra), (error) => error instanceof ConfigError && pattern.test(error.message), extra.join(' '));
  }

  // 合法配置：默认值补齐（displayName 缺省用 id，memoryLimit 缺省 10，没配 rootDir = 不自动落盘）
  const { config } = load(['projects:', '  demo:', '    displayName: 演示项目']);
  assert.equal(config.projects.demo.displayName, '演示项目');
  assert.equal(config.projects.demo.memoryLimit, 10);
  assert.equal(config.projects.demo.rootDir, null, '没配项目文件夹就不该有落盘位置');
});

// ---------------------------------------------------------------- ② 必选与拒绝

test('P7-1 · 项目可选：未指定放行交 agent 判断；显式指定时未知 / 缺规范仍拒', (t) => {
  const root = tmpRoot(t);
  const config = { projects: { demo: { displayName: '演示' }, other: { displayName: '另一个' } } };

  // 没指定项目 → 放行，auto=true + 可用清单交给 agent 自主判断（新项目/老项目/一次性）。
  const auto = assertProject({ config, workRoot: root, requested: null });
  assert.equal(auto.project, null);
  assert.equal(auto.auto, true);
  assert.deepEqual(auto.available, ['demo', 'other']);
  // 空字符串同样视为没指定。
  assert.equal(assertProject({ config, workRoot: root, requested: '  ' }).auto, true);
  assert.throws(
    () => assertProject({ config, workRoot: root, requested: 'nope' }),
    (error) => error.code === 'PROJECT_UNKNOWN' && /可用：demo, other/.test(error.message),
  );
  const missing = (() => {
    try { assertProject({ config, workRoot: root, requested: 'demo' }); } catch (error) { return error; }
    return null;
  })();
  assert.equal(missing?.code, 'PROJECT_SPEC_MISSING');
  assert.ok(missing.message.includes(path.join(root, 'projects', 'demo', 'project.yaml')), '必须报出具体路径');

  // 建了规范就通过
  writeSpec(root, 'demo');
  const ok = assertProject({ config, workRoot: root, requested: 'demo' });
  assert.equal(ok.project, 'demo');
  assert.match(ok.spec.text, /术语先统一/);

  // 老配置（一个项目都没配）：不强制，行为与以前一致
  assert.deepEqual(assertProject({ config: {}, workRoot: root }).legacy, true);
});

// ---------------------------------------------------------------- 引擎脚手架

function company(root, { projects = null, reportMode = null, lessons = null } = {}) {
  const gui = reportMode !== null;
  return {
    version: 1,
    company: { name: 'p7-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    ...(projects ? { projects } : {}),
    interaction: { defaultMode: 'direct', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 50, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            // CEO 占位：被请验收就放行，其余情况把活拆成一张子卡派下去。
            result: (ctx) => (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '通过' }
              : {
                type: 'task-create', title: '子任务', assignee: 'worker-01',
                instructions: '按 brief 执行', acceptance: ['产物非空'],
              }),
          },
        },
      },
      gui ? {
        id: 'worker-01', displayName: '窗口席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: {
          type: 'gui-template',
          config: {
            workRoot: root, windowTitle: 'TEST-WINDOW', driver: 'simulation',
            reportMode,
            // 模拟「聊天窗口型助手」交差：产物 + 三/五字段的极简报告（可选带经验）
            simulation: {
              onSend: async ({ paths }) => {
                fs.writeFileSync(path.join(paths.outputDir, 'note.md'), '交付文本内容', 'utf8');
                fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'), JSON.stringify({
                  status: 'success', summary: '处理完一章，产物是 output/note.md',
                  ...(lessons ? { lessons, nextHints: ['先核对编号再动笔'] } : {}),
                }), 'utf8');
              },
            },
            steps: [{ action: 'activate' }, { action: 'paste' }, { action: 'press', key: 'GO' }],
            maxPolls: 3, pollIntervalMs: 0,
          },
        },
      } : {
        id: 'worker-01', displayName: '后台席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, '交付文本内容', 'utf8');
              const feed = ctx.adapterConfig.memoryFeed;
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: '处理完一章，产物是 output/note.md',
                artifacts: ['output/note.md'],
                checksum: { 'output/note.md': sha256File(file) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1, ...(feed ? { memoryFeed: feed } : {}) },
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

// ---------------------------------------------------------------- ③ 记忆写入

test('P7-3 · 直投单 done 后落一条记忆：元数据由引擎补，员工塞的字段不采信', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const cfg = company(root, { projects: { demo: { displayName: '演示' } } });
  // 员工在记忆供料里夹带 taskId / project：都不该进库
  cfg.agents[1].adapter.config.memoryFeed = {
    lessons: ['长文一次贴 3000 字会崩，要分段'],
    nextHints: ['先要词条表再动笔'],
    taskId: 'T-FAKE', project: 'hacked',
  };
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  const r = await engine.submit({ text: '处理第三章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });

  assert.equal(r.project, 'demo');
  assert.equal(db.prepare('SELECT project FROM tasks WHERE taskId = ?').get(r.taskId).project, 'demo');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');

  const memory = readRecentMemory(root, 'demo', { limit: 5 });
  assert.equal(memory.count, 1, '一张卡只落一条');
  const [rec] = memory.entries;
  assert.equal(rec.schema, 'aicompany.memory/v1');
  assert.equal(rec.taskId, r.taskId, 'taskId 只能是引擎补的，员工夹带无效');
  assert.equal(rec.project, 'demo', 'project 同上，不给员工改');
  assert.equal(rec.agent, 'worker-01');
  assert.equal(rec.difficulty, 'normal');
  assert.deepEqual(rec.artifacts, ['output/note.md']);
  assert.deepEqual(rec.lessons, ['长文一次贴 3000 字会崩，要分段']);
  assert.ok(engine.getAudit().some((a) => a.action === 'memory_written'));
  db.close();
});

test('P7-3 · 记忆字段不合法就不入库：只留审计，库里一条不加', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const cfg = company(root, { projects: { demo: { displayName: '演示' } } });
  cfg.agents[1].adapter.config.memoryFeed = { lessons: '不是数组（写花了）' };
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  await engine.submit({ text: '处理第四章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });

  assert.equal(readRecentMemory(root, 'demo', { limit: 5 }).count, 0, '校验不过一律不入库');
  const rejected = engine.getAudit().filter((a) => a.action === 'memory_rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].newValue, /lessons/);
  // 卡本身照样 done：记忆是副产品，不能因为它把活判失败
  assert.equal(db.prepare('SELECT status FROM tasks').get().status, 'done');
  db.close();
});

// ---------------------------------------------------------------- ④ 规范与经验注入

test('P7-2 / P7-4 · brief：规范全文 + 上一单的教训都进提示词，第一单没有「相关经验」', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo', '# 这行是写给人看的注释\n词条表必须在 input/词条表.md；段落数必须与原文一致。');
  const cfg = company(root, {
    projects: { demo: { displayName: '演示' } }, reportMode: 'draft',
    lessons: ['豆包会把编号写错'],
  });
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });

  // 第一单：brief 里只有规范，没有「相关经验」
  const first = await engine.submit({ text: '处理第一章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(first.taskId).status, 'done');
  const firstBrief = fs.readFileSync(path.join(root, 'tasks', first.taskId, 'brief.md'), 'utf8');
  assert.match(firstBrief, /【项目规范】/, '规范必须进 brief');
  assert.match(firstBrief, /词条表必须在 input\/词条表\.md/);
  assert.equal(/这行是写给人看的注释/.test(firstBrief), false, '规范里的注释不进提示词（只留生效的键值）');
  assert.equal(/【相关经验】/.test(firstBrief), false, '还没有记忆时这一节要省略，不能留空标题');
  assert.ok(firstBrief.indexOf('【项目规范】') < firstBrief.indexOf('【硬性要求'), '规范要排在硬性要求之前');

  // 员工交差时顺路带回经验（draft 的可选字段）
  const taskDir = path.join(root, 'tasks', first.taskId);
  fs.writeFileSync(path.join(taskDir, 'report.draft.json'), JSON.stringify({
    status: 'success', summary: '第一章处理完', lessons: ['豆包会把编号写错'], nextHints: ['先核对编号'],
  }), 'utf8');

  // 第二单：brief 里应该出现第一单的教训
  const second = await engine.submit({ text: '处理第二章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });
  const secondBrief = fs.readFileSync(path.join(root, 'tasks', second.taskId, 'brief.md'), 'utf8');
  assert.match(secondBrief, /【相关经验】/);
  assert.match(secondBrief, /豆包会把编号写错/);
  assert.match(secondBrief, /先核对编号/);
  db.close();
});

test('P7-4 · memoryLimit 控制注入条数；记忆坏了只跳过坏行，不影响别的条目', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const file = memoryPath(root, 'demo');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (n) => JSON.stringify({
    schema: 'aicompany.memory/v1', taskId: `T-${n}`, project: 'demo', finishedAt: '2026-11-16T00:00:00Z',
    summary: `第 ${n} 单`, lessons: [`教训 ${n}`], nextHints: [],
  });
  fs.writeFileSync(file, [line(1), '{坏掉的一行', line(2), line(3)].join('\n') + '\n', 'utf8');

  const config = { projects: { demo: { displayName: '演示', memoryLimit: 2 } } };
  const ctx = buildProjectContext({ workRoot: root, config, id: 'demo' });
  assert.match(ctx.contextText, /最近 2 条/);
  assert.match(ctx.contextText, /教训 3/);
  assert.match(ctx.contextText, /教训 2/);
  assert.equal(/教训 1/.test(ctx.contextText), false, 'memoryLimit=2 时不该多塞');
  assert.equal(ctx.memoryCount, 4, '坏行也算行数（统计口径是行数，不是有效条数）');
});

// ---------------------------------------------------------------- ⑤ 子卡继承

test('P7-1 · 子卡继承父卡的项目：CEO 拆活不会把活拆出项目之外', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const cfg = company(root, { projects: { demo: { displayName: '演示' } } });
  cfg.interaction.defaultMode = 'delegate';
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  const r = await engine.submit({ text: '处理第五章', mode: 'delegate', project: 'demo' });

  const rows = db.prepare('SELECT taskId, parentTaskId, project, assignee FROM tasks ORDER BY rowid').all();
  assert.equal(rows.length, 2, '父卡 + CEO 派出的子卡');
  assert.equal(rows[0].project, 'demo');
  assert.equal(rows[1].project, 'demo', '子卡必须跟着项目走');
  assert.equal(rows[1].assignee, 'worker-01');
  assert.equal(r.project, 'demo');
  db.close();
});

// ---------------------------------------------------------------- ⑥ 新建项目渠道

test('P7-8 · 新建项目：建目录 + 起步规范 + 立刻可用；重复/坏 id/坏路径都拒', (t) => {
  const root = tmpRoot(t);
  const config = { projects: {} };
  const out = createProject({ config, workRoot: root, id: 'demo-new', displayName: '新项目' });

  assert.equal(out.ok, true);
  assert.equal(fs.existsSync(out.specPath), true, '要写一份起步规范');
  assert.equal(fs.existsSync(path.join(root, 'projects', 'demo-new', 'knowledge')), true);
  assert.deepEqual(Object.keys(config.projects), ['demo-new'], '配置里立刻可见');
  // 建完就能下单：显式指定它不再报「未知项目 / 缺规范」。
  assert.equal(assertProject({ config, workRoot: root, requested: 'demo-new' }).project, 'demo-new');

  assert.throws(() => createProject({ config, workRoot: root, id: 'demo-new' }),
    (e) => e instanceof ProjectError && e.code === 'PROJECT_EXISTS');
  assert.throws(() => createProject({ config, workRoot: root, id: 'Bad ID' }),
    (e) => e.code === 'PROJECT_ID_INVALID');
  assert.throws(() => createProject({ config, workRoot: root, id: 'x2', rootDir: path.join(root, 'nope') }),
    (e) => e.code === 'PROJECT_ROOT_MISSING', '落盘目录必须先存在，不替你到处建野目录');
  assert.throws(() => createProject({ config, workRoot: root, id: 'x3', deliverSubdir: '../外面' }),
    (e) => e.code === 'PROJECT_SUBDIR_INVALID');

  // 已有规范绝不覆盖（规范是人定的）。
  const spec = writeSpec(root, 'keep', '老规范：不许改我');
  createProject({ config, workRoot: root, id: 'keep' });
  assert.equal(fs.readFileSync(spec, 'utf8'), '老规范：不许改我');
});

test('P7-9 · CEO 一次拆多张卡、改判项目、建议新项目都落进系统', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  writeSpec(root, 'other');
  const cfg = company(root, { projects: { demo: { displayName: '演示' }, other: { displayName: '另一个' } } });
  cfg.interaction.defaultMode = 'delegate';
  // CEO 的「脑子」：一次拆两张卡、都改判到 demo，同时建议单开一个新项目。
  cfg.agents[0].adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'pass', reason: '通过' }
    : {
      type: 'task-create',
      summary: '归 demo，拆两张；另外建议单开 new-proj',
      projectSuggestion: { id: 'new-proj', displayName: '新项目', reason: '值得单开' },
      tasks: [
        { title: '第一张', assignee: 'worker-01', project: 'demo', instructions: '做 A', acceptance: ['产物非空'] },
        { title: '第二张', assignee: 'worker-01', instructions: '做 B', acceptance: ['产物非空'] },
      ],
    });

  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  const r = await engine.submit({ text: '做个东西', mode: 'delegate' });

  const rows = db.prepare('SELECT taskId, parentTaskId, project, assignee, originJson FROM tasks ORDER BY rowid').all();
  assert.equal(rows.length, 3, '父卡 + 两张子卡');
  assert.equal(rows[0].project, null, '董事会没指定项目');
  assert.equal(rows[1].project, 'demo', 'CEO 改判的项目必须落到子卡上');
  assert.equal(rows[2].project, 'demo');
  assert.equal(rows[1].assignee, 'worker-01');
  assert.match(rows[1].originJson ?? '', /归 demo/, 'CEO 的说明挂在卡上，看板能直接看到');

  const ap = db.prepare("SELECT status, requestJson FROM approvals WHERE kind = 'project_create'").all();
  assert.equal(ap.length, 1, '建议建项目要出审批单，不能自己建');
  assert.equal(JSON.parse(ap[0].requestJson).payload.project.id, 'new-proj');
  assert.equal(Object.keys(cfg.projects).includes('new-proj'), false, '没点通过之前不许真建');
  assert.equal(r.project ?? null, null);
  db.close();
});

test('P7-10 · 总经理在输出里点名自己也不许自干：强制改派执行席位', async (t) => {
  const root = tmpRoot(t);
  const cfg = company(root);
  // 最坏情况：CEO 无视提示词，把卡派给自己。
  cfg.agents[0].adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'pass', reason: '通过' }
    : {
      type: 'task-create', summary: '我想自己干',
      tasks: [{ title: '我自己来', assignee: 'ceo', instructions: '写个文件', acceptance: ['产物非空'] }],
    });

  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  await engine.submit({ text: '做点东西', mode: 'delegate' });

  const child = db.prepare('SELECT assignee, assignedBy FROM tasks WHERE parentTaskId IS NOT NULL').get();
  assert.ok(child, '子卡必须建出来');
  assert.equal(child.assignee, 'worker-01', '总经理岗不接执行卡，必须改派给执行席位');
  db.close();
});

test('P7-11 · 建项目用 CEO 拟好的规范：董事会只审不填，通过就照草案写', (t) => {
  const root = tmpRoot(t);
  const config = {};
  const out = createProject({
    config, workRoot: root, id: 'demo2', displayName: '演示二',
    deliverSubdir: '04-out',
    acceptance: ['44 批全部处理完', '词条表前后一致'],
    rules: ['文件名用 04-out/docNN.md', '不许改动源文件目录'],
  });
  const spec = fs.readFileSync(out.specPath, 'utf8');
  assert.match(spec, /44 批全部处理完/, '验收条件要原样写进规范');
  assert.match(spec, /词条表前后一致/);
  assert.match(spec, /04-out\/docNN\.md/, '固定规矩要原样写进规范');
  assert.doesNotMatch(spec, /产物落在约定目录，且内容非空/, 'CEO 给了验收条件就不该用空白模板');
  assert.match(spec, /displayName: 演示二/);
  assert.match(spec, /deliverSubdir: 04-out/);
  assert.equal(config.projects.demo2.deliverSubdir, '04-out');
});

test('P7-12 · 卡上写了还不存在的项目：父卡挂起等审批，一张子卡都不许建（白批事故回归）', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const cfg = company(root, { projects: { demo: { displayName: '演示' } } });
  cfg.interaction.defaultMode = 'delegate';
  // CEO 判断这活归一个还不存在的项目，并顺手递上建项目申请——正是真机上「批完才发现活早跑完了」的场景。
  cfg.agents[0].adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'pass', reason: '通过' }
    : {
      type: 'task-create', summary: '归 demo-editor',
      projectSuggestion: { id: 'demo-editor', displayName: '外部编辑器', reason: '长期项目' },
      tasks: [{
        title: '接管仓库', assignee: 'worker-01', project: 'demo-editor',
        instructions: '读仓库并出基线', acceptance: ['产物非空'],
      }],
    });

  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  engine.setApprovalHandler('project_create', (payload) => {
    const out = createProject({ config: cfg, workRoot: root, ...payload.project });
    return { project: out.project };
  });
  await engine.submit({ text: '接管外部编辑器', mode: 'delegate' });

  const parent = db.prepare('SELECT taskId, status FROM tasks WHERE parentTaskId IS NULL').get();
  assert.equal(parent.status, 'awaiting_decision', '项目没批，父卡必须挂起等董事会');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId IS NOT NULL').get().n, 0,
    '项目没批，一张子卡都不许建（否则就是先跑完再批，产物和经验全落不到项目里）');
  const ap = db.prepare("SELECT approvalId FROM approvals WHERE kind = 'project_create' AND status = 'pending'").get();
  assert.ok(ap, '要出建项目审批单');

  // 董事会通过 → 真建项目，并把父卡放出来重拆（不批就永远停着）。
  const decided = engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'board' });
  assert.equal(decided.applied, true, decided.error ?? '');
  assert.ok(cfg.projects['demo-editor'], '通过之后项目才存在');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(parent.taskId).status, 'in_progress',
    '父卡要被放出来，否则批了也接不上');
  const wake = db.prepare("SELECT payloadJson FROM events WHERE taskId = ? AND type = 'issue_assigned' ORDER BY rowid DESC LIMIT 1").get(parent.taskId);
  assert.match(String(wake?.payloadJson ?? ''), /"wakeReason":"decision"/, '唤醒理由必须是 decision（挂起态只认这个出口）');
  db.close();
});

test('P7-13 · 项目被拒：父卡放出来按一次性任务跑，不会永远挂起', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo');
  const cfg = company(root, { projects: { demo: { displayName: '演示' } } });
  cfg.interaction.defaultMode = 'delegate';
  cfg.agents[0].adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'pass', reason: '通过' }
    : {
      type: 'task-create', summary: '归 someday',
      projectSuggestion: { id: 'someday', displayName: '以后再说', reason: '先占位' },
      tasks: [{ title: '先干着', assignee: 'worker-01', project: 'someday', instructions: '做', acceptance: ['非空'] }],
    });

  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  await engine.submit({ text: '做点事', mode: 'delegate' });
  const parent = db.prepare('SELECT taskId, status FROM tasks WHERE parentTaskId IS NULL').get();
  assert.equal(parent.status, 'awaiting_decision');

  const ap = db.prepare("SELECT approvalId FROM approvals WHERE kind = 'project_create'").get();
  engine.decideApproval(ap.approvalId, { decision: 'rejected', decidedBy: 'board', reason: '不建' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(parent.taskId).status, 'in_progress',
    '被拒也要放出来，不能因为项目没批就把活永远停住');
  assert.equal(Object.keys(cfg.projects).includes('someday'), false, '拒了就不建');
  db.close();
});

test('P7-14 · 只排班不派卡：tasks 空数组不建空壳卡，批了才进调度器', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'demo-editor');
  const cfg = company(root, { projects: { 'demo-editor': { displayName: '外部编辑器' } } });
  cfg.interaction.defaultMode = 'delegate';
  cfg.agents[0].adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'pass', reason: '通过' }
    : {
      type: 'task-create', summary: '为 demo-editor 排运行节奏',
      recurringSuggestion: {
        title: '外部编辑器每周体检', project: 'demo-editor',
        rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=0',
        assignee: 'worker-01', kind: 'inspection',
        instructions: '按 MAINTENANCE-PLAN 1.2 做每周体检',
        acceptance: ['build.ps1 退出码 0 且 0 警告'],
        reason: '每周都必须重跑一次门禁',
      },
      tasks: [],
    });

  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  await engine.submit({ text: '给 demo-editor 排节奏', mode: 'delegate' });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId IS NOT NULL').get().n, 0,
    '只排班不该建出干活的卡（tasks:[] 不能被当成「把整个结果当一张卡」）');
  assert.equal(db.prepare('SELECT status FROM tasks').get().status, 'done', '排班提完，这单本身就是完的');

  const ap = db.prepare("SELECT approvalId, requestJson FROM approvals WHERE kind = 'recurring_create'").get();
  assert.ok(ap, '要出循环任务审批单');
  const payload = JSON.parse(ap.requestJson).payload;
  assert.equal(payload.job.project, 'demo-editor', '排班必须带回项目归属');
  assert.equal(payload.job.assignee, 'worker-01');
  assert.equal(payload.job.trigger.rrule, 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=0');
  assert.equal(payload.rruleText, '每周一 20:00', '董事会要看人话，不是 rrule');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recurring_jobs').get().n, 0, '没点通过之前不许进调度器');

  // 通过之后才真注册，且注册出来的 job 带项目归属。
  engine.setApprovalHandler('recurring_create', (p) => {
    const rec = createRecurring({ db, notifier: createNotifier('noop') });
    const out = rec.registerJob(p.job);
    return { jobId: out.jobId, nextFireAt: out.nextFireAt };
  });
  const decided = engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'board' });
  assert.equal(decided.applied, true, decided.error ?? '');
  const jobs = db.prepare('SELECT jobId, status, jobJson FROM recurring_jobs').all();
  assert.equal(jobs.length, 1, '批了才真排班');
  assert.equal(JSON.parse(jobs[0].jobJson).project, 'demo-editor');
  assert.equal(jobs[0].status, 'active');
  db.close();
});
