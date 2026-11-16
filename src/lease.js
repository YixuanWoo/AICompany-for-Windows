// P2-2 / P2-3：checkout 独占、leaseToken 校验、过期释放、bridge 心跳与在线状态。
// 依据：任务书 §6.4 / §9.2 / §9.3 / §9.4 / §7.3 第 5 项 / §7.7。

import { randomUUID } from 'node:crypto';
import { nowIso } from './ids.js';
import { writeAudit, transition } from './core.js';

const toMs = (value) => (value instanceof Date ? value.getTime() : Date.parse(value ?? nowIso()));

// 领取用一条「条件 UPDATE」：SQLite 单语句本身是事务，changes===1 才算抢到，
// 并发 10 个领取请求有且仅有 1 个成功，其余返回 409（§9.4）。
export function checkout(db, {
  taskId, agentId, runId = `R-${randomUUID().slice(0, 8)}`,
  ttlSec = 300, now = new Date(),
}) {
  const stamp = new Date(toMs(now)).toISOString();
  const expiresAt = new Date(toMs(now) + ttlSec * 1000).toISOString();
  const token = `LS-${randomUUID().slice(0, 12)}`;
  let changes = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    changes = db.prepare(`UPDATE tasks SET leaseToken = ?, leaseExpiresAt = ?, updatedAt = ?
      WHERE taskId = ? AND status IN ('todo', 'in_progress')
        AND (leaseToken IS NULL OR leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`)
      .run(token, expiresAt, stamp, taskId, stamp).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (changes !== 1) {
    writeAudit(db, { actor: agentId, action: 'checkout_conflict', newValue: taskId, runId });
    return { ok: false, conflict: true, status: 409, reason: '已被别的 bridge 领走，或任务不在可领取状态' };
  }
  const row = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId);
  if (row.status === 'todo') transition(db, taskId, 'in_progress', 'bridge', runId);
  writeAudit(db, { actor: agentId, action: 'checkout', newValue: taskId, runId });
  return {
    ok: true, status: 200, leaseToken: token, leaseExpiresAt: expiresAt,
    runId, taskId, agentId,
  };
}

// 所有回写都要先验 lease；挂起态 lease 冻结（不因到期释放，仍认原持有者，§6D.3）。
export function assertLease(db, taskId, leaseToken, now = new Date()) {
  const row = db.prepare('SELECT status, leaseToken, leaseExpiresAt FROM tasks WHERE taskId = ?').get(taskId);
  if (!row) return { ok: false, status: 404, reason: '任务不存在' };
  if (!row.leaseToken) return { ok: false, status: 409, reason: '任务没有有效 lease，请先 checkout' };
  if (leaseToken !== row.leaseToken) return { ok: false, status: 409, reason: 'leaseToken 不匹配，拒绝回写' };
  if (row.status === 'awaiting_decision') {
    return { ok: true, status: 200, frozen: true, task: row };
  }
  if (row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) < toMs(now)) {
    return { ok: false, status: 410, reason: 'lease 已过期，拒绝回写' };
  }
  return { ok: true, status: 200, task: row };
}

export function releaseLease(db, taskId, leaseToken) {
  const info = db.prepare('UPDATE tasks SET leaseToken = NULL, leaseExpiresAt = NULL WHERE taskId = ? AND leaseToken = ?')
    .run(taskId, leaseToken);
  return { released: info.changes === 1 };
}

// 续租：交互式席位干一张卡可能远超默认 5 分钟，不能逼它「干到一半被判定过期」。
// 只延长到期时间，不换 token —— 换 token 等于换持有人，会把别的回写路径弄乱。
export function renewLease(db, { taskId, leaseToken, ttlSec = 3600, now = new Date() }) {
  const row = db.prepare('SELECT status, leaseToken FROM tasks WHERE taskId = ?').get(taskId);
  if (!row) return { ok: false, status: 404, reason: '任务不存在' };
  if (!row.leaseToken || row.leaseToken !== leaseToken) {
    return { ok: false, status: 409, reason: 'leaseToken 不匹配，拒绝续租' };
  }
  // 挂起态 lease 冻结（同 assertLease）：到期时间不动，仍认原持有者。
  if (row.status === 'awaiting_decision') {
    return { ok: true, status: 200, frozen: true, reason: '任务挂起，lease 冻结不续' };
  }
  const expiresAt = new Date(toMs(now) + ttlSec * 1000).toISOString();
  db.prepare('UPDATE tasks SET leaseExpiresAt = ? WHERE taskId = ? AND leaseToken = ?')
    .run(expiresAt, taskId, leaseToken);
  writeAudit(db, { actor: 'bridge', action: 'lease_renewed', newValue: `${taskId}|${expiresAt}` });
  return { ok: true, status: 200, leaseToken, leaseExpiresAt: expiresAt, ttlSec };
}

// 租约到期自动释放并把任务置 blocked 上报；awaiting_decision 显式排除，冻结不释放。
export function expireLeases(db, now = new Date()) {
  const stamp = new Date(toMs(now)).toISOString();
  const rows = db.prepare(`SELECT taskId FROM tasks
    WHERE status = 'in_progress' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?`).all(stamp);
  for (const row of rows) {
    db.prepare('UPDATE tasks SET leaseToken = NULL, leaseExpiresAt = NULL WHERE taskId = ?').run(row.taskId);
    writeAudit(db, { actor: 'scheduler', action: 'lease_expired', newValue: row.taskId });
    transition(db, row.taskId, 'blocked', 'scheduler');
  }
  return { released: rows.length, frozen: 'awaiting_decision 不释放、不重跑' };
}

export function heartbeat(db, { agentId, meta = {}, onlineWindowSec = 60, now = new Date() }) {
  const stamp = new Date(toMs(now)).toISOString();
  db.prepare(`INSERT INTO bridges (agentId, lastSeenAt, status, metaJson) VALUES (?, ?, 'online', ?)
    ON CONFLICT(agentId) DO UPDATE SET lastSeenAt = excluded.lastSeenAt,
      status = 'online', metaJson = excluded.metaJson`)
    .run(agentId, stamp, JSON.stringify(meta));
  return { agentId, online: true, lastSeenAt: stamp, onlineWindowSec };
}

export function isBridgeOnline(db, agentId, onlineWindowSec = 60, now = new Date()) {
  const row = db.prepare('SELECT lastSeenAt FROM bridges WHERE agentId = ?').get(agentId);
  if (!row?.lastSeenAt) return false;
  return toMs(now) - Date.parse(row.lastSeenAt) <= onlineWindowSec * 1000;
}

export function markBridgeOffline(db, agentId) {
  db.prepare("UPDATE bridges SET status = 'offline' WHERE agentId = ?").run(agentId);
  return { agentId, online: false };
}

export function listBridges(db, onlineWindowSec = 60, now = new Date()) {
  return db.prepare('SELECT * FROM bridges ORDER BY agentId').all().map((row) => ({
    agentId: row.agentId,
    lastSeenAt: row.lastSeenAt,
    online: isBridgeOnline(db, row.agentId, onlineWindowSec, now),
    meta: JSON.parse(row.metaJson ?? '{}'),
  }));
}
