// 所有封闭枚举集中在这里。引擎只认这些标签，不认任何产品名（任务书 §6B.2 / §6C.2）。

export const SCHEMA_KINDS = [
  'task', 'progress', 'completion', 'recurring',
  'cycle-summary', 'change-request', 'decision', 'thread',
];

export const SCHEMA_IDS = {
  'task': 'aicompany.task/v1',
  'progress': 'aicompany.progress/v1',
  'completion': 'aicompany.completion/v1',
  'recurring': 'aicompany.recurring/v1',
  'cycle-summary': 'aicompany.cycle-summary/v1',
  'change-request': 'aicompany.change-request/v1',
  'decision': 'aicompany.decision/v1',
  'thread': 'aicompany.thread/v1',
};

export const INTERACTION_MODES = ['delegate', 'direct', 'cowork', 'meeting'];
export const DECISION_OUTCOMES = ['resume', 'redo', 'derive', 'cancel'];
export const CEO_OUTPUT_KINDS = ['task-create', 'review', 'escalation', 'decision'];

export const TASK_STATUSES = [
  'backlog', 'todo', 'in_progress', 'awaiting_decision',
  'in_review', 'done', 'cancelled', 'blocked', 'paused',
];
export const COMPENSATION_SCAN_WHITELIST = ['todo', 'in_progress'];
export const COMPLETION_STATUSES = ['success', 'failed', 'blocked'];

export const ADAPTER_TYPES = ['process', 'http', 'cli-acp', 'gui-template', 'polling'];
export const CAPABILITIES = ['plan', 'delegate', 'review', 'execute', 'escalate', 'readOnly'];
export const CLIENT_TYPES = ['web', 'im', 'cli', 'noop'];
export const NOTIFIER_TYPES = ['web', 'im', 'webhook', 'stdout', 'noop'];

export const CHANGE_KINDS = ['direction', 'clarify', 'scope', 'blocked'];
export const CHANGE_SEVERITIES = ['needsDecision', 'advisory'];
export const WAKE_POLICIES = ['never', 'onRollCall', 'onMessage'];
export const THREAD_STATES = ['active', 'archived'];
export const THREAD_STYLES = ['readonly', 'rollCall', 'full'];

// P4：三道常规人审门禁 + 两类按需事件型人审（replan / 循环模板改版）。
export const APPROVAL_KINDS = ['strategy', 'hiring_budget', 'review_reject', 'replan', 'recurring_change'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rewrite', 'rejected', 'expired'];
export const APPROVAL_DECISIONS = ['approved', 'rewrite', 'rejected'];

export const DEFAULTS = Object.freeze({
  defaultMode: 'delegate',
  autoAssign: false,
  fullRequiresConfirm: true,
  ttlDays: 30,
  promoteRequiresExplicit: true,
  warnRatio: 0.8,
  stopRatio: 1,
  decisionRemindHours: 24,
  decisionMaxPendingHours: 72,
  // P5：Run Policy 第 4 条。cooldownSec 默认 0 = 关闭，保持老配置行为不变。
  maxConcurrent: 3,
  cooldownSec: 0,
  maxRunHours: 2,
  staleEventMinutes: 10,
});

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOneOf(value, allowed) {
  return allowed.includes(value);
}

export function assertEnum(value, allowed, label) {
  if (!isOneOf(value, allowed)) {
    throw new Error(`${label} 必须是 [${allowed.join(', ')}] 之一，收到：${String(value)}`);
  }
  return value;
}
