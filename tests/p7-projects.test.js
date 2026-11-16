// P7 自主验收（第一步：P7-1 ~ P7-4）：项目层与项目记忆。
//   ① 项目注册表（id 安全、archiveDir 绝对路径、memoryLimit 范围）
//   ② 建卡必选项目（缺 / 未知 / 缺规范 三种都拒，且报出可用列表与路径）
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
import { loadConfig, ConfigError } from '../src/config.js';
import {
  assertProject, buildProjectContext, readRecentMemory, memoryPath, ProjectError,
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

test('P7-1 · 项目配置：id 必须是安全目录名；archiveDir 必须绝对路径；memoryLimit 有范围', (t) => {
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
    [['projects:', '  demo:', '    archiveDir: benny/out'], /绝对路径/],
    [['projects:', '  demo:', '    memoryLimit: 999'], /0–50/],
  ];
  for (const [extra, pattern] of bad) {
    assert.throws(() => load(extra), (error) => error instanceof ConfigError && pattern.test(error.message), extra.join(' '));
  }

  // 合法配置：默认值补齐（displayName 缺省用 id，memoryLimit 缺省 10）
  const { config } = load(['projects:', '  demo:', '    displayName: 演示项目']);
  assert.equal(config.projects.demo.displayName, '演示项目');
  assert.equal(config.projects.demo.memoryLimit, 10);
  assert.equal(config.projects.demo.archiveDir, null, '没授权就不该有归档目录');
});

// ---------------------------------------------------------------- ② 必选与拒绝

test('P7-1 · 下单校验：缺项目 / 未知项目 / 缺规范 三种拒绝各有可读原因', (t) => {
  const root = tmpRoot(t);
  const config = { projects: { demo: { displayName: '演示' }, other: { displayName: '另一个' } } };

  assert.throws(
    () => assertProject({ config, workRoot: root, requested: null }),
    (error) => error instanceof ProjectError
      && error.code === 'PROJECT_REQUIRED'
      && /demo, other/.test(error.message),
  );
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
                fs.writeFileSync(path.join(paths.outputDir, 'note.md'), '译文内容', 'utf8');
                fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'), JSON.stringify({
                  status: 'success', summary: '译完一章，产物是 output/note.md',
                  ...(lessons ? { lessons, nextHints: ['先核对章节号再动笔'] } : {}),
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
              fs.writeFileSync(file, '译文内容', 'utf8');
              const feed = ctx.adapterConfig.memoryFeed;
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: '译完一章，产物是 output/note.md',
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
    nextHints: ['先要术语表再动笔'],
    taskId: 'T-FAKE', project: 'hacked',
  };
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });
  const r = await engine.submit({ text: '译第三章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });

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
  await engine.submit({ text: '译第四章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });

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
  writeSpec(root, 'demo', '# 这行是写给人看的注释\n术语表必须在 input/术语表.md；段落数必须与原文一致。');
  const cfg = company(root, {
    projects: { demo: { displayName: '演示' } }, reportMode: 'draft',
    lessons: ['豆包会把章节号写错'],
  });
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });

  // 第一单：brief 里只有规范，没有「相关经验」
  const first = await engine.submit({ text: '译第一章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(first.taskId).status, 'done');
  const firstBrief = fs.readFileSync(path.join(root, 'tasks', first.taskId, 'brief.md'), 'utf8');
  assert.match(firstBrief, /【项目规范】/, '规范必须进 brief');
  assert.match(firstBrief, /术语表必须在 input\/术语表\.md/);
  assert.equal(/这行是写给人看的注释/.test(firstBrief), false, '规范里的注释不进提示词（只留生效的键值）');
  assert.equal(/【相关经验】/.test(firstBrief), false, '还没有记忆时这一节要省略，不能留空标题');
  assert.ok(firstBrief.indexOf('【项目规范】') < firstBrief.indexOf('【硬性要求'), '规范要排在硬性要求之前');

  // 员工交差时顺路带回经验（draft 的可选字段）
  const taskDir = path.join(root, 'tasks', first.taskId);
  fs.writeFileSync(path.join(taskDir, 'report.draft.json'), JSON.stringify({
    status: 'success', summary: '第一章译完', lessons: ['豆包会把章节号写错'], nextHints: ['先核对章节号'],
  }), 'utf8');

  // 第二单：brief 里应该出现第一单的教训
  const second = await engine.submit({ text: '译第二章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });
  const secondBrief = fs.readFileSync(path.join(root, 'tasks', second.taskId, 'brief.md'), 'utf8');
  assert.match(secondBrief, /【相关经验】/);
  assert.match(secondBrief, /豆包会把章节号写错/);
  assert.match(secondBrief, /先核对章节号/);
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
  const r = await engine.submit({ text: '译第五章', mode: 'delegate', project: 'demo' });

  const rows = db.prepare('SELECT taskId, parentTaskId, project, assignee FROM tasks ORDER BY rowid').all();
  assert.equal(rows.length, 2, '父卡 + CEO 派出的子卡');
  assert.equal(rows[0].project, 'demo');
  assert.equal(rows[1].project, 'demo', '子卡必须跟着项目走');
  assert.equal(rows[1].assignee, 'worker-01');
  assert.equal(r.project, 'demo');
  db.close();
});
