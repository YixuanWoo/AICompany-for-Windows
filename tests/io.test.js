import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDEMPOTENCY_KEYS, nowIso, atomicWriteJson, ensureLayout, assertPromote,
  changeRequestPath, decisionPath, snapshotPath, revisionPath, LAYOUT,
} from '../src/ids.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-p0-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('P0-6 · 幂等键覆盖 7 类对象', () => {
  const keys = Object.values(IDEMPOTENCY_KEYS).join('|');
  for (const key of ['requestId', 'taskId', 'runId', 'message_id', 'changeRequestId', 'messageId', 'decisionId']) {
    assert.ok(keys.includes(key), `缺幂等键 ${key}`);
  }
  assert.equal(Object.keys(IDEMPOTENCY_KEYS).length, 7);
});

test('P0-6 · 原子写：写临时文件后 rename，读回一致、无 .tmp 残留、UTF-8 无 BOM', () => {
  withTempDir((dir) => {
    const target = path.join(dir, 'nested', 'task.json');
    const payload = { schema: 'aicompany.task/v1', taskId: 'T-1' };
    atomicWriteJson(target, payload);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), payload);
    const files = fs.readdirSync(path.dirname(target));
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
    const buffer = fs.readFileSync(target);
    assert.notDeepEqual([...buffer.slice(0, 3)], [0xef, 0xbb, 0xbf], '不得带 BOM');
  });
});

test('P0-6 · 时间统一 UTC ISO，不带 +08:00 字面量', () => {
  const stamp = nowIso();
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(!stamp.includes('+08:00'));
});

test('P0-6 · 目录规范与命名约定：单复数、outbox/API 双通道落到同一 crId', () => {
  const root = 'work';
  assert.ok(changeRequestPath(root, 'T-1', 'CR-1').endsWith(path.join('change-requests', 'CR-1.json')));
  assert.ok(decisionPath(root, 'T-1', 'CR-1').endsWith(path.join('decisions', 'CR-1.json')));
  assert.ok(snapshotPath(root, 'T-1', 'CR-1').endsWith(path.join('snapshots', 'CR-1.json')));
  assert.ok(revisionPath(root, 'T-1', 2).endsWith(path.join('revisions', 'rev-2.json')));
  withTempDir((dir) => {
    ensureLayout(dir);
    for (const name of LAYOUT) assert.ok(fs.existsSync(path.join(dir, name)));
  });
});

test('P0-6 · promote 单向：只能从 active 提升一次', () => {
  const thread = { threadId: 'TH-1', state: 'active', promotedTo: null };
  const promoted = assertPromote(thread, 'T-9');
  assert.equal(promoted.promotedTo, 'T-9');
  assert.equal(promoted.state, 'archived');
  assert.throws(() => assertPromote(promoted, 'T-10'), /只能做一次/);
  assert.throws(() => assertPromote({ ...thread, state: 'archived' }, 'T-9'), /active/);
  assert.throws(() => assertPromote(thread, null), /显式给出/);
});

test('P0-7 · .env.example 只有变量名，没有任何值', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.length >= 3);
  for (const line of lines) assert.match(line, /^[A-Z][A-Z0-9_]*=$/, `不该有值：${line}`);
});

test('P0-7 · 引擎源码零产品名、零本机绝对路径、不依赖 examples/', () => {
  const srcDir = path.join(ROOT, 'src');
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 6);
  const source = files.map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n').toLowerCase();
  // 必须按「词边界」判定：needsHumanApproval 里含 dsH，用 includes('dsh') 会误报。
  // 任务书 §6B.11 的 CI grep 示例同样要改成 \b(dsh|...)\b，见 docs/P0-协议冻结说明.md。
  for (const name of ['dsh', 'doubao', 'workbuddy', 'hermes', 'larksuite', 'feishu']) {
    assert.ok(!new RegExp(`\\b${name}\\b`, 'i').test(source), `引擎源码不该出现产品名 ${name}`);
  }
  assert.ok(!source.includes('c:\\users'));
  assert.ok(!source.includes('d:\\工作台'));
  assert.ok(!source.includes('examples/'), '删掉 examples/ 后核心必须仍能跑');
});
