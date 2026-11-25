// 2026-11-23 全盘维护回归：
//   M1 交付过滤：output/ 里的脚本、控制面文件、校验/调试输出不再被复制进项目目录
//      （真机事故：04-out 被倒进 build_doc15_chujiao.py、completion.json、report.md、预览图，
//        人清了两轮，下一次交付又被灌回去）。
//   M3 空记忆可观测：lessons / nextHints 双空时补一条 memory_empty 审计，入库行为不变。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';
import { deliverTask, deliverableOf } from '../src/deliver.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-mt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scene(t, files) {
  const workRoot = tmpRoot(t);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-proj-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const taskId = 'T-mt000001';
  const outputDir = path.join(workRoot, 'tasks', taskId, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(outputDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  const config = { projects: { demo: { displayName: '文档处理项目', rootDir: projectDir, deliverSubdir: '04-out' } } };
  return { workRoot, projectDir, taskId, config, task: { taskId, project: 'demo' } };
}

test('M1 · deliverableOf：真产物放行，脚本 / 控制面 / 校验输出被挡', () => {
  for (const name of ['note.md', 'doc15-初版后全文.md', 'doc05-A5.pdf', '预览-doc05-p1.png', 'annotations.json', 'sub/dir/a.md']) {
    assert.equal(deliverableOf(name).ok, true, `不该被挡：${name}`);
  }
  for (const name of ['build_doc15.py', 'verify_doc15.py', 'verify-doc15批注.txt', 'cmp_ch05.py',
    'check_structure.py', 'completion.json', 'report.draft.json', 'report.md',
    'run-progress.json', 'stop.json', 'x.ps1', 'a.js']) {
    assert.equal(deliverableOf(name).ok, false, `不该放行：${name}`);
  }
});

test('M1 · 混合 output：只有真产物落项目，其余进 skipped，交付台账同样留痕', (t) => {
  const s = scene(t, {
    'note.md': '交付文本内容',
    'sub/doc15-初版清单.md': '清单',
    'build_x.py': 'print(1)',
    'completion.json': '{}',
    'verify-a.txt': 'ok',
  });
  const out = deliverTask({ workRoot: s.workRoot, config: s.config, task: s.task });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.copied.length, 2);
  assert.equal(out.skipped.length, 3);

  const targetDir = path.join(s.projectDir, '04-out');
  assert.equal(fs.readFileSync(path.join(targetDir, 'note.md'), 'utf8'), '交付文本内容');
  // 2026-11-23 起 copyArtifacts 保留相对目录结构：sub/ 下的清单落在 sub/ 里，不再拍平。
  assert.equal(fs.existsSync(path.join(targetDir, 'sub', 'doc15-初版清单.md')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'doc15-初版清单.md')), false);
  for (const junk of ['build_x.py', 'completion.json', 'verify-a.txt']) {
    assert.equal(fs.existsSync(path.join(targetDir, junk)), false, `垃圾不该进项目：${junk}`);
  }
  const log = fs.readFileSync(path.join(s.workRoot, 'projects', 'demo', 'deliveries.jsonl'), 'utf8');
  assert.match(log, /"skipped"/);
});

test('M1 · 全是脚本与校验输出时按 NO_ARTIFACTS 拒绝，项目里不留任何文件', (t) => {
  const s = scene(t, { 'a.py': 'print(1)', 'verify-b.txt': 'ok', 'completion.json': '{}' });
  const out = deliverTask({ workRoot: s.workRoot, config: s.config, task: s.task });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_ARTIFACTS');
  assert.equal(out.skipped.length, 3);
  assert.match(out.error, /没有可交付产物/);
  assert.equal(fs.existsSync(path.join(s.projectDir, '04-out')), false);
});

// ---- M3：空记忆审计（走真引擎，直投单到 done）----

test('M3 · 没写教训的卡照样 done，但审计里多出一条 memory_empty', async (t) => {
  const root = tmpRoot(t);
  const specDir = path.join(root, 'projects', 'demo');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'project.yaml'), '规范：产物必须落文件。', 'utf8');

  const config = {
    version: 1,
    company: { name: 'mt-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: { demo: { displayName: '文档处理项目' } },
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
              fs.writeFileSync(file, '交付文本内容', 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: '干完了，但一条经验都没写',
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

  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('noop') });
  const r = await engine.submit({ text: '处理第八章', mode: 'direct', addressedTo: 'worker-01', project: 'demo' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');

  const actions = engine.getAudit().map((a) => a.action);
  assert.ok(actions.includes('memory_written'), '记忆本身仍要入库（行为不变）');
  assert.ok(actions.includes('memory_empty'), '双空记忆必须补一条 memory_empty 审计');

  const memoryFile = path.join(specDir, 'knowledge', 'memory.jsonl');
  const lines = fs.readFileSync(memoryFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.lessons.length, 0);
  assert.equal(rec.nextHints.length, 0);
  db.close();
});
