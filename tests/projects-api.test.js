// P7：新建项目渠道（看板/API）+「CEO 建议 → 董事会点通过 → 真建」这条闭环。
// 只跑内存库 + 临时 overrides 文件，不碰生产配置、不联网、不烧额度。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createServer } from '../src/server.js';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-projects-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeConfig(root) {
  return {
    version: 1,
    company: { name: 'projects-api', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: {},
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo' },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true,
        capabilities: ['plan', 'delegate', 'review'], status: 'active', quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: () => ({ type: 'review', verdict: 'pass', reason: '通过' }) } },
      },
      {
        id: 'worker-01', displayName: '执行', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
}

async function boot(t, { overridesPath = null } = {}) {
  const root = tmpRoot(t);
  const overrides = overridesPath ?? path.join(root, 'runtime-overrides.json');
  const db = openDb(':memory:');
  const engine = createEngine({
    db, config: makeConfig(root), notifier: createNotifier('noop'), workRoot: root,
  });
  const server = createServer({ engine, port: 0, host: '127.0.0.1', overridesPath: overrides });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  return { base, root, engine, overrides };
}

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /api/projects 真建项目：目录 + 起步规范 + 落 runtime-overrides', async (t) => {
  const { base, root, overrides, engine } = await boot(t);
  const res = await postJson(`${base}/api/projects`, { id: 'demo-api', displayName: '接口新建' });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.project.id, 'demo-api');
  assert.equal(fs.existsSync(out.specPath), true, '要写起步规范');
  assert.equal(fs.existsSync(path.join(root, 'projects', 'demo-api', 'knowledge')), true);
  assert.equal(engine.config.projects['demo-api'].displayName, '接口新建', '引擎手里的配置要立刻生效');

  const saved = JSON.parse(fs.readFileSync(overrides, 'utf8'));
  assert.equal(saved.projects['demo-api'].displayName, '接口新建', '重启后要还在，所以必须落盘');
});

test('POST /api/projects 拒绝坏 id / 重复 id，且不建任何目录', async (t) => {
  const { base, root } = await boot(t);
  let res = await postJson(`${base}/api/projects`, { id: 'Bad ID' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'PROJECT_ID_INVALID');
  assert.equal(fs.existsSync(path.join(root, 'projects', 'Bad ID')), false);

  await postJson(`${base}/api/projects`, { id: 'dup' });
  res = await postJson(`${base}/api/projects`, { id: 'dup' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'PROJECT_EXISTS');
});

test('CEO 建议建项目 → 董事会点通过 → 项目真被建出来', async (t) => {
  const { base, root, engine } = await boot(t);
  // 模拟 CEO 那一侧：建议建 new-proj（引擎在 CEO 输出里看到 projectSuggestion 就会出这张单）。
  const approval = engine.requestApproval({
    kind: 'project_create',
    title: 'CEO 建议新建项目：新项目（new-proj）',
    body: '值得单开',
    payload: { project: { id: 'new-proj', displayName: '新项目', reason: '值得单开' } },
    requestedBy: 'ceo',
  });

  const res = await postJson(`${base}/api/approvals/${approval.approvalId}/decision`, {
    decision: 'approved', decidedBy: 'board',
  });
  const out = await res.json();
  assert.equal(out.applied, true);
  assert.equal(out.project.id, 'new-proj');
  assert.equal(fs.existsSync(path.join(root, 'projects', 'new-proj', 'project.yaml')), true);
  assert.equal(engine.config.projects['new-proj'].displayName, '新项目');
});

test('驳回建议：不建项目，只留结论', async (t) => {
  const { base, root, engine } = await boot(t);
  const approval = engine.requestApproval({
    kind: 'project_create',
    title: '建议建 x',
    payload: { project: { id: 'rejected-proj', displayName: '不要建' } },
    requestedBy: 'ceo',
  });
  const res = await postJson(`${base}/api/approvals/${approval.approvalId}/decision`, {
    decision: 'rejected', decidedBy: 'board', reason: '没必要',
  });
  const out = await res.json();
  assert.equal(out.applied, false);
  assert.equal(fs.existsSync(path.join(root, 'projects', 'rejected-proj')), false);
});
