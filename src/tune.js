// P5-2：据试运行数据调 cooldown / 配额 / 提示词模板，并且每次调整都留痕（旧值 → 新值可查）。
//
// 两条硬约束：
// 1. 只允许改白名单里的键，别的一律拒绝——防止「顺手改了个未定义字段」导致配置静默失效；
// 2. 改完立刻生效（config 对象是引擎持有的同一引用），同时写 audit，action = config_change。
//
// 持久化不做 YAML 文本改写（会把用户手写的注释与顺序搞坏），而是落一份 runtime-overrides.json，
// 由 config.js 在 schema 校验之前合并。删掉这个文件即回到配置文件原值。

import fs from 'node:fs';
import path from 'node:path';
import { writeAudit } from './core.js';

// 可调项。type 决定校验方式；max 是防止「调成 0 就停摆」或「调成天文数字」。
export const TUNABLE = Object.freeze({
  'runPolicy.cooldownSec': { type: 'int', min: 0, max: 3600, label: '同一席位两次唤醒的最小间隔（秒）' },
  'runPolicy.maxConcurrent': { type: 'int', min: 1, max: 32, label: '全局并发 Run 上限' },
  'quota.warnRatio': { type: 'ratio', min: 0, max: 1, label: '配额预警比例' },
  'quota.stopRatio': { type: 'ratio', min: 0, max: 1, label: '配额停派比例' },
  'quota.periodHours': { type: 'int', min: 1, max: 720, label: '配额周期（小时）' },
  'decision.remindAfterHours': { type: 'int', min: 1, max: 720, label: '挂起多久开始提醒（小时）' },
  'decision.maxPendingHours': { type: 'int', min: 1, max: 8760, label: '挂起多久自动取消（小时）' },
  'interaction.thread.ttlDays': { type: 'int', min: 1, max: 3650, label: '协作空间闲置归档天数' },
  'interaction.meeting.fullRequiresConfirm': { type: 'bool', label: '全员会议是否必须二次确认' },
});

// 席位级：agents.<id>.quotaDaily
const AGENT_KEY = /^agents\.([A-Za-z0-9_-]+)\.quotaDaily$/;

export function readOverrides(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function writeOverrides(file, overrides) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
  return file;
}

// 深合并：只合 plain object；挡掉 __proto__ / constructor / prototype，避免原型污染。
export function applyOverrides(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
      && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = applyOverrides(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function getPath(obj, dotted) {
  return dotted.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

export function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
  return obj;
}

export class TuneError extends Error {
  constructor(message, code = 'TUNE_INVALID') {
    super(message);
    this.name = 'TuneError';
    this.code = code;
  }
}

export function describeTunable(key) {
  const spec = TUNABLE[key];
  if (spec) return spec;
  const m = AGENT_KEY.exec(key);
  if (m) return { type: 'int', min: 0, max: 1000, label: `席位 ${m[1]} 的每日额度` };
  return null;
}

export function validateTunable(key, value) {
  const spec = describeTunable(key);
  if (!spec) {
    throw new TuneError(`不可调参数：${key}（允许：${[...Object.keys(TUNABLE), 'agents.<id>.quotaDaily'].join(' / ')}）`);
  }
  if (spec.type === 'bool') {
    if (typeof value !== 'boolean') throw new TuneError(`${key} 必须是 true / false`);
    return true;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw new TuneError(`${key} 必须是数字，收到 ${JSON.stringify(value)}`);
  if (spec.type === 'int' && !Number.isInteger(num)) throw new TuneError(`${key} 必须是整数，收到 ${num}`);
  if (num < spec.min || num > spec.max) {
    throw new TuneError(`${key} 超出允许范围 [${spec.min}, ${spec.max}]，收到 ${num}`);
  }
  return num;
}

/**
 * 改一个可调项。
 * @param {{ config: object, db: object, overridesPath?: string|null }} runtime
 * @returns {{ key, from, to, applied: true, persisted: boolean, at }}
 */
export function tune(runtime, { key, value, actor = 'human', reason = '', persist = true, now = new Date() }) {
  const { config, db } = runtime;
  if (!config || !db) throw new TuneError('tune 需要 config 与 db');
  const normalized = validateTunable(key, value);

  // 席位级要顺手校验席位真的存在，不然会悄悄造出一个配置里没有的席位。
  const m = AGENT_KEY.exec(key);
  if (m) {
    const exists = (config.agents ?? []).some((a) => a.id === m[1]);
    if (!exists) throw new TuneError(`配置里没有席位 ${m[1]}，不能给它调额度`);
  }

  // 阈值之间的联动：预警必须小于等于停派，否则「永远预警不了」。
  if (key === 'quota.warnRatio' && normalized > (getPath(config, 'quota.stopRatio') ?? 1)) {
    throw new TuneError(`warnRatio(${normalized}) 不能大于 stopRatio(${getPath(config, 'quota.stopRatio')})`);
  }
  if (key === 'quota.stopRatio' && normalized < (getPath(config, 'quota.warnRatio') ?? 0.8)) {
    throw new TuneError(`stopRatio(${normalized}) 不能小于 warnRatio(${getPath(config, 'quota.warnRatio')})`);
  }

  const from = getPath(config, key);
  if (from === normalized) {
    return { key, from, to: normalized, applied: false, persisted: false, at: now.toISOString(), note: '值未变化' };
  }

  setPath(config, key, normalized);

  let persisted = false;
  if (persist && runtime.overridesPath) {
    const overrides = readOverrides(runtime.overridesPath);
    // agents 是数组，不能按点路径深合并（会把整个数组冲掉），席位级额度单独存一张映射表。
    if (m) {
      overrides.agentQuotaDaily = { ...(overrides.agentQuotaDaily ?? {}), [m[1]]: normalized };
    } else {
      setPath(overrides, key, normalized);
    }
    writeOverrides(runtime.overridesPath, overrides);
    persisted = true;
  }

  writeAudit(db, {
    actor,
    action: 'config_change',
    oldValue: JSON.stringify({ key, value: from ?? null }),
    newValue: JSON.stringify({ key, value: normalized, reason: reason || null, persisted }),
  });

  return { key, from: from ?? null, to: normalized, applied: true, persisted, at: now.toISOString() };
}

// 调整历史，给看板与报告用。
export function tuneHistory(db, limit = 100) {
  return db.prepare("SELECT * FROM audit WHERE action = 'config_change' ORDER BY rowid DESC LIMIT ?").all(limit)
    .map((row) => {
      let from = null;
      let to = null;
      try { from = JSON.parse(row.oldValue ?? 'null'); } catch { from = { raw: row.oldValue }; }
      try { to = JSON.parse(row.newValue ?? 'null'); } catch { to = { raw: row.newValue }; }
      return {
        auditId: row.auditId, at: row.createdAt, actor: row.actor,
        key: to?.key ?? from?.key ?? null,
        from: from?.value ?? null,
        to: to?.value ?? null,
        reason: to?.reason ?? null,
        persisted: Boolean(to?.persisted),
      };
    });
}
