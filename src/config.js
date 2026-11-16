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
  // P7：项目 id 直接当目录名用，必须是安全文件名；archiveDir 要跨盘，必须绝对路径。
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
        const archiveDir = entry?.archiveDir;
        if (archiveDir !== undefined && archiveDir !== null && archiveDir !== '') {
          if (typeof archiveDir !== 'string' || !path.isAbsolute(archiveDir)) {
            errors.push(`projects.${id}.archiveDir 必须是绝对路径（归档要写到公司文件夹之外）`);
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
  // G3：席位不写 maxDifficulty = 不设限；这里补默认值，避免下游每处都判 undefined。
  const agents = (config.agents || []).map((agent) => ({
    ...agent, maxDifficulty: ceilingOf(agent),
  }));
  // P7：项目配置补默认值（显示名、记忆条数）；archiveDir 不填就是「还没有授权归档目录」。
  const projects = Object.fromEntries(Object.entries(config.projects ?? {}).map(([id, entry]) => [id, {
    displayName: entry?.displayName ?? id,
    archiveDir: entry?.archiveDir ?? null,
    memoryLimit: entry?.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
  }]));
  return { ...config, agents, projects, interaction, quota, gates, decision, runPolicy };
}

export function doctor(config) {
  const checks = [];
  const agents = config.agents || [];
  checks.push({
    name: '唯一 CEO 席位',
    ok: agents.filter((a) => a.isCEO === true).length === 1,
    detail: agents.filter((a) => a.isCEO === true).map((a) => a.id).join(', ') || '无',
  });
  for (const agent of agents) {
    checks.push({
      name: `${agent.id}.adapter.type 已注册`,
      ok: ADAPTER_TYPES.includes(agent.adapter?.type),
      detail: String(agent.adapter?.type),
    });
  }
  checks.push({
    name: '汇报线不成环',
    ok: applyConfigRules(config).filter((e) => e.includes('成环') || e.includes('不存在')).length === 0,
    detail: agents.map((a) => `${a.id}→${a.reportsTo ?? '无'}`).join(', '),
  });
  checks.push({
    name: '零外部凭据可跑（web + noop）',
    ok: (config.clients || []).includes('web') && (config.notifier || []).includes('noop'),
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
