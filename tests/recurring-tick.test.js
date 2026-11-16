// 循环任务「到点触发」的回归测试 —— 2026-11-16 20:30 事故。
//
// 事故：yitai 周体检（FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=30，Asia/Shanghai）
// 在 20:30:08 被 tick 处理，`lastFiredAt` 写进去了、`nextFireAt` 前进到下周，
// 但 0 张卡、0 条审计、0 条 cycles —— 一声不响地跳过了第一次触发。
//
// 根因：occurrencesBetween 是左开区间（candidate > from），而 tick 首次触发时
// from = lastFiredAt ?? nextFireAt，正好等于触发点本身 → 触发点被自己排除。
//
// 为什么 310 条测试没抓到：tick 的用例只有一个，用的是 HOURLY、且 to 恰好落在整点，
// 于是它触发的是「下一个整点」凑巧 fired=1，把 bug 盖住了。真机是 WEEKLY，没有下个整点兜底。
//
// 本文件专门守「走 tick 的首次触发」，不再直接调 fire()。

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core.js';
import { createNotifier } from '../src/engine.js';
import { createRecurring } from '../src/recurring.js';
import { createScheduler } from '../src/scheduler.js';

const FAR = '2099-01-01T00:00:00.000Z';

function makeJob(overrides = {}) {
  return {
    schema: 'aicompany.recurring/v1',
    jobId: 'JOB-tick', jobVersion: 1,
    title: '每周体检', kind: 'inspection',
    owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=30', timezone: 'Asia/Shanghai' },
    misfirePolicy: 'run_once', misfireGraceMin: 720,
    overlapPolicy: 'skip',
    // 协议要求必须有终止条件（validUntil / maxCycles / budgetTotal 至少一个）。
    termination: { validUntil: '2027-11-16T00:00:00.000Z', maxCycles: null, pauseOnConsecutiveFailures: 3 },
    requiresHumanEachCycle: false,
    taskTemplate: {
      role: 'execute', instructions: '按计划体检并写出完成报告。',
      acceptance: ['completion.json 通过 schema 校验'],
      completionReportPath: 'output/completion.json',
    },
    dedupeWindowMin: 60,
    project: null,
    nextFireAt: FAR,
    ...overrides,
  };
}

function makeRecurring() {
  const db = openDb(':memory:');
  const rec = createRecurring({ db, notifier: createNotifier('web'), now: () => FAR });
  return { db, rec };
}

const audits = (db) => db.prepare('SELECT action, newValue FROM audit ORDER BY rowid').all();
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// 真机那一刻：nextFireAt = 2026-11-16T12:30:00Z（北京时间 20:30），tick 在 12:30:08。
// 只晚 8 秒 —— 区间 (12:30:00, 12:30:08] 里如果起点算错就一个点都没有。
const DUE = '2026-11-16T12:30:00.000Z';
const TICK_AT = '2026-11-16T12:30:08.652Z';

test('RT-1 · 首次触发（lastFiredAt 为空）：到点必须建卡，不能被左开区间吃掉', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-FIRST', nextFireAt: DUE }));
  const sched = createScheduler({ recurring: rec, now: () => TICK_AT });

  const out = sched.runOnce({ now: TICK_AT });

  assert.equal(out.fired, 1, '到点了就必须触发一次，这是第一次触发，不该被跳过');
  assert.equal(count(db, 'cycles'), 1, '要有 cycle 记账');
  assert.equal(count(db, 'tasks'), 1, '要真建出轮次卡');

  const cycle = db.prepare('SELECT * FROM cycles').get();
  assert.equal(cycle.cycleNo, 1);
  assert.equal(cycle.periodEnd, DUE, '周期结束点应等于此刻的触发点');

  const card = db.prepare('SELECT * FROM tasks').get();
  assert.match(card.title, /第 1 轮/);
  assert.equal(card.status, 'todo');

  assert.ok(
    audits(db).some((a) => a.action === 'cycle_instantiated'),
    '必须留一条 cycle_instantiated：没卡的触发至少让人能从审计里看见',
  );
  assert.equal(rec.getJob('JOB-FIRST').nextFireAt, '2026-11-23T12:30:00.000Z', '下次应是下周一同一时刻');
  db.close();
});

test('RT-2 · 第二个周期照样能触发（from 不能粘在 lastFiredAt 上漏掉下一次）', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-TWICE', nextFireAt: DUE }));
  const sched = createScheduler({ recurring: rec, now: () => TICK_AT });

  sched.runOnce({ now: TICK_AT });
  assert.equal(count(db, 'tasks'), 1);

  // 第一轮跑完了（结案），否则会被 overlapPolicy=skip 正确挡住 —— 这里验的是 from 的推进，不是 overlap。
  db.prepare("UPDATE cycles SET status = 'done'").run();
  db.prepare("UPDATE tasks SET status = 'done'").run();

  // 一周后的同一时刻，tick 又晚 8 秒
  const nextWeek = '2026-11-23T12:30:08.652Z';
  sched.runOnce({ now: nextWeek });
  assert.equal(count(db, 'tasks'), 2, '第二轮也要建卡');
  assert.equal(count(db, 'cycles'), 2);
  assert.equal(rec.getJob('JOB-TWICE').lastCycleNo, 2);
  db.close();
});

test('RT-3 · 没到点：不建卡、不留下「算不出触发点」的审计', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-EARLY', nextFireAt: DUE }));
  const sched = createScheduler({ recurring: rec, now: () => TICK_AT });

  const early = sched.runOnce({ now: '2026-11-16T12:20:00.000Z' });
  assert.equal(early.fired, 0);
  assert.equal(count(db, 'tasks'), 0);
  assert.equal(audits(db).filter((a) => a.action === 'job_due_no_occurrence').length, 0);
  db.close();
});

test('RT-4 · 真到点却算不出触发点：必须留痕，不许静默推进', () => {
  const { db, rec } = makeRecurring();
  // BYMONTHDAY=31 + 只有 30 天的月份，这一周期本来就无触发点：区间算空是「合法」的。
  rec.registerJob(makeJob({
    jobId: 'JOB-GHOST',
    trigger: { type: 'cron', rrule: 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=10;BYMINUTE=0', timezone: 'UTC' },
    nextFireAt: '2026-04-15T00:00:00.000Z',
  }));
  const sched = createScheduler({ recurring: rec, now: () => FAR });
  sched.runOnce({ now: '2026-04-15T00:00:10.000Z' });

  // 4 月没有 31 号 → selectFires 为空。这类「算不出来」以前一声不响，现在必须有审计。
  // （若某天 rrule 实现补上了月末折叠，这里会变成建卡，届时这条断言要跟着改。）
  const ghost = audits(db).filter((a) => a.action === 'job_due_no_occurrence');
  if (ghost.length === 0) {
    assert.equal(count(db, 'tasks'), 1, '算得出就建卡，也算合理');
  } else {
    assert.match(ghost[0].newValue, /JOB-GHOST/);
  }
  db.close();
});

test('RT-5 · 生产配置原样复刻：周一 20:30 到点那一刻进来的 tick 必须建卡', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-yitai-每周体检', project: 'yitai', assignee: 'doubao' }));
  const job = rec.getJob('JOB-yitai-每周体检');
  // 注册时算出的 nextFireAt 应落在未来；这里直接把它挪到「刚过」的那一刻，模拟 20:30:08 的 tick。
  db.prepare('UPDATE recurring_jobs SET nextFireAt = ? WHERE jobId = ?').run(DUE, 'JOB-yitai-每周体检');
  assert.equal(rec.getJob('JOB-yitai-每周体检').nextFireAt, DUE);
  assert.ok(job, 'job 要能注册成功');

  const sched = createScheduler({ recurring: rec, now: () => TICK_AT });
  assert.equal(sched.runOnce({ now: TICK_AT }).fired, 1);

  const card = db.prepare('SELECT * FROM tasks').get();
  assert.equal(card.project, 'yitai', '循环卡必须带项目归属');
  assert.equal(card.assignee, 'doubao');
  assert.equal(card.mode, 'delegate');
  db.close();
});

test('RT-6 · cron 型：卡跑完必须收账，否则下一轮会被自己的上一轮挡住', () => {
  const { db, rec } = makeRecurring();
  rec.registerJob(makeJob({ jobId: 'JOB-CLOSE', nextFireAt: DUE, overlapPolicy: 'skip' }));
  const sched = createScheduler({ recurring: rec, now: () => TICK_AT });
  sched.runOnce({ now: TICK_AT });

  const card = db.prepare('SELECT taskId FROM tasks').get();
  assert.equal(db.prepare('SELECT status FROM cycles').get().status, 'todo', '刚建卡时这一轮还没收账');

  // 卡跑完（delegate 模式下 CEO 验收过 → done）→ 引擎回调
  rec.onTaskTerminal({ taskId: card.taskId, status: 'done', runId: 'R-close', now: TICK_AT });
  assert.equal(db.prepare('SELECT status FROM cycles').get().status, 'done', '卡终态了，这一轮就必须收账');
  assert.ok(
    audits(db).some((a) => a.action === 'completion_cycle_closed'),
    '收账要留审计，否则「这轮到底算不算完」只能靠猜',
  );

  // 一周后：上一轮已收账，不能被 overlapPolicy=skip 当成「还没完」挡掉
  const next = sched.runOnce({ now: '2026-11-23T12:30:08.652Z' });
  assert.equal(next.fired, 1, '上一轮已收账，这一轮必须能跑');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycles').get().n, 2);
  db.close();
});
