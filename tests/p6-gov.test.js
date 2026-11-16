// G3 验收：按难度分流。≥3 个岗位、难度写进任务卡、调度器按「接不接得住」选人。
// 对应 docs/开发清单.md 的 G3（§15.4）与 docs/G3-难度分流.md。
//
// 三条铁律（本文件逐条守住）：
//   ① 硬活不许落给只接简单活的席位（筛不掉就不派，绝不硬塞）；
//   ② 简单活优先给「刚够用」的席位，别拿强席位烧在琐事上；
//   ③ 人显式点名接不了的席位时，明确报错并给出能接的候选，而不是悄悄换人或悄悄照派。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { rankCandidates } from '../src/org.js';
import { canTake, ceilingOf, normalizeDifficulty, DifficultyError } from '../src/difficulty.js';
import { nowIso } from '../src/ids.js';

const completion = (ctx, extra = {}) => ({
  schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '完成', artifacts: [], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(), ...extra,
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-g3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 三档执行席位 + CEO。ceiling 故意错开，才能看出「刚够用优先」。
function seats({ ceilings = { easy: 'easy', normal: 'normal', hard: 'hard' }, extra = [] } = {}) {
  const [easy, normal, hard] = [ceilings.easy, ceilings.normal, ceilings.hard];
  const list = [
    {
      id: 'ceo', displayName: '总经理', isCEO: true,
      capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 30, reportsTo: null,
      adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-easy', displayName: '轻活席位', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'ceo',
      ...(easy === undefined ? {} : { maxDifficulty: easy }),
      adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-normal', displayName: '常规席位', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'ceo',
      ...(normal === undefined ? {} : { maxDifficulty: normal }),
      adapter: { type: 'mock', config: {} },
    },
    {
      id: 'worker-hard', displayName: '重活席位', isCEO: false, capabilities: ['execute'],
      status: 'active', quotaDaily: 20, reportsTo: 'ceo',
      ...(hard === undefined ? {} : { maxDifficulty: hard }),
      adapter: { type: 'mock', config: {} },
    },
    ...extra,
  ];
  return list;
}

function cfgFor({ agents = seats(), autoAssign = true, strategy = false } = {}) {
  return {
    version: 1,
    company: { name: 'g3-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: { strategy },
    interaction: {
      defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign,
      meeting: { defaultStyle: 'rollCall', fullRequiresConfirm: true },
      thread: { ttlDays: 30, promoteRequiresExplicit: true },
    },
    agents,
    clients: ['web'], notifier: ['noop'],
  };
}

function engineFor(t, { cfg = cfgFor(), ceoResult = null, workerResult = null } = {}) {
  const root = tmpDir(t);
  const c = { ...cfg, workRoot: root };
  for (const agent of c.agents) {
    if (agent.id === 'ceo') {
      agent.adapter = {
        type: 'mock',
        config: {
          result: ceoResult ?? ((ctx) => (ctx.task === null
            ? { type: 'message', text: '已看过' }
            : (ctx.wakeReason === 'review_requested'
              ? { type: 'review', verdict: 'pass', reason: '通过' }
              : { type: 'task-create', title: '子任务', assignee: 'worker-normal' }))),
        },
      };
    } else if (String(agent.adapter?.type) === 'mock') {
      agent.adapter = {
        type: 'mock',
        config: {
          result: workerResult ?? ((ctx) => (ctx.task ? completion(ctx) : { type: 'message', text: '已发言' })),
        },
      };
    }
  }
  const db = openDb(':memory:');
  const engine = createEngine({
    db, config: c, notifier: createNotifier('noop'),
    now: () => new Date('2026-01-01T00:00:00.000Z'), workRoot: root,
  });
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  return { engine, db, cfg: c, root };
}

// ---- 难度词汇与天花板 ----

test('G3 · 难度只有三档：非法值必须报错，不许静默当 normal', () => {
  assert.equal(normalizeDifficulty(undefined), 'normal');
  assert.equal(normalizeDifficulty(' HARD '), 'hard');
  assert.throws(() => normalizeDifficulty('urgent'), (e) => e instanceof DifficultyError
    && /easy \/ normal \/ hard/.test(e.message) && /urgent/.test(e.message));
  // 席位不写上限 = 不设限（老配置升级上来行为不变）
  assert.equal(ceilingOf({ id: 'w' }), 'hard');
  assert.equal(canTake({ agentId: 'w', maxDifficulty: 'easy' }, 'hard'), false);
  assert.equal(canTake({ agentId: 'w', maxDifficulty: 'normal' }, 'normal'), true);
  assert.equal(canTake({ agentId: 'w', maxDifficulty: 'easy' }, 'easy'), true);
});

test('G3 · 候选排序：先筛掉接不了的，再让「刚够用」的席位排前面', () => {
  const seat = (agentId, maxDifficulty, used) => ({
    agentId, status: 'active', isCEO: false, capabilities: ['execute'],
    quotaLimit: 10, quotaUsed: used, maxDifficulty,
  });
  const pool = [seat('w-hard', 'hard', 0), seat('w-easy', 'easy', 0), seat('w-normal', 'normal', 9)];
  // 简单活：三席都能接，但「刚好够用」的那位先上（哪怕另一位配额更多）
  assert.deepEqual(
    rankCandidates(pool, { needCapability: 'execute', difficulty: 'easy' }).map((c) => c.agentId),
    ['w-easy', 'w-normal', 'w-hard'],
  );
  // 硬活：只剩接得住的，弱席位直接被筛掉
  assert.deepEqual(
    rankCandidates(pool, { needCapability: 'execute', difficulty: 'hard' }).map((c) => c.agentId),
    ['w-hard'],
  );
  // 不给难度时保持老行为（纯按配额余量排），不因这次改动改变既有排序
  assert.deepEqual(
    rankCandidates(pool, { needCapability: 'execute' }).map((c) => c.agentId),
    ['w-easy', 'w-hard', 'w-normal'],
  );
  // 额度用完的席位不许因为「够用」被优先推上去：旁边有能接的就该给能接的
  assert.deepEqual(
    rankCandidates(
      [seat('w-easy', 'easy', 10), seat('w-normal', 'normal', 0)],
      { needCapability: 'execute', difficulty: 'easy' },
    ).map((c) => c.agentId),
    ['w-normal', 'w-easy'],
  );
});

// ---- 路由：自动选人 ----

test('G3 · 自动选人：三档席位下，hard 卡不会落给只接 easy / normal 的席位', async (t) => {
  const { engine, db } = engineFor(t);
  const out = await engine.route({ text: '把这座桥算一遍', mode: 'direct', difficulty: 'hard' });
  assert.equal(out.target, 'worker-hard');
  assert.equal(out.difficulty, 'hard');
  const row = db.prepare('SELECT assignee, difficulty FROM tasks WHERE taskId = ?').get(out.taskId);
  assert.equal(row.assignee, 'worker-hard');
  assert.equal(row.difficulty, 'hard');
});

test('G3 · 自动选人：简单活先给「刚够用」的席位，别拿重活席位烧琐事', async (t) => {
  const { engine } = engineFor(t);
  assert.equal((await engine.route({ text: '整理文件名', mode: 'direct', difficulty: 'easy' })).target, 'worker-easy');
  assert.equal((await engine.route({ text: '写周报', mode: 'direct', difficulty: 'normal' })).target, 'worker-normal');
  // 不写难度 = normal（人给的原始需求默认普通）
  const plain = await engine.route({ text: '随手记一下', mode: 'direct' });
  assert.equal(plain.difficulty, 'normal');
  assert.equal(plain.target, 'worker-normal');
});

test('G3 · 席位不写 maxDifficulty = 不设限：老配置照样能接 hard 卡', async (t) => {
  const { engine } = engineFor(t, {
    cfg: cfgFor({
      agents: seats({
        ceilings: { easy: undefined, normal: 'easy', hard: 'easy' },
      }),
    }),
  });
  const out = await engine.route({ text: '难活', mode: 'direct', difficulty: 'hard' });
  assert.equal(out.target, 'worker-easy', '没写上限的席位应被当成「不设限」');
});

// ---- 路由：人点名 ----

test('G3 · 人点名接不了的席位：明确报错 + 列出能接的候选，且一张卡都不许建', async (t) => {
  const { engine, db } = engineFor(t);
  assert.throws(
    () => engine.route({ text: '硬活', mode: 'direct', addressedTo: 'worker-easy', difficulty: 'hard' }),
    (e) => /worker-easy 只接 ≤ easy/.test(e.message) && /worker-hard/.test(e.message),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, '被拒的派活不能留下半张卡');
});

test('G3 · 非法难度：直接拒绝，不静默降级成 normal', async (t) => {
  const { engine, db } = engineFor(t);
  assert.throws(
    () => engine.route({ text: '硬活', mode: 'direct', addressedTo: 'worker-hard', difficulty: 'urgent' }),
    (e) => /difficulty 只能是 easy \/ normal \/ hard/.test(e.message),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});

// ---- CEO 拆活 ----

test('G3 · CEO 拆活：子卡继承父卡难度，接不了就改派给接得住的（留痕，不硬塞）', async (t) => {
  const { engine, db } = engineFor(t, {
    ceoResult: (ctx) => (ctx.task === null
      ? { type: 'message', text: '已看过' }
      : (ctx.wakeReason === 'review_requested'
        ? { type: 'review', verdict: 'pass', reason: '通过' }
        // CEO 把 hard 子任务点给了只接 easy 的席位
        : { type: 'task-create', title: '子任务', assignee: 'worker-easy' })),
  });
  const out = await engine.submit({ text: '难项目', mode: 'delegate', difficulty: 'hard' });
  assert.equal(out.target, 'ceo');

  const children = db.prepare('SELECT * FROM tasks WHERE parentTaskId = ?').all(out.taskId);
  assert.equal(children.length, 1);
  assert.equal(children[0].difficulty, 'hard', '子卡没标难度时应继承父卡');
  assert.equal(children[0].assignee, 'worker-hard', '接不了的席位要被改成接得住的');
  const audit = db.prepare("SELECT * FROM audit WHERE action = 'difficulty_reassigned'").get();
  assert.ok(audit, '改派必须留痕，否则人不知道 CEO 的点名被改了');
  assert.equal(audit.oldValue, 'worker-easy');
  assert.equal(audit.newValue, 'worker-hard');
});

test('G3 · CEO 拆活：一个能接的都没有 → 不派、不假完成，挂起并通知人', async (t) => {
  const { engine, db } = engineFor(t, {
    cfg: cfgFor({ agents: seats({ ceilings: { easy: 'easy', normal: 'easy', hard: 'easy' } }) }),
    ceoResult: (ctx) => (ctx.task === null
      ? { type: 'message', text: '已看过' }
      : (ctx.wakeReason === 'review_requested'
        ? { type: 'review', verdict: 'pass', reason: '通过' }
        : { type: 'task-create', title: '硬子任务', assignee: 'worker-easy' })),
  });
  const out = await engine.submit({ text: '超出能力的项目', mode: 'delegate', difficulty: 'hard' });
  const parent = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(out.taskId);
  assert.notEqual(parent.status, 'done', '派不出去就不是完成');
  assert.ok(['blocked', 'paused'].includes(parent.status), `应挂起等人处理，实际 ${parent.status}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId = ?').get(out.taskId).n, 0);
  assert.ok(db.prepare("SELECT * FROM audit WHERE action = 'difficulty_blocked'").get());
});

// ---- 落库 / 展示 ----

test('G3 · 难度要能查：getTasks 与审计都能看到这张卡是几档', async (t) => {
  const { engine, db } = engineFor(t, { cfg: cfgFor({ autoAssign: false }) });
  const out = await engine.route({ text: '硬活', mode: 'direct', addressedTo: 'worker-hard', difficulty: 'hard' });
  const card = engine.getTasks().find((x) => x.taskId === out.taskId);
  assert.equal(card.difficulty, 'hard');
  const audit = db.prepare("SELECT * FROM audit WHERE action = 'create_task' AND taskId = ?").get(out.taskId);
  assert.ok(audit);
});

test('G3 · 老库升级：补列后旧任务按 normal 走，旧席位按「不设限」走（不追溯改判）', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'old.db');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  // 故意只建 G3 之前的老结构：没有 difficulty / maxDifficulty 两列。
  raw.exec(`CREATE TABLE tasks (
    taskId TEXT PRIMARY KEY, requestId TEXT, parentTaskId TEXT, title TEXT, role TEXT,
    assignee TEXT, status TEXT, mode TEXT, addressedTo TEXT, assignedBy TEXT,
    revision INTEGER DEFAULT 1, threadId TEXT, attempt INTEGER DEFAULT 0,
    priority TEXT, createdAt TEXT, updatedAt TEXT, leaseToken TEXT, leaseExpiresAt TEXT,
    originJson TEXT)`);
  raw.exec(`CREATE TABLE agents (agentId TEXT PRIMARY KEY, displayName TEXT, isCEO INTEGER,
    capabilities TEXT, status TEXT, quotaDaily INTEGER, adapterType TEXT, reportsTo TEXT,
    escalationTo TEXT)`);
  raw.exec("INSERT INTO tasks (taskId, requestId, title, status) VALUES ('T-old', 'REQ-old', '旧卡', 'todo')");
  raw.exec("INSERT INTO agents (agentId, isCEO, capabilities, status, quotaDaily, adapterType) VALUES ('w-old', 0, '[\"execute\"]', 'active', 20, 'mock')");
  raw.close();

  const db = openDb(file);
  try {
    assert.equal(db.prepare('SELECT difficulty FROM tasks WHERE taskId = ?').get('T-old').difficulty, 'normal');
    assert.equal(db.prepare('SELECT maxDifficulty FROM agents WHERE agentId = ?').get('w-old').maxDifficulty, null);
    // 老席位没有上限值 = 不设限，硬活照样能接（升级不会把老配置锁死）
    assert.equal(canTake({ agentId: 'w-old', maxDifficulty: null }, 'hard'), true);
  } finally {
    // 必须在临时目录清理前关库，否则 Windows 上文件被占用，删不掉。
    db.close();
  }
});
