// P5-1 / G-P5：试运行驱动器。
//
// 两种模式，结论绝不混用：
// - real：真实墙钟，按 intervalMs 真等。跑满 72 小时且全程无脏状态，才可能给出 gate=pass。
// - compressed：虚拟时钟把多天压进几分钟。它能证明「状态机在长时间维度不脏」，
//   但不能冒充「连续 3 天」——所以 gate 只会给 simulated，永远不给 pass。
//
// 负载由确定性 mock adapter 生成（可复现），验证的是控制面与治理逻辑，
// 不是模型质量。要验模型质量，用 --real-config 指向真实配置，让真实流量跑进来。

import fs from 'node:fs';
import path from 'node:path';
import { createEngine, createNotifier } from './engine.js';
import { openDb, seedAgents } from './core.js';
import { buildObservation, renderObservationMarkdown, detectDirty } from './observe.js';
import { nowIso } from './ids.js';
import { GuiError } from './gui-driver.js';

// GUI 席位的六种工况。soak 每步切一种，让闸门 / 剪贴板 / deferred / 失败都进样本。
// 不是随机撒：固定循环，出问题能对着场景号复现。
export const SOAK_GUI_MODES = Object.freeze(['ok', 'busy', 'locked', 'focus', 'bad']);

// 模拟对面那个 agent：收到提示词后往 output/ 写真产物，再写三字段 draft。
// 控制面扫 output/ 自己算校验和 —— 和真机豆包走的是同一条路径，不是假成功。
//
// 工况从**任务卡标题**解析（[gui-ok] / [gui-busy] / ...），不从全局状态读：
// 一张卡被闸门拦下后会在后续某轮重投，那时全局工况早就切走了；如果把行为绑在全局状态上，
// 「你正用电脑」的卡重投时会按当时的工况乱跑，样本归因全错。绑在卡上才对得起来。
// 首次触发故意出一次错（deferred / failed），重投即成功 —— 模拟「临时挡一下，稍后自己好了」。
function makeSoakGuiOnSend() {
  return async ({ paths, taskId, runId, ctx }) => {
    const title = String(ctx?.task?.title ?? '');
    const matched = /^\[gui-(ok|busy|locked|focus|bad)\]/.exec(title);
    const mode = matched?.[1] ?? 'ok';
    const attempt = Number(ctx?.task?.attempt ?? 0);
    if (mode === 'focus' && attempt === 0) {
      throw new GuiError('focus', '模拟：前台窗口被抢，稍后再试');
    }
    fs.mkdirSync(paths.outputDir, { recursive: true });
    if (mode !== 'bad' || attempt > 0) {
      fs.writeFileSync(
        path.join(paths.outputDir, 'result.md'),
        `# soak 产物\n\n- taskId: ${taskId}\n- runId: ${runId}\n- 工况: ${mode}\n- 第 ${attempt + 1} 次\n`,
        'utf8',
      );
    }
    fs.writeFileSync(path.join(paths.taskDir, 'report.draft.json'), `${JSON.stringify({
      schema: 'aicompany.draft/v1', status: 'success',
      summary: `soak GUI 席位（${mode}）完成`,
    }, null, 2)}\n`, 'utf8');
  };
}

// 五个席位：CEO / 组长 / 执行 / 救火 / 模拟驱动 GUI。
// GUI 那席用 simulation driver，不碰真实键鼠、不抢前台；只有文件和状态机是真的。
export function buildSoakSeats({ quotaDaily = 30, workRoot = null } = {}) {
  const guiState = { mode: 'ok' };
  return [
    {
      id: 'ceo', displayName: '总经理', isCEO: true,
      capabilities: ['plan', 'delegate', 'review', 'escalate'],
      status: 'active', quotaDaily, reportsTo: null,
      adapter: { type: 'mock', config: { result: soakCeoResult } },
    },
    {
      id: 'lead', displayName: '组长', isCEO: false,
      capabilities: ['plan', 'review', 'delegate', 'execute'],
      status: 'active', quotaDaily, reportsTo: 'ceo',
      adapter: { type: 'mock', config: { result: makeSoakWorkerResult(workRoot) } },
    },
    {
      id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily, reportsTo: 'lead', escalationTo: 'worker-02',
      adapter: { type: 'mock', config: { result: makeSoakWorkerResult(workRoot) } },
    },
    {
      id: 'worker-02', displayName: '救火席位', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily, reportsTo: 'ceo',
      adapter: { type: 'mock', config: { result: makeSoakWorkerResult(workRoot) } },
    },
    // G-P5 / B：把 GUI 路径也拉进 72 小时样本。
    // 之前四席全是 mock，guiFailure 永远「样本不足」，闸门 / 剪贴板 / deferred 一行都没跑到。
    {
      id: 'gui-worker', displayName: 'GUI 执行席（模拟驱动）', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily, reportsTo: 'lead',
      adapter: {
        type: 'gui-template',
        config: {
          workRoot,
          windowTitle: 'Soak Assistant（模拟）',
          driver: 'simulation',
          reportMode: 'draft',
          pollIntervalMs: 10,
          maxPolls: 1,
          // 四道闸只开两道：静置与锁屏。busy / locked 两种工况靠改 simulation 的读数触发，
          // 而不是改闸配置 —— 配置在 72 小时里必须冻结，否则样本口径会漂。
          gate: { requireIdleSec: 60, requireUnlocked: true },
          steps: [
            { action: 'activate' },
            { action: 'paste' },
            { action: 'press', key: 'enter' },
          ],
          simulation: {
            initialTitle: 'Soak Assistant（模拟）',
            idleSec: 999, locked: false, clipChars: 0,
            onSend: makeSoakGuiOnSend(),
            // 给 runner 找到这个状态对象用；createSimulationDriver 展开时忽略未知字段。
            _modeState: guiState,
          },
        },
      },
    },
  ];
}

// CEO：被请求复审就放行，否则拆成子卡。这条是 delegate 链路能跑通的前提。
function soakCeoResult(ctx) {
  if (ctx.wakeReason === 'review_requested') {
    return { type: 'review', verdict: 'pass', reason: '通过' };
  }
  if (ctx.wakeReason === 'escalation') {
    return { type: 'review', verdict: 'pass', reason: '升级处理完毕' };
  }
  return {
    type: 'task-create',
    title: `子任务：${ctx.task?.title ?? '拆解'}`,
    assignee: 'worker-01',
    acceptance: ['完成报告可读'],
  };
}

// 执行席位：按标题前缀决定这一轮怎么收场，造出正常 / 返工 / 挂起三类样本。
// 成功时要真的把 completion.json 落到盘上——「只认文件」是这套引擎的底线，
// mock 不写文件的话，长跑里的「报告缺失」检查会全是误报。
function makeSoakWorkerResult(workRoot) {
  return (ctx) => {
    const title = String(ctx.task?.title ?? '');
    if (title.startsWith('[hang]')) {
      return {
        status: 'change_requested',
        changeRequestId: `CR-${ctx.runId}`,
        kind: 'direction',
        severity: 'needsDecision',
        reason: '前提变了，请拍板',
        doneSoFar: { percent: 40 },
      };
    }
    if (title.startsWith('[bad]') && (ctx.task?.attempt ?? 0) === 0) {
      // 第一次交不合格报告 → 触发返工；第二次正常收工。
      return { schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, runId: ctx.runId, agent: ctx.agent.id, status: 'failed' };
    }
    const report = {
      schema: 'aicompany.completion/v1',
      taskId: ctx.task?.taskId ?? 'T-unknown',
      runId: ctx.runId,
      agent: ctx.agent.id,
      revision: ctx.task?.revision ?? 1,
      status: 'success',
      summary: `soak 完成：${title.slice(0, 40)}`,
      artifacts: [],
      checksum: {},
      acceptanceResults: [{ rule: '完成报告可读', pass: true }],
      usage: { quotaUnits: 1 },
      finishedAt: nowIso(),
    };
    if (workRoot && ctx.task?.taskId) {
      const dir = path.join(workRoot, 'tasks', ctx.task.taskId, 'output');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'completion.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return report;
  };
}

// 配额默认给足：GUI 卡被闸门拦下 / deferred / 返工都会重试，一张卡能累积好几个 run。
// 配额触顶会让引擎拒绝派活并记一条 error，把「状态机不脏」的长跑结论污染成报错。
// 试运行是压力测试，配额治理不是它的观测对象。
export function buildSoakConfig({ workRoot = null, cooldownSec = 0, maxConcurrent = 3, periodHours = 24, quotaDaily = 500 } = {}) {
  return {
    version: 1,
    workRoot,
    company: { name: 'soak-run', timezone: 'Asia/Shanghai' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours },
    gates: { strategy: false, hiringBudget: false },
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    runPolicy: { maxConcurrent, cooldownSec, maxRunHours: 2, staleEventMinutes: 10 },
    interaction: {
      defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false,
      meeting: { defaultStyle: 'rollCall', fullRequiresConfirm: true },
      thread: { ttlDays: 30, promoteRequiresExplicit: true },
    },
    agents: buildSoakSeats({ quotaDaily, workRoot }),
    clients: ['web'], notifier: ['noop'],
  };
}

// 一轮 8 个场景，循环使用。刻意混进返工、挂起、协作、会议，让指标有样本可算。
export const SOAK_SCENARIOS = Object.freeze([
  { kind: 'direct-ok', title: '[ok] 整理本周数据', mode: 'direct', addressedTo: 'worker-01' },
  { kind: 'direct-ok', title: '[ok] 汇总会议纪要', mode: 'direct', addressedTo: 'worker-02' },
  { kind: 'direct-bad', title: '[bad] 出一版粗糙草稿', mode: 'direct', addressedTo: 'worker-01' },
  { kind: 'direct-hang', title: '[hang] 目标可能变了的那件活', mode: 'direct', addressedTo: 'worker-01' },
  { kind: 'delegate', title: '[ok] 拆一下季度目标', mode: 'delegate', addressedTo: null },
  { kind: 'cowork', title: '[ok] 一起改材料', mode: 'cowork', addressedTo: 'worker-01' },
  { kind: 'meeting', title: '[ok] 点名同步进度', mode: 'meeting', addressedTo: null },
  { kind: 'direct-ok', title: '[ok] 巡检日志', mode: 'direct', addressedTo: 'lead' },
  // G-P5 / B：五种 GUI 工况各一张卡，点名给模拟 GUI 席位。
  { kind: 'gui-ok', title: '[gui-ok] GUI 席位整理材料', mode: 'direct', addressedTo: 'gui-worker', guiMode: 'ok' },
  { kind: 'gui-busy', title: '[gui-busy] 你正用电脑时来的 GUI 活', mode: 'direct', addressedTo: 'gui-worker', guiMode: 'busy' },
  { kind: 'gui-locked', title: '[gui-locked] 锁屏时来的 GUI 活', mode: 'direct', addressedTo: 'gui-worker', guiMode: 'locked' },
  { kind: 'gui-focus', title: '[gui-focus] 前台被抢的 GUI 活', mode: 'direct', addressedTo: 'gui-worker', guiMode: 'focus' },
  { kind: 'gui-bad', title: '[gui-bad] GUI 席位交了空报告', mode: 'direct', addressedTo: 'gui-worker', guiMode: 'bad' },
]);

export function scenarioFor(index) {
  return SOAK_SCENARIOS[index % SOAK_SCENARIOS.length];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 造一个可长时间运行的试运行环境。
 * @param {object} opts
 * @param {string} opts.workRoot 产物根目录
 * @param {string} opts.dbPath sqlite 文件路径（不给就内存库，但那样验证不到重启持久化）
 * @param {Date} opts.startAt 虚拟时钟起点
 */
export function createSoakRunner({
  workRoot, dbPath = ':memory:', config = null, startAt = new Date('2026-03-01T00:00:00.000Z'),
  stepMinutes = 60, sampleEvery = 1, realClock = false,
} = {}) {
  ensureDir(workRoot);
  const db = openDb(dbPath);
  const cfg = config ?? buildSoakConfig({ workRoot });
  seedAgents(db, cfg);
  let virtualNow = new Date(startAt.getTime());
  // real 模式用真实墙钟：脏检测的「Run 挂了多久 / 事件积压多久」必须按真时间算，
  // 否则虚拟时钟停在起点，72 小时里所有超时检查都会失效。
  const clock = realClock ? () => new Date() : () => new Date(virtualNow);
  const engine = createEngine({
    db, config: cfg, notifier: createNotifier('noop'),
    workRoot, now: clock, dispatchMode: 'inline', maxSteps: 200,
  });

  // G-P5 / B：找到 GUI 席位的状态对象，每步切工况。配置本身冻结，只改模拟探针的读数。
  const guiSeat = (cfg.agents ?? []).find((a) => a.id === 'gui-worker') ?? null;
  const guiState = guiSeat?.adapter?.config?.simulation?._modeState ?? null;
  const guiSimulation = guiSeat?.adapter?.config?.simulation ?? null;
  function setGuiMode(mode = 'ok') {
    if (!guiState) return;
    const safe = SOAK_GUI_MODES.includes(mode) ? mode : 'ok';
    guiState.mode = safe;
    if (guiSimulation) {
      // requireIdleSec=60：busy 给 0 秒；其余给 999 秒，绝不会误拦。
      guiSimulation.idleSec = safe === 'busy' ? 0 : 999;
      guiSimulation.locked = safe === 'locked';
      guiSimulation.clipChars = 0;
    }
  }

  const samples = [];
  let stepIndex = 0;
  let scenarioIndex = 0;
  let probeCount = 0;

  function advance(minutes = stepMinutes) {
    virtualNow = new Date(virtualNow.getTime() + minutes * 60_000);
    return clock();
  }

  // 主动探针：对一张已完成的卡再发一次派活事件，验证「终态拦截」真的挡住了。
  // 不这么干的话，误唤醒率会永远显示「样本不足」——不是没发生，而是没人去撞。
  async function probeTerminalWake() {
    const done = db.prepare("SELECT taskId, assignee FROM tasks WHERE status = 'done' ORDER BY rowid DESC LIMIT 1").get();
    if (!done) return null;
    engine.emitEvent({
      type: 'issue_assigned', taskId: done.taskId, agentId: done.assignee,
      payload: { wakeReason: 'issue_assigned' },
      dedupeKey: `probe:${done.taskId}:${stepIndex}`,
      source: 'soak-probe',
    });
    await engine.pump();
    probeCount += 1;
    return done.taskId;
  }

  // 常驻该做的事：定时例程 → 补偿扫描 → 挂起超时 → 协作空间 TTL。
  // 补偿扫描给 10 分钟宽限，不能每步都把所有 todo 重投一遍（那会造出大量假唤醒）。
  function maintain() {
    const at = clock();
    const compensated = engine.compensationScan({ olderThanMs: 10 * 60_000, now: at });
    const expired = engine.expireDecisions({ now: at });
    const archived = engine.archiveStaleThreads({ now: at });
    return { at: at.toISOString(), compensated, expired, archived };
  }

  function sample(tag = '') {
    const dirty = detectDirty({ db, config: cfg, workRoot, now: clock() });
    const counts = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
    const sampled = {
      at: clock().toISOString(),
      step: stepIndex,
      tag,
      tasks: Object.fromEntries(counts.map((r) => [r.status, r.n])),
      runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
      pendingEvents: db.prepare('SELECT COUNT(*) AS n FROM events WHERE processed = 0').get().n,
      dirtyCount: dirty.count,
      dirtyCodes: dirty.counts,
      guiMode: guiState?.mode ?? null,
    };
    samples.push(sampled);
    return sampled;
  }

  async function submitScenario(scenario) {
    const requestId = `SOAK-${scenario.kind}-${stepIndex}-${scenarioIndex}`;
    scenarioIndex += 1;
    if (scenario.mode === 'cowork') {
      return engine.submit({ requestId, text: scenario.title, mode: 'cowork', addressedTo: scenario.addressedTo });
    }
    if (scenario.mode === 'meeting') {
      return engine.submit({
        requestId, text: scenario.title, mode: 'meeting',
        style: 'rollCall', participants: ['worker-01', 'lead'],
      });
    }
    if (scenario.mode === 'direct') {
      return engine.submit({ requestId, text: scenario.title, mode: 'direct', addressedTo: scenario.addressedTo });
    }
    return engine.submit({ requestId, text: scenario.title, mode: 'delegate' });
  }

  /**
   * 跑若干步。每步：推进时钟 → 维护 → 投一个请求 → 采样。
   * @returns {{ steps, hours, samples, errors }}
   */
  async function drive({ hours = 72, onStep = null } = {}) {
    const steps = Math.round((hours * 60) / stepMinutes);
    const errors = [];
    for (let i = 0; i < steps; i += 1) {
      stepIndex += 1;
      advance();
      const scenario = scenarioFor(stepIndex);
      // 先切工况再维护：上一轮被闸门退回的卡，重投时要用这一轮的读数。
      setGuiMode(scenario.guiMode ?? 'ok');
      try {
        maintain();
        await submitScenario(scenario);
        await engine.pump();
        if (stepIndex % 8 === 0) await probeTerminalWake();
      } catch (error) {
        // 试运行的正常预期是「不炸」。炸了要留证，不能吞掉假装顺利。
        errors.push({ step: stepIndex, at: clock().toISOString(), error: String(error.message ?? error) });
      }
      if (stepIndex % sampleEvery === 0) sample(scenario.kind);
      if (onStep) onStep({ step: stepIndex, steps, at: clock().toISOString() });
    }
    return { steps, hours, samples, errors };
  }

  /**
   * 真实墙钟模式走一步：只投一张卡，不推进虚拟时钟（时钟是真实墙钟）。
   * 由 scripts/soak.js 每个 interval 调一次。跟 drive() 的单步逻辑一致，
   * 区别仅在「不 advance」——否则 72 小时会把虚拟时钟推到天荒地老，脏检测全乱。
   */
  async function realtimeStep() {
    stepIndex += 1;
    const scenario = scenarioFor(stepIndex);
    setGuiMode(scenario.guiMode ?? 'ok');
    let error = null;
    try {
      maintain();
      await submitScenario(scenario);
      await engine.pump();
      if (stepIndex % 8 === 0) await probeTerminalWake();
    } catch (e) {
      error = String(e.message ?? e);
    }
    sample(scenario.kind);
    return { step: stepIndex, scenario: scenario.kind, at: clock().toISOString(), error };
  }

  function observation({ mode = 'compressed', hours = 0, startedAt = null } = {}) {
    return buildObservation({
      db, config: cfg, workRoot, now: clock(),
      window: {
        mode, hours, stepMinutes, startedAt, endedAt: clock().toISOString(),
        notes: [
          ...(probeCount > 0
            ? [`含 ${probeCount} 次「对已完成卡再派一次」的主动探针，用于验证终态拦截；探针单独计数，不计入误唤醒率的分母。`]
            : []),
          guiState
            ? '含模拟驱动 GUI 席位（simulation driver，不碰真实键鼠），按 ok/busy/locked/focus/bad 五种工况循环，闸门、剪贴板、deferred、失败率均进样本。'
            : '本次未启用模拟 GUI 席位。',
        ],
      },
    });
  }

  return {
    db, engine, config: cfg, clock,
    get now() { return clock(); },
    get samples() { return samples; },
    get probeCount() { return probeCount; },
    advance, maintain, sample, submitScenario, probeTerminalWake, drive, realtimeStep, observation, setGuiMode,
    get guiMode() { return guiState?.mode ?? null; },
    close: () => db.close(),
  };
}

const GATE_MIN_HOURS = 72;

// G-P5 门禁判定。宁可判不过，也不许把模拟当实测。
export function judgeGate({ mode, wallClockHours, wallClockMinutes = null, samples, finalObservation }) {
  const dirtyEver = samples.filter((s) => s.dirtyCount > 0);
  if (mode === 'compressed') {
    const minutes = wallClockMinutes ?? wallClockHours * 60;
    return {
      passed: false,
      level: 'simulated',
      reason: `压缩时钟用 ${minutes.toFixed(2)} 分钟墙钟跑完多天，只能证明「逻辑在多天维度不自相矛盾」；`
        + `G-P5 要求的是连续 ${GATE_MIN_HOURS} 小时真实墙钟，不能用模拟代替。`,
      dirtyEver: dirtyEver.length,
      finalClean: finalObservation?.dirty?.clean ?? null,
    };
  }
  if (wallClockHours < GATE_MIN_HOURS) {
    return {
      passed: false,
      level: 'insufficient',
      reason: `真实墙钟只跑了 ${wallClockHours.toFixed(2)} 小时，未满 ${GATE_MIN_HOURS} 小时。`,
      dirtyEver: dirtyEver.length,
      finalClean: finalObservation?.dirty?.clean ?? null,
    };
  }
  if (dirtyEver.length > 0 || finalObservation?.dirty?.clean === false) {
    return {
      passed: false,
      level: 'dirty',
      reason: `跑满 ${wallClockHours.toFixed(2)} 小时，但中途出现 ${dirtyEver.length} 次脏状态，最后一次检查也不干净。`,
      dirtyEver: dirtyEver.length,
      finalClean: false,
    };
  }
  return {
    passed: true,
    level: 'real',
    reason: `连续 ${wallClockHours.toFixed(2)} 小时真实墙钟，全程 ${samples.length} 次采样零脏状态。`,
    dirtyEver: 0,
    finalClean: true,
  };
}

export function writeSoakReport(reportDir, { runId, mode, hours, stepMinutes, startedAt, endedAt, samples, observation, gate, errors = [] }) {
  const dir = ensureDir(path.join(reportDir, runId));
  const report = {
    runId, mode, hours, stepMinutes, startedAt, endedAt,
    wallClockHours: (Date.parse(endedAt) - Date.parse(startedAt)) / 3_600_000,
    gate,
    sampleCount: samples.length,
    dirtySamples: samples.filter((s) => s.dirtyCount > 0).length,
    errors,
    observation,
  };
  fs.writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // 逐步采样单独一份 jsonl，方便画曲线 / 事后追某一步发生了什么。
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'report.md'), `${[
    `# 试运行报告 ${runId}`,
    '',
    `- 模式：**${mode}**（${mode === 'real' ? '真实墙钟' : '压缩时钟'}）`,
    `- 窗口：${startedAt} → ${endedAt}（墙钟 ${report.wallClockHours.toFixed(2)} 小时）`,
    `- 采样：${samples.length} 次，其中脏状态采样 ${report.dirtySamples} 次`,
    `- 异常：${errors.length} 次`,
    '',
    `## G-P5 门禁：${gate.passed ? '通过' : '未通过'}（${gate.level}）`,
    '',
    gate.reason,
    '',
    errors.length ? `## 异常明细\n\n${errors.slice(0, 20).map((e) => `- 第 ${e.step} 步（${e.at}）：${e.error}`).join('\n')}` : '',
    '',
    renderObservationMarkdown(observation),
  ].join('\n')}\n`, 'utf8');
  return { dir, report };
}
