// 离线单测：用假 HTTP 客户端驱动 webhook-exec adapter，不碰真 8080、不依赖外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createWebhookExecAdapter } from '../src/adapter-webhook-exec.js';

const WORK = path.join(os.tmpdir(), 'aicompany-webhook-exec-test');

const baseCtx = {
  taskId: 'T-123', runId: 'R-9',
  task: { taskId: 'T-123', revision: 1, title: '列目录', instructions: '列出当前目录文件', acceptance: ['说清楚有几个文件'] },
  agent: { id: 'ceo-agent', isCEO: false },
  adapterConfig: { workRoot: WORK },
  project: { specification: '项目规范A', recentMemory: [{ text: '上轮教训B' }] },
};

function fakeServer({ healthOk = true, taskOk = true, statuses = ['running', 'done'], text = '我列了目录，共 3 个文件，验收满足。', resultError = null } = {}) {
  const calls = [];
  let i = 0;
  const request = async (baseUrl, path, payload, opts) => {
    calls.push({ path, payload, opts });
    if (path === '/aiceo/api/health') {
      return { statusCode: 200, body: { ok: true, value: { ok: true, agents: healthOk, presets: healthOk } } };
    }
    if (path === '/aiceo/api/task') {
      if (!taskOk) return { statusCode: 500, body: { ok: false, error: { code: 'boom', message: '拉起 agent 失败' } } };
      return { statusCode: 200, body: { ok: true, value: { taskId: payload.taskId, sessionId: 'aiceo-ceo-T-123' } } };
    }
    if (path === '/aiceo/api/result') {
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return { statusCode: 200, body: { ok: true, value: { status, text, turn: 1, error: resultError, sessionId: 'aiceo-ceo-T-123' } } };
    }
    throw new Error('unexpected path ' + path);
  };
  return { request, calls };
}

test('testEnvironment 在线且就绪返回 ok', async () => {
  const { request } = fakeServer({ healthOk: true });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const env = await a.testEnvironment({});
  assert.equal(env.ok, true);
});

test('testEnvironment 端点不可达返回 not ok', async () => {
  const a = createWebhookExecAdapter({ request: async () => { throw new Error('ECONNREFUSED'); }, sleep: async () => {} });
  const env = await a.testEnvironment({});
  assert.equal(env.ok, false);
  assert.match(env.detail, /不可达/);
});

test('成功路径：投递→轮询→done→合法 completion report', async () => {
  // 产物清单由控制面扫 output 目录得出，不靠 agent 在回复里报——先放一个文件模拟它干了活。
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'tasks', 'T-123', 'output'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'tasks', 'T-123', 'output', 'note.md'), '写完了', 'utf8');
  const { request, calls } = fakeServer({ statuses: ['running', 'done'] });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute(baseCtx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.schema, 'aicompany.completion/v1');
  assert.equal(out.result.taskId, 'T-123');
  assert.equal(out.result.runId, 'R-9');
  assert.equal(out.result.status, 'success');
  assert.match(out.result.summary, /3 个文件/);
  assert.deepEqual(out.result.artifacts, ['output/note.md'], '控制面自己扫出产物，不靠 agent 交代');
  assert.ok(calls.some((c) => c.path === '/aiceo/api/task'));
  assert.ok(calls.some((c) => c.path === '/aiceo/api/result'));
  assert.match(calls.find((c) => c.path === '/aiceo/api/task').payload.prompt, /项目规范A/);
  assert.match(calls.find((c) => c.path === '/aiceo/api/task').payload.prompt, /上轮教训B/);
  assert.equal(calls.find((c) => c.path === '/aiceo/api/task').payload.cwd, WORK);
});

test('提示词含任务说明与验收条件', async () => {
  const { request, calls } = fakeServer();
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  await a.execute(baseCtx);
  const prompt = calls.find((c) => c.path === '/aiceo/api/task').payload.prompt;
  assert.match(prompt, /列出当前目录文件/);
  assert.match(prompt, /说清楚有几个文件/);
});

test('投递失败产出 failed report（不 throw）', async () => {
  const { request } = fakeServer({ taskOk: false });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute(baseCtx);
  assert.equal(out.status, 'failed');
  assert.equal(out.result.status, 'failed');
  assert.match(out.result.summary, /投递.*失败/);
});

test('agent 报 error 产出 failed report', async () => {
  const { request } = fakeServer({ statuses: ['error'], resultError: '模型不可用' });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute(baseCtx);
  assert.equal(out.status, 'failed');
  assert.match(out.result.summary, /agent 执行出错.*模型不可用/);
});

test('done 但空文本产出 failed report', async () => {
  const { request } = fakeServer({ statuses: ['done'], text: '   ' });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute(baseCtx);
  assert.equal(out.status, 'failed');
  assert.match(out.result.summary, /没有返回任何内容/);
});

test('缺 taskId 直接产出 failed report', async () => {
  const { request, calls } = fakeServer();
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute({ ...baseCtx, taskId: undefined, task: {} });
  assert.equal(out.status, 'failed');
  assert.equal(calls.length, 0);
});

test('completion report 过 schema 校验', async () => {
  const { validate } = await import('../src/validate.js');
  const { request } = fakeServer();
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute(baseCtx);
  const checked = validate('completion', out.result);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
});

test('完成报告会落到任务根目录（看门狗与验收都按这个位置找）', async () => {
  const { request } = fakeServer();
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  await a.execute(baseCtx);
  const file = path.join(WORK, 'tasks', 'T-123', 'completion.json');
  assert.equal(fs.existsSync(file), true, file);
});

// ---- CEO 模式：只拆解 / 验收，产出 CEO 输出契约，不产出完成报告 ----

const ceoCtx = {
  ...baseCtx,
  taskId: 'T-777', runId: 'R-77',
  task: {
    taskId: 'T-777', revision: 1, title: '给看板加每日巡检',
    instructions: '加一个每天自动巡检的功能', acceptance: ['产物落盘且能跑'],
  },
  agent: { id: 'ceo', isCEO: true },
  adapterConfig: { workRoot: WORK, mode: 'ceo' },
  company: {
    agents: [
      { id: 'ceo', postTitle: '总经理', holderName: '外部 agent', displayName: '总经理', isCEO: true, capabilities: ['plan'], status: 'active', adapter: 'webhook-exec' },
      { id: 'doubao', postTitle: '执行', holderName: '豆包工作', displayName: '执行', isCEO: false, capabilities: ['execute'], status: 'active', adapter: 'gui-template' },
    ],
  },
  availableProjects: [{ id: 'aicompany-dev', displayName: 'AICompany 自研开发', specExists: true, rootDir: null }],
  wakeReason: 'issue_assigned',
};

test('CEO 模式：从带解释的回复里抠出拆解 JSON，并带上员工名册', async () => {
  const text = '我的判断：属于已有项目 aicompany-dev，派执行岗。\n'
    + '```json\n{"type":"task-create","summary":"归 aicompany-dev","tasks":[{"title":"加每日巡检","assignee":"doubao","difficulty":"normal","project":"aicompany-dev","instructions":"写一个每日巡检脚本","acceptance":["脚本能跑"]}]}\n```';
  const { request, calls } = fakeServer({ statuses: ['done'], text });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute(ceoCtx);
  assert.equal(out.status, 'success');
  assert.equal(out.result.type, 'task-create');
  assert.equal(out.result.tasks[0].assignee, 'doubao');
  assert.equal(out.sessionParams.mode, 'ceo');
  const posted = calls.find((c) => c.path === '/aiceo/api/task');
  assert.equal(posted.payload.taskId, 'T-777-plan');
  assert.match(posted.payload.prompt, /你是 AICompany 的总经理/);
  assert.match(posted.payload.prompt, /不要自己写代码/);
  // 名册按「岗位 → 担任者」写，agent 名不许冒充席位名。
  assert.match(posted.payload.prompt, /doubao｜岗位「执行」｜担任者「豆包工作」/);
  assert.match(posted.payload.prompt, /aicompany-dev/);
});

test('CEO 模式：验收轮给产物目录，校验 verdict', async () => {
  const text = '{"type":"review","verdict":"pass","reason":"产物齐全、能跑","summary":"通过"}';
  const { request, calls } = fakeServer({ statuses: ['done'], text });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  const out = await a.execute({ ...ceoCtx, wakeReason: 'review_requested' });
  assert.equal(out.result.type, 'review');
  assert.equal(out.result.verdict, 'pass');
  const posted = calls.find((c) => c.path === '/aiceo/api/task');
  assert.equal(posted.payload.taskId, 'T-777-review');
  assert.match(posted.payload.prompt, /验收/);
  assert.match(posted.payload.prompt, /tasks\/T-777\/output/);
});

test('CEO 模式：回复里没有可解析契约就报错（不静默当完成）', async () => {
  const { request } = fakeServer({ statuses: ['done'], text: '我觉得这个活挺好的，你们看着办。' });
  const a = createWebhookExecAdapter({ request, sleep: async () => {} });
  await assert.rejects(() => a.execute(ceoCtx), /没有给出可解析的 JSON/);
});
