// P1 自主验收：逐条对齐 docs/开发清单.md 的 P1-1 ~ P1-8 与 G-P1。
// 主路径用内存 mock adapter（快、可控、可注入故障）；另有一组走真实子进程 adapter。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openDb, transition, TRANSITIONS, emit, compensationScan,
} from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { getAdapter, availableAdapterTypes } from '../src/adapters.js';
import { loadConfig, EXAMPLE_CONFIG_PATH } from '../src/config.js';
import { createServer } from '../src/server.js';
import { WEB_BOARD_MIN_PAGES } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function completion(ctx, overrides = {}) {
  return {
    schema: 'aicompany.completion/v1',
    taskId: ctx.task?.taskId ?? 'T-unknown',
    runId: ctx.runId,
    agent: ctx.agent.id,
    revision: ctx.task?.revision ?? 1,
    status: 'success',
    summary: '模拟执行完成',
    artifacts: ['output/result.md'],
    checksum: { 'output/result.md': 'sha256:mock' },
    acceptanceResults: [{ rule: 'output/result.md 存在且非空', pass: true }],
    usage: { quotaUnits: 1 },
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

const defaultCeo = (ctx) => (ctx.wakeReason === 'review_requested'
  ? { type: 'review', verdict: 'pass', reason: '机检通过，验收合格' }
  : { type: 'task-create', title: '执行子任务', role: 'general', assignee: 'worker-01' });

function mockConfig(opts = {}) {
  return {
    version: 1,
    company: { name: 'test-company', timezone: 'Asia/Shanghai' },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: opts.ceoResult ?? defaultCeo } },
      },
      {
        id: 'worker-01', displayName: '执行席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { result: opts.workerResult ?? ((ctx) => completion(ctx)) } },
      },
    ],
    clients: ['web'],
    notifier: ['noop'],
  };
}

function makeEngine(opts = {}) {
  const db = openDb(':memory:');
  const config = mockConfig(opts);
  const notifier = createNotifier('web');
  const engine = createEngine({ db, config, notifier, maxSteps: opts.maxSteps ?? 80 });
  return { db, config, notifier, engine };
}

const allTasks = (db) => db.prepare('SELECT * FROM tasks ORDER BY rowid').all();
const allRuns = (db) => db.prepare('SELECT * FROM runs ORDER BY rowid').all();

function insertBareTask(db, taskId, status, updatedAt = new Date(Date.now() - 60000).toISOString()) {
  db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, status, assignee, createdAt, updatedAt, revision, attempt)
    VALUES (?, ?, ?, ?, 'worker-01', ?, ?, 1, 0)`)
    .run(taskId, `REQ-${taskId}`, taskId, status, updatedAt, updatedAt);
}

// ---------------------------------------------------------------- P1-1

test('P1-1 · SQLite 状态机：合法 / 非法跳转、终态、cancelled 不可 reopen', () => {
  const db = openDb(':memory:');
  insertBareTask(db, 'T-flow', 'todo');
  assert.deepEqual(TRANSITIONS.done, []);
  assert.deepEqual(TRANSITIONS.cancelled, []);
  assert.ok(TRANSITIONS.in_progress.includes('awaiting_decision'));
  assert.ok(TRANSITIONS.awaiting_decision.includes('cancelled'));

  assert.deepEqual(transition(db, 'T-flow', 'in_progress'), { from: 'todo', to: 'in_progress' });
  assert.deepEqual(transition(db, 'T-flow', 'in_review'), { from: 'in_progress', to: 'in_review' });
  assert.deepEqual(transition(db, 'T-flow', 'done'), { from: 'in_review', to: 'done' });
  assert.throws(() => transition(db, 'T-flow', 'in_progress'), /非法跳转/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='illegal_transition'").get().n, 1);

  insertBareTask(db, 'T-cancel', 'todo');
  transition(db, 'T-cancel', 'cancelled');
  assert.throws(() => transition(db, 'T-cancel', 'todo'), /非法跳转/);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE taskId='T-cancel'").get().status, 'cancelled');
  db.close();
});

test('P1-1 · 补偿扫描只捞 todo / in_progress，挂起态与终态一律排除', () => {
  const db = openDb(':memory:');
  for (const status of ['todo', 'in_progress', 'awaiting_decision', 'paused', 'cancelled', 'done', 'blocked', 'in_review']) {
    insertBareTask(db, `T-${status}`, status);
  }
  const first = compensationScan(db);
  assert.equal(first.scanned, 2);
  assert.deepEqual(first.whitelist, ['todo', 'in_progress']);
  const queued = db.prepare("SELECT taskId FROM events WHERE type='issue_assigned'").all().map((r) => r.taskId);
  assert.ok(!queued.includes('T-awaiting_decision'));
  assert.ok(!queued.includes('T-paused'));
  assert.ok(!queued.includes('T-done'));
  // 同分钟双触发（cron + 补偿）靠 dedupeKey 只生成一次
  assert.equal(compensationScan(db).requeued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='issue_assigned'").get().n, 2);
  db.close();
});

// ---------------------------------------------------------------- P1-2

test('P1-2 · 同一 requestId 重复投递只建一张卡；同 dedupeKey 只入一条事件', async () => {
  const { db, engine } = makeEngine();
  const req = { requestId: 'REQ-IDEMPOTENT', text: '只办一次', mode: 'direct', addressedTo: 'worker-01' };
  const first = await engine.submit(req);
  const second = await engine.submit(req);
  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal(second.taskId, first.taskId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE requestId='REQ-IDEMPOTENT'").get().n, 1);

  const a = emit(db, { type: 'state_changed', taskId: 'T-x', dedupeKey: 'same-key' });
  const b = emit(db, { type: 'state_changed', taskId: 'T-x', dedupeKey: 'same-key' });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE dedupeKey='same-key'").get().n, 1);
  db.close();
});

test('P1-2 · cowork 重复 requestId 只建一个协作空间', async () => {
  const { db, engine } = makeEngine();
  const req = { requestId: 'REQ-THREAD-1', text: '聊一下', mode: 'cowork' };
  const a = await engine.route(req);
  const b = await engine.route(req);
  assert.equal(a.threadId, b.threadId);
  assert.equal(b.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM threads').get().n, 1);
  db.close();
});

// ---------------------------------------------------------------- P1-3

test('P1-3 · Run Policy：席位状态 / 配额 / 并发 / 挂起态依次拦截', async () => {
  const { db, engine } = makeEngine();
  const card = engine.route({ requestId: 'REQ-POLICY', text: 'x', mode: 'direct', addressedTo: 'worker-01' });

  db.prepare("UPDATE agents SET status='inactive' WHERE agentId='worker-01'").run();
  let r = await engine.wake(card.taskId, 'worker-01', 'issue_assigned');
  assert.equal(r.skipped, true);
  db.prepare("UPDATE agents SET status='active' WHERE agentId='worker-01'").run();

  db.prepare('UPDATE quotas SET used = limitUnits WHERE agentId = ?').run('worker-01');
  r = await engine.wake(card.taskId, 'worker-01', 'issue_assigned');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /配额/);
  db.prepare('UPDATE quotas SET used = 0 WHERE agentId = ?').run('worker-01');

  for (let i = 0; i < 3; i += 1) {
    db.prepare("INSERT INTO runs (runId, taskId, agentId, status, startedAt) VALUES (?, ?, 'ceo', 'running', ?)")
      .run(`R-FAKE-${i}`, card.taskId, new Date().toISOString());
  }
  r = await engine.wake(card.taskId, 'worker-01', 'issue_assigned');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /并发/);
  db.prepare("DELETE FROM runs WHERE runId LIKE 'R-FAKE-%'").run();

  transition(db, card.taskId, 'in_progress');
  transition(db, card.taskId, 'awaiting_decision');
  r = await engine.wake(card.taskId, 'worker-01', 'issue_assigned');
  assert.equal(r.skipped, true);
  assert.match(r.reason, /挂起/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='wake_rejected'").get().n, 4);
  db.close();
});

// ---------------------------------------------------------------- G-P1 / P1-6

test('G-P1 · 一条 delegate 需求：一次 submit 自动跑到 done，零第二条命令', async () => {
  const { db, engine, notifier } = makeEngine();
  const result = await engine.submit({ requestId: 'REQ-DELEGATE', text: '写份周报', mode: 'delegate' });
  assert.equal(result.taskCreated, true);
  assert.equal(result.pending, 0);
  const tasks = allTasks(db);
  assert.ok(tasks.length >= 2, 'CEO 应派生出子卡');
  assert.ok(tasks.every((t) => t.status === 'done'), '所有卡都应走到 done');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId='ceo'").get().n >= 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM briefs').get().n, 1);
  assert.ok(notifier.messages.some((m) => m.scene === 'brief'));
  db.close();
});

test('G-P1 · 关机再开机任务与 Run 不丢（文件库 + 迁移幂等）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p1-'));
  const dbPath = path.join(dir, 'aicompany.db');
  try {
    const config = mockConfig();
    const db1 = openDb(dbPath);
    const e1 = createEngine({ db: db1, config, notifier: createNotifier('web') });
    const routed = e1.route({ requestId: 'REQ-RESTART', text: '重启不丢', mode: 'direct', addressedTo: 'worker-01' });
    db1.prepare('UPDATE tasks SET status = ? WHERE taskId = ?').run('in_progress', routed.taskId);
    db1.prepare("INSERT INTO runs (runId, taskId, agentId, status, startedAt) VALUES ('R-PERSIST', ?, 'worker-01', 'success', ?)")
      .run(routed.taskId, new Date().toISOString());
    db1.close();

    const db2 = openDb(dbPath);
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
    assert.equal(db2.prepare('SELECT status FROM tasks WHERE taskId = ?').get(routed.taskId).status, 'in_progress');
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
    const cols = db2.prepare('PRAGMA table_info(threads)').all().map((c) => c.name);
    assert.ok(cols.includes('requestId'), '旧库应自动补上 threads.requestId');
    const e2 = createEngine({ db: db2, config, notifier: createNotifier('web') });
    assert.ok(e2.taskById(routed.taskId));
    db2.close();
  } finally {
    // 只清理本次测试自己创建的临时目录，不碰任何用户文件。
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- P1-6

test('P1-6 · 报告不合格打回、自动重跑一次、简报按固定模板出站', async () => {
  let calls = 0;
  const workerResult = (ctx) => {
    calls += 1;
    if (calls === 1) {
      return { schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, status: 'failed', reason: '缺字段的不合格报告' };
    }
    return completion(ctx);
  };
  const { db, engine, notifier } = makeEngine({ workerResult });
  const r = await engine.submit({ requestId: 'REQ-RETRY', text: '验证打回', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');
  assert.equal(engine.getAudit().filter((a) => a.action === 'report_rejected').length, 1);
  assert.equal(engine.getRuns().filter((x) => x.wakeReason === 'retry').length, 1);
  const brief = db.prepare('SELECT * FROM briefs').get();
  assert.match(brief.body, /AICompany 简报/);
  assert.match(brief.body, /今日完成：1/);
  assert.match(brief.body, /待你拍板：0 条审批 · 0 张挂起待决策/);
  assert.ok(notifier.messages.some((m) => m.scene === 'brief'));
  db.close();
});

test('P1-6 · 连续不合格达到上限后 blocked，不无限重跑', async () => {
  const workerResult = (ctx) => completion(ctx, { status: 'failed', reason: '一直失败' });
  const { db, engine } = makeEngine({ workerResult });
  const r = await engine.submit({ requestId: 'REQ-BLOCKED', text: '验证上限', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'blocked');
  assert.equal(engine.getRuns().length, 2);
  assert.equal(r.pending, 0);
  db.close();
});

test('P1-6 · CEO 验收打回只自动重跑一次，不会无限空转', async () => {
  const ceoResult = (ctx) => (ctx.wakeReason === 'review_requested'
    ? { type: 'review', verdict: 'reject', reason: '不满意' }
    : { type: 'task-create', title: '子任务', assignee: 'worker-01' });
  const { db, engine } = makeEngine({ ceoResult, maxSteps: 60 });
  const r = await engine.submit({ requestId: 'REQ-REJECT', text: '验收打回', mode: 'delegate' });
  assert.ok(r.steps < 60, '不应把 maxSteps 跑满');
  assert.equal(r.pending, 0);
  assert.equal(engine.getAudit().filter((a) => a.action === 'review_rework').length, 1);
  // P4-5 起：第二次打回不再静默，转救火席位或出人审批卡（本条配置没配 escalationTo）。
  assert.ok(engine.getAudit().some((a) => a.action === 'blocked_escalated'));
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'review_reject'").get().n >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId='worker-01'").get().n, 2);
  db.close();
});

// ---------------------------------------------------------------- P1-7

test('P1-7 · direct 只产生一次 execute，runs 里没有 CEO 的 Run', async () => {
  const { db, engine } = makeEngine();
  const r = await engine.submit({ requestId: 'REQ-DIRECT', text: '直接干活', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(r.mode, 'direct');
  const runs = allRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentId, 'worker-01');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId='ceo'").get().n, 0);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');
  assert.ok(engine.getAudit().some((a) => a.action === 'machine_acceptance'));
  assert.throws(() => engine.route({ requestId: 'REQ-DIRECT-BAD', mode: 'direct' }), /addressedTo/);
  db.close();
});

test('P1-7 · direct 直投 CEO 时 cc 不与 addressedTo 撞车', () => {
  const { db, engine } = makeEngine();
  assert.doesNotThrow(() => engine.route({ requestId: 'REQ-DIRECT-CEO', text: '直接找总经理', mode: 'direct', addressedTo: 'ceo' }));
  db.close();
});

test('P1-7 · cowork 零建卡，10 条消息与 @某席位都不唤醒', async () => {
  const { db, engine } = makeEngine();
  const r = await engine.submit({ requestId: 'REQ-COWORK', text: '一起聊', mode: 'cowork', participants: ['worker-01'] });
  assert.equal(r.taskCreated, false);
  assert.equal(allTasks(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM threads').get().n, 1);
  const before = allRuns(db).length;
  for (let i = 0; i < 10; i += 1) {
    const posted = engine.postThreadMessage(r.threadId, { text: `@worker-01 第 ${i + 1} 条`, author: 'human' });
    assert.equal(posted.wakes, 0);
    assert.equal(posted.taskCreated, false);
  }
  assert.equal(allTasks(db).length, 0);
  assert.equal(allRuns(db).length, before);
  assert.equal(engine.threadById(r.threadId).messages.length, 11);
  assert.throws(() => engine.route({ requestId: 'REQ-MEETING-BAD', mode: 'direct' }), /addressedTo/);
  // P4 起 meeting 开放：readonly 公告零唤醒、不建卡。
  const meeting = engine.route({
    requestId: 'REQ-MEETING', mode: 'meeting', participants: ['worker-01'], style: 'readonly',
  });
  assert.equal(meeting.mode, 'meeting');
  assert.equal(meeting.wakePolicy, 'never');
  assert.equal(allTasks(db).length, 0);
  db.close();
});

// ---------------------------------------------------------------- P1-8

test('P1-8 · progress 只留痕不唤醒；advisory change-request 唤醒 CEO → 派生新卡 → 原卡 cancelled', async () => {
  const { db, engine } = makeEngine();
  const routed = engine.route({ requestId: 'REQ-CHANGE', text: '原任务', mode: 'delegate' });
  // 模拟「活干到一半」：领活事件已被消费，卡停在 in_progress。
  db.prepare('DELETE FROM events').run();
  transition(db, routed.taskId, 'in_progress');
  db.prepare('DELETE FROM events').run();

  const before = await engine.onProgressReport();
  assert.equal(before.wakes, 0);
  assert.equal(engine.getRuns().length, 0);

  const cr = {
    changeRequestId: 'CR-001', taskId: routed.taskId, runId: 'R-manual',
    agentId: 'worker-01', kind: 'direction', severity: 'advisory',
    reason: '提个建议，不打断', doneSoFar: { files: ['draft.md'] },
  };
  assert.equal(engine.submitChangeRequest(cr).inserted, true);
  const pumped = await engine.pump();
  assert.equal(pumped.pending, 0);

  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(routed.taskId).status, 'cancelled');
  const derived = db.prepare('SELECT * FROM tasks WHERE parentTaskId = ?').get(routed.taskId);
  assert.ok(derived);
  assert.equal(derived.status, 'done');
  assert.ok(engine.getRuns().some((x) => x.agentId === 'ceo' && x.wakeReason === 'escalation'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM change_requests').get().n, 1);
  assert.ok(engine.getAudit().some((a) => a.action === 'derive_from_change_request'));
  assert.equal(engine.submitChangeRequest(cr).inserted, false, '重复 changeRequestId 不重复处理');
  db.close();
});

test('P1-8 / P4-8 · needsDecision 走完整档：真挂起 + 现场快照，不再自动派生', async () => {
  const { db, engine } = makeEngine();
  const routed = engine.route({ requestId: 'REQ-SUSPEND', text: '原任务', mode: 'delegate' });
  db.prepare('DELETE FROM events').run();
  transition(db, routed.taskId, 'in_progress');
  db.prepare('DELETE FROM events').run();
  const out = engine.submitChangeRequest({
    changeRequestId: 'CR-SUSPEND', taskId: routed.taskId, runId: 'R-manual',
    agentId: 'worker-01', kind: 'direction', severity: 'needsDecision',
    reason: '前提变了，请拍板', doneSoFar: { files: [] },
  });
  assert.equal(out.inserted, true);
  assert.equal(out.suspended, true);
  assert.ok(out.snapshotPath);
  await engine.pump();
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(routed.taskId).status, 'awaiting_decision');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId = ?').get(routed.taskId).n, 0);
  assert.equal(engine.getRuns().length, 0, '挂起不烧额度，不额外唤醒 CEO');
  db.close();
});

// ---------------------------------------------------------------- P1-5

test('P1-5 · adapter 注册表：三型可用、testEnvironment 可诊断、未知类型拒绝启动', () => {
  const types = availableAdapterTypes();
  for (const type of ['process', 'cli-acp', 'mock']) assert.ok(types.includes(type));
  for (const type of ['process', 'cli-acp', 'mock']) {
    const mod = getAdapter(type);
    assert.equal(typeof mod.execute, 'function');
    const diag = mod.testEnvironment({});
    assert.equal(typeof diag.ok, 'boolean');
    assert.equal(typeof diag.detail, 'string');
  }
  assert.equal(getAdapter('process').testEnvironment({}).ok, false);
  assert.equal(getAdapter('process').testEnvironment({ command: 'echo ok' }).ok, true);
  assert.throws(() => getAdapter('not-a-type'), /未注册|拒绝启动/);

  // P1 新增的引擎源码里不能出现任何具体产品名（词边界，避免 needsHumanApproval 误报）。
  const banned = ['dsh', 'workbuddy', '豆包', 'hermes', '飞书', 'lark', 'feishu'];
  for (const file of ['core.js', 'adapters.js', 'engine.js', 'server.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    for (const name of banned) {
      assert.ok(!new RegExp(`\\b${name}\\b`, 'i').test(text), `${file} 不应出现产品名 ${name}`);
    }
  }
});

test('P1-5 · 真实 cli-acp / process adapter 走 fake-agent 跑通 delegate 闭环', async () => {
  const demo = `node "${path.join(ROOT, 'scripts', 'fake-agent.js').replace(/\\/g, '/')}"`;
  const env = { ...process.env, AICOMPANY_CEO_CMD: demo, AICOMPANY_WORKER_CMD: demo };
  const { config, doctor: report } = loadConfig(EXAMPLE_CONFIG_PATH, env);
  assert.equal(report.ok, true);
  assert.deepEqual(config.clients, ['web']);
  assert.deepEqual(config.notifier, ['noop']);

  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-REAL-ADAPTER', text: '真实子进程链路', mode: 'delegate' });
  assert.equal(r.pending, 0);
  assert.ok(allTasks(db).length >= 2);
  assert.ok(allTasks(db).every((t) => t.status === 'done'));
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId='ceo'").get().n >= 2);
  db.close();
});

// ---------------------------------------------------------------- P1-4

test('P1-4 · Web Board 最小页覆盖契约里的五个范围', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'board.html'), 'utf8');
  assert.equal(WEB_BOARD_MIN_PAGES.length, 5);
  for (const marker of ['Tasks', 'Approvals', 'Inbox', 'id="mode"', 'id="addressedTo"', 'WorkThread', 'EventSource']) {
    assert.ok(html.includes(marker), `页面缺少 ${marker}`);
  }
  for (const endpoint of ['/api/requests', '/api/change-requests', '/api/threads']) {
    assert.ok(html.includes(endpoint), `页面应走统一 API ${endpoint}`);
  }
});

test('P1-4 · 统一 API + Web Board + SSE：浏览器提交一条需求自动办完', async (t) => {
  const { db, engine } = makeEngine();
  const server = createServer({ engine, port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ac = new AbortController();
  t.after(async () => {
    ac.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /AICompany · Web Board/);

  const agents = await (await fetch(`${base}/api/agents`)).json();
  assert.equal(agents.length, 2);
  assert.equal((await (await fetch(`${base}/api/approvals`)).json()).length, 0);

  const sse = await fetch(`${base}/api/events`, { signal: ac.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  const readWithTimeout = async (ms) => {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms); });
    try { return await Promise.race([reader.read(), timeout]); }
    finally { clearTimeout(timer); }
  };
  let seen = '';
  const first = await readWithTimeout(1500);
  if (!first.timeout && !first.done) seen += decoder.decode(first.value, { stream: true });

  const submitted = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'REQ-HTTP', text: '浏览器提的需求', mode: 'delegate' }),
  });
  assert.equal(submitted.status, 201);
  assert.equal((await submitted.json()).pending, 0);

  let pushed = false;
  for (let i = 0; i < 14 && !pushed; i += 1) {
    const chunk = await readWithTimeout(400);
    if (chunk.timeout) continue;
    if (chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
    pushed = seen.includes('data:');
  }
  assert.ok(pushed, 'SSE 应推送状态变更');
  assert.match(seen, /"type":"(state_changed|issue_assigned|review_requested)"/);

  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.ok(tasks.length >= 2);
  assert.ok(tasks.every((x) => x.status === 'done'));
  assert.ok((await (await fetch(`${base}/api/dashboard`)).json()).runs >= 3);
  assert.equal((await (await fetch(`${base}/api/inbox`)).json()).briefs.length, 1);
});

test('P1-4 / P1-7 / P1-8 · 同一套 API 下的 direct / cowork / threads / change-requests', async (t) => {
  const { db, engine } = makeEngine();
  const server = createServer({ engine, port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const postJson = async (p, body) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };

  const direct = await postJson('/api/requests', {
    requestId: 'REQ-API-DIRECT', text: '直投', mode: 'direct', addressedTo: 'worker-01',
  });
  assert.equal(direct.status, 201);
  assert.equal(direct.data.pending, 0);

  const cowork = await postJson('/api/threads', {
    requestId: 'REQ-API-THREAD', title: '协作', text: '开聊', participants: ['worker-01'],
  });
  assert.equal(cowork.status, 201);
  assert.equal(cowork.data.taskCreated, false);
  const threadId = cowork.data.threadId;

  const before = await (await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}`)).json();
  assert.equal(before.messages.length, 1);
  const posted = await postJson(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    text: '@worker-01 你好', author: 'human',
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.data.wakes, 0);
  const after = await (await fetch(`${base}/api/threads/${encodeURIComponent(threadId)}`)).json();
  assert.equal(after.messages.length, 2);

  assert.equal((await (await fetch(`${base}/api/tasks`)).json()).length, 1, '协作消息不应产生任务卡');
  const runs = await (await fetch(`${base}/api/runs`)).json();
  assert.equal(runs.filter((x) => x.agentId === 'ceo').length, 0);

  const cr = await postJson('/api/change-requests', {
    changeRequestId: 'CR-API-1', taskId: direct.data.taskId, runId: 'R-manual',
    agentId: 'worker-01', kind: 'clarify', severity: 'needsDecision', reason: '补充一点背景',
  });
  assert.equal(cr.status, 201);
  assert.equal(cr.data.inserted, true);

  assert.equal((await postJson('/api/approvals/NONE/decision', { decision: 'approved' })).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
