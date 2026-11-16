// P7：项目层 —— 「公司是大脑，项目是工地」。
// 规范与记忆全部落在公司文件夹内（<workRoot>/projects/<id>/），项目文件夹只出交付物。
// 三条硬规矩：
//   1. 规范是人定的（本模块只读，不写规范）；
//   2. 记忆只有引擎写（员工只能通过报告「供料」，影响不了库结构）；
//   3. 校验不过的记忆不入库 —— 宁缺毋滥，写花了不污染库。

import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_SCHEMA = 'aicompany.memory/v1';
export const DEFAULT_MEMORY_LIMIT = 10;
export const MAX_MEMORY_ITEMS = 8;
export const MAX_MEMORY_ITEM_CHARS = 400;
// 项目 id 直接当目录名用，所以只允许「安全文件名」字符，且不许以 . / - 打头。
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class ProjectError extends Error {
  constructor(message, code = 'PROJECT_INVALID', extra = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function projectsDir(workRoot) {
  return path.join(workRoot, 'projects');
}

export function projectDir(workRoot, id) {
  return path.join(projectsDir(workRoot), id);
}

export function projectSpecPath(workRoot, id) {
  return path.join(projectDir(workRoot, id), 'project.yaml');
}

export function memoryPath(workRoot, id) {
  return path.join(projectDir(workRoot, id), 'knowledge', 'memory.jsonl');
}

export function configuredProjectIds(config = {}) {
  return Object.keys(config.projects ?? {});
}

export function projectEntry(config = {}, id) {
  return (config.projects ?? {})[id] ?? null;
}

export function memoryLimitOf(config = {}, id) {
  const limit = Number(projectEntry(config, id)?.memoryLimit ?? DEFAULT_MEMORY_LIMIT);
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_MEMORY_LIMIT;
}

export function readProjectSpec(workRoot, id) {
  const file = projectSpecPath(workRoot, id);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, text, path: file };
  } catch (error) {
    return { ok: false, text: '', path: file, error: `读不到项目规范：${file}（${error.message}）` };
  }
}

/**
 * 下单时的项目校验。**配置了项目就必选**，不留「猜一个」的余地：
 * 猜错项目的代价比让人多选一次大得多（产物会落到别人的工地上）。
 */
export function assertProject({ config = {}, workRoot, requested = null } = {}) {
  const ids = configuredProjectIds(config);
  if (ids.length === 0) return { ok: true, project: null, legacy: true };
  const id = requested === null || requested === undefined ? '' : String(requested).trim();
  if (!id) {
    throw new ProjectError(
      `下单必须指定项目（projects.${ids.join(' / projects.')}）；可用：${ids.join(', ')}`,
      'PROJECT_REQUIRED', { available: ids },
    );
  }
  if (!PROJECT_ID_RE.test(id) || !ids.includes(id)) {
    throw new ProjectError(`未知项目：${id}；可用：${ids.join(', ')}`, 'PROJECT_UNKNOWN', { available: ids });
  }
  const spec = readProjectSpec(workRoot, id);
  if (!spec.ok) {
    // 缺规范就别派活：没有规范的项目等于没有工地，派出去只会把产物写得到处都是。
    throw new ProjectError(`项目 ${id} 缺少规范文件：${spec.path}`, 'PROJECT_SPEC_MISSING', { path: spec.path });
  }
  return { ok: true, project: id, spec };
}

export function listProjects({ config = {}, workRoot } = {}) {
  return configuredProjectIds(config).map((id) => {
    const entry = projectEntry(config, id) ?? {};
    const spec = readProjectSpec(workRoot, id);
    const memory = readRecentMemory(workRoot, id, { limit: 0, countOnly: true });
    return {
      id,
      displayName: entry.displayName ?? id,
      memoryLimit: memoryLimitOf(config, id),
      // 落盘位置 = 项目文件夹本身；没配 rootDir 就是「产物只留在公司，人自己取」。
      rootDir: entry.rootDir ?? null,
      deliverSubdir: entry.deliverSubdir ?? null,
      specPath: spec.path,
      specExists: spec.ok,
      memoryCount: memory.count,
    };
  });
}

function cleanItems(value, field) {
  if (value === undefined || value === null) return { ok: true, items: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${field} 必须是字符串数组` };
  const items = [];
  for (const raw of value) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, error: `${field} 里出现了非字符串项` };
    const text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    items.push(text.slice(0, MAX_MEMORY_ITEM_CHARS));
    if (items.length >= MAX_MEMORY_ITEMS) break;
  }
  return { ok: true, items };
}

/**
 * 把「员工交差的报告」整理成一条记忆。**只允许影响这一条**：
 * taskId / 项目 / 时间 / 产物 / 难度这些元数据一律由引擎补，报告里写了也不采信。
 */
export function buildMemoryRecord({ task, report, agentId = null, at = new Date().toISOString() } = {}) {
  const project = task?.project ?? null;
  if (!project) return { ok: false, error: '任务没有项目，不入项目记忆' };
  const feed = report?.usage?.memoryFeed ?? {};
  const lessons = cleanItems(feed.lessons, 'lessons');
  if (!lessons.ok) return { ok: false, error: lessons.error };
  const nextHints = cleanItems(feed.nextHints, 'nextHints');
  if (!nextHints.ok) return { ok: false, error: nextHints.error };

  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts.slice(0, 20).map(String) : [];
  return {
    ok: true,
    record: {
      schema: MEMORY_SCHEMA,
      taskId: task.taskId,
      project,
      title: String(task.title ?? '').slice(0, 200),
      agent: agentId ?? null,
      difficulty: task.difficulty ?? 'normal',
      finishedAt: at,
      summary: String(report?.summary ?? '').slice(0, 600),
      artifacts,
      lessons: lessons.items,
      nextHints: nextHints.items,
    },
  };
}

export function appendMemory(workRoot, id, record) {
  const file = memoryPath(workRoot, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 一行一条：人可以直接打开看，坏掉一行也只影响那一行（读取时跳过）。
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

export function readRecentMemory(workRoot, id, { limit = DEFAULT_MEMORY_LIMIT, countOnly = false } = {}) {
  const file = memoryPath(workRoot, id);
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return { count: 0, entries: [] };
  }
  if (countOnly) return { count: lines.length, entries: [] };
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < Math.max(0, limit); i -= 1) {
    try { entries.push(JSON.parse(lines[i])); } catch { /* 坏行跳过，不影响别的条目 */ }
  }
  return { count: lines.length, entries: entries.reverse() };
}

/**
 * 派活时塞进 brief 的那一段。没有规范 / 没有记忆时**该段省略**，不写空标题占位。
 */
export function buildProjectContext({ workRoot, config = {}, id, limit = null } = {}) {
  if (!id) return null;
  const entry = projectEntry(config, id) ?? {};
  const spec = readProjectSpec(workRoot, id);
  const take = limit === null ? memoryLimitOf(config, id) : limit;
  const memory = readRecentMemory(workRoot, id, { limit: take });
  const blocks = [];
  if (spec.ok && spec.text.trim()) {
    // 规范文件里的注释是写给人看的（怎么改、为什么这么定），不必塞进提示词：
    // 既占篇幅又容易和「必须遵守」混淆。只留实际生效的键值。
    const body = spec.text.split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body) {
      blocks.push([
        `【项目规范】${entry.displayName ?? id}（${id}）`,
        '以下是这个项目的固定规矩，必须遵守；与本 brief 其它内容冲突时以本节为准。',
        body,
      ].join('\n'));
    }
  }
  if (memory.entries.length) {
    const lines = [memory.entries.length === 1
      ? '【相关经验】本项目最近 1 条任务（前人踩过的坑，开工前先看）'
      : `【相关经验】本项目最近 ${memory.entries.length} 条任务（前人踩过的坑，开工前先看）`];
    memory.entries.forEach((rec, i) => {
      const when = String(rec.finishedAt ?? '').slice(0, 10);
      lines.push(`${i + 1}. [${when}] ${rec.taskId}｜${rec.summary || rec.title || '(无摘要)'}`);
      if (rec.lessons?.length) lines.push(`   教训：${rec.lessons.join('；')}`);
      if (rec.nextHints?.length) lines.push(`   下次：${rec.nextHints.join('；')}`);
    });
    blocks.push(lines.join('\n'));
  }
  return {
    id,
    specPath: spec.path,
    specLoaded: spec.ok,
    memoryCount: memory.count,
    contextText: blocks.join('\n\n'),
  };
}
