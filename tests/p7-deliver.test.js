// P7 自主验收（P7-5）：产物落盘 —— 验收通过后复制到项目自己的文件夹。
//   ① 正常落盘：文件到位、校验和与源一致、清单落一行
//   ② 同名绝不覆盖：原有文件原样不动，新文件带任务号
//   ③ 四个拒绝：没配 rootDir / 文件夹不存在 / 子目录跑出项目 / 没有产物
//   ④ 引擎挂接：直投单 done 之后产物出现在项目文件夹；被占用时先不落、心跳重试补上
// 全部零外部依赖、不碰真实键盘、不联网。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';
import { deliverTask, resolveDeliverDir, lastDeliveryOf } from '../src/deliver.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p7d-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 造一个「公司根 + 项目文件夹」，输出目录里放一份产物。
function scene(t, { withRoot = true, files = { 'note.md': '译文内容' } } = {}) {
  const workRoot = tmpRoot(t);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benny-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const taskId = 'T-test0001';
  const outputDir = path.join(workRoot, 'tasks', taskId, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(outputDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  const config = {
    projects: {
      benny: {
        displayName: '小王子翻译',
        ...(withRoot ? { rootDir: projectDir } : {}),
        deliverSubdir: '04-译稿',
      },
    },
  };
  return { workRoot, projectDir, taskId, outputDir, config, task: { taskId, project: 'benny' } };
}

// ---------------------------------------------------------------- ① 正常落盘

test('P7-5 · 落盘：文件到位、校验和与源一致、清单落一行、不在项目里删改任何东西', (t) => {
  const s = scene(t);
  // 目标目录里先放一个无关文件，落盘绝不能动它。
  const existingDir = path.join(s.projectDir, '04-译稿');
  fs.mkdirSync(existingDir, { recursive: true });
  fs.writeFileSync(path.join(existingDir, '别人的稿.md'), '不要动我', 'utf8');

  const out = deliverTask({ workRoot: s.workRoot, config: s.config, task: s.task });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.code, 'DELIVERED');

  const target = path.join(existingDir, 'note.md');
  assert.equal(fs.readFileSync(target, 'utf8'), '译文内容');
  const src = path.join(s.outputDir, 'note.md');
  assert.equal(sha256File(target), sha256File(src), '落进去的那份必须和公司留档同一内容');
  assert.equal(out.copied[0].sha256, sha(Buffer.from('译文内容', 'utf8')));
  assert.equal(out.copied[0].bytes, Buffer.byteLength('译文内容'));
  assert.equal(out.copied[0].renamed, false);

  // 公司原件还在（复制不是移动）
  assert.ok(fs.existsSync(src));
  // 别人的文件一个字节都没变
  assert.equal(fs.readFileSync(path.join(existingDir, '别人的稿.md'), 'utf8'), '不要动我');

  const log = lastDeliveryOf(s.workRoot, 'benny', s.taskId);
  assert.equal(log.schema, 'aicompany.delivery/v1');
  assert.equal(log.targetDir, path.join(s.projectDir, '04-译稿'));
  assert.deepEqual(log.failed, []);
});

test('P7-5 · 同名不覆盖：原来那份不动，新的一份带任务号', (t) => {
  const s = scene(t);
  const targetDir = path.join(s.projectDir, '04-译稿');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'note.md'), '老版本', 'utf8');

  const out = deliverTask({ workRoot: s.workRoot, config: s.config, task: s.task });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(targetDir, 'note.md'), 'utf8'), '老版本', '同名文件绝不能被覆盖');
  const renamed = path.join(targetDir, `note-${s.taskId}.md`);
  assert.equal(fs.readFileSync(renamed, 'utf8'), '译文内容');
  assert.equal(out.copied[0].renamed, true);
});

// ---------------------------------------------------------------- ③ 四个拒绝

test('P7-5 · 四个拒绝各有 code：没配 rootDir / 文件夹不存在 / 子目录跑出项目 / 没有产物', (t) => {
  const noRoot = scene(t, { withRoot: false });
  const r1 = deliverTask({ workRoot: noRoot.workRoot, config: noRoot.config, task: noRoot.task });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'PROJECT_NO_ROOT_DIR');

  const s2 = scene(t);
  s2.config.projects.benny.rootDir = path.join(s2.projectDir, '根本没这个文件夹');
  const r2 = deliverTask({ workRoot: s2.workRoot, config: s2.config, task: s2.task });
  assert.equal(r2.code, 'ROOT_DIR_MISSING');
  // 关键：盘符或路径写错时不许自己在错的地方建目录
  assert.equal(fs.existsSync(path.join(s2.projectDir, '根本没这个文件夹')), false);

  const s3 = scene(t);
  s3.config.projects.benny.deliverSubdir = '../跑出去';
  const r3 = deliverTask({ workRoot: s3.workRoot, config: s3.config, task: s3.task });
  assert.equal(r3.code, 'TARGET_OUTSIDE_PROJECT');
  assert.equal(fs.existsSync(path.join(s3.projectDir, '..', '跑出去')), false);

  const s4 = scene(t, { files: {} });
  const r4 = deliverTask({ workRoot: s4.workRoot, config: s4.config, task: s4.task });
  assert.equal(r4.code, 'NO_ARTIFACTS');
});

test('P7-5 · 落点解析：subdir 为空就落项目根目录，绝不让路径前缀骗过判断', (t) => {
  const root = tmpRoot(t);
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const config = { projects: { p: { rootDir: projectDir, deliverSubdir: null } } };
  const ok = resolveDeliverDir({ config, id: 'p' });
  assert.equal(ok.ok, true);
  assert.equal(ok.targetDir, fs.realpathSync(projectDir));

  // 形如 D:/proj-evil 的兄弟目录不许被当成 D:/proj 的子目录
  const evil = resolveDeliverDir({ config, id: 'p', subdir: '../proj-evil' });
  assert.equal(evil.ok, false);
  assert.equal(evil.code, 'TARGET_OUTSIDE_PROJECT');
});

// ---------------------------------------------------------------- ④ 引擎挂接

function companyConfig(root, projectExtra = {}) {
  return {
    version: 1,
    company: { name: 'p7d-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: { benny: { displayName: '小王子翻译', ...projectExtra } },
    interaction: { defaultMode: 'direct', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'review'], status: 'active', quotaDaily: 50, reportsTo: null,
        adapter: { type: 'mock', config: { result: () => ({ type: 'review', verdict: 'pass' }) } },
      },
      {
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
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: '译完一章，产物是 output/note.md',
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

function writeSpec(root, id) {
  const dir = path.join(root, 'projects', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), '规范：产物必须落文件。', 'utf8');
}

test('P7-5 · 直投单 done 之后，产物出现在项目文件夹里，审计与清单都有据', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'benny');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benny-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const cfg = companyConfig(root, { rootDir: projectDir, deliverSubdir: '04-译稿' });
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });

  const r = await engine.submit({ text: '译第八章', mode: 'direct', addressedTo: 'worker-01', project: 'benny' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');

  const target = path.join(projectDir, '04-译稿', 'note.md');
  assert.equal(fs.readFileSync(target, 'utf8'), '译文内容', '验收通过后产物必须落在项目自己的文件夹里');
  const delivered = engine.getAudit().filter((a) => a.action === 'delivered');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].newValue, /04-译稿/);
  db.close();
});

test('P7-5 · 被占用时先不落：审计记 deferred、项目里没文件；占用解除后心跳重试补上', async (t) => {
  const root = tmpRoot(t);
  writeSpec(root, 'benny');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benny-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  // 测试进程本身就是 node：拿它当「译台开着」的替身，必然命中。
  const cfg = companyConfig(root, { rootDir: projectDir, deliverSubdir: '04-译稿', deliverBlockers: ['node*'] });
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: cfg, notifier: createNotifier('noop') });

  const r = await engine.submit({ text: '译第九章', mode: 'direct', addressedTo: 'worker-01', project: 'benny' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done', '落盘挡不住卡收账');
  assert.equal(fs.existsSync(path.join(projectDir, '04-译稿')), false, '被占用时一个文件都不许写');
  assert.ok(engine.getAudit().some((a) => a.action === 'deliver_deferred'));
  assert.equal(lastDeliveryOf(root, 'benny', r.taskId), null);

  // 模拟译台关掉：去掉占用名单，心跳重试应该把它补上。
  engine.config.projects.benny.deliverBlockers = [];
  const retried = engine.retryPendingDeliveries();
  assert.equal(retried, 1);
  assert.equal(fs.readFileSync(path.join(projectDir, '04-译稿', 'note.md'), 'utf8'), '译文内容');
  db.close();
});
