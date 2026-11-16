// P4-3 / P4-7：汇报线（组织树）解析。代码里不写死任何席位，全部由 company.yaml 决定。
// 规则：① 汇报线不得成环（配置加载时已校验）；② 派活只能派给自己的汇报子树；
// ③ 决策者沿 reportsTo 向上找，优先有 review 能力的上级，最终落 CEO（任务书 §7.4 / §6C.4）。

import { canTake, ceilingOf, difficultyRank } from './difficulty.js';

export function ceoOf(config) {
  return config.agents.find((a) => a.isCEO === true)?.id ?? null;
}

export function agentMap(config) {
  return new Map(config.agents.map((a) => [a.id, a]));
}

// 某人及其所有下级。
export function subtreeOf(config, agentId) {
  const out = new Set([agentId]);
  let added = true;
  while (added) {
    added = false;
    for (const agent of config.agents) {
      if (agent.reportsTo && out.has(agent.reportsTo) && !out.has(agent.id)) {
        out.add(agent.id);
        added = true;
      }
    }
  }
  return out;
}

// 自己是自己的上级也算合法（给自己派活不越级）。
export function isInSubtree(config, managerId, agentId) {
  return subtreeOf(config, managerId).has(agentId);
}

export function assertMayAssign(config, managerId, agentId) {
  if (managerId === agentId) return { ok: true };
  if (!agentMap(config).has(agentId)) return { ok: false, reason: `席位不存在：${agentId}` };
  if (!isInSubtree(config, managerId, agentId)) {
    return { ok: false, reason: `${managerId} 只能给汇报子树内的岗位派活，${agentId} 不在其子树内` };
  }
  return { ok: true };
}

// 沿 reportsTo 向上找决策者：第一个带 review / delegate / plan 能力的上级；找不到就落 CEO。
// 注意：从「自己的上级」开始找，不是从自己开始 —— 自己是执行席位时不该给自己拍板。
export function resolveDecisionMaker(config, agentId, { prefer = null } = {}) {
  const byId = agentMap(config);
  const ceo = ceoOf(config);
  if (prefer && byId.has(prefer)) {
    // requestedDecisionBy 只是建议，仍必须在该席位的汇报链上，否则不采纳（不越级找外人拍板）。
    if (prefer === ceo || ancestors(config, agentId).includes(prefer)) return prefer;
  }
  const self = byId.get(agentId);
  let cursor = self?.reportsTo ? byId.get(self.reportsTo) : null;
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.isCEO === true) return cursor.id;
    if ((cursor.capabilities ?? []).some((c) => ['review', 'delegate', 'plan'].includes(c))) return cursor.id;
    cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : null;
  }
  return ceo;
}

export function ancestors(config, agentId) {
  const byId = agentMap(config);
  const out = [];
  let cursor = byId.get(agentId);
  const seen = new Set();
  while (cursor?.reportsTo && !seen.has(cursor.reportsTo)) {
    seen.add(cursor.reportsTo);
    out.push(cursor.reportsTo);
    cursor = byId.get(cursor.reportsTo);
  }
  return out;
}

// §6C.4 ③：默认只排序、不替人决定；要系统挑必须显式 autoAssign: true。
// G3：给了 difficulty 就先按「这个岗位接不接得了」筛，再按「刚够用」优先排——
// 简单活不该烧强席位（ceiling 小的先），硬活自然只剩强席位能选。
export function rankCandidates(candidates, { needCapability = null, difficulty = null } = {}) {
  return [...candidates]
    .filter((c) => c.status === 'active' && !c.isCEO)
    .filter((c) => !needCapability || c.capabilities.includes(needCapability))
    .filter((c) => !difficulty || canTake(c, difficulty))
    .map((c) => {
      const limit = c.quotaLimit || 1;
      const remaining = Math.max(0, limit - (c.quotaUsed ?? 0));
      return {
        ...c,
        remaining, ratio: remaining / limit,
        ceiling: ceilingOf(c),
        ceilingRank: difficultyRank(ceilingOf(c)),
      };
    })
    .sort((a, b) => {
      // 先看「还有没有额度」：没额度的席位排在后面（否则「刚够用」优先会把活推给一个已经停派的席位，
      // 明明旁边有能接的，结果整单派不出去）。
      const aHas = a.remaining > 0 ? 1 : 0;
      const bHas = b.remaining > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (difficulty && aHas) {
        const byCeiling = a.ceilingRank - b.ceilingRank;
        if (byCeiling !== 0) return byCeiling;
      }
      return (b.ratio - a.ratio) || String(a.agentId).localeCompare(String(b.agentId));
    });
}
