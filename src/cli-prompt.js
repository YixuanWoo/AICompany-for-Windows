// CLI 席位的提示词（纯函数，可单测）。
//
// 2026-11-23 抽出来的原因：提示词原来是桥接脚本里的内部函数，只能靠「读源码找字符串」
// 做回归 —— 上次「[object Object] 吞掉项目规范」的 bug 就这么活了好几天。
// 现在提示词是一段可以单独构造、单独断言的纯逻辑，桥接只负责把它喂给 CLI。
//
// 落盘口径与 GUI 席位（gui-prompt.js）保持一致：
//   有项目落点 → 产物写项目目录，output/ 只放公司自己的文件，draft 里报 deliverables；
//   没项目落点 → 产物写 output/，控制面自己扫描，deliverables 可省。

import path from 'node:path';

export function buildCliPrompt(ctx = {}, paths = {}) {
  const task = ctx.task ?? {};
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance.join('；') : String(task.acceptance ?? '');
  const writeDir = ctx.project?.writeDir ? String(ctx.project.writeDir) : null;
  const deliverDir = writeDir ?? paths.outputDir;

  const heading = [
    '你是一台无人值守流水线里的执行席位，不是聊天助手。这个窗口没有人值守，你在里面说的话不会被读到。',
    '',
    `任务编号：${task.taskId ?? ctx.taskId ?? '-'}`,
    `任务标题：${task.title ?? '-'}`,
    `任务说明：${task.instructions ?? '(见 brief.md)'}`,
    `验收条件：${acceptance || '(见 task.json)'}`,
    `产物落点（绝对路径）：${deliverDir}`,
  ];

  if (writeDir) {
    heading.push(
      '【落盘纪律】项目产物（交付文件、代码、图片、PDF、表格等）只能写进上面的产物落点及其子目录，'
        + `禁止写进 ${paths.outputDir}（output/）。`,
      'output/ 只放跟任务卡有关的公司文件：ack.md、progress.json、report.draft.json、change-requests/、blocked.json。',
      '产物具体进哪个子目录，看下面【项目规范】里 workflow.outputs 的落点表，不要自己另起目录名。',
      '需要临时脚本时放在项目自己的工作目录，不要放 output/。',
    );
  } else {
    heading.push(`【落盘纪律】本单没有项目落点，产物写到 ${paths.outputDir}（output/）；脚本与控制面文件不要混进产物。`);
  }

  heading.push(
    '路径一律写绝对路径：相对路径会落在当前工作目录，控制面找不到，整单会被判「没有可用产物」而重新派一遍。',
    `正式报告由控制面生成，你只需要写：${path.join(paths.taskDir ?? '', 'report.draft.json')}`,
    `需要人配合或要拍板：写 ${path.join(paths.changeRequestsDir ?? '', 'CR-<时间戳>.json')}`
      + '（{"schema":"aicompany.change-request/v1","kind":"clarify","severity":"needsDecision","reason":"要谁做什么"}），写完停手，不要等回复。',
    `确实做不下去：写 ${path.join(paths.taskDir ?? '', 'blocked.json')}`
      + '（{"reason":"卡在哪","need":"需要谁做什么"}），然后停手。',
    '',
    'report.draft.json 的格式：{"status":"success","summary":"一句话说清干了什么","deliverables":[{"path":"交付文件的绝对路径"}]}',
  );
  if (writeDir) {
    heading.push(
      '★ deliverables 必须列出你真正交付的文件（绝对路径，且在产物落点目录里）：'
        + '控制面按这份清单逐个核对存在与大小，报不出来或路径对不上就收不了单。中间产物、脚本、截图不要往里写。',
    );
  } else {
    heading.push('本单没有项目落点，控制面会自己扫描 output/，deliverables 可以省略。');
  }
  heading.push(
    '做不到就把 status 写成 failed 或 blocked，并加 "reason" 说明原因；不要只在窗口里解释。',
    '没有人答复时：按最保守的假设做完，并在 summary 里标注 assumed。',
    '全部完成后，最后只回复 DONE。',
  );

  if (ctx.briefing) heading.unshift(String(ctx.briefing), '');
  // ctx.project 是 buildProjectContext() 返回的对象，提示词只能取 .contextText
  // （曾经整个 String 化，拼进去的是字面 "[object Object]"，项目规范一直没下发）。
  const projectText = String(ctx.project?.contextText ?? '').trim();
  if (projectText) heading.push('', projectText);
  if (task.reviewNote) heading.push('', `上一轮打回意见：${task.reviewNote}`);
  return heading.join('\n');
}
