// 2026-11-18 真机事故回归：桥接总开关 + 事件泵并发认领。
//
// 事故现场：工程执行岗的卡被 GUI 那趟活占着（adapter 一次跑 5~20 分钟），handleEvent 里 await 不放，
// 整条事件队列被一张卡堵死；新下单的任务连事件都排不上，看板看着像宕机。
// 另外董事会要求：桥接（bridge / seat 拉模式）停用、代码保留，工程执行岗位只走 GUI 直派。

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, markProcessed, emit } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { registerAdapter, mockAdapter } from '../src/adapters.js';

const mockConfig = (overrides = {}) => ({
  version: 1,
  company: { name: 'test-company', timezone: 'Asia/Shanghai' },
  interaction: { defaultMode: 'direct', defaultTarget: 'worker-01', autoAssign: false },
  agents: [
    {
      id: 'worker-01', displayName: '执行席位', isCEO: false,
      capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: null,
      dispatch: 'push',
      adapter: {
        type: 'mock',
        config: {
          result: (ctx) => ({
            schema: 'aicompany.completion/v1',
            taskId: ctx.task?.taskId ?? 'T-x', runId: ctx.runId, agent: 'worker-01',
            revision: 1, status: 'success', summary: 'ok',
            artifacts: [], acceptanceResults: [], usage: { quotaUnits: 1 },
            finishedAt: new Date().toISOString(),
          }),
        },
      },
    },
  ],
  clients: ['web'],
  notifier: ['noop'],
  ...overrides,
});

const makeEngine = (overrides) => {
  const db = openDb(':memory:');
  const config = mockConfig(overrides);
  const engine = createEngine({ db, config, notifier: createNotifier('noop'), dispatchMode: 'inline' });
  return { db, config, engine };
};

test('BD-1 · 桥接关死：领活类 POST 一律 503，只读 GET / 交结论 / 任务 API 不受影响', async (t) => {
  const { engine } = makeEngine({ bridge: { enabled: false } });
  const server = createServer({ engine, port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const checkout = await fetch(`${base}/api/bridge/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'worker-01' }),
  });
  assert.equal(checkout.status, 503);
  const body = await checkout.json();
  assert.equal(body.code, 'BRIDGE_DISABLED');
  assert.match(String(body.error), /bridge\.enabled/);

  // 心跳同样被拒：误启动的 seat / bridge 客户端不能靠心跳把自己「叫上线」。
  const hb = await fetch(`${base}/api/bridge/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'worker-01' }),
  });
  assert.equal(hb.status, 503);

  // 看板初始化用的只读状态必须放行：这里一挡到底，整个看板会白屏（任务卡区消失）。
  const status = await fetch(`${base}/api/bridge/status`);
  assert.equal(status.status, 200, 'GET /api/bridge/status 必须仍可用，否则看板初始化会整块失败');
  const statusBody = await status.json();
  assert.ok(Array.isArray(statusBody.bridges));

  // 交验收结论的通道必须放行：它不是领活，关掉它验收就会「跑完有结论、引擎读不到」死循环。
  const review = await fetch(`${base}/api/bridge/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: 'T-not-exist', agentId: 'worker-01', verdict: 'pass', reason: 'x' }),
  });
  const reviewBody = await review.json();
  assert.notEqual(reviewBody.code, 'BRIDGE_DISABLED', 'POST /api/bridge/review 不得被桥接开关挡掉');

  // 领活类动作仍然必须被拒（否则桥接客户端照样能把卡领走）。
  const checkout2 = await fetch(`${base}/api/bridge/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'worker-01' }),
  });
  assert.equal(checkout2.status, 503);

  // 看板自己的接口照常：关桥接不是把整个 API 关掉。
  const tasks = await fetch(`${base}/api/tasks`);
  assert.equal(tasks.status, 200);
});

// 2026-11-18 真机事故：工程岗（CTO）拿到卡、方案也写好了，一调 spawn 就吃 503 BRIDGE_DISABLED，
// 于是它判断「派不出去」，退回自己动手改代码 —— 中层不下场这件事被开关亲手废掉了。
// 开关的本意是防「桥接客户端把卡领走、和 GUI 直派抢同一张卡」，spawn 既不领卡也不改别人的状态，
// 只是新建一张子卡，而且引擎侧还有三道闸，必须留在开关外面。
test('BD-1b · 桥接关死时中层照样能派活：spawn 不被开关拦，且真正建出子卡', async (t) => {
  const { engine, db } = makeEngine({
    bridge: { enabled: false },
    agents: [
      {
        id: 'cto-01', displayName: '工程执行（CTO）', isCEO: false,
        capabilities: ['execute', 'delegate', 'review', 'plan'], status: 'active',
        quotaDaily: 20, reportsTo: 'ceo-01', dispatch: 'push',
        adapter: { type: 'mock', config: {} },
      },
      {
        id: 'worker-01', displayName: '执行席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 20,
        reportsTo: 'cto-01', dispatch: 'push',
        adapter: { type: 'mock', config: {} },
      },
    ],
  });
  const server = createServer({ engine, port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // 父卡：一张已经派到 CTO 手里的实现卡
  db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, status, assignee, createdAt, updatedAt, revision, attempt, mode)
    VALUES ('T-parent', 'REQ-1', '给首页加缓存', 'in_progress', 'cto-01', ?, ?, 1, 1, 'delegate')`)
    .run(new Date().toISOString(), new Date().toISOString());

  const spawn = await fetch(`${base}/api/bridge/spawn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parentTaskId: 'T-parent', agentId: 'cto-01', assignee: 'worker-01',
      title: '实现缓存层', instructions: '按方案实现，附单测', acceptance: ['测试通过'],
      difficulty: 'normal',
    }),
  });
  const body = await spawn.json();
  assert.notEqual(body.code, 'BRIDGE_DISABLED', 'spawn 是派活通道，不是领活通道，不得被桥接开关挡掉');
  assert.equal(spawn.status, 201, `中层派活应当成功（实际 ${spawn.status} ${JSON.stringify(body)}`);
  assert.ok(body.taskId, '必须真的建出子卡');
  assert.equal(body.assignee, 'worker-01');

  // 子卡落库，且父卡关系与发布者都写对（验收人默认就是派活的人）
  const child = db.prepare('SELECT assignee, parentTaskId, assignerId, mode FROM tasks WHERE taskId = ?')
    .get(body.taskId);
  assert.equal(child.assignee, 'worker-01');
  assert.equal(child.parentTaskId, 'T-parent');
  assert.equal(child.assignerId, 'cto-01');
  assert.equal(child.mode, 'delegate');

  // 领活仍然被拒：开关该干的事没丢
  const checkout = await fetch(`${base}/api/bridge/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'worker-01' }),
  });
  assert.equal(checkout.status, 503);
});

test('BD-2 · 桥接打开的档位仍然能走（开关不是把代码删了）', async (t) => {
  const { engine } = makeEngine({}); // 不写 bridge.enabled = 默认放行，保持老行为
  const server = createServer({ engine, port: 0, host: '127.0.0.1', bridgeToken: 'tk' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/bridge/status`, { headers: { 'x-bridge-token': 'tk' } });
  assert.equal(res.status, 200);
});

test('BD-3 · 事件认领是原子的：第二条 UPDATE 抢不走已处理的事件', () => {
  const db = openDb(':memory:');
  const out = emit(db, { type: 'issue_assigned', taskId: 'T-a', agentId: 'worker-01' });
  assert.equal(markProcessed(db, out.eventId), 1, '第一次认领应当成功');
  assert.equal(markProcessed(db, out.eventId), 0, '第二次认领必须失败（否则多趟泵会重复派活）');
});

// 慢 adapter：模拟「GUI 一趟活要跑几分钟」，用来验证「一趟泵被占住时，别的事件还能往前走」。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
registerAdapter('slow-test', {
  type: 'slow-test',
  testEnvironment: () => ({ ok: true, detail: '测试用慢 adapter' }),
  async execute(ctx) {
    await sleep(700);
    return mockAdapter.execute(ctx);
  },
});

test('BD-4 · 泵扇出：一趟慢活占着泵，新任务的事件不必等它跑完', async (t) => {
  const prev = process.env.AICOMPANY_PUMP_UNBLOCK_MS;
  process.env.AICOMPANY_PUMP_UNBLOCK_MS = '60';
  t.after(() => {
    if (prev === undefined) delete process.env.AICOMPANY_PUMP_UNBLOCK_MS;
    else process.env.AICOMPANY_PUMP_UNBLOCK_MS = prev;
  });

  const db = openDb(':memory:');
  const config = mockConfig({
    runPolicy: { maxConcurrent: 2 },
    agents: [
      {
        id: 'a1', displayName: '慢席位一', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: null, dispatch: 'push',
        adapter: { type: 'slow-test', config: {} },
      },
      {
        id: 'a2', displayName: '慢席位二', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: null, dispatch: 'push',
        adapter: { type: 'slow-test', config: {} },
      },
    ],
  });
  const engine = createEngine({ db, config, notifier: createNotifier('noop'), dispatchMode: 'inline' });

  const insert = (taskId, assignee) => db.prepare(`INSERT INTO tasks
    (taskId, requestId, title, status, assignee, createdAt, updatedAt, revision, attempt, mode)
    VALUES (?, ?, ?, 'todo', ?, ?, ?, 1, 0, 'direct')`)
    .run(taskId, `REQ-${taskId}`, taskId, assignee, new Date().toISOString(), new Date().toISOString());

  insert('T-slow-1', 'a1');
  insert('T-slow-2', 'a2');
  emit(db, { type: 'issue_assigned', taskId: 'T-slow-1', agentId: 'a1' });
  emit(db, { type: 'issue_assigned', taskId: 'T-slow-2', agentId: 'a2' });

  const first = engine.pump();          // 这趟泵会被 a1 的慢活占住 0.7 秒
  await sleep(120);                     // 超过 60ms 的扇出阈值
  const second = engine.pump();         // 第二趟泵必须能开工，把 T-slow-2 推进
  await second;

  // 第二张卡已经跑完，而第一趟可能还在跑 —— 这就是「新任务不再被旧任务堵死」。
  const t2 = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-slow-2');
  assert.notEqual(t2.status, 'todo', `T-slow-2 仍停在 todo，说明泵被第一趟堵死了（实际 ${t2.status}）`);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'pump_fanout'").get().n > 0,
    '扇出必须留一条账，事后能查到「为什么同时有两趟泵」');

  await first;
  const t1 = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get('T-slow-1');
  assert.notEqual(t1.status, 'todo', `T-slow-1 也应当被推进（实际 ${t1.status}）`);
});
