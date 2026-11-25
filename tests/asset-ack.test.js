// 资产归口（2026-11-18）：交付验收通过后，代码仓库必须由仓库主人确认落地才算关单。
// 事故背景：CEO 直派执行岗改代码 → CEO 验收通过 → 卡 done → 仓库没提交没推送。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { assetOwnerOf, needsAssetAck, assetAckInstructions } from '../src/asset-ack.js';
import { ceoRoutingBriefing, seatPreamble } from '../src/org-chart.js';
import { nowIso } from '../src/ids.js';

const upd = (ctx) => ({
  schema: 'aicompany.completion/v1', taskId: ctx.task.taskId, runId: ctx.runId,
  agent: ctx.agent.id, revision: ctx.task.revision ?? 1, status: 'success',
  summary: '改完了', artifacts: ['src/a.js'], checksum: {},
  acceptanceResults: [{ rule: '完成', pass: true }],
  usage: { quotaUnits: 1 }, finishedAt: nowIso(),
});

test('归口判定：代码卡 + 登记仓库 + 非仓库主人 → 需要回执', () => {
  const repo = { id: 'demo-editor', path: 'D:/开源/demo-editor', remote: 'demo-owner/demo-editor', reviewer: 'engineering' };
  const config = { repos: { 'demo-editor': repo }, artifacts: { defaultReviewer: 'engineering' } };
  const task = { taskId: 'T-1', assignee: 'doubao', repo: 'demo-editor' };

  assert.deepEqual(assetOwnerOf({ task, config }), { owner: 'engineering', repo });
  assert.equal(needsAssetAck({ task, kind: 'managed-code', config }).owner, 'engineering');

  // 仓库主人自己干：不需要再给自己回执。
  assert.equal(needsAssetAck({ task: { ...task, assignee: 'engineering' }, kind: 'managed-code', config }), null);
  // 一次性脚本：不触发，避免小事层层转包。
  assert.equal(needsAssetAck({ task, kind: 'scratch-code', config }), null);
  // 没登记仓库：不触发（但 CEO 派代码卡漏写 repo 本身就是违规，见 org-chart 提示）。
  assert.equal(needsAssetAck({ task: { ...task, repo: null }, kind: 'managed-code', config }), null);
  // 已回执：不再重复建卡。
  assert.equal(needsAssetAck({ task: { ...task, assetAck: 'done' }, kind: 'managed-code', config }), null);
  // 全局开关。
  assert.equal(needsAssetAck({ task, kind: 'managed-code', config: { ...config, artifacts: { requireAssetAck: false } } }), null);
});

test('归口说明：只核对落地，不重做实现，并区分推送策略', () => {
  const text = assetAckInstructions({
    task: { taskId: 'T-1', title: '改接口' }, owner: 'engineering',
    repo: { id: 'aicompany', path: 'D:/开源/AICompany', remote: '', allowPush: false },
    artifacts: ['src/a.js'],
  });
  assert.match(text, /不是重做交付/);
  assert.match(text, /不允许自动推送/);
  assert.match(text, /无需变更/);
  assert.match(text, /commit 短哈希/);
});

test('提示词：CEO 知道仓库归谁，执行岗知道不自行推送，工程岗知道自己是归口人', () => {
  const cfg = {
    agents: [
      { id: 'ceo', postTitle: '总经理', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', reportsTo: null, adapter: { type: 'mock', config: {} } },
      { id: 'engineering', postTitle: '工程执行', capabilities: ['execute', 'review', 'delegate', 'plan'], status: 'active', reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
      { id: 'doubao', postTitle: '执行', capabilities: ['execute'], status: 'active', reportsTo: 'engineering', adapter: { type: 'mock', config: {} } },
    ],
    repos: { 'demo-editor': { id: 'demo-editor', path: 'D:/开源/demo-editor', remote: 'demo-owner/demo-editor', reviewer: 'engineering', allowPush: true } },
    artifacts: { defaultReviewer: 'engineering' },
  };
  const ceo = ceoRoutingBriefing(cfg);
  assert.match(ceo, /资产归属/);
  assert.match(ceo, /reviewBy 不要写你自己/);
  assert.match(ceo, /repo 是必填/);

  const worker = seatPreamble(cfg, 'doubao', { repos: cfg.repos });
  assert.match(worker, /资产归口/);
  assert.match(worker, /不自行 commit \/ push/);

  const owner = seatPreamble(cfg, 'engineering', { repos: cfg.repos });
  assert.match(owner, /你是仓库归口人/);
  assert.match(owner, /不重做实现/);
});

test('直投执行岗的代码卡：验收通过先挂「待归口」，仓库主人回执后才 done', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-ack-'));
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-repo-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  const cfg = {
    version: 1,
    company: { name: 'ack-test', timezone: 'UTC' },
    quota: { warnRatio: 0.8, stopRatio: 1, periodHours: 24 },
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo', autoAssign: true },
    repos: { 'demo-editor': { id: 'demo-editor', displayName: 'demo-editor', path: repoPath, remote: 'demo-owner/demo-editor', branch: 'main', allowPush: true, reviewer: 'engineering' } },
    artifacts: { defaultReviewer: 'engineering', codeExtensions: ['.js'] },
    agents: [
      { id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 30, reportsTo: null, adapter: { type: 'mock', config: {} } },
      { id: 'engineering', displayName: '工程执行', capabilities: ['execute', 'review', 'delegate', 'plan'], status: 'active', quotaDaily: 30, reportsTo: 'ceo', adapter: { type: 'mock', config: {} } },
      { id: 'doubao', displayName: '执行', capabilities: ['execute'], status: 'active', quotaDaily: 30, reportsTo: 'engineering', adapter: { type: 'mock', config: {} } },
    ],
    clients: ['web'], notifier: ['noop'],
  };
  for (const agent of cfg.agents) {
    agent.adapter = {
      type: 'mock',
      config: {
        result: (ctx) => {
          if (!ctx.task) return { type: 'message', text: '收到' };
          if (ctx.wakeReason === 'review_requested') return { type: 'review', verdict: 'pass', reason: '通过' };
          return upd(ctx);
        },
      },
    };
  }
  const db = openDb(':memory:');
  const engine = createEngine({ db, config: { ...cfg, workRoot: root }, notifier: createNotifier('noop'), workRoot: root });
  t.after(() => { try { db.close(); } catch { /* closed */ } });

  const submitted = await engine.submit({
    requestId: 'REQ-ACK', text: '改个 bug', mode: 'direct', addressedTo: 'doubao', repo: 'demo-editor',
  });
  assert.equal(submitted.taskCreated, true);

  const parent = db.prepare("SELECT * FROM tasks WHERE requestId='REQ-ACK' AND parentTaskId IS NULL").get();
  assert.ok(parent, '父卡应在');
  // 速度快的 mock 会把归口卡也跑完，所以最终状态是 done + 已归口；关键是流程里确实派生过归口卡。
  const acks = db.prepare("SELECT * FROM tasks WHERE title LIKE '归口核对：%'").all();
  assert.equal(acks.length, 1, '应派生一张归口核对卡');
  assert.equal(acks[0].assignee, 'engineering');
  assert.equal(acks[0].repo, 'demo-editor');

  const fresh = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(parent.taskId);
  assert.equal(fresh.assetOwner, 'engineering');
  assert.equal(fresh.assetAck, 'done');
  assert.ok(fresh.assetAckTaskId, '父卡要记住归口卡 id');

  const audit = db.prepare("SELECT * FROM audit WHERE action = 'asset_ack_opened'").all();
  assert.equal(audit.length, 1);
  const passed = db.prepare("SELECT * FROM audit WHERE action = 'asset_ack_passed'").all();
  assert.equal(passed.length, 1);
});
