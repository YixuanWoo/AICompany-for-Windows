// 配置加载：YAML → ${ENV} 插值 → schema 校验 → 业务规则 → 归一化 → doctor。
// 依据：任务书 §6B.4 / §6B.9 / §6C.2 / §6C.7 / §7.4 / §18 D8。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml-lite.js';
import { validateAgainstSchema } from './schema-validator.js';
import { readOverrides, applyOverrides } from './tune.js';
import { ADAPTER_TYPES, CLIENT_TYPES, NOTIFIER_TYPES, DEFAULTS, isPlainObject } from './enums.js';
import { ceilingOf } from './difficulty.js';
import { PROJECT_ID_RE, DEFAULT_MEMORY_LIMIT, projectSpecPath, readProjectSpec } from './projects.js';
import { normalizeRepos } from './repos.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EXAMPLE_CONFIG_PATH = path.join(ROOT, 'config', 'company.example.yaml');
export const COMPANY_SCHEMA_PATH = path.join(ROOT, 'config', 'company.schema.json');
export const CONFIG_SCHEMA = JSON.parse(fs.readFileSync(COMPANY_SCHEMA_PATH, 'utf8'));
// P5-2：试运行期调参不回写 YAML（保住用户手写的注释与顺序），单独落一份覆盖文件。
export const OVERRIDES_PATH = path.join(ROOT, 'config', 'runtime-overrides.json');

export class ConfigError extends Error {
  constructor(message, code = 'CONFIG_INVALID') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export function interpolate(value, env, missing = []) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (full, name) => {
      const replacement = env[name];
      if (replacement === undefined || replacement === '') {
        missing.push(name);
        return full;
      }
      return String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env, missing));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, missing)]));
  }
  return value;
}

export function applyConfigRules(config) {
  const errors = [];
  const agents = Array.isArray(config.agents) ? config.agents : [];
  const ids = agents.map((a) => a.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length) errors.push(`agent.id 重复：${[...new Set(duplicates)].join(', ')}`);
  for (const id of ids) {
    if (['human', 'system'].includes(id)) errors.push(`agent.id 不得占用保留字：${id}`);
  }

  const ceos = agents.filter((a) => a.isCEO === true);
  if (ceos.length !== 1) errors.push(`必须恰好有一个 isCEO: true 的席位，当前 ${ceos.length} 个`);
  const ceoId = ceos[0]?.id;

  const interaction = config.interaction || {};
  if (interaction.defaultTarget && interaction.defaultTarget !== ceoId) {
    errors.push(`interaction.defaultTarget 必须解析为唯一 isCEO 席位的 id（${ceoId}），不得写死其它值`);
  }

  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const agent of agents) {
    if (agent.reportsTo && !byId.has(agent.reportsTo)) {
      errors.push(`${agent.id}.reportsTo 指向不存在的席位：${agent.reportsTo}`);
    }
    // P4-5：救火席位必须真实存在，且不能指向自己（否则返工升级会原地打转）。
    if (agent.escalationTo !== undefined && agent.escalationTo !== null) {
      if (!byId.has(agent.escalationTo)) {
        errors.push(`${agent.id}.escalationTo 指向不存在的席位：${agent.escalationTo}`);
      } else if (agent.escalationTo === agent.id) {
        errors.push(`${agent.id}.escalationTo 不能指向自己`);
      }
    }
    const seen = new Set();
    let cursor = agent;
    while (cursor && cursor.reportsTo) {
      if (seen.has(cursor.id)) {
        errors.push(`汇报线成环，涉及席位 ${cursor.id}`);
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.reportsTo);
    }
    const type = agent.adapter?.type;
    if (!ADAPTER_TYPES.includes(type)) {
      errors.push(`${agent.id}.adapter.type 未注册：${String(type)}；可用类型：${ADAPTER_TYPES.join(', ')}（拒绝启动，不静默降级）`);
    }
  }

  for (const client of config.clients || []) {
    if (!CLIENT_TYPES.includes(client)) errors.push(`未知 clients 项：${client}`);
  }
  for (const notifier of config.notifier || []) {
    if (!NOTIFIER_TYPES.includes(notifier)) errors.push(`未知 notifier 项：${notifier}`);
  }
  // P7：项目 id 直接当目录名用，必须是安全文件名；rootDir 是「项目文件夹在你磁盘上的位置」，要跨盘，必须绝对路径。
  const projects = config.projects;
  if (projects !== undefined) {
    if (!isPlainObject(projects)) {
      errors.push('projects 必须是「项目 id → 配置」的对象');
    } else {
      for (const [id, entry] of Object.entries(projects)) {
        if (!PROJECT_ID_RE.test(id)) {
          errors.push(`projects.${id}：项目 id 只能是小写字母 / 数字 / - / _，且以字母数字开头（它会被当成目录名）`);
        }
        if (entry !== null && entry !== undefined && !isPlainObject(entry)) {
          errors.push(`projects.${id} 必须是对象或留空`);
          continue;
        }
        // P7：项目文件夹在哪 = 产物落哪（填了就是授权，不再单独授权一个目录）。
        const rootDir = entry?.rootDir;
        if (rootDir !== undefined && rootDir !== null && rootDir !== '') {
          if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
            errors.push(`projects.${id}.rootDir 必须是绝对路径（它是这个项目文件夹的位置）`);
          }
        }
        // 子目录只能挂在项目文件夹下面：绝对路径或 .. 会把产物写到项目之外，一律拒绝。
        const subdir = entry?.deliverSubdir;
        if (subdir !== undefined && subdir !== null && subdir !== '') {
          if (typeof subdir !== 'string' || path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes('..')) {
            errors.push(`projects.${id}.deliverSubdir 只能是项目文件夹下的相对子目录（不能绝对路径、不能带 ..）`);
          }
        }
        // 落盘前的占用检查：这些进程在跑就先不写（例：译台开着会锁住译稿）。
        const blockers = entry?.deliverBlockers;
        if (blockers !== undefined) {
          if (!Array.isArray(blockers) || blockers.some((b) => typeof b !== 'string' || !b.trim())) {
            errors.push(`projects.${id}.deliverBlockers 必须是字符串数组（进程名，可以带 * 通配）`);
          }
        }
        const limit = entry?.memoryLimit;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > 50)) {
          errors.push(`projects.${id}.memoryLimit 必须是 0–50 的整数`);
        }
      }
    }
  }
  return errors;
}

// 两层席位模型（2026-11-16 定）：
//   holders = 担任者，真的是一个 agent（或一个程序），必须有 name 和 adapter；
//   posts   = 岗位，席位的名字，必须有 title，并写 heldBy 指向某个 holder。
// 同一个 agent 可以担任多个岗位：为每个岗位复制一份 adapter 配置，
// 岗位可用 adapterConfig 覆盖参数（例：同一个 agent 在「总经理」岗走 ceo 模式，在「执行」岗走普通模式）。
// 老配置（只有 agents、没有 posts）原样放行：那种写法里岗位和担任者是一一对应的。
export function expandPostsAndHolders(data) {
  const posts = Array.isArray(data?.posts) ? data.posts : null;
  if (!posts) return data;
  const holders = Array.isArray(data.holders) ? data.holders : [];
  const byId = new Map();
  for (const h of holders) {
    if (!h?.id) throw new ConfigError('holders 每一项都必须写 id', 'CONFIG_INVALID');
    if (!h.name) throw new ConfigError(`holders.${h.id} 必须写 name（这个 agent 的名字，一看就知道谁干）`, 'CONFIG_INVALID');
    if (!h.adapter?.type) throw new ConfigError(`holders.${h.id} 缺 adapter（这个 agent 怎么调用）`, 'CONFIG_INVALID');
    byId.set(h.id, h);
  }
  const agents = posts.map((p) => {
    if (!p?.id) throw new ConfigError('posts 每一项都必须写 id（岗位 id）', 'CONFIG_INVALID');
    if (!p.title) throw new ConfigError(`posts.${p.id} 必须写 title（岗位名称，一看就知道干啥）`, 'CONFIG_INVALID');
    const h = byId.get(p.heldBy);
    if (!h) throw new ConfigError(`posts.${p.id}.heldBy=${String(p.heldBy)} 在 holders 里找不到`, 'CONFIG_INVALID');
    return {
      id: p.id,
      post: p.title,
      holder: h.name,
      holderId: h.id,
      holderKind: h.kind ?? null,
      displayName: p.title,
      isCEO: p.isCEO === true,
      capabilities: p.capabilities ?? h.capabilities ?? ['execute'],
      status: p.status ?? h.status ?? 'active',
      quotaDaily: p.quotaDaily ?? h.quotaDaily ?? 20,
      reportsTo: p.reportsTo ?? null,
      escalationTo: p.escalationTo ?? null,
      // 岗位说明书：给提示词用，不进任何校验逻辑。
      ...(p.duties ? { duties: String(p.duties) } : {}),
      ...(Array.isArray(p.boundaries) && p.boundaries.length ? { boundaries: p.boundaries.map(String) } : {}),
      ...(Array.isArray(p.mayDelegateTo) && p.mayDelegateTo.length ? { mayDelegateTo: p.mayDelegateTo.map(String) } : {}),
      ...(p.maxDifficulty ? { maxDifficulty: p.maxDifficulty } : {}),
      adapter: {
        ...h.adapter,
        config: { ...(h.adapter?.config ?? {}), ...(p.adapterConfig ?? {}) },
      },
      // 派活方式：push = 控制面直调 adapter（默认）；pull = 卡留在队列，由席位自己来领。
      // 交互式 agent（人叫才醒、没有常驻进程）只能走 pull，否则引擎会在它不在的时候派活。
      dispatch: p.dispatch ?? h.dispatch ?? 'push',
    };
  });
  return { ...data, agents };
}

export function normalizeConfig(config) {
  const interaction = { ...(config.interaction || {}) };
  interaction.defaultMode = interaction.defaultMode ?? DEFAULTS.defaultMode;
  interaction.autoAssign = interaction.autoAssign ?? DEFAULTS.autoAssign;
  interaction.defaultTarget = config.agents.find((a) => a.isCEO === true)?.id ?? interaction.defaultTarget;
  interaction.meeting = { ...(interaction.meeting || {}) };
  interaction.meeting.fullRequiresConfirm = interaction.meeting.fullRequiresConfirm ?? DEFAULTS.fullRequiresConfirm;
  interaction.meeting.defaultStyle = interaction.meeting.defaultStyle ?? 'rollCall';
  interaction.thread = { ...(interaction.thread || {}) };
  interaction.thread.ttlDays = interaction.thread.ttlDays ?? DEFAULTS.ttlDays;
  interaction.thread.promoteRequiresExplicit = interaction.thread.promoteRequiresExplicit ?? DEFAULTS.promoteRequiresExplicit;
  // 总经理会话复用：共用一个会话才能命中前缀缓存（按量计费席位省的是真钱）。
  // warnTurns 到点提醒董事会换新，maxTurns 到点自动换；reuse=false 回到「每轮新会话」的旧行为。
  interaction.ceoSession = { ...(interaction.ceoSession || {}) };
  interaction.ceoSession.reuse = interaction.ceoSession.reuse ?? true;
  interaction.ceoSession.warnTurns = interaction.ceoSession.warnTurns ?? 30;
  interaction.ceoSession.maxTurns = interaction.ceoSession.maxTurns ?? 60;
  // P4-1：配额阈值可配，默认 80% 预警、100% 停派。
  const quota = { ...(config.quota || {}) };
  quota.warnRatio = quota.warnRatio ?? DEFAULTS.warnRatio;
  quota.stopRatio = quota.stopRatio ?? DEFAULTS.stopRatio;
  quota.periodHours = quota.periodHours ?? 24;
  // P4-2：门禁默认全关，保持老配置行为不变（不配就是旧行为）。
  const gates = { strategy: false, hiringBudget: false, ...(config.gates || {}) };
  const decision = {
    remindAfterHours: config.decision?.remindAfterHours ?? DEFAULTS.decisionRemindHours,
    maxPendingHours: config.decision?.maxPendingHours ?? DEFAULTS.decisionMaxPendingHours,
  };
  // P5：Run Policy 第 4 条的「并发上限 + 冷却」原来只有硬编码值，现在可配、可调、可观测。
  const runPolicy = {
    maxConcurrent: config.runPolicy?.maxConcurrent ?? DEFAULTS.maxConcurrent,
    cooldownSec: config.runPolicy?.cooldownSec ?? DEFAULTS.cooldownSec,
    maxRunHours: config.runPolicy?.maxRunHours ?? DEFAULTS.maxRunHours,
    staleEventMinutes: config.runPolicy?.staleEventMinutes ?? DEFAULTS.staleEventMinutes,
  };
  // 席位与担任者是两件事，必须分开写清楚：
  //   post   = 岗位名（总经理 / 执行），席位本身的名字，稳定不变
  //   holder = 由谁担任这个岗位（桌面应用名 / 8080 上的 agent 名），换人只改这里
  // 老配置没这两项时退回 displayName，行为与以前一致（不逼着一次性全改）。
  const agents = (config.agents || []).map((agent) => {
    const post = String(agent.post ?? '').trim() || null;
    const holderRaw = agent.holder;
    const holder = holderRaw == null
      ? null
      : (typeof holderRaw === 'string' ? { name: holderRaw } : holderRaw);
    const holderName = String(holder?.name ?? '').trim() || null;
    const holderKind = String(holder?.kind ?? agent.holderKind ?? '').trim() || null;
    return {
      ...agent,
      // 只在有值时才落字段：老配置不写这两项，就不该在 config 里凭空多出 null（会过不了 schema）。
      ...(post ? { post } : {}),
      ...(holderName ? { holderName } : {}),
      ...(holderKind ? { holderKind } : {}),
      postTitle: post ?? agent.displayName ?? agent.id,
      // 显示名默认 = 岗位名。担任者单独放 holderName，绝不把 agent 名当席位名。
      displayName: agent.displayName ?? post ?? agent.id,
      maxDifficulty: ceilingOf(agent),
    };
  });
  // P7：项目配置补默认值（显示名、记忆条数、落盘位置）。
  // rootDir 有值 = 验收通过后产物落到那里（填了就是授权）；没填 = 产物只在公司任务目录里，由人自己取。
  const projects = Object.fromEntries(Object.entries(config.projects ?? {}).map(([id, entry]) => [id, {
    displayName: entry?.displayName ?? id,
    rootDir: entry?.rootDir ?? null,
    deliverSubdir: entry?.deliverSubdir ?? null,
    deliverBlockers: entry?.deliverBlockers ?? [],
    memoryLimit: entry?.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
  }]));
  // 仓库台账：与项目解耦的一等对象（一个项目可以没有仓库，一个仓库也可以不属于任何项目）。
  // 配错了在这里就炸掉，不要等到派活时才发现推错地方。
  let repos = {};
  try {
    repos = normalizeRepos(config.repos);
  } catch (error) {
    throw new ConfigError(`仓库台账配置有误：${error.message}`, 'CONFIG_INVALID');
  }
  // 产物政策：代码归谁审、默认走哪条交付路径。
  const artifacts = {
    // 受管代码默认交给谁审（岗位 id）。
    defaultReviewer: config.artifacts?.defaultReviewer ?? 'engineering',
    // 认不出发布者时（老数据 / policy）怎么走。
    // 正常卡不看这个：董事会派的 → 落盘；上级 agent 派的 → 回上级审。这是「谁发布谁负责」。
    //   byAssigner = 按发布者推导（默认，推荐）
    //   ceo        = 一律请总经理验收（最保守，费 CEO 额度）
    //   land       = 一律直接落盘（最省，但没人把关）
    defaultHandoff: ['byAssigner', 'ceo', 'land'].includes(config.artifacts?.defaultHandoff)
      ? config.artifacts.defaultHandoff
      : 'byAssigner',
    // 判成受管代码却没写 repo：默认拒绝交活（宁肯打回，也不让代码流到没人管的地方）。
    requireRepoForManagedCode: config.artifacts?.requireRepoForManagedCode !== false,
    // 哪些扩展名算「代码」：执行岗没写 artifactKind 时用来兜底判断。
    codeExtensions: Array.isArray(config.artifacts?.codeExtensions) && config.artifacts.codeExtensions.length
      ? config.artifacts.codeExtensions.map((x) => String(x).toLowerCase())
      : ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat', '.rs', '.go', '.java', '.cs', '.sql'],
  };
  return {
    ...config, agents, projects, interaction, quota, gates, decision, runPolicy, repos, artifacts,
  };
}

export function doctor(config) {
  const checks = [];
  const agents = config.agents || [];
  checks.push({
    name: '唯一总经理岗',
    ok: agents.filter((a) => a.isCEO === true).length === 1,
    detail: agents.filter((a) => a.isCEO === true).map((a) => a.postTitle ?? a.id).join(', ') || '无',
  });
  // 岗位 / 担任者分离：只要有一个席位写了 post，就要求全部写清，避免「有的写岗位有的写人名」这种半新半旧。
  if (agents.some((a) => a.post != null)) {
    checks.push({
      name: '每个席位都写明岗位与担任者',
      ok: agents.every((a) => a.post != null && a.holderName != null),
      detail: agents.map((a) => `${a.id}: ${a.postTitle ?? '（缺岗位）'} / ${a.holderName ?? '（缺担任者）'}`).join('；'),
    });
  }
  for (const agent of agents) {
    checks.push({
      name: `${agent.id}.adapter.type 已注册`,
      ok: ADAPTER_TYPES.includes(agent.adapter?.type),
      detail: String(agent.adapter?.type),
    });
  }
  // 同一 agent 兼任多岗是允许的（用户明确要求）：体检要把它说清楚，
  // 否则看板上两个岗位、实际只有一个 agent，人会误以为买了两份。
  const byHolder = new Map();
  for (const a of agents) {
    if (!a.holderId) continue;
    byHolder.set(a.holderId, [...(byHolder.get(a.holderId) ?? []), a.postTitle ?? a.id]);
  }
  const shared = [...byHolder.entries()].filter(([, posts]) => posts.length > 1);
  checks.push({
    name: '担任者复用（一个 agent 可兼多岗）',
    ok: true,
    detail: shared.length
      ? shared.map(([holder, posts]) => `${holder} 兼任 ${posts.join('、')}`).join('；')
      : '每个岗位各由一名担任者，无兼任',
  });
  checks.push({
    name: '汇报线不成环',
    ok: applyConfigRules(config).filter((e) => e.includes('成环') || e.includes('不存在')).length === 0,
    detail: agents.map((a) => `${a.id}→${a.reportsTo ?? '无'}`).join(', '),
  });
  checks.push({
    name: '零外部凭据可跑（只用本地通道）',
    // 本地通道：web（看板）/ noop / stdout / desktop（桌面气泡）。im 与 webhook 要外部地址，不算。
    ok: (config.clients || []).includes('web')
      && (config.notifier || []).every((n) => ['web', 'noop', 'stdout', 'desktop'].includes(n)),
    detail: `clients=${(config.clients || []).join('+')} notifier=${(config.notifier || []).join('+')}`,
  });
  // P7：配了项目就得有规范文件——没有规范的「项目」派活时会被拒，不如启动时就说清。
  const projectIds = Object.keys(config.projects ?? {});
  if (projectIds.length) {
    const bad = config.workRoot
      ? projectIds.filter((id) => !readProjectSpec(config.workRoot, id).ok)
      : [];
    checks.push({
      name: '每个项目都有 project.yaml',
      ok: bad.length === 0,
      detail: config.workRoot
        ? (bad.length ? `缺规范：${bad.join(', ')}` : `${projectIds.length} 个项目齐备（${projectIds.join(', ')}）`)
        : `未配 workRoot，跳过文件检查（${projectIds.join(', ')}）`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export function loadConfig(configPath = EXAMPLE_CONFIG_PATH, env = process.env, options = {}) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`读不到配置文件：${configPath}（${error.message}）`, 'CONFIG_NOT_FOUND');
  }
  const raw = parseYaml(text);
  const missing = [];
  let data = interpolate(raw, env, missing);
  if (missing.length) {
    // 缺环境变量直接失败，且全程只读，不创建任何文件 / 数据库。
    throw new ConfigError(`缺少必需环境变量：${[...new Set(missing)].join(', ')}`, 'ENV_MISSING');
  }
  // P5-2：运行时调参覆盖层，在 schema 校验之前合并，所以非法覆盖同样会被拦住。
  const overridesPath = options.overridesPath === undefined ? OVERRIDES_PATH : options.overridesPath;
  let overrides = {};
  if (overridesPath) overrides = readOverrides(overridesPath);
  if (Object.keys(overrides).length) {
    const { agentQuotaDaily, ...plain } = overrides;
    data = applyOverrides(data, plain);
    if (agentQuotaDaily && typeof agentQuotaDaily === 'object') {
      data = {
        ...data,
        agents: (data.agents ?? []).map((a) => (
          agentQuotaDaily[a.id] === undefined ? a : { ...a, quotaDaily: agentQuotaDaily[a.id] }
        )),
      };
    }
  }
  // 两层模型：posts + holders 合成出引擎用的 agents（岗位 id 作 agentId，adapter 沿用担任者的）。
  // 必须在 schema 校验之前做——新配置里可能只写 posts、不写 agents。老配置没有 posts，这一步是空操作。
  data = expandPostsAndHolders(data);
  const structural = validateAgainstSchema(CONFIG_SCHEMA, data);
  const ruleErrors = applyConfigRules(data);
  const errors = [
    ...structural.errors.map((e) => `${e.path}: ${e.message}`),
    ...ruleErrors,
  ];
  if (errors.length) throw new ConfigError(`配置校验失败：\n${errors.join('\n')}`, 'CONFIG_INVALID');
  const config = normalizeConfig(data);
  return { config, doctor: doctor(config), source: configPath, overrides };
}
