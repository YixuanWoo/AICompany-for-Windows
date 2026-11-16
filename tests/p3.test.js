// P3 自主验收：逐条对齐 docs/开发清单.md 的 P3-1 ~ P3-5 与 G-P3。
// 全部用可注入的模拟 GUI 驱动：不激活任何真实窗口、不抢焦点、不按键、不联网、不烧额度。
// 报告一律落到临时目录里由「模拟 agent」写文件，控制面只轮询文件（§6.6 第一原则）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { getAdapter, availableAdapterTypes, registerAdapter } from '../src/adapters.js';
import { createGuiLock } from '../src/gui-lock.js';
import {
  renderPrompt, normalizeSteps, assertPromptComplete,
  REQUIRED_PROMPT_SLOTS, DEFAULT_PROMPT_TEMPLATE, SUPPORTED_STEP_ACTIONS,
} from '../src/gui-prompt.js';
import {
  buildTaskPaths, writeTaskBundle, writeChangeRequest, sha256File,
  verifyReport, pollForReport, isInsideOutput,
} from '../src/gui-report.js';
import {
  createGuiDriver, createSimulationDriver, createCommandDriver,
  assertForeground, captureScreenshot, GuiError,
} from '../src/gui-driver.js';
import { createGuiAdapter, guiTemplateAdapter } from '../src/gui-adapter.js';
import { nowIso } from '../src/ids.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW = 'TEST-WINDOW'; // 测试用的中性标题，不是任何产品名
const noWait = async () => {};

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p3-'));
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

function writeSuccessBundle(paths, taskId, runId, { artifact = 'output/result.md', content = 'P3 产物' } = {}) {
  const file = path.join(paths.taskDir, artifact);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
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

function makeAdapter(root, t, overrides = {}) {
  const config = guiConfig(root, overrides);
  const lock = createGuiLock();
  const driver = createGuiDriver(config);
  const adapter = createGuiAdapter({ lock, driver, wait: noWait, maxPolls: config.maxPolls, config });
  return { adapter, config, lock, driver };
}

const defaultCeo = (ctx) => (ctx.wakeReason === 'review_requested'
  ? { type: 'review', verdict: 'pass', reason: '机检通过' }
  : { type: 'task-create', title: '子任务', role: 'general', assignee: 'worker-01' });

function guiCompanyConfig(guiAdapterConfig) {
  return {
    version: 1,
    company: { name: 'test-company', timezone: 'Asia/Shanghai' },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: defaultCeo } },
      },
      {
        id: 'worker-01', displayName: 'GUI 执行席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 20, reportsTo: 'ceo',
        adapter: { type: 'gui-template', config: guiAdapterConfig },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

// ---------------------------------------------------------------- P3-1

test('P3-1 · gui-template 已注册为通用型 adapter，且声明严格环境检查', () => {
  assert.ok(availableAdapterTypes().includes('gui-template'));
  const mod = getAdapter('gui-template');
  assert.equal(mod.type, 'gui-template');
  assert.equal(mod.strictEnvironment, true);
  assert.equal(typeof mod.testEnvironment, 'function');
  assert.equal(typeof mod.execute, 'function');
});

test('P3-1 · testEnvironment 六项检查全过：目录 / 窗口 / 步骤 / 驱动 / 提示词 / 互斥锁', (t) => {
  const root = tmpRoot(t);
  const { adapter, config } = makeAdapter(root, t);
  const env = adapter.testEnvironment(config);
  assert.equal(env.ok, true, env.detail);
  assert.equal(env.checks.length, 6);
  assert.ok(env.checks.every((c) => c.ok));
});

test('P3-1 · 缺 windowTitle / steps / workRoot / 驱动命令时明确失败，不静默跳过', (t) => {
  const root = tmpRoot(t);
  const { adapter, config } = makeAdapter(root, t);
  for (const [key, value] of [
    ['windowTitle', ''], ['steps', []], ['workRoot', path.join(root, '不存在的目录')],
  ]) {
    const env = adapter.testEnvironment({ ...config, [key]: value });
    assert.equal(env.ok, false, `${key} 不该通过`);
    assert.ok(env.detail.length > 0);
  }
  const noCommands = adapter.testEnvironment({ ...config, driver: 'command', commands: {} });
  assert.equal(noCommands.ok, false);
  assert.match(noCommands.detail, /驱动配置齐全/);
});

test('P3-1 · 自定义提示词模板漏槽位，环境检查直接拦下', (t) => {
  const root = tmpRoot(t);
  const { adapter, config } = makeAdapter(root, t);
  const env = adapter.testEnvironment({ ...config, promptTemplate: '只写一句话，什么路径都不给' });
  assert.equal(env.ok, false);
  assert.match(env.detail, /提示词模板含全部必备槽位/);
});

test('P3-1 · 全局 GUI 互斥锁：并发两个 owner 只有一个拿到，越权释放被拒', () => {
  const lock = createGuiLock();
  const a = lock.acquire('R-1');
  const b = lock.acquire('R-2');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.busy, true);
  assert.equal(lock.isHeld(), 'R-1');
  assert.equal(lock.release('R-2').released, false);
  assert.equal(lock.release('R-1').released, true);
  assert.equal(lock.isHeld(), null);
  assert.equal(lock.acquire('R-2').ok, true);
});

test('P3-1 · 跨进程文件锁：wx 独占、释放只改内容不删文件、过期锁可接管', (t) => {
  const root = tmpRoot(t);
  const lockPath = path.join(root, 'gui.lock');
  const first = createGuiLock({ lockPath });
  const second = createGuiLock({ lockPath });
  assert.equal(first.acquire('R-A').ok, true);
  assert.equal(second.acquire('R-B').busy, true);
  assert.equal(first.release('R-A').released, true);
  assert.equal(fs.existsSync(lockPath), true, '释放不得删除锁文件');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).released, true);
  assert.equal(second.acquire('R-B').ok, true, '已释放的锁可被下一任务接管');

  let clock = '2026-01-01T00:00:00.000Z';
  const staleLock = path.join(root, 'stale.lock');
  const old = createGuiLock({ lockPath: staleLock, now: () => clock, staleMs: 60000 });
  assert.equal(old.acquire('R-OLD').ok, true);
  clock = '2026-01-01T00:02:00.000Z';
  assert.equal(createGuiLock({ lockPath: staleLock, now: () => clock, staleMs: 60000 })
    .acquire('R-NEW').tookOver, true);
});

test('P3-1 · 引擎：环境不过时不派活、任务补偿回 todo、写 env_check_failed 审计', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = guiCompanyConfig({ ...guiConfig(root), windowTitle: '' });
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-GUI-ENV', text: '窗口没开', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo');
  assert.equal(engine.getRuns().length, 0, '环境没过一次都不该唤醒');
  assert.ok(engine.getAudit().some((a) => a.action === 'env_check_failed'));
  db.close();
});

// ---------------------------------------------------------------- P3-2

test('P3-2 · 源码零写死窗口标题 / 快捷键 / 按键；步骤只能由配置给出', () => {
  // 白名单是封闭集合：加动作必须同时改这里，防止配置里悄悄写进没实现的步骤。
  // 7 = activate / newSession / hotkey / paste / press / verify / restoreFocus
  assert.equal(SUPPORTED_STEP_ACTIONS.length, 7);
  assert.throws(() => normalizeSteps({}), /必须由配置提供 steps/);
  assert.throws(() => normalizeSteps({ steps: [{ action: 'click' }] }), /action 不合法/);
  // 收尾动作必须排最后，否则「还给用户焦点」之后还要校验目标窗口，必然自相矛盾。
  assert.throws(
    () => normalizeSteps({ steps: [{ action: 'restoreFocus' }, { action: 'paste' }] }),
    /必须排在最后一步/,
  );
  const steps = normalizeSteps({ steps: [{ action: 'hotkey', keys: ['A', 'B'] }, { action: 'press', key: 'GO' }] });
  assert.deepEqual(steps.map((s) => s.index), [0, 1]);
  for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.startsWith('gui-'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    assert.equal(/\b(C\+N|Ctrl|Alt|Enter|Tab|豆包|飞书|WorkBuddy|DSH)\b/.test(text), false,
      `${file} 不该写死窗口标题或按键`);
  }
});

test('P3-2 · 步骤严格按配置顺序执行，且每步前后都校验前台窗口', async (t) => {
  const root = tmpRoot(t);
  const { adapter, config, driver } = makeAdapter(root, t, {
    simulation: { onSend: ({ taskId, runId, paths }) => writeSuccessBundle(paths, taskId, runId) },
  });
  const out = await adapter.execute(makeCtx(config, 'T-STEPS', 'R-STEPS'));
  assert.equal(out.status, 'success');
  const actions = driver.trace.map((x) => x.action);
  assert.deepEqual(actions.slice(0, 5), ['activate', 'hotkey', 'clipboard', 'paste', 'press']);
  assert.ok(driver.trace.some((x) => x.action === 'paste' && x.length > 100), '提示词确实进了剪贴板');
});

test('P3-2 · 焦点校验：前台窗口不是目标窗口时立即抛 GuiError(focus)', async () => {
  const driver = createSimulationDriver({ initialTitle: WINDOW });
  assert.equal((await assertForeground(driver, WINDOW, '前')).ok, true);
  const stolen = createSimulationDriver({ initialTitle: WINDOW, stolenTitle: '别的窗口' });
  await assert.rejects(() => assertForeground(stolen, WINDOW, '中'), (e) => e instanceof GuiError && e.kind === 'focus');
});

test('P3-2 · 剪贴板内容与提示词不一致时拒绝发送', async (t) => {
  const root = tmpRoot(t);
  const config = guiConfig(root, { steps: [{ action: 'activate' }, { action: 'press', key: 'SUBMIT' }] });
  const driver = {
    kind: 'fake', trace: [], clipboard: '被别的东西覆盖了',
    async activateWindow() {}, async foregroundTitle() { return WINDOW; },
    async setClipboard() {}, async paste() {}, async press() {}, async send() {},
    async screenshot() { return Buffer.from('x'); },
  };
  const adapter = createGuiAdapter({ lock: createGuiLock(), driver, wait: noWait, config });
  // paste 步骤才会校验剪贴板；这里放一个 paste 让校验有机会跑。
  config.steps = [{ action: 'activate' }, { action: 'paste' }, { action: 'press', key: 'SUBMIT' }];
  const out = await adapter.execute(makeCtx(config, 'T-CLIP', 'R-CLIP'));
  assert.equal(out.status, 'blocked');
  assert.match(out.result.reason, /剪贴板/);
});

test('P3-2 · command 驱动的命令全来自配置，缺命令明确报错不猜默认值', async () => {
  const driver = createGuiDriver({ driver: 'command', commands: {} });
  await assert.rejects(() => driver.activateWindow(WINDOW), /缺 commands\.activate/);
  const configured = createGuiDriver({
    driver: 'command',
    commands: { activate: 'echo {{windowTitle}}', foregroundTitle: `echo ${WINDOW}` },
  });
  assert.equal(await configured.foregroundTitle(), WINDOW);
});

// ---------------------------------------------------------------- P3-3

test('P3-3 · 默认提示词含全部必备槽位：taskId / 绝对路径 / output / completion.json / 变更请求', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-PROMPT', {});
  const { prompt, values } = renderPrompt({
    task: { taskId: 'T-PROMPT', instructions: '干活', acceptance: ['产物非空'], reportsTo: 'ceo' },
    paths,
  });
  assert.equal(assertPromptComplete(prompt, values).slots, REQUIRED_PROMPT_SLOTS.length);
  for (const marker of ['T-PROMPT', 'input', 'output', 'completion.json', 'change-requests/',
    '不要只在屏幕上回复', 'progress.json', 'aicompany.completion/v1']) {
    assert.ok(prompt.includes(marker), `提示词缺 ${marker}`);
  }
  assert.ok(path.isAbsolute(paths.reportPath), '报告路径必须是绝对路径');
  assert.ok(DEFAULT_PROMPT_TEMPLATE.includes('{{reportPath}}'));
});

test('P3-3 · 自定义模板漏槽位 / 写未知槽位一律拒绝发送', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-P2', {});
  const task = { taskId: 'T-P2', instructions: 'x', acceptance: ['y'] };
  assert.throws(() => renderPrompt({ task, paths, config: { promptTemplate: '只干活' } }),
    /缺少必备内容/);
  assert.throws(() => renderPrompt({ task, paths, config: { promptTemplate: '{{taskId}} {{不存在的槽}}' } }),
    /未知槽位/);
});

test('P3-3 · 不靠读屏判断完成：窗口一直在、但没写报告就只能超时', async (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-NOSCREEN', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  const driver = createSimulationDriver({ initialTitle: WINDOW });
  assert.equal(await driver.foregroundTitle(), WINDOW, '前台窗口标题一直正确');
  const result = await pollForReport({
    paths, config: {}, taskId: 'T-NOSCREEN', runId: 'R-NOSCREEN',
    maxPolls: 3, wait: noWait,
  });
  assert.equal(result.kind, 'timeout', '没有文件就不能算完成');
  assert.equal(result.progressSeen, false);
});

// ---------------------------------------------------------------- P3-4

test('P3-4 · 合规报告通过 schema / 验收项 / checksum 并回收产物', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-OK', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  const report = writeSuccessBundle(paths, 'T-OK', 'R-OK');
  const checked = verifyReport({ report, paths, taskId: 'T-OK', runId: 'R-OK' });
  assert.equal(checked.ok, true, checked.errors.join('; '));
  assert.equal(Object.keys(checked.computed).length, 1);
  assert.match(checked.computed['output/result.md'], /^sha256:/);
});

test('P3-4 · 缺字段 / 验收项未过 / status 非 success 一律拒绝', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-BAD', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  const base = writeSuccessBundle(paths, 'T-BAD', 'R-BAD');
  const missing = { ...base }; delete missing.status;
  assert.equal(verifyReport({ report: missing, paths, taskId: 'T-BAD', runId: 'R-BAD' }).ok, false);
  const badAcceptance = writeSuccessBundle(paths, 'T-BAD', 'R-BAD');
  badAcceptance.acceptanceResults = [{ rule: '产物存在', pass: false }];
  assert.match(verifyReport({ report: badAcceptance, paths, taskId: 'T-BAD', runId: 'R-BAD' }).errors.join(), /验收项未通过/);
  const wrongStatus = writeSuccessBundle(paths, 'T-BAD', 'R-BAD');
  wrongStatus.status = 'failed'; wrongStatus.reason = 'x';
  assert.equal(verifyReport({ report: wrongStatus, paths, taskId: 'T-BAD', runId: 'R-BAD' }).ok, false);
});

test('P3-4 · checksum 不匹配 / 产物文件被改动 → 拒绝入库', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-HASH', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  const report = writeSuccessBundle(paths, 'T-HASH', 'R-HASH');
  report.checksum['output/result.md'] = 'sha256:deadbeef';
  assert.match(verifyReport({ report, paths, taskId: 'T-HASH', runId: 'R-HASH' }).errors.join(), /checksum 不匹配/);
});

test('P3-4 · 产物越界（绝对路径 / ../ / 不在 output 下）一律拒绝，不入库', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-OUT', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  for (const artifact of ['../secret.txt', path.join(root, 'abs.txt'), 'tmp/x.md']) {
    assert.equal(isInsideOutput(paths.outputDir, artifact), false, `${artifact} 不该被允许`);
    const report = writeSuccessBundle(paths, 'T-OUT', 'R-OUT');
    report.artifacts = [artifact];
    report.checksum = { [artifact]: 'sha256:x' };
    assert.match(verifyReport({ report, paths, taskId: 'T-OUT', runId: 'R-OUT' }).errors.join(), /越界/);
  }
});

test('P3-4 · 报告 taskId / runId 串单被拒', (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-REAL', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  const report = writeSuccessBundle(paths, 'T-REAL', 'R-REAL');
  const wrong = verifyReport({ report, paths, taskId: 'T-OTHER', runId: 'R-REAL' });
  assert.match(wrong.errors.join(), /taskId 不匹配/);
  assert.match(verifyReport({ report, paths, taskId: 'T-REAL', runId: 'R-OTHER' }).errors.join(), /runId 不匹配/);
});

test('P3-4 · 轮询先看 change-requests/：同时有 CR 和完成报告，先收 change_requested', async (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-CR', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  writeSuccessBundle(paths, 'T-CR', 'R-CR');
  writeChangeRequest(paths, 'CR-001', {
    schema: 'aicompany.change-request/v1', changeRequestId: 'CR-001',
    taskId: 'T-CR', runId: 'R-CR', agentId: 'worker-01', reportsTo: 'ceo',
    revision: 1, kind: 'direction', severity: 'needsDecision',
    reason: '前提变了，原目标作废', doneSoFar: { files: ['output/draft.md'] }, createdAt: nowIso(),
  });
  const polled = await pollForReport({ paths, config: {}, taskId: 'T-CR', runId: 'R-CR', maxPolls: 2, wait: noWait });
  assert.equal(polled.kind, 'change_request');
  assert.equal(polled.data.changeRequestId, 'CR-001');
  assert.equal(polled.file, 'CR-001.json');
});

test('P3-4 · progress.json 只读留痕，不触发事件、不唤醒任何人', async (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-PROGRESS', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  fs.writeFileSync(paths.progressPath, JSON.stringify({ percent: 60 }), 'utf8');
  const polled = await pollForReport({ paths, config: {}, taskId: 'T-PROGRESS', runId: 'R-P', maxPolls: 2, wait: noWait });
  assert.equal(polled.kind, 'timeout');
  assert.equal(polled.progressSeen, true);
});

test('P3-4 · 引擎收到 change_requested：不算失败、不重试、交控制面处理', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = guiCompanyConfig(guiConfig(root, {
    simulation: {
      onSend: ({ taskId, runId, paths }) => {
        writeChangeRequest(paths, 'CR-GUI', {
          schema: 'aicompany.change-request/v1', changeRequestId: 'CR-GUI',
          taskId, runId, agentId: 'worker-01', reportsTo: 'ceo', revision: 1,
          kind: 'direction', severity: 'needsDecision', reason: '前提变了',
          doneSoFar: { files: [] }, createdAt: nowIso(),
        });
      },
    },
  }));
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-GUI-CR', text: '中途变道', mode: 'direct', addressedTo: 'worker-01' });
  const audit = engine.getAudit().map((a) => a.action);
  assert.ok(audit.includes('change_requested_from_gui'));
  assert.equal(audit.includes('report_rejected'), false, '绝不能当成不合格报告');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM change_requests').get().n, 1);
  assert.equal(r.pending, 0);
  db.close();
});

// ---------------------------------------------------------------- P3-5

async function runFault(t, injection, taskId = 'T-FAULT') {
  const root = tmpRoot(t);
  const { adapter, config, lock } = makeAdapter(root, t, { simulation: injection });
  const out = await adapter.execute(makeCtx(config, taskId, 'R-FAULT'));
  const paths = buildTaskPaths(root, taskId, config);
  return { out, paths, lock, root };
}

test('P3-5 · 焦点被抢 → 中止并留证（deferred：等下次再派，不算失败）', async (t) => {
  const { out, paths, lock } = await runFault(t, { stolenTitle: '别的窗口' });
  // P6 起语义细化：抢不到前台是**临时条件**，adapter 报 deferred 让引擎退回排队；
  // 中止、留证、释放锁这些铁律一条不变，只是不再把卡打成 blocked。
  assert.equal(out.status, 'deferred');
  assert.equal(out.sessionParams.retryable, true);
  assert.match(String(out.sessionParams.deferredReason), /前台窗口不是目标窗口/);
  assert.ok(fs.existsSync(path.join(paths.screenshotsDir, 'T-FAULT-R-FAULT.png')));
  assert.equal(lock.isHeld(), null, '异常后必须释放 GUI 锁');
  assert.equal(fs.existsSync(paths.reportPath), false, '没有报告就绝不假装完成');
});

test('P3-5 · 弹窗遮挡 → deferred + 截图 + 锁释放', async (t) => {
  const { out, paths, lock } = await runFault(t, { overlay: '确认对话框' }, 'T-OVERLAY');
  assert.equal(out.status, 'deferred');
  assert.equal(out.sessionParams.retryable, true);
  assert.ok(fs.existsSync(path.join(paths.screenshotsDir, 'T-OVERLAY-R-FAULT.png')));
  assert.equal(lock.isHeld(), null);
});

test('P3-5 · 报告缺失超时 → failed 带 reason + 截图 + retry 配置透传', async (t) => {
  const { out, paths, lock } = await runFault(t, {}, 'T-TIMEOUT');
  assert.equal(out.status, 'failed');
  assert.match(out.result.reason, /超时/);
  assert.ok(fs.existsSync(path.join(paths.screenshotsDir, 'T-TIMEOUT-R-FAULT.png')));
  assert.deepEqual(out.sessionParams.retry, { max: 2, backoffSec: 0 });
  assert.equal(out.result.reason ? true : false, true, 'failed 报告必须带 reason');
  assert.equal(lock.isHeld(), null);
});

test('P3-5 · 报告 schema 残缺 → blocked 并附具体错误原因', async (t) => {
  const root = tmpRoot(t);
  const { adapter, config } = makeAdapter(root, t, {
    simulation: {
      onSend: ({ paths }) => fs.writeFileSync(paths.reportPath, JSON.stringify({ status: 'success' }), 'utf8'),
    },
  });
  const out = await adapter.execute(makeCtx(config, 'T-BROKEN', 'R-BROKEN'));
  assert.equal(out.status, 'blocked');
  assert.match(out.result.reason, /完成报告不合格/);
  assert.ok(fs.existsSync(path.join(buildTaskPaths(root, 'T-BROKEN', config).screenshotsDir, 'T-BROKEN-R-BROKEN.png')));
});

test('P3-5 · 故障之后不留脏状态：锁空闲、无越界产物、卡退回排队等下次', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = guiCompanyConfig(guiConfig(root, { simulation: { stolenTitle: '抢焦点' } }));
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-GUI-FAULT', text: '焦点故障', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'todo',
    '抢不到焦点：卡退回排队，不是打成 blocked');
  assert.equal(engine.getAudit().some((a) => a.action === 'wake_deferred'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get('in_progress').n, 0);
  assert.equal(getAdapter('gui-template').lock.isHeld(), null);
  db.close();
});

// ---------------------------------------------------------------- G-P3

test('G-P3 · 连续 10 个模板化任务 ≥9 自动完成并产出合格报告（注入 1 个不产报告）', async (t) => {
  const root = tmpRoot(t);
  let n = 0;
  const { adapter, config, lock } = makeAdapter(root, t, {
    simulation: {
      onSend: ({ taskId, runId, paths }) => {
        n += 1;
        if (n === 7) return; // 注入 1 次「报告缺失」
        writeSuccessBundle(paths, taskId, runId, { content: `第 ${n} 次产物` });
      },
    },
  });
  const results = [];
  for (let i = 1; i <= 10; i += 1) {
    const taskId = `T-GP3-${i}`;
    const runId = `R-GP3-${i}`;
    const out = await adapter.execute(makeCtx(config, taskId, runId));
    results.push({ taskId, status: out.status, report: out.result });
    assert.equal(lock.isHeld(), null, `第 ${i} 次执行后锁必须释放`);
  }
  const done = results.filter((r) => r.status === 'success');
  assert.equal(done.length >= 9, true, `应至少 9 个完成，实际 ${done.length}`);
  assert.equal(results[6].status, 'failed', '第 7 次是故意注入的失败');
  for (const item of done) {
    const paths = buildTaskPaths(root, item.taskId, config);
    const checked = verifyReport({
      report: item.report, paths,
      taskId: item.taskId, runId: `R-GP3-${item.taskId.split('-').pop()}`,
    });
    assert.equal(checked.ok, true, `${item.taskId} 报告不合格：${checked.errors.join('; ')}`);
    assert.ok(fs.existsSync(path.join(paths.outputDir, 'result.md')));
  }
});

test('G-P3 · 引擎集成：GUI 席位把模板任务自动办到 done，且 P0~P2 链路仍通', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = guiCompanyConfig(guiConfig(root, {
    simulation: { onSend: ({ taskId, runId, paths }) => writeSuccessBundle(paths, taskId, runId) },
  }));
  const engine = createEngine({ db, config, notifier: createNotifier('web') });
  const r = await engine.submit({ requestId: 'REQ-GUI-DONE', text: 'GUI 模板任务', mode: 'direct', addressedTo: 'worker-01' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r.taskId).status, 'done');
  assert.equal(r.pending, 0);
  assert.equal(engine.getRuns().length, 1);
  assert.ok(engine.getBriefs().length >= 1, '简报仍照常生成');

  // G-P3 门禁正文：连续 10 个模板化任务，≥9 自动完成并产出合格报告（§12.6）。
  const BATCH = 10;
  const ids = [];
  for (let i = 0; i < BATCH; i += 1) {
    ids.push((await engine.submit({
      requestId: `REQ-GUI-BATCH-${i}`, text: `模板任务 ${i}`, mode: 'direct', addressedTo: 'worker-01',
    })).taskId);
  }
  const rows = ids.map((id) => db.prepare('SELECT taskId FROM tasks WHERE taskId = ?').get(id));
  assert.equal(rows.filter(Boolean).length, BATCH, '10 张卡都在');
  const done = ids.filter((id) => db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(id).status === 'done');
  assert.ok(done.length >= 9, `门禁要求 ≥9，实际 ${done.length}`);
  const reportsOk = done.filter((id) => {
    const paths = buildTaskPaths(root, id, {});
    if (!fs.existsSync(paths.reportPath)) return false;
    const rep = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8'));
    return rep.status === 'success' && Object.keys(rep.checksum ?? {}).length > 0;
  });
  assert.equal(reportsOk.length, done.length, '办成的那几张，完成报告全部合格');

  // 回归：换成普通 mock 席位，delegate 闭环与循环引擎都不受 P3 影响。
  const db2 = openDb(':memory:');
  const plain = {
    ...config,
    agents: config.agents.map((a) => (a.id === 'worker-01'
      ? { ...a, adapter: { type: 'mock', config: { result: (ctx) => ({
        schema: 'aicompany.completion/v1', taskId: ctx.task?.taskId ?? ctx.taskId,
        runId: ctx.runId, agent: 'worker-01', revision: 1, status: 'success',
        summary: 'ok', artifacts: ['output/result.md'],
        checksum: { 'output/result.md': 'sha256:mock' },
        acceptanceResults: [{ rule: '产物存在', pass: true }],
        usage: { quotaUnits: 1 }, finishedAt: nowIso(),
      }) } } }
      : a)),
  };
  const engine2 = createEngine({ db: db2, config: plain, notifier: createNotifier('web') });
  const r2 = await engine2.submit({ requestId: 'REQ-REGRESSION', text: '回归检查', mode: 'delegate' });
  assert.equal(db2.prepare('SELECT status FROM tasks WHERE taskId = ?').get(r2.taskId).status, 'done');
  assert.equal(r2.pending, 0);
  db.close(); db2.close();
});

test('G-P3 · 截图留证只新增文件、不删除任何文件', async (t) => {
  const root = tmpRoot(t);
  const paths = buildTaskPaths(root, 'T-KEEP', {});
  writeTaskBundle(paths, { task: {}, prompt: 'x' });
  const marker = path.join(paths.taskDir, 'keep.txt');
  fs.writeFileSync(marker, '用户文件，不能动');
  const before = fs.readdirSync(paths.screenshotsDir).length;
  await captureScreenshot({ paths, taskId: 'T-KEEP', runId: 'R-1', driver: createSimulationDriver() });
  await captureScreenshot({ paths, taskId: 'T-KEEP', runId: 'R-2', driver: createSimulationDriver() });
  assert.equal(fs.readdirSync(paths.screenshotsDir).length, before + 2);
  assert.ok(fs.existsSync(marker), '不得删除任务目录里的任何既有文件');
  assert.ok(fs.statSync(path.join(paths.screenshotsDir, 'T-KEEP-R-1.png')).size > 0);
});

