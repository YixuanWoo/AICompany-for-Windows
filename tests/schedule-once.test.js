// 自主一次性定时：CEO 写 at 而不是 rrule 时，走「排班建议 → 董事会审批 → 注册 → 跑完自动结束」这条既有通道。
// 覆盖三件事：
//   ① at 建议出的是「只跑一次」审批单（payload.oneShot，人话写成「只跑一次 · 时间」）；
//   ② 没批之前不进调度器，批了才真注册（maxCycles=1、overlap=queue）；
//   ③ 跑完这一轮当场收工（status=ended），不会挂成「active · 下次明天」骗董事会。

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createRecurring } from '../src/recurring.js';

function cfg(workRoot, result) {
  return {
    version: 1,
    company: { name: 'schedule-once', timezone: 'Asia/Shanghai' },
    workRoot,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active',
        quotaDaily: 50, reportsTo: null,
        adapter: { type: 'mock', config: { result } },
      },
      {
        id: 'worker-01', displayName: '执行席', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { result: { type: 'decision', verdict: 'done' } } },
      },
    ],
  };
}

const onceResult = {
  type: 'task-create',
  summary: '第 12 期视频发完了，明天复盘这一期数据',
  recurringSuggestion: {
    title: '复盘第 12 期视频',
    at: '2026-11-18 21:30',
    assignee: 'worker-01',
    kind: 'brief',
    instructions: '拉这一期的完播率、评论关键词、涨粉数，出一份复盘',
    acceptance: ['复盘文件落在 output/', '说清下一期要改的三件事'],
    reviewBy: 'ceo',
    reason: '只做一次，但要等数据积一天',
  },
  tasks: [],
};

test('CEO 用 at 提一次性定时：出「只跑一次」审批单，批了才注册', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const engine = createEngine({ db, config: cfg(process.cwd(), () => onceResult), notifier: createNotifier('noop') });
  const rec = createRecurring({ db, notifier: createNotifier('noop') });
  engine.setApprovalHandler('recurring_create', (p) => {
    const out = rec.registerJob(p.job);
    return { jobId: out.jobId, nextFireAt: out.nextFireAt };
  });

  await engine.submit({ text: '这期视频做完了，明天复盘一下', mode: 'delegate' });

  const ap = db.prepare("SELECT approvalId, requestJson FROM approvals WHERE kind = 'recurring_create'").get();
  assert.ok(ap, '一次性定时也要走审批，CEO 不许自己排');
  const payload = JSON.parse(ap.requestJson).payload;
  assert.equal(payload.oneShot, true, '审批单要标出这是一次性的');
  assert.match(payload.rruleText, /只跑一次/, '董事会看到的是「只跑一次」，不是「每天 21:30」');
  assert.equal(payload.job.termination.maxCycles, 1);
  assert.equal(payload.job.overlapPolicy, 'queue', '到点若还在忙，排队等而不是跳过');
  assert.match(payload.job.trigger.rrule, /BYHOUR=21;BYMINUTE=30/);
  assert.equal(payload.job.nextFireAt, '2026-11-18T21:30:00+08:00', '指定了日期就钉在那一天');
  assert.equal(payload.job.assignee, 'worker-01');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recurring_jobs').get().n, 0, '没点通过不许进调度器');

  const decided = engine.decideApproval(ap.approvalId, { decision: 'approved', decidedBy: 'board' });
  assert.equal(decided.applied, true, decided.error ?? '');
  const job = rec.getJob(payload.job.jobId);
  assert.equal(job.status, 'active');
  assert.equal(job.termination.maxCycles, 1);
});

test('一次性定时跑完这一轮就收工：status=ended，不再挂「下次明天」', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const rec = createRecurring({ db, notifier: createNotifier('noop') });
  const job = rec.registerJob({
    schema: 'aicompany.recurring/v1',
    jobId: 'SCH-once-test', jobVersion: 1,
    title: '复盘第 12 期视频', kind: 'brief', owner: 'ceo', assignee: 'worker-01',
    project: null, reportsTo: 'ceo', reviewBy: 'ceo', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=DAILY;BYHOUR=21;BYMINUTE=30', timezone: 'Asia/Shanghai' },
    misfirePolicy: 'run_once', misfireGraceMin: 720, overlapPolicy: 'queue',
    termination: { validUntil: null, maxCycles: 1, pauseOnConsecutiveFailures: 1 },
    requiresHumanEachCycle: false,
    taskTemplate: {
      role: 'general', instructions: '出一份复盘',
      acceptance: ['复盘文件落在 output/'], completionReportPath: 'output/completion.json',
    },
    carryOver: { enabled: false }, dedupeWindowMin: 30, lastCycleNo: 0,
    nextFireAt: '2026-11-18T21:30:00+08:00',
  });

  const fired = rec.fire({ jobId: job.jobId, scheduledAt: '2026-11-18T21:30:00+08:00', now: '2026-11-18T21:30:00+08:00' });
  assert.equal(fired.created, true, fired.reason ?? '');
  assert.equal(fired.cycleNo, 1);

  const after = rec.getJob(job.jobId);
  assert.equal(after.status, 'ended', '只跑一次的任务跑完就该收工');
  assert.equal(after.nextFireAt, null, '不能再报一个「下次明天」的假计划');
  const again = rec.fire({ jobId: job.jobId, now: '2026-11-19T21:30:00+08:00' });
  assert.equal(again.skipped, true, '第二天不能再触发第二次');
});

test('既没 rrule 也没 at 的排班建议被打回（不是静默丢弃），且错误提示指向 at', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const bad = {
    type: 'task-create', summary: '提一条没写节奏的排班',
    recurringSuggestion: {
      title: '没节奏', assignee: 'worker-01',
      instructions: '干点什么', acceptance: ['非空'],
    },
    tasks: [],
  };
  const engine = createEngine({ db, config: cfg(process.cwd(), () => bad), notifier: createNotifier('noop') });
  const sub = await engine.submit({ text: '随便排一条', mode: 'delegate' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'recurring_create'").get().n, 0,
    '不合协议的建议不许变成审批单');
  // 2026-11-18：拒绝不再是「写条审计然后继续」，而是打回 + 回执 + 重投。
  const audit = db.prepare("SELECT newValue FROM audit WHERE action = 'rule_violation'").get();
  assert.ok(audit, '被打回的建议要留审计，不能静默吞掉');
  assert.match(audit.newValue, /一次性定时请写 at/);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'rule_retry'").get(),
    '打回后要重新唤醒 CEO，并把原因带进下一轮');
  assert.notEqual(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(sub.taskId).status, 'done',
    '什么都没落地的一轮不许标「完成」');
});
