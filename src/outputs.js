// P6-4：任务产物查看（看板「看结果」、命令行 --wait 共用一套口径）。
//
// 为什么需要：GUI 席位干完活只留一堆文件在 tasks/<id>/output/ 里。天天用的人不该去翻资源管理器，
// 更不该看到 0 字节文件还以为「做完了」。所以这里只做两件事：列出产物、读回文本。
//
// 安全边界（这是给 HTTP 用的，必须当成外部输入处理）：
//   - taskId 只允许 T- 开头的安全字符（防止 ../ 拼出别处）
//   - 只允许读 workRoot/tasks/<taskId>/output/ 之下的普通文件，软链接一律不跟
//   - 单文件读取有体积上限，超了截断并明确标记
//   - 不写、不删、不建任何文件

import fs from 'node:fs';
import path from 'node:path';

export const MAX_TEXT_BYTES = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class OutputsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'OutputsError';
    this.status = status;
  }
}

export function assertSafeTaskId(taskId) {
  const id = String(taskId ?? '');
  if (!SAFE_ID.test(id)) throw new OutputsError(`任务号不合法：${id || '空'}`, 400);
  return id;
}

export function outputDirOf(workRoot, taskId) {
  assertSafeTaskId(taskId);
  if (!workRoot) throw new OutputsError('控制面没有工作根目录（workRoot 未配置）', 500);
  return path.join(path.resolve(workRoot), 'tasks', taskId, 'output');
}

// 递归列产物，但对深度和数量都设上限：席位要是抽风写了十万个小文件，看板不能跟着卡死。
export function listOutputs(workRoot, taskId, { maxFiles = 200, maxDepth = 3 } = {}) {
  const dir = outputDirOf(workRoot, taskId);
  const files = [];
  let truncated = false;

  function walk(current, depth) {
    if (files.length >= maxFiles) { truncated = true; return; }
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      files.push({
        name: path.relative(dir, full).replace(/\\/g, '/'),
        artifact: `output/${path.relative(dir, full).replace(/\\/g, '/')}`,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        empty: stat.size === 0,
      });
    }
  }

  walk(dir, 0);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    taskId, dir, files, truncated,
    exists: fs.existsSync(dir),
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
  };
}

export function readOutput(workRoot, taskId, name, { maxBytes = MAX_TEXT_BYTES } = {}) {
  const dir = outputDirOf(workRoot, taskId);
  const rel = String(name ?? '').replace(/\\/g, '/').replace(/^output\//, '');
  if (!rel || rel.includes('..') || path.isAbsolute(rel) || rel.startsWith('/')) {
    throw new OutputsError(`产物名不合法：${name}`, 400);
  }
  const resolved = path.resolve(dir, rel);
  const back = path.relative(dir, resolved);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) {
    throw new OutputsError(`产物越界：${name}`, 400);
  }
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new OutputsError(`产物不存在：${rel}`, 404); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new OutputsError(`不是普通文件：${rel}`, 400);

  const buffer = fs.readFileSync(resolved);
  const clipped = buffer.subarray(0, maxBytes);
  return {
    name: rel,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    truncated: buffer.length > clipped.length,
    text: clipped.toString('utf8'),
  };
}
