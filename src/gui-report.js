// P3-4：文件轮询 + schema 校验 + checksum。
// 第一原则（§6.6 / §8.3）：**只认文件，禁止用读屏 / OCR / 窗口标题判断「完成」**。
// 轮询顺序是硬规矩：先看 change-requests/，再碰 completion.json（§8.3 第 4b 条）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validate } from './validate.js';
import { atomicWriteJson, changeRequestPath } from './ids.js';

export function buildTaskPaths(workRoot, taskId, config = {}) {
  const taskDir = path.join(workRoot, 'tasks', taskId);
  const reportName = config.reportPath ?? 'completion.json';
  if (path.isAbsolute(reportName) || String(reportName).includes('..')) {
    throw new Error(`reportPath 必须是任务目录内的相对文件名：${reportName}`);
  }
  return {
    taskDir,
    inputDir: path.join(taskDir, 'input'),
    outputDir: path.join(taskDir, 'output'),
    reportPath: path.join(taskDir, reportName),
    progressPath: path.join(taskDir, 'progress.json'),
    changeRequestsDir: path.join(taskDir, 'change-requests'),
    screenshotsDir: path.join(taskDir, 'screenshots'),
    briefPath: path.join(taskDir, 'brief.md'),
    taskJsonPath: path.join(taskDir, 'task.json'),
  };
}

export function ensureTaskDirs(paths) {
  for (const dir of [paths.taskDir, paths.inputDir, paths.outputDir,
    paths.changeRequestsDir, paths.screenshotsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function sha256File(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

// output/ 里至少有一个非空文件（空文件不算产物，防止「碰一下文件就算完成」）。
// 必须递归：员工常把产物按 output/docs/reports/ 这类子目录组织，只看顶层会把
// 「顶层只有文件夹」误判成「没有产物」，草稿模式就会白等满 maxMinutes 才超时。
export function hasNonEmptyFile(outputDir) {
  let stack = [outputDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) { stack.push(path.join(dir, entry.name)); continue; }
      if (!entry.isFile()) continue;
      try { if (fs.statSync(path.join(dir, entry.name)).size > 0) return true; } catch { /* 跳过读不到的 */ }
    }
  }
  return false;
}

export function isInsideOutput(outputDir, artifact) {
  const normalized = String(artifact).replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.includes('../') || !normalized.startsWith('output/')) {
    return false;
  }
  const resolved = path.resolve(pathsParent(outputDir), normalized);
  const rel = path.relative(path.resolve(outputDir), resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 2026-11-23 落盘改造：产物有两种合法形态 ——
//   ① output/ 下的相对路径（无项目的一次性任务，沿用旧规矩）；
//   ② **项目落点内的绝对路径**（项目产物直接落项目目录，不进 output/）。
// 其它位置一律拒。用 path.relative 判断，避免 D:/proj-evil 被当成 D:/proj 的子目录。
export function isInsideAllowedRoots(outputDir, artifact, writeDir = null) {
  const raw = String(artifact ?? '');
  if (!path.isAbsolute(raw)) return isInsideOutput(outputDir, raw);
  if (!writeDir) return false;
  const rel = path.relative(path.resolve(writeDir), path.resolve(raw));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// outputDir 的上一级就是 taskDir；artifact 里的 output/ 前缀相对 taskDir 解析。
function pathsParent(outputDir) {
  return path.dirname(outputDir);
}

export function verifyReport({ report, paths, taskId, runId, writeDir = null }) {
  const errors = [];
  const checked = validate('completion', report);
  for (const error of checked.errors) errors.push(error);
  if (report?.taskId !== taskId) errors.push(`报告 taskId 不匹配：${report?.taskId} ≠ ${taskId}`);
  if (report?.runId !== runId) errors.push(`报告 runId 不匹配：${report?.runId} ≠ ${runId}（防串单）`);
  if (report?.status !== 'success') errors.push(`报告 status 不是 success：${report?.status}`);

  const results = Array.isArray(report?.acceptanceResults) ? report.acceptanceResults : [];
  if (results.length === 0) errors.push('acceptanceResults 为空，不能算验收通过');
  for (const item of results) {
    if (item?.pass !== true) errors.push(`验收项未通过：${JSON.stringify(item)}`);
  }

  const artifacts = Array.isArray(report?.artifacts) ? report.artifacts : [];
  if (artifacts.length === 0) errors.push('artifacts 为空，没有可回收产物');
  const computed = {};
  for (const artifact of artifacts) {
    if (!isInsideAllowedRoots(paths.outputDir, artifact, writeDir)) {
      errors.push(`产物越界（只能写项目落点${writeDir ? ` ${writeDir}` : ''} 或 output/）：${artifact}`);
      continue;
    }
    const absolute = path.isAbsolute(String(artifact))
      ? path.resolve(String(artifact))
      : path.resolve(path.dirname(paths.outputDir), String(artifact).replace(/\\/g, '/'));
    if (!fs.existsSync(absolute)) { errors.push(`产物不存在：${artifact}`); continue; }
    if (fs.statSync(absolute).size === 0) { errors.push(`产物为空：${artifact}`); continue; }
    computed[artifact] = sha256File(absolute);
    if (report?.checksum?.[artifact] !== computed[artifact]) {
      errors.push(`checksum 不匹配：${artifact}`);
    }
  }
  return { ok: errors.length === 0, errors, computed };
}

export function listChangeRequests(paths) {
  if (!fs.existsSync(paths.changeRequestsDir)) return [];
  return fs.readdirSync(paths.changeRequestsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return { file: name, data: JSON.parse(fs.readFileSync(path.join(paths.changeRequestsDir, name), 'utf8')) };
      } catch { return { file: name, data: null, parseError: true }; }
    });
}

// 控制面在派活前把任务卡与提示词落盘，agent 只读（§6.2）。
export function writeTaskBundle(paths, { task, prompt }) {
  ensureTaskDirs(paths);
  atomicWriteJson(paths.taskJsonPath, task ?? {});
  if (prompt !== undefined) fs.writeFileSync(paths.briefPath, `${prompt}\n`, 'utf8');
  return paths;
}

export function writeChangeRequest(paths, crId, data) {
  const workRoot = path.dirname(path.dirname(paths.taskDir));
  const taskId = path.basename(paths.taskDir);
  const file = changeRequestPath(workRoot, taskId, crId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, data);
  return file;
}

// ---- P6：报告补全（GUI 型 agent 的降级验收）----
//
// 为什么需要：gui-template 面对的是「聊天窗口里的助手」（豆包工作这类），
// 它能把结果写成文件，但让它自己算 sha256、列 artifacts 是不现实的 —— 那等于要求
// 它同时当一个可靠的构建脚本。所以拆开：agent 只写一份三字段的极简报告，
// 证据（文件是否存在、大小、校验和）由控制面自己扫。
//
// 四条不放水的纪律（2026-11-23 落盘改造后）：
//   1. 产物默认由扫描 output/ 得出；席位报了 draft.deliverables 时改用这份清单，
//      但**每一条都要控制面亲自核实**（绝对路径、在项目落点内、存在且非空、checksum 自算），
//      不是它说有什么就认什么；
//   2. draft 说 failed / blocked 就按失败走，不补全成 success；
//   3. output/ 没有非空文件、又没报 deliverables，一律不算成功（空文件也不算）；
//   4. 项目产物落项目目录，output/ 只放任务卡、进度、报告这类公司自己的文件。
export const DRAFT_REPORT_NAME = 'report.draft.json';

// 草稿的位置：正位是任务目录；员工偶尔会误写进 output/（T-3ff55213 事故）。
// 兜底读 output/ 里那份，保证「人没丢、单没丢」——但提示词仍然要求写正位。
export function draftFileCandidates(paths) {
  return [
    path.join(paths.taskDir, DRAFT_REPORT_NAME),
    path.join(paths.outputDir, DRAFT_REPORT_NAME),
  ];
}

// 本轮开工时刻：控制面每次派活都会重写 task.json（里面带本轮 runId），
// 所以「task.json 的 mtime」就是这一轮的开始时间。返回 null 表示没有本轮标记
// （老结构 / 单测手写的 task.json），此时不启用陈旧守卫，保持向后兼容。
export function runStartedAt(paths, runId) {
  try {
    const data = JSON.parse(fs.readFileSync(paths.taskJsonPath, 'utf8'));
    const recorded = data?.runId ?? data?.task?.runId ?? null;
    if (!recorded || recorded !== runId) return null;
    return fs.statSync(paths.taskJsonPath).mtimeMs;
  } catch {
    return null;
  }
}

export function readDraft(paths, { minMtimeMs = null } = {}) {
  for (const file of draftFileCandidates(paths)) {
    if (!fs.existsSync(file)) continue;
    // 上一轮留下的草稿不能当本轮成果：见 pollForReport ④b 的说明。
    if (minMtimeMs != null) {
      try { if (fs.statSync(file).mtimeMs < minMtimeMs) continue; } catch { continue; }
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch {
      return null;
    }
  }
  return null;
}

export function scanOutputFiles(paths) {
  const files = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(abs, relPath); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(abs).size;
      if (size > 0) files.push({ abs, artifact: `output/${relPath}`, size });
    }
  };
  walk(paths.outputDir, '');
  return files.sort((a, b) => a.artifact.localeCompare(b.artifact));
}

export function buildCompletionFromDraft({
  paths, taskId, runId, agent, revision = 1, writeDir = null, now = () => new Date().toISOString(),
}) {
  // 只认本轮写的草稿：上一轮的 draft 说 success 也不能拿来交卷（T-906d3686）。
  const draft = readDraft(paths, { minMtimeMs: runStartedAt(paths, runId) });
  if (!draft) return { ok: false, kind: 'no_draft', reason: `没有 ${DRAFT_REPORT_NAME}` };

  const status = String(draft.status ?? '').trim();
  if (!['success', 'failed', 'blocked'].includes(status)) {
    return { ok: false, kind: 'bad_draft', reason: `draft 的 status 不合法：${status || '(空)'}` };
  }
  if (status !== 'success') {
    return {
      ok: false, kind: 'draft_not_success', draft,
      reason: `agent 自报 ${status}：${draft.reason ?? draft.summary ?? '(未说明原因)'}`,
    };
  }

  // 2026-11-23 落盘改造：项目产物落在**项目自己的目录**，不进 output/。
  // 席位在 draft.deliverables 里报「真正交付了哪几个文件」（绝对路径），控制面逐个核对：
  // 必须在项目落点内、真实存在且非空；checksum 一律控制面自己算，不采信它自报的 hash。
  // 有 deliverables 就不再拿「output/ 里有没有文件」否决这份完成信号 ——
  // output/ 只放任务卡、进度、报告这类公司自己的文件。
  // 没报 deliverables 的旧卡仍按老办法扫 output/，行为不变。
  const declared = Array.isArray(draft.deliverables) ? draft.deliverables : [];
  let files;
  let source = 'output-scan';
  if (declared.length) {
    source = 'manifest';
    files = [];
    const problems = [];
    for (const item of declared) {
      const p = typeof item === 'string' ? item : item?.path;
      if (!p || !path.isAbsolute(String(p))) { problems.push(`不是绝对路径：${p ?? '(空)'}`); continue; }
      if (writeDir && !isInsideAllowedRoots(paths.outputDir, p, writeDir)) { problems.push(`不在项目落点内：${p}`); continue; }
      let st = null;
      try { st = fs.statSync(p); } catch { st = null; }
      if (!st?.isFile() || st.size === 0) { problems.push(`不存在或为空：${p}`); continue; }
      files.push({ abs: String(p), artifact: String(p).replace(/\\/g, '/'), size: st.size });
    }
    if (files.length === 0) {
      return {
        ok: false, kind: 'deliverables_invalid', draft,
        reason: `deliverables 报了 ${declared.length} 条但没有一条能核实：${problems.join('；')}`,
      };
    }
  } else {
    files = scanOutputFiles(paths);
    if (files.length === 0) {
      return {
        ok: false, kind: 'no_artifacts', draft,
        reason: `draft 说成功，但 output/ 里没有任何非空文件（空文件不算），也没有报 deliverables`,
      };
    }
  }

  const checksum = {};
  for (const f of files) checksum[f.artifact] = sha256File(f.abs);

  // P7：员工在 draft 里附的经验原样搬进 usage（completion schema 是冻结的，不能新加字段）。
  // 这里只做搬运，不做修补 —— 坏数据留给引擎按规矩拒掉，不在这层悄悄「洗干净」。
  const memoryFeed = {};
  if (draft.lessons !== undefined) memoryFeed.lessons = draft.lessons;
  if (draft.nextHints !== undefined) memoryFeed.nextHints = draft.nextHints;

  const report = {
    schema: 'aicompany.completion/v1',
    taskId, runId, agent, revision,
    status: 'success',
    summary: String(draft.summary ?? `产出 ${files.length} 个文件`),
    artifacts: files.map((f) => f.artifact),
    checksum,
    acceptanceResults: [{
      rule: source === 'manifest' ? '控制面核实：deliverables 指向的项目产物真实存在且非空' : '控制面核实：产物真实存在且非空',
      pass: true,
      detail: `${source === 'manifest' ? '按 manifest 核对，' : ''}${files.length} 个文件，共 ${files.reduce((n, f) => n + f.size, 0)} 字节`,
    }],
    // usage 是自由对象，把「这份报告是谁写的」记在这里，不污染固定字段。
    usage: {
      quotaUnits: 1,
      reportSource: 'control-plane-draft',
      ...(Object.keys(memoryFeed).length ? { memoryFeed } : {}),
    },
    finishedAt: now(),
  };
  const verified = verifyReport({ report, paths, taskId, runId, writeDir });
  return { ok: true, kind: 'completion', report, verified, files, draft, source };
}

export function writeCompletion(paths, report) {
  atomicWriteJson(paths.reportPath, report);
  return paths.reportPath;
}

export async function pollForReport({
  paths, config = {}, taskId, runId, maxPolls = null, wait = null, now = () => new Date().toISOString(),
  onPoll = null, writeDir = null,
}) {
  const intervalMs = config.pollIntervalMs ?? 3000;
  const limit = maxPolls ?? Math.max(1, Math.ceil(((config.maxMinutes ?? 1) * 60000) / intervalMs));
  const pause = wait ?? (() => new Promise((resolve) => setTimeout(resolve, intervalMs)));
  let progressSeen = false;
  const startedAt = runStartedAt(paths, runId);

  for (let i = 1; i <= limit; i += 1) {
    // ① 先看变更请求：needsDecision 立刻收，绝不当成超时或失败。
    const pending = listChangeRequests(paths).find((x) => x.data?.severity === 'needsDecision');
    if (pending) {
      return { kind: 'change_request', data: pending.data, file: pending.file, polls: i, at: now() };
    }
    // ①b P2-4（2026-11-23）：席位主动「停手」信号 blocked.json。
    //     比让它反复乱试、或干等 60 分钟超时都便宜；只认本轮写的（早于开工时刻的算上一轮残留）。
    const blockedFile = path.join(paths.taskDir, 'blocked.json');
    let blockedSt = null;
    try { blockedSt = fs.statSync(blockedFile); } catch { blockedSt = null; }
    if (blockedSt && blockedSt.size > 0 && (startedAt == null || blockedSt.mtimeMs >= startedAt)) {
      let blockedData = null;
      try { blockedData = JSON.parse(fs.readFileSync(blockedFile, 'utf8')); } catch { blockedData = null; }
      return { kind: 'blocked', data: blockedData, file: blockedFile, polls: i, at: now() };
    }
    // ② 再看完成报告（终态，写完即收）。
    if (fs.existsSync(paths.reportPath)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8')); } catch (error) {
        return { kind: 'invalid_report', error: String(error.message ?? error), polls: i, at: now() };
      }
      // ②b 陈旧报告跳过（T-465c3869 事故回归）：卡被打回重做 / 转救火席位再投时，
      //    任务目录里残留的是**上一轮运行**的 completion.json —— taskId 相同、runId 不同。
      //    旧逻辑在这里直接判 invalid_report 把卡打死（防串单），新运行永远走不到
      //    草稿模式，卡就卡死在 blocked。处理：只跳过、不判死，继续等本轮自己的报告；
      //    草稿模式收尾时 writeCompletion 会用当前 runId 覆盖这份旧文件，自然自愈。
      //    taskId 都对不上才是真串单，照旧拒绝。
      const staleFromPreviousRun = data?.taskId === taskId
        && data?.runId != null && data.runId !== runId;
      if (!staleFromPreviousRun) {
        const verified = verifyReport({ report: data, paths, taskId, runId, writeDir });
        return {
          kind: verified.ok ? 'completion' : 'invalid_report',
          data, verified, polls: i, at: now(),
        };
      }
    }
    // ③ progress.json 只是覆盖写的进度，绝不触发事件、绝不唤醒任何人。
    if (fs.existsSync(paths.progressPath)) progressSeen = true;
    // ③b 证据心跳：adapter 还活着、还在盯着这个任务目录（不等于 agent 在产出，只是机器侧证据）。
    //     抛异常一律吞掉：心跳失败绝不能把一次正常的轮询变成失败。
    if (onPoll) { try { onPoll({ index: i, progressSeen }); } catch { /* ignore */ } }
    // ④ 草稿模式（聊天窗口型助手）：draft 就是它的终态信号，别傻等满 maxMinutes。
    //    但 draft 说成功、output/ 里却还没有非空文件时不算数，继续等（agent 可能还在写）。
    //    草稿被误写进 output/ 也能兜住（draftFileCandidates 有两个候选位）。
    if (config.reportMode === 'draft') {
      // ④b 陈旧草稿跳过（T-906d3686 事故回归）：卡被验收打回重做 / 转救火再投时，
      //    任务目录里躺着**上一轮**的 report.draft.json，它说 success。旧逻辑直接当成本轮
      //    成果收单 —— 等于「打回」自动变成「原样通过」，验收方再拒一次就成死循环。
      //    处理：比本轮开工时刻（task.json 的 mtime）还老的草稿一律不算数，继续等本轮自己写。
      const draftFile = draftFileCandidates(paths).find((f) => {
        if (!fs.existsSync(f)) return false;
        if (startedAt == null) return true;
        try { return fs.statSync(f).mtimeMs >= startedAt; } catch { return false; }
      });
      if (draftFile) {
        let draft;
        try { draft = JSON.parse(fs.readFileSync(draftFile, 'utf8')); } catch (error) {
          return { kind: 'invalid_report', error: String(error.message ?? error), polls: i, at: now() };
        }
        if (draft.status !== 'success' || hasNonEmptyFile(paths.outputDir)) {
          return { kind: 'draft', data: draft, polls: i, at: now() };
        }
        // 落盘改造：draft 报了 deliverables 就不必再等 output/ 出文件 ——
        // 产物在项目目录里，output/ 本来就该是空的。
        if (Array.isArray(draft.deliverables) && draft.deliverables.length > 0) {
          return { kind: 'draft', data: draft, polls: i, at: now() };
        }
      }
    }
    if (i < limit) await pause();
  }
  return { kind: 'timeout', polls: limit, progressSeen, at: now() };
}
