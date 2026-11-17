// P4 验收：配额阈值 / 三道门禁 / 汇报线 / 查询 / 升级规则 / 可选通道 /
// §6C 完整档 / §6D 完整档 / 循环 L3 + 清理红线 / G-P4 门禁。
// 逐条对齐 docs/开发清单.md 的 P4-1 ~ P4-9。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, transition } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { createRecurring } from '../src/recurring.js';
import { validate } from '../src/validate.js';
import { applyConfigRules } from '../src/config.js';
import { quotaState, periodKey } from '../src/quota.js';
import { isInSubtree, resolveDecisionMaker, assertMayAssign } from '../src/org.js';
import { createChannels } from '../src/channels.js';
import { cleanupScan, CleanupRefused } from '../src/cleanup.js';
import { nowIso } from '../src/ids.js';

const completion = (ctx, extra = {}) => ({
  schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(), ...extra,
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 清理红线的用例不能拿系统临时目录当「安全目录」：Windows 的 %TEMP% 就在 AppData 底下，
// 本来命中敏感规则。这里改用仓库内 work/（.gitignore 已忽略）。
function safeScratchDir(t) {
  const base = path.resolve('work');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'p4-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config({ gates = {}, autoAssign = false, seats = null, workRoot = null } = {}) {
  const agents = seats ?? [
    {
      id: 'ceo', displayName: '总经理', isCEO: true,
      capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active', quotaDaily: 30,
      reportsTo: null, adapter: { type: 'mock', config: {} },
    },
    {
      id: 'lead', displayName: '组长', isCEO: false,
      capabilities: ['plan', 'review', 'delegate', 'execute'], status: 'active', quotaDaily: 20,
      reportsTo: 'ceo', adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'lead', escalationTo: 'worker-02',
      adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-02', displayName: '救火席位', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'ceo',
      adapter: { type: 'mock', config: {} },
    },
  ];
  return {
    version: 1,
    workRoot,
    company: { name: 'p4-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates,
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: {
      defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign,
      meeting: { defaultStyle: 'rollCall', fullRequiresConfirm: true },
      thread: { ttlDays: 30, promoteRequiresExplicit: true },
    },
    agents,
    clients: ['web'], notifier: ['noop'],
  };
}

function engineFor(t, {
  cfg = config(), workerResult = (ctx) => completion(ctx), ceoResult = null,
  now = () => new Date('2026-01-01T00:00:00.000Z'), notifier = null, workRoot = null, db = null,
} = {}) {
  const root = workRoot ?? tmpDir(t);
  const c = { ...cfg, workRoot: cfg.workRoot ?? root };
  // 协作空间的唤醒没有任务卡（ctx.task === null），返回值是一句话而不是完成报告；
  // mock 必须区分这两种上下文，否则 rollCall 会被 CompletionReport 校验直接打回。
  const asThreadReply = (text) => ({ type: 'message', text });
  for (const agent of c.agents) {
    if (agent.id === 'worker-01' || agent.id === 'worker-02') {
      agent.adapter = {
        type: 'mock',
        config: { result: (ctx) => (ctx.task ? workerResult(ctx) : asThreadReply(`${ctx.agent.id} 已发言`)) },
      };
    }
    if (agent.adapter.type === 'mock' && (agent.id === 'ceo' || agent.id === 'lead')) {
      agent.adapter = {
        type: 'mock',
        config: {
          result: ceoResult ?? ((ctx) => (ctx.task === null
            ? asThreadReply(`${ctx.agent.id} 汇总：已看过`)
            : (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '通过' }
              : { type: 'task-create', title: '子任务', assignee: 'worker-01' }))),
        },
      };
    }
  }
  const database = db ?? openDb(':memory:');
  const engine = createEngine({
    db: database, config: c, notifier: notifier ?? createNotifier('web'), now, workRoot: root,
  });
  t.after(() => { try { database.close(); } catch { /* already closed */ } });
  return { engine, db: database, cfg: c, root };
}

// ---------------------------------------------------------------- P4-1

test('P4-1 · 80% 预警只发一次，100% 停派并通知', async (t) => {
  const { engine, db } = engineFor(t, {
    cfg: config({
      seats: [
        { id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 20, reportsTo: null, adapter: { type: 'mock', config: {} } },
        { id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 5, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
        { id: 'worker-02', displayName: '执行二席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
      ],
    }),
  });
  for (let i = 0; i < 4; i += 1) {
    await engine.submit({ requestId: `REQ-Q-${i}`, text: '干活', mode: 'direct', addressedTo: 'worker-01' });
  }
  const warns = engine.getAudit().filter((a) => a.action === 'quota_warning');
  assert.equal(warns.length, 1, '80% 只预警一次');
  assert.ok(engine.notifier.messages.some((m) => m.scene === 'quota'), '预警要出通知卡片');

  await engine.submit({ requestId: 'REQ-Q-5', text: '再干', mode: 'direct', addressedTo: 'worker-01' });
  const state = quotaState(db, 'worker-01', { now: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(state.used >= state.limit, true, '额度已触顶');
  assert.throws(
    () => engine.route({ requestId: 'REQ-Q-6', mode: 'direct', addressedTo: 'worker-01' }),
    /配额触顶|停止派活/,
  );
  assert.ok(engine.getAudit().some((a) => a.action === 'quota_exhausted'));
  assert.ok(engine.notifier.messages.some((m) => m.scene === 'quota' && /触顶/.test(m.title)));
});

test('P4-1 · 周期重置自动开新账，人工 reset 立刻恢复', async (t) => {
  let clock = new Date('2026-01-01T10:00:00.000Z');
  const { engine, db } = engineFor(t, {
    now: () => clock,
    cfg: config({
      seats: [
        { id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 20, reportsTo: null, adapter: { type: 'mock', config: {} } },
        { id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 2, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
      ],
    }),
  });
  assert.equal(periodKey(clock), '2026-01-01');
  db.prepare("UPDATE quotas SET used = limitUnits WHERE agentId = 'worker-01'").run();
  clock = new Date('2026-01-02T10:00:00.000Z');
  assert.equal(periodKey(clock), '2026-01-02');
  await engine.submit({ requestId: 'REQ-Q-NEXT', text: '新的一天', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare("SELECT status FROM tasks WHERE requestId = 'REQ-Q-NEXT'").get().status, 'done');

  db.prepare("UPDATE quotas SET used = limitUnits WHERE agentId = 'worker-01' AND period = '2026-01-02'").run();
  assert.throws(() => engine.route({ requestId: 'REQ-Q-BLOCK', mode: 'direct', addressedTo: 'worker-01' }), /配额/);
  const reset = engine.resetQuota('worker-01');
  assert.equal(reset.reset, true);
  const routed = engine.route({ requestId: 'REQ-Q-RESET', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(routed.target, 'worker-01');
});

// ---------------------------------------------------------------- P4-2

test('P4-2 · 战略门禁：通过才派活，重写打回，驳回取消', async (t) => {
  const { engine, db } = engineFor(t, { cfg: config({ gates: { strategy: true } }) });
  const submitted = await engine.submit({ requestId: 'REQ-GATE', text: '拆活', mode: 'delegate' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, '门禁未过不建子卡');
  const pending = engine.getApprovals({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'strategy');
  assert.ok(engine.notifier.messages.some((m) => m.kind === 'approval'), '要有出站审批卡片');

  engine.decideApproval(pending[0].approvalId, { decision: 'approved', decidedBy: 'boss' });
  await engine.pump();
  const child = db.prepare('SELECT * FROM tasks WHERE parentTaskId = ?').get(submitted.taskId);
  assert.ok(child, '通过后才建子卡');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(submitted.taskId).status, 'done');
});

test('P4-2 · 战略门禁要求重写 → CEO 返工；驳回 → 原卡取消', async (t) => {
  const { engine, db } = engineFor(t, { cfg: config({ gates: { strategy: true } }) });
  const r1 = await engine.submit({ requestId: 'REQ-GATE-RW', text: '拆活', mode: 'delegate' });
  const ap1 = engine.getApprovals({ status: 'pending' })[0];
  engine.decideApproval(ap1.approvalId, { decision: 'rewrite', decidedBy: 'boss', reason: '目标不清' });
  await engine.pump();
  assert.ok(engine.getAudit().some((a) => a.action === 'approval_rewrite'));
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r1.taskId).status, 'in_progress');
  assert.equal(engine.getRuns().filter((x) => x.wakeReason === 'rework').length, 1);

  const r2 = await engine.submit({ requestId: 'REQ-GATE-RJ', text: '再拆', mode: 'delegate' });
  // 上一张卡的返工也会再产生一条策略审批，必须按 taskId 认领，不能拿「第一条 pending」凑。
  const ap2 = engine.getApprovals({ status: 'pending' }).find((a) => a.taskId === r2.taskId);
  engine.decideApproval(ap2.approvalId, { decision: 'rejected', decidedBy: 'boss' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r2.taskId).status, 'cancelled');
});

test('P4-2 · 验收打回门禁：通过=返工，重写=换人，驳回=放弃', async (t) => {
  const failing = (ctx) => completion(ctx, { status: 'failed', reason: '不合格' });
  // 这条走「连续不合格 → 出人审卡」的路径：worker-01 不配 escalationTo，
  // 否则会先被救火席位接走（那是 P4-5 的规则），到不了人审。
  const { engine, db } = engineFor(t, {
    workerResult: failing,
    cfg: config({
      seats: [
        { id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 30, reportsTo: null, adapter: { type: 'mock', config: {} } },
        { id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
        { id: 'worker-02', displayName: '执行二席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
      ],
    }),
  });
  const r = await engine.submit({ requestId: 'REQ-RJ', text: '会失败', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'blocked');
  const ap = engine.getApprovals({ status: 'pending' }).find((a) => a.kind === 'review_reject');
  assert.ok(ap, '连续不合格要出人审卡');

  engine.decideApproval(ap.approvalId, { decision: 'rewrite', decidedBy: 'boss' });
  await engine.pump();
  assert.equal(db.prepare('SELECT assignee FROM tasks WHERE taskId = ?').get(r.taskId).assignee, 'worker-02', '换人：优先 escalationTo，没配就挑配额最足的其他人');
});

test('P4-2 · hiring_budget 审批只记录结论，不改任务', async (t) => {
  const { engine } = engineFor(t);
  const ap = engine.requestApproval({ kind: 'hiring_budget', title: '招一个席位', body: '预算 1 人' });
  const out = engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'boss' });
  assert.equal(out.applied, false);
  assert.equal(engine.getApprovals({ status: 'approved' }).length, 1);
  assert.throws(() => engine.decideApproval(ap.approvalId, { decision: 'approved' }), /已处理/);
});

// ---------------------------------------------------------------- P4-3

test('P4-3 · 组织树：子树判定、跨子树拒绝、决策者由汇报线解析', () => {
  const cfg = config({ autoAssign: false, seats: [
    { id: 'ceo', displayName: 'CEO', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', reportsTo: null, adapter: { type: 'mock', config: {} } },
    { id: 'lead', displayName: '组长', isCEO: false, capabilities: ['plan', 'review'], status: 'active', reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
    { id: 'w1', displayName: '一席', isCEO: false, capabilities: ['execute'], status: 'active', reportsTo: 'lead', adapter: { type: 'mock', config: {} } },
    { id: 'w2', displayName: '二席', isCEO: false, capabilities: ['execute'], status: 'active', reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
  ] });
  assert.equal(isInSubtree(cfg, 'lead', 'w1'), true);
  assert.equal(isInSubtree(cfg, 'lead', 'w2'), false);
  assert.equal(assertMayAssign(cfg, 'lead', 'w2').ok, false);
  assert.match(assertMayAssign(cfg, 'lead', 'w2').reason, /子树/);
  assert.equal(resolveDecisionMaker(cfg, 'w1'), 'lead');
  assert.equal(resolveDecisionMaker(cfg, 'lead'), 'ceo');

  const looped = { ...cfg, agents: cfg.agents.map((a) => (a.id === 'ceo' ? { ...a, reportsTo: 'lead' } : a)) };
  assert.ok(applyConfigRules(looped).some((e) => /成环/.test(e)), '汇报线成环必须拒绝');
});

test('P4-3 · 跨子树派活被引擎拒绝（derive 出口走到别的子树）', async (t) => {
  const seats = [
    { id: 'ceo', displayName: 'CEO', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 30, reportsTo: null, adapter: { type: 'mock', config: {} } },
    { id: 'lead', displayName: '组长', isCEO: false, capabilities: ['plan', 'review', 'execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
    { id: 'w1', displayName: '一席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'lead', adapter: { type: 'mock', config: {} } },
    { id: 'w2', displayName: '二席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
  ];
  const { engine, db } = engineFor(t, { cfg: config({ seats }) });
  const r = engine.route({ requestId: 'REQ-XTREE', text: '跨树', mode: 'direct', addressedTo: 'w1' });
  db.prepare('DELETE FROM events').run();
  transition(db, r.taskId, 'in_progress');
  engine.submitChangeRequest({
    changeRequestId: 'CR-XTREE', taskId: r.taskId, runId: 'R-1', agentId: 'w1',
    kind: 'direction', severity: 'needsDecision', reason: '方向变了', doneSoFar: {},
  });
  await assert.rejects(
    () => engine.submitDecision({
      changeRequestId: 'CR-XTREE', taskId: r.taskId, decidedBy: 'lead',
      decision: 'derive', deriveAssignee: 'w2', needsHumanApproval: false, reason: '换人另起一件',
    }),
    /子树/,
  );
});

// ---------------------------------------------------------------- P4-4

test('P4-4 · Activity 时间线可追 runId / revision；查询接口可过滤', async (t) => {
  const { engine } = engineFor(t);
  const r = await engine.submit({ requestId: 'REQ-ACT', text: '查账', mode: 'delegate' });
  const activity = engine.getActivity(r.taskId);
  assert.ok(activity.runs.length >= 1);
  assert.ok(activity.audit.length >= 1);
  assert.equal(activity.task.taskId, r.taskId);
  const run = activity.runs[0];
  assert.equal(run.revision, 1, 'Run 记自己按哪版跑');
  assert.ok(activity.audit.some((a) => a.runId === run.runId), '审计可按 runId 串起来');
});

test('P4-4 · HTTP：runs / audit / activity / dashboard / quotas 全部可查', async (t) => {
  const { engine, db } = engineFor(t);
  const server = createServer({ engine, port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const r = await (await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'REQ-API-P4', text: '查询', mode: 'delegate' }),
  })).json();
  const runs = await (await fetch(`${base}/api/runs?taskId=${r.taskId}`)).json();
  assert.ok(runs.length >= 1);
  assert.equal(runs.every((x) => x.taskId === r.taskId), true);
  const audit = await (await fetch(`${base}/api/audit?action=wake`)).json();
  assert.ok(audit.length >= 1);
  const activity = await (await fetch(`${base}/api/activity?taskId=${r.taskId}`)).json();
  assert.equal(activity.task.taskId, r.taskId);
  const dash = await (await fetch(`${base}/api/dashboard`)).json();
  assert.ok(Array.isArray(dash.quotas));
  assert.equal(typeof dash.pendingApprovals, 'number');
  const quotas = await (await fetch(`${base}/api/quotas`)).json();
  assert.ok(quotas.length >= 4);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /审批 · Approvals/);
  assert.match(html, /运行与审计 · Activity/);
});

// ---------------------------------------------------------------- P4-5

test('P4-5 · 返工 2 次转 escalationTo 救火席位（配置决定，不写死）', async (t) => {
  const ceoReject = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'reject', reason: '不满意' }
    : { type: 'task-create', title: '子任务', assignee: 'worker-01' });
  const { engine, db } = engineFor(t, { ceoResult: ceoReject, workerResult: (ctx) => completion(ctx) });
  await engine.submit({ requestId: 'REQ-ESC', text: '反复返工', mode: 'delegate' });
  const escalated = engine.getAudit().filter((a) => a.action === 'escalate_to_rescue');
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].newValue, 'worker-02');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'worker-02'").get().n, 1);
});

test('P4-5 · 连续不合格转救火席位时必须把卡打回 todo（T-465c3869 死锁回归）', async (t) => {
  // 复刻事故：worker-01 连续两次交不合格报告 → 卡转 blocked → 转救火席位。
  // 旧代码用转 blocked **之前**的任务快照判断「是否 blocked」，恒为假 → 卡停在 blocked，
  // 而救火席位只领 todo 卡 → 死锁，永远无人接手。
  const badThenGood = (ctx) => (ctx.agent.id === 'worker-01'
    ? { ...completion(ctx), status: 'failed', reason: '模拟不合格报告' }
    : completion(ctx));
  const ceoPass = (ctx) => (ctx.task === null
    ? { type: 'message', text: 'ceo 已看过' }
    : (ctx.wakeReason === 'review_requested'
      ? { type: 'review', verdict: 'pass', reason: '通过' }
      : { type: 'task-create', title: '子任务', assignee: 'worker-01' }));
  const { engine, db } = engineFor(t, { workerResult: badThenGood, ceoResult: ceoPass });
  const r = await engine.submit({ requestId: 'REQ-DEADLOCK', text: '连续不合格转救火', mode: 'delegate' });

  // CEO 拆出的子卡才是执行卡：连续两次不合格 → 转救火席位 + 打回 todo
  const child = db.prepare('SELECT * FROM tasks WHERE parentTaskId = ?').get(r.taskId);
  assert.ok(child, 'CEO 拆出了执行子卡');
  assert.equal(child.assignee, 'worker-02', '连续两次不合格后转救火席位');
  assert.notEqual(child.status, 'blocked', '救火接手后卡不能停在 blocked（旧代码死锁在此）');

  await engine.pump();
  await engine.pump();
  const after = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(child.taskId);
  assert.equal(after.status, 'done', '救火席位能真正接手并收束（旧代码会永远卡死在 blocked）');
});

test('P4-5 · CEO 打回必须把意见传给执行人，不能只说「重做」（T-906d3686 事故回归）', async (t) => {
  // 事故：CEO 判定 reject 并写了意见，但引擎只发了 `{ wakeReason: 'rework' }`——
  // 意见既没进事件、也没落审计、也没进提示词，执行人被重新叫起来后不知道该改什么。
  const ceoReject = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'reject', reason: '第三条验收没给证据' }
    : { type: 'task-create', title: '子任务', assignee: 'worker-01' });
  const { engine } = engineFor(t, { ceoResult: ceoReject, workerResult: (ctx) => completion(ctx) });
  await engine.submit({ requestId: 'REQ-NOTE', text: '带意见打回', mode: 'delegate' });

  const rework = engine.getEvents()
    .filter((e) => e.type === 'issue_assigned' && JSON.parse(e.payloadJson).wakeReason === 'rework');
  assert.ok(rework.length >= 1, '打回要重新派活');
  assert.match(String(JSON.parse(rework[0].payloadJson).reviewNote ?? ''), /第三条验收没给证据/,
    '打回事件要把 CEO 的意见带下去，否则执行人只能猜');

  const audited = engine.getAudit().filter((a) => a.action === 'review_rework');
  assert.ok(audited.length >= 1, '打回动作要留痕');
  assert.match(String(audited[0].newValue), /第三条验收没给证据/, '留痕里要写清为什么打回');
});

test('P4-3 · 交付成功后「连续不合格」计数归零，且打回记录挂在卡上（T-906d3686 事故回归）', async (t) => {
  // 事故：计数只在转救火时清零，成功交付从不清零 → 「连续两次」实际是「累计两次」。
  // 一次早期超时（no_draft）之后，返工时任何一次小磕碰都直接判 blocked + 转救火。
  let calls = 0;
  const workerResult = (ctx) => {
    calls += 1;
    return calls === 1 ? { status: 'success' } : completion(ctx); // 第一次交个不合规的报告
  };
  const { engine, db } = engineFor(t, { workerResult });
  const r = await engine.submit({ requestId: 'REQ-ATTEMPT', text: '先错后对', mode: 'delegate' });

  const rejected = engine.getAudit().filter((a) => a.action === 'report_rejected');
  assert.equal(rejected.length, 1, '第一次不合格要留痕');
  assert.ok(rejected[0].taskId, '打回记录必须挂在卡上：不挂卡就按卡查不到，看板只能说「没说原因」');

  const child = db.prepare('SELECT taskId, attempt, status FROM tasks WHERE parentTaskId = ?').get(r.taskId);
  assert.equal(child.status, 'done', '重试成功后正常收单');
  assert.equal(child.attempt, 0, '成功交付后计数要归零；不清零会让「连续」变成「累计」');
});

test('P4-5 · escalationTo 指向不存在 / 自己时配置直接拒绝', () => {
  const cfg = config();
  const missing = { ...cfg, agents: cfg.agents.map((a) => (a.id === 'worker-01' ? { ...a, escalationTo: 'nobody' } : a)) };
  assert.ok(applyConfigRules(missing).some((e) => /escalationTo/.test(e)));
  const self = { ...cfg, agents: cfg.agents.map((a) => (a.id === 'worker-01' ? { ...a, escalationTo: 'worker-01' } : a)) };
  assert.ok(applyConfigRules(self).some((e) => /不能指向自己/.test(e)));
});

// ---------------------------------------------------------------- P4-6

test('P4-6 · 通道按配置：web/noop 零凭据可跑，im 缺地址明确失败', () => {
  const web = createChannels(['web']);
  web.send({ title: 'x' });
  assert.equal(web.messages.length, 1);
  assert.throws(() => createChannels(['im'], { env: {} }), /缺少地址/);
  const posted = [];
  const im = createChannels(['im'], {
    env: { AICOMPANY_IM_WEBHOOK_URL: 'http://example.invalid/hook' },
    fetchImpl: (url, init) => { posted.push({ url, init }); return Promise.resolve({ ok: true }); },
  });
  im.send({ title: '出站' });
  assert.equal(posted.length, 1);
  assert.match(posted[0].init.body, /出站/);
});

test('P4-6 · 禁用全部非 web 通道后，最小闭环 + 循环任务仍全绿', async (t) => {
  const { engine, db, cfg } = engineFor(t);
  const notifier = createNotifier(cfg.notifier);
  assert.equal(notifier.kind, 'noop');
  const r = await engine.submit({ requestId: 'REQ-NOCHAN', text: '无通道也要跑', mode: 'delegate' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');

  const rec = createRecurring({ db, notifier });
  const job = {
    schema: 'aicompany.recurring/v1', jobId: 'JOB-NOCHAN', jobVersion: 1,
    title: '巡检', kind: 'inspection', owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', timezone: 'UTC' },
    misfirePolicy: 'run_once', misfireGraceMin: 720, overlapPolicy: 'skip',
    termination: { validUntil: null, maxCycles: 5, pauseOnConsecutiveFailures: 3, budgetTotal: { quotaUnits: 10 } },
    requiresHumanEachCycle: false,
    taskTemplate: { role: 'general', instructions: '巡检', acceptance: ['ok'], completionReportPath: 'output/completion.json' },
    carryOver: { enabled: true, maxItems: 10, injectField: 'input.previousFindings' },
    dedupeWindowMin: 1, lastCycleNo: 0,
  };
  rec.registerJob(job);
  const fired = rec.fire({ jobId: 'JOB-NOCHAN', scheduledAt: '2026-01-02T09:00:00.000Z', now: '2026-01-02T09:00:00.000Z' });
  assert.equal(fired.created, true);
  await engine.pump();
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(fired.taskId).status, 'done');
});

// ---------------------------------------------------------------- P4-7

test('P4-7 · 会议三档：readonly 0 唤醒 / rollCall 点名 / full 必须二次确认', async (t) => {
  const { engine, db } = engineFor(t);
  const readonly = await engine.submit({
    requestId: 'REQ-M-RO', mode: 'meeting', style: 'readonly', participants: ['worker-01'], text: '公告',
  });
  assert.equal(readonly.wakePolicy, 'never');
  assert.equal(engine.getRuns().length, 0);

  const roll = await engine.submit({
    requestId: 'REQ-M-RC', mode: 'meeting', style: 'rollCall', participants: ['worker-01', 'worker-02'], text: '点名',
  });
  assert.equal(roll.wakePolicy, 'onRollCall');
  const called = await engine.rollCall(roll.threadId, { style: 'rollCall' });
  assert.equal(called.wakes, 2, 'rollCall 最多点两个');
  assert.equal(engine.threadById(roll.threadId).messages.length, 3, '两条发言 + 一条人类消息');

  const full = await engine.submit({
    requestId: 'REQ-M-FULL', mode: 'meeting', style: 'full', participants: ['worker-01', 'worker-02'],
    text: '全员', confirm: true,
  });
  // 第一道确认在「开会」这一步：不确认就不许开 full 会议室。
  await assert.rejects(
    () => engine.submit({ requestId: 'REQ-M-FULL-2', mode: 'meeting', style: 'full', participants: ['worker-01'], text: '不确认' }),
    /二次确认/,
  );
  await assert.rejects(() => engine.rollCall(full.threadId, { style: 'full' }), /二次确认/);
  const confirmed = await engine.rollCall(full.threadId, { style: 'full', confirm: true });
  assert.equal(confirmed.wakes, 3, '两个发言 + CEO 汇总');
  assert.ok(engine.threadById(full.threadId).messages.some((m) => m.author === 'summary'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, '会议不建卡');
});

test('P4-7 · autoAssign 默认只推荐不替选，开着才记 assignedBy: policy', async (t) => {
  const { engine } = engineFor(t);
  assert.throws(
    () => engine.route({ requestId: 'REQ-AUTO-OFF', mode: 'direct' }),
    /必须显式给 addressedTo.*候选/,
  );
  const { engine: on } = engineFor(t, { cfg: config({ autoAssign: true }) });
  const routed = on.route({ requestId: 'REQ-AUTO-ON', mode: 'direct' });
  assert.equal(routed.assignedBy, 'policy');
  assert.ok(on.getAudit().some((a) => a.action === 'assigned_by_policy'));
  assert.ok(routed.target);
});

test('P4-7 · promote 单向：建卡 + 归档，二次提升被拒；TTL 到点归档', async (t) => {
  const { engine, db } = engineFor(t);
  const thread = await engine.submit({ requestId: 'REQ-PRO', mode: 'cowork', participants: ['worker-01'], text: '定稿' });
  const promoted = await engine.promoteThread(thread.threadId, { title: '按定稿执行', assignee: 'worker-01' });
  assert.equal(promoted.state, 'archived');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(promoted.taskId).status, 'done');
  await assert.rejects(() => engine.promoteThread(thread.threadId, { assignee: 'worker-01' }), /只能做一次/);

  const stale = await engine.submit({ requestId: 'REQ-TTL', mode: 'cowork', participants: ['worker-01'], text: '旧空间' });
  db.prepare("UPDATE threads SET lastActiveAt = '2025-01-01T00:00:00.000Z' WHERE threadId = ?").run(stale.threadId);
  const archived = engine.archiveStaleThreads({ now: new Date('2026-01-01T00:00:00.000Z') });
  assert.ok(archived.archived.includes(stale.threadId));
  assert.throws(() => engine.postThreadMessage(stale.threadId, { text: '还能说话吗' }), /已归档/);
});

// ---------------------------------------------------------------- P4-8

async function suspend(t, { decisionCfg = {} } = {}) {
  const ctx = engineFor(t, { cfg: { ...config(), ...decisionCfg } });
  const routed = ctx.engine.route({ requestId: `REQ-SUSPEND-${Math.random().toString(36).slice(2, 6)}`, text: '原任务', mode: 'delegate' });
  ctx.db.prepare('DELETE FROM events').run();
  transition(ctx.db, routed.taskId, 'in_progress');
  // 真实场景是「agent 正跑着撞墙」：先有一笔 revision=1 的 Run，挂起后这笔 Run 仍记 v1。
  ctx.db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt)
    VALUES ('R-suspend', ?, 'worker-01', 'issue_assigned', 'running', 1, 1, ?)`).run(routed.taskId, nowIso());
  // 产出半成品：resume 后必须还在。
  const outDir = path.join(ctx.root, 'tasks', routed.taskId, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'draft.md'), '已干的一半', 'utf8');
  const submitted = ctx.engine.submitChangeRequest({
    changeRequestId: `CR-${routed.taskId}`,
    taskId: routed.taskId, runId: 'R-suspend', agentId: 'worker-01',
    kind: 'direction', severity: 'needsDecision', reason: '前提变了', doneSoFar: { percent: 40 },
  });
  return { ...ctx, taskId: routed.taskId, submitted };
}

test('P4-8 · 挂起：awaiting_decision + 快照落盘 + 补偿扫描绝不重跑', async (t) => {
  const { engine, db, taskId, submitted } = await suspend(t);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId).status, 'awaiting_decision');
  assert.ok(submitted.snapshotPath && fs.existsSync(submitted.snapshotPath));
  const snap = JSON.parse(fs.readFileSync(submitted.snapshotPath, 'utf8'));
  assert.equal(snap.artifacts.length, 1);
  assert.equal(snap.immutable, true);
  const scan = engine.compensationScan({ olderThanMs: 0 });
  assert.equal(scan.requeued, 0, '挂起态绝不能被补偿扫描重新入队');
  assert.equal(scan.whitelist.includes('awaiting_decision'), false);
});

test('P4-8 · resume：沿用原 runId、产物还在、按新指令续做', async (t) => {
  const { engine, db, taskId } = await suspend(t);
  const out = await engine.submitDecision({
    changeRequestId: `CR-${taskId}`, taskId, decidedBy: 'human',
    decision: 'resume', needsHumanApproval: false, reason: '继续做',
  });
  assert.equal(out.runId, 'R-suspend', 'resume 必须沿用原 runId');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId).status, 'done');
  assert.ok(fs.existsSync(path.join(engine.config.workRoot ?? '', 'tasks', taskId, 'output', 'draft.md')));
  assert.equal(engine.getRuns().filter((r) => r.runId === 'R-suspend').length, 1);
});

test('P4-8 · redo 换新 runId；derive 另起卡；cancel 终态', async (t) => {
  const a = await suspend(t);
  const redo = await a.engine.submitDecision({
    changeRequestId: `CR-${a.taskId}`, taskId: a.taskId, decidedBy: 'human',
    decision: 'redo', needsHumanApproval: false, reason: '这一版不要了，重做',
  });
  assert.notEqual(redo.runId, 'R-suspend');
  assert.equal(a.db.prepare('SELECT attempt FROM tasks WHERE taskId = ?').get(a.taskId).attempt, 1);

  const b = await suspend(t);
  const derived = await b.engine.submitDecision({
    changeRequestId: `CR-${b.taskId}`, taskId: b.taskId, decidedBy: 'human',
    decision: 'derive', deriveAssignee: 'worker-02', deriveTitle: '另起一件',
    needsHumanApproval: false, reason: '原目标作废，另起一件',
  });
  assert.equal(b.db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(b.taskId).status, 'cancelled');
  assert.equal(b.db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(derived.childTaskId).status, 'done');

  const c = await suspend(t);
  await c.engine.submitDecision({
    changeRequestId: `CR-${c.taskId}`, taskId: c.taskId, decidedBy: 'human',
    decision: 'cancel', needsHumanApproval: false, reason: '不做了',
  });
  assert.equal(c.db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(c.taskId).status, 'cancelled');
  await assert.rejects(() => c.engine.submitDecision({
    changeRequestId: `CR-${c.taskId}`, taskId: c.taskId, decidedBy: 'human',
    decision: 'resume', needsHumanApproval: false, reason: '反悔',
  }), /不在挂起态|重复/);
});

test('P4-8 · 改验收必须 replan 人审：未声明拒绝，声明后挂起等人点头，批准才版本 +1', async (t) => {
  const { engine, db, taskId } = await suspend(t);
  await assert.rejects(() => engine.submitDecision({
    changeRequestId: `CR-${taskId}`, taskId, decidedBy: 'ceo',
    decision: 'resume', newAcceptance: ['产物存在且带术语表'], needsHumanApproval: false,
    reason: '验收条件变了',
  }), /needsHumanApproval/);

  const out = await engine.submitDecision({
    changeRequestId: `CR-${taskId}`, taskId, decidedBy: 'ceo',
    decision: 'resume', newAcceptance: ['产物存在且带术语表'], needsHumanApproval: true,
    reason: '验收条件变了',
  });
  assert.equal(out.status, 'awaiting_approval');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId).status, 'awaiting_decision', '人审没过之前仍挂起');
  const ap = engine.getApprovals({ status: 'pending' }).find((a) => a.kind === 'replan');
  assert.ok(ap);
  assert.ok(ap.request.payload.before.acceptance);
  assert.ok(ap.request.payload.after.acceptance);

  engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'boss' });
  const applied = await engine.submitDecision(engine.getApprovals().find((a) => a.kind === 'replan').request.payload.decision);
  assert.equal(applied.revision, 2);
  assert.equal(db.prepare('SELECT revision FROM tasks WHERE taskId = ?').get(taskId).revision, 2);
  const oldRuns = engine.getRuns().filter((r) => r.runId === 'R-suspend');
  assert.equal(oldRuns[0].revision, 1, '旧 Run 仍记 revision=1');
  assert.ok(fs.existsSync(path.join(engine.config.workRoot ?? '', 'tasks', taskId, 'revisions', 'rev-2.json')));
});

test('P4-8 · 挂起超时：24h 提醒一次，72h 自动取消且不自动恢复', async (t) => {
  const { engine, db, taskId } = await suspend(t);
  // 挂起起点用引擎注入的时钟（2026-01-01T00:00:00Z），不能拿系统真实时间做基准。
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const before = engine.getRuns().length;
  const at30 = engine.expireDecisions({ now: new Date(base + 30 * 3600_000) });
  assert.deepEqual(at30.cancelled, []);
  assert.ok(at30.reminded.includes(taskId));
  const again = engine.expireDecisions({ now: new Date(base + 31 * 3600_000) });
  assert.equal(again.reminded.length, 0, '提醒只发一次');
  const at80 = engine.expireDecisions({ now: new Date(base + 80 * 3600_000) });
  assert.ok(at80.cancelled.includes(taskId));
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId).status, 'cancelled');
  assert.equal(engine.getRuns().length, before, '超时只取消，不偷偷重跑');
});

// ---------------------------------------------------------------- P4-9

test('P4-9 · 循环模板改版必须人审：批准后 jobVersion+1，旧轮次不动', async (t) => {
  const { engine, db } = engineFor(t);
  const rec = createRecurring({ db, notifier: engine.notifier });
  engine.setApprovalHandler('recurring_change', (payload, meta) =>
    rec.applyRevision(payload.jobId, payload.patch ?? {}, { approvedBy: meta.decidedBy }));
  const job = {
    schema: 'aicompany.recurring/v1', jobId: 'JOB-L3', jobVersion: 1,
    title: '巡检', kind: 'inspection', owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', timezone: 'UTC' },
    misfirePolicy: 'run_once', misfireGraceMin: 720, overlapPolicy: 'skip',
    termination: { validUntil: null, maxCycles: 30, pauseOnConsecutiveFailures: 3, budgetTotal: { quotaUnits: 100 } },
    requiresHumanEachCycle: false,
    taskTemplate: { role: 'general', instructions: '巡检', acceptance: ['ok'], completionReportPath: 'output/completion.json' },
    carryOver: { enabled: true, maxItems: 10, injectField: 'input.previousFindings' },
    dedupeWindowMin: 1, lastCycleNo: 0,
  };
  rec.registerJob(job);
  rec.fire({ jobId: 'JOB-L3', scheduledAt: '2026-01-02T09:00:00.000Z', now: '2026-01-02T09:00:00.000Z' });

  const ap = engine.requestApproval({
    kind: 'recurring_change', title: '改频率', payload: { jobId: 'JOB-L3', patch: { trigger: { type: 'cron', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', timezone: 'UTC' } } },
  });
  assert.equal(rec.getJob('JOB-L3').jobVersion, 1, '人审没过不改模板');
  const out = engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'boss' });
  assert.equal(out.applied, true);
  assert.equal(rec.getJob('JOB-L3').jobVersion, 2);
  assert.equal(rec.listCycles('JOB-L3')[0].jobVersion, 1, '旧轮次仍记 v1');
});

test('P4-9 · 清理红线：requiresHumanEachCycle 必须 true；Desktop 直接拒绝且不写文件', async (t) => {
  const base = {
    schema: 'aicompany.recurring/v1', jobId: 'JOB-CLEAN', jobVersion: 1,
    title: '清理', kind: 'cleanup', owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0', timezone: 'UTC' },
    termination: { maxCycles: 5 }, requiresHumanEachCycle: false,
    taskTemplate: { role: 'general', instructions: '扫描', acceptance: ['ok'], completionReportPath: 'output/completion.json' },
  };
  assert.equal(validate('recurring', base).ok, false);
  assert.match(validate('recurring', base).errors.join(';'), /requiresHumanEachCycle/);

  const root = safeScratchDir(t);
  const safeDir = path.join(root, 'cache');
  fs.mkdirSync(safeDir, { recursive: true });
  fs.writeFileSync(path.join(safeDir, 'a.log'), 'x', 'utf8');
  const ok = cleanupScan({ jobId: 'JOB-CLEAN', cycleNo: 1, targets: [safeDir], whitelist: [root], workRoot: root });
  assert.equal(ok.metrics.deletedCount, 0);
  assert.equal(ok.metrics.fileCount, 1);
  assert.ok(fs.existsSync(ok.reportPath), '只写报告');

  const desktop = path.join(root, 'Desktop', '照片');
  assert.throws(
    () => cleanupScan({ jobId: 'JOB-CLEAN', cycleNo: 2, targets: [desktop], whitelist: [root], workRoot: root }),
    (e) => e instanceof CleanupRefused && /敏感目录/.test(e.message),
  );
  assert.equal(fs.existsSync(path.join(root, 'reports', 'cleanup-JOB-CLEAN-2.json')), false, '被拒绝时一个文件都不写');

  assert.throws(
    () => cleanupScan({ jobId: 'JOB-CLEAN', cycleNo: 3, targets: [path.join(root, 'outside')], whitelist: [safeDir], workRoot: root }),
    /白名单/,
  );
});

// ---------------------------------------------------------------- G-P4

test('G-P4 门禁：配额触顶停派 / resume 不丢产物 / 挂起不被重跑 / 改验收未过审被拒', async (t) => {
  const { engine, db } = engineFor(t, {
    cfg: config({
      seats: [
        { id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 30, reportsTo: null, adapter: { type: 'mock', config: {} } },
        { id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 2, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
        { id: 'worker-02', displayName: '执行二席', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
      ],
    }),
  });
  await engine.submit({ requestId: 'G-1', text: 'a', mode: 'direct', addressedTo: 'worker-01' });
  await engine.submit({ requestId: 'G-2', text: 'b', mode: 'direct', addressedTo: 'worker-01' });
  assert.throws(() => engine.route({ requestId: 'G-3', mode: 'direct', addressedTo: 'worker-01' }), /配额/);
  assert.ok(engine.getAudit().some((a) => a.action === 'quota_exhausted'));

  // resume 保持产物与原 runId
  const s = await suspend(t);
  const resumed = await s.engine.submitDecision({
    changeRequestId: `CR-${s.taskId}`, taskId: s.taskId, decidedBy: 'human',
    decision: 'resume', needsHumanApproval: false, reason: '继续做',
  });
  assert.equal(resumed.runId, 'R-suspend');
  assert.ok(fs.existsSync(path.join(s.root, 'tasks', s.taskId, 'output', 'draft.md')));
  assert.equal(s.engine.compensationScan({ olderThanMs: 0 }).requeued, 0);

  // 改验收未走 replan 被拒
  await assert.rejects(() => s.engine.submitDecision({
    changeRequestId: `CR-${s.taskId}`, taskId: s.taskId, decidedBy: 'ceo',
    decision: 'resume', newAcceptance: ['放水'], needsHumanApproval: false, reason: '改验收',
  }), /needsHumanApproval|不在挂起态/);
});

// ---------------------------------------------------------------- 冒烟回归

test('P4 回归 · adapter 的 status 元字段混进变更请求时不再整单被拒', async (t) => {
  // mock / process adapter 会把 status 一起放进 result；变更请求协议不允许该字段。
  // 控制面必须按协议白名单取字段，而不是把 adapter 返回值原样当业务单据。
  const hang = (ctx) => ({
    status: 'change_requested',
    changeRequestId: `CR-${ctx.task.taskId}`,
    kind: 'direction', severity: 'needsDecision', reason: '前提变了', doneSoFar: { percent: 40 },
  });
  const { engine, db } = engineFor(t, { workerResult: hang });
  const r = await engine.submit({ requestId: 'REQ-ADAPTER-META', text: '撞墙', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'awaiting_decision');
});

test('P4 回归 · 凭据不出现在任务卡 / 审计 / 报告 / 落盘产物里', async (t) => {
  // adapter 配置里带密钥是常态；控制面绝不能把它抄进卡、审计、完成报告或磁盘。
  const SECRET = 'sk-SMOKE-DO-NOT-LEAK-0001';
  const { engine, db, root } = engineFor(t, {});
  // 把密钥塞进某席位的 adapter 配置（模拟真实凭据），再跑一条完整闭环。
  engine.config.agents.find((a) => a.id === 'worker-01').adapter.config.apiKey = SECRET;
  await engine.submit({ requestId: 'REQ-SECRET', text: '跑一遍', mode: 'direct', addressedTo: 'worker-01' });

  const blobs = [
    JSON.stringify(engine.getTasks()),
    JSON.stringify(engine.getRuns()),
    JSON.stringify(engine.getAudit()),
    JSON.stringify(engine.notifier.messages),
    JSON.stringify(db.prepare('SELECT * FROM task_payload').all()),
  ];
  const walk = (dir) => {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) out.push(fs.readFileSync(full, 'utf8'));
      }
    }
    return out;
  };
  blobs.push(...walk(root));
  const leaked = blobs.filter((b) => String(b).includes(SECRET));
  assert.equal(leaked.length, 0, `密钥泄漏到 ${leaked.length} 处：任务卡 / 审计 / 报告 / 产物文件`);
});

test('P4 回归 · 只给 changeRequestId 也能拍板（taskId 由变更请求反查补全）', async (t) => {
  // 第一次干活撞墙；续做（wakeReason=decision）才正常收工。
  const hangThenDone = (ctx) => (ctx.wakeReason === 'decision' ? completion(ctx) : {
    status: 'change_requested',
    changeRequestId: `CR-${ctx.task.taskId}`,
    kind: 'direction', severity: 'needsDecision', reason: '要人拍板', doneSoFar: {},
  });
  const { engine, db } = engineFor(t, { workerResult: hangThenDone });
  const r = await engine.submit({ requestId: 'REQ-CR-ONLY', text: '撞墙', mode: 'direct', addressedTo: 'worker-01' });
  const out = await engine.submitDecision({
    changeRequestId: `CR-${r.taskId}`, decidedBy: 'human',
    decision: 'resume', needsHumanApproval: false, reason: '继续',
  });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');
  assert.ok(out.runId, 'resume 应当带出 runId');

  // 张冠李戴要拦住
  const other = await engine.submit({ requestId: 'REQ-CR-ONLY-2', text: '再撞一次', mode: 'direct', addressedTo: 'worker-01' });
  await assert.rejects(() => engine.submitDecision({
    changeRequestId: `CR-${r.taskId}`, taskId: other.taskId, decidedBy: 'human',
    decision: 'cancel', needsHumanApproval: false, reason: '故意错配',
  }), /不一致|不在挂起态|已按/);
});
