// P4-8：挂起时的现场快照。只读、不可变：同一 crId 第二次写入直接复用已有文件，绝不覆盖。
// 依据：任务书 §6D.3。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson, snapshotPath, nowIso, taskDir } from './ids.js';

function sha256File(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function listArtifacts(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          bytes: fs.statSync(full).size,
          checksum: sha256File(full),
        });
      }
    }
  };
  walk(root);
  return out;
}

export function buildSnapshot({
  workRoot, task, changeRequest, sessionParams = {}, transcriptPath = null, percent = null,
}) {
  const file = snapshotPath(workRoot, task.taskId, changeRequest.changeRequestId);
  if (fs.existsSync(file)) {
    return { path: file, reused: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  const outputDir = path.join(taskDir(workRoot, task.taskId), 'output');
  const data = {
    schema: 'aicompany.snapshot/v1',
    taskId: task.taskId,
    changeRequestId: changeRequest.changeRequestId,
    revision: task.revision ?? 1,
    status: task.status,
    percent,
    artifacts: listArtifacts(outputDir),
    sessionParams,
    transcriptPath,
    createdAt: nowIso(),
    immutable: true,
  };
  atomicWriteJson(file, data);
  return { path: file, reused: false, data };
}

export function readSnapshot(workRoot, taskId, crId) {
  const file = snapshotPath(workRoot, taskId, crId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
