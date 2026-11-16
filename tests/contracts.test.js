import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_ENDPOINTS, WEB_BOARD_MIN_PAGES, WEB_BOARD_FULL_PAGES, WEB_BOARD_P2_PANELS, WEB_BOARD_P4_PANELS,
  assertImplements, ADAPTER_CONTRACT, CHANNEL_CONTRACT, NOTIFIER_CONTRACT, listEndpoints,
  WEB_BOARD_P5_PANELS, OBSERVE_METRICS_CONTRACT, OBSERVE_FINDINGS_CONTRACT,
} from '../src/contracts.js';
import { buildObservation } from '../src/observe.js';
import { openDb } from '../src/core.js';
import {
  ADAPTER_TYPES, CEO_OUTPUT_KINDS, INTERACTION_MODES, DECISION_OUTCOMES,
  COMPLETION_STATUSES, TASK_STATUSES, COMPENSATION_SCAN_WHITELIST, isOneOf,
} from '../src/enums.js';

test('P0-3 · 统一 API 端点清单覆盖 Web Board / 交互 / 变更决策增量', () => {
  const endpoints = listEndpoints();
  const required = [
    'POST /api/requests', 'GET /api/agents', 'POST /api/threads',
    'POST /api/threads/:id/roll-call', 'POST /api/threads/:id/promote',
    'POST /api/change-requests', 'POST /api/change-requests/:id/decision',
    'POST /api/approvals/:id/decision', 'POST /api/tasks/:id/cancel',
    'GET /api/tasks/:id/revisions', 'GET /api/events',
  ];
  for (const item of required) assert.ok(endpoints.includes(item), `缺端点 ${item}`);
  const signatures = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
  assert.equal(new Set(signatures).size, signatures.length, '同一 method+path 不应重复；同 path 不同 method 合法');
});

test('P0-3 · Web Board 最小页范围（D5）与完整页分开', () => {
  for (const page of ['Tasks', 'Approvals', 'Inbox']) assert.ok(WEB_BOARD_MIN_PAGES.includes(page));
  assert.ok(WEB_BOARD_MIN_PAGES.some((p) => p.includes('模式下拉')));
  assert.ok(WEB_BOARD_FULL_PAGES.includes('ChangeRequests（改动前后对照）'));
});

test('P4 · 端点清单补上配额 / 审批 / 查询 / 清理，且 P4 面板覆盖六类控件', () => {
  const endpoints = listEndpoints();
  for (const item of [
    'GET /api/quotas', 'POST /api/quotas/:id/reset', 'POST /api/approvals', 'GET /api/approvals',
    'POST /api/change-requests/expire', 'GET /api/decisions', 'GET /api/activity',
    'POST /api/threads/archive-stale', 'POST /api/recurring/:id/revise', 'POST /api/cleanup/scan',
  ]) assert.ok(endpoints.includes(item), `缺 P4 端点 ${item}`);

  assert.equal(WEB_BOARD_P4_PANELS.length, 6);
  assert.equal(new Set(WEB_BOARD_P4_PANELS).size, WEB_BOARD_P4_PANELS.length, '面板名不得重复');
  for (const keyword of ['Approvals', 'Decisions', 'Quotas', 'Activity', 'Cleanup']) {
    assert.ok(WEB_BOARD_P4_PANELS.some((p) => p.includes(keyword)), `面板清单缺 ${keyword}`);
  }
  // P2 面板不能被 P4 覆盖掉（分阶段增量，不是替换）。
  assert.ok(WEB_BOARD_P2_PANELS.length >= 2);
});

test('P5 · 端点清单补上观测与调参，指标与结论清单固定', () => {
  const endpoints = listEndpoints();
  for (const item of [
    'GET /api/observe', 'GET /api/observe/dirty', 'GET /api/observe/report',
    'GET /api/config/tuning', 'POST /api/config/tune',
  ]) assert.ok(endpoints.includes(item), `缺 P5 端点 ${item}`);

  assert.equal(WEB_BOARD_P5_PANELS.length, 4);
  assert.equal(new Set(WEB_BOARD_P5_PANELS).size, WEB_BOARD_P5_PANELS.length, '面板名不得重复');
  for (const keyword of ['Observe', 'Tune', '观察记录', '调参历史']) {
    assert.ok(WEB_BOARD_P5_PANELS.some((p) => p.includes(keyword)), `P5 面板缺 ${keyword}`);
  }

  assert.deepEqual([...OBSERVE_METRICS_CONTRACT], ['falseWake', 'idleRun', 'reportReject', 'guiFailure', 'quotaBurn']);
  assert.deepEqual([...OBSERVE_FINDINGS_CONTRACT], ['directBypassesCeo', 'coworkCreatesTask', 'awaitingRerun', 'decisionTimeout']);

  // 契约里声明的指标名必须与 observe.js 真实产物一致，否则面板会读空。
  const sample = buildObservation({
    db: openDb(':memory:'), config: { agents: [{ id: 'ceo', isCEO: true, capabilities: [] }] }, workRoot: null,
  });
  for (const key of OBSERVE_METRICS_CONTRACT) assert.ok(sample.metrics[key], `指标对不上：${key}`);
  for (const key of OBSERVE_FINDINGS_CONTRACT) assert.ok(sample.findings[key], `结论对不上：${key}`);
});

test('P0-3 · adapter / Channel / Notifier 三份契约可判定', () => {
  const adapter = { type: 'process', execute: () => {}, testEnvironment: () => ({ ok: true }) };
  assert.equal(assertImplements(adapter, ADAPTER_CONTRACT).ok, true);
  assert.equal(assertImplements({ type: 'process' }, ADAPTER_CONTRACT).ok, false);

  const channel = { start: () => {}, stop: () => {}, onInbound: () => {} };
  assert.equal(assertImplements(channel, CHANNEL_CONTRACT).ok, true);
  assert.equal(assertImplements({ start: () => {}, stop: () => {} }, CHANNEL_CONTRACT).ok, false);

  const notifier = { send: () => {}, requestApproval: () => {} };
  assert.equal(assertImplements(notifier, NOTIFIER_CONTRACT).ok, true);
  const withReadInbox = { ...notifier, readInbox: () => {} };
  const result = assertImplements(withReadInbox, NOTIFIER_CONTRACT);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('readInbox')));
});

test('P0-5 · 所有封闭枚举都不含第五类出口', () => {
  assert.deepEqual(ADAPTER_TYPES, ['process', 'http', 'cli-acp', 'gui-template', 'polling']);
  assert.equal(INTERACTION_MODES.length, 4);
  assert.equal(DECISION_OUTCOMES.length, 4);
  assert.equal(CEO_OUTPUT_KINDS.length, 4);
  assert.equal(isOneOf('free-form', CEO_OUTPUT_KINDS), false);
  assert.equal(isOneOf('restart', DECISION_OUTCOMES), false);
  assert.deepEqual(COMPLETION_STATUSES, ['success', 'failed', 'blocked']);
  assert.ok(TASK_STATUSES.includes('awaiting_decision'));
  assert.ok(TASK_STATUSES.includes('cancelled'));
  assert.ok(!COMPENSATION_SCAN_WHITELIST.includes('awaiting_decision'), '挂起态必须排除在补偿扫描之外');
});
