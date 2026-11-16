// G2 自主验收：任务完成后自动触发下一轮（无需第二条命令）。
//   ① 完成即触发：一轮 done → 立刻建下一轮，审计可查
//   ② 连败自动停：失败轮也派生，但到阈值就暂停 job，不再烧额度
//   ③ 最小间隔：两轮之间太近就延期，审计可查，绝不瞬时连爆
//   ④ 引擎接线：卡真的到 done 时，hook 自动把下一轮派生出来
// 全部零外部依赖、不碰真实键盘、用内存库与假时钟。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, writeAudit } from '../src/core.js';
import { createNotifier } from '../src/engine.js';
import { createEngine } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { validate } from '../src/validate.js';
import { createRecurring } from '../src/recurring.js';
import { buildTaskPaths, sha256File } from '../src/gui-report.js';

const BASE = '2026-11-16T12:00:00.000Z';
const stamp = (min) => new Date(Date.parse(BASE) + min * 60000).toISOString();

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-g2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function job(overrides = {}) {
  return {
    schema: 'aicompany.recurring/v1',
    jobId: 'JOB-G2', jobVersion: 1,
    title: '每日巡检', kind: 'inspection',
    owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
    trigger: { type: 'onCompletion', completionMinIntervalSec: 0 },
    misfirePolicy: 'run_once', overlapPolicy: 'skip',
    termination: { maxCycles: 20, pauseOnConsecutiveFailures: 2 },
    requiresHumanEachCycle: false,
    taskTemplate: {
      role: 'general', instructions: '巡检并写出完成报告。',
      acceptance: ['completion.json 通过 schema 校验'],
      completionReportPath: 'output/completion.json',
    },
    dedupeWindowMin: 1,
    ...overrides,
  };
}

function setup(t, extra = {}, jobOverrides = {}) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const notifier = createNotifier('noop');
  let clock = stamp(0);
  const rec = createRecurring({ db, notifier, now: () => clock });
  const registered = rec.registerJob(job(jobOverrides));
  t.after(() => db.close());
  return { root, db, rec, registered, setNow: (iso) => { clock = iso; }, notifier, ...extra };
}

// ---------------------------------------------------------------- ① 完成即触发

test('G2 · onCompletion 型 job：一轮 done 后立刻派生下一轮，审计逐条可查', (t) => {
  const s = setup(t);
  assert.equal(validate('recurring', job()).ok, true, 'onCompletion 类型必须通过协议校验');

  const first = s.rec.fire({ jobId: 'JOB-G2', scheduledAt: stamp(0), now: stamp(0) });
  assert.equal(first.created, true);
  assert.equal(first.cycleNo, 1);
  assert.equal(s.rec.listCycles('JOB-G2').length, 1);

  s.setNow(stamp(1));
  const began = Date.now();
  const out = s.rec.onTaskTerminal({ taskId: first.taskId, status: 'done', runId: 'RUN-1', now: stamp(1) });
  assert.equal(out.closed, true);
  assert.equal(out.created, true);
  assert.equal(out.cycleNo, 2, '完成即触发：下一轮同一秒内建出来');
  assert.ok(Date.now() - began < 1000, '1 秒内出现下一轮');
  assert.equal(s.rec.listCycles('JOB-G2').length, 2);

  const audits = s.db.prepare('SELECT action, newValue FROM audit ORDER BY rowid').all();
  assert.ok(audits.some((a) => a.action === 'completion_cycle_closed' && /JOB-G2#1:done/.test(a.newValue)));
  assert.ok(audits.some((a) => a.action === 'completion_triggered' && /JOB-G2#2/.test(a.newValue)));
  // 一轮只收一次账：重复通知不能建出第三轮
  const dup = s.rec.onTaskTerminal({ taskId: first.taskId, status: 'done', now: stamp(1) });
  assert.equal(dup.skipped, true);
  assert.equal(s.rec.listCycles('JOB-G2').length, 2);
});

test('G2 · 非 onCompletion 的 job 不受影响：cron 型卡完成不会自己派生', (t) => {
  const s = setup(t, {}, {
    trigger: { type: 'cron', rrule: 'FREQ=DAILY;BYHOUR=0', completionMinIntervalSec: 0 },
    nextFireAt: stamp(999),
  });
  const first = s.rec.fire({ jobId: 'JOB-G2', scheduledAt: stamp(0), now: stamp(0) });
  const out = s.rec.onTaskTerminal({ taskId: first.taskId, status: 'done', now: stamp(1) });
  assert.equal(out.skipped, true);
  assert.equal(s.rec.listCycles('JOB-G2').length, 1, 'cron 型仍由调度器到点触发');
});

// ---------------------------------------------------------------- ② 连败自动停

test('G2 · 必失败的活：失败轮也派生，但连续 N 次后自动暂停并写审计', (t) => {
  const s = setup(t, {}, { termination: { maxCycles: 20, pauseOnConsecutiveFailures: 2 } });
  const first = s.rec.fire({ jobId: 'JOB-G2', now: stamp(0) });
  const second = s.rec.onTaskTerminal({ taskId: first.taskId, status: 'blocked', now: stamp(1) });
  assert.equal(second.created, true, '第一次失败还要再试一轮');
  assert.equal(second.cycleNo, 2);

  const third = s.rec.onTaskTerminal({ taskId: second.taskId, status: 'blocked', now: stamp(2) });
  assert.equal(third.paused, true, '连败到阈值必须停手');
  assert.equal(s.rec.getJob('JOB-G2').status, 'paused');
  assert.equal(s.rec.listCycles('JOB-G2').length, 2, '停手后不再派生第三轮');
  assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action = 'job_paused'").get());
});

test('G2 · 人工取消的轮次不再派生下一轮', (t) => {
  const s = setup(t);
  const first = s.rec.fire({ jobId: 'JOB-G2', now: stamp(0) });
  const out = s.rec.onTaskTerminal({ taskId: first.taskId, status: 'cancelled', now: stamp(1) });
  assert.equal(out.stopped, true);
  assert.equal(s.rec.listCycles('JOB-G2').length, 1);
});

// ---------------------------------------------------------------- ③ 最小间隔

test('G2 · 最小间隔防连爆：两轮派生太近就延期，审计写明原因', (t) => {
  const s = setup(t, {}, {
    trigger: { type: 'onCompletion', completionMinIntervalSec: 300 },
  });
  const first = s.rec.fire({ jobId: 'JOB-G2', now: stamp(0) });
  const out = s.rec.onTaskTerminal({ taskId: first.taskId, status: 'done', now: stamp(1) });
  assert.equal(out.deferred, true);
  assert.equal(out.waitMs, 240000, '首轮 0 分触发、现在 1 分完成，最小间隔 5 分 → 还等 4 分');
  assert.equal(s.rec.listCycles('JOB-G2').length, 1, '延期期间不许建卡');
  assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action = 'completion_deferred'").get());
});

// ---------------------------------------------------------------- ④ 引擎接线

function company(root, clock) {
  return {
    version: 1,
    company: { name: 'g2-company', timezone: 'Asia/Shanghai' },
    workRoot: root,
    interaction: { defaultMode: 'direct', defaultTarget: 'ceo', autoAssign: false },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'review'], status: 'active', quotaDaily: 50, reportsTo: null,
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass' }
              : {
                type: 'task-create', title: '子任务', assignee: 'worker-01',
                instructions: '按 brief 执行', acceptance: ['产物非空'],
              }),
          },
        },
      },
      {
        id: 'worker-01', displayName: '后台席位', isCEO: false,
        capabilities: ['execute'], status: 'active', quotaDaily: 50, reportsTo: 'ceo',
        adapter: {
          type: 'mock',
          config: {
            result: (ctx) => {
              const paths = buildTaskPaths(root, ctx.task.taskId);
              fs.mkdirSync(paths.outputDir, { recursive: true });
              const file = path.join(paths.outputDir, 'note.md');
              fs.writeFileSync(file, '巡检内容', 'utf8');
              return {
                schema: 'aicompany.completion/v1',
                taskId: ctx.task.taskId, runId: ctx.runId, agent: 'worker-01',
                revision: ctx.task.revision, status: 'success',
                summary: '巡检完成，产物是 output/note.md',
                artifacts: ['output/note.md'],
                checksum: { 'output/note.md': sha256File(file) },
                acceptanceResults: [{ rule: '产物非空', pass: true }],
                usage: { quotaUnits: 1 },
                finishedAt: clock,
              };
            },
          },
        },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

test('G2 · 真实接线：createServer 把终态 hook 接上，卡 done 后下一轮自己出现', async (t) => {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const notifier = createNotifier('noop');
  let clock = stamp(0);
  const config = company(root, clock);
  const engine = createEngine({ db, config, notifier });
  const server = createServer({ engine, port: 0, host: '127.0.0.1', now: () => clock });
  t.after(() => { server.close(); db.close(); });

  const rec = createRecurring({ db, notifier, now: () => clock });
  rec.registerJob(job());
  // server 创建时已把 hook 接到它自己的 rec；这里换成测试持有的 rec（同一个库）。
  engine.setTaskTerminalHook?.((p) => rec.onTaskTerminal(p));

  const first = rec.fire({ jobId: 'JOB-G2', now: stamp(0) });
  assert.equal(first.created, true);
  await engine.pump();
  clock = stamp(1);
  await engine.pump();

  const cycles = rec.listCycles('JOB-G2');
  assert.ok(cycles.length >= 2, `卡 done 后必须自动派生下一轮，实际 ${cycles.length} 轮`);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'completion_triggered'").get());
});
