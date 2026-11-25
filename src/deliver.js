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

// 交付过滤（2026-11-23 维护）：output/ 是工作区，不只放真产物 —— 一次性脚本、控制面文件、
// 校验/调试输出都会混在里面。整批复制会把它们灌进项目目录（真机：04-out 被倒进
// build_ch15_chujiao.py、completion.json、report.md、预览图，人清了两轮还会再被灌）。
// 所以落项目之前先过一道：被挡下的不复制，但写进 skipped 台账，绝不静默丢。
const CONTROL_FILE_NAMES = new Set([
  'completion.json', 'completion.plan.json', 'report.draft.json', 'report.md',
  'progress.json', 'run-progress.json', 'run-heartbeat.json', 'dispatch.json',
  'stop.json', 'blocked.json', 'out-of-scope.json', 'task.json', 'brief.md', 'ack.md',
]);
const SCRIPT_EXTENSIONS = new Set([
  '.py', '.ps1', '.bat', '.cmd', '.sh', '.js', '.mjs', '.cjs', '.ts', '.exe', '.dll',
]);
// 校验 / 调试类输出：是「怎么证明干完了」的旁证，不是交付物本身。
const TOOL_OUTPUT_RE = /^(verify[-_]?|cmp_|check_|chk|debug_|probe_|diag_)/i;

export function deliverableOf(name) {
  const base = String(name).split('/').pop();
  if (CONTROL_FILE_NAMES.has(base)) return { ok: false, reason: '控制面文件，不进项目' };
  const ext = path.extname(base).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) return { ok: false, reason: `脚本/可执行文件（${ext}），不进项目` };
  if (TOOL_OUTPUT_RE.test(base)) return { ok: false, reason: '校验/调试输出，不进项目' };
  return { ok: true };
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
export function deliverTask({ workRoot, config = {}, task, subdir = null, at = null, report = null } = {}) {
  const id = task?.project;
  if (!id) return { ok: false, code: 'PROJECT_REQUIRED', error: '这个任务没有项目，不落盘' };
  const target = resolveDeliverDir({ config, id, subdir });
  if (!target.ok) return target;

  // 2026-11-23 落盘改造：completion.artifacts 是**绝对路径**说明产物已经按项目规矩
  // 落进项目目录（manifest 模式），这时不再从 output/ 复制一份过去 —— 复制只会造出
  // 双份产物，还把脚本与校验文件灌进项目文件夹（T-d396e200 / T-d22d97ae 事故）。
  // 这里只核验「确实在落点内、确实存在」并写台账。相对路径（output/...）仍走旧的复制路径。
  const declared = Array.isArray(report?.artifacts) ? report.artifacts.map((x) => String(x)) : [];
  if (declared.length && declared.every((a) => path.isAbsolute(a))) {
    const files = [];
    const failed = [];
    for (const a of declared) {
      const abs = path.resolve(a);
      const rel = path.relative(target.targetDir, abs);
      const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      let st = null;
      try { st = fs.statSync(abs); } catch { st = null; }
      if (!inside) { failed.push({ name: a, reason: '不在本单落点内，拒绝记账' }); continue; }
      if (!st?.isFile() || st.size === 0) { failed.push({ name: a, reason: '不存在或为空' }); continue; }
      files.push({
        artifact: a.replace(/\\/g, '/'),
        bytes: st.size,
        sha256: report?.checksum?.[a] ?? report?.checksum?.[a.replace(/\\/g, '/')] ?? null,
      });
    }
    const record = {
      schema: DELIVERY_SCHEMA,
      taskId: task.taskId,
      project: id,
      at: at ?? new Date().toISOString(),
      targetDir: target.targetDir,
      subdir: target.subdir,
      mode: 'in-place',
      copied: [], failed, files, skipped: [],
    };
    let logPath = null;
    try { logPath = appendDeliveryLog(workRoot, id, record); } catch { /* 清单写不进去不影响已落成的文件 */ }
    if (!files.length) {
      return {
        ok: false, code: 'DELIVERY_INCOMPLETE', targetDir: target.targetDir,
        copied: [], failed, files, mode: 'in-place', logPath,
        error: 'deliverables 没有一条落在本单落点内',
      };
    }
    return { ok: true, code: 'DELIVERED', targetDir: target.targetDir, copied: [], failed, files, mode: 'in-place', logPath };
  }

  const scanned = listOutputFiles(workRoot, task.taskId);
  const skipped = [];
  const files = [];
  for (const f of scanned) {
    const verdict = deliverableOf(f.name);
    if (verdict.ok) files.push(f);
    else skipped.push({ name: f.name, reason: verdict.reason });
  }
  if (files.length === 0) {
    return {
      ok: false, code: 'NO_ARTIFACTS', targetDir: target.targetDir, skipped,
      error: scanned.length
        ? `output 里 ${scanned.length} 个文件全是脚本/控制面/校验输出，没有可交付产物（详见 skipped）`
        : 'output 目录里没有产物，没什么可落',
    };
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
    skipped,
  };
  let logPath = null;
  try { logPath = appendDeliveryLog(workRoot, id, record); } catch { /* 清单写不进去不影响已落成的文件 */ }
  return {
    ok: result.copied.length > 0 && result.failed.length === 0,
    code: result.failed.length ? 'PARTIAL' : 'DELIVERED',
    targetDir: target.targetDir,
    copied: result.copied,
    failed: result.failed,
    skipped,
    logPath,
  };
}

/**
 * 落盘前的「别人正占着」检查：项目配置 deliverBlockers.processes 里列出的进程在跑就先不写。
 * 例：目标项目被某个独占进程占用时，会锁住交付目录里的文件。
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
