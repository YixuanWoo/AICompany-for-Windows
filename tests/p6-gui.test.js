// P6 真实 GUI 修正：三处只有在接真窗口时才会暴露的阻塞点。
// ① 桌面客户端标题前面挂会话名 → 必须支持「包含」匹配，否则同一个窗口被判成被抢焦点；
// ② 第一步就是 activate 时不能做「启动前」焦点校验，否则永远发不出去；
// ③ 没配 commands.send 时发送回调不能抛错（Enter 已经按下去了，抛错会把已发送记成失败）。
// 仍然全部用可注入的模拟驱动，不激活任何真实窗口、不抢焦点、不按键。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


import { createGuiLock } from '../src/gui-lock.js';
import { sha256File } from '../src/gui-report.js';
import {
  createGuiDriver, createSimulationDriver, createCommandDriver,
  assertForeground, GuiError,
} from '../src/gui-driver.js';
import { createGuiAdapter } from '../src/gui-adapter.js';
import { nowIso } from '../src/ids.js';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { registerAdapter } from '../src/adapters.js';
import { validate } from '../src/validate.js';

const WINDOW = 'TEST-WINDOW';
const noWait = async () => {};

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function guiConfig(root, overrides = {}) {
  return {
    workRoot: root,
    windowTitle: WINDOW,
    steps: [
      { action: 'activate' },
      { action: 'hotkey', keys: ['K1', 'K2'] },
      { action: 'paste' },
      { action: 'press', key: 'SUBMIT' },
    ],
    driver: 'simulation',
    simulation: {},
    reportPath: 'completion.json',
    maxPolls: 2,
    pollIntervalMs: 0,
    retry: { max: 2, backoffSec: 0 },
    ...overrides,
  };
}

function makeCtx(config, taskId, runId) {
  return {
    runId, taskId,
    task: {
      taskId, title: '模板化任务', revision: 1, instructions: '按 brief 执行并写出报告',
      acceptance: ['产物存在且非空'], mode: 'direct', reportsTo: 'ceo',
    },
    agent: { id: 'worker-01', isCEO: false, capabilities: ['execute'] },
    company: { agents: [] },
    adapterConfig: config,
    wakeReason: 'issue_assigned',
  };
}

function writeSuccessBundle(paths, taskId, runId) {
  const artifact = 'output/result.md';
  const file = path.join(paths.taskDir, artifact);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'P6 产物', 'utf8');
  const report = {
    schema: 'aicompany.completion/v1', taskId, runId, agent: 'worker-01', revision: 1,
    status: 'success', summary: '模板任务完成', artifacts: [artifact],
    checksum: { [artifact]: sha256File(file) },
    acceptanceResults: [{ rule: '产物存在且非空', pass: true }],
    usage: { quotaUnits: 1 }, finishedAt: nowIso(),
  };
  fs.writeFileSync(paths.reportPath, `${JSON.stringify(report)}\n`, 'utf8');
  return report;
}

test('P6 · 标题按包含匹配：真实窗口标题带会话名，exact 会误判成被抢焦点', async (t) => {
  const root = tmpRoot(t);
  const fullTitle = `${WINDOW}：某个会话名`;

  // 直接对断言函数验口径：同一个窗口，exact 拒、contains 过。
  const sim = createSimulationDriver({ initialTitle: fullTitle });
  await assert.rejects(
    () => assertForeground(sim, WINDOW, '前'),
    (e) => e instanceof GuiError && e.kind === 'focus',
  );
  assert.equal((await assertForeground(sim, WINDOW, '前', { match: 'contains' })).ok, true);
  // 别的窗口即使 contains 也要拒。
  await assert.rejects(
    () => assertForeground(sim, '别的标题', '前', { match: 'contains' }),
    (e) => e instanceof GuiError && e.kind === 'focus',
  );

  // 走完整 execute：标题一直挂着会话名（activate 后也不变），配 contains 必须能跑完。
  const config = guiConfig(root, { windowTitleMatch: 'contains' });
  const sticky = {
    kind: 'sticky', trace: [], clipboard: '',
    async activateWindow() {},
    async foregroundTitle() { return fullTitle; },
    async hotkey() {}, async paste() {}, async press() {},
    async setClipboard(text) { this.clipboard = text; },
    async send(payload) { writeSuccessBundle(payload.paths, payload.taskId, payload.runId); },
    async screenshot() { return Buffer.from('x'); },
  };
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver: sticky, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-CONT', 'R-CONT'));
  assert.equal(out.status, 'success', out.result?.reason ?? '');

  // 同一套驱动配 exact 必须被挡住，证明开关真的起作用。
  const exactConfig = guiConfig(root, {});
  const exactAdapter = createGuiAdapter({
    lock: createGuiLock(), driver: { ...sticky, trace: [] }, wait: noWait, config: exactConfig,
  });
  const blocked = await exactAdapter.execute(makeCtx(exactConfig, 'T-EXACT', 'R-EXACT'));
  // P6 起：抢不到前台是临时条件 → deferred（退回排队），不是 blocked（执行失败）。
  assert.equal(blocked.status, 'deferred');
  assert.match(String(blocked.sessionParams.deferredReason), /前台窗口/);
});

test('P6 · 第一步是 activate 时不做「启动前」焦点校验，否则永远发不出去', async (t) => {
  const root = tmpRoot(t);
  // initialTitle 是「别人的窗口」：窗口还没到前台。第一步就是 activate，应当放行。
  const config = guiConfig(root, {
    simulation: {
      initialTitle: '别人的窗口',
      onSend: ({ taskId, runId, paths }) => writeSuccessBundle(paths, taskId, runId),
    },
  });
  const adapter = createGuiAdapter({
    lock: createGuiLock(), driver: createGuiDriver(config), wait: noWait, config,
  });
  const out = await adapter.execute(makeCtx(config, 'T-ACT', 'R-ACT'));
  assert.equal(out.status, 'success', out.result?.reason ?? '');

  // 反过来：第一步不是 activate，窗口又不在前台 → 立刻 blocked，绝不盲按。
  const config2 = guiConfig(root, {
    steps: [{ action: 'hotkey', keys: ['K1'] }, { action: 'press', key: 'SUBMIT' }],
    simulation: { initialTitle: '别人的窗口' },
  });
  const adapter2 = createGuiAdapter({
    lock: createGuiLock(), driver: createGuiDriver(config2), wait: noWait, config: config2,
  });
  const out2 = await adapter2.execute(makeCtx(config2, 'T-ACT2', 'R-ACT2'));
  // 「启动前就不在前台」同样属于临时条件：中止并退回排队。
  assert.equal(out2.status, 'deferred');
  assert.match(String(out2.sessionParams.deferredReason), /前台窗口/);
});

test('P6 · 未配置 commands.send 时发送回调不报错（Enter 已经按下去了）', async (t) => {
  const root = tmpRoot(t);
  const driver = createCommandDriver({ commands: {} });
  await driver.send({ taskId: 'T-1' });
  assert.deepEqual(driver.trace.at(-1), { action: 'send', skipped: 'no-command' });

  // 配了就要真的执行，不能悄悄跳过：用一个临时脚本把 taskId 写进文件当证据。
  const script = path.join(root, 'echo-arg.js');
  const marker = path.join(root, 'sent.txt');
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    'fs.writeFileSync(process.argv[2], `sent:${process.argv[3]}`);',
  ].join('\n'), 'utf8');
  const withSend = createCommandDriver({
    commands: { send: `node "${script}" "${marker}" {{taskId}}` },
  });
  await withSend.send({ taskId: 'T-9' });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'sent:T-9');
});

test('P6 · 文档级 workRoot 要传进派活前的环境检查（否则真实配置永远过不了）', async (t) => {
  const root = tmpRoot(t);
  const seen = [];
  registerAdapter('p6-strict-probe', {
    type: 'p6-strict-probe',
    strictEnvironment: true,
    testEnvironment(config) { seen.push(config.workRoot); return { ok: true, detail: 'ok', checks: [] }; },
    execute: async (ctx) => ({
      status: 'success',
      result: {
        schema: 'aicompany.completion/v1', taskId: ctx.taskId, runId: ctx.runId,
        agent: 'worker-01', revision: 1, status: 'success', summary: 'ok',
        artifacts: ['output/result.md'], checksum: { 'output/result.md': 'sha256:mock' },
        acceptanceResults: [{ rule: '产物存在', pass: true }],
        usage: { quotaUnits: 1 }, finishedAt: nowIso(),
      },
      usage: { quotaUnits: 1 },
    }),
  });

  const config = {
    version: 1,
    company: { name: 'test-company', timezone: 'Asia/Shanghai' },
    // 关键：workRoot 只在文档级给出，adapter.config 里没有。
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 20,
        reportsTo: null,
        adapter: { type: 'mock', config: { result: (ctx) => ({ type: 'task-create', title: '子任务', assignee: 'worker-01' }) } },
      },
      {
        id: 'worker-01', displayName: '执行席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo',
        adapter: { type: 'p6-strict-probe', config: { windowTitle: 'X' } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };

  const db = openDb(path.join(root, 'p6.db'));
  try {
    const engine = createEngine({ db, config, notifier: createNotifier('noop') });
    const result = await engine.submit({ requestId: 'REQ-P6-WR', text: '检查 workRoot 传递', mode: 'delegate' });
    assert.equal(seen.length >= 1, true, '环境检查必须被调用');
    assert.equal(seen.every((wr) => wr === root), true, `workRoot 应统一为 ${root}，实际 ${JSON.stringify(seen)}`);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(result.taskId).status, 'done');
  } finally {
    db.close();
  }
});

test('P6 · 阻塞结果必须是合法 completion 文档（sessionParams 不能混进 result）', async (t) => {
  const root = tmpRoot(t);
  // 窗口根本不在前台：必然中止，且结果要能过 completion schema，
  // 否则控制面只会报「多余字段」，把真正的失败原因（失焦）吃掉。
  const config = guiConfig(root, {
    steps: [{ action: 'hotkey', keys: ['K1'] }, { action: 'press', key: 'SUBMIT' }],
    simulation: { initialTitle: '别人的窗口' },
  });
  const adapter = createGuiAdapter({
    lock: createGuiLock(), driver: createGuiDriver(config), wait: noWait, config,
  });
  const out = await adapter.execute(makeCtx(config, 'T-SCHEMA', 'R-SCHEMA'));
  // P6 起：这是「临时条件」，所以状态是 deferred；但结果仍然必须是合法 completion 文档。
  assert.equal(out.status, 'deferred');
  assert.equal(out.result.sessionParams, undefined, 'result 里不许出现 sessionParams');
  assert.ok(out.sessionParams.screenshot, '截图证据仍要留在 sessionParams 里');
  const checked = validate('completion', out.result);
  assert.equal(checked.ok, true, `deferred 结果应通过 completion schema：${checked.errors.join('; ')}`);
  assert.match(out.result.reason, /前台窗口/);
});

test('P6 · 草稿模式：draft 一到就收账，不空等到 maxMinutes', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, { reportMode: 'draft', maxMinutes: 20, pollIntervalMs: 0, maxPolls: 200 });
  const driver = {
    kind: 'drafty', trace: [], clipboard: '',
    async activateWindow() {}, async foregroundTitle() { return WINDOW; },
    async hotkey() {}, async paste() {}, async press() {}, async screenshot() { return Buffer.from('x'); },
    async setClipboard(text) { this.clipboard = text; },
    async send({ paths }) {
      fs.writeFileSync(path.join(paths.outputDir, 'hello.md'), '# 真实接入测试\n', 'utf8');
      fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'),
        JSON.stringify({ status: 'success', summary: '写了 hello.md' }), 'utf8');
    },
  };
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-DRAFT', 'R-DRAFT'));
  assert.equal(out.status, 'success', out.result?.reason ?? '');
  assert.equal(out.sessionParams.polls, 1, 'draft 一出现就该收账，不该继续轮询');
  assert.equal(out.sessionParams.reportSource, 'control-plane-draft');
  assert.deepEqual(out.result.artifacts, ['output/hello.md']);

  // 反向：draft 说成功但 output/ 里没有非空文件 → 不能放行，继续等到超时也不算成功。
  const config2 = guiConfig(root, { reportMode: 'draft', maxMinutes: 1, pollIntervalMs: 0, maxPolls: 2 });
  const emptyDriver = {
    ...driver,
    async send({ paths }) {
      fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'),
        JSON.stringify({ status: 'success', summary: '嘴上说写了' }), 'utf8');
    },
  };
  const adapter2 = createGuiAdapter({ lock: createGuiLock(), driver: emptyDriver, wait: noWait, config: config2 });
  const out2 = await adapter2.execute(makeCtx(config2, 'T-DRAFT2', 'R-DRAFT2'));
  assert.notEqual(out2.status, 'success');
});

// ---- P6 · 会话隔离：新会话要真的开出来，开不出来不许装没事 ----
// 真机背景：豆包空白新会话时标题就是产品名本身，进了会话才变「会话名 - 产品名」。
// 靠这个差异做防错（不是判完成——完成仍只认磁盘文件）。

function sessionDriver({ freshAfter = 1, sendBundle = true } = {}) {
  let calls = 0;
  const trace = [];
  const ctx = {
    kind: 'session', trace, clipboard: '',
    title: '旧会话名 - TEST-WINDOW',
    pastedInto: [],
    async activateWindow() { this.title = '旧会话名 - TEST-WINDOW'; trace.push({ action: 'activate' }); },
    async newSession() {
      calls += 1;
      trace.push({ action: 'newSession', call: calls });
      if (calls >= freshAfter) this.title = 'TEST-WINDOW';
    },
    async foregroundTitle() { return this.title; },
    async hotkey() {}, async press() {},
    async setClipboard(text) { this.clipboard = text; },
    async paste() { this.pastedInto.push(this.title); trace.push({ action: 'paste', title: this.title }); },
    async screenshot() { return Buffer.from('x'); },
    async send({ paths, taskId, runId }) {
      if (!sendBundle) return;
      fs.writeFileSync(path.join(paths.outputDir, 'out.md'), 'ok', 'utf8');
      fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'),
        JSON.stringify({ status: 'success', summary: 'done' }), 'utf8');
    },
  };
  return ctx;
}

const sessionSteps = [
  { action: 'activate' }, { action: 'newSession' }, { action: 'paste' }, { action: 'press', key: 'ENTER' },
];

test('P6 · 新会话开出来了：提示词落在空白会话里，标记 fresh', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, {
    steps: sessionSteps, windowTitleMatch: "contains", reportMode: 'draft', maxMinutes: 1, pollIntervalMs: 0,
    freshTitle: WINDOW, newSessionPollMs: 0, newSessionPolls: 2,
  });
  const driver = sessionDriver({ freshAfter: 1 });
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-SESS1', 'R-SESS1'));
  assert.equal(out.status, 'success', out.result?.reason ?? '');
  assert.equal(out.sessionParams.session, 'fresh');
  assert.equal(out.sessionParams.sessionAttempts, 1);
  // 关键：粘贴发生的那一刻，标题必须是纯产品名（= 空白会话）。
  assert.deepEqual(driver.pastedInto, [WINDOW]);
});

test('P6 · 第一次没开成、第二次开成：重试有效，且仍标 fresh', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, {
    steps: sessionSteps, windowTitleMatch: "contains", reportMode: 'draft', maxMinutes: 1, pollIntervalMs: 0,
    freshTitle: WINDOW, newSessionPollMs: 0, newSessionPolls: 1, newSessionAttempts: 2,
  });
  const driver = sessionDriver({ freshAfter: 2 });
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-SESS2', 'R-SESS2'));
  assert.equal(out.status, 'success');
  assert.equal(out.sessionParams.session, 'fresh');
  assert.equal(out.sessionParams.sessionAttempts, 2);
  assert.deepEqual(driver.pastedInto, [WINDOW]);
});

test('P6 · 一直开不出来：默认照发但标 reused，绝不假装是新会话', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, {
    steps: sessionSteps, windowTitleMatch: "contains", reportMode: 'draft', maxMinutes: 1, pollIntervalMs: 0,
    freshTitle: WINDOW, newSessionPollMs: 0, newSessionPolls: 1,
  });
  const driver = sessionDriver({ freshAfter: 999 });
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-SESS3', 'R-SESS3'));
  assert.equal(out.status, 'success');
  assert.equal(out.sessionParams.session, 'reused');
  assert.match(out.sessionParams.sessionTitle, /旧会话名/);
});

test('P6 · 配了 blocked 时：开不出新会话就 blocked，且一个字都不许贴进旧会话', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, {
    steps: sessionSteps, windowTitleMatch: "contains", reportMode: 'draft', maxMinutes: 1, pollIntervalMs: 0,
    freshTitle: WINDOW, newSessionPollMs: 0, newSessionPolls: 1,
    onNewSessionMismatch: 'blocked',
  });
  const driver = sessionDriver({ freshAfter: 999 });
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-SESS4', 'R-SESS4'));
  assert.equal(out.status, 'blocked');
  assert.match(out.result.reason, /新会话/);
  assert.deepEqual(driver.pastedInto, [], '有串会话风险时绝不能把提示词贴出去');
  const checked = validate('completion', out.result);
  assert.equal(checked.ok, true, checked.errors.join('; '));
});

test('P6 · 配置没写 freshTitle 时，用 windowTitle 当判据（不多要一个配置项）', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, {
    steps: sessionSteps, windowTitleMatch: "contains", reportMode: 'draft', maxMinutes: 1, pollIntervalMs: 0,
    newSessionPollMs: 0, newSessionPolls: 1,
  });
  delete config.freshTitle;
  const driver = sessionDriver({ freshAfter: 1 });
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-SESS5', 'R-SESS5'));
  assert.equal(out.status, 'success');
  assert.equal(out.sessionParams.session, 'fresh');
});

test('P6 · 运行参数要进审计：否则「这次在不在新会话里跑的」事后查不到', async (t) => {
  const root = tmpRoot(t);
  registerAdapter('p6-params-probe', {
    type: 'p6-params-probe',
    execute: async (ctx) => ({
      status: 'success',
      result: {
        schema: 'aicompany.completion/v1', taskId: ctx.taskId, runId: ctx.runId,
        agent: 'worker-01', revision: 1, status: 'success', summary: 'ok',
        artifacts: ['output/x.md'], checksum: { 'output/x.md': 'sha256:mock' },
        acceptanceResults: [{ rule: '产物存在', pass: true }],
        usage: { quotaUnits: 1 }, finishedAt: nowIso(),
      },
      usage: { quotaUnits: 1 },
      sessionParams: { session: 'fresh', sessionAttempts: 1, polls: 3 },
    }),
  });
  const config = {
    version: 1,
    company: { name: 'test-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: (ctx) => ({ type: 'task-create', title: '子任务', assignee: 'w1' }) } },
      },
      {
        id: 'w1', displayName: '执行席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo',
        adapter: { type: 'p6-params-probe', config: {} },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
  const db = openDb(path.join(root, 'p6p.db'));
  try {
    const engine = createEngine({ db, config, notifier: createNotifier('noop') });
    const submitted = await engine.submit({ requestId: 'REQ-P6-P', text: '留痕验证', mode: 'delegate' });
    assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(submitted.taskId).status, 'done');
    const row = db.prepare("SELECT * FROM audit WHERE action = 'run_params'").get();
    assert.ok(row, 'adapter 的运行参数必须落一条审计');
    assert.match(row.newValue, /"session":"fresh"/);
  } finally {
    db.close();
  }
});

test('P6 · 证据层：GUI 真发出去之后必须落 dispatch 回执与 ack 模板', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, { reportMode: 'draft', maxMinutes: 20, pollIntervalMs: 0, maxPolls: 200 });
  const driver = {
    kind: 'receipt-probe', clipboard: '',
    async activateWindow() {}, async foregroundTitle() { return WINDOW; },
    async hotkey() {}, async paste() {}, async press() {}, async screenshot() { return Buffer.from('x'); },
    async setClipboard(text) { this.clipboard = text; },
    async send({ paths }) {
      fs.writeFileSync(path.join(paths.outputDir, 'hello.md'), '# 产物\n', 'utf8');
      fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'),
        JSON.stringify({ status: 'success', summary: '写了 hello.md' }), 'utf8');
    },
  };
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  const out = await adapter.execute(makeCtx(config, 'T-RECEIPT', 'R-RECEIPT'));
  assert.equal(out.status, 'success', out.result?.reason ?? '');

  const dir = path.join(root, 'tasks', 'T-RECEIPT');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'dispatch.json'), 'utf8'));
  assert.equal(receipt.runId, 'R-RECEIPT', '送达回执必须归属本趟 run，不能拿上一轮的顶账');
  assert.equal(receipt.via, 'gui');
  const ack = fs.readFileSync(path.join(dir, 'ack.md'), 'utf8');
  assert.match(ack, /收到｜预计/, '派单时必须预置一行回执模板，agent 只需改一行');
});
