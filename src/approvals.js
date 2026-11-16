// P4-2：审批单存储。三道常规门禁（strategy / hiring_budget / review_reject）
// 与两类按需人审（replan / 循环模板改版）共用一张表；判定动作在 engine 里按 kind 分派。
// 依据：任务书 §7.6 / §6D.4。

import { randomUUID } from 'node:crypto';
import { nowIso } from './ids.js';
import { APPROVAL_KINDS, APPROVAL_DECISIONS } from './enums.js';

export function createApproval(db, {
  kind, taskId = null, title = '', body = '', payload = {}, requestedBy = 'control-plane',
}) {
  if (!APPROVAL_KINDS.includes(kind)) {
    throw new Error(`未知审批类型 ${kind}；可用：${APPROVAL_KINDS.join(', ')}`);
  }
  const approvalId = `AP-${randomUUID().slice(0, 8)}`;
  const request = { title, body, requestedBy, payload };
  db.prepare(`INSERT INTO approvals (approvalId, kind, taskId, status, requestJson, createdAt)
    VALUES (?, ?, ?, 'pending', ?, ?)`).run(
    approvalId, kind, taskId, JSON.stringify(request), nowIso(),
  );
  return { approvalId, kind, taskId, status: 'pending', ...request, createdAt: nowIso() };
}

export function getApproval(db, approvalId) {
  const row = db.prepare('SELECT * FROM approvals WHERE approvalId = ?').get(approvalId);
  if (!row) return null;
  return { ...row, request: JSON.parse(row.requestJson ?? '{}') };
}

export function listApprovals(db, { status = null, taskId = null, kind = null } = {}) {
  const rows = db.prepare('SELECT * FROM approvals ORDER BY rowid').all();
  return rows
    .filter((r) => (!status || r.status === status)
      && (!taskId || r.taskId === taskId)
      && (!kind || r.kind === kind))
    .map((r) => ({ ...r, request: JSON.parse(r.requestJson ?? '{}') }));
}

export function closeApproval(db, approvalId, { decision, decidedBy = 'human', reason = null }) {
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new Error(`未知审批结论 ${decision}；可用：${APPROVAL_DECISIONS.join(', ')}`);
  }
  const row = db.prepare('SELECT * FROM approvals WHERE approvalId = ?').get(approvalId);
  if (!row) throw new Error(`没有待审批单 ${approvalId}`);
  if (row.status !== 'pending') throw new Error(`审批单 ${approvalId} 已处理（${row.status}），不重复判定`);
  db.prepare('UPDATE approvals SET status = ?, decidedBy = ?, decidedAt = ?, reason = ? WHERE approvalId = ?')
    .run(decision, decidedBy, nowIso(), reason, approvalId);
  return getApproval(db, approvalId);
}

export function pendingApprovals(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get().n;
}

// 人审通过后把「这次被批准的决策」补一个 approvalId 印章：
// 决策者拿同一份 decision 重新提交时，凭这个章直接执行，不再反复生成新的 replan 审批。
export function stampRequestPayload(db, approvalId, patch = {}) {
  const row = db.prepare('SELECT * FROM approvals WHERE approvalId = ?').get(approvalId);
  if (!row) throw new Error(`没有审批单 ${approvalId}`);
  const request = JSON.parse(row.requestJson ?? '{}');
  const next = { ...request, payload: { ...(request.payload ?? {}), ...patch } };
  db.prepare('UPDATE approvals SET requestJson = ? WHERE approvalId = ?').run(JSON.stringify(next), approvalId);
  return next;
}
