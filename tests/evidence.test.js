// 证据层回归（2026-11-18，董事会要求：按 L1→L2→L3 顺序做、全部用模拟席位验证）。
//   L1 启动确认：没有系统级 dispatch 回执 → 不判死，判「没启动」→ 中断并重派一次；
//   L2 活动证据：已启动但长时间没有任何产出痕迹 → 再探证据 → 重派；有 ack/产物就不打扰；
//   L3 升级阶梯：自动重派用尽 → 开处置卡交给上级 agent，验收卡还允许上级代验收。
// 这些行为由 runPolicy.evidenceEnabled 打开，默认关（老配置 / 老测试语义不变）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { writeDispatchReceipt, writeRunHeartbeat, ensureAckTemplate, EVIDENCE_FILES } from '../src/evidence.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(runPolicy) {
  return {
    version: 1,
    company: { name: 'evidence-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {},
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy,
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active', quotaDaily: 30,
        reportsTo: null, adapter: { type: 'mock', config: {} },
      },
      {
        id: 'engineering', displayName: '工程执行', isCEO: false,
        capabilities: ['plan', 'review', 'delegate', 'execute'], status: 'active', quotaDaily: 20,
        reportsTo: 'ceo', escalationTo: 'ceo', adapter: { type: 'mock', config: {} },
      },
      {
        id: 'doubao', displayName: '执行席位', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: 'engineering',
        // 执行席位的处置线就是工程岗（真机配置如此）；测试里显式写出来，别让处置卡越级落到 CEO。
        escalationTo: 'engineering',
        adapter: { type: 'mock', config: {} },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function insertCard(db, {
  taskId = 'T-EV-1', assignee = 'doubao', status = 'in_progress',
  assignedBy = 'engineering', assignerId = 'engineering',
  title = '证据层模拟卡', role = 'work',
} = {}) {
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (taskId, requestId, title, role, assignee, status, mode, addressedTo,
    assignedBy, revision, attempt, priority, difficulty, createdAt, updatedAt, assignerId)
    VALUES (?, ?, ?, ?, ?, ?, 'delegate', 'engineering', ?, 1, 0, 'normal', 'normal', ?, ?, ?)`)
    .run(taskId, 'REQ-EV', title, role, assignee, status, assignedBy, ts, ts, assignerId);
  db.prepare(`INSERT INTO task_payload (taskId, revision, instructions, acceptanceJson, inputJson)
    VALUES (?, 1, '模拟指令', '[]', '{}')`).run(taskId);
  return taskId;
}

function insertRun(db, { runId = 'R-EV-1', taskId = 'T-EV-1', agentId = 'doubao',
  startedAt, wakeReason = 'issue_assigned' } = {}) {
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, startedAt)
    VALUES (?, ?, ?, ?, 'running', 1, ?)`).run(runId, taskId, agentId, wakeReason, startedAt);
  return runId;
}

function audits(db, action) {
  return db.prepare('SELECT * FROM audit WHERE action = ?').all(action);
}

function engineFor(t, { policy, root, doubaoAdapter = {} }) {
  const c = { ...config(policy), workRoot: root };
  // 允许给 doubao 换 adapter 参数（比如 maxMinutes），用来验证「席位预算」这条边界。
  c.agents = c.agents.map((a) => (a.id === 'doubao'
    ? { ...a, adapter: { ...a.adapter, config: { ...a.adapter.config, ...doubaoAdapter } } }
    : a));
  const db = openDb(':memory:');
  const engine = createEngine({
    db, config: c, notifier: createNotifier('noop'), workRoot: root, dispatchMode: 'inline',
    now: () => new Date(clockMs),
  });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  return { engine, db, c };
}

let clockMs = Date.now();

test('L1 · 没有 dispatch 回执 → 判「没启动」，中断并重派（不判死、不等人）', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    policy: { evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 600, maxDispatchAttempts: 3, escalateToBoss: true },
  });
  insertCard(db, { taskId: 'T-EV-L1' });
  insertRun(db, { taskId: 'T-EV-L1', runId: 'R-EV-L1', startedAt: new Date(clockMs - 3 * 60_000).toISOString() });

  await engine.reconcile({ olderThanMs: 60_000 });

  const run = db.prepare('SELECT status, interruptedReason FROM runs WHERE runId = ?').get('R-EV-L1');
  assert.equal(run.status, 'interrupted', '没有启动回执的 run 必须被中断收账，不能一直占着 running');
  assert.match(String(run.interruptedReason), /启动回执/);
  assert.equal(audits(db, 'redispatch_no_dispatch').length, 1);
  const ev = db.prepare(`SELECT payloadJson FROM events WHERE taskId = 'T-EV-L1' AND type = 'issue_assigned'`).all();
  assert.ok(ev.some((x) => String(x.payloadJson).includes('redispatch')), '必须留下一条重派事件，让泵真的再派一次');
});

test('L2 · 已启动但一直没有产出痕迹 → 重派；有 ack + 产物 → 不打扰', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    policy: { evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 60, maxDispatchAttempts: 3, escalateToBoss: true },
  });
  // 卡 A：已启动，但什么都没写 → 耐心 = idle 的一半（30s），2 分钟后必须重派。
  insertCard(db, { taskId: 'T-EV-L2A' });
  insertRun(db, { taskId: 'T-EV-L2A', runId: 'R-EV-L2A', startedAt: new Date(clockMs - 2 * 60_000).toISOString() });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-L2A', runId: 'R-EV-L2A', via: 'test' });
  // 预置模板没改 → 不算回执（不能靠模板白拿耐心）。
  ensureAckTemplate({ workRoot: root, taskId: 'T-EV-L2A', runId: 'R-EV-L2A' });

  // 卡 B：同一时刻已启动，但 agent 改了回执、还有新鲜产物 → 不该被打扰。
  insertCard(db, { taskId: 'T-EV-L2B' });
  insertRun(db, { taskId: 'T-EV-L2B', runId: 'R-EV-L2B', startedAt: new Date(clockMs - 2 * 60_000).toISOString() });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-L2B', runId: 'R-EV-L2B', via: 'test' });
  fs.writeFileSync(path.join(root, 'tasks', 'T-EV-L2B', EVIDENCE_FILES.ack), '收到｜预计 20 分钟｜我的理解：先拆方案\n', 'utf8');
  fs.mkdirSync(path.join(root, 'tasks', 'T-EV-L2B', 'output'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'T-EV-L2B', 'output', 'plan.md'), '# 方案\n', 'utf8');

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-L2A').status, 'interrupted');
  assert.equal(audits(db, 'redispatch_no_evidence').length, 1);
  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-L2B').status, 'running',
    '有回执 + 有新产物的 run 必须继续跑，不能被误杀');
});

// 2026-11-19 真机误伤（T-6493fc51）回归：doubao 那趟 dispatch✓ heartbeat✓、7.9 分钟没写 progress，
// 被按「无 ack 耐心减半」砍掉；重派那一趟 3 分钟就干完了 —— 说明第一趟本来就在干。
// 结论：心跳还在的时候不许重派（重派 = 同一件活干两遍）。
test('L2b · 心跳还在 → 不重派，只记一条「看见了但没动手」', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    policy: {
      evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 60,
      maxDispatchAttempts: 3, escalateToBoss: true,
      heartbeatGraceSec: 180, seatBudgetSlackSec: 120,
    },
  });
  insertCard(db, { taskId: 'T-EV-HB', assignee: 'doubao' });
  insertRun(db, {
    taskId: 'T-EV-HB', runId: 'R-EV-HB',
    startedAt: new Date(clockMs - 10 * 60_000).toISOString(),
  });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-HB', runId: 'R-EV-HB', via: 'test' });
  // adapter 仍在轮询：心跳是三十秒前写的（远新于 heartbeatGraceSec=180s）
  writeRunHeartbeat({
    workRoot: root, taskId: 'T-EV-HB', runId: 'R-EV-HB', polls: 20,
    at: new Date(clockMs - 30_000).toISOString(),
  });

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-HB').status, 'running',
    '心跳还在的这趟必须继续跑：它只是没写盘，不是宕机');
  assert.equal(audits(db, 'redispatch_no_evidence').length, 0, '不许重派（重派会把同一件活干两遍）');
  assert.equal(audits(db, 'stall_wait_heartbeat').length, 1, '必须留一条「看见了但没动手」的账');
});

test('L2c · 心跳也不新鲜了 → 回到老逻辑：探不到证据就重派', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    policy: {
      evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 60,
      maxDispatchAttempts: 3, escalateToBoss: true,
      heartbeatGraceSec: 180, seatBudgetSlackSec: 120,
    },
  });
  insertCard(db, { taskId: 'T-EV-HB2', assignee: 'doubao' });
  insertRun(db, {
    taskId: 'T-EV-HB2', runId: 'R-EV-HB2',
    startedAt: new Date(clockMs - 10 * 60_000).toISOString(),
  });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-HB2', runId: 'R-EV-HB2', via: 'test' });
  // 心跳是十分钟前的（早就过期）：说明 adapter 已经不轮询这一趟了
  writeRunHeartbeat({
    workRoot: root, taskId: 'T-EV-HB2', runId: 'R-EV-HB2', polls: 3,
    at: new Date(clockMs - 10 * 60_000).toISOString(),
  });

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-HB2').status, 'interrupted');
  assert.equal(audits(db, 'redispatch_no_evidence').length, 1);
});

test('L2d · 心跳在、但跑穿了席位自己的 maxMinutes → 不重派，直接向上收束', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    doubaoAdapter: { maxMinutes: 5 },
    policy: {
      evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 60,
      maxDispatchAttempts: 3, escalateToBoss: true,
      heartbeatGraceSec: 180, seatBudgetSlackSec: 120,
    },
  });
  insertCard(db, { taskId: 'T-EV-HB3', assignee: 'doubao' });
  // 预算 5 分钟 + 宽限 2 分钟 = 7 分钟；这趟已经跑了 12 分钟，心跳还在。
  insertRun(db, {
    taskId: 'T-EV-HB3', runId: 'R-EV-HB3',
    startedAt: new Date(clockMs - 12 * 60_000).toISOString(),
  });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-HB3', runId: 'R-EV-HB3', via: 'test' });
  writeRunHeartbeat({
    workRoot: root, taskId: 'T-EV-HB3', runId: 'R-EV-HB3', polls: 60,
    at: new Date(clockMs - 20_000).toISOString(),
  });

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-HB3').status, 'interrupted',
    '超预算的那趟必须收账，不能继续占并发');
  assert.equal(audits(db, 'redispatch_no_evidence').length, 0, '超预算不是「再派一次」能解决的，不许重派');
  assert.equal(audits(db, 'evidence_escalated').length, 1, '必须向上收束，让上级 agent 去看');
  // 只看这张卡自己的处置链（inline 派发下 mock 席位会连带再开一串上级处置卡，那是另一条链路的事）。
  const escs = db.prepare(`SELECT * FROM tasks WHERE role = 'escalation' AND parentTaskId = ?`).all('T-EV-HB3');
  assert.ok(escs.length >= 1, '必须真的开一张处置卡');
  // 汇报方向钉死在审计里：doubao → engineering（不许越级跳过 CTO 直接找 CEO）。
  const reported = audits(db, 'reported_upward').map((a) => String(a.newValue));
  assert.ok(reported.some((v) => v.startsWith('doubao→engineering')), `汇报必须沿汇报线走：${reported.join(' / ')}`);
});

test('L2e · 没有心跳、也没有 ack，但席位预算是一小时 → 前 30 分钟不许掀翻', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    doubaoAdapter: { maxMinutes: 60 },
    policy: {
      evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 900,
      maxDispatchAttempts: 3, escalateToBoss: true,
      heartbeatGraceSec: 600, seatBudgetSlackSec: 300,
    },
  });
  // 25 分钟的活，什么都没写、心跳也停了（等一次长模型回复时就是这状态）→ 仍在预算一半（30 分钟）内，不许动。
  insertCard(db, { taskId: 'T-EV-P25', assignee: 'doubao' });
  insertRun(db, {
    taskId: 'T-EV-P25', runId: 'R-EV-P25',
    startedAt: new Date(clockMs - 25 * 60_000).toISOString(),
  });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-P25', runId: 'R-EV-P25', via: 'test' });

  // 35 分钟了还在同一个状态 → 超过耐心，该重派。
  insertCard(db, { taskId: 'T-EV-P35', assignee: 'doubao' });
  insertRun(db, {
    taskId: 'T-EV-P35', runId: 'R-EV-P35',
    startedAt: new Date(clockMs - 35 * 60_000).toISOString(),
  });
  writeDispatchReceipt({ workRoot: root, taskId: 'T-EV-P35', runId: 'R-EV-P35', via: 'test' });

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-P25').status, 'running',
    '一小时预算的席位，25 分钟没动静还在耐心区里（老逻辑 7.5 分钟就砍了）');
  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-P35').status, 'interrupted',
    '过了耐心（30 分钟）仍无痕迹 → 该重派');
});

test('L3 · 重派用尽 → 开处置卡给上级；验收卡允许上级代验收', async (t) => {  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    policy: { evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 60, maxDispatchAttempts: 1, escalateToBoss: true },
  });
  // 先记一次已经重派过的账（= 额度用完）。
  db.prepare(`INSERT INTO audit (auditId, actor, action, newValue, taskId, createdAt)
    VALUES ('A-pre', 'control-plane', 'redispatch_no_evidence', 'T-EV-L3|第 1 次', 'T-EV-L3', ?)`).run(new Date(clockMs).toISOString());
  insertCard(db, { taskId: 'T-EV-L3', assignee: 'engineering', status: 'in_review', assignedBy: 'ceo', assignerId: 'ceo' });
  insertRun(db, {
    taskId: 'T-EV-L3', runId: 'R-EV-L3', agentId: 'engineering',
    startedAt: new Date(clockMs - 5 * 60_000).toISOString(), wakeReason: 'review_requested',
  });

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(audits(db, 'evidence_escalated').length, 1, '用尽自动手段必须留一条升级审计');
  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-L3').status, 'interrupted',
    '升级时那趟假跑的 run 必须先收账，不能一直占着 running');
  const esc = db.prepare("SELECT * FROM tasks WHERE role = 'escalation'").get();
  assert.ok(esc, '必须真的开一张处置卡，而不是只写日志');
  assert.equal(esc.assignee, 'ceo', '处置卡交汇报线上的上级（这里是总经理）');
  assert.equal(esc.parentTaskId, 'T-EV-L3');
  const payload = db.prepare('SELECT instructions FROM task_payload WHERE taskId = ? AND revision = 1').get(esc.taskId);
  assert.match(String(payload.instructions), /代验收/, '验收卡的处置卡必须写明「可以代验收」的合法出口');
});

test('L3b · maxDispatchAttempts=2 是「一共派 2 次」：第二次失败就升级，并且卡进入等上级状态', async (t) => {
  clockMs = Date.now();
  const root = tmpDir(t);
  const { engine, db } = engineFor(t, {
    root,
    policy: { evidenceEnabled: true, ackTimeoutSec: 5, idleTimeoutSec: 60, maxDispatchAttempts: 2, escalateToBoss: true },
  });
  db.prepare(`INSERT INTO audit (auditId, actor, action, newValue, taskId, createdAt)
    VALUES ('A-pre2', 'control-plane', 'redispatch_no_dispatch', 'T-EV-L3B|第 1 次派单', 'T-EV-L3B', ?)`)
    .run(new Date(clockMs).toISOString());
  insertCard(db, { taskId: 'T-EV-L3B', assignee: 'doubao', status: 'in_progress' });
  insertRun(db, { taskId: 'T-EV-L3B', runId: 'R-EV-L3B', startedAt: new Date(clockMs - 3 * 60_000).toISOString() });

  await engine.reconcile({ olderThanMs: 60_000 });

  assert.equal(db.prepare('SELECT status FROM runs WHERE runId = ?').get('R-EV-L3B').status, 'interrupted');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-EV-L3B').status, 'blocked',
    '执行卡升级后必须进入等上级处置，不能留在 todo 被常规补投反复派');
  assert.equal(audits(db, 'evidence_escalated').length, 1);
  const esc = db.prepare("SELECT * FROM tasks WHERE role = 'escalation' AND parentTaskId = 'T-EV-L3B'").get();
  assert.ok(esc, '必须开一张处置卡');
});


