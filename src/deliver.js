// P7-5：验收通过后把产物复制到**项目自己的文件夹**（projects.<id>.rootDir）。
//
// 三条边界全部在代码里拦，不靠自觉：
//   1. 落点必须解析在 rootDir 之内 —— rootDir 没配 / 不存在 / subdir 带 .. 一律拒绝，宁可不落；
//   2. 只在这个目录里**新建**文件：不移动、不删除、不覆盖（同名加任务号后缀，由 deliver-copy 负责）；
//   3. 落盘失败不改卡的状态：只写审计和落盘清单，等维护心跳重试。
//
// 「什么时候落」由引擎决定（卡真正 done）；这里只管「落到哪、落了什么、没落成怎么办」。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyArtifacts } from './deliver-copy.js';
import { projectEntry } from './projects.js';

export const DELIVERY_SCHEMA = 'aicompany.delivery/v1';

export function deliveryLogPath(workRoot, id) {
  return path.join(workRoot, 'projects', id, 'deliveries.jsonl');
}

/**
 * 算出这一单该落到哪个目录。四个拒绝理由各有 code，审计里能看出来为什么没落。
 */
export function resolveDeliverDir({ config = {}, id, subdir = null } = {}) {
  const entry = projectEntry(config, id) ?? {};
  const rootDir = entry.rootDir ?? null;
  if (!rootDir) {
    return { ok: false, code: 'PROJECT_NO_ROOT_DIR', error: '这个项目没配 rootDir：产物只留在公司，由人自己取' };
  }
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch {
    // 盘符写错 / 文件夹被挪走时**不许自己创建**：那会在错的地方留下一串空目录。
    return { ok: false, code: 'ROOT_DIR_MISSING', error: `项目文件夹不存在：${rootDir}` };
  }
  try {
    if (!fs.statSync(rootReal).isDirectory()) {
      return { ok: false, code: 'ROOT_DIR_NOT_DIR', error: `rootDir 不是文件夹：${rootReal}` };
    }
  } catch {
    return { ok: false, code: 'ROOT_DIR_MISSING', error: `项目文件夹读不到：${rootDir}` };
  }
  const want = (subdir ?? entry.deliverSubdir ?? null) || null;
  const targetDir = want ? path.resolve(rootReal, String(want)) : rootReal;
  // 用 relative 判断而不是 startsWith：后者会把 D:/proj-evil 当成 D:/proj 的子目录。
  const rel = path.relative(rootReal, targetDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'TARGET_OUTSIDE_PROJECT', error: `落点跑到项目文件夹外面去了：${targetDir}` };
  }
  return { ok: true, rootDir: rootReal, targetDir, subdir: want };
}

/** 公司任务目录里这一单的产物（递归；name 是相对 output 的路径）。 */
export function listOutputFiles(workRoot, taskId) {
  const root = path.join(workRoot, 'tasks', taskId, 'output');
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.push({ name: path.relative(root, full).split(path.sep).join('/'), path: full });
      }
    }
  };
  walk(root);
  return files;
}

/** 落盘清单是追加写的 jsonl：项目里落了什么，一条一条可查。 */
export function appendDeliveryLog(workRoot, id, record) {
  const file = deliveryLogPath(workRoot, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

export function readDeliveryLog(workRoot, id) {
  let lines = [];
  try {
    lines = fs.readFileSync(deliveryLogPath(workRoot, id), 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过，不影响别的记录 */ }
  }
  return rows;
}

/** 某个任务最近一次落盘记录（没有就是 null）。 */
export function lastDeliveryOf(workRoot, id, taskId) {
  const rows = readDeliveryLog(workRoot, id).filter((r) => r.taskId === taskId);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * 落盘本体。返回 { ok, code, targetDir, copied, failed, logPath }，**不抛异常**。
 */
export function deliverTask({ workRoot, config = {}, task, subdir = null, at = null } = {}) {
  const id = task?.project;
  if (!id) return { ok: false, code: 'PROJECT_REQUIRED', error: '这个任务没有项目，不落盘' };
  const target = resolveDeliverDir({ config, id, subdir });
  if (!target.ok) return target;

  const files = listOutputFiles(workRoot, task.taskId);
  if (files.length === 0) {
    return { ok: false, code: 'NO_ARTIFACTS', error: 'output 目录里没有产物，没什么可落', targetDir: target.targetDir };
  }

  const result = copyArtifacts({ files, targetDir: target.targetDir, taskId: task.taskId });
  const record = {
    schema: DELIVERY_SCHEMA,
    taskId: task.taskId,
    project: id,
    at: at ?? new Date().toISOString(),
    targetDir: target.targetDir,
    subdir: target.subdir,
    copied: result.copied,
    failed: result.failed,
  };
  let logPath = null;
  try { logPath = appendDeliveryLog(workRoot, id, record); } catch { /* 清单写不进去不影响已落成的文件 */ }
  return {
    ok: result.copied.length > 0 && result.failed.length === 0,
    code: result.failed.length ? 'PARTIAL' : 'DELIVERED',
    targetDir: target.targetDir,
    copied: result.copied,
    failed: result.failed,
    logPath,
  };
}

/**
 * 落盘前的「别人正占着」检查：项目配置 deliverBlockers.processes 里列出的进程在跑就先不写。
 * 例：小王子项目的译台（YiTai*）开着时会锁住 04-译稿 里的文件。
 */
export function runningProcesses(patterns = []) {
  const wanted = (Array.isArray(patterns) ? patterns : []).filter((p) => typeof p === 'string' && p.trim());
  if (wanted.length === 0 || process.platform !== 'win32') return [];
  let out = '';
  try {
    out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
  } catch {
    return []; // 查不到进程就当没人占用：宁可落一次，也不要因为工具不可用而永远不落。
  }
  const names = [];
  for (const line of out.split(/\r?\n/)) {
    const hit = /^"([^"]+)"/.exec(line);
    if (hit) names.push(hit[1]);
  }
  const found = [];
  for (const pattern of wanted) {
    const rx = new RegExp(`^${pattern.trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*')}$`, 'i');
    const hit = names.find((n) => rx.test(n));
    if (hit) found.push(hit);
  }
  return found;
}
