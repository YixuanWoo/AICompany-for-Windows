// 总经理（外部按量计费席位）的会话复用。
// 目的：所有工作在一个会话里完成 → 前缀稳定 → 命中缓存 → 真省钱。
// 约束：一个会话不能并发跑两轮（服务端按 sessionId 收文本，会串台），必须排队。
// 另外要能：到轮次提醒、到上限自动换、董事会随时手动换。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWebhookExecAdapter } from '../src/adapter-webhook-exec.js';
import {
  DEFAULT_SESSION_POLICY, describeCeoSession, ensureCeoSession, readCeoSession, rotateCeoSession,
} from '../src/ceo-session.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ANSWER = JSON.stringify({ type: 'task-create', tasks: [], summary: '知道了' });

function fakeServer({ seen = [], order = null, delayMs = 0 } = {}) {
  return async (base, endpoint, payload) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (endpoint === '/aiceo/api/task') {
      seen.push(payload);
      if (order) order.push(`task:${payload.taskId}`);
      return {
        statusCode: 200,
        body: { ok: true, value: { taskId: payload.taskId, sessionId: `aiceo-ceo-${payload.sessionId ?? payload.taskId}` } },
      };
    }
    if (endpoint === '/aiceo/api/result') {
      if (order) order.push(`result:${payload.taskId}`);
      return { statusCode: 200, body: { ok: true, value: { status: 'done', text: ANSWER, turn: 1 } } };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}

function ceoCtx(workRoot, over = {}) {
  const task = over.task ?? { taskId: 'T-1', title: '问点事', instructions: '看看现状', revision: 1 };
  return {
    task,
    taskId: task.taskId,
    wakeReason: 'issue_assigned',
    agent: { id: 'dsh-planner' },
    workRoot,
    interaction: {},
    company: { agents: [] },
    availableProjects: [],
    adapterConfig: { mode: 'ceo', workRoot, baseUrl: 'http://fake', token: 't', timeoutMs: 3000, pollMs: 0 },
    ...over,
  };
}

function adapter({ seen = [], order = null, delayMs = 0 } = {}) {
  return createWebhookExecAdapter({
    request: fakeServer({ seen, order, delayMs }),
    sleep: async () => {},
  });
}

test('S1 · 连续两轮共用同一个会话（这才是缓存命中的前提）', async (t) => {
  const root = tmpRoot(t);
  const seen = [];
  const a = adapter({ seen });

  await a.execute(ceoCtx(root, { task: { taskId: 'T-1', title: '第一单', instructions: 'x', revision: 1 } }));
  await a.execute(ceoCtx(root, { task: { taskId: 'T-2', title: '第二单', instructions: 'y', revision: 1 } }));

  assert.equal(seen.length, 2);
  assert.ok(seen[0].sessionId, '第一次投递就要带会话 id，否则服务端会自己新建');
  assert.equal(seen[1].sessionId, seen[0].sessionId, '第二轮必须落在同一个会话里');

  const state = readCeoSession(root, 'dsh-planner');
  assert.equal(state.turns, 2, '每轮记一次账');
  assert.equal(state.lastTaskId, 'T-2');
  assert.ok(state.startedAt);
});

test('S2 · 手动换新：会话 id 变、轮次归零、旧的那段留下尾巴', async (t) => {
  const root = tmpRoot(t);
  const seen = [];
  const a = adapter({ seen });

  await a.execute(ceoCtx(root));
  const before = readCeoSession(root, 'dsh-planner');

  const fresh = rotateCeoSession(root, 'dsh-planner', { reason: '董事会手动新建', actor: 'board' });
  assert.notEqual(fresh.sessionId, before.sessionId);
  assert.equal(fresh.turns, 0);
  assert.equal(fresh.previous.sessionId, before.sessionId, '换新不是抹历史，要能回看上一段');
  assert.equal(fresh.previous.turns, 1);
  assert.match(fresh.previous.reason, /手动/);

  await a.execute(ceoCtx(root, { task: { taskId: 'T-9', title: '换新之后', instructions: 'z', revision: 1 } }));
  assert.equal(seen[1].sessionId, fresh.sessionId, '换新后下一轮必须用新会话');
});

test('S3 · 轮次到上限自动换新，不用人盯着', async (t) => {
  const root = tmpRoot(t);
  const first = ensureCeoSession(root, 'dsh-planner', { warnTurns: 2, maxTurns: 2 });

  // 手写两轮，模拟已经跑满
  const file = path.join(root, 'sessions', 'dsh-planner.json');
  fs.writeFileSync(file, JSON.stringify({ ...first, turns: 2 }), 'utf8');

  const next = ensureCeoSession(root, 'dsh-planner', { warnTurns: 2, maxTurns: 2 });
  assert.notEqual(next.sessionId, first.sessionId, '到上限要换新会话');
  assert.equal(next.turns, 0);
  assert.match(next.previous.reason, /轮次到上限/);
});

test('S4 · 同一会话串行：两轮并发也绝不重叠', async (t) => {
  const root = tmpRoot(t);
  const order = [];
  const a = adapter({ order, delayMs: 5 });

  await Promise.all([
    a.execute(ceoCtx(root, { task: { taskId: 'T-A', title: 'A', instructions: 'a', revision: 1 } })),
    a.execute(ceoCtx(root, { task: { taskId: 'T-B', title: 'B', instructions: 'b', revision: 1 } })),
  ]);

  // 严格交替：A 投递 → A 取结果 → B 投递 → B 取结果。有任何交错都说明两个任务抢了同一个会话。
  // 任务键带 plan 后缀（同一张卡的拆解与验收是两轮，不能共用一个键），但会话是同一个。
  assert.deepEqual(order, ['task:T-A-plan', 'result:T-A-plan', 'task:T-B-plan', 'result:T-B-plan']);
});

test('S6 · CEO 长回合也要留证据：回执写在真任务号目录，不是 -plan 键', async (t) => {
  const root = tmpRoot(t);
  const a = adapter();

  const out = await a.execute(ceoCtx(root, {
    task: { taskId: 'T-9fk2e11', title: '长回合', instructions: 'x', revision: 1 },
    runId: 'R-abc123',
  }));
  assert.equal(out.status, 'success');

  // 看门狗找证据只看 workRoot/tasks/<真任务号>/：键带 -plan 后缀的那份等于没写。
  const receiptFile = path.join(root, 'tasks', 'T-9fk2e11', 'dispatch.json');
  assert.equal(fs.existsSync(receiptFile), true, 'CEO 派出去了就得有送达回执');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(receipt.runId, 'R-abc123');
  assert.equal(receipt.via, 'webhook');
  assert.equal(fs.existsSync(path.join(root, 'tasks', 'T-9fk2e11-plan', 'dispatch.json')), false,
    '证据不能落在 API 任务键那个目录，看门狗看不见');
});

test('S7 · 上游一轮卡死不返回：超时后必须换新会话，别再往死任务后面排队', async (t) => {
  const root = tmpRoot(t);
  const before = ensureCeoSession(root, 'dsh-planner', DEFAULT_SESSION_POLICY);
  const a = createWebhookExecAdapter({
    request: async (base, endpoint, payload) => {
      if (endpoint === '/aiceo/api/task') {
        return { statusCode: 200, body: { ok: true, value: { taskId: payload.taskId, sessionId: 's-dead' } } };
      }
      // 上游一直说 running、一个字都不吐：模拟 2026-11-20 那次卡死
      return { statusCode: 200, body: { ok: true, value: { status: 'running', text: '', turn: 0 } } };
    },
    sleep: async () => {},
  });

  await assert.rejects(
    a.execute(ceoCtx(root, {
      adapterConfig: {
        mode: 'ceo', workRoot: root, baseUrl: 'http://fake', token: 't', timeoutMs: 300, pollMs: 0,
      },
    })),
    /超时/,
  );

  const after = readCeoSession(root, 'dsh-planner');
  assert.notEqual(after.sessionId, before.sessionId, '超时后必须换新会话，否则重派会排在那条死任务后面');
  assert.match(String(after.previous?.reason ?? ''), /超时/);
});

test('S5 · 人话摘要：轮次、时长、短码都算得出来', async (t) => {
  const root = tmpRoot(t);
  ensureCeoSession(root, 'ceo');
  const d = describeCeoSession(readCeoSession(root, 'ceo'));
  assert.equal(d.exists, true);
  assert.equal(d.turns, 0);
  assert.match(d.text, /已 0 轮/);
  assert.match(d.short, /^\d{12}-[a-z0-9]{4}$/, '短码 = 开的时间 + 随机尾巴，人和日志里都认得出来');

  assert.equal(describeCeoSession(null).exists, false);
  assert.equal(DEFAULT_SESSION_POLICY.reuse, true);
});
