// P5 验收：试运行的观测、调参、跨天不脏。
// 原则同前几阶段：断言真实行为，不为变绿放宽标准；跑不出来就如实标记为「模拟」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, seedAgents, emit, writeAudit } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import {
  computeMetrics, computeInteractionFindings, detectDirty, buildObservation,
  renderObservationMarkdown, METRIC_DEFINITIONS, DIRTY_RULES,
} from '../src/observe.js';
import {
  createSoakRunner, buildSoakConfig, judgeGate, writeSoakReport, scenarioFor, SOAK_SCENARIOS,
} from '../src/soak.js';
import {
  tune, tuneHistory, TUNABLE, TuneError, readOverrides, writeOverrides, applyOverrides,
} from '../src/tune.js';
import { loadConfig, EXAMPLE_CONFIG_PATH } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 用仓库内 work/ 而不是系统临时目录：Windows 的 %TEMP% 在 AppData 底下，
// 一旦被清理红线之类的规则扫到会误判（P4 已踩过一次）。
function scratch(t, prefix = 'p5') {
  const base = path.join(ROOT, 'work');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${prefix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freshDb(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

// 跑一段压缩长跑，返回 runner 与观察结果。
async function soakRun(t, { hours = 24, stepMinutes = 60, workRoot = null, config = null } = {}) {
  const root = workRoot ?? scratch(t, 'p5-soak');
  const runner = createSoakRunner({
    workRoot: root,
    config: config ?? buildSoakConfig({ workRoot: root }),
    stepMinutes,
  });
  t.after(() => { try { runner.close(); } catch { /* 已关 */ } });
  const result = await runner.drive({ hours });
  const observation = runner.observation({ mode: 'compressed', hours });
  return { runner, result, observation, root };
}

// ---------- P5-1：五项指标 ----------

test('P5-1 · 五项指标齐全，且每项都带口径说明', async (t) => {
  const { observation } = await soakRun(t, { hours: 24 });
  const m = observation.metrics;
  for (const key of ['falseWake', 'idleRun', 'reportReject', 'guiFailure', 'quotaBurn']) {
    assert.ok(m[key], `缺少指标 ${key}`);
    assert.ok(Object.hasOwn(m[key], 'rate'), `${key} 缺少 rate`);
    assert.ok(METRIC_DEFINITIONS[key], `${key} 缺少口径说明`);
    assert.equal(typeof METRIC_DEFINITIONS[key], 'string');
  }
  // 造了 24 步负载，任务与 Run 必须真的产生，否则指标是空的
  assert.ok(m.runs.total > 0, '没有产生任何 Run');
  assert.ok(m.tasks.total > 0, '没有产生任何任务卡');
  assert.ok(m.reportReject.rejected > 0, '24 步里应至少有一次验收打回样本');
});

test('P5-1 · 观察记录落盘：json / jsonl / markdown 三份都在', async (t) => {
  const { runner, result, observation } = await soakRun(t, { hours: 12 });
  runner.sample('final');
  const dir = scratch(t, 'p5-report');
  const endedAt = new Date().toISOString();
  const gate = judgeGate({
    mode: 'compressed', wallClockHours: 0, wallClockMinutes: 1,
    samples: runner.samples, finalObservation: observation,
  });
  const { dir: out } = writeSoakReport(dir, {
    runId: 'soak-test', mode: 'compressed', hours: 12, stepMinutes: 60,
    startedAt: endedAt, endedAt, samples: runner.samples, observation, gate, errors: result.errors,
  });
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  assert.ok(fs.existsSync(path.join(out, 'samples.jsonl')));
  assert.ok(fs.existsSync(path.join(out, 'report.md')));
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.sampleCount, runner.samples.length);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(md, /五项指标/);
  assert.match(md, /§6C \/ §6D 四项结论/);
});

test('P5-1 · 场景表覆盖正常 / 返工 / 挂起 / 协作 / 会议', () => {
  const kinds = new Set(SOAK_SCENARIOS.map((s) => s.kind));
  for (const expected of ['direct-ok', 'direct-bad', 'direct-hang', 'delegate', 'cowork', 'meeting']) {
    assert.ok(kinds.has(expected), `场景表缺少 ${expected}`);
  }
  assert.equal(scenarioFor(0).kind, 'direct-ok');
  assert.equal(scenarioFor(SOAK_SCENARIOS.length).kind, 'direct-ok', '场景表应循环');
});

// ---------- P5-2：调参与留痕 ----------

test('P5-2 · 调参写审计，旧值新值都查得到', (t) => {
  const db = freshDb(t);
  const config = buildSoakConfig({});
  const runtime = { config, db, overridesPath: null };
  const before = config.quota.warnRatio;

  const result = tune(runtime, { key: 'quota.warnRatio', value: 0.7, reason: '试运行发现预警太晚' });
  assert.equal(result.applied, true);
  assert.equal(result.from, before);
  assert.equal(result.to, 0.7);
  assert.equal(config.quota.warnRatio, 0.7, '调完要立刻生效');

  const history = tuneHistory(db);
  assert.equal(history.length, 1);
  assert.equal(history[0].key, 'quota.warnRatio');
  assert.equal(history[0].from, before);
  assert.equal(history[0].to, 0.7);
  assert.equal(history[0].reason, '试运行发现预警太晚');
});

test('P5-2 · 非法键 / 越界值 / 阈值倒挂 一律拒绝', (t) => {
  const db = freshDb(t);
  const config = buildSoakConfig({});
  const runtime = { config, db, overridesPath: null };
  assert.throws(() => tune(runtime, { key: 'quota.whatever', value: 1 }), TuneError);
  assert.throws(() => tune(runtime, { key: 'quota.warnRatio', value: 5 }), TuneError);
  assert.throws(() => tune(runtime, { key: 'runPolicy.cooldownSec', value: -1 }), TuneError);
  assert.throws(() => tune(runtime, { key: 'agents.nobody.quotaDaily', value: 10 }), TuneError);

  // 阈值不变量双向守护：warnRatio 不能高于 stopRatio，stopRatio 也不能低于 warnRatio。
  // 所以「倒挂」这个状态根本达不成 —— 从任何一侧调都会被另一侧拦住。
  assert.throws(() => tune(runtime, { key: 'quota.stopRatio', value: 0.5 }), TuneError);
  assert.equal(tuneHistory(db).length, 0, '全被拒时不该留审计');
  assert.equal(config.quota.warnRatio, 0.8, '被拒的调整不能改动配置');

  // 合法下调预警线可以成功；此后想把停派线压到它下面，立刻被拦。
  tune(runtime, { key: 'quota.warnRatio', value: 0.5, reason: '测试' });
  assert.throws(() => tune(runtime, { key: 'quota.stopRatio', value: 0.4 }), TuneError);
  assert.equal(config.quota.warnRatio, 0.5);
  assert.equal(config.quota.stopRatio, 1);
  assert.equal(tuneHistory(db).length, 1, '只有那次成功调整该留审计');
});

test('P5-2 · 持久化覆盖层：重载配置后调参仍生效，且不碰 YAML', (t) => {
  const dir = scratch(t, 'p5-tune');
  const overridesPath = path.join(dir, 'runtime-overrides.json');
  const db = freshDb(t);
  const config = buildSoakConfig({});
  tune({ config, db, overridesPath }, { key: 'quota.warnRatio', value: 0.5, reason: '测试' });
  tune({ config, db, overridesPath }, { key: 'agents.worker-01.quotaDaily', value: 7, reason: '测试' });

  const stored = readOverrides(overridesPath);
  assert.equal(stored.quota.warnRatio, 0.5);
  assert.equal(stored.agentQuotaDaily['worker-01'], 7, '席位级额度必须单独存，不能深合并进数组');

  const env = { AICOMPANY_CEO_CMD: 'echo ceo', AICOMPANY_WORKER_CMD: 'echo worker' };
  const { config: reloaded } = loadConfig(EXAMPLE_CONFIG_PATH, env, { overridesPath });
  assert.equal(reloaded.quota.warnRatio, 0.5);
  assert.equal(reloaded.agents.find((a) => a.id === 'worker-01').quotaDaily, 7);
  // 不传覆盖层时应回到配置文件原值
  const { config: plain } = loadConfig(EXAMPLE_CONFIG_PATH, env, { overridesPath: null });
  assert.equal(plain.quota.warnRatio, 0.8);
  assert.equal(plain.agents.find((a) => a.id === 'worker-01').quotaDaily, 20);
});

test('P5-2 · 覆盖层挡掉原型污染键', () => {
  const merged = applyOverrides({ a: 1 }, JSON.parse('{"__proto__":{"polluted":true},"a":2}'));
  assert.equal(merged.a, 2);
  assert.equal({}.polluted, undefined);
});

test('P5-2 · 可调项白名单覆盖 cooldown / 配额 / 挂起时长', () => {
  for (const key of ['runPolicy.cooldownSec', 'quota.warnRatio', 'quota.periodHours', 'decision.maxPendingHours']) {
    assert.ok(TUNABLE[key], `白名单缺少 ${key}`);
  }
});

// ---------- P5-3：四项结论 ----------

test('P5-3 · 四项结论齐全且都有明确判定', async (t) => {
  const { observation } = await soakRun(t, { hours: 24 });
  const f = observation.findings;
  for (const key of ['directBypassesCeo', 'coworkCreatesTask', 'awaitingRerun', 'decisionTimeout']) {
    assert.ok(f[key], `缺少结论 ${key}`);
    assert.ok(['pass', 'fail', 'insufficient', 'attention'].includes(f[key].verdict), `${key} 判定值不合法`);
    assert.equal(typeof f[key].conclusion, 'string');
    assert.ok(f[key].conclusion.length > 0, `${key} 没有结论文字`);
  }
  assert.equal(f.directBypassesCeo.verdict, 'pass', '直投应当绕开 CEO');
  assert.equal(f.coworkCreatesTask.verdict, 'pass', 'cowork 不该建卡');
  assert.equal(f.awaitingRerun.verdict, 'pass', '挂起不该被别的唤醒插进来');
});

test('P5-3 · 挂起后若真被重跑，检查必须报出来', (t) => {
  const db = freshDb(t);
  const config = buildSoakConfig({});
  seedAgents(db, config);
  db.prepare(`INSERT INTO tasks (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt)
    VALUES ('T-x', 'REQ-x', '挂起测试', 'worker-01', 'awaiting_decision', 'direct', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0)`).run();
  db.prepare(`INSERT INTO change_requests (changeRequestId, taskId, runId, agentId, kind, severity, reason, createdAt)
    VALUES ('CR-x', 'T-x', 'R-origin', 'worker-01', 'direction', 'needsDecision', '要拍板', '2026-01-01T01:00:00Z')`).run();
  // 挂起之后又被人派了一次活（wakeReason 不是 decision）——这就是脏
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-bad', 'T-x', 'worker-01', 'issue_assigned', 'success', 1, 1, '2026-01-01T02:00:00Z', '2026-01-01T02:01:00Z')`).run();

  const f = computeInteractionFindings({ db, config });
  assert.equal(f.awaitingRerun.verdict, 'fail');
  assert.equal(f.awaitingRerun.misRuns, 1);
  assert.match(f.awaitingRerun.conclusion, /误跑/);
});

test('P5-3 · 没有样本时给「样本不足」，不假装通过', (t) => {
  const db = freshDb(t);
  const config = buildSoakConfig({});
  seedAgents(db, config);
  const f = computeInteractionFindings({ db, config });
  assert.equal(f.directBypassesCeo.verdict, 'insufficient');
  assert.equal(f.coworkCreatesTask.verdict, 'insufficient');
  assert.equal(f.awaitingRerun.verdict, 'insufficient');
  assert.match(f.directBypassesCeo.conclusion, /样本不足/);
});

// ---------- P5-4：today 席位去留 ----------

test('P5-4 · today 不占席位：示例配置不配它，文档写明结论', () => {
  const yaml = fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  assert.doesNotMatch(yaml, /^\s*-?\s*id:\s*today\s*$/m, '示例配置不该把 today 配成席位');
  assert.match(yaml, /today/, '配置里要留下说明，不能让人以为忘了配');

  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'P5-交付说明.md'), 'utf8');
  assert.match(doc, /today/);
  assert.match(doc, /编制外|不进主任务链路|只读/);
});

// ---------- G-P5：脏状态 ----------

test('G-P5 · 脏状态检查能抓到各类脏数据', (t) => {
  const db = freshDb(t);
  const config = buildSoakConfig({});
  seedAgents(db, config);
  const workRoot = scratch(t, 'p5-dirty');
  const now = new Date('2026-05-01T12:00:00Z');

  // ① 孤儿 Run
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-orphan', 'T-ghost', 'worker-01', 'issue_assigned', 'success', 1, 1, '2026-05-01T10:00:00Z', '2026-05-01T10:01:00Z')`).run();
  // ② 挂死的 Run
  db.prepare(`INSERT INTO tasks (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt)
    VALUES ('T-stuck', 'REQ-stuck', '卡住', 'worker-01', 'in_progress', 'direct', '2026-05-01T01:00:00Z', '2026-05-01T01:00:00Z', 1, 0)`).run();
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-stuck', 'T-stuck', 'worker-01', 'issue_assigned', 'running', 1, 1, '2026-05-01T02:00:00Z', NULL)`).run();
  // ③ 积压事件
  emit(db, { type: 'issue_assigned', taskId: 'T-stuck', agentId: 'worker-01' });
  db.prepare("UPDATE events SET createdAt = '2026-05-01T08:00:00Z' WHERE processed = 0").run();
  // ④ done 但报告文件不在（执行席位）
  db.prepare(`INSERT INTO tasks (taskId, requestId, title, assignee, status, mode, createdAt, updatedAt, revision, attempt)
    VALUES ('T-noreport', 'REQ-nr', '没交报告', 'worker-01', 'done', 'direct', '2026-05-01T01:00:00Z', '2026-05-01T02:00:00Z', 1, 0)`).run();
  db.prepare("INSERT INTO task_payload (taskId, revision, instructions, acceptanceJson, completionReportPath) VALUES ('T-noreport', 1, '', '[]', 'output/completion.json')").run();
  // ⑤ 配额为负
  db.prepare("UPDATE quotas SET used = -3 WHERE agentId = 'worker-01'").run();
  // ⑥ 决策指向不存在的变更请求
  db.prepare(`INSERT INTO decisions (decisionId, changeRequestId, taskId, decidedBy, decision, createdAt)
    VALUES ('DC-1', 'CR-ghost', 'T-stuck', 'human', 'resume', '2026-05-01T03:00:00Z')`).run();
  // ⑦ revision 与版本表不一致
  db.prepare("UPDATE tasks SET revision = 5 WHERE taskId = 'T-stuck'").run();
  db.prepare(`INSERT INTO task_revisions (taskId, revision, instructionsSnapshot, acceptanceSnapshot, approvedBy, createdAt)
    VALUES ('T-stuck', 1, '', '[]', 'human', '2026-05-01T01:00:00Z')`).run();
  // ⑧ 已提升但没归档
  db.prepare(`INSERT INTO threads (threadId, requestId, mode, title, participantsJson, wakePolicy, ceoVisibility, ttlDays, state, createdAt, lastActiveAt, promotedTo)
    VALUES ('TH-1', 'REQ-th', 'cowork', '一起改', '[]', 'readonly', 'none', 30, 'active', '2026-05-01T01:00:00Z', '2026-05-01T01:00:00Z', 'T-noreport')`).run();

  const dirty = detectDirty({ db, config, workRoot, now });
  assert.equal(dirty.clean, false);
  for (const code of ['orphan_run', 'stuck_running', 'stale_event', 'done_without_report',
    'quota_anomaly', 'decision_without_cr', 'revision_gap', 'promoted_not_archived']) {
    assert.ok(dirty.counts[code] >= 1, `没抓到 ${code}，实际：${JSON.stringify(dirty.counts)}`);
  }
  assert.equal(dirty.rules.length, DIRTY_RULES.length);
});

test('G-P5 · 压缩长跑全程零脏状态，但门禁只给「模拟」不给通过', async (t) => {
  const { runner, result, observation } = await soakRun(t, { hours: 48 });
  assert.equal(result.errors.length, 0, `长跑不该报错：${JSON.stringify(result.errors.slice(0, 3))}`);
  assert.ok(runner.samples.length >= 48);
  const dirtySamples = runner.samples.filter((s) => s.dirtyCount > 0);
  assert.equal(dirtySamples.length, 0, `中途出现脏状态：${JSON.stringify(dirtySamples.slice(0, 2))}`);
  assert.equal(observation.dirty.clean, true);

  const gate = judgeGate({
    mode: 'compressed', wallClockHours: 0, wallClockMinutes: 2,
    samples: runner.samples, finalObservation: observation,
  });
  assert.equal(gate.passed, false, '压缩模式绝不能判通过');
  assert.equal(gate.level, 'simulated');
  assert.match(gate.reason, /真实墙钟/);
});

test('G-P5 · 真实墙钟不满 72 小时判「不足」', () => {
  const gate = judgeGate({
    mode: 'real', wallClockHours: 5, samples: [{ dirtyCount: 0 }],
    finalObservation: { dirty: { clean: true } },
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.level, 'insufficient');
});

test('G-P5 · 真实墙钟满 72 小时且零脏才判通过', () => {
  const gate = judgeGate({
    mode: 'real', wallClockHours: 73, samples: [{ dirtyCount: 0 }, { dirtyCount: 0 }],
    finalObservation: { dirty: { clean: true } },
  });
  assert.equal(gate.passed, true);
  assert.equal(gate.level, 'real');
});

test('G-P5 · 真实墙钟跑满但中途脏过，仍然判不通过', () => {
  const gate = judgeGate({
    mode: 'real', wallClockHours: 73, samples: [{ dirtyCount: 0 }, { dirtyCount: 2 }],
    finalObservation: { dirty: { clean: true } },
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.level, 'dirty');
});

// ---------- Run Policy：cooldown 与终态 ----------

function engineFor(t, { cooldownSec = 0, maxConcurrent = 3, workRoot = null } = {}) {
  const root = workRoot ?? scratch(t, 'p5-engine');
  const config = buildSoakConfig({ workRoot: root, cooldownSec, maxConcurrent });
  const db = openDb(':memory:');
  seedAgents(db, config);
  const engine = createEngine({
    db, config, notifier: createNotifier('noop'), workRoot: root,
    now: () => new Date('2026-04-01T00:00:00.000Z'), maxSteps: 100,
  });
  t.after(() => { try { engine.close(); } catch { /* 已关 */ } });
  return { engine, db, config, root };
}

test('Run Policy · cooldown 生效，且被拒后任务退回 todo 等人重投', async (t) => {
  const { engine, db } = engineFor(t, { cooldownSec: 3600 });
  await engine.submit({ requestId: 'REQ-CD-1', text: '[ok] 第一件', mode: 'direct', addressedTo: 'worker-01' });
  await engine.submit({ requestId: 'REQ-CD-2', text: '[ok] 第二件', mode: 'direct', addressedTo: 'worker-01' });

  const rejected = db.prepare("SELECT * FROM audit WHERE action = 'wake_rejected'").all();
  assert.ok(rejected.length >= 1, '第二次唤醒应被冷却拒绝');
  assert.ok(rejected.some((r) => String(r.newValue).includes('|cooldown|')), `冷却未生效：${JSON.stringify(rejected)}`);

  const second = db.prepare("SELECT status FROM tasks WHERE requestId = 'REQ-CD-2'").get();
  assert.equal(second.status, 'todo', '暂时派不出去要退回 todo，不能停在 in_progress');
});

test('Run Policy · 终态任务不再被唤醒，且留痕可查', async (t) => {
  const { engine, db } = engineFor(t);
  await engine.submit({ requestId: 'REQ-TERM-1', text: '[ok] 干完的活', mode: 'direct', addressedTo: 'worker-01' });
  const done = db.prepare("SELECT taskId, assignee FROM tasks WHERE requestId = 'REQ-TERM-1'").get();
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(done.taskId).status, 'done');

  engine.emitEvent({
    type: 'issue_assigned', taskId: done.taskId, agentId: done.assignee,
    payload: { wakeReason: 'issue_assigned' }, dedupeKey: 'probe:1',
  });
  await engine.pump();

  const reject = db.prepare("SELECT * FROM audit WHERE action = 'wake_rejected'").all()
    .find((r) => String(r.newValue).includes('|terminal|'));
  assert.ok(reject, '终态唤醒必须被拒并留痕');
  const runsAfter = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE taskId = ?').get(done.taskId).n;
  assert.equal(runsAfter, 1, '终态后不许再开新 Run');
});

test('Run Policy · 并发上限可配，不再是写死的 3', (t) => {
  const { config } = engineFor(t, { maxConcurrent: 5 });
  assert.equal(config.runPolicy.maxConcurrent, 5);
  assert.equal(config.runPolicy.cooldownSec, 0);
});

// ---------- 观察报告渲染 ----------

test('P5-1 · 报告把口径与结论都印出来，而不是只有数字', async (t) => {
  const { observation } = await soakRun(t, { hours: 12 });
  const md = renderObservationMarkdown(observation);
  assert.match(md, /误唤醒率/);
  assert.match(md, /空转 Run 率/);
  assert.match(md, /报告不合格率/);
  assert.match(md, /GUI 失败率/);
  assert.match(md, /额度消耗/);
  assert.match(md, /直投是否绕开 CEO/);
  assert.match(md, /cowork 是否误建卡/);
  assert.match(md, /挂起是否被误重跑/);
  assert.match(md, /决策超时率/);
  assert.match(md, /脏状态检查/);
});
