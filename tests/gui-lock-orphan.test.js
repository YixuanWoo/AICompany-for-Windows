// 重启后 GUI 锁必须跟着「死掉的 Run」一起放。
// 真机事故（20:50）：引擎重启，run R-387d746b 已按中断收账，但文件锁里还写着
// 「GUI 正被 R-387d746b 占用」→ 新卡全被 env_check 拦下，人看到的就是「重派了却没反应」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { nowIso } from '../src/ids.js';

test('L1 · 重启收尸时把锁一并放掉，新卡才派得出去', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'gui.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ owner: 'R-dead', acquiredAt: nowIso(), released: false })}\n`, 'utf8');

  const config = {
    version: 1,
    company: { name: 'lock-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {}, decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy: {},
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 10,
        adapter: { type: 'mock', config: {} },
      },
      {
        id: 'gui-seat', displayName: '桌面席', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 10, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { lockPath } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('web'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* 已关 */ } });

  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-dead', 'T-x', 'gui-seat', 'issue_assigned', 'running', 1, 1, ?, NULL)`).run(nowIso());
  const recovered = engine.recoverOrphanRuns();
  assert.equal(recovered, 1);
  assert.equal(engine.db.prepare("SELECT status FROM runs WHERE runId = 'R-dead'").get().status, 'interrupted');

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.released, true, '锁必须标成已释放，否则 30 分钟内谁都派不出去');
  const audit = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'gui_lock_released_orphan'").get().n;
  assert.equal(audit, 1, '放锁这件事要留账，否则事后查不到「为什么突然能派了」');
});

test('L2 · 上一轮重启留下的锁（run 早已 interrupted）：启动时照样放掉', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-lock2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'gui.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ owner: 'R-old', acquiredAt: nowIso(), released: false })}\n`, 'utf8');

  const config = {
    version: 1,
    company: { name: 'lock-test2', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    gates: {}, decision: { remindAfterHours: 24, maxPendingHours: 72 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: false },
    runPolicy: {},
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 10,
        adapter: { type: 'mock', config: {} },
      },
      {
        id: 'gui-seat', displayName: '桌面席', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 10, reportsTo: 'ceo',
        adapter: { type: 'mock', config: { lockPath } },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
  const db = openDb(':memory:');
  const engine = createEngine({ db, config, notifier: createNotifier('web'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* 已关 */ } });

  // 这一次启动时没有任何 running：锁的主人是**上一次**收尸判死的 run。
  db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
    VALUES ('R-old', 'T-y', 'gui-seat', 'issue_assigned', 'interrupted', 1, 1, ?, ?)`).run(nowIso(), nowIso());
  engine.recoverOrphanRuns();

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.released, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'gui_lock_released_stale'").get().n, 1);
});
