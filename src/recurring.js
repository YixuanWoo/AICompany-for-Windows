// P2-5 / P2-6：循环引擎 L2 —— 实例化器、misfire / overlap / dedupe / 终止闸、
// CycleHistory（deltaVsPrev 由控制面算）与 carryOver 跨轮记忆。
// 依据：任务书 §6A.2 / §6A.3 / §6A.4 / §6A.5 / §6A.6 / §6A.13 用例 1~6。

import { randomUUID } from 'node:crypto';
import { validate, loadSchema } from './validate.js';
import { emit, writeAudit } from './core.js';
import { nowIso } from './ids.js';
import { nextFireAt, occurrencesBetween } from './rrule.js';

const shortId = () => randomUUID().slice(0, 8);
const minuteKey = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 16);

// 按协议里声明的字段裁剪：校验只看协议字段，运行时内部字段不参与（否则改版必被判「多余字段」）。
const schemaOnly = (kind, data) => {
  const schema = loadSchema(kind);
  if (!schema?.properties) return data;
  const out = {};
  for (const key of Object.keys(schema.properties)) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
};

// 错过触发点时该补几轮：run_once 只补最近 1 次，skip 不补，catch_up 有限补投。
export function selectFires(job, fromIso, toIso) {
  const all = occurrencesBetween(job.trigger.rrule, fromIso, toIso, job.trigger.timezone ?? 'UTC');
  if (all.length <= 1) return all;
  const graceMin = job.misfireGraceMin ?? 720;
  const latenessMin = (Date.parse(toIso) - Date.parse(all[0])) / 60000;
  if (latenessMin <= graceMin) return all.slice(-1);
  if (job.misfirePolicy === 'skip') return [];
  if (job.misfirePolicy === 'catch_up') return all.slice(-3);
  return all.slice(-1); // run_once（默认）
}

export function createRecurring({ db, notifier, now = nowIso }) {
  function getJob(jobId) {
    const row = db.prepare('SELECT * FROM recurring_jobs WHERE jobId = ?').get(jobId);
    if (!row) return null;
    const job = JSON.parse(row.jobJson ?? '{}');
    return {
      ...job,
      jobVersion: row.jobVersion,
      status: row.status,
      lastCycleNo: row.lastCycleNo ?? job.lastCycleNo ?? 0,
      nextFireAt: row.nextFireAt ?? job.nextFireAt ?? null,
      lastFiredAt: row.lastFiredAt ?? null,
      consecutiveFailures: row.consecutiveFailures ?? 0,
    };
  }

  function saveJob(job, extra = {}) {
    db.prepare(`UPDATE recurring_jobs SET
      jobVersion = ?, status = ?, rrule = ?, timezone = ?, kind = ?,
      taskTemplateJson = ?, requiresHumanEachCycle = ?, lastCycleNo = ?,
      jobJson = ?, nextFireAt = ?, lastFiredAt = ?, consecutiveFailures = ?,
      misfirePolicy = ?, overlapPolicy = ?, dedupeWindowMin = ?, terminationJson = ?
      WHERE jobId = ?`).run(
      job.jobVersion, job.status, job.trigger?.rrule ?? null, job.trigger?.timezone ?? 'UTC',
      job.kind, JSON.stringify(job.taskTemplate ?? {}), job.requiresHumanEachCycle ? 1 : 0,
      job.lastCycleNo ?? 0, JSON.stringify(job), job.nextFireAt ?? null,
      extra.lastFiredAt ?? job.lastFiredAt ?? null, job.consecutiveFailures ?? 0,
      job.misfirePolicy ?? 'run_once', job.overlapPolicy ?? 'skip',
      job.dedupeWindowMin ?? 60, JSON.stringify(job.termination ?? {}), job.jobId,
    );
  }

  function registerJob(rawJob) {
    const checked = validate('recurring', rawJob);
    if (!checked.ok) throw new Error(`循环任务不合法：${checked.errors.join('; ')}`);
    const job = {
      misfireGraceMin: 720,
      lastCycleNo: 0,
      consecutiveFailures: 0,
      ...rawJob,
      status: rawJob.status ?? 'active',
    };
    job.nextFireAt = rawJob.nextFireAt
      ?? (job.trigger?.rrule
        ? nextFireAt(job.trigger.rrule, now(), job.trigger.timezone ?? 'UTC')
        : null); // event 型触发由外部写入，不吃 cron 时钟
    db.prepare(`INSERT OR REPLACE INTO recurring_jobs
      (jobId, jobVersion, kind, status, rrule, timezone, taskTemplateJson,
       requiresHumanEachCycle, lastCycleNo, jobJson, nextFireAt, lastFiredAt,
       consecutiveFailures, misfirePolicy, overlapPolicy, dedupeWindowMin, terminationJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(
      job.jobId, job.jobVersion, job.kind, job.status, job.trigger.rrule,
      job.trigger.timezone ?? 'UTC', JSON.stringify(job.taskTemplate),
      job.requiresHumanEachCycle ? 1 : 0, job.lastCycleNo, JSON.stringify(job),
      job.nextFireAt, job.consecutiveFailures, job.misfirePolicy ?? 'run_once',
      job.overlapPolicy ?? 'skip', job.dedupeWindowMin ?? 60,
      JSON.stringify(job.termination ?? {}),
    );
    writeAudit(db, { actor: 'scheduler', action: 'job_registered', newValue: job.jobId });
    return job;
  }

  function checkTermination(job, at) {
    const t = job.termination ?? {};
    if (t.validUntil && Date.parse(at) > Date.parse(t.validUntil)) return 'validUntil 到期';
    if (t.maxCycles && (job.lastCycleNo ?? 0) >= t.maxCycles) return 'maxCycles 触顶';
    if (t.budgetTotal?.quotaUnits) {
      const used = db.prepare(`SELECT COALESCE(SUM(quotaUnits), 0) AS n FROM runs
        WHERE taskId IN (SELECT taskId FROM cycles WHERE jobId = ?)`).get(job.jobId).n;
      if (used >= t.budgetTotal.quotaUnits) return 'budgetTotal 触顶';
    }
    if ((job.consecutiveFailures ?? 0) >= (t.pauseOnConsecutiveFailures ?? 3)) return '连续失败触顶';
    return null;
  }

  function pauseJob(jobId, reason) {
    db.prepare("UPDATE recurring_jobs SET status = 'paused' WHERE jobId = ?").run(jobId);
    writeAudit(db, { actor: 'scheduler', action: 'job_paused', newValue: `${jobId}:${reason}` });
    notifier.send({
      title: '循环任务已自动暂停',
      body: `${jobId}：${reason}。系统不会自动恢复，需人工 resume。`,
      scene: 'alert',
    });
    return { jobId, status: 'paused', reason };
  }

  function resumeJob(jobId) {
    db.prepare("UPDATE recurring_jobs SET status = 'active', consecutiveFailures = 0 WHERE jobId = ?").run(jobId);
    writeAudit(db, { actor: 'human', action: 'job_resumed', newValue: jobId });
    return { jobId, status: 'active' };
  }

  function latestSummary(jobId) {
    const row = db.prepare(`SELECT h.*, c.jobVersion, c.taskId, c.periodStart, c.periodEnd, c.status
      FROM cycle_history h JOIN cycles c ON c.jobId = h.jobId AND c.cycleNo = h.cycleNo
      WHERE h.jobId = ? ORDER BY h.cycleNo DESC LIMIT 1`).get(jobId);
    if (!row) return null;
    return {
      cycleNo: row.cycleNo, jobVersion: row.jobVersion, taskId: row.taskId,
      periodStart: row.periodStart, periodEnd: row.periodEnd, status: row.status,
      metrics: JSON.parse(row.metricsJson ?? '{}'),
      carryOver: JSON.parse(row.carryOverJson ?? '[]'),
      findings: JSON.parse(row.findingsJson ?? '[]'),
    };
  }

  function fire({ jobId, scheduledAt, now: atArg }) {
    const at = atArg ?? now();
    const triggerAt = scheduledAt ?? at;
    const job = getJob(jobId);
    if (!job) return { skipped: true, reason: '循环任务不存在' };
    if (job.status !== 'active') return { skipped: true, reason: `job 状态 ${job.status}，不再实例化` };

    const term = checkTermination(job, at);
    if (term) return { skipped: true, paused: true, ...pauseJob(jobId, term) };

    const latenessMin = (Date.parse(at) - Date.parse(triggerAt)) / 60000;
    if (latenessMin > (job.misfireGraceMin ?? 720)) {
      if (job.misfirePolicy === 'skip') {
        writeAudit(db, { actor: 'scheduler', action: 'misfire_skip', newValue: `${jobId}:${triggerAt}` });
        return { skipped: true, reason: 'misfire=skip' };
      }
      writeAudit(db, {
        actor: 'scheduler', action: 'misfire_recover',
        newValue: `${jobId}:迟到 ${Math.round(latenessMin)} 分钟`,
      });
    }

    // 以 cycles 自己收账的状态为准，不依赖任务卡有没有被 bridge 领过（§6A.2）。
    // done / failed / cancelled / skipped 都是「已收账」终态；失败轮次也不该堵住下一轮。
    const activeCycle = db.prepare(`SELECT cycleNo FROM cycles
      WHERE jobId = ? AND status NOT IN ('done', 'failed', 'cancelled', 'skipped')
      ORDER BY cycleNo DESC LIMIT 1`).get(jobId);
    if (activeCycle) {
      if (job.overlapPolicy === 'skip' || job.overlapPolicy === 'queue') {
        writeAudit(db, {
          actor: 'scheduler',
          action: job.overlapPolicy === 'skip' ? 'overlap_skip' : 'overlap_queue',
          newValue: `${jobId}:第 ${activeCycle.cycleNo} 轮未完成`,
        });
        return {
          skipped: job.overlapPolicy === 'skip', queued: job.overlapPolicy === 'queue',
          reason: `overlap=${job.overlapPolicy}`, activeCycleNo: activeCycle.cycleNo,
        };
      }
      // parallel：纯只读巡检才允许，继续建卡
    }

    const key = minuteKey(triggerAt);
    const existing = db.prepare('SELECT taskId FROM cycle_fires WHERE jobId = ? AND scheduledKey = ?')
      .get(jobId, key);
    if (existing) {
      return { skipped: true, reason: '同一触发点已建卡（cron 与补偿扫描双触发只 1 张）', taskId: existing.taskId };
    }
    const recent = db.prepare(`SELECT scheduledKey, createdAt FROM cycle_fires
      WHERE jobId = ? ORDER BY createdAt DESC LIMIT 1`).get(jobId);
    if (recent && recent.scheduledKey !== key
      && Date.parse(at) - Date.parse(recent.createdAt) < (job.dedupeWindowMin ?? 60) * 60000) {
      return { skipped: true, reason: `dedupeWindowMin=${job.dedupeWindowMin ?? 60} 窗口内已有触发` };
    }

    const prev = latestSummary(jobId);
    const cycleNo = (job.lastCycleNo ?? 0) + 1;
    const carryOverItems = job.carryOver?.enabled ? (prev?.carryOver ?? []) : [];
    const taskId = `T-CYCLE-${shortId()}`;
    const card = {
      schema: 'aicompany.task/v1', taskId,
      requestId: `REQ-CYCLE-${jobId}-${cycleNo}`,
      parentTaskId: null,
      title: `${job.title} · 第 ${cycleNo} 轮`,
      role: job.taskTemplate.role, revision: 1,
      mode: 'delegate', addressedTo: null, cc: [],
      assignedBy: 'policy', threadId: null,
      assignee: job.assignee, reportsTo: job.reportsTo ?? null,
      status: 'todo', priority: 'normal', difficulty: job.taskTemplate.difficulty ?? 'normal', createdAt: at, lease: null,
      budget: job.budgetPerCycle ?? { maxRuns: 2 },
      input: {
        files: [],
        previousFindings: carryOverItems,
        baseline: prev?.metrics ?? null,
      },
      instructions: job.taskTemplate.instructions,
      acceptance: job.taskTemplate.acceptance,
      completionReportPath: job.taskTemplate.completionReportPath ?? 'output/completion.json',
      retry: { attempt: 0, max: 2, backoffSec: 0 },
      tags: ['cycle'],
      origin: {
        jobId, cycleNo, jobVersion: job.jobVersion,
        periodStart: prev?.periodEnd ?? triggerAt, periodEnd: triggerAt,
      },
    };
    const checked = validate('task', card);
    if (!checked.ok) throw new Error(`循环任务卡不合法：${checked.errors.join('; ')}`);

    db.prepare(`INSERT INTO tasks
      (taskId, requestId, parentTaskId, title, role, assignee, status, mode, addressedTo,
       assignedBy, revision, threadId, attempt, priority, difficulty, createdAt, updatedAt, originJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
      card.taskId, card.requestId, card.parentTaskId, card.title, card.role,
      card.assignee, card.status, card.mode, card.addressedTo, card.assignedBy,
      card.revision, card.threadId, card.priority, card.difficulty,
      card.createdAt, card.createdAt, JSON.stringify(card.origin),
    );
    db.prepare(`INSERT INTO task_payload
      (taskId, revision, instructions, acceptanceJson, completionReportPath, inputJson)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      card.taskId, card.revision, card.instructions, JSON.stringify(card.acceptance),
      card.completionReportPath, JSON.stringify(card.input),
    );
    db.prepare('INSERT INTO cycle_fires (jobId, scheduledKey, taskId, createdAt) VALUES (?, ?, ?, ?)')
      .run(jobId, key, taskId, at);
    db.prepare(`INSERT INTO cycles
      (jobId, cycleNo, jobVersion, taskId, periodStart, periodEnd, status, summaryPath)
      VALUES (?, ?, ?, ?, ?, ?, 'todo', NULL)`).run(
      jobId, cycleNo, job.jobVersion, taskId,
      card.origin.periodStart, card.origin.periodEnd,
    );
    emit(db, {
      type: 'issue_assigned', taskId, agentId: job.assignee,
      payload: { wakeReason: 'cycle', jobId, cycleNo },
      dedupeKey: `cycle:${taskId}:1`,
    });
    writeAudit(db, { actor: 'scheduler', action: 'cycle_instantiated', newValue: `${jobId}#${cycleNo}:${taskId}` });

    job.lastCycleNo = cycleNo;
    job.lastFiredAt = at;
    // event 型触发没有 rrule，不吃 cron 时钟；否则 nextFireAt(null) 会退化成「每天」误触发。
    job.nextFireAt = job.trigger?.rrule
      ? nextFireAt(job.trigger.rrule, at, job.trigger.timezone ?? 'UTC')
      : null;
    saveJob(job, { lastFiredAt: at });
    return {
      created: true, taskId, cycleNo, jobVersion: job.jobVersion,
      previousFindings: carryOverItems, periodStart: card.origin.periodStart,
    };
  }

  function completeCycle({ jobId, cycleNo, status = 'done', metrics = {}, findings = [], runIds = [], derivedTasks = [] }) {
    const cycle = db.prepare('SELECT * FROM cycles WHERE jobId = ? AND cycleNo = ?').get(jobId, cycleNo);
    if (!cycle) throw new Error(`轮次不存在：${jobId}#${cycleNo}`);
    const job = getJob(jobId);
    const prev = db.prepare('SELECT * FROM cycle_history WHERE jobId = ? AND cycleNo = ?')
      .get(jobId, cycleNo - 1);
    const prevMetrics = prev ? JSON.parse(prev.metricsJson ?? '{}') : {};
    // deltaVsPrev 只能由控制面算，不许 agent 自己填（§6A.4）。
    const deltaVsPrev = {};
    for (const [name, value] of Object.entries(metrics)) {
      if (typeof value === 'number' && typeof prevMetrics[name] === 'number') {
        deltaVsPrev[name] = value - prevMetrics[name];
      }
    }
    // 未解决的问题跨轮累计「挂了几轮」，不能每轮都从 0 重新数（§6A.4 跨轮记忆）。
    const prevCarry = prev ? JSON.parse(prev.carryOverJson ?? '[]') : [];
    const ageById = new Map(prevCarry.map((item) => [item.id, item.ageCycles ?? 0]));
    const carryOver = findings
      .filter((f) => f.state !== 'resolved')
      .map((f) => ({
        id: f.id, text: f.text,
        ageCycles: (ageById.get(f.id) ?? f.ageCycles ?? 0) + 1,
      }));
    const summary = {
      schema: 'aicompany.cycle-summary/v1',
      jobId, jobVersion: cycle.jobVersion, cycleNo,
      periodStart: cycle.periodStart, periodEnd: cycle.periodEnd,
      taskId: cycle.taskId, status,
      metrics, deltaVsPrev, findings, carryOver, derivedTasks,
      humanDecision: null, runIds, transcriptPath: null,
    };
    const checked = validate('cycle-summary', summary);
    if (!checked.ok) throw new Error(`轮次摘要不合法：${checked.errors.join('; ')}`);
    db.prepare(`INSERT OR REPLACE INTO cycle_history
      (jobId, cycleNo, metricsJson, deltaJson, findingsJson, carryOverJson,
       derivedTasksJson, humanDecision, runIds)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
      jobId, cycleNo, JSON.stringify(metrics), JSON.stringify(deltaVsPrev),
      JSON.stringify(findings), JSON.stringify(carryOver),
      JSON.stringify(derivedTasks), JSON.stringify(runIds),
    );
    db.prepare('UPDATE cycles SET status = ?, summaryPath = ? WHERE jobId = ? AND cycleNo = ?')
      .run(status, `cycles/${jobId}/${cycleNo}.json`, jobId, cycleNo);
    // 收账时把本轮任务卡一起收口，避免留下永远 todo 的孤儿卡。
    const taskRow = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(cycle.taskId);
    if (taskRow && !['done', 'cancelled'].includes(taskRow.status)) {
      const terminal = status === 'failed' ? 'blocked' : (status === 'done' ? 'done' : taskRow.status);
      if (terminal !== taskRow.status) {
        db.prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE taskId = ?')
          .run(terminal, now(), cycle.taskId);
        writeAudit(db, {
          actor: 'scheduler', action: 'cycle_task_closed',
          oldValue: taskRow.status, newValue: terminal,
        });
      }
    }

    const failed = status === 'failed';
    const consecutive = failed ? (job.consecutiveFailures ?? 0) + 1 : 0;
    job.consecutiveFailures = consecutive;
    saveJob(job);
    writeAudit(db, { actor: 'scheduler', action: 'cycle_closed', newValue: `${jobId}#${cycleNo}:${status}` });
    if (consecutive >= (job.termination?.pauseOnConsecutiveFailures ?? 3)) {
      pauseJob(jobId, `连续 ${consecutive} 轮失败`);
      summary.autoPaused = true;
    }
    return summary;
  }

  // 每个 tick 只处理到点的 job；漏跑补几轮由 selectFires 决定（§6A.6）。
  function tick({ now: atArg } = {}) {
    const at = atArg ?? now();
    const results = [];
    const rows = db.prepare("SELECT jobId FROM recurring_jobs WHERE status = 'active'").all();
    for (const row of rows) {
      const job = getJob(row.jobId);
      if (!job?.nextFireAt || Date.parse(job.nextFireAt) > Date.parse(at)) continue;
      const from = job.lastFiredAt ?? job.nextFireAt;
      for (const scheduledAt of selectFires(job, from, at)) {
        const result = fire({ jobId: job.jobId, scheduledAt, now: at });
        results.push({ jobId: job.jobId, scheduledAt, ...result });
      }
      const fresh = getJob(job.jobId);
      if (!results.some((r) => r.jobId === job.jobId && r.queued)) {
        fresh.nextFireAt = job.trigger?.rrule
          ? nextFireAt(job.trigger.rrule, at, job.trigger.timezone ?? 'UTC')
          : null;
        fresh.lastFiredAt = at;
        saveJob(fresh, { lastFiredAt: at });
      }
    }
    return { at, fired: results.length, results };
  }

  // P4-9 循环 L3：改模板 / 频率必须走人审；批准后只影响「新轮次」，旧轮次原样保留。
  function applyRevision(jobId, patch = {}, { approvedBy = 'human' } = {}) {
    const job = getJob(jobId);
    if (!job) throw new Error(`循环任务不存在：${jobId}`);
    const props = loadSchema('recurring')?.properties ?? {};
    const unknown = Object.keys(patch).filter((key) => !(key in props));
    if (unknown.length) {
      // 补丁里写了协议没有的字段：多半是拼错了，静默丢弃等于「假装改成功」。
      throw new Error(`改版补丁含未知字段：${unknown.join(', ')}；可用字段见 protocol/recurring.schema.json`);
    }
    const next = {
      ...job,
      ...patch,
      jobId,
      jobVersion: (job.jobVersion ?? 1) + 1,
    };
    // 只拿协议里定义的字段去校验：运行时状态（lastFiredAt / consecutiveFailures / nextFireAt）
    // 本来就不在协议里，混进校验会被 additionalProperties 判成「多余字段」。
    const checked = validate('recurring', schemaOnly('recurring', next));
    if (!checked.ok) throw new Error(`改版后的循环任务不合法：${checked.errors.join('; ')}`);
    next.nextFireAt = next.trigger?.type === 'cron' && next.trigger?.rrule
      ? nextFireAt(next.trigger.rrule, now(), next.trigger.timezone ?? 'UTC')
      : null;
    saveJob(next);
    writeAudit(db, {
      actor: approvedBy, action: 'job_revised',
      oldValue: `${jobId}:v${job.jobVersion}`, newValue: `${jobId}:v${next.jobVersion}`,
    });
    return {
      jobId, jobVersion: next.jobVersion, applied: true,
      nextFireAt: next.nextFireAt, note: '只影响新轮次，历史 CycleHistory 不动',
    };
  }

  return {
    registerJob, getJob, saveJob, fire, tick, completeCycle,
    pauseJob, resumeJob, latestSummary, selectFires, applyRevision,
    listJobs: () => db.prepare('SELECT * FROM recurring_jobs ORDER BY jobId').all().map((r) => getJob(r.jobId)),
    listCycles: (jobId) => db.prepare('SELECT * FROM cycles WHERE jobId = ? ORDER BY cycleNo').all(jobId),
    listHistory: (jobId) => db.prepare('SELECT * FROM cycle_history WHERE jobId = ? ORDER BY cycleNo').all(jobId),
  };
}
