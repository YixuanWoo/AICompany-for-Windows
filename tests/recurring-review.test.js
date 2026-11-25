// 循环任务的审计人：日常活交工程岗，方向性才回到总经理。
//
// 背景（2026-11-16 董事会定）：循环任务是「日常活」，审的是有没有照做、数字对不对，
// 不是方向。原来每一轮都请总经理验收 → 每周/每月白烧一次按量计费的 CEO Run，
// 而 CEO 看完也只能说一句「知道了」。现在：
//   1) 排班时就定死「每轮谁审」，写进 job 与每一轮的卡；
//   2) 默认 = 工程岗（配置 routineReviewer → defaultReviewer → 第一个带 review 能力的席位）；
//   3) 只有方向性长期任务，CEO 才在自己提的建议里写 reviewBy: ceo / human。
// 还要守两条边界：不能让自己审自己；卡上写死了审查人，执行人不能自报 land 把它绕过去。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createRecurring } from '../src/recurring.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-cycle-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const suggestion = (over = {}) => ({
  title: 'demo-editor 每周体检',
  rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=30',
  timezone: 'Asia/Shanghai',
  assignee: 'doubao',
  kind: 'inspection',
  instructions: '按维护计划体检一遍，写出本轮数字。',
  acceptance: ['两个数字都要写出来'],
  reason: '长期重复',
  ...over,
});

function company(root, { tasks = null, cycle = null, report = {} } = {}) {
  return {
    version: 1,
    company: { name: 'cycle-review', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    artifacts: {
      defaultReviewer: 'engineering',
      routineReviewer: 'engineering',
      defaultHandoff: 'byAssigner',
    },
    agents: [
      {
        id: 'ceo', postTitle: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active',
        quotaDaily: 99, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: () => ({
              type: 'task-create', summary: '只排班不派卡',
              tasks: tasks ?? [],
              recurringSuggestion: cycle ?? undefined,
            }),
          },
        },
      },
      {
        id: 'doubao', postTitle: '执行', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 99, reportsTo: 'engineering',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, 'ok', 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'doubao',
                revision: ctx.task.revision, status: 'success',
                summary: '体检完成', artifacts: ['output/note.md'],
                checksum: { 'output/note.md': sha256File(file) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1 },
                ...report,
                finishedAt: new Date().toISOString(),
              };
            },
          },
        },
      },
      {
        id: 'engineering', postTitle: '工程执行', isCEO: false,
        capabilities: ['execute', 'review', 'delegate', 'plan'], status: 'active',
        quotaDaily: 99, reportsTo: 'ceo', escalationTo: 'ceo', dispatch: 'pull',
        adapter: { type: 'mock', config: { result: { type: 'review', verdict: 'pass' } } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

function setup(t, opts = {}) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: company(root, opts), notifier: createNotifier('noop') });
  const rec = createRecurring({ db, notifier: createNotifier('noop'), now: () => '2099-01-01T00:00:00.000Z' });
  engine.setTaskTerminalHook?.((payload) => rec.onTaskTerminal(payload));
  t.after(() => db.close());
  return { root, db, engine, rec };
}

const pumpAll = async (engine) => { for (let i = 0; i < 8; i += 1) await engine.pump(); };

function makeJob(over = {}) {
  return {
    schema: 'aicompany.recurring/v1',
    jobId: 'JOB-weekly', jobVersion: 1,
    title: 'demo-editor 每周体检', kind: 'inspection',
    owner: 'ceo', assignee: 'doubao', reportsTo: 'engineering', status: 'active',
    trigger: { type: 'cron', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=30', timezone: 'Asia/Shanghai' },
    misfirePolicy: 'run_once', misfireGraceMin: 720, overlapPolicy: 'skip',
    termination: { validUntil: '2100-01-01T00:00:00.000Z', maxCycles: null, pauseOnConsecutiveFailures: 3 },
    requiresHumanEachCycle: false,
    taskTemplate: {
      role: 'execute', instructions: '按计划体检。',
      acceptance: ['completion.json 通过校验'], completionReportPath: 'output/completion.json',
    },
    dedupeWindowMin: 60, project: null, nextFireAt: '2099-01-01T00:00:00.000Z',
    ...over,
  };
}

test('CR-1 · 循环卡把审查人写在卡上：跑完停 engineering 的待审队列，不叫 CEO', async (t) => {
  const { db, rec, engine } = setup(t);
  rec.registerJob(makeJob({ reviewBy: 'engineering', reviewNote: '日常体检，工程岗看数' }));
  const fired = rec.fire({ jobId: 'JOB-weekly', scheduledAt: '2099-01-01T00:00:00.000Z' });
  assert.ok(fired.created, '到点要建卡');

  const card = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(fired.taskId);
  assert.equal(card.reviewBy, 'engineering');
  assert.equal(card.handoff, 'review', '写死审查人就等于写死了「必须审」，不按发布者推成落盘');

  await pumpAll(engine);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(fired.taskId).status, 'in_review');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'review_queued' AND taskId = ?").get(fired.taskId),
    '审查人是拉模式席位时卡要排队等它来审');
  const ceoReviews = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = 'ceo' AND wakeReason = 'review_requested'").get().n;
  assert.equal(ceoReviews, 0, '日常循环不该每轮烧一次总经理的额度');

  // 提醒一句：这一轮不收账，下一轮会被 overlap=skip 挡掉，董事会得知道。
  const notice = db.prepare("SELECT * FROM board_messages WHERE kind = 'notice' AND taskId = ?").get(fired.taskId);
  assert.ok(notice, '卡在「人叫才醒」的席位手上时，必须给董事会留一句话');
  assert.match(notice.body, /工程执行|engineering/);

  engine.reviewTask(fired.taskId, { reviewer: 'engineering', verdict: 'pass', reason: '数字对得上' });
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(fired.taskId).status, 'done');
  assert.equal(db.prepare('SELECT status FROM cycles WHERE jobId = ?').get('JOB-weekly').status, 'done',
    '审过才收账，下一轮才不会被自己挡住');
});

test('CR-2 · 老 job 没写 reviewBy：照旧能建卡，不炸、也不硬塞审查人', (t) => {
  const { db, rec } = setup(t);
  rec.registerJob(makeJob({ jobId: 'JOB-legacy' }));
  const fired = rec.fire({ jobId: 'JOB-legacy', scheduledAt: '2099-01-01T00:00:00.000Z' });
  assert.ok(fired.created, '没有 reviewBy 的老排班必须继续能跑（向后兼容）');
  const card = db.prepare('SELECT reviewBy, handoff FROM tasks WHERE taskId = ?').get(fired.taskId);
  assert.equal(card.reviewBy, null);
  assert.equal(card.handoff, null);
});

test('CR-3 · CEO 提排班不写 reviewBy：默认工程岗，并在审批单上写清是谁审', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion() });
  await engine.submit({ text: '给 demo-editor 定运行节奏，只排班不派卡' });
  await pumpAll(engine);

  const ap = db.prepare("SELECT * FROM approvals WHERE kind = 'recurring_create' AND status = 'pending'").get();
  assert.ok(ap, '排班建议要变成审批单');
  const request = JSON.parse(ap.requestJson);
  assert.equal(request.payload.job.reviewBy, 'engineering', '日常巡检默认交工程岗');
  assert.match(request.body, /每轮谁来审/, '审批卡要让董事会一眼看到谁审');
});

test('CR-4 · 方向性长期任务：CEO 可以写 reviewBy: ceo，系统照办', async (t) => {
  const { db, engine } = setup(t, {
    cycle: suggestion({ title: '季度方向复盘', reviewBy: 'ceo', reviewNote: '会改项目走向，必须我看' }),
  });
  await engine.submit({ text: '排一个季度方向复盘' });
  await pumpAll(engine);
  const ap = db.prepare("SELECT * FROM approvals WHERE kind = 'recurring_create' AND status = 'pending'").get();
  const job = JSON.parse(ap.requestJson).payload.job;
  assert.equal(job.reviewBy, 'ceo');
  assert.match(job.reviewNote, /项目走向/);
});

test('CR-5 · reviewBy 写成执行人自己：不再拒单，自动往上抬一级（2026-11-18 改）', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion({ reviewBy: 'doubao' }) });
  await engine.submit({ text: '给 demo-editor 排班' });
  await pumpAll(engine);

  // 旧行为：整条建议被静默丢掉，董事会只看到「完成」而库里什么都没有。
  // 新行为：规则仍然成立（不能自己审自己），但方式是「抬一级」——doubao 的上级是 engineering，
  // 所以这条排班照常出单，只是审的人从「执行人自己」换成了它的上级，并留痕说明为什么换了。
  const ap = db.prepare("SELECT * FROM approvals WHERE kind = 'recurring_create' AND status = 'pending'").get();
  assert.ok(ap, '撞车要抬级，不是把活扔掉');
  const job = JSON.parse(ap.requestJson).payload.job;
  assert.equal(job.assignee, 'doubao');
  assert.equal(job.reviewBy, 'engineering', '审的人 = 执行人的上级（reportsTo）');
  const esc = db.prepare("SELECT * FROM audit WHERE action = 'review_by_escalated'").get();
  assert.ok(esc, '抬级必须留痕，否则董事会不知道审的人为什么变了');
  assert.match(esc.newValue, /doubao→engineering/);
});

test('CR-6 · 卡上写死审查人后，执行人自报 land 会被拦下（不能绕过别人审）', async (t) => {
  const { db, rec, engine } = setup(t, { report: { handoff: 'land' } });
  rec.registerJob(makeJob({ reviewBy: 'engineering' }));
  const fired = rec.fire({ jobId: 'JOB-weekly', scheduledAt: '2099-01-01T00:00:00.000Z' });
  await pumpAll(engine);

  const hit = db.prepare("SELECT * FROM audit WHERE action = 'handoff_downgraded' AND taskId = ?").get(fired.taskId);
  assert.ok(hit, '私自落盘必须留痕');
  // 卡上连 handoff 一起写死时走 self-land-ignored；只写 reviewBy 没写 handoff 时走 reviewer-pinned-…。
  // 两种表述都表示同一件事：审查人定了，执行人改不了。
  assert.match(hit.newValue, /self-land-ignored|reviewer-pinned-cannot-self-land/);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(fired.taskId).status, 'in_review',
    '拦下之后仍然要走审，不能既拦下又结案');
});
