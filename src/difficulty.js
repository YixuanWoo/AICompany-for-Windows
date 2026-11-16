// G3：按难度分流。难度词汇、排序、席位上限，全部收在这一个文件里。
// 为什么单独一个文件：难度要同时被「任务卡 / 席位配置 / 路由 / 看板」用到，
// 各自写一遍字符串比较，迟早出现 easy / Easy / 简单 三种写法互不认识（任务书 §15.4）。

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);
const RANK = Object.freeze({ easy: 1, normal: 2, hard: 3 });

export const DEFAULT_DIFFICULTY = 'normal';
// 席位不写 maxDifficulty ＝ 不设限。老配置升级上来行为不变；
// 想限制某个岗位只接简单活，必须显式写 maxDifficulty: easy（不猜、不默认收窄）。
export const NO_CEILING = 'hard';

export class DifficultyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DifficultyError';
    this.kind = 'difficulty';
  }
}

export function difficultyRank(value) {
  return RANK[value] ?? 0;
}

// 归一化：空值走 fallback，非法值直接报错并列出可选值（不静默降级成 normal）。
export function normalizeDifficulty(value, { fallback = DEFAULT_DIFFICULTY, field = 'difficulty' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const key = String(value).trim().toLowerCase();
  if (!(key in RANK)) {
    throw new DifficultyError(`${field} 只能是 ${DIFFICULTIES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return key;
}

// 席位天花板。agent 可以是配置里的席位，也可以是库里那一行（列名 maxDifficulty）。
export function ceilingOf(agent) {
  const id = agent?.id ?? agent?.agentId ?? '席位';
  return normalizeDifficulty(agent?.maxDifficulty, { fallback: NO_CEILING, field: `${id}.maxDifficulty` });
}

export function canTake(agent, difficulty) {
  return difficultyRank(difficulty) <= difficultyRank(ceilingOf(agent));
}

export function describeSeat(agent) {
  return `${agent?.agentId ?? agent?.id}（≤ ${ceilingOf(agent)}）`;
}

export function describeDifficulty(difficulty) {
  return difficulty === 'easy' ? '简单' : (difficulty === 'hard' ? '困难' : '普通');
}
