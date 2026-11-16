#!/usr/bin/env node
// 演示 / 测试用的本地假 agent：从 stdin 读上下文，输出一行结构化 JSON。
// 不调用任何外部模型、不联网、不烧额度；真实 agent 由用户自己配 company.yaml。

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let ctx = {};
  try { ctx = JSON.parse(input || '{}'); } catch { /* 保持空上下文 */ }
  const workers = (ctx.company?.agents ?? []).filter((a) => !a.isCEO);
  const workerId = workers[0]?.id ?? 'worker-01';
  const taskId = ctx.task?.taskId ?? 'T-unknown';
  const runId = ctx.runId ?? 'R-unknown';
  const stamp = new Date().toISOString();
  let output;

  if (ctx.agent?.isCEO) {
    if (ctx.wakeReason === 'review_requested') {
      output = {
        type: 'review', taskId,
        verdict: process.env.FAKE_REJECT === '1' ? 'reject' : 'pass',
        reason: '机检通过，验收合格',
      };
    } else {
      output = {
        type: 'task-create',
        title: ctx.wakeReason === 'escalation' ? '派生任务（变更请求）' : '执行子任务',
        role: 'general', assignee: workerId,
        instructions: '按 brief 执行并写出完成报告。',
        acceptance: ['completion.json 通过 schema 校验且 status = success'],
      };
    }
  } else {
    const failFirst = process.env.FAKE_FAIL_FIRST === '1' && (ctx.task?.attempt ?? 0) === 0;
    const failed = failFirst || process.env.FAKE_FAIL === '1';
    output = {
      schema: 'aicompany.completion/v1', taskId, runId,
      agent: ctx.agent?.id ?? workerId,
      revision: ctx.task?.revision ?? 1,
      status: failed ? 'failed' : 'success',
      summary: failed ? '模拟执行失败（用于打回重跑测试）' : '模拟执行完成',
      artifacts: failed ? [] : ['output/result.md'],
      checksum: failed ? {} : { 'output/result.md': 'sha256:mock' },
      acceptanceResults: failed ? [] : [{ rule: 'output/result.md 存在且非空', pass: true }],
      usage: { quotaUnits: 1 },
      finishedAt: stamp,
    };
    if (failed) output.reason = '注入的失败，用于验证打回自动重跑';
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
});
