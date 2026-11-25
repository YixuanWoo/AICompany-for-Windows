// G-P5 常驻门禁：不按 72 小时墙钟，按累计活动 + 任务/Run 样本 + 任务异常率判。
// 这些测试只验规则与续跑，不启动真控制面。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, seedAgents } from '../src/core.js';
import { buildSoakConfig } from '../src/soak.js';
import { detectDirty } from '../src/observe.js';
import {
  emptyGateState, applyGateSample, judgeGateState, loadGateState, saveGateState,
  createGateWatch, renderGateMarkdown, DEFAULT_GATE_THRESHOLDS,
} from '../src/gate-watch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratch(t, prefix = 'gate-watch') {
  const base = path.join(ROOT, 'work');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function dbWith(t) {
  const db = openDb(':memory:');
  seedAgents(db, buildSoakConfig({}));
  t.after(() => db.close());
  return db;
}

test('G-P5 · 关机空档不计活动时间，连续小间隔才累计', () => {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  let state = emptyGateState({ now: new Date(start) });
  state.lastTickAt = new Date(start - 60_000).toISOString();
  state = applyGateSample(state, {
    at: new Date(start), clean: true, taskStats: {}, runStats: {},
  }, { maxGapMs: 10 * 60_000 });
  assert.equal(state.activeMs, 60_000, '1 分钟连续间隔应计入');

  state.lastTickAt = new Date(start - 8 * 3_600_000).toISOString();
  const before = state.activeMs;
  state = applyGateSample(state, {
    at: new Date(start), clean: true, taskStats: {}, runStats: {},
  }, { maxGapMs: 10 * 60_000 });
  assert.equal(state.activeMs, before, '关机 8 小时的空档不能补计');
});

test('G-P5 · 样本不足判 insufficient，脏/探测失败优先判不过', () => {
  const state = emptyGateState({ now: new Date('2026-01-01T00:00:00Z') });
  let gate = judgeGateState(state);
  assert.equal(gate.passed, false);
  assert.equal(gate.level, 'insufficient');

  const dirty = { ...state, dirtySamples: 1, lastDirtyAt: state.updatedAt };
  gate = judgeGateState(dirty);
  assert.equal(gate.level, 'dirty', '窗口内的脏状态要拦');

  // 2026-11-25 口径：脏状态只看最近 24 小时，历史累计不再追罚
  const staleDirty = { ...state, dirtySamples: 30, lastDirtyAt: '2025-12-25T00:00:00.000Z' };
  gate = judgeGateState(staleDirty);
  assert.notEqual(gate.level, 'dirty', '窗口外的历史脏状态不该永久卡住门禁');

  const probe = { ...state, probeErrors: 1 };
  gate = judgeGateState(probe);
  assert.equal(gate.level, 'probe-error');
});

test('G-P5 · 累计样本达标且异常率不超线才通过；通过后钉住', () => {
  const base = {
    ...emptyGateState({ now: new Date('2026-01-01T00:00:00Z') }),
    activeMs: 6 * 3_600_000,
    samples: 300,
    tasks: 35,
    guiTasks: 5,
    runs: 40,
    effectiveRuns: 35,
    failedRuns: 1,
  };
  let gate = judgeGateState(base);
  assert.equal(gate.passed, true, gate.reason);
  assert.equal(gate.level, 'pass');

  const sticky = { ...base, passedAt: '2026-01-02T00:00:00Z', dirtySamples: 2 };
  gate = judgeGateState(sticky);
  assert.equal(gate.passed, true, '通过后不应被新脏状态翻回去');
  assert.equal(gate.level, 'passed');
  assert.match(gate.reason, /已在/);
});

test('G-P5 · 异常率超线判 error-rate，不靠“跑够时间”蒙混', () => {
  const base = {
    ...emptyGateState({ now: new Date('2026-01-01T00:00:00Z') }),
    activeMs: 6 * 3_600_000,
    samples: 300,
    tasks: 35,
    guiTasks: 5,
    runs: 40,
    effectiveRuns: 35,
    tasksBad: 3,
    failedRuns: 3,
  };
  const gate = judgeGateState(base);
  assert.equal(gate.passed, false);
  assert.equal(gate.level, 'error-rate');
  assert.match(gate.reason, /异常率/);
});

test('G-P5 · 异常率按卡片算：重派造成的 failed run 不重复罚分', () => {
  const base = {
    ...emptyGateState({ now: new Date('2026-01-01T00:00:00Z') }),
    activeMs: 6 * 3_600_000,
    samples: 300,
    tasks: 35,
    tasksDone: 35,
    tasksBad: 0,
    guiTasks: 5,
    runs: 40,
    effectiveRuns: 35,
    failedRuns: 8, // 同一张卡重派多次留下的过程账
  };
  const gate = judgeGateState(base);
  assert.equal(gate.passed, true, gate.reason);
  assert.equal(gate.metrics.taskErrorRate, 0);
});

test('G-P5 · 状态可持久化，重启后接着累计而不是清零', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'gate-watch.json');
  const state = {
    ...emptyGateState({ now: new Date('2026-01-01T00:00:00Z') }),
    activeMs: 2 * 3_600_000,
    samples: 120,
    lastTickAt: '2026-01-01T02:00:00.000Z',
  };
  saveGateState(file, state);
  const loaded = loadGateState(file);
  assert.equal(loaded.samples, 120);
  assert.equal(loaded.activeMs, 2 * 3_600_000);
  assert.equal(loaded.schema, state.schema);
});

test('G-P5 · 常驻实例按生产库任务/Run 计样本，并写入状态与报告', (t) => {
  const dir = scratch(t);
  const db = dbWith(t);
  const now = new Date('2026-01-02T00:00:00Z');
  const stateFile = path.join(dir, 'gate-watch.json');
  const reportDir = path.join(dir, 'gate-watch');

  // 预置到“只差一次采样就能通过”的进度：6h 活动、300 次采样。
  saveGateState(stateFile, {
    ...emptyGateState({ now: new Date('2026-01-01T00:00:00Z') }),
    activeMs: 6 * 3_600_000,
    samples: 300,
    lastTickAt: new Date(now.getTime() - 60_000).toISOString(),
  });

  // 35 个任务，其中 5 个 GUI 席位；35 个有效 Run，只有 1 个 failed（2.9% < 5%）。
  const insertTask = db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`);
  for (let i = 0; i < 35; i += 1) {
    const assignee = i < 5 ? 'gui-worker' : 'worker-01';
    insertTask.run(`T-gw-${i}`, `Rq-gw-${i}`, `任务 ${i}`, assignee, 'done', 'direct',
      new Date(now.getTime() - 60_000).toISOString(), new Date(now.getTime() - 30_000).toISOString());
  }
  const insertRun = db.prepare(`INSERT INTO runs
    (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES (?, ?, ?, 'first-start', ?, 1, 1, ?, ?)`);
  for (let i = 0; i < 35; i += 1) {
    insertRun.run(`Run-gw-${i}`, `T-gw-${i}`, 'worker-01', i === 0 ? 'failed' : 'success',
      new Date(now.getTime() - 60_000).toISOString(), new Date(now.getTime() - 30_000).toISOString());
  }

  const gateWatch = createGateWatch({
    db, config: buildSoakConfig({ workRoot: dir }), workRoot: dir,
    statePath: stateFile, reportDir, now: () => now, reportEvery: 5,
  });
  const snap = gateWatch.sample();
  assert.equal(snap.state.samples, 301);
  assert.equal(snap.state.activeMs, 6 * 3_600_000 + 60_000);
  assert.equal(snap.state.tasks, 35);
  assert.equal(snap.state.guiTasks, 5);
  assert.equal(snap.state.effectiveRuns, 35);
  assert.equal(snap.gate.passed, true, snap.gate.reason);
  assert.ok(fs.existsSync(path.join(reportDir, 'gate-report.json')));
  assert.ok(fs.existsSync(path.join(reportDir, 'gate-report.md')));
  const md = renderGateMarkdown(snap);
  assert.match(md, /累计活动/);
  assert.match(md, /任务异常率/);
  assert.match(md, /通过/);
  gateWatch.stop();
});

test('G-P5 · 观察窗口之前就已终态的老脏卡不拖累新门禁', (t) => {
  const dir = scratch(t);
  const db = dbWith(t);
  const now = new Date('2026-01-02T00:00:00Z');
  const insertTask = db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt)
    VALUES (?, ?, ?, 'worker-01', 'done', 'direct', ?, ?, 1, 0)`);
  const insertPayload = db.prepare(`INSERT INTO task_payload
    (taskId, revision, instructions, acceptanceJson, completionReportPath, inputJson)
    VALUES (?, 1, 'x', '[]', 'output/completion.json', '{}')`);
  insertTask.run('T-old', 'Rq-old', '老卡', '2025-12-01T00:00:00Z', '2025-12-01T01:00:00Z');
  insertPayload.run('T-old');
  insertTask.run('T-new', 'Rq-new', '新卡', '2026-01-01T20:00:00Z', '2026-01-01T21:00:00Z');
  insertPayload.run('T-new');

  const all = detectDirty({ db, config: buildSoakConfig({ workRoot: dir }), workRoot: dir, now });
  assert.ok(all.issues.some((i) => i.taskId === 'T-old'), '不带 since 时应看到老卡');
  const windowed = detectDirty({
    db, config: buildSoakConfig({ workRoot: dir }), workRoot: dir, now, since: '2026-01-01T00:00:00Z',
  });
  assert.ok(!windowed.issues.some((i) => i.taskId === 'T-old'), '窗口之前的老卡不应计入');
  assert.ok(windowed.issues.some((i) => i.taskId === 'T-new'), '窗口内的新卡仍要报');
});

test('G-P5 · 默认阈值不是 72 小时，而是 6 小时活动 + 30 任务 + 30 Run', () => {
  assert.equal(DEFAULT_GATE_THRESHOLDS.minActiveHours, 6);
  assert.equal(DEFAULT_GATE_THRESHOLDS.minTasks, 30);
  assert.equal(DEFAULT_GATE_THRESHOLDS.minRuns, 30);
  assert.equal(DEFAULT_GATE_THRESHOLDS.maxTaskErrorRate, 0.05);
  assert.equal(DEFAULT_GATE_THRESHOLDS.dirtyWindowHours, 24);
  assert.ok(!('minHours' in DEFAULT_GATE_THRESHOLDS));
});
