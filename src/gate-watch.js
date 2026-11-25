// G-P5 常驻门禁：不再按「连续 72 小时墙钟」判，改成按「累计活动 + 任务样本」判。
//
// 为什么改：用户白天用电脑、晚上关机，72 小时连续墙钟既不舒服也不真实。
// 现在的口径：
//   - 只有两次采样间隔 <= maxGapMs 才算「活动时间」；关机、睡眠、进程停掉的大空档不计；
//   - 样本数、任务数、Run 数、GUI 任务数、任务异常率都必须达标；
//   - 脏状态和探测失败必须为 0；
//   - 达标那一刻把结果钉住（passedAt），之后继续采样只做观察，不会因为一次新脏状态把已通过翻回去。
//
// 这个模块本身不设定时器：由常驻控制面的维护心跳每 60 秒调一次 sample()，
// 状态落 workRoot/gate-watch.json，重启后接着累计，晚上关机不扣时间。

import fs from 'node:fs';
import path from 'node:path';
import { detectDirty } from './observe.js';

export const GATE_SCHEMA = 'aicompany.gate-watch/v1';

export const DEFAULT_GATE_THRESHOLDS = Object.freeze({
  minActiveHours: 6,
  minSamples: 300,
  minTasks: 30,
  minRuns: 30,
  minGuiTasks: 5,
  maxTaskErrorRate: 0.05,
  maxDirtySamples: 0,
  // 脏状态只看最近这么多小时（2026-11-25 改）：随着使用会不断调代码和命令，
  // 历史脏过的账不该永久卡住门禁。累计值仍保留，只作展示。
  dirtyWindowHours: 24,
  maxProbeErrors: 0,
});

const HOUR_MS = 3_600_000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ratio(n, d) {
  return d > 0 ? n / d : null;
}

// 脏状态按小时分桶（UTC 的 YYYY-MM-DDTHH），只用来算「最近 N 小时」，
// 历史总量另存在 dirtySamples 里做展示，不参与判定。
function hourKey(at) {
  return at.toISOString().slice(0, 13);
}

function pruneBuckets(buckets, at, keepHours) {
  const from = at.getTime() - keepHours * HOUR_MS;
  const out = {};
  for (const [key, count] of Object.entries(buckets)) {
    const ms = Date.parse(`${key}:00:00.000Z`);
    if (Number.isFinite(ms) && ms >= from) out[key] = count;
  }
  return out;
}

// 最近 windowHours 小时内的脏状态次数。
// 老状态没有 buckets 时退回 lastDirtyAt：在窗口内算 1 次，窗口外不算 —— 历史累计不再追罚。
export function recentDirtyCount(state, { at = null, windowHours } = {}) {
  const hours = windowHours ?? DEFAULT_GATE_THRESHOLDS.dirtyWindowHours;
  const ref = at ?? (state.updatedAt ? new Date(state.updatedAt) : new Date());
  const from = ref.getTime() - hours * HOUR_MS;
  const buckets = state.dirtyBuckets;
  if (buckets && typeof buckets === 'object' && Object.keys(buckets).length > 0) {
    let n = 0;
    for (const [key, count] of Object.entries(buckets)) {
      const ms = Date.parse(`${key}:00:00.000Z`);
      if (Number.isFinite(ms) && ms >= from && ms <= ref.getTime() + HOUR_MS) n += Number(count ?? 0);
    }
    return n;
  }
  if (state.lastDirtyAt && Date.parse(state.lastDirtyAt) >= from) return 1;
  return 0;
}

export function emptyGateState({ now = new Date() } = {}) {
  const at = now.toISOString();
  return {
    schema: GATE_SCHEMA,
    startedAt: at,
    updatedAt: at,
    lastTickAt: null,
    activeMs: 0,
    samples: 0,
    dirtySamples: 0,
    dirtyBuckets: {},
    probeErrors: 0,
    lastDirtyAt: null,
    lastProbeError: null,
    tasks: 0,
    tasksDone: 0,
    tasksBad: 0,
    guiTasks: 0,
    runs: 0,
    effectiveRuns: 0,
    failedRuns: 0,
    interruptedRuns: 0,
    skippedRuns: 0,
    passedAt: null,
    passedSnapshot: null,
  };
}

export function loadGateState(statePath, { now = new Date() } = {}) {
  if (!statePath || !fs.existsSync(statePath)) return emptyGateState({ now });
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!raw || raw.schema !== GATE_SCHEMA) return emptyGateState({ now });
    // 老状态缺字段就补默认值，避免升级后读一个 undefined 把累计清零。
    return { ...emptyGateState({ now }), ...raw };
  } catch {
    return emptyGateState({ now });
  }
}

export function saveGateState(statePath, state) {
  if (!statePath) return;
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 采样一次。纯函数，不读库：调用方把 task/run 统计和 dirty 结果传进来。
 * @param {object} state
 * @param {object} sample
 * @param {Date} sample.at
 * @param {boolean} sample.clean
 * @param {number} sample.dirtyCount
 * @param {string|null} sample.probeError
 * @param {object} sample.taskStats { tasks, tasksDone, tasksBad, guiTasks }
 * @param {object} sample.runStats { runs, effectiveRuns, failedRuns, interruptedRuns, skippedRuns }
 * @param {number} maxGapMs
 */
export function applyGateSample(state, sample, { maxGapMs = 10 * 60_000, thresholds = DEFAULT_GATE_THRESHOLDS } = {}) {
  const s = { ...state };
  const at = sample.at instanceof Date ? sample.at : new Date(sample.at);
  const iso = at.toISOString();

  if (s.lastTickAt) {
    const gap = at.getTime() - Date.parse(s.lastTickAt);
    // 只把「连续在跑」的间隔计入活动时间。关机一夜、进程停掉都算空档，不加。
    if (gap > 0 && gap <= maxGapMs) s.activeMs += gap;
  }
  s.lastTickAt = iso;
  s.samples += 1;

  if (sample.probeError) {
    s.probeErrors += 1;
    s.lastProbeError = { at: iso, error: String(sample.probeError) };
  }
  if (sample.clean === false) {
    s.dirtySamples += 1;
    s.lastDirtyAt = iso;
    const key = hourKey(at);
    const buckets = { ...(s.dirtyBuckets ?? {}) };
    buckets[key] = (buckets[key] ?? 0) + 1;
    s.dirtyBuckets = pruneBuckets(buckets, at, (thresholds.dirtyWindowHours ?? 24) + 1);
  }

  const t = sample.taskStats ?? {};
  s.tasks = Number(t.tasks ?? 0);
  s.tasksDone = Number(t.tasksDone ?? 0);
  s.tasksBad = Number(t.tasksBad ?? 0);
  s.guiTasks = Number(t.guiTasks ?? 0);

  const r = sample.runStats ?? {};
  s.runs = Number(r.runs ?? 0);
  s.effectiveRuns = Number(r.effectiveRuns ?? 0);
  s.failedRuns = Number(r.failedRuns ?? 0);
  s.interruptedRuns = Number(r.interruptedRuns ?? 0);
  s.skippedRuns = Number(r.skippedRuns ?? 0);

  s.updatedAt = iso;
  if (!s.passedAt) {
    const gate = judgeGateState(s, thresholds);
    if (gate.passed) {
      s.passedAt = iso;
      s.passedSnapshot = gate.metrics;
    }
  }
  return s;
}

/**
 * 门禁判定：先看硬故障（探测失败 / 脏状态），再看样本量够不够，最后看任务异常率。
 * 注意：passedAt 一旦落下就保持通过；之后的新脏状态只作为「通过后事件」另行观察。
 */
export function judgeGateState(state, thresholds = DEFAULT_GATE_THRESHOLDS) {
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...thresholds };
  const activeHours = state.activeMs / HOUR_MS;
  // 2026-11-25：异常率改按「卡」算 —— 同一张卡重派三次会被记三条 failed run，
  // 拿 run 算等于重复罚分。真正该看的是「最后没做成的卡 / 总卡」。
  const taskErrorRate = ratio(state.tasksBad, state.tasks);
  const runFailureRate = ratio(state.failedRuns, state.effectiveRuns);
  const recentDirty = recentDirtyCount(state, { windowHours: th.dirtyWindowHours });
  const metrics = {
    activeHours,
    samples: state.samples,
    tasks: state.tasks,
    tasksDone: state.tasksDone,
    tasksBad: state.tasksBad,
    guiTasks: state.guiTasks,
    runs: state.runs,
    effectiveRuns: state.effectiveRuns,
    failedRuns: state.failedRuns,
    interruptedRuns: state.interruptedRuns,
    skippedRuns: state.skippedRuns,
    taskErrorRate,
    runFailureRate,
    dirtySamples: state.dirtySamples,
    recentDirtySamples: recentDirty,
    dirtyWindowHours: th.dirtyWindowHours,
    probeErrors: state.probeErrors,
    thresholds: th,
  };

  if (state.passedAt) {
    return {
      passed: true,
      level: 'passed',
      reason: `已在 ${state.passedAt} 达标并钉住：累计活动 ${activeHours.toFixed(2)}h、${state.tasks} 个任务、${state.effectiveRuns} 个有效 Run、异常率 ${taskErrorRate === null ? '样本不足' : `${(taskErrorRate * 100).toFixed(1)}%`}。通过后继续采样，只做观察。`,
      metrics,
      missing: [],
    };
  }

  if (state.probeErrors > th.maxProbeErrors) {
    return {
      passed: false, level: 'probe-error',
      reason: `探测失败 ${state.probeErrors} 次，超过上限 ${th.maxProbeErrors}；看门狗自己瞎了不能算干净。`,
      metrics, missing: ['探测失败'],
    };
  }
  if (recentDirty > th.maxDirtySamples) {
    return {
      passed: false, level: 'dirty',
      reason: `最近 ${th.dirtyWindowHours} 小时内出现 ${recentDirty} 次脏状态（上限 ${th.maxDirtySamples}）；等它自己过去或先修掉根因再说。`,
      metrics, missing: ['脏状态'],
    };
  }

  const missing = [];
  if (activeHours < th.minActiveHours) missing.push(`活动 ${activeHours.toFixed(2)}/${th.minActiveHours}h`);
  if (state.samples < th.minSamples) missing.push(`采样 ${state.samples}/${th.minSamples}`);
  if (state.tasks < th.minTasks) missing.push(`任务 ${state.tasks}/${th.minTasks}`);
  if (state.effectiveRuns < th.minRuns) missing.push(`有效 Run ${state.effectiveRuns}/${th.minRuns}`);
  if (state.guiTasks < th.minGuiTasks) missing.push(`GUI 任务 ${state.guiTasks}/${th.minGuiTasks}`);

  if (missing.length > 0) {
    return {
      passed: false, level: 'insufficient',
      reason: `样本还不够：${missing.join('、')}。晚上关机不扣时间，下次启动接着累计。`,
      metrics, missing,
    };
  }
  if (taskErrorRate !== null && taskErrorRate > th.maxTaskErrorRate) {
    return {
      passed: false, level: 'error-rate',
      reason: `任务异常率 ${(taskErrorRate * 100).toFixed(1)}%（${state.tasksBad}/${state.tasks} 张卡最终 blocked/cancelled），超过上限 ${(th.maxTaskErrorRate * 100).toFixed(1)}%。`,
      metrics, missing: ['任务异常率'],
    };
  }

  return {
    passed: true, level: 'pass',
    reason: `累计活动 ${activeHours.toFixed(2)}h、${state.samples} 次采样、${state.tasks} 个任务、${state.effectiveRuns} 个有效 Run、GUI 任务 ${state.guiTasks} 个；`
      + `任务异常率 ${taskErrorRate === null ? '样本不足' : `${(taskErrorRate * 100).toFixed(1)}%`}、最近 ${th.dirtyWindowHours} 小时零脏、零探测失败。`,
    metrics, missing: [],
  };
}

/**
 * 常驻门禁实例。不自己 setInterval，由控制面的维护心跳驱动。
 */
export function createGateWatch({
  db, config, workRoot,
  statePath = null, reportDir = null,
  thresholds = DEFAULT_GATE_THRESHOLDS,
  now = () => new Date(),
  maxGapMs = 10 * 60_000,
  reportEvery = 5,
  env = process.env,
} = {}) {
  const root = workRoot || process.cwd();
  const stateFile = statePath || path.join(root, 'gate-watch.json');
  const reportRoot = reportDir || path.join(root, 'gate-watch');
  const th = { ...DEFAULT_GATE_THRESHOLDS, ...thresholds };
  let state = loadGateState(stateFile, { now: now() });
  let lastReportAt = 0;
  let lastPassReported = Boolean(state.passedAt);

  function taskStats() {
    const since = state.startedAt;
    const tasks = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN status IN ('blocked', 'cancelled') THEN 1 ELSE 0 END) AS bad
        FROM tasks WHERE createdAt >= ?
    `).get(since);
    const gui = db.prepare(`
      SELECT COUNT(*) AS n
        FROM tasks t JOIN agents a ON a.agentId = t.assignee
       WHERE a.adapterType = 'gui-template' AND t.createdAt >= ?
    `).get(since);
    return {
      tasks: Number(tasks.n ?? 0),
      tasksDone: Number(tasks.done ?? 0),
      tasksBad: Number(tasks.bad ?? 0),
      guiTasks: Number(gui.n ?? 0),
    };
  }

  function runStats() {
    const since = state.startedAt;
    const row = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
             SUM(CASE WHEN status IN ('deferred', 'blocked') THEN 1 ELSE 0 END) AS skipped
        FROM runs WHERE startedAt >= ?
    `).get(since);
    const total = Number(row.n ?? 0);
    const skipped = Number(row.skipped ?? 0);
    const effective = Math.max(0, total - skipped);
    return {
      runs: total,
      effectiveRuns: effective,
      failedRuns: Number(row.failed ?? 0),
      interruptedRuns: Number(row.interrupted ?? 0),
      skippedRuns: skipped,
    };
  }

  function sample() {
    const at = now();
    let dirty = null;
    let probeError = null;
    try {
      dirty = detectDirty({ db, config, workRoot: root, now: at, since: state.startedAt });
    } catch (error) {
      probeError = String(error?.message ?? error);
    }
    const ts = taskStats();
    const rs = runStats();
    state = applyGateSample(state, {
      at,
      clean: dirty ? dirty.clean : null,
      dirtyCount: dirty ? dirty.count : null,
      probeError,
      taskStats: ts,
      runStats: rs,
    }, { maxGapMs, thresholds: th });
    saveGateState(stateFile, state);

    if (state.samples - lastReportAt >= reportEvery) {
      writeGateReport(reportRoot, { state, gate: judgeGateState(state, th) });
      lastReportAt = state.samples;
    }
    if (state.passedAt && !lastPassReported) {
      // 达标那一刻写一份定稿，之后继续采样只更新进度，不覆盖“通过”结论。
      writeGateReport(reportRoot, { state, gate: judgeGateState(state, th) });
      lastReportAt = state.samples;
      lastPassReported = true;
    }
    return snapshot();
  }

  function snapshot() {
    return {
      state: { ...state },
      gate: judgeGateState(state, th),
      statePath: stateFile,
      reportDir: reportRoot,
    };
  }

  function markdown() {
    return renderGateMarkdown({ state, gate: judgeGateState(state, th) });
  }

  function stop() {
    saveGateState(stateFile, state);
    writeGateReport(reportRoot, { state, gate: judgeGateState(state, th) });
  }

  return {
    sample, snapshot, markdown, stop,
    get state() { return state; },
    thresholds: th,
  };
}

export function writeGateReport(reportDir, { state, gate }) {
  ensureDir(reportDir);
  const report = { schema: 'aicompany.gate-report/v1', generatedAt: new Date().toISOString(), state, gate };
  fs.writeFileSync(path.join(reportDir, 'gate-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'gate-report.md'), `${renderGateMarkdown({ state, gate })}\n`, 'utf8');
  return report;
}

export function renderGateMarkdown({ state, gate }) {
  const m = gate.metrics;
  const pct = (v) => (v === null || v === undefined ? '样本不足' : `${(v * 100).toFixed(1)}%`);
  return [
    '# G-P5 常驻门禁报告',
    '',
    `- 结论：**${gate.passed ? '通过' : '未通过'}**（${gate.level}）`,
    `- 累计窗口：${state.startedAt} → ${state.updatedAt}`,
    `- 累计活动：${m.activeHours.toFixed(2)} / ${m.thresholds.minActiveHours} 小时（关机空档不计）`,
    `- 采样：${state.samples} / ${m.thresholds.minSamples} 次；脏状态累计 ${state.dirtySamples} 次（判定只看最近 ${m.thresholds.dirtyWindowHours} 小时，其中 ${m.recentDirtySamples ?? 0} 次）；探测失败 ${state.probeErrors} 次`,
    `- 任务：${state.tasks} / ${m.thresholds.minTasks} 个；其中 done ${state.tasksDone}、blocked/cancelled ${state.tasksBad}、GUI 任务 ${state.guiTasks} / ${m.thresholds.minGuiTasks}`,
    `- Run：${state.runs} 个；有效 ${state.effectiveRuns} / ${m.thresholds.minRuns}；failed ${state.failedRuns}、interrupted ${state.interruptedRuns}、deferred/blocked ${state.skippedRuns}（只作观察，不判异常）`,
    `- 任务异常率：${pct(m.taskErrorRate)}（按卡算：${state.tasksBad}/${state.tasks} 张最终 blocked/cancelled；上限 ${(m.thresholds.maxTaskErrorRate * 100).toFixed(1)}%）`,
    state.passedAt ? `- 通过时间：${state.passedAt}` : '',
    '',
    '## 判定说明',
    '',
    gate.reason,
    '',
    '> 口径：只累计「连续在跑」的活动时间；晚上关机、进程停掉的空档不扣也不补。脏状态只看最近 24 小时（历史累计留着展示，不追罚）；异常率按卡算（同一张卡重派多次不重复罚分）。达到样本量、窗口内零脏、零探测失败、异常率不超线即通过，通过后钉住。',
  ].filter((x) => x !== '').join('\n');
}
