// 2026-11-23 第二轮维护回归：落盘改造 + 配置字段落地 + 交付复制保目录 + 记忆归档。
//
// 背景：用户明确要求「项目产物按项目目录与项目规则落盘，项目文件禁止进 output/；
// output/ 只放任务卡、说明、进度、完成报告这类 AICompany 自己的文件」。
// 这组测试守住这条边界，以及它牵连的四条链路：提示词 → draft 补全 → 报告核验 → 交付记账。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildTaskPaths, buildCompletionFromDraft, verifyReport, isInsideAllowedRoots,
} from '../src/gui-report.js';
import { deliverTask } from '../src/deliver.js';
import { copyArtifacts } from '../src/deliver-copy.js';
import { buildProjectContext, archiveMemoryIfNeeded, readRecentMemory } from '../src/projects.js';
import { renderPrompt } from '../src/gui-prompt.js';
import { parseYaml } from '../src/yaml-lite.js';

function tmp(t, prefix = 'aicompany-r2-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manifestScene(t, { withDraft = true } = {}) {
  const workRoot = tmp(t);
  const projectDir = tmp(t, 'r2-proj-');
  const taskId = 'T-r2000001';
  const paths = buildTaskPaths(workRoot, taskId);
  fs.mkdirSync(paths.outputDir, { recursive: true });
  const writeDir = path.join(projectDir, '05-成品');
  fs.mkdirSync(writeDir, { recursive: true });
  const artifact = path.join(writeDir, 'doc15-A5.pdf');
  fs.writeFileSync(artifact, 'pdf-bytes', 'utf8');
  if (withDraft) {
    fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'), JSON.stringify({
      status: 'success', summary: 'doc15 PDF 已生成', deliverables: [{ path: artifact }],
    }), 'utf8');
  }
  return { workRoot, projectDir, taskId, paths, writeDir, artifact };
}

test('R1 · manifest：output 全空也能按 deliverables 补全正式报告', (t) => {
  const s = manifestScene(t);
  const built = buildCompletionFromDraft({
    paths: s.paths, taskId: s.taskId, runId: 'run-1', agent: 'cli-exec', writeDir: s.writeDir,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.source, 'manifest');
  assert.deepEqual(built.report.artifacts, [s.artifact.replace(/\\/g, '/')]);
  assert.equal(built.verified.ok, true, built.verified.errors?.join(';'));
  assert.equal(fs.readdirSync(s.paths.outputDir).length, 0, 'output/ 不该被塞进任何产物');
});

test('R2 · manifest：deliverables 指向落点之外 / 不存在的文件会被拒', (t) => {
  const s = manifestScene(t, { withDraft: false });
  const outside = path.join(s.workRoot, 'elsewhere.md');
  fs.writeFileSync(outside, 'x', 'utf8');
  fs.writeFileSync(path.join(s.paths.taskDir, 'report.draft.json'), JSON.stringify({
    status: 'success', deliverables: [{ path: outside }, { path: path.join(s.writeDir, '不存在.pdf') }],
  }), 'utf8');
  const built = buildCompletionFromDraft({
    paths: s.paths, taskId: s.taskId, runId: 'run-1', agent: 'cli-exec', writeDir: s.writeDir,
  });
  assert.equal(built.ok, false);
  assert.equal(built.kind, 'deliverables_invalid');
  assert.match(built.reason, /不在项目落点内/);
  assert.match(built.reason, /不存在或为空/);
});

test('R3 · verifyReport：绝对路径只在 writeDir 内合法；没 writeDir 时一律拒', (t) => {
  const s = manifestScene(t);
  assert.equal(isInsideAllowedRoots(s.paths.outputDir, s.artifact, s.writeDir), true);
  assert.equal(isInsideAllowedRoots(s.paths.outputDir, s.artifact, null), false);
  assert.equal(isInsideAllowedRoots(s.paths.outputDir, path.join(s.projectDir, '别处的.md'), s.writeDir), false);
  assert.equal(isInsideAllowedRoots(s.paths.outputDir, 'output/a.md', null), true);
  assert.equal(isInsideAllowedRoots(s.paths.outputDir, 'output/../x.md', s.writeDir), false);
});

test('R4 · 交付：绝对路径产物已在项目目录 → 只记账，不再复制副本', (t) => {
  const s = manifestScene(t);
  const config = { projects: { demo: { rootDir: s.projectDir, deliverSubdir: '05-成品' } } };
  const built = buildCompletionFromDraft({
    paths: s.paths, taskId: s.taskId, runId: 'run-1', agent: 'cli-exec', writeDir: s.writeDir,
  });
  const out = deliverTask({
    workRoot: s.workRoot, config, task: { taskId: s.taskId, project: 'demo' }, report: built.report,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.mode, 'in-place');
  assert.equal(out.copied.length, 0);
  assert.equal(out.files.length, 1);
  // 项目目录里只有那一份 PDF，没有 -T-xxx 副本，也没有从 output/ 复制来的东西
  assert.deepEqual(fs.readdirSync(s.writeDir), ['doc15-A5.pdf']);
  const log = fs.readFileSync(path.join(s.workRoot, 'projects', 'demo', 'deliveries.jsonl'), 'utf8');
  assert.match(log, /"mode":"in-place"/);
});

test('R5 · 旧路径不变：output/ 相对路径仍走复制交付', (t) => {
  const workRoot = tmp(t);
  const projectDir = tmp(t, 'r2-proj-');
  const taskId = 'T-r2000002';
  const outputDir = path.join(workRoot, 'tasks', taskId, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'note.md'), '交付文本', 'utf8');
  const out = deliverTask({
    workRoot, task: { taskId, project: 'demo' },
    config: { projects: { demo: { rootDir: projectDir, deliverSubdir: '04-out' } } },
    report: { artifacts: ['output/note.md'] },
  });
  assert.equal(out.ok, true);
  assert.equal(out.copied.length, 1);
  assert.equal(fs.readFileSync(path.join(projectDir, '04-out', 'note.md'), 'utf8'), '交付文本');
});

test('R6 · 交付复制保留子目录，且拒绝 .. 逃逸', (t) => {
  const src = tmp(t);
  const targetDir = tmp(t, 'r2-target-');
  const a = path.join(src, 'a.md');
  fs.writeFileSync(a, 'A', 'utf8');
  const out = copyArtifacts({
    files: [{ name: 'output/分册/part08.md', path: a }, { name: '../escape.md', path: a }],
    targetDir, taskId: 'T-r2',
  });
  assert.equal(out.copied.length, 1);
  assert.equal(fs.readFileSync(path.join(targetDir, '分册', 'part08.md'), 'utf8'), 'A');
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].reason, /拒绝落盘/);
  assert.equal(fs.existsSync(path.join(targetDir, '..', 'escape.md')), false);
});

test('R7 · 项目规范：memory 段不再当规矩贴进提示词，focus 单独必读', (t) => {
  const workRoot = tmp(t);
  const dir = path.join(workRoot, 'projects', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.yaml'), [
    'name: 文档处理项目',
    'workflow:',
    '  outputs:',
    '    stage4: 05-成品/docNN-A5.pdf',
    'redlines:',
    '  - 只改三类：错别字、错漏、硬性事实错误',
    'memory:',
    '  focus:',
    '    - 外部编辑器占着文件时不许改盘上文件',
    '    - 产物必须落盘，不能只回「已完成」',
    '  requireLessons: true',
  ].join('\n'), 'utf8');
  const ctx = buildProjectContext({ workRoot, config: { projects: { demo: {} } }, id: 'demo' });
  assert.match(ctx.contextText, /【项目规范】/);
  assert.match(ctx.contextText, /stage4: 05-成品/);
  assert.match(ctx.contextText, /只改三类：错别字/);
  assert.match(ctx.contextText, /【项目焦点】/);
  assert.match(ctx.contextText, /外部编辑器占着文件时不许改盘上文件/);
  assert.match(ctx.contextText, /【记忆要求】/);
  assert.doesNotMatch(ctx.contextText, /requireLessons: true/, 'memory: 配置段不该混进「必须遵守」的规范');
  assert.deepEqual(ctx.focus, ['外部编辑器占着文件时不许改盘上文件', '产物必须落盘，不能只回「已完成」']);
});

test('R8 · 连续三单交白卷时提示词点名提醒', (t) => {
  const workRoot = tmp(t);
  const dir = path.join(workRoot, 'projects', 'demo', 'knowledge');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [1, 2, 3].map((n) => JSON.stringify({
    schema: 'aicompany.memory/v1', taskId: `T-${n}`, summary: `第${n}单`, lessons: [], nextHints: [],
  }));
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${rows.join('\n')}\n`, 'utf8');
  const ctx = buildProjectContext({ workRoot, config: { projects: { demo: {} } }, id: 'demo' });
  assert.match(ctx.contextText, /最近 3 单都没留下任何经验/);
});

test('R9 · 记忆超量归档：最老的进 archive，读窗口不变', (t) => {
  const workRoot = tmp(t);
  const dir = path.join(workRoot, 'projects', 'demo', 'knowledge');
  fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify({ taskId: `T-${i}`, lessons: [`经验${i}`] }));
  fs.writeFileSync(path.join(dir, 'memory.jsonl'), `${rows.join('\n')}\n`, 'utf8');
  const gc = archiveMemoryIfNeeded(workRoot, 'demo', { keep: 10 });
  assert.equal(gc.archived, 10);
  assert.equal(gc.count, 20);
  const recent = readRecentMemory(workRoot, 'demo', { limit: 10 });
  assert.equal(recent.entries.length, 10);
  assert.equal(recent.entries.at(-1).taskId, 'T-29');
  const archive = fs.readFileSync(gc.archive, 'utf8').trim().split('\n');
  assert.equal(archive.length, 10, '归档一条都不能丢');
});

test('R10 · GUI 提示词：产物落点用项目目录，output 只放公司文件', () => {
  const { prompt } = renderPrompt({
    task: { taskId: 'T-r2', instructions: '生成doc15 PDF', acceptance: ['产物落盘'] },
    paths: {
      taskDir: 'D:\\w\\tasks\\T-r2', inputDir: 'D:\\w\\tasks\\T-r2\\input',
      outputDir: 'D:\\w\\tasks\\T-r2\\output', reportPath: 'D:\\w\\tasks\\T-r2\\completion.json',
      changeRequestsDir: 'D:\\w\\tasks\\T-r2\\change-requests',
    },
    config: { reportMode: 'draft', reportsTo: 'ceo' },
    project: { writeDir: 'D:\\Demo\\\文档处理项目\\05-成品', contextText: '【项目规范】x' },
  });
  assert.match(prompt, /产物写到这个目录（绝对路径）：D:\\Demo\\\文档处理项目\\05-成品/);
  assert.match(prompt, /禁止写进 output\//);
  assert.match(prompt, /deliverables 必须列出/);
  assert.match(prompt, /report\.draft\.json/);
});

test('R11 · yaml-lite 能解析纯标量列表（project.yaml 的 redlines / focus）', () => {
  const data = parseYaml(['redlines:', '  - 只改三类：错别字', '  - 不动别人已验收的段落', 'name: x'].join('\n'));
  assert.deepEqual(data.redlines, ['只改三类：错别字', '不动别人已验收的段落']);
  assert.equal(data.name, 'x');
});

// R12 走真引擎：模拟 CLI 席位的行为（产物写项目目录 + 写 completion.json + 回报告），
// 验证「派活 → 收单 → done → 交付」全程不会再把产物复制一份、也不会灌脚本进项目。
test('R12 · 真引擎端到端：项目目录产物 done 后只记账，不复制副本', async (t) => {
  const { openDb } = await import('../src/core.js');
  const { createEngine, createNotifier } = await import('../src/engine.js');
  const { sha256File } = await import('../src/gui-report.js');
  const root = tmp(t);
  const projectDir = tmp(t, 'r2-proj-');
  const specDir = path.join(root, 'projects', 'demo');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'project.yaml'), 'workflow:\n  outputs:\n    stage4: 05-成品/docNN-A5.pdf\n', 'utf8');
  const writeDir = path.join(projectDir, '05-成品');
  fs.mkdirSync(writeDir, { recursive: true });

  const config = {
    version: 1,
    company: { name: 'r2-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: { demo: { displayName: '文档处理项目', rootDir: projectDir, deliverSubdir: '05-成品' } },
    interaction: { defaultMode: 'direct', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'review'], status: 'active', quotaDaily: 50, reportsTo: null,
        adapter: { type: 'mock', config: { result: () => ({ type: 'review', verdict: 'pass' }) } },
      },
      {
        id: 'cli-exec', displayName: 'CLI 席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              // 席位拿到的落点必须是引擎算好的项目目录，不是 output/
              assert.equal(ctx.project.writeDir, writeDir);
              const artifact = path.join(writeDir, 'doc15-A5.pdf');
              fs.writeFileSync(artifact, 'pdf-bytes', 'utf8');
              const taskDir = path.join(root, 'tasks', ctx.task.taskId);
              fs.mkdirSync(taskDir, { recursive: true });
              const key = artifact.replace(/\\/g, '/');
              const report = {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'cli-exec',
                revision: ctx.task.revision, status: 'success',
                summary: 'doc15 PDF 已按项目规矩落 05-成品',
                artifacts: [key], checksum: { [key]: sha256File(artifact) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1, memoryFeed: { lessons: ['产物直接写项目目录'], nextHints: [] } },
                finishedAt: new Date().toISOString(),
              };
              fs.writeFileSync(path.join(taskDir, 'completion.json'), JSON.stringify(report), 'utf8');
              return report;
            },
          },
        },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };

  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('noop') });
  const r = await engine.submit({ text: '做doc15 PDF', mode: 'direct', addressedTo: 'cli-exec', project: 'demo' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');
  assert.deepEqual(fs.readdirSync(writeDir), ['doc15-A5.pdf'], '项目目录里只有那一份产物，没有副本');
  const log = fs.readFileSync(path.join(root, 'projects', 'demo', 'deliveries.jsonl'), 'utf8');
  assert.match(log, /"mode":"in-place"/);
  assert.ok(engine.getAudit().some((a) => a.action === 'delivered'), '交付要留审计');
  db.close();
});
