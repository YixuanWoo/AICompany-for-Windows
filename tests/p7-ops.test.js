// P6 自主验收（第二批）：让 GUI 席位「能天天用」的配套。
//   ① 闸门（暂停 / 时段 / 空闲 / 锁屏）② 席位占位（防双开）
//   ③ 产物查看（越界拒绝）④ 实例档位 ⑤ 剪贴板还原 ⑥ 引擎把闸门当「暂时不派」而非失败
//   ⑦ 维护心跳把退回 todo 的卡重新投出去 ⑧ HTTP 端点
// 全部零外部依赖、不激活真实窗口、不联网、不烧额度。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { evaluateGate, inAllowedHours, GATE_CODES } from '../src/gui-gate.js';
import { createSeatClaim } from '../src/gui-seat.js';
import { createGuiAdapter, readPauseFlag, writePauseFlag } from '../src/gui-adapter.js';
import { createGuiDriver, createSimulationDriver } from '../src/gui-driver.js';
import { createGuiLock } from '../src/gui-lock.js';
import { listOutputs, readOutput, OutputsError } from '../src/outputs.js';
import { isFatalExit, nextDelay } from '../src/runner.js';
import { resolveProfile } from '../src/profiles.js';
import { createServer } from '../src/server.js';
import { nowIso } from '../src/ids.js';
import { sha256File } from '../src/gui-report.js';
import { buildTaskPaths } from '../src/gui-report.js';

const WINDOW = 'TEST-WINDOW';
const noWait = async () => {};
// 短延迟自检是异步的，断言得等它一下；轮询比固定 sleep 稳，也不会拖慢整体。
const waitUntil = async (fn, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch { /* 中间态不算失败，继续等 */ }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  return false;
};

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p6b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- 闸门

test('P6-2 · 闸门：默认不拦；暂停 / 时段 / 空闲 / 锁屏各自给出可读原因', () => {
  const noon = new Date('2026-11-16T12:00:00');
  assert.equal(evaluateGate({ now: noon }).ok, true);

  const paused = evaluateGate({ paused: true, pausedAt: '2026-11-16T11:00:00Z', now: noon });
  assert.equal(paused.ok, false);
  assert.equal(paused.code, GATE_CODES.paused);
  assert.match(paused.reason, /已人工暂停/);

  const hours = evaluateGate({ allowedHours: [23, 7], now: noon });
  assert.equal(hours.code, GATE_CODES.hours);

  const busy = evaluateGate({ requireIdleSec: 10, idleSec: 1, now: noon });
  assert.equal(busy.code, GATE_CODES.busy);
  assert.match(busy.reason, /1 秒前还在操作键鼠/);

  const locked = evaluateGate({ requireUnlocked: true, locked: true, now: noon });
  assert.equal(locked.code, GATE_CODES.locked);

  // 读不到空闲时长（null）时不拦：宁可放过，也不要因为探测失败让活永久派不出去。
  assert.equal(evaluateGate({ requireIdleSec: 60, idleSec: null, now: noon }).ok, true);
  // 没要求「必须未锁屏」时，锁屏也不拦（保持老配置行为）。
  assert.equal(evaluateGate({ locked: true, now: noon }).ok, true);
});

test('P6-2 · 时段判定：普通区间 / 跨午夜 / 全天 / 非法值一律放行', () => {
  const at = (h, m = 0) => new Date(2026, 10, 16, h, m, 0);
  assert.equal(inAllowedHours(at(9), [8, 18]), true);
  assert.equal(inAllowedHours(at(19), [8, 18]), false);
  // 跨午夜：23 点到次日 7 点
  assert.equal(inAllowedHours(at(23, 30), [23, 7]), true);
  assert.equal(inAllowedHours(at(2), [23, 7]), true);
  assert.equal(inAllowedHours(at(12), [23, 7]), false);
  assert.equal(inAllowedHours(at(12), [0, 24]), true);
  assert.equal(inAllowedHours(at(12), [5, 5]), true, 'from = to 视为全天');
  assert.equal(inAllowedHours(at(12), null), true, '不配就放行');
  assert.equal(inAllowedHours(at(12), ['x']), true, '非法配置按放行处理，不误锁死');
});

test('P6-2 · 暂停开关落盘：文件不存在 = 正常；内容坏掉 = 正常（不永久停摆）', (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, 'gui-pause.json');
  assert.equal(readPauseFlag(file).paused, false);
  writePauseFlag(file, { paused: true, reason: '测试' });
  const paused = readPauseFlag(file);
  assert.equal(paused.paused, true);
  assert.equal(paused.reason, '测试');
  writePauseFlag(file, { paused: false });
  assert.equal(readPauseFlag(file).paused, false);
  fs.writeFileSync(file, '{坏掉的 json', 'utf8');
  assert.equal(readPauseFlag(file).paused, false, '坏文件不能把 GUI 席位永久停掉');
});

// ---------------------------------------------------------------- 席位占位

test('P6-1 · 席位占位：活着不让双开；死了能被接管；别人不能越权释放', (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, 'gui-seat.json');
  const claim = createSeatClaim({ file, isAlive: (pid) => pid === 111 });

  assert.equal(claim.status().held, false);
  const first = claim.claim({ pid: 111, port: 3100, configPath: 'a.yaml' });
  assert.equal(first.ok, true);

  // 另一个活着的控制面来抢
  const second = createSeatClaim({ file, isAlive: (pid) => pid === 111 || pid === 222 });
  const blocked = second.claim({ pid: 222, port: 3101 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.conflict, true);
  assert.match(blocked.reason, /GUI 席位已被另一个控制面占用/);

  // 同一个 pid 重复占位（例如启动重试）应当允许
  assert.equal(claim.claim({ pid: 111, port: 3100 }).ok, true);

  // 越权释放被拒
  const other = createSeatClaim({ file, isAlive: () => true });
  assert.equal(other.release({ pid: 999 }).released, false);

  // 占位者进程没了 → 可接管
  const afterDeath = createSeatClaim({ file, isAlive: () => false });
  const takeover = afterDeath.claim({ pid: 333, port: 3102 });
  assert.equal(takeover.ok, true);
  assert.equal(afterDeath.status().state.port, 3102);
});

// ---------------------------------------------------------------- 产物查看

test('P6-3 · 产物列表：0 字节也列出来并标记；软链接与目录不会混进来', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-ABC');
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.writeFileSync(path.join(paths.outputDir, 'report.md'), '# 正文', 'utf8');
  fs.writeFileSync(path.join(paths.outputDir, 'empty.txt'), '', 'utf8');
  fs.mkdirSync(path.join(paths.outputDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(paths.outputDir, 'sub', 'deep.csv'), 'a,b\n1,2\n', 'utf8');

  const listed = listOutputs(root, 'T-ABC');
  assert.equal(listed.files.length, 3);
  const names = listed.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['empty.txt', 'report.md', 'sub/deep.csv']);
  assert.equal(listed.files.find((f) => f.name === 'empty.txt').empty, true);
  assert.equal(listed.files.find((f) => f.name === 'report.md').empty, false);
  assert.ok(listed.totalBytes > 0);

  // 没跑过的任务：不报错，明确返回「不存在」
  const none = listOutputs(root, 'T-NONE');
  assert.equal(none.exists, false);
  assert.deepEqual(none.files, []);
});

test('P6-3 · 产物读取：越界 / 绝对路径 / 任务号非法全部拒绝，不吞异常', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-ABC');
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.writeFileSync(path.join(paths.outputDir, 'ok.md'), '内容', 'utf8');
  fs.writeFileSync(path.join(paths.taskDir, 'completion.json'), '{}', 'utf8');

  assert.equal(readOutput(root, 'T-ABC', 'ok.md').text, '内容');
  assert.equal(readOutput(root, 'T-ABC', 'output/ok.md').text, '内容', '带 output/ 前缀也认');

  assert.throws(() => readOutput(root, 'T-ABC', '../completion.json'), OutputsError);
  assert.throws(() => readOutput(root, 'T-ABC', 'sub/../../completion.json'), OutputsError);
  assert.throws(() => readOutput(root, 'T-ABC', path.join(root, 'x.md')), OutputsError);
  assert.throws(() => readOutput(root, '../etc', 'x'), OutputsError, '任务号非法要拒');
  assert.throws(() => listOutputs(root, '../../'), OutputsError);
});

// ---------------------------------------------------------------- 档位

test('P6-1 · 实例档位：prod / demo 各自一套端口与目录；未知名报错', () => {
  const prod = resolveProfile('prod');
  const demo = resolveProfile('demo');
  assert.equal(prod.port, 3100);
  assert.notEqual(demo.port, prod.port, '两个实例不能抢同一个端口');
  assert.notEqual(demo.db, prod.db, '两个实例不能共用一个数据库');
  assert.notEqual(demo.runDir, prod.runDir, 'pid 文件必须分开，否则会互相判活');
  assert.ok(path.isAbsolute(prod.runDir) && path.isAbsolute(prod.config));
  assert.ok(fs.existsSync(prod.config), '档位指向的配置文件必须真实存在');
  assert.equal(prod.guiSeatFile, demo.guiSeatFile, '席位占位是跨实例共享的');
  assert.throws(() => resolveProfile('nope'), /没有名为「nope」的实例档位/);
});

// ---------------------------------------------------------------- 剪贴板

function adapterHarness(root, overrides = {}) {
  const config = {
    workRoot: root,
    windowTitle: WINDOW,
    driver: 'simulation',
    steps: [{ action: 'activate' }, { action: 'paste' }, { action: 'press', key: 'GO' }],
    maxPolls: 2,
    pollIntervalMs: 0,
    ...overrides,
  };
  return { config, adapter: createGuiAdapter({ lock: createGuiLock(), wait: noWait, maxPolls: 2, config }) };
}

function ctxOf(config, taskId, runId) {
  return {
    runId, taskId,
    task: {
      taskId, title: '静默任务', revision: 1, instructions: '写个文件',
      acceptance: ['产物非空'], mode: 'direct', reportsTo: 'ceo',
    },
    agent: { id: 'worker-01', isCEO: false, capabilities: ['execute'] },
    company: { agents: [] }, adapterConfig: config, wakeReason: 'issue_assigned',
  };
}

test('P6-2 · 剪贴板还原：发前存一份、发完还回去；原来没有内容就不动它', async (t) => {
  const root = tmpRoot(t);
  const taskId = 'T-CLIP';

  // 情形一：剪贴板里本来有 40 个字符
  const withClip = createSimulationDriver({
    clipChars: 40, clipText: '原来的内容'.repeat(4),
    onSend: async ({ paths, taskId: id, runId }) => {
      fs.writeFileSync(path.join(paths.outputDir, 'out.md'), 'done', 'utf8');
      fs.writeFileSync(paths.reportPath, `${JSON.stringify({
        schema: 'aicompany.completion/v1', taskId: id, runId, agent: 'worker-01', revision: 1,
        status: 'success', summary: 'ok', artifacts: ['output/out.md'],
        checksum: { 'output/out.md': sha256File(path.join(paths.outputDir, 'out.md')) },
        acceptanceResults: [{ rule: '产物非空', pass: true }], usage: { quotaUnits: 1 }, finishedAt: nowIso(),
      })}\n`, 'utf8');
    },
  });
  const { config } = adapterHarness(root);
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver: withClip, wait: noWait, maxPolls: 2, config });
  const out = await adapter.execute(ctxOf(config, taskId, 'R-CLIP'));
  assert.equal(out.status, 'success', JSON.stringify(out.sessionParams));
  assert.equal(out.sessionParams.clipboard, 'restored');
  assert.equal(withClip.clipboard, '原来的内容'.repeat(4), '必须还原成之前的内容，而不是留着提示词');

  // 情形二：剪贴板是空的（读不到文本）→ 不算还原，也不清空
  const emptyClip = createSimulationDriver({ clipChars: 0, onSend: async ({ paths, taskId: id, runId }) => {
    fs.writeFileSync(path.join(paths.outputDir, 'o.md'), 'x', 'utf8');
    const report = {
      schema: 'aicompany.completion/v1', taskId: id, runId, agent: 'worker-01', revision: 1,
      status: 'success', summary: 'ok', artifacts: ['output/o.md'],
      checksum: { 'output/o.md': sha256File(path.join(paths.outputDir, 'o.md')) },
      acceptanceResults: [{ rule: '产物非空', pass: true }], usage: { quotaUnits: 1 }, finishedAt: nowIso(),
    };
    fs.writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, 'utf8');
  } });
  const adapter2 = createGuiAdapter({ lock: createGuiLock(), driver: emptyClip, wait: noWait, maxPolls: 2, config });
  const out2 = await adapter2.execute(ctxOf(config, 'T-CLIP2', 'R-CLIP2'));
  assert.equal(out2.sessionParams.clipboard, 'nothing-to-restore');
  assert.notEqual(emptyClip.clipboard, '', '读不到原内容时不能把剪贴板清空');
});

test('P6-2 · 闸门在 adapter 里也生效：precheck 给出 code，execute 直接不动手', async (t) => {
  const root = tmpRoot(t);
  const pauseFile = path.join(root, 'pause.json');
  writePauseFlag(pauseFile, { paused: true, reason: '我要用电脑' });
  const { config } = adapterHarness(root, { gate: { pauseFile } });
  const driver = createSimulationDriver();
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, maxPolls: 2, config });

  const pre = await adapter.precheck(config);
  assert.equal(pre.ok, false);
  assert.equal(pre.code, GATE_CODES.paused);

  const out = await adapter.execute(ctxOf(config, 'T-GATE', 'R-GATE'));
  assert.equal(out.status, 'blocked');
  assert.match(String(out.sessionParams.blockedReason), /GUI 闸门拦下/);
  assert.equal(driver.trace.length, 0, '闸门拦下时一个动作都不该做');
});

// ---------------------------------------------------------------- 引擎集成

function companyWithGate(root, gate, simulation = {}) {
  return {
    version: 1,
    company: { name: 'test-company', timezone: 'Asia/Shanghai' },
    // 顶层 workRoot 必须与席位配置一致：产物接口是按 engine.workRoot 找目录的。
    workRoot: root,
    interaction: { defaultMode: 'direct', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
      {
        id: 'worker-01', displayName: 'GUI 席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo',
        adapter: {
          type: 'gui-template',
          config: {
            workRoot: root, windowTitle: WINDOW, driver: 'simulation', simulation,
            steps: [{ action: 'activate' }, { action: 'press', key: 'GO' }],
            maxPolls: 1, pollIntervalMs: 0, gate,
          },
        },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

test('P6-2 · 引擎：闸门拦下 → 卡退回 todo、不扣额度、不累加重试，审计写明原因', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, { requireIdleSec: 30 }, { idleSec: 2 });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-GATE', text: '现在别抢我键盘', mode: 'direct', addressedTo: 'worker-01' });

  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');
  assert.equal(engine.getRuns().length, 0, '一张卡都不该真派出去');
  const audit = engine.getAudit();
  assert.ok(audit.some((a) => a.action === 'gate_blocked'), '拦下必须留痕');
  assert.equal(audit.some((a) => a.action === 'report_rejected'), false, '不能当成执行失败');
  assert.equal(db.prepare('SELECT attempt FROM tasks WHERE taskId = ?').get(r.taskId).attempt, 0);
  assert.deepEqual(engine.pendingGateRetries(), [], '默认不排自检，只靠维护心跳（保持老行为）');
  db.close();
});

// 真机踩过：人在看板上点完提交（idle=0）→ 静置闸立刻拦下 → 卡退回 todo，
// 而重投只能等维护心跳（按服务启动时刻对齐、最长 60 秒，还要卡龄过阈值 → 实际干等 100 秒）。
// 用户看到的就是「点了提交，什么都没发生，豆包也没打开」。这条盯的就是把空窗压回秒级。
test('P6-9 · 被静置闸拦下的卡：几秒后自己再试，不等维护心跳', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const simulation = { idleSec: 1 }; // 先装成「你一秒前还在敲键盘」
  const config = companyWithGate(root, { requireIdleSec: 30 }, simulation);
  const engine = createEngine({ db, config, notifier: createNotifier('web'), gateRetryMs: 25 });
  t.after(() => engine.close());

  const r = await engine.submit({
    requestId: 'REQ-GATE-RETRY', text: '等会儿再跑', mode: 'direct', addressedTo: 'worker-01',
  });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');
  assert.deepEqual(engine.pendingGateRetries(), [r.taskId], '拦下之后必须排着一次自检');

  simulation.idleSec = 999; // 手离开了，闸门该放行
  const started = await waitUntil(() => engine.getRuns().some((x) => x.taskId === r.taskId));
  assert.ok(started, '短延迟自检必须把卡重投出去（真机上这里曾干等 100 秒）');
  assert.equal(engine.pendingGateRetries().length, 0, '派出去之后自检要作废，不能过几分钟再投一次');
});

test('P6-9b · 取消会把挂着的那次自检一起作废', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, { requireIdleSec: 30 }, { idleSec: 1 });
  const engine = createEngine({ db, config, notifier: createNotifier('web'), gateRetryMs: 40 });
  t.after(() => engine.close());

  const r = await engine.submit({
    requestId: 'REQ-GATE-CANCEL', text: '发了又不想要了', mode: 'direct', addressedTo: 'worker-01',
  });
  assert.equal(engine.pendingGateRetries().includes(r.taskId), true);
  engine.cancelTask(r.taskId, { reason: '测试取消' });
  assert.deepEqual(engine.pendingGateRetries(), [], '卡作废了就不该再排重投');
  // 等过一个完整间隔，确认它真的没被偷偷投出去。
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  assert.equal(engine.getRuns().length, 0, '已取消的卡不能自己开工');
});

test('P6-5 · 维护心跳：躺着的 todo 卡会被重新投递；有待处理事件的不重复投', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, {}, { idleSec: 999 });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-RECON', text: '重新投递我', mode: 'direct', addressedTo: 'worker-01' });

  // 手工把卡打回 todo 并做旧（模拟「闸门拦下之后没人叫它」）
  db.prepare("UPDATE tasks SET status = 'todo', updatedAt = ? WHERE taskId = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), r.taskId);
  const first = await engine.reconcile({ olderThanMs: 60_000 });
  assert.ok(first.requeued >= 1);
  // 关键不是它最后成没成，而是「躺着的卡确实被重新投出去了」：
  // 模拟席位交不出产物会被判失败，但一定不能再停在 todo 无人过问。
  assert.notEqual(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');
  assert.ok(engine.getRuns().length >= 1, '重新投递必须真的叫醒席位');

  // 再来一次：卡已经是终态，不该再有动作
  const second = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(second.requeued, 0);
  db.close();
});

// ---------------------------------------------------------------- HTTP

async function withServer(t, config, run) {
  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const server = createServer({ engine, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { server.close(); db.close(); });
  return run({ engine, port, base: `http://127.0.0.1:${port}` });
}

test('P6-4 · HTTP：产物列表 / 单个产物 / GUI 状态 / 暂停开关 / 公司元信息', async (t) => {
  const root = tmpRoot(t);
  const pauseFile = path.join(root, 'pause.json');
  const config = companyWithGate(root, { pauseFile });
  const paths = buildTaskPaths(root, 'T-HTTP');
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.writeFileSync(path.join(paths.outputDir, 'hello.md'), '# 你好', 'utf8');

  await withServer(t, config, async ({ base }) => {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.defaultMode, 'direct');
    assert.ok(meta.seats.some((s) => s.agentId === 'worker-01' && s.gui === true));

    const listed = await (await fetch(`${base}/api/tasks/T-HTTP/outputs`)).json();
    assert.equal(listed.files.length, 1);

    const one = await (await fetch(`${base}/api/tasks/T-HTTP/output?file=hello.md`)).json();
    assert.equal(one.text, '# 你好');

    const traversal = await fetch(`${base}/api/tasks/T-HTTP/output?file=../completion.json`);
    assert.equal(traversal.status, 400, '越界读取必须 400');

    const state1 = await (await fetch(`${base}/api/gui/state`)).json();
    assert.equal(state1.paused, false);
    assert.equal(state1.seats.length, 1);

    const paused = await (await fetch(`${base}/api/gui/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true, reason: '我要用电脑' }),
    })).json();
    assert.equal(paused.paused, true);
    assert.equal(readPauseFlag(pauseFile).reason, '我要用电脑');

    const state2 = await (await fetch(`${base}/api/gui/state`)).json();
    assert.equal(state2.paused, true);

    // 暂停后提交：卡应当停在 todo，且审计里有 gate_blocked
    const submitted = await (await fetch(`${base}/api/requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '暂停期间的活', mode: 'direct', addressedTo: 'worker-01' }),
    })).json();
    const task = await (await fetch(`${base}/api/tasks/${submitted.taskId}`)).json();
    assert.equal(task.status, 'todo');

    // 恢复
    const resumed = await (await fetch(`${base}/api/gui/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: false }),
    })).json();
    assert.equal(resumed.paused, false);
  });
});

test('P6-4 · HTTP：没有 GUI 席位的实例，暂停接口明确拒绝而不是假装成功', async (t) => {
  const root = tmpRoot(t);
  const config = {
    version: 1,
    company: { name: 'no-gui' },
    interaction: { defaultMode: 'direct', defaultTarget: 'ceo' },
    agents: [
      {
        id: 'ceo', isCEO: true, capabilities: ['plan'], status: 'active', quotaDaily: 5, reportsTo: null,
        adapter: { type: 'mock', config: {} },
      },
      {
        id: 'worker-01', isCEO: false, capabilities: ['execute'], status: 'active', quotaDaily: 5, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
  await withServer(t, config, async ({ base }) => {
    const res = await fetch(`${base}/api/gui/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /没有 GUI 席位/);
    const state = await (await fetch(`${base}/api/gui/state`)).json();
    assert.deepEqual(state.seats, []);
  });
});

test('P6-5 · 维护心跳：正在跑的卡不算「躺着」，不会被重复投递', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, {}, { idleSec: 999 });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-RUNNING', text: '正在跑', mode: 'direct', addressedTo: 'worker-01' });

  // 造出「卡在做、Run 在跑、updatedAt 很旧」的现场（GUI 任务跑几分钟正是这样）
  db.prepare("UPDATE tasks SET status = 'in_progress', updatedAt = ? WHERE taskId = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), r.taskId);
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES (?, ?, 'worker-01', 'issue_assigned', 'running', 1, 1, ?, NULL)`)
    .run('R-STILL-RUNNING', r.taskId, new Date().toISOString());

  const out = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(out.requeued, 0, '有 Run 在跑就不能再投一次');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'in_progress');
  db.close();
});

test('P6-5 · 收账不撞车：同一张卡已有 Run 在跑时，第二次唤醒让路而不是把卡打回 todo', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, {}, { idleSec: 999 });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-DOUBLE', text: '重复唤醒', mode: 'direct', addressedTo: 'worker-01' });

  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE taskId = ?").run(r.taskId);
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-ACTIVE', ?, 'worker-01', 'issue_assigned', 'running', 1, 1, ?, NULL)`)
    .run(r.taskId, new Date().toISOString());

  const second = await engine.wake(r.taskId, 'worker-01', 'issue_assigned');
  assert.equal(second.skipped, true);
  assert.equal(second.code, 'concurrent');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'in_progress',
    '正在跑的卡不能被退回 todo，否则收账时会撞「非法跳转」');
  assert.equal(engine.getRuns().filter((x) => x.runId === 'R-ACTIVE').length, 1);
  db.close();
});

test('P6-5 · 异步提交：HTTP 立刻返回，泵在后台把活干完', async (t) => {
  const root = tmpRoot(t);
  const config = companyWithGate(root, {}, { idleSec: 999 });
  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const server = createServer({ engine, port: 0, deferRequests: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });

  const started = Date.now();
  const res = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '后台跑', mode: 'direct', addressedTo: 'worker-01' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.deferred, true);
  assert.ok(Date.now() - started < 2000, '提交不该陪着 GUI 任务干等');

  // 模拟席位交不出报告会失败，但关键是「后台确实推进过」——不是停在 todo。
  let status = 'todo';
  for (let i = 0; i < 40 && status === 'todo'; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const task = await (await fetch(`${base}/api/tasks/${body.taskId}`)).json();
    status = task.status;
  }
  assert.notEqual(status, 'todo', '后台泵必须真的把它推进过');
});

test('P6-5 · 人工取消：非终态能停手，终态不重复取消', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, {}, { idleSec: 999 });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-CANCEL', text: '停下', mode: 'direct', addressedTo: 'worker-01' });

  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE taskId = ?").run(r.taskId);
  const out = engine.cancelTask(r.taskId, { reason: '方向错了' });
  assert.equal(out.cancelled, true);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'cancelled');

  const again = engine.cancelTask(r.taskId);
  assert.equal(again.cancelled, false);
  assert.match(again.reason, /终态/);
  assert.ok(engine.getAudit().some((a) => a.action === 'cancel_task'));
  assert.throws(() => engine.cancelTask('T-NOT-EXIST'), /任务不存在/);
  db.close();
});

test('P6-5 · 原始需求就是任务说明：text 会自动落到 instructions，不再是一句空话', (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = companyWithGate(root, {}, { idleSec: 999 });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const routed = engine.route({ requestId: 'REQ-TEXT', text: '把周报压成 200 字', mode: 'direct', addressedTo: 'worker-01' });
  const payload = db.prepare('SELECT instructions, acceptanceJson FROM task_payload WHERE taskId = ?').get(routed.taskId);
  assert.equal(payload.instructions, '把周报压成 200 字');
  db.close();
});

// ---------------------------------------------------------------- 抢不到前台

test('P6-2 · 抢不到前台算「稍后再试」：adapter 报 deferred，引擎退回排队且不算失败', async (t) => {
  const root = tmpRoot(t);
  const { config } = adapterHarness(root);
  const stolen = createSimulationDriver({ stolenTitle: '别人的窗口' });
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver: stolen, wait: noWait, maxPolls: 2, config });
  const out = await adapter.execute(ctxOf(config, 'T-STEAL', 'R-STEAL'));
  assert.equal(out.status, 'deferred', JSON.stringify(out.sessionParams));
  assert.equal(out.sessionParams.retryable, true);
  assert.match(String(out.sessionParams.deferredReason), /前台窗口/);

  // 引擎侧：卡回 todo、attempt 不动、审计写 wake_deferred，绝不出审批卡
  const db = openDb(':memory:');
  const company = companyWithGate(root, {}, { idleSec: 999, stolenTitle: '别人的窗口' });
  const engine = createEngine({ db, config: company, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-STEAL', text: '抢不到前台', mode: 'direct', addressedTo: 'worker-01' });
  const task = db.prepare('SELECT status, attempt FROM tasks WHERE taskId = ?').get(r.taskId);
  assert.equal(task.status, 'todo');
  assert.equal(task.attempt, 0, '临时条件不该累加重试次数');
  const actions = engine.getAudit().map((a) => a.action);
  assert.ok(actions.includes('wake_deferred'));
  assert.equal(actions.includes('report_rejected'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0, '不该生成审批卡');
  db.close();
});

test('P6-6 · 驱动工厂：不配 driver 时走模拟（测试与演示绝不抢真实键盘）', () => {
  const driver = createGuiDriver({ windowTitle: WINDOW });
  assert.equal(driver.kind, 'simulation');
  const command = createGuiDriver({ driver: 'command', commands: { activate: 'x', foregroundTitle: 'y' } });
  assert.equal(command.kind, 'command');
});

// 取消一张卡时，挂在它身上的待办审批必须一起关掉。
// 真机踩过：卡作废了，看板上那张「待你拍板」还挂着，点进去是一张不存在的活，而且关不掉。
test('P6-8 · 人工取消 → 待办审批自动关闭并留痕（不留幽灵待办）', async (t) => {
  const root = tmpRoot(t);
  const pauseFile = path.join(root, 'pause.json');
  writePauseFlag(pauseFile, { paused: true, reason: '测试：先别派活' });
  const db = openDb(':memory:');
  const config = companyWithGate(root, { pauseFile });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });

  const r = await engine.submit({ requestId: 'REQ-CANCEL', text: '等一下再说的活', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');

  // 人为挂一张待办审批在它身上（相当于之前跑失败留下的 review_reject）
  db.prepare(`INSERT INTO approvals (approvalId, kind, taskId, status, requestJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)`).run('AP-TEST', 'review_reject', r.taskId, 'pending', '{}', new Date().toISOString());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get().n, 1);

  const out = engine.cancelTask(r.taskId, { reason: '测试取消' });
  assert.equal(out.cancelled, true);
  assert.equal(out.closedApprovals, 1, '取消要顺手关掉 1 张待办审批');

  const ap = db.prepare('SELECT status, reason FROM approvals WHERE approvalId = ?').get('AP-TEST');
  assert.equal(ap.status, 'cancelled');
  assert.match(ap.reason, /任务已取消/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get().n, 0, '看板不该再有待办');
  assert.ok(engine.getAudit().some((a) => a.action === 'approvals_auto_closed'), '关闭动作要留痕');

  // 再取消一次：终态不动，也不报错、不重复关
  const again = engine.cancelTask(r.taskId);
  assert.equal(again.cancelled, false);
  db.close();
});


// 常驻 runner 的「该不该重试」判定。真机上踩过：席位被占时服务 exit 5，
// 而 runner 把它当崩溃连着重启 20 次，日志瞬间刷满 —— 重试没有意义，只会埋掉真原因。
test('P6-7 · runner 遇到「再起也一样」的退出码不再重试', () => {
  assert.equal(isFatalExit(5), true, '席位被占（exit 5）不该进入退避循环');
  for (const code of [0, 1, 2, 3, 137, null, undefined]) {
    assert.equal(isFatalExit(code), false, `code=${code} 仍按崩溃重试`);
  }
  // 退避本身不受影响
  assert.equal(nextDelay({ restarts: 1 }).delayMs, 1000);
  assert.equal(nextDelay({ restarts: 3 }).delayMs, 4000);
  assert.equal(nextDelay({ restarts: 20 }).restart, false);
});
