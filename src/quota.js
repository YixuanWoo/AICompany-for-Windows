// P4-1：岗位配额与 80% / 100% 阈值。
// 规则：按周期（默认 24 小时）记账；到 warnRatio 预警一次、到 stopRatio 停派新活并通知；
// 跨周期自动开新账（旧账保留可回溯），人工也能显式重置。依据任务书 §7.5 / §12 P4。

import { nowIso } from './ids.js';

export function periodKey(now = new Date(), periodHours = 24) {
  if (periodHours === 24) return now.toISOString().slice(0, 10);
  return `P${periodHours}-${Math.floor(now.getTime() / (periodHours * 3600_000))}`;
}

export function quotaState(db, agentId, { now = new Date(), periodHours = 24 } = {}) {
  const period = periodKey(now, periodHours);
  const row = db.prepare('SELECT * FROM quotas WHERE agentId = ? AND period = ?').get(agentId, period);
  if (!row) return null;
  return {
    agentId, period,
    used: row.used, limit: row.limitUnits, warnAt: row.warnAt,
    ratio: row.limitUnits > 0 ? row.used / row.limitUnits : 0,
    exhausted: row.used >= row.limitUnits,
    warned: Boolean(row.warnNotifiedAt),
  };
}

// 当前周期没有账就开一本；配额上限 / 预警线改了就跟上配置（旧账不动）。
export function ensureQuota(db, agent, { now = new Date(), quota = {} } = {}) {
  const periodHours = quota.periodHours ?? 24;
  const warnRatio = quota.warnRatio ?? 0.8;
  const period = periodKey(now, periodHours);
  const limit = agent.quotaDaily ?? 20;
  const warnAt = Math.max(1, Math.floor(limit * warnRatio));
  const row = db.prepare('SELECT * FROM quotas WHERE agentId = ? AND period = ?').get(agent.id, period);
  if (!row) {
    db.prepare(`INSERT INTO quotas (agentId, period, used, limitUnits, warnAt)
      VALUES (?, ?, 0, ?, ?)`).run(agent.id, period, limit, warnAt);
  } else if (row.limitUnits !== limit || row.warnAt !== warnAt) {
    db.prepare('UPDATE quotas SET limitUnits = ?, warnAt = ? WHERE agentId = ? AND period = ?')
      .run(limit, warnAt, agent.id, period);
  }
  return quotaState(db, agent.id, { now, periodHours });
}

export function ensureAllQuotas(db, config, { now = new Date() } = {}) {
  return config.agents.map((agent) => ensureQuota(db, agent, { now, quota: config.quota }));
}

export function consumeQuota(db, agentId, units = 1, { now = new Date(), periodHours = 24 } = {}) {
  const period = periodKey(now, periodHours);
  db.prepare('UPDATE quotas SET used = used + ? WHERE agentId = ? AND period = ?')
    .run(units, agentId, period);
  return quotaState(db, agentId, { now, periodHours });
}

// 人工重置：只把「当前周期」的已用量清零，历史周期保留（不删任何行）。
export function resetQuota(db, agentId, { now = new Date(), periodHours = 24 } = {}) {
  const period = periodKey(now, periodHours);
  const info = db.prepare(`UPDATE quotas SET used = 0, warnNotifiedAt = NULL, stopNotifiedAt = NULL
    WHERE agentId = ? AND period = ?`).run(agentId, period);
  return { agentId, period, reset: info.changes === 1, at: nowIso() };
}

// 派活前的统一判定：返回 ok / 原因，以及「本条该发哪种通知」（每个周期只发一次）。
export function checkQuota(db, agent, { now = new Date(), quota = {} } = {}) {
  const state = ensureQuota(db, agent, { now, quota });
  const stopRatio = quota.stopRatio ?? 1;
  const limit = state.limit;
  const stopAt = Math.max(1, Math.floor(limit * stopRatio));
  const period = state.period;

  if (state.used >= stopAt) {
    const first = !db.prepare('SELECT stopNotifiedAt FROM quotas WHERE agentId = ? AND period = ?')
      .get(agent.id, period).stopNotifiedAt;
    if (first) {
      db.prepare('UPDATE quotas SET stopNotifiedAt = ? WHERE agentId = ? AND period = ?')
        .run(nowIso(), agent.id, period);
    }
    return { ok: false, reason: `配额触顶 ${Math.round((state.used / limit) * 100)}%，停止派新活`, state, stopNow: first, warnNow: false };
  }
  if (state.used >= state.warnAt) {
    const first = !db.prepare('SELECT warnNotifiedAt FROM quotas WHERE agentId = ? AND period = ?')
      .get(agent.id, period).warnNotifiedAt;
    if (first) {
      db.prepare('UPDATE quotas SET warnNotifiedAt = ? WHERE agentId = ? AND period = ?')
        .run(nowIso(), agent.id, period);
    }
    return { ok: true, state, warnNow: first, stopNow: false };
  }
  return { ok: true, state, warnNow: false, stopNow: false };
}
