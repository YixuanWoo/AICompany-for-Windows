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
export function hasNonEmptyFile(outputDir) {
  let entries = [];
  try { entries = fs.readdirSync(outputDir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try { if (fs.statSync(path.join(outputDir, entry.name)).size > 0) return true; } catch { /* 跳过读不到的 */ }
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

// outputDir 的上一级就是 taskDir；artifact 里的 output/ 前缀相对 taskDir 解析。
function pathsParent(outputDir) {
  return path.dirname(outputDir);
}

export function verifyReport({ report, paths, taskId, runId }) {
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
    if (!isInsideOutput(paths.outputDir, artifact)) {
      errors.push(`产物越界（只能写 output/）：${artifact}`);
      continue;
    }
    const absolute = path.resolve(path.dirname(paths.outputDir), String(artifact).replace(/\\/g, '/'));
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
// 三条不放水的纪律：
//   1. artifacts 一律由扫描 output/ 得出，**绝不采信 draft 里声明的清单**；
//   2. draft 说 failed / blocked 就按失败走，不补全成 success；
//   3. output/ 里没有非空文件，一律不算成功（空文件也不算）。
export const DRAFT_REPORT_NAME = 'report.draft.json';

export function readDraft(paths) {
  const file = path.join(paths.taskDir, DRAFT_REPORT_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
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
  paths, taskId, runId, agent, revision = 1, now = () => new Date().toISOString(),
}) {
  const draft = readDraft(paths);
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

  const files = scanOutputFiles(paths);
  if (files.length === 0) {
    return {
      ok: false, kind: 'no_artifacts', draft,
      reason: `draft 说成功，但 output/ 里没有任何非空文件（空文件不算）`,
    };
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
      rule: '控制面核实：产物真实存在且非空',
      pass: true,
      detail: `${files.length} 个文件，共 ${files.reduce((n, f) => n + f.size, 0)} 字节`,
    }],
    // usage 是自由对象，把「这份报告是谁写的」记在这里，不污染固定字段。
    usage: {
      quotaUnits: 1,
      reportSource: 'control-plane-draft',
      ...(Object.keys(memoryFeed).length ? { memoryFeed } : {}),
    },
    finishedAt: now(),
  };
  const verified = verifyReport({ report, paths, taskId, runId });
  return { ok: true, kind: 'completion', report, verified, files, draft };
}

export function writeCompletion(paths, report) {
  atomicWriteJson(paths.reportPath, report);
  return paths.reportPath;
}

export async function pollForReport({
  paths, config = {}, taskId, runId, maxPolls = null, wait = null, now = () => new Date().toISOString(),
}) {
  const intervalMs = config.pollIntervalMs ?? 3000;
  const limit = maxPolls ?? Math.max(1, Math.ceil(((config.maxMinutes ?? 1) * 60000) / intervalMs));
  const pause = wait ?? (() => new Promise((resolve) => setTimeout(resolve, intervalMs)));
  let progressSeen = false;

  for (let i = 1; i <= limit; i += 1) {
    // ① 先看变更请求：needsDecision 立刻收，绝不当成超时或失败。
    const pending = listChangeRequests(paths).find((x) => x.data?.severity === 'needsDecision');
    if (pending) {
      return { kind: 'change_request', data: pending.data, file: pending.file, polls: i, at: now() };
    }
    // ② 再看完成报告（终态，写完即收）。
    if (fs.existsSync(paths.reportPath)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8')); } catch (error) {
        return { kind: 'invalid_report', error: String(error.message ?? error), polls: i, at: now() };
      }
      const verified = verifyReport({ report: data, paths, taskId, runId });
      return {
        kind: verified.ok ? 'completion' : 'invalid_report',
        data, verified, polls: i, at: now(),
      };
    }
    // ③ progress.json 只是覆盖写的进度，绝不触发事件、绝不唤醒任何人。
    if (fs.existsSync(paths.progressPath)) progressSeen = true;
    // ④ 草稿模式（聊天窗口型助手）：draft 就是它的终态信号，别傻等满 maxMinutes。
    //    但 draft 说成功、output/ 里却还没有非空文件时不算数，继续等（agent 可能还在写）。
    if (config.reportMode === 'draft') {
      const draftFile = path.join(paths.taskDir, DRAFT_REPORT_NAME);
      if (fs.existsSync(draftFile)) {
        let draft;
        try { draft = JSON.parse(fs.readFileSync(draftFile, 'utf8')); } catch (error) {
          return { kind: 'invalid_report', error: String(error.message ?? error), polls: i, at: now() };
        }
        if (draft.status !== 'success' || hasNonEmptyFile(paths.outputDir)) {
          return { kind: 'draft', data: draft, polls: i, at: now() };
        }
      }
    }
    if (i < limit) await pause();
  }
  return { kind: 'timeout', polls: limit, progressSeen, at: now() };
}
