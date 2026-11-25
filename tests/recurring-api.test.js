// 循环任务的 HTTP 接口：中文 jobId 必须能用。
//
// 事故：CEO 起的循环任务 id 是中文标题（JOB-demo-editor-每周体检-…），
// 而 `url.pathname` 保持 URL 编码态，路由拿到的 jobId 是 `JOB-demo-editor-%E6%AF%8F…`，
// 查库永远查不到 —— 接口只回一句「循环任务不存在」，看板上点 pause / fire 全废。
//
// 这里同时守住「只读不越权」：不存在的 id 仍然是 404 之外的正常响应，不会误伤别的 job。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core.js';
import { createEngine, createNotifier } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { createRecurring } from '../src/recurring.js';

// CEO 真正会起的那种 id：带中文、带连字符、带空格
const CN_JOB = 'JOB-demo-editor-每周体检-全量门禁-git-干净度';

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-recurring-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(t) {
  const root = tmpRoot(t);
  const db = openDb(':memory:');
  const config = {
    version: 1,
    company: { name: 'recurring-api', timezone: 'Asia/Shanghai' },
    workRoot: root,
    projects: {},
    interaction: { defaultMode: 'delegate', defaultTarget: 'ceo' },
    agents: [
      {
        id: 'ceo', displayName: '总经理', isCEO: true, capabilities: ['plan'],
        status: 'active', quotaDaily: 20, reportsTo: null,
        adapter: { type: 'mock', config: { result: () => ({ type: 'review', verdict: 'pass', reason: 'ok' }) } },
      },
      {
        id: 'worker-01', displayName: '执行', isCEO: false, capabilities: ['execute'],
        status: 'active', quotaDaily: 20, reportsTo: 'ceo', adapter: { type: 'mock', config: {} },
      },
    ],
    clients: ['web'], notifier: ['noop'],
  };
  const engine = createEngine({ db, config, notifier: createNotifier('noop'), workRoot: root });
  const notifier = createNotifier('noop');
  const rec = createRecurring({ db, notifier });
  const server = createServer({
    engine, port: 0, host: '127.0.0.1', recurring: rec,
    overridesPath: path.join(root, 'runtime-overrides.json'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  return { base, db, rec };
}

const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const JOB = (overrides = {}) => ({
  schema: 'aicompany.recurring/v1',
  jobId: CN_JOB, jobVersion: 1,
  title: '每周体检', kind: 'inspection',
  owner: 'ceo', assignee: 'worker-01', reportsTo: 'ceo', status: 'active',
  trigger: { type: 'cron', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=30', timezone: 'Asia/Shanghai' },
  misfirePolicy: 'run_once', misfireGraceMin: 720, overlapPolicy: 'skip',
  termination: { validUntil: '2027-11-16T00:00:00.000Z', maxCycles: null, pauseOnConsecutiveFailures: 3 },
  requiresHumanEachCycle: false,
  taskTemplate: {
    role: 'execute', instructions: '体检并写报告。',
    acceptance: ['completion.json 合法'], completionReportPath: 'output/completion.json',
  },
  dedupeWindowMin: 60,
  nextFireAt: '2026-11-16T12:30:00.000Z',
  ...overrides,
});

test('RAPI-1 · 中文 jobId：POST /fire 能真建卡（编码解码不能丢）', async (t) => {
  const { base, db } = await boot(t);
  const reg = await postJson(`${base}/api/recurring`, JOB());
  assert.equal(reg.status, 201, '注册要先成功');

  const res = await postJson(
    `${base}/api/recurring/${encodeURIComponent(CN_JOB)}/fire`,
    { scheduledAt: '2026-11-16T12:30:00.000Z' },
  );
  const out = await res.json();
  assert.equal(out.created, true, `中文 id 必须能触发，实际：${JSON.stringify(out)}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
});

test('RAPI-2 · 中文 jobId：pause / resume 都认得同一个 job', async (t) => {
  const { base, rec } = await boot(t);
  await postJson(`${base}/api/recurring`, JOB());
  const url = `${base}/api/recurring/${encodeURIComponent(CN_JOB)}`;

  await postJson(`${url}/pause`, { reason: '自检' });
  assert.equal(rec.getJob(CN_JOB).status, 'paused', '暂停要落到这个 job 上');

  await postJson(`${url}/resume`, {});
  assert.equal(rec.getJob(CN_JOB).status, 'active');
});

test('RAPI-3 · 不存在的中文 id：明确报「不存在」，不误伤别的 job', async (t) => {
  const { base, db } = await boot(t);
  await postJson(`${base}/api/recurring`, JOB());
  const res = await postJson(
    `${base}/api/recurring/${encodeURIComponent('JOB-查无此任务-乱写')}/fire`, {},
  );
  const out = await res.json();
  assert.equal(out.skipped, true);
  assert.match(out.reason, /不存在/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
});
