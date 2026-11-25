// 证据层：产物写在项目目录时也要看得见（2026-11-24，T-5457e8a0 误杀后补）。
// 病根：落盘改造后提示词让席位直接写 projects.<id>.rootDir，而 probeRun 只扫任务目录 output/，
// 于是「真在干活」在证据层里等同于「什么都没写」→ 15 分钟一到就被判死重派。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeRun, EVIDENCE_LEVEL } from '../src/evidence.js';

function board({ startedAgoMs = 60_000 } = {}) {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-proj-'));
  const taskId = 'T-PROJ-1';
  const dir = path.join(workRoot, 'tasks', taskId);
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  const projectDir = path.join(workRoot, 'proj', '04-out');
  fs.mkdirSync(projectDir, { recursive: true });
  const startedAt = new Date(Date.now() - startedAgoMs).toISOString();
  fs.writeFileSync(path.join(dir, 'dispatch.json'), JSON.stringify({ runId: 'R-PROJ-1', at: startedAt }));
  return { workRoot, taskId, dir, projectDir, startedAt, run: { runId: 'R-PROJ-1', startedAt } };
}

test('P-A1 · output/ 空着、项目目录有新产物 → 判「在动」（L2）', () => {
  const f = board();
  fs.writeFileSync(path.join(f.projectDir, 'ch17.md'), 'x'.repeat(200));

  const probe = probeRun({ workRoot: f.workRoot, taskId: f.taskId, run: f.run, extraDirs: [f.projectDir] });

  assert.equal(probe.level, EVIDENCE_LEVEL.ACTIVE, '项目目录有新鲜产物就该算在动');
  assert.ok(probe.kinds.includes('artifact-project'), '要能标出证据来自项目产物');
  assert.ok(probe.activityAt, '要报出最近活动时间，引擎据此重置耐心');
});

test('P-A2 · 项目目录只有上一轮的旧文件 → 停在「已启动」（L1）', () => {
  const f = board();
  const old = path.join(f.projectDir, 'ch16.md');
  fs.writeFileSync(old, 'x'.repeat(200));
  const oneHourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(old, oneHourAgo, oneHourAgo);

  const probe = probeRun({ workRoot: f.workRoot, taskId: f.taskId, run: f.run, extraDirs: [f.projectDir] });

  assert.equal(probe.level, EVIDENCE_LEVEL.DISPATCHED, '旧产物不能给本轮续命');
  assert.ok(!probe.kinds.includes('artifact-project'));
});

test('P-A3 · 不传 extraDirs → 老行为不变（仍只看任务目录 output/）', () => {
  const f = board();
  fs.writeFileSync(path.join(f.projectDir, 'ch17.md'), 'x'.repeat(200));

  const probe = probeRun({ workRoot: f.workRoot, taskId: f.taskId, run: f.run });

  assert.equal(probe.level, EVIDENCE_LEVEL.DISPATCHED);
});
