// 制度回执（2026-11-18）：引擎拒绝 ≠ 把这条删掉、当没发生。
//
// 真机事故 T-51a0595b：CEO 提「工作台月度体检」，reviewBy 撞到执行人自己 →
// 引擎把整条建议丢掉、只写一条审计 → CEO 在回话里说「已安排」、看板写「完成：…」，
// 而 recurring_jobs 里根本没有这条。董事会看到的和库里发生的完全是两件事。
//
// 现在统一成三条规矩：
//   ① 校验跑在动手之前：不合规 → 这一轮**什么都不落**（不出单、不建卡、不标完成）；
//   ② 回执带三样：违反哪条 / 为什么 / 正确写法，然后**重新唤醒同一个 agent**；
//   ③ 上限 2 次重试，第 3 次 blocked 并沿汇报线上报（CEO 的上级 = 董事会）。
// 另外：零落地的一轮不许标「完成」，它是「回复」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-rule-feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const suggestion = (over = {}) => ({
  title: '自媒体工作台月度体检',
  project: 'workbench',
  rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=20;BYMINUTE=0',
  timezone: 'Asia/Shanghai',
  assignee: 'doubao',
  kind: 'maintenance',
  instructions: '按体检清单跑一遍，写出本轮数字与遗留风险。',
  acceptance: ['两个数字都要写出来'],
  reason: '长期重复',
  ...over,
});

function company(root, { cycle = null, tasks = [] } = {}) {
  return {
    version: 1,
    company: { name: 'rule-feedback', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    artifacts: {
      defaultReviewer: 'engineering', routineReviewer: 'engineering', defaultHandoff: 'byAssigner',
    },
    projects: {
      workbench: {
        displayName: '自媒体工作台', rootDir: root, deliverSubdir: 'deliver',
        acceptance: ['产物落在 deliver'], rules: [],
      },
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
              type: 'task-create',
              summary: cycle ? '已给工作台安排月度体检' : '这一轮只回话',
              tasks: tasks,
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
            result: (ctx) => ({
              schema: 'aicompany.completion/v1',
              taskId: ctx.task.taskId, runId: ctx.runId, agent: 'doubao',
              revision: ctx.task.revision, status: 'success',
              summary: '干完了', acceptanceResults: [{ rule: '产物非空', pass: true }],
              usage: { quotaUnits: 1 }, finishedAt: new Date().toISOString(),
            }),
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
  // 项目要有规范文件才允许派活（没有规范的项目＝没有工地）。测试里给工作台写一份最小规范。
  const projectDir = path.join(root, 'projects', 'workbench');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'project.yaml'),
    'displayName: 自媒体工作台\ndeliverSubdir: deliver\nacceptance:\n  - 产物落在 deliver\nrules: []\n', 'utf8');
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: company(root, opts), notifier: createNotifier('noop') });
  t.after(() => db.close());
  return { root, db, engine };
}

const pumpAll = async (engine) => { for (let i = 0; i < 10; i += 1) await engine.pump(); };
const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const count = (db, sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;

test('RF-1 · 建议不合规：整轮不落任何东西，卡带回执重投（不是静默丢弃）', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion({ acceptance: [] }) });
  const sub = await engine.submit({ text: '给工作台配个月度体检' });
  await pumpAll(engine);

  const card = one(db, 'SELECT * FROM tasks WHERE taskId = ?', sub.taskId);
  assert.notEqual(card.status, 'done', '有不合规的产出就不许标「完成」');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM approvals WHERE kind = 'recurring_create'"),
    0, '不合规的建议一张审批单都不许出（否则重试时会重复出单）');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'recurring_suggestion_rejected'"),
    0, '旧语义（静默丢弃）必须消失');

  const violation = one(db, "SELECT * FROM audit WHERE action = 'rule_violation' ORDER BY rowid LIMIT 1");
  assert.ok(violation, '拒绝必须留痕');
  assert.match(violation.newValue, /acceptance/);

  const retry = one(db, "SELECT * FROM audit WHERE action = 'rule_retry' ORDER BY rowid LIMIT 1");
  assert.ok(retry, '拒绝之后必须重新唤醒同一个 agent，而不是停下等人');
});

test('RF-2 · 回执要真的进到下一次的提示词（reviewNote 带原因和正确写法）', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion({ acceptance: [] }) });
  const sub = await engine.submit({ text: '给工作台配个月度体检' });
  await pumpAll(engine);

  const ev = one(db, `SELECT * FROM events
    WHERE type = 'issue_assigned' AND taskId = ? AND payloadJson LIKE '%rule_retry%'
    ORDER BY rowid LIMIT 1`, sub.taskId);
  assert.ok(ev, '要发一条新的派活事件把 CEO 叫起来');
  const payload = JSON.parse(ev.payloadJson ?? '{}');
  assert.equal(payload.wakeReason, 'rule_retry');
  const note = String(payload.reviewNote ?? '');
  assert.match(note, /不合制度/, '回执要直接说清这一轮为什么被退回');
  assert.match(note, /正确写法/, '只说错、不说怎么改，等于让人再猜一遍');
  assert.match(note, /acceptance/, '要具体到缺的那个字段');
  assert.match(note, /没有派卡、没有出审批单/, '要让人知道这一轮已经全部撤回，不会留半截');
});

test('RF-3 · 改两轮仍不对：第 3 次 blocked 并上报（不无限烧额度）', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion({ acceptance: [] }) });
  const sub = await engine.submit({ text: '给工作台配个月度体检' });
  await pumpAll(engine);

  const card = one(db, 'SELECT * FROM tasks WHERE taskId = ?', sub.taskId);
  assert.equal(card.status, 'blocked');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'rule_retry'"), 2, '最多重投 2 次');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'rule_violation'"), 3, '第 3 次不再重投');
  assert.ok(one(db, "SELECT * FROM audit WHERE action = 'blocked_escalated' AND taskId = ?", sub.taskId),
    '耗尽了要沿汇报线上报（CEO 的上级是董事会）');
});

test('RF-4 · 合规的一轮照常落地，且把「连续不合规」计数清零', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion(), tasks: [] });
  const sub = await engine.submit({ text: '给工作台配个月度体检' });
  await pumpAll(engine);

  const ap = one(db, "SELECT * FROM approvals WHERE kind = 'recurring_create' AND status = 'pending'");
  assert.ok(ap, '合规建议要出审批单');
  const job = JSON.parse(ap.requestJson).payload.job;
  assert.equal(job.assignee, 'doubao', '执行人是 CEO 指定的下级席位');
  assert.equal(job.reviewBy, 'engineering', '审的人由引擎按执行人的上级推出来，不用 CEO 手写');
  assert.equal(job.reportsTo, 'engineering');
  assert.equal(one(db, 'SELECT * FROM tasks WHERE taskId = ?', sub.taskId).attempt, 0, '合规轮次不留重投计数');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit WHERE action = 'rule_violation'"), 0);
});

test('RF-5 · 零落地的一轮不许标「完成」：它是回复，不是办完一件事', async (t) => {
  const { db, engine } = setup(t, { cycle: suggestion() });
  // 先让同一条建议已经有一张待批单（模拟 CEO 一轮里重复提同一条）。
  const first = await engine.submit({ text: '给工作台配个月度体检' });
  await pumpAll(engine);
  assert.ok(one(db, "SELECT * FROM approvals WHERE kind = 'recurring_create' AND status = 'pending'"));

  // 第二次提同一条：被 dup 挡掉，这一轮实际什么都不落地，只有回话。
  const second = await engine.submit({ text: '再给工作台配个月度体检（重复）' });
  await pumpAll(engine);

  const msg = one(db, "SELECT * FROM board_messages WHERE taskId = ? ORDER BY rowid DESC LIMIT 1", second.taskId);
  assert.ok(msg, '要有一条消息给董事会');
  assert.equal(msg.kind, 'answer', '没落地的一轮是「回复」，不是「完成」');
  assert.match(msg.title, /总经理回复/, '标题不许写「完成」');
  assert.ok(one(db, 'SELECT * FROM audit WHERE action = \'ceo_no_delivery\' AND taskId = ?', second.taskId),
    '零落地要留痕，方便以后查「它说做了其实没做」');
  // 第一条单不能因为第二轮重复提交而翻倍。
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM approvals WHERE kind = 'recurring_create'"), 1);
});
