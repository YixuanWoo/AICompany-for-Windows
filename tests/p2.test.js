// P2 自主验收：逐条对齐 docs/开发清单.md 的 P2-1 ~ P2-6 与 G-P2。
// 约定：绝大多数用例用内存 SQLite + 可注入时钟，不依赖真实服务器、不联网、不烧额度；
// 最后一组用真实 HTTP 服务验证「同一套 /api」下的 bridge / 循环链路确实跑得通。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, transition, compensationScan, pendingEvents } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { getAdapter } from '../src/adapters.js';
import { createBridgeApi, assertBridgeToken, BRIDGE_ENDPOINTS } from '../src/bridge-api.js';
import { createBridge } from '../src/bridge.js';
import {
  checkout, assertLease, releaseLease, expireLeases,
  heartbeat, isBridgeOnline, listBridges, markBridgeOffline,
} from '../src/lease.js';
import { createRecurring, selectFires } from '../src/recurring.js';
import { parseRRule, occurrencesBetween, nextFireAt, timezoneOffsetMin } from '../src/rrule.js';
import { createScheduler } from '../src/scheduler.js';
import { buildOpsAdapterConfig, findHardcodedTarget } from '../src/ops.js';
import { createLogger } from '../src/logger.js';
import { shouldRestart } from '../scripts/daemon.js';
import { API_ENDPOINTS, WEB_BOARD_P2_PANELS } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = (day, hour = 1) => `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const FAR = '2099-01-01T00:00:00.000Z';

// ---------------------------------------------------------------- 夹具

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
  const engine = createEngine({
    db, config, notifier, maxSteps: opts.maxSteps ?? 80,
    dispatchMode: opts.dispatchMode ?? 'inline',
  });
  return { db, config, notifier, engine };
}

function insertBareTask(db, taskId, status = 'todo', stamp = T(1)) {
  db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, status, assignee, createdAt, updatedAt, revision, attempt, mode)
    VALUES (?, ?, ?, ?, 'worker-01', ?, ?, 1, 0, ?)`)
    .run(taskId, `REQ-${taskId}`, taskId, status, stamp, stamp, 'direct');
}

function makeJob(overrides = {}) {
  return {
    schema: 'aicompany.recurring/v1',
    jobId: 'JOB-brief', jobVersion: 1,
    title: '每日巡检', kind: 'inspection',
    owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=HOURLY;BYMINUTE=0', timezone: 'UTC' },
    misfirePolicy: 'run_once', misfireGraceMin: 720,
    overlapPolicy: 'skip',
    termination: {
      validUntil: null, maxCycles: 30, pauseOnConsecutiveFailures: 3,
      budgetTotal: { quotaUnits: 100 },
    },
    requiresHumanEachCycle: false,
    taskTemplate: {
      role: 'general', instructions: '按 brief 巡检并写出完成报告。',
      acceptance: ['completion.json 通过 schema 校验'],
      completionReportPath: 'output/completion.json',
    },
    carryOver: { enabled: true },
    dedupeWindowMin: 1,
    nextFireAt: FAR,
    ...overrides,
  };
}

function makeRecurring() {
  const db = openDb(':memory:');
  const notifier = createNotifier('web');
  const rec = createRecurring({ db, notifier, now: () => FAR });
  return { db, notifier, rec };
}

const auditHas = (db, action) => db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ?').get(action).n > 0;

async function withServer(engine, t, opts = {}) {
  const server = createServer({ engine, port: 0, host: '127.0.0.1', ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, pathname, body, headers = {}) => fetch(`${base}${pathname}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------- P2-1

test('P2-1 · 统一 API：P2 端点全部登记在契约清单里且签名不重复', () => {
  const signatures = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  assert.equal(new Set(signatures).size, signatures.length);
  for (const path of [
    '/api/bridge/inbox', '/api/bridge/checkout', '/api/bridge/heartbeat',
    '/api/bridge/progress', '/api/bridge/complete', '/api/bridge/change-request',
    '/api/bridge/snapshot', '/api/bridge/status', '/api/bridges', '/api/leases',
    '/api/recurring', '/api/recurring/:id/fire', '/api/recurring/:id/complete-cycle',
    '/api/cycles', '/api/cycle-history', '/api/scheduler', '/api/scheduler/tick',
  ]) assert.ok(API_ENDPOINTS.some((e) => e.path === path), `契约缺端点 ${path}`);
  assert.equal(BRIDGE_ENDPOINTS.length, 8);
  assert.equal(WEB_BOARD_P2_PANELS.length, 2);
});

test('P2-1 · Web Board 已挂上 Bridge 与 RecurringJobs 两个 P2 面板', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'board.html'), 'utf8');
  for (const marker of [
    '/api/bridge/status', '/api/recurring', 'Bridge', 'RecurringJobs',
    'job-register', 'job-fire',
  ]) assert.ok(html.includes(marker), `看板缺少 ${marker}`);
});

// ---------------------------------------------------------------- P2-2

test('P2-2 · 并发 10 个 checkout：有且仅有 1 个成功，其余全部 409', () => {
  const db = openDb(':memory:');
  insertBareTask(db, 'T-LEASE');
  const results = Array.from({ length: 10 }, (_, i) => checkout(db, {
    taskId: 'T-LEASE', agentId: `bridge-${i}`, now: new Date(T(1)),
  }));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.conflict && r.status === 409).length, 9);
  assert.equal(auditHas(db, 'checkout_conflict'), true);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-LEASE').status, 'in_progress');
  db.close();
});

test('P2-2 · leaseToken 不匹配 / 缺失的回写一律拒绝', () => {
  const db = openDb(':memory:');
  insertBareTask(db, 'T-TOKEN');
  const co = checkout(db, { taskId: 'T-TOKEN', agentId: 'bridge-a', now: new Date(T(1)) });
  assert.equal(assertLease(db, 'T-TOKEN', 'LS-wrong').status, 409);
  assert.equal(assertLease(db, 'T-TOKEN', null).status, 409);
  assert.equal(assertLease(db, 'T-MISSING', co.leaseToken).status, 404);
  assert.equal(assertLease(db, 'T-TOKEN', co.leaseToken, new Date(T(1))).ok, true);
  assert.equal(releaseLease(db, 'T-TOKEN', co.leaseToken).released, true);
  assert.equal(releaseLease(db, 'T-TOKEN', co.leaseToken).released, false);
  db.close();
});

test('P2-2 · 过期 lease 拒绝回写（410），expireLeases 自动释放并置 blocked', () => {
  const db = openDb(':memory:');
  insertBareTask(db, 'T-EXPIRE');
  const co = checkout(db, { taskId: 'T-EXPIRE', agentId: 'bridge-a', now: new Date(T(1)), ttlSec: 1 });
  const later = new Date(Date.parse(T(1)) + 5000);
  assert.equal(assertLease(db, 'T-EXPIRE', co.leaseToken, later).status, 410);
  const out = expireLeases(db, later);
  assert.equal(out.released, 1);
  assert.equal(db.prepare('SELECT leaseToken FROM tasks WHERE taskId = ?').get('T-EXPIRE').leaseToken, null);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-EXPIRE').status, 'blocked');
  assert.equal(auditHas(db, 'lease_expired'), true);
  db.close();
});

test('P2-2 · awaiting_decision 挂起态 lease 冻结：不释放、仍认原持有者', () => {
  const db = openDb(':memory:');
  insertBareTask(db, 'T-HOLD');
  const co = checkout(db, { taskId: 'T-HOLD', agentId: 'bridge-a', now: new Date(T(1)), ttlSec: 1 });
  transition(db, 'T-HOLD', 'awaiting_decision');
  const later = new Date(Date.parse(T(1)) + 3600000);
  assert.equal(expireLeases(db, later).released, 0);
  const frozen = assertLease(db, 'T-HOLD', co.leaseToken, later);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.frozen, true);
  assert.equal(db.prepare('SELECT leaseToken FROM tasks WHERE taskId = ?').get('T-HOLD').leaseToken, co.leaseToken);
  db.close();
});

test('P2-2 · bridge token：本地免密放行，配了 token 时错误/缺失返回 401', () => {
  assert.equal(assertBridgeToken({}, null).ok, true);
  assert.equal(assertBridgeToken({}, 'secret').status, 401);
  assert.equal(assertBridgeToken({ 'x-bridge-token': 'bad' }, 'secret').status, 401);
  assert.equal(assertBridgeToken({ 'x-bridge-token': 'secret' }, 'secret').ok, true);
  assert.equal(assertBridgeToken({ authorization: 'Bearer secret' }, 'secret').ok, true);
});

test('P2-2 · 走 API 回写：重复 checkout 返 409，过期 lease 返 410', async () => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  insertBareTask(db, 'T-API-LEASE');
  let clock = new Date(T(1));
  const api = createBridgeApi({ engine, now: () => clock });
  const co = await api.handle({
    method: 'POST', pathname: '/api/bridge/checkout',
    body: { taskId: 'T-API-LEASE', agentId: 'worker-01', ttlSec: 1 },
  });
  assert.equal(co.status, 200);
  const again = await api.handle({
    method: 'POST', pathname: '/api/bridge/checkout',
    body: { taskId: 'T-API-LEASE', agentId: 'bridge-b' },
  });
  assert.equal(again.status, 409);
  clock = new Date(Date.parse(T(1)) + 5000);
  const expired = await api.handle({
    method: 'POST', pathname: '/api/bridge/progress',
    body: { taskId: 'T-API-LEASE', leaseToken: co.data.leaseToken, percent: 50 },
  });
  assert.equal(expired.status, 410);
  assert.match(expired.data.error, /过期/);
  db.close();
});

// ---------------------------------------------------------------- P2-3

test('P2-3 · bridge 离线期间新任务保持 todo，不唤醒、不烧额度', async () => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  const r = await engine.submit({ requestId: 'REQ-OFFLINE', text: '断机期间的需求', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');
  assert.equal(engine.getRuns().length, 0);
  assert.equal(isBridgeOnline(db, 'worker-01'), false);
  assert.equal(auditHas(db, 'queued_offline'), true);
  assert.equal(r.pending, 0, '拉模式下事件仍被消费掉，不堆积');
  db.close();
});

test('P2-3 · 心跳 / 在线窗口 / 离线标记', () => {
  const db = openDb(':memory:');
  const t0 = new Date(T(1));
  heartbeat(db, { agentId: 'worker-01', meta: { host: 'local' }, now: t0 });
  assert.equal(isBridgeOnline(db, 'worker-01', 60, t0), true);
  assert.equal(isBridgeOnline(db, 'worker-01', 60, new Date(t0.getTime() + 61000)), false);
  assert.equal(listBridges(db, 60, t0)[0].online, true);
  assert.equal(listBridges(db, 60, t0)[0].meta.host, 'local');
  markBridgeOffline(db, 'worker-01');
  assert.equal(db.prepare('SELECT status FROM bridges WHERE agentId = ?').get('worker-01').status, 'offline');
  db.close();
});

test('P2-3 · progress 只留痕、0 唤醒；change-request / snapshot 都要先验 lease', async () => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  insertBareTask(db, 'T-PROGRESS');
  const api = createBridgeApi({ engine, now: () => new Date(T(1)) });
  const before = engine.getRuns().length;
  const noLease = await api.handle({ method: 'POST', pathname: '/api/bridge/progress', body: { taskId: 'T-PROGRESS' } });
  assert.equal(noLease.status, 409);
  const co = checkout(db, { taskId: 'T-PROGRESS', agentId: 'worker-01', now: new Date(T(1)) });
  const ok = await api.handle({
    method: 'POST', pathname: '/api/bridge/progress',
    body: { taskId: 'T-PROGRESS', leaseToken: co.leaseToken, percent: 60 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.wakes, 0);
  assert.equal(engine.getRuns().length, before);
  assert.equal(auditHas(db, 'progress_only'), true);
  const snap = await api.handle({
    method: 'POST', pathname: '/api/bridge/snapshot',
    body: { taskId: 'T-PROGRESS', leaseToken: co.leaseToken },
  });
  assert.equal(snap.status, 200);
  assert.match(snap.data.note, /P4/);
  db.close();
});

test('P2-3 · adapter 崩了也回写失败报告，任务不会被 lease 永久锁死', async (t) => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  insertBareTask(db, 'T-BOOM');
  const { base } = await withServer(engine, t);
  const bridge = createBridge({
    baseUrl: base, agentId: 'worker-01', pollMs: 0, maxLoops: 1,
    adapter: { execute: () => { throw new Error('模拟 adapter 崩溃'); } },
  });
  const res = await bridge.pollOnce();
  assert.equal(res.done.length, 1);
  assert.equal(res.done[0].ok, true, '失败报告本身要被控制面接住');
  assert.equal(db.prepare('SELECT leaseToken FROM tasks WHERE taskId = ?').get('T-BOOM').leaseToken, null);
  assert.equal(engine.getRuns().length, 1);
  assert.equal(auditHas(db, 'report_rejected'), true);
  db.close();
});

// ---------------------------------------------------------------- P2-4

test('P2-4 · 运维席位 adapter：local / ssh 目标全来自参数，command 必填', () => {
  assert.throws(() => buildOpsAdapterConfig({}), /必须显式提供 command/);
  assert.throws(() => buildOpsAdapterConfig({ target: 'ssh', command: 'whoami' }), /必须提供 host/);
  assert.throws(() => buildOpsAdapterConfig({ target: 'telnet', command: 'x' }), /未知运维目标/);
  const local = buildOpsAdapterConfig({ command: 'echo ok', cwd: '/srv/app' });
  assert.equal(local.type, 'process');
  assert.match(local.config.command, /cd '\/srv\/app' && echo ok/);
  const ssh = buildOpsAdapterConfig({
    target: 'ssh', host: 'ops.example.internal', user: 'ops', port: 2222,
    command: 'systemctl status aicompany', cwd: '/srv/app',
  });
  assert.match(ssh.config.command, /-p 2222/);
  assert.match(ssh.config.command, /ops@ops\.example\.internal/);
});

test('P2-4 · 硬编码主机 / 盘符路径能被查出来；示例配置零产品名', () => {
  assert.deepEqual(findHardcodedTarget("cd '/srv/app' && echo ok"), []);
  const hits = findHardcodedTarget('ssh 192.168.1.10 C:\\Users\\me\\x /home/alice/run.sh');
  assert.ok(hits.includes('IP 地址'));
  assert.ok(hits.includes('Windows 盘符路径'));
  assert.ok(hits.includes('本机用户目录'));
  const yaml = fs.readFileSync(path.join(ROOT, 'config', 'company.example.yaml'), 'utf8');
  assert.ok(!/\b(dsh|feishu|lark|workbuddy|claude|chatgpt)\b/i.test(yaml));
  assert.ok(yaml.includes('${AICOMPANY_CEO_CMD}'));
});

// ---------------------------------------------------------------- P2-5

test('P2-5 · registerJob 过 schema；非法 job 拒绝；event 型触发不吃 cron 时钟', () => {
  const { db, rec } = makeRecurring();
  assert.throws(() => rec.registerJob({ ...makeJob(), kind: 'unknown' }), /循环任务不合法/);
  const ev = rec.registerJob(makeJob({
    jobId: 'JOB-EVENT',
    trigger: { type: 'event', rrule: null, timezone: 'UTC', eventTrigger: 'file_arrived' },
    nextFireAt: null,
  }));
  assert.equal(ev.nextFireAt, null);
  const fired = rec.fire({ jobId: 'JOB-EVENT', scheduledAt: T(1), now: T(1) });
  assert.equal(fired.created, true);
  assert.equal(rec.getJob('JOB-EVENT').nextFireAt, null, 'event 型不能被算成每天触发');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycles').get().n, 1);
  db.close();
});

test('P2-5 · misfire：停机跨 3 个触发点只补 1 轮；skip 不补；catch_up 有限补投', () => {
  const base = { trigger: { rrule: 'FREQ=HOURLY;BYMINUTE=0', timezone: 'UTC' } };
  const from = '2026-01-01T00:00:00.000Z';
  const to = '2026-01-01T03:00:00.000Z';
  assert.equal(occurrencesBetween(base.trigger.rrule, from, to, 'UTC').length, 3);
  assert.equal(selectFires({ ...base, misfirePolicy: 'run_once', misfireGraceMin: 720 }, from, to).length, 1);
  const late = { ...base, misfireGraceMin: 30 };
  assert.equal(selectFires({ ...late, misfirePolicy: 'skip' }, from, to).length, 0);
  assert.equal(selectFires({ ...late, misfirePolicy: 'catch_up' }, from, to).length, 3);
});

test('P2-5 · overlap=skip 写 audit 不建卡；parallel 才允许并行建卡', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-OVERLAP' }));
  const r1 = rec.fire({ jobId: 'JOB-OVERLAP', scheduledAt: T(1), now: T(1) });
  const r2 = rec.fire({ jobId: 'JOB-OVERLAP', scheduledAt: T(1, 3), now: T(1, 3) });
  assert.equal(r1.created, true);
  assert.equal(r2.skipped, true);
  assert.match(r2.reason, /overlap/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(auditHas(db, 'overlap_skip'), true);

  rec.registerJob(makeJob({ jobId: 'JOB-PARALLEL', overlapPolicy: 'parallel' }));
  assert.equal(rec.fire({ jobId: 'JOB-PARALLEL', scheduledAt: T(2), now: T(2) }).created, true);
  assert.equal(rec.fire({ jobId: 'JOB-PARALLEL', scheduledAt: T(2, 3), now: T(2, 3) }).created, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycles WHERE jobId = ?').get('JOB-PARALLEL').n, 2);
  db.close();
});

test('P2-5 · cron 与补偿扫描同分钟不双触发（cycle_fires 主键去重）', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-DEDUP', overlapPolicy: 'parallel' }));
  const r1 = rec.fire({ jobId: 'JOB-DEDUP', scheduledAt: T(1, 2), now: T(1, 2) });
  assert.equal(r1.created, true);
  const scan = compensationScan(db, { olderThanMs: 0 });
  assert.equal(scan.requeued, 1, '补偿扫描只补发唤醒事件，不建新轮次卡');
  const r2 = rec.fire({ jobId: 'JOB-DEDUP', scheduledAt: T(1, 2), now: T(1, 2) });
  assert.equal(r2.skipped, true);
  assert.match(r2.reason, /同一触发点/);
  assert.equal(r2.taskId, r1.taskId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycle_fires').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycles').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  db.close();
});

test('P2-5 · 连败 3 轮自动 paused + Notifier，且系统不会自动恢复', () => {
  const { db, rec, notifier } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-FAIL' }));
  for (let i = 1; i <= 3; i += 1) {
    const fired = rec.fire({ jobId: 'JOB-FAIL', scheduledAt: T(i), now: T(i) });
    assert.equal(fired.created, true, `第 ${i} 轮不该被上一轮失败堵住`);
    const summary = rec.completeCycle({
      jobId: 'JOB-FAIL', cycleNo: i, status: 'failed',
      metrics: {}, findings: [], runIds: [],
    });
    if (i === 3) assert.equal(summary.autoPaused, true);
  }
  assert.equal(rec.getJob('JOB-FAIL').status, 'paused');
  assert.equal(rec.getJob('JOB-FAIL').consecutiveFailures, 3);
  assert.equal(notifier.messages.some((m) => m.scene === 'alert' && /暂停/.test(m.title)), true);
  assert.equal(rec.fire({ jobId: 'JOB-FAIL', scheduledAt: T(4), now: T(4) }).skipped, true);
  assert.equal(rec.resumeJob('JOB-FAIL').status, 'active', '恢复必须人工调用');
  assert.equal(rec.getJob('JOB-FAIL').consecutiveFailures, 0);
  db.close();
});

test('P2-5 · 跨轮 carryOver 注入 input.previousFindings，ageCycles 逐轮累加', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-CARRY' }));
  rec.fire({ jobId: 'JOB-CARRY', scheduledAt: T(1), now: T(1) });
  rec.completeCycle({
    jobId: 'JOB-CARRY', cycleNo: 1, status: 'done', metrics: { issues: 5 },
    findings: [{ id: 'f1', text: '登录页慢', state: 'open' }], runIds: [],
  });

  const r2 = rec.fire({ jobId: 'JOB-CARRY', scheduledAt: T(2), now: T(2) });
  assert.equal(r2.previousFindings.length, 1);
  assert.equal(r2.previousFindings[0].text, '登录页慢');
  assert.equal(r2.previousFindings[0].ageCycles, 1);
  assert.equal(r2.periodStart, T(1), '本轮区间从上一轮结束接着走');
  const input2 = JSON.parse(db.prepare('SELECT inputJson FROM task_payload WHERE taskId = ?').get(r2.taskId).inputJson);
  assert.deepEqual(input2.previousFindings, r2.previousFindings);
  assert.equal(input2.baseline.issues, 5);

  rec.completeCycle({
    jobId: 'JOB-CARRY', cycleNo: 2, status: 'done', metrics: { issues: 8 },
    findings: [
      { id: 'f1', text: '登录页慢', state: 'open' },
      { id: 'f2', text: '已修复', state: 'resolved' },
    ], runIds: [],
  });
  const r3 = rec.fire({ jobId: 'JOB-CARRY', scheduledAt: T(3), now: T(3) });
  assert.equal(r3.previousFindings.length, 1, 'resolved 的问题不再带下去');
  assert.equal(r3.previousFindings[0].ageCycles, 2);
  db.close();
});

test('P2-5 · deltaVsPrev 只能由控制面算，调用方自带的数字不被采信', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-DELTA' }));
  rec.fire({ jobId: 'JOB-DELTA', scheduledAt: T(1), now: T(1) });
  rec.completeCycle({ jobId: 'JOB-DELTA', cycleNo: 1, status: 'done', metrics: { issues: 5 }, runIds: [] });
  rec.fire({ jobId: 'JOB-DELTA', scheduledAt: T(2), now: T(2) });
  const summary = rec.completeCycle({
    jobId: 'JOB-DELTA', cycleNo: 2, status: 'done',
    metrics: { issues: 8, ratio: 0.5 },
    deltaVsPrev: { issues: 999 }, // 故意塞一个假的，必须被忽略
    runIds: [],
  });
  assert.equal(summary.deltaVsPrev.issues, 3);
  assert.equal(summary.deltaVsPrev.ratio, undefined, '没有上一轮同名字段就不编造差值');
  assert.equal(summary.deltaVsPrev.issues, 3);
  assert.equal(JSON.stringify(summary).includes('999'), false);
  db.close();
});

test('P2-5 · jobVersion 快照隔离：注册 v2 不覆盖 v1 的轮次与任务卡来源', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-VER', jobVersion: 1 }));
  const r1 = rec.fire({ jobId: 'JOB-VER', scheduledAt: T(1), now: T(1) });
  rec.completeCycle({ jobId: 'JOB-VER', cycleNo: 1, status: 'done', metrics: {}, runIds: [] });
  rec.registerJob(makeJob({ jobId: 'JOB-VER', jobVersion: 2, lastCycleNo: 1 }));
  const r2 = rec.fire({ jobId: 'JOB-VER', scheduledAt: T(2), now: T(2) });
  const cycles = rec.listCycles('JOB-VER');
  assert.deepEqual(cycles.map((c) => c.jobVersion), [1, 2]);
  assert.equal(r1.jobVersion, 1);
  assert.equal(r2.jobVersion, 2);
  assert.equal(r2.cycleNo, 2);
  const origin1 = JSON.parse(db.prepare('SELECT originJson FROM tasks WHERE taskId = ?').get(r1.taskId).originJson);
  const origin2 = JSON.parse(db.prepare('SELECT originJson FROM tasks WHERE taskId = ?').get(r2.taskId).originJson);
  assert.equal(origin1.jobVersion, 1);
  assert.equal(origin2.jobVersion, 2);
  assert.equal(rec.listHistory('JOB-VER').length, 1, 'v2 不回头改写 v1 的历史');
  db.close();
});

test('P2-5 · completeCycle 收账时同步收口任务卡，不留永远 todo 的孤儿卡', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-CLOSE' }));
  const r1 = rec.fire({ jobId: 'JOB-CLOSE', scheduledAt: T(1), now: T(1) });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r1.taskId).status, 'todo');
  rec.completeCycle({ jobId: 'JOB-CLOSE', cycleNo: 1, status: 'done', metrics: {}, runIds: [] });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r1.taskId).status, 'done');
  assert.equal(auditHas(db, 'cycle_task_closed'), true);
  assert.equal(rec.fire({ jobId: 'JOB-CLOSE', scheduledAt: T(2), now: T(2) }).created, true,
    '收账后下一轮不该被旧卡状态误判为 overlap');
  db.close();
});

// ---------------------------------------------------------------- P2-6

test('P2-6 · 受限 rrule：四种 FREQ / 固定时区偏移 / 非法规则明确拒绝', () => {
  assert.equal(timezoneOffsetMin('UTC'), 0);
  assert.equal(timezoneOffsetMin('Asia/Shanghai'), 480);
  assert.equal(timezoneOffsetMin('+05:30'), 330);
  assert.throws(() => timezoneOffsetMin('Mars/Olympus'), /不支持的时区/);
  assert.throws(() => parseRRule('FREQ=YEARLY'), /不支持的 FREQ/);
  assert.throws(() => parseRRule('FREQ=DAILY;INTERVAL=0'), /INTERVAL/);
  assert.throws(() => parseRRule('FREQ=WEEKLY;BYDAY=XX'), /BYDAY 未知/);

  const daily = occurrencesBetween(
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 'UTC',
  );
  assert.deepEqual(daily, [
    '2026-01-01T09:00:00.000Z', '2026-01-02T09:00:00.000Z', '2026-01-03T09:00:00.000Z',
  ]);
  const shanghai = occurrencesBetween(
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'Asia/Shanghai',
  );
  assert.deepEqual(shanghai, ['2026-01-01T01:00:00.000Z'], '北京时间 9 点 = UTC 1 点');
  const weekly = occurrencesBetween(
    'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=0',
    '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z', 'UTC',
  );
  assert.equal(weekly.length, 2);
  const monthly = occurrencesBetween(
    'FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=0',
    '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'UTC',
  );
  assert.equal(monthly.length, 2);
  assert.equal(nextFireAt('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', '2026-01-01T10:00:00.000Z', 'UTC'),
    '2026-01-02T09:00:00.000Z');
});

test('P2-6 · scheduler 可注入时间、tick 计数、start/stop 都不阻止进程退出', () => {
  const seen = [];
  const rec = { tick: ({ now }) => ({ at: now, fired: 1, results: [] }) };
  const sched = createScheduler({ recurring: rec, intervalMs: 100000, now: () => FAR, onTick: (r) => seen.push(r.at) });
  const r = sched.runOnce({ now: '2026-02-01T00:00:00.000Z' });
  assert.equal(r.at, '2026-02-01T00:00:00.000Z');
  assert.equal(r.fired, 1);
  assert.equal(sched.ticks, 1);
  assert.equal(seen.length, 1);
  assert.equal(sched.running, false);
  assert.equal(sched.start().started, true);
  assert.equal(sched.start().started, false);
  assert.equal(sched.running, true);
  assert.equal(sched.stop().stopped, true);
  assert.equal(sched.stop().stopped, false);
});

test('P2-6 · 真实 tick：到点的 job 才实例化，且只建 1 张轮次卡', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-TICK', nextFireAt: T(1, 1) }));
  const sched = createScheduler({ recurring: rec, now: () => T(1, 2) });
  const tooEarly = sched.runOnce({ now: T(1, 0) });
  assert.equal(tooEarly.fired, 0);
  const hit = sched.runOnce({ now: T(1, 2) });
  assert.equal(hit.fired, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycles').get().n, 1);
  assert.equal(rec.getJob('JOB-TICK').nextFireAt, T(1, 3));
  db.close();
});

test('P2-6 · 结构化日志按天轮转、只读白名单文件、不自动删除任何文件', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p2-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); // 只清自己刚建的临时目录
  let clock = new Date('2026-01-01T10:00:00.000Z');
  const logger = createLogger({ dir, now: () => clock });
  logger.info('tick', { fired: 1 });
  clock = new Date('2026-01-02T10:00:00.000Z');
  logger.warn('lease_expired', { taskId: 'T-1' });
  assert.deepEqual(logger.listFiles(), ['2026-01-01.log', '2026-01-02.log']);
  assert.equal(logger.readDay('2026-01-01').length, 1);
  assert.equal(logger.readDay('2026-01-01')[0].fired, 1);
  assert.equal(logger.readDay('2026-01-02')[0].level, 'warn');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'do-not-touch');
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  assert.equal(logger.listFiles().includes('keep.txt'), false);
  assert.deepEqual(logger.readDay('../../etc/passwd'), [], '非法日期读不出任何东西');
});

test('P2-6 · daemon 指数退避 + 连续重启上限；工程保持零运行时依赖', () => {
  assert.deepEqual(shouldRestart({ restarts: 0, backoffMs: 1000 }), { restart: true, backoffMs: 1000 });
  assert.equal(shouldRestart({ restarts: 1, backoffMs: 1000 }).backoffMs, 2000);
  assert.equal(shouldRestart({ restarts: 3, backoffMs: 1000 }).backoffMs, 8000);
  assert.equal(shouldRestart({ restarts: 9, maxRestarts: 10, backoffMs: 1000 }).backoffMs, 60000);
  assert.equal(shouldRestart({ restarts: 10, maxRestarts: 10 }).restart, false);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  for (const name of ['start', 'bridge', 'start:daemon', 'test:p2']) {
    assert.ok(pkg.scripts[name], `package.json 缺脚本 ${name}`);
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    assert.equal(/from\s+['"](node-cron|pm2|rrule|better-sqlite3|js-yaml|zod)['"]/.test(text), false,
      `${file} 不应引入外部运行时依赖`);
  }
});

// ---------------------------------------------------------------- G-P2

test('G-P2 · 断机 30 分钟：任务排队不丢，恢复心跳后按 createdAt 顺序补领', async () => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  let clock = new Date(T(1, 0));
  const api = createBridgeApi({ engine, now: () => clock });
  await api.handle({ method: 'POST', pathname: '/api/bridge/heartbeat', body: { agentId: 'worker-01' } });
  await engine.submit({ requestId: 'REQ-C1', text: '断机前', mode: 'direct', addressedTo: 'worker-01' });

  clock = new Date(clock.getTime() + 30 * 60000); // 停 bridge 30 分钟
  await engine.submit({ requestId: 'REQ-C2', text: '断机中 1', mode: 'direct', addressedTo: 'worker-01' });
  await engine.submit({ requestId: 'REQ-C3', text: '断机中 2', mode: 'direct', addressedTo: 'worker-01' });
  const off = await api.handle({ method: 'GET', pathname: '/api/bridge/status', query: new URLSearchParams() });
  assert.equal(off.data.queued, 3);
  assert.equal(off.data.bridges[0].online, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo'").get().n, 3);
  assert.equal(engine.getRuns().length, 0, '离线期间一次都不唤醒');

  clock = new Date(clock.getTime() + 60000); // 开机
  await api.handle({ method: 'POST', pathname: '/api/bridge/heartbeat', body: { agentId: 'worker-01' } });
  const inbox = await api.handle({
    method: 'GET', pathname: '/api/bridge/inbox',
    query: new URLSearchParams({ agentId: 'worker-01' }),
  });
  assert.equal(inbox.data.count, 3);
  assert.equal(inbox.data.online, true);
  const expected = db.prepare('SELECT taskId FROM tasks ORDER BY createdAt, rowid').all().map((r) => r.taskId);
  assert.deepEqual(inbox.data.tasks.map((t) => t.taskId), expected, '补投按创建顺序，不插队');
  db.close();
});

test('G-P2 · 真实 HTTP：离线 5 张排队 → 开机补领各执行一次 → 不重复执行', async (t) => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  const { base } = await withServer(engine, t);
  t.after(() => db.close());

  for (let i = 0; i < 5; i += 1) {
    const res = await post(base, '/api/requests', {
      requestId: `REQ-BRIDGE-${i}`, text: `断机期间的需求 ${i}`,
      mode: 'direct', addressedTo: 'worker-01',
    });
    assert.equal(res.status, 201);
  }
  const status0 = await (await fetch(`${base}/api/bridge/status`)).json();
  assert.equal(status0.queued, 5);
  assert.equal(status0.bridges.length, 0);
  assert.equal(status0.dispatchMode, 'bridge');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo'").get().n, 5);
  assert.equal(engine.getRuns().length, 0);

  const bridge = createBridge({
    baseUrl: base, agentId: 'worker-01', pollMs: 0, maxLoops: 1,
    adapter: getAdapter('mock'), adapterConfig: { result: (ctx) => completion(ctx) },
  });
  const first = await bridge.pollOnce();
  assert.equal(first.done.length, 5);
  assert.equal(first.done.every((x) => x.ok), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'").get().n, 5);
  assert.equal(engine.getRuns().length, 5, '5 张卡各且仅执行一次');
  assert.equal((await (await fetch(`${base}/api/bridge/status`)).json()).queued, 0);

  const second = await bridge.pollOnce();
  assert.equal(second.done.length, 0, '重复拉不重复执行');
  assert.equal(engine.getRuns().length, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE leaseToken IS NOT NULL').get().n, 0);
});

test('G-P2 · 同一个 HTTP 服务上：Web Board / bridge / 循环 / 调度共用一套 /api', async (t) => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  const { base } = await withServer(engine, t);
  t.after(() => db.close());

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /AICompany · Web Board/);
  assert.ok(html.includes('/api/bridge/status'));
  assert.ok(html.includes('/api/recurring'));

  const job = makeJob({ jobId: 'JOB-http', nextFireAt: T(1, 1), overlapPolicy: 'parallel' });
  const reg = await post(base, '/api/recurring', job);
  assert.equal(reg.status, 201);
  const jobs = await (await fetch(`${base}/api/recurring`)).json();
  assert.equal(jobs.length, 1);

  const tick = await post(base, '/api/scheduler/tick', { now: T(1, 2) });
  assert.equal(tick.status, 200);
  assert.equal((await tick.json()).fired, 1);
  const cycles = await (await fetch(`${base}/api/cycles?jobId=JOB-http`)).json();
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].cycleNo, 1);

  const closed = await post(base, '/api/recurring/JOB-http/complete-cycle', {
    cycleNo: 1, status: 'done', metrics: { issues: 5 },
    findings: [{ id: 'f1', text: '磁盘告警', state: 'open' }], runIds: [],
  });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).deltaVsPrev.issues, undefined);

  const next = await post(base, '/api/recurring/JOB-http/fire', { scheduledAt: T(2, 3), now: T(2, 3) });
  assert.equal(next.status, 200);
  const second = await next.json();
  assert.equal(second.created, true);
  assert.equal(second.cycleNo, 2);
  assert.equal(second.previousFindings[0].text, '磁盘告警', '第 1 轮 finding 出现在第 2 轮输入里');

  const history = await (await fetch(`${base}/api/cycle-history?jobId=JOB-http`)).json();
  assert.equal(history.length, 1);
  assert.equal(JSON.parse(history[0].deltaJson).issues, undefined);
  assert.equal((await (await fetch(`${base}/api/scheduler`)).json()).ticks, 1);
});

test('G-P2 · bridge token 401 由统一 API 拦下；本地 inline 演示仍与 P1 一样跑通', async (t) => {
  const { db, engine } = makeEngine({ dispatchMode: 'bridge' });
  const { base } = await withServer(engine, t, { bridgeToken: 'secret' });
  t.after(() => db.close());
  assert.equal((await fetch(`${base}/api/bridge/status`)).status, 401);
  const ok = await fetch(`${base}/api/bridge/status`, { headers: { 'x-bridge-token': 'secret' } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dispatchMode, 'bridge');

  const local = makeEngine(); // 默认 inline，不配任何环境变量
  t.after(() => local.db.close());
  const r = await local.engine.submit({ requestId: 'REQ-INLINE-P2', text: '本地单机演示', mode: 'delegate' });
  assert.equal(local.db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');
  assert.equal(local.engine.getRuns().length >= 2, true);
  assert.equal(r.pending, 0);
});

test('P2-7 · 循环卡必须带项目归属：否则「替项目干活却不认这个项目」', () => {
  const { db, rec } = makeRecurring();
  // 带 project 的 job：卡上要能读到同一个项目，后续规范注入 / 经验 / 交付才有着落。
  rec.registerJob(makeJob({ jobId: 'JOB-PROJ', project: 'yitai' }));
  const fired = rec.fire({ jobId: 'JOB-PROJ', scheduledAt: FAR, now: FAR });
  assert.equal(fired.created, true);
  const row = db.prepare('SELECT project, title FROM tasks WHERE taskId = ?').get(fired.taskId);
  assert.equal(row.project, 'yitai', '循环卡丢了项目归属 = 产物和经验都进不了项目');

  // 不写 project 的老 job 仍然可以跑，只是不归属任何项目（向后兼容）。
  rec.registerJob(makeJob({ jobId: 'JOB-NOPROJ' }));
  const fired2 = rec.fire({ jobId: 'JOB-NOPROJ', scheduledAt: FAR, now: FAR });
  assert.equal(fired2.created, true);
  assert.equal(db.prepare('SELECT project FROM tasks WHERE taskId = ?').get(fired2.taskId).project, null);
  db.close();
});
