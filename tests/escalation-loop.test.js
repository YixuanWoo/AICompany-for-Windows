// 2026-11-17 稳定性加固（董事会四条）：卡不许停在原地等人。
//  ① 走不下去 → 先交给汇报线上的上级（agent）处置，只有到顶才出审批单；
//  ② 上级处置完 → 原卡自己回到执行人手上重跑（最多救活 2 次）；
//  ③ 卡在同一状态太久 → 心跳看门狗先补投（最多 3 次），还不动就向上汇报。
// 这些行为由 runPolicy.escalateToBoss / stuckMinutes 控制，默认关；公司档里打开。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { nowIso } from '../src/ids.js';

const completion = (ctx, extra = {}) => ({
  schema: 'aicompany/completion/v1'.replace('/', '.'), taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(), ...extra,
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-esc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config({ runPolicy = {}, seats = null } = {}) {
  const agents = seats ?? [
    {
      id: 'ceo', displayName: '总经理', isCEO: true,
      capabilities: ['plan', 'delegate', 'review', 'escalate'], status: 'active', quotaDaily: 30,
      reportsTo: null, adapter: { type: 'mock', config: {} },
    },
    {
      id: 'lead', displayName: '技术主管', isCEO: false,
      capabilities: ['plan', 'review', 'delegate', 'execute'], status: 'active', quotaDaily: 20,
      reportsTo: 'ceo', adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-01', displayName: '执行一席', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'lead',
      adapter: { type: 'mock', config: {} },
    },
  ];
  return {
    version: 1,
    company: { name: 'esc-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {},
    decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy,
    agents,
    clients: ['web'], notifier: ['noop'],
  };
}

// worker-01 永远交不合格报告；lead 收到处置卡就「给一条返工意见」；ceo 只当观众。
function engineFor(t, { runPolicy = {}, workerResult = null, leadResult = null } = {}) {
  const root = tmpDir(t);
  const c = { ...config({ runPolicy }), workRoot: root };
  for (const agent of c.agents) {
    if (agent.id === 'worker-01') {
      agent.adapter.config.result = workerResult
        ?? ((ctx) => completion(ctx, { status: 'failed', reason: '这条路做不了' }));
    }
    if (agent.id === 'lead') {
      agent.adapter.config.result = leadResult
        ?? ((ctx) => (ctx.task && String(ctx.task.title).startsWith('处理升级')
          ? completion(ctx, { summary: '返工：换一条更简单的路，别再扩范围' })
          : completion(ctx)));
    }
    if (agent.id === 'ceo') {
      // 处置卡自己也是卡：它交了处置意见后要走验收，总经理在这里放行。
      agent.adapter.config.result = (ctx) => (ctx.wakeReason === 'review_requested'
        ? { type: 'review', verdict: 'pass', reason: '处置意见可用' }
        : { type: 'message', text: '看过' });
    }
  }
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: c, notifier: createNotifier('web'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  return { engine, db, c };
}

test('E1 · 连续失败 → 卡转 blocked，但立刻给上级建处置卡（不是出审批单给人）', async (t) => {
  const { engine, db } = engineFor(t, { runPolicy: { escalateToBoss: true } });
  const r = await engine.submit({ requestId: 'REQ-E1', text: '做不了', mode: 'direct', addressedTo: 'worker-01' });

  const card = db.prepare('SELECT status, assignee FROM tasks WHERE taskId = ?').get(r.taskId);
  assert.ok(['blocked', 'in_progress'].includes(card.status), `卡要么在等人处置、要么已被叫回来重做，实际 ${card.status}`);
  const esc = db.prepare("SELECT * FROM tasks WHERE role = 'escalation'").get();
  assert.ok(esc, '必须有一张接手卡，不能只写一行日志');
  assert.equal(esc.assignee, 'lead');
  assert.equal(esc.parentTaskId, r.taskId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'review_reject'").get().n, 0,
    '上级还没说话，不该直接惊动董事会');
  const audit = engine.getAudit().filter((a) => a.action === 'reported_upward');
  assert.equal(audit.length, 1);
});

test('E2 · 上级处置完，原卡自己回到执行人手上重跑（不用人等）', async (t) => {
  const { engine, db } = engineFor(t, { runPolicy: { escalateToBoss: true } });
  const r = await engine.submit({ requestId: 'REQ-E2', text: '做不了', mode: 'direct', addressedTo: 'worker-01' });

  const resumed = engine.getAudit().filter((a) => a.action === 'resumed_after_escalation');
  assert.equal(resumed.length, 1, '处置卡收尾后原卡必须被叫回来');
  // 叫回来的证据：返工事件带上级处置意见，执行人确实又跑了一轮。
  const ev = db.prepare(`SELECT payloadJson FROM events WHERE taskId = ? AND type = 'issue_assigned'
    ORDER BY rowid DESC LIMIT 1`).get(r.taskId);
  assert.ok(ev, '原卡要有一次新的派活事件');
  assert.match(String(ev.payloadJson), /上级处置|rework/);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE taskId = ? AND agentId = 'worker-01'").get(r.taskId).n >= 2,
    '原执行人要被重新叫起来');
});

test('E3 · 上级的处置卡也办不下去 → 再往上一层报，不停在中间层', async (t) => {
  const { engine, db } = engineFor(t, {
    runPolicy: { escalateToBoss: true },
    // 上级（lead）自己接手处置也交不出合格报告
    leadResult: (ctx) => (String(ctx.task.title).startsWith('处理升级')
      ? completion(ctx, { status: 'failed', reason: '我也判不了' })
      : completion(ctx)),
  });
  const r = await engine.submit({ requestId: 'REQ-E3', text: '做不了', mode: 'direct', addressedTo: 'worker-01' });

  const cards = db.prepare("SELECT assignee, status FROM tasks WHERE role = 'escalation' ORDER BY rowid").all();
  assert.ok(cards.length >= 2, `处置卡失败要继续往上汇报，实际只有 ${cards.length} 张`);
  assert.equal(cards[cards.length - 1].assignee, 'ceo', '最后要报到总经理，不停在中间层');
  assert.ok(engine.getAudit().some((a) => a.action === 'reported_upward' && a.taskId === r.taskId));
});

test('E4 · 看门狗：卡停在 blocked 太久、又没人处置 → 自动再向上汇报', async (t) => {
  const { engine, db } = engineFor(t, { runPolicy: { escalateToBoss: true, stuckMinutes: 30 } });
  const r = await engine.submit({ requestId: 'REQ-E4', text: '放着不动', mode: 'direct', addressedTo: 'worker-01' });
  // 收尾那张处置卡并把它做旧：模拟「上级处置过了，但原卡还躺在 blocked，之后谁也没再管」。
  db.prepare("UPDATE tasks SET status = 'done', updatedAt = ? WHERE role = 'escalation'")
    .run(new Date(Date.now() - 180 * 60 * 1000).toISOString());
  db.prepare("UPDATE tasks SET status = 'blocked', updatedAt = ? WHERE taskId = ?")
    .run(new Date(Date.now() - 180 * 60 * 1000).toISOString(), r.taskId);

  const out = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(out.stuckEscalated, 1, '看门狗要把这张卡捞出来');
  assert.ok(engine.getAudit().some((a) => a.action === 'stuck_escalated'), '必须留痕');
  const cards = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE role = 'escalation'").get().n;
  assert.ok(cards >= 2, '要有新的一张处置卡，不能只记一条日志');

  // 再来一轮：已经报过就不再重复报，避免每次心跳都惊动上级。
  const again = await engine.reconcile({ olderThanMs: 60_000 });
  assert.equal(again.stuckEscalated, 0);
});
