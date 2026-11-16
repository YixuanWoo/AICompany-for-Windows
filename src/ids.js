// 幂等键、目录规范、原子写、时间格式（任务书 §6.2 / §6.9 / §7.1）。

import fs from 'node:fs';
import path from 'node:path';

export const IDEMPOTENCY_KEYS = Object.freeze({
  request: 'requestId',
  task: 'taskId',
  run: 'runId',
  channelEvent: 'message_id',
  changeRequest: 'changeRequestId',
  threadMessage: 'threadId + messageId',
  decision: 'decisionId（一个 crId 只允许一条生效决策）',
});

export const TIME_RULE = '统一存 UTC ISO 8601（new Date().toISOString()），展示时才转本地时区；不混用 +08:00 字面量';
export const ENCODING_RULE = 'UTF-8 无 BOM；写临时文件 → 原子 rename';

export function nowIso() {
  return new Date().toISOString();
}

export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

export const LAYOUT = Object.freeze([
  'tasks', 'threads', 'inbox', 'outbox', 'events',
]);

export function ensureLayout(workRoot) {
  for (const dir of LAYOUT) fs.mkdirSync(path.join(workRoot, dir), { recursive: true });
  return workRoot;
}

export function taskDir(workRoot, taskId) {
  return path.join(workRoot, 'tasks', taskId);
}

// 命名约定：change-request.json 是简称，实际落 <crId>.json（任务书 §6.2 / §6D.2）。
export function changeRequestPath(workRoot, taskId, crId) {
  return path.join(taskDir(workRoot, taskId), 'change-requests', `${crId}.json`);
}

export function decisionPath(workRoot, taskId, crId) {
  return path.join(taskDir(workRoot, taskId), 'decisions', `${crId}.json`);
}

export function snapshotPath(workRoot, taskId, crId) {
  return path.join(taskDir(workRoot, taskId), 'snapshots', `${crId}.json`);
}

export function revisionPath(workRoot, taskId, revision) {
  return path.join(taskDir(workRoot, taskId), 'revisions', `rev-${revision}.json`);
}

// promote 单向：thread → TaskCard 可以，反向一律拒绝（任务书 §6C.5）。
export function assertPromote(thread, targetTaskId) {
  if (thread.promotedTo) throw new Error('该协作空间已提升过，promote 只能做一次');
  if (thread.state !== 'active') throw new Error('只有 active 的协作空间可以提升');
  if (!targetTaskId) throw new Error('必须显式给出目标 taskId');
  return { ...thread, promotedTo: targetTaskId, state: 'archived' };
}

export function dedupeKey(kind, ids) {
  const parts = Object.entries(ids).map(([k, v]) => `${k}=${v}`);
  return `${kind}:${parts.join('|')}`;
}
