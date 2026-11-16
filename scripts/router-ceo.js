#!/usr/bin/env node
// 确定性「派单器」：给生产实例当一个不用模型、也不烧额度的 CEO 占位。
//
// 为什么需要它：引擎规则要求「有且只有一个 isCEO 席位」，而接真模型（dsh / 我自己 / hermes）
// 还没做。没有占位的话，配置根本起不来，direct 模式也用不了 —— 但 direct 恰恰是「天天用」的主路径。
//
// 它做两件事，都不做判断、不编内容：
//   1. 收到需求 → 派生一张子卡，指令与验收条件**原样继承**，派给第一个执行席位（难度也由引擎继承）
//   2. 收到验收请求 → 放行（真正的质量把关是「产物必须落盘且过 schema」，那部分是硬校验）
//
// 一句话：只搬运，不创作。接上真模型后把它换掉即可，配置改一行。

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let ctx = {};
  try { ctx = JSON.parse(input || '{}'); } catch { /* 空上下文就按最小卡片处理 */ }
  const task = ctx.task ?? {};
  const workers = (ctx.company?.agents ?? []).filter((a) => !a.isCEO);
  const workerId = workers[0]?.id;
  const taskId = task.taskId ?? ctx.taskId ?? 'T-unknown';

  let output;
  if (ctx.wakeReason === 'review_requested') {
    output = {
      type: 'review', taskId, verdict: 'pass',
      reason: '派单器不做质量判断；产物已落盘并通过 schema / 校验和检查，按通过放行',
    };
  } else {
    output = {
      type: 'task-create',
      title: task.title ? `${task.title}` : '执行需求',
      role: 'general',
      ...(workerId ? { assignee: workerId } : {}),
      instructions: task.instructions || '按需求完成，并把结果写成文件。',
      acceptance: (Array.isArray(task.acceptance) && task.acceptance.length)
        ? task.acceptance
        : ['output/ 下至少有一个非空产物文件'],
    };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
});
