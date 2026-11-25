import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from '../protocol/examples.js';
import { validate, businessRules } from '../src/validate.js';
import { SCHEMA_KINDS } from '../src/enums.js';

function rejects(kind, data, keyword) {
  const result = validate(kind, data);
  assert.equal(result.ok, false, `应当被拒：${keyword}`);
  assert.ok(result.errors.join('\n').includes(keyword), `错误信息应包含「${keyword}」，实际：${result.errors.join('; ')}`);
}

test('P0-5 · 把 cc 当 addressedTo 用，被明确拒绝', () => {
  const data = fixtures.task.invalid[1].data;
  rejects('task', data, 'addressedTo 必填');
});

test('P0-5 · cowork / meeting 不产生 TaskCard', () => {
  const base = fixtures.task.valid[0];
  rejects('task', { ...base, mode: 'cowork' }, '不产生 TaskCard');
  rejects('task', { ...base, mode: 'meeting' }, '不产生 TaskCard');
});

test('P0-5 · CEO 输出是封闭四类；未知决策出口被拒', () => {
  rejects('decision', { ...fixtures.decision.valid[0], decision: 'restart' }, 'decision');
});

test('P0-5 · 改目标必须走 replan 人审；放宽验收一律拒绝', () => {
  rejects('decision', { ...fixtures.decision.valid[0], newInstructions: '改用统一术语', needsHumanApproval: false }, 'needsHumanApproval');
  rejects('decision', { ...fixtures.decision.valid[0], newAcceptance: ['放宽验收条件'], needsHumanApproval: true }, '放宽');
});

test('P0-5 · 清理类循环硬红线：每轮人审不能被关掉，deletedCount 必须为 0', () => {
  rejects('recurring', { ...fixtures.recurring.valid[0], requiresHumanEachCycle: false }, 'requiresHumanEachCycle');
  rejects('cycle-summary', { ...fixtures['cycle-summary'].valid[0], metrics: { deletedCount: 1 } }, 'deletedCount');
  rejects('recurring', { ...fixtures.recurring.valid[0], taskTemplate: { ...fixtures.recurring.valid[0].taskTemplate, instructions: '扫描 Desktop 并删除' } }, 'Desktop');
});

test('P0-5 · blocked 走既有 escalation，不触发挂起', () => {
  rejects('change-request', { ...fixtures['change-request'].valid[0], kind: 'blocked', severity: 'needsDecision' }, 'blocked');
});

test('P0-5 · progress 不触发事件，change-request 每次落盘都触发', () => {
  assert.equal(validate('progress', fixtures.progress.valid[0]).meta.triggersEvent, false);
  assert.equal(validate('change-request', fixtures['change-request'].valid[0]).meta.triggersEvent, true);
  assert.equal(businessRules('progress', fixtures.progress.valid[0]).length, 0);
});

test('P0-4 · 未知单据类型明确报错并列出可用类型', () => {
  const result = validate('invoice', {});
  assert.equal(result.ok, false);
  for (const kind of SCHEMA_KINDS) assert.ok(result.errors[0].includes(kind));
});
