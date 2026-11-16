// 统一校验入口：结构（JSON Schema）+ 语义（业务规则）。
// 依据：任务书 §6.3 / §6.6 / §6A.3 / §6A.9 / §6C.1 / §6C.5 / §6D.2 / §6D.4 / §6.7。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema } from './schema-validator.js';
import { CONFIG_SCHEMA, applyConfigRules } from './config.js';
import { SCHEMA_KINDS, SCHEMA_IDS, isPlainObject } from './enums.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL_DIR = path.join(ROOT, 'protocol');

export const SCHEMA_FILES = Object.freeze({
  'task': 'task.schema.json',
  'progress': 'progress.schema.json',
  'completion': 'completion.schema.json',
  'recurring': 'recurring.schema.json',
  'cycle-summary': 'cycle-summary.schema.json',
  'change-request': 'change-request.schema.json',
  'decision': 'decision.schema.json',
  'thread': 'thread.schema.json',
});

const cache = new Map();

export function loadSchema(kind) {
  if (kind === 'config') return CONFIG_SCHEMA;
  const filename = SCHEMA_FILES[kind];
  if (!filename) return null;
  if (cache.has(kind)) return cache.get(kind);
  const schema = JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, filename), 'utf8'));
  cache.set(kind, schema);
  return schema;
}

export function listSchemas() {
  return SCHEMA_KINDS.map((kind) => ({
    kind,
    id: SCHEMA_IDS[kind],
    file: `protocol/${SCHEMA_FILES[kind]}`,
  }));
}

export function businessRules(kind, data) {
  const errors = [];
  if (kind === 'config') return applyConfigRules(data);
  if (!isPlainObject(data)) return errors;

  switch (kind) {
    case 'task': {
      if (data.mode === 'direct' && !data.addressedTo) {
        errors.push('mode=direct 时 addressedTo 必填；cc 只是抄送，不能代替交付');
      }
      if (data.mode === 'cowork' || data.mode === 'meeting') {
        errors.push('cowork / meeting 不产生 TaskCard，应写 thread 协议');
      }
      if (/你看着办|自行判断/.test(data.instructions || '')) {
        errors.push('instructions 不得含「你看着办 / 自行判断」，必须可机检');
      }
      if (Array.isArray(data.cc) && data.addressedTo && data.cc.includes(data.addressedTo)) {
        errors.push('同一席位不能既出现在 addressedTo 又出现在 cc');
      }
      break;
    }
    case 'completion': {
      if (data.status === 'failed' && !data.reason) errors.push('status=failed 必须带 reason');
      break;
    }
    case 'recurring': {
      if (data.kind === 'cleanup' && data.requiresHumanEachCycle !== true) {
        errors.push('清理类循环 requiresHumanEachCycle 必须为 true（§6A.9 硬红线）');
      }
      if (data.trigger?.type === 'cron' && !data.trigger?.rrule) {
        errors.push('cron 触发必须给出 rrule + timezone');
      }
      const termination = data.termination || {};
      if (!termination.validUntil && !termination.maxCycles && !termination.budgetTotal) {
        errors.push('循环必须有终止条件：validUntil / maxCycles / budgetTotal 至少一个非 null');
      }
      if (/Desktop|桌面/i.test(JSON.stringify(data.taskTemplate || {}))) {
        errors.push('扫描路径出现 Desktop / 桌面，拒绝且不写任何文件（§6A.9）');
      }
      break;
    }
    case 'cycle-summary': {
      if (data.metrics?.deletedCount !== undefined && data.metrics.deletedCount !== 0) {
        errors.push('定期清理只扫描出报告，绝不自动删除；deletedCount 必须为 0');
      }
      break;
    }
    case 'change-request': {
      if (data.kind === 'blocked' && data.severity === 'needsDecision') {
        errors.push('kind=blocked 走既有 §7.4 escalation，不得触发挂起；severity 应为 advisory');
      }
      break;
    }
    case 'decision': {
      const acceptance = Array.isArray(data.newAcceptance) ? data.newAcceptance : [];
      const touchesTarget = (typeof data.newInstructions === 'string' && data.newInstructions.trim() !== '') || acceptance.length > 0;
      if (touchesTarget && data.needsHumanApproval !== true) {
        errors.push('改动 instructions / acceptance 时 needsHumanApproval 必须为 true，由控制面生成 replan 人审');
      }
      if (acceptance.some((rule) => /放宽|降低|忽略/.test(String(rule)))) {
        errors.push('CEO 不得单方面放宽 / 降低 / 忽略验收条件（§6.7 / §7.6）');
      }
      break;
    }
    case 'thread': {
      if (data.promotedTo && data.state !== 'archived') {
        errors.push('promote 单向：提升后 state 必须为 archived');
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

const EVENT_TRIGGER = Object.freeze({
  'progress': false,
  'task': true,
  'completion': true,
  'recurring': true,
  'cycle-summary': true,
  'change-request': true,
  'decision': true,
  'thread': true,
  'config': null,
});

export function validate(kind, data) {
  const schema = loadSchema(kind);
  if (!schema) {
    return {
      ok: false,
      errors: [`未知单据类型 ${kind}；可用：${SCHEMA_KINDS.join(', ')}, config`],
      meta: { kind, schemaId: null, triggersEvent: null },
    };
  }
  const structural = validateAgainstSchema(schema, data);
  const errors = [
    ...structural.errors.map((e) => `${e.path}: ${e.message}`),
    ...businessRules(kind, data),
  ];
  return {
    ok: errors.length === 0,
    errors,
    meta: {
      kind,
      schemaId: schema.$id ?? null,
      triggersEvent: EVENT_TRIGGER[kind] ?? null,
    },
  };
}
