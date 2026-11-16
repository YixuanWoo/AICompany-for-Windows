// 「工程执行」这类人机席位（拉模式）的完整链路。
//
// 背景：会话里的 agent 没有常驻进程，人叫才醒。控制面在它离线时派活只会白烧一次 Run，
// 所以这类席位配 dispatch: pull —— 卡留 todo，由它自己用 scripts/seat.js（= src/seat.js）来领。
//
// 这里守四件事：
//   1. 派活不直调它，卡留在队列（且留痕）
//   2. 心跳 / 看队列 / 领卡走的是同一套 bridge 协议，不另造
//   3. 交活要带 lease，报告合法，产物清单与控制面同口径
//   4. 维护心跳不会把它「还没领的卡」当成躺尸反复重投

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { createSeat, handoffPath } from '../src/seat.js';

const PULL_SEAT = 'engineering';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-seat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeConfig(root) {
  return {
    version: 1,
    company: { name: 'seat-test', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: {},
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo' },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan', 'review'],
        status: 'active', quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: () => ({ type: 'review', verdict: 'pass', reason: 'ok' }) } },
      },
      {
        id: 'worker-01', displayName: '执行', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} },
      },
      {
        // 人机席位：人叫才醒，只能自己来领
        id: PULL_SEAT, displayName: '工程执行', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: 'ceo', dispatch: 'pull',
        adapter: { type: 'seat', config: {} },
      },
    ],
    clients: ['web'], notifier: ['noop'],
    runPolicy: { cooldownSec: 0 },
  };
}

const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };

async function boot(t) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const engine = createEngine({
    db, config: makeConfig(root), notifier: createNotifier('noop'), workRoot: root,
  });
  const server = createServer({
    engine, port: 0, host: '127.0.0.1',
    overridesPath: path.join(root, 'runtime-overrides.json'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const seat = createSeat({ baseUrl, agentId: PULL_SEAT, workRoot: root });
  return { baseUrl, db, engine, root, seat };
}

test('S1 · 派活不直调人机席位：卡留 todo，并留一条 queued_for_pull', async (t) => {
  const { db, engine } = await boot(t);
  const r = await engine.submit({
    text: '把发布脚本改成幂等的', mode: 'direct', addressedTo: PULL_SEAT,
  });
  await pumpAll(engine);

  const row = db.prepare('SELECT status, assignee FROM tasks WHERE taskId = ?').get(r.taskId);
  assert.equal(row.status, 'todo', '人不在，卡就该留在队列，而不是硬派下去白烧一次 Run');
  assert.equal(row.assignee, PULL_SEAT);

  const audits = db.prepare("SELECT * FROM audit WHERE action = 'queued_for_pull'").all();
  assert.equal(audits.length, 1, '「留队列」必须留痕，否则看着像卡死了');
  assert.match(audits[0].newValue, new RegExp(PULL_SEAT));
  assert.equal(audits[0].taskId, r.taskId, '审计要带 taskId：按卡追溯时这是唯一入口');

  // 不该有 run：直调了就说明跑模式没生效
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
});

test('S2 · 心跳 → 看队列 → 领卡：走的是同一套 bridge 协议', async (t) => {
  const { db, engine, seat, root } = await boot(t);
  const r = await engine.submit({ text: '查一下依赖有没有越界', mode: 'direct', addressedTo: PULL_SEAT });
  await pumpAll(engine);

  const hb = await seat.heartbeat({ via: 'test' });
  assert.equal(hb.online, true);

  const box = await seat.inbox();
  assert.equal(box.tasks.length, 1);
  assert.equal(box.tasks[0].taskId, r.taskId);
  assert.ok(box.tasks[0].instructions, '领卡要能拿到任务指令，否则人没法干');

  const claimed = await seat.claim();
  assert.equal(claimed.ok, true);
  assert.equal(claimed.taskId, r.taskId);
  assert.ok(claimed.leaseToken, '领卡必须拿到 lease，否则交活会被拒');
  assert.equal(claimed.instructions !== null, true);

  const row = db.prepare('SELECT status, leaseToken FROM tasks WHERE taskId = ?').get(r.taskId);
  assert.equal(row.status, 'in_progress', '领了就该进 in_progress');
  assert.equal(row.leaseToken, claimed.leaseToken);

  // 手上那张卡要落盘：被重新叫醒时得知道「我欠一张没交」
  const held = seat.holding();
  assert.equal(held.taskId, r.taskId);
  assert.equal(fs.existsSync(handoffPath(root, PULL_SEAT)), true, '必须落盘，否则换个会话就忘了自己领过什么');
});

test('S3 · 交活：带 lease 写报告，卡 done，产物清单与控制面同口径', async (t) => {
  const { db, engine, root, seat } = await boot(t);
  const r = await engine.submit({ text: '补一个单元测试', mode: 'direct', addressedTo: PULL_SEAT });
  await pumpAll(engine);
  await seat.claim();

  // 模拟「我干了活」：产物落在任务目录的 output 下（控制面就扫这里）
  const outDir = path.join(root, 'tasks', r.taskId, 'output');
  fs.mkdirSync(path.join(outDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.md'), '# 干完了', 'utf8');
  fs.writeFileSync(path.join(outDir, 'sub', 'patch.diff'), 'diff --git a b', 'utf8');

  const done = await seat.complete({
    summary: '补了 deps.test.js 的取消用例',
    acceptanceResults: [{ rule: '测试通过', pass: true }],
  });
  assert.equal(done.ok, true);
  assert.deepEqual(
    done.report.artifacts.sort(),
    ['output/report.md', 'output/sub/patch.diff'],
    '产物要相对任务目录、带 output/ 前缀，和 deliver.js 一个口径',
  );
  assert.equal(done.report.schema, 'aicompany.completion/v1');

  const row = db.prepare('SELECT status, leaseToken FROM tasks WHERE taskId = ?').get(r.taskId);
  assert.equal(row.status, 'done');
  assert.equal(row.leaseToken, null, '交完要释放 lease');
  assert.equal(seat.holding(), null, '交完要清掉「手上有什么」，否则下次以为自己还欠一张');
});

test('S4 · 交活必须写 summary；写空就是没交代，控制面拒收', async (t) => {
  const { seat, engine } = await boot(t);
  await engine.submit({ text: '随便改点东西', mode: 'direct', addressedTo: PULL_SEAT });
  await pumpAll(engine);
  await seat.claim();

  const out = await seat.complete({ summary: '   ' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /summary/);
});

test('S5 · 手上还有一张没交时，不许再领第二张', async (t) => {
  const { seat, engine } = await boot(t);
  await engine.submit({ text: '活一', mode: 'direct', addressedTo: PULL_SEAT });
  await engine.submit({ text: '活二', mode: 'direct', addressedTo: PULL_SEAT });
  await pumpAll(engine);

  const first = await seat.claim();
  assert.equal(first.ok, true);
  const second = await seat.claim();
  assert.equal(second.ok, false, '一张没交就领第二张 = 两张同时占着手，必然漏交');
  assert.match(second.reason, /手上还有一张没交/);
});

test('S6 · 维护心跳不把「等人来领的卡」当躺尸重投', async (t) => {
  const { db, engine } = await boot(t);
  const r = await engine.submit({ text: '等你来领的活', mode: 'direct', addressedTo: PULL_SEAT });
  await pumpAll(engine);

  // 把 updatedAt 拨老，制造「躺了很久」的假象
  db.prepare("UPDATE tasks SET updatedAt = '2026-01-01T00:00:00.000Z' WHERE taskId = ?").run(r.taskId);
  await engine.reconcile({ olderThanMs: 15_000 });

  const requeued = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'reconcile_requeue'").get().n;
  assert.equal(requeued, 0, '拉模式席位的卡在等本人，不是躺尸；重投只会每 60 秒刷一条无用的拦截');
});

test('S7 · 续租：长活干不完时延长到期，不换 token', async (t) => {
  const { seat, engine } = await boot(t);
  await engine.submit({ text: '要跑很久的活', mode: 'direct', addressedTo: PULL_SEAT });
  await pumpAll(engine);

  const claimed = await seat.claim({ ttlSec: 60 });
  const renewed = await seat.renew({ ttlSec: 3600 });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.leaseToken, claimed.leaseToken, '续租只延长到期，不换 token');
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(claimed.leaseExpiresAt));
  assert.equal(seat.holding().leaseExpiresAt, renewed.leaseExpiresAt, '本地也要记住新到期时间');
});

test('S8 · 派人机席位走 adapter 直调必须炸（配置写错了要当场发现）', async (t) => {
  const { getAdapter } = await import('../src/adapters.js');
  const seatAdapter = getAdapter('seat');
  await assert.rejects(
    () => seatAdapter.execute({ agent: { id: PULL_SEAT }, task: { taskId: 'T-1' }, adapterConfig: {} }),
    /拉模式/,
  );
});
