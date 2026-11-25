// P5-1 / P5-3 / G-P5：试运行的观测与脏状态检查。
// 全部从控制面自己的记录里算（tasks / runs / audit / events / quotas / threads），
// 不读屏、不猜、不依赖 agent 自述。指标定义写在 METRIC_DEFINITIONS 里，报告里原样带上，
// 避免出现「有数字但没人知道它到底在量什么」。

import fs from 'node:fs';
import path from 'node:path';

// 指标口径。改口径必须改这里，报告会把它一起印出来（防止事后自己骗自己）。
export const METRIC_DEFINITIONS = Object.freeze({
  falseWake: '误唤醒率 = 对「已挂起等决策 / 已终态」的任务发起的唤醒次数 ÷ 全部被拒唤醒次数。配额、并发、bridge 离线属于正常延迟，不计入误唤醒。主动探针单独计数，不进分子分母。',
  idleRun: '空转率 = 跑完但没带来任何进展的 Run 数 ÷ 成功的 Run 数。进展指状态迁移、建卡、返工、验收、决策、改版、升级、改派。',
  reportReject: '报告不合格率 = 验收打回次数 ÷（验收通过 + 验收打回）。等于返工率。',
  guiFailure: 'GUI 失败率 = GUI 席位（adapter.type=gui-template）非成功 Run 数 ÷ 有效 Run 数；deferred（你正在用电脑 / 前台被抢）是临时条件，不扣额度、不算失败，单独列出不计入分母。含环境检查不过与超时。',
  quotaBurn: '额度消耗 = 本周期各席位已用 ÷ 上限，合计给出总消耗率。',
});

// 哪些审计动作算「这个 Run 干了实事」。不在这张表里的成功 Run 就是空转。
const PROGRESS_ACTIONS = new Set([
  'transition', 'create_task', 'rework', 'review_rework', 'report_rejected', 'machine_acceptance',
  'derive_task', 'derive_from_change_request', 'decision_applied', 'revision_bumped',
  'escalate_to_rescue', 'reassign', 'strategy_approved', 'replan_approved', 'promote_thread',
  'cycle_instantiated', 'cycle_closed', 'cycle_task_closed', 'change_request_created',
]);

// 被拒唤醒的分类：这两类是「本来就不该唤醒」，其余属于正常的延迟/拒绝。
const MISWAKE_CODES = new Set(['suspended', 'terminal']);

const ratio = (a, b) => (b > 0 ? Number((a / b).toFixed(4)) : null);

function classifyWake(value) {
  const text = String(value ?? '');
  // 新格式 agentId|code|reason|source；老记录只有裸文本，按关键词兜底。
  const parts = text.split('|');
  if (parts.length >= 3) return { code: parts[1], source: parts[3] ?? 'control-plane' };
  if (text.includes('挂起')) return { code: 'suspended', source: 'control-plane' };
  if (text.includes('终态') || text.includes('已完成') || text.includes('已取消')) return { code: 'terminal', source: 'control-plane' };
  if (text.includes('配额')) return { code: 'quota', source: 'control-plane' };
  if (text.includes('并发')) return { code: 'concurrent', source: 'control-plane' };
  if (text.includes('bridge')) return { code: 'bridge_offline', source: 'control-plane' };
  if (text.includes('冷却')) return { code: 'cooldown', source: 'control-plane' };
  return { code: 'other', source: 'control-plane' };
}

// P5-1：五项指标。
export function computeMetrics({ db, config }) {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY rowid').all();
  const runs = db.prepare('SELECT * FROM runs ORDER BY rowid').all();
  const audit = db.prepare('SELECT * FROM audit ORDER BY rowid').all();
  const agents = config?.agents ?? [];

  // ① 误唤醒
  // 主动探针（source=soak-probe）单独计数：它证明拦截有效，但不是「真实流量里的误唤醒」，
  // 混进分母会让误唤醒率虚高到 100%，等于自己吓自己。
  const rejected = audit.filter((a) => a.action === 'wake_rejected');
  const byCode = {};
  let probeRejected = 0;
  let realRejected = 0;
  let miswake = 0;
  for (const row of rejected) {
    const { code, source } = classifyWake(row.newValue);
    if (source === 'soak-probe') {
      probeRejected += 1;
      byCode[`probe:${code}`] = (byCode[`probe:${code}`] ?? 0) + 1;
      continue;
    }
    realRejected += 1;
    byCode[code] = (byCode[code] ?? 0) + 1;
    if (MISWAKE_CODES.has(code)) miswake += 1;
  }

  // ② 空转 Run：成功但该 runId 下没有任何进展动作
  const progressByRun = new Set(audit.filter((a) => a.runId && PROGRESS_ACTIONS.has(a.action)).map((a) => a.runId));
  const successRuns = runs.filter((r) => r.status === 'success' || r.status === 'done');
  const idleRuns = successRuns.filter((r) => !progressByRun.has(r.runId));

  // ③ 报告不合格率
  const rejectedReports = audit.filter((a) => a.action === 'report_rejected').length;
  const acceptedReports = audit.filter((a) => a.action === 'machine_acceptance').length;

  // ④ GUI 失败率
  const guiAgents = new Set(agents.filter((a) => a.adapter?.type === 'gui-template').map((a) => a.id));
  const guiRuns = runs.filter((r) => guiAgents.has(r.agentId));
  // deferred = 临时条件（你在用电脑 / 前台被抢），引擎明确不扣额度、不算失败、不累加重试。
  // 指标口径必须跟引擎一致：它既不是成功也不是失败，单独列出，不进失败率分母（同 falseWake 的处理）。
  const guiDeferred = guiRuns.filter((r) => r.status === 'deferred');
  const guiEffective = guiRuns.filter((r) => r.status !== 'deferred');
  const guiBad = guiEffective.filter((r) => r.status !== 'success' && r.status !== 'done');
  const envFailed = audit.filter((a) => a.action === 'env_check_failed').length;

  // ⑤ 额度消耗
  const quotaRows = db.prepare('SELECT * FROM quotas ORDER BY agentId').all();
  const used = quotaRows.reduce((n, q) => n + (q.used ?? 0), 0);
  const limit = quotaRows.reduce((n, q) => n + (q.limitUnits ?? 0), 0);

  return {
    tasks: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      awaitingDecision: tasks.filter((t) => t.status === 'awaiting_decision').length,
    },
    runs: { total: runs.length },
    falseWake: {
      attempts: realRejected,
      miswake,
      deferred: realRejected - miswake,
      probeRejected,
      byCode,
      rate: ratio(miswake, realRejected),
    },
    idleRun: {
      total: idleRuns.length,
      successRuns: successRuns.length,
      runIds: idleRuns.slice(-20).map((r) => r.runId),
      rate: ratio(idleRuns.length, successRuns.length),
    },
    reportReject: {
      rejected: rejectedReports,
      accepted: acceptedReports,
      rate: ratio(rejectedReports, rejectedReports + acceptedReports),
    },
    guiFailure: {
      runs: guiEffective.length,
      failed: guiBad.length,
      deferred: guiDeferred.length,
      envCheckFailed: envFailed,
      rate: ratio(guiBad.length, guiEffective.length),
    },
    quotaBurn: {
      used,
      limit,
      rate: ratio(used, limit),
      byAgent: quotaRows.map((q) => ({
        agentId: q.agentId, period: q.period, used: q.used, limit: q.limitUnits,
        rate: ratio(q.used, q.limitUnits),
      })),
    },
    definitions: METRIC_DEFINITIONS,
  };
}

// P5-3：§6C / §6D 的四个新指标。每个都给「结论」，不给结论就不算观察过。
export function computeInteractionFindings({ db, config }) {
  const ceoId = (config?.agents ?? []).find((a) => a.isCEO === true)?.id ?? null;
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY rowid').all();
  const runs = db.prepare('SELECT * FROM runs ORDER BY rowid').all();
  const threads = db.prepare('SELECT * FROM threads ORDER BY rowid').all();
  const changes = db.prepare('SELECT * FROM change_requests ORDER BY rowid').all();
  const audit = db.prepare('SELECT * FROM audit ORDER BY rowid').all();

  // ① 直投是否绕开 CEO
  const direct = tasks.filter((t) => t.mode === 'direct');
  const directToOther = direct.filter((t) => t.assignee && t.assignee !== ceoId);
  const ceoRunsOnDirect = runs.filter((r) => direct.some((t) => t.taskId === r.taskId) && r.agentId === ceoId);
  const bypass = direct.length === 0 ? 'insufficient' : (ceoRunsOnDirect.length > 0 ? 'fail' : 'pass');
  const bypassConclusion = direct.length === 0
    ? '样本不足：试运行期间没有直投任务，无法判断'
    : ceoRunsOnDirect.length === 0
      ? `直投确实绕开 CEO：${direct.length} 张直投卡里 CEO 一次都没被唤醒`
      : `直投没有绕开 CEO：${ceoRunsOnDirect.length} 次 CEO 介入，需查是否被当成 delegate 处理`;

  // ② cowork 是否误建卡
  const cowork = threads.filter((t) => t.mode === 'cowork');
  const coworkTaskIds = new Set(cowork.map((t) => t.threadId));
  const tasksFromCowork = tasks.filter((t) => t.threadId && coworkTaskIds.has(t.threadId));
  const coworkConclusion = cowork.length === 0
    ? '样本不足：试运行期间没有 cowork 会话，无法判断'
    : tasksFromCowork.length === 0
      ? `${cowork.length} 个 cowork 会话全部零建卡，符合预期`
      : `${tasksFromCowork.length} 张卡来自 cowork 会话，属于误建卡，必须修`;

  // ③ awaiting_decision 是否被误重跑
  // 判据：变更请求落盘之后，该任务出现了 wakeReason 不是 decision 的新 Run。
  // 必须排除「产生这个变更请求的那一次 Run」——它和 cr 同时落盘，不排除就会被当成误重跑。
  const susTaskIds = [...new Set(changes.map((c) => c.taskId))];
  const misRuns = [];
  for (const cr of changes) {
    const since = Date.parse(cr.createdAt);
    for (const r of runs) {
      if (r.taskId !== cr.taskId) continue;
      if (r.runId === cr.runId) continue;
      if (!r.startedAt || Date.parse(r.startedAt) <= since) continue;
      if (r.wakeReason === 'decision') continue;
      misRuns.push({ taskId: r.taskId, runId: r.runId, wakeReason: r.wakeReason, changeRequestId: cr.changeRequestId });
    }
  }
  const rerunConclusion = susTaskIds.length === 0
    ? '样本不足：试运行期间没有挂起过，无法判断'
    : misRuns.length === 0
      ? `${susTaskIds.length} 次挂起全程没有被别的唤醒插进来，符合预期`
      : `挂起后被误跑了 ${misRuns.length} 次，必须修`;

  // ④ 决策超时率
  const timedOut = audit.filter((a) => a.action === 'decision_timeout').length;
  const reminded = audit.filter((a) => a.action === 'decision_reminder').length;
  const stillPending = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'awaiting_decision'").get().n;
  const decided = Math.max(0, susTaskIds.length - timedOut - stillPending);
  const timeoutConclusion = susTaskIds.length === 0
    ? '样本不足：试运行期间没有挂起过，无法判断'
    : timedOut === 0
      ? `${susTaskIds.length} 次挂起里 ${decided} 次已拍板、${stillPending} 次仍在等人，零超时`
      : `${susTaskIds.length} 次挂起里有 ${timedOut} 次超时被自动取消（${Math.round((timedOut / susTaskIds.length) * 100)}%），拍板跟不上`;

  return {
    directBypassesCeo: {
      directTasks: direct.length,
      directToNonCeo: directToOther.length,
      ceoRuns: ceoRunsOnDirect.length,
      verdict: bypass,
      conclusion: bypassConclusion,
    },
    coworkCreatesTask: {
      coworkThreads: cowork.length,
      tasksFromCowork: tasksFromCowork.length,
      taskIds: tasksFromCowork.map((t) => t.taskId),
      verdict: cowork.length === 0 ? 'insufficient' : (tasksFromCowork.length === 0 ? 'pass' : 'fail'),
      conclusion: coworkConclusion,
    },
    awaitingRerun: {
      suspended: susTaskIds.length,
      misRuns: misRuns.length,
      sample: misRuns.slice(0, 10),
      verdict: susTaskIds.length === 0 ? 'insufficient' : (misRuns.length === 0 ? 'pass' : 'fail'),
      conclusion: rerunConclusion,
    },
    decisionTimeout: {
      suspended: susTaskIds.length,
      timedOut,
      reminded,
      decided,
      stillPending,
      rate: ratio(timedOut, susTaskIds.length),
      verdict: susTaskIds.length === 0 ? 'insufficient' : (timedOut === 0 ? 'pass' : 'attention'),
      conclusion: timeoutConclusion,
    },
  };
}

// G-P5：什么叫「脏状态」。每一条都必须能指向具体记录，不许用「感觉没问题」代替。
export const DIRTY_RULES = Object.freeze([
  ['orphan_run', 'Run 指向不存在的任务卡'],
  ['stuck_running', 'Run 一直 running 没收尾（超过 maxRunHours）'],
  ['stale_event', '事件积压超过 staleEventMinutes 没被处理'],
  ['awaiting_overdue', '挂起超过 72 小时仍没被取消（说明超时扫描没跑）'],
  ['done_without_report', '卡标成 done，但完成报告文件不存在'],
  ['in_progress_without_run', '卡在 in_progress，但从没有任何 Run 跑过'],
  ['quota_anomaly', '配额账目为负或远超上限'],
  ['decision_without_cr', '决策指向不存在的变更请求'],
  ['revision_gap', '任务当前 revision 与版本快照表的最大 revision 不一致'],
  ['promoted_not_archived', '协作空间已提升成卡，但状态没归档'],
  ['terminal_rewoken', '已终态的任务之后又被唤醒跑了一次'],
]);

export function detectDirty({ db, config, workRoot = null, now = new Date(), since = null }) {
  const issues = [];
  const add = (code, detail, extra = {}) => issues.push({ code, detail, ...extra });
  const allTasks = db.prepare('SELECT * FROM tasks ORDER BY rowid').all();
  const taskIds = new Set(allTasks.map((t) => t.taskId));
  const sinceMs = since ? Date.parse(since) : null;
  // 常驻门禁只判「观察窗口内」的状态：窗口之前就已终态、且之后再没动过的老卡，
  // 不拿来当今天的脏数据（否则历史上的 12 张无报告卡会让新门禁永远过不了）。
  // 非终态卡无论如何都算——它们现在还在系统里，是真问题。
  const tasks = sinceMs
    ? allTasks.filter((t) => (t.updatedAt && Date.parse(t.updatedAt) >= sinceMs)
      || (t.status !== 'done' && t.status !== 'cancelled'))
    : allTasks;
  const allRuns = db.prepare('SELECT * FROM runs ORDER BY rowid').all();
  // 窗口内开跑的 Run；另外 running 的 Run 不管什么时候开跑都算当前脏。
  const runs = sinceMs
    ? allRuns.filter((r) => (r.startedAt && Date.parse(r.startedAt) >= sinceMs) || r.status === 'running')
    : allRuns;
  const maxRunHours = config?.runPolicy?.maxRunHours ?? 2;
  const staleEventMin = config?.runPolicy?.staleEventMinutes ?? 10;

  for (const r of runs) {
    if (!taskIds.has(r.taskId)) add('orphan_run', `Run ${r.runId} 指向不存在的任务 ${r.taskId}`, { runId: r.runId });
    if (r.status === 'running' && r.startedAt) {
      const h = (now.getTime() - Date.parse(r.startedAt)) / 3_600_000;
      if (h > maxRunHours) add('stuck_running', `Run ${r.runId} 已 running ${h.toFixed(1)}h（上限 ${maxRunHours}h）`, { runId: r.runId });
    }
  }

  for (const e of db.prepare('SELECT * FROM events WHERE processed = 0').all()) {
    const min = (now.getTime() - Date.parse(e.createdAt)) / 60_000;
    if (min > staleEventMin) add('stale_event', `事件 ${e.eventId}（${e.type}）积压 ${Math.round(min)} 分钟`, { eventId: e.eventId });
  }

  const maxPendingH = config?.decision?.maxPendingHours ?? 72;
  for (const t of tasks.filter((x) => x.status === 'awaiting_decision')) {
    const cr = db.prepare('SELECT createdAt FROM change_requests WHERE taskId = ? ORDER BY rowid LIMIT 1').get(t.taskId);
    if (cr) {
      const h = (now.getTime() - Date.parse(cr.createdAt)) / 3_600_000;
      if (h > maxPendingH + 1) add('awaiting_overdue', `任务 ${t.taskId} 挂起 ${Math.round(h)}h 仍未被取消`, { taskId: t.taskId });
    }
  }

  if (workRoot) {
    // 只查执行席位：指挥岗（CEO / 组长）以「派出子卡」收场，本来就没有 completion.json，
    // 对它报「报告缺失」是误报，会把长跑结论搞脏（第一版就踩了这个坑）。
    for (const t of tasks.filter((x) => x.status === 'done')) {
      const agentRow = db.prepare('SELECT isCEO, capabilities FROM agents WHERE agentId = ?').get(t.assignee);
      const caps = JSON.parse(agentRow?.capabilities ?? '[]');
      const isExecutor = agentRow && !agentRow.isCEO && caps.includes('execute');
      if (!isExecutor) continue;
      const payload = db.prepare('SELECT completionReportPath FROM task_payload WHERE taskId = ? ORDER BY revision DESC LIMIT 1').get(t.taskId);
      const rel = payload?.completionReportPath;
      // completionReportPath 是相对「任务目录」的（如 output/completion.json），不是相对 workRoot。
      if (rel) {
        const abs = path.isAbsolute(rel) ? rel : path.join(workRoot, 'tasks', t.taskId, rel);
        // GUI 型 adapter 的 reportPath 默认是任务根的 completion.json（见 buildTaskPaths），
        // 而建卡时元数据统一写 output/completion.json。两个都是合法落点：
        // 验收阶段 verifyReport 已逐字段校验过 checksum，这里只问「报告文件还在不在」。
        // 只认元数据那一处会把所有 GUI 卡误判成脏（生产库 11/11 全中），属于假阳性。
        const rootReport = path.join(workRoot, 'tasks', t.taskId, 'completion.json');
        const legacyReport = abs === rootReport ? null : rootReport;
        if (!fs.existsSync(abs) && !(legacyReport && fs.existsSync(legacyReport))) {
          add('done_without_report', `任务 ${t.taskId} 标 done，但报告缺失：${abs}`, { taskId: t.taskId });
        }
      }
    }
  }

  for (const t of tasks.filter((x) => x.status === 'in_progress')) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE taskId = ?').get(t.taskId).n;
    if (n === 0 && now.getTime() - Date.parse(t.createdAt) > 5 * 60_000) {
      add('in_progress_without_run', `任务 ${t.taskId} 在 in_progress 却从没跑过 Run`, { taskId: t.taskId });
    }
  }

  for (const q of db.prepare('SELECT * FROM quotas').all()) {
    if ((q.used ?? 0) < 0) add('quota_anomaly', `${q.agentId} 配额为负：${q.used}`);
    if (q.limitUnits && q.used > q.limitUnits * 2) {
      add('quota_anomaly', `${q.agentId} 已用 ${q.used} 超过上限 ${q.limitUnits} 的两倍`);
    }
  }

  for (const d of db.prepare('SELECT * FROM decisions').all()) {
    const cr = db.prepare('SELECT changeRequestId FROM change_requests WHERE changeRequestId = ?').get(d.changeRequestId);
    if (!cr) add('decision_without_cr', `决策 ${d.decisionId} 指向不存在的变更请求 ${d.changeRequestId}`);
  }

  for (const t of tasks) {
    const maxRev = db.prepare('SELECT MAX(revision) AS m FROM task_revisions WHERE taskId = ?').get(t.taskId).m;
    if (maxRev && t.revision !== maxRev) {
      add('revision_gap', `任务 ${t.taskId} 当前 revision=${t.revision}，但版本表最大是 ${maxRev}`, { taskId: t.taskId });
    }
  }

  for (const th of db.prepare('SELECT * FROM threads').all()) {
    if (th.promotedTo && th.state !== 'archived') {
      add('promoted_not_archived', `协作空间 ${th.threadId} 已提升为 ${th.promotedTo}，但状态是 ${th.state}`);
    }
  }

  // 终态又被唤醒：任务进入 done/cancelled 的时刻之后，仍有新 Run 开跑。
  for (const t of tasks.filter((x) => x.status === 'done' || x.status === 'cancelled')) {
    const closed = db.prepare("SELECT createdAt FROM audit WHERE action = 'transition' AND taskId = ? AND (newValue LIKE '%done%' OR newValue LIKE '%cancelled%') ORDER BY rowid DESC LIMIT 1").get(t.taskId);
    if (!closed?.createdAt) continue;
    const after = runs.filter((r) => r.taskId === t.taskId && r.startedAt && Date.parse(r.startedAt) > Date.parse(closed.createdAt));
    if (after.length) add('terminal_rewoken', `任务 ${t.taskId} 已 ${t.status}，之后又被跑了 ${after.length} 次`, { taskId: t.taskId });
  }

  const counts = issues.reduce((acc, i) => ({ ...acc, [i.code]: (acc[i.code] ?? 0) + 1 }), {});
  return { clean: issues.length === 0, count: issues.length, counts, issues, rules: DIRTY_RULES.map(([code, text]) => ({ code, text })) };
}

// 汇总成一份可查的观察记录。
export function buildObservation({ db, config, workRoot = null, window = {}, now = new Date() }) {
  const metrics = computeMetrics({ db, config });
  const findings = computeInteractionFindings({ db, config });
  const dirty = detectDirty({ db, config, workRoot, now });
  const samples = db.prepare("SELECT oldValue FROM audit WHERE action = 'soak_sample' ORDER BY rowid DESC LIMIT 1").get();
  return {
    generatedAt: now.toISOString(),
    window,
    metrics,
    findings,
    dirty,
    lastSampleAt: samples?.oldValue ?? null,
    verdict: dirty.clean ? 'clean' : 'dirty',
  };
}

export function writeObservation(outPath, observation) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
  return outPath;
}

// 给看板 / 报告用的大白话渲染（Markdown）。
export function renderObservationMarkdown(obs) {
  const pct = (v) => (v === null || v === undefined ? '样本不足' : `${(v * 100).toFixed(1)}%`);
  const m = obs.metrics;
  const f = obs.findings;
  const fw = m.falseWake;
  // 0/0 不是「样本不足」，是「真实流量里根本没有被拒的唤醒」——两句话含义完全不同。
  const fwText = fw.attempts === 0
    ? (fw.probeRejected > 0
      ? `真实流量零被拒唤醒；另有 ${fw.probeRejected} 次探针全部被终态拦截挡住`
      : '样本不足（没有任何被拒唤醒，也没跑探针）')
    : `${pct(fw.rate)}（${fw.miswake}/${fw.attempts}，另有 ${fw.probeRejected} 次探针）`;
  const lines = [
    `# 试运行观察记录`,
    '',
    `- 生成时间：${obs.generatedAt}`,
    `- 观察窗口：${obs.window.mode ?? '未标注'} / ${obs.window.hours ?? '?'} 小时`,
    `- 总体判定：**${obs.verdict === 'clean' ? '无脏状态' : `发现 ${obs.dirty.count} 处脏状态`}**`,
    ...(obs.window?.notes?.length ? ['', ...obs.window.notes.map((n) => `> ${n}`)] : []),
    '',
    '## 五项指标（P5-1）',
    '',
    '| 指标 | 数值 | 口径 |',
    '|---|---|---|',
    `| 误唤醒率 | ${fwText} | ${METRIC_DEFINITIONS.falseWake} |`,
    `| 空转 Run 率 | ${pct(m.idleRun.rate)}（${m.idleRun.total}/${m.idleRun.successRuns}） | ${METRIC_DEFINITIONS.idleRun} |`,
    `| 报告不合格率 | ${pct(m.reportReject.rate)}（${m.reportReject.rejected}/${m.reportReject.rejected + m.reportReject.accepted}） | ${METRIC_DEFINITIONS.reportReject} |`,
    `| GUI 失败率 | ${pct(m.guiFailure.rate)}（${m.guiFailure.failed}/${m.guiFailure.runs}，deferred ${m.guiFailure.deferred} 次不计分母，环境检查不过 ${m.guiFailure.envCheckFailed} 次） | ${METRIC_DEFINITIONS.guiFailure} |`,
    `| 额度消耗 | ${pct(m.quotaBurn.rate)}（${m.quotaBurn.used}/${m.quotaBurn.limit}） | ${METRIC_DEFINITIONS.quotaBurn} |`,
    '',
    '## §6C / §6D 四项结论（P5-3）',
    '',
    `1. **直投是否绕开 CEO**（${f.directBypassesCeo.verdict}）：${f.directBypassesCeo.conclusion}`,
    `2. **cowork 是否误建卡**（${f.coworkCreatesTask.verdict}）：${f.coworkCreatesTask.conclusion}`,
    `3. **挂起是否被误重跑**（${f.awaitingRerun.verdict}）：${f.awaitingRerun.conclusion}`,
    `4. **决策超时率**（${f.decisionTimeout.verdict}）：${f.decisionTimeout.conclusion}`,
    '',
    '## 脏状态检查（G-P5）',
    '',
    obs.dirty.clean
      ? '本次检查 11 条规则全部通过，没有发现脏状态。'
      : `发现 ${obs.dirty.count} 处：\n\n| 类型 | 说明 |\n|---|---|\n${obs.dirty.issues.map((i) => `| ${i.code} | ${i.detail} |`).join('\n')}`,
    '',
    '> 注意：脏状态检查只能证明「控制面的记录自洽」，不能证明 agent 干得对不对。后者要看报告不合格率与人工抽检。',
  ];
  return `${lines.join('\n')}\n`;
}
