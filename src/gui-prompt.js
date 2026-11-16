// P3-2 / P3-3：提示词模板与操作序列。
// 铁律：窗口标题、快捷键、按键一律来自 gui-template 配置，**源码里不写死任何一个**。
// 提示词用「槽位」而不是自由文案：自定义模板也必须渲染出全部槽位，否则拒绝发送（§8.3 第 4 条）。

export const REQUIRED_PROMPT_SLOTS = Object.freeze([
  'taskId', 'inputDir', 'outputDir', 'reportPath', 'changeRequestsDir',
  'reportsTo', 'instructions', 'acceptance', 'noScreenOnly', 'changeRequestHint',
]);

export const SUPPORTED_STEP_ACTIONS = Object.freeze([
  // restoreFocus 是「把电脑还给你」的收尾动作：必须排在最后一步。
  'activate', 'newSession', 'hotkey', 'paste', 'press', 'verify', 'restoreFocus',
]);

// 默认模板只讲「写什么文件、写到哪儿」，不提任何具体产品、窗口标题或按键。
export const DEFAULT_PROMPT_TEMPLATE = [
  '你是本公司的一个执行席位。请严格按下面要求完成任务，并把结果写成文件。',
  '',
  '任务编号：{{taskId}}',
  '汇报对象：{{reportsTo}}',
  '输入素材（只读，绝对路径）：{{inputDir}}',
  '产物只能写到（绝对路径）：{{outputDir}}',
  '变更请求目录（绝对路径）：{{changeRequestsDir}}',
  '',
  '任务说明：{{instructions}}',
  '验收条件：{{acceptance}}',
  '',
  '{{projectContext}}',
  '',
  '完成后必须把完成报告写到这个绝对路径：{{reportPath}}',
  '报告字段必须是 aicompany.completion/v1 的固定结构：schema / taskId / runId / agent /',
  'revision / status / summary / artifacts / checksum / acceptanceResults / usage / finishedAt。',
  'status 只允许 success | failed | blocked；failed 必须带 reason。',
  '{{noScreenOnly}}',
  '写完即终态，不要事后修改；产物路径越界（不在 output/ 下）一律不入库。',
  '',
  '{{changeRequestHint}}',
  '变更请求字段模板见 brief.md；控制面会先检查这个目录，不会把你的请求当成超时或失败。',
  '进度可以覆盖写 progress.json，但进度不触发任何唤醒。',
].join('\n');

// P6：给「聊天窗口型助手」用的模板。区别只有一处 ——
// 不要求它写合规的 completion.json（算 sha256 不现实），只让它写三字段的 draft，
// 正式报告由控制面扫描产物生成。其余槽位一个不少，保证仍然能通过槽位校验。
export const DRAFT_PROMPT_TEMPLATE = [
  '你是本公司的一个执行席位。请完成任务，并把结果写成文件。',
  '',
  '任务编号：{{taskId}}',
  '汇报对象：{{reportsTo}}',
  '输入素材（只读，绝对路径）：{{inputDir}}',
  '',
  '任务说明：{{instructions}}',
  '验收条件：{{acceptance}}',
  '',
  '{{projectContext}}',
  '',
  '【硬性要求，逐条照做】',
  '1. 所有产物只能写进这个目录（绝对路径）：{{outputDir}}',
  '2. {{noScreenOnly}}',
  '3. 写完后，把这份极简报告写到：{{taskDir}}\\report.draft.json',
  '   允许的字段如下（前两个必填，后两个可选），不要加别的：',
  '   {',
  '     "status": "success",',
  '     "summary": "一句话说明你做了什么、产出是哪个文件",',
  '     "lessons": ["这次踩的坑 / 怎么绕过去的（最多 8 条，每条一句话）"],',
  '     "nextHints": ["下一单同类活开工前该注意什么（最多 8 条）"]',
  '   }',
  '   lessons / nextHints 会写进公司对该项目的长期记忆，下一单的同事开工前会读到；',
  '   写具体、可操作的经验，不要写「做得不错」这类空话。',
  '   做不到就把 status 写成 failed 或 blocked，并加一个 "reason" 字段说明原因。',
  '4. 不要自己算校验和，也不要写 {{reportPath}} —— 那份正式报告由控制面根据你的产物自动生成。',
  '',
  '{{changeRequestHint}}',
  '变更请求写到这个目录：{{changeRequestsDir}}',
].join('\n');

export function promptSlotValues({ task = {}, paths = {}, config = {}, projectContext = '' }) {
  return {
    taskId: task.taskId ?? '(缺 taskId)',
    taskDir: paths.taskDir ?? '(缺 taskDir)',
    inputDir: paths.inputDir ?? '(缺 inputDir)',
    outputDir: paths.outputDir ?? '(缺 outputDir)',
    reportPath: paths.reportPath ?? '(缺 reportPath)',
    changeRequestsDir: paths.changeRequestsDir ?? '(缺 changeRequestsDir)',
    reportsTo: task.reportsTo ?? config.reportsTo ?? '(沿汇报线)',
    instructions: task.instructions ?? '(见 brief.md)',
    acceptance: Array.isArray(task.acceptance) ? task.acceptance.join('；') : String(task.acceptance ?? ''),
    // P7：项目规范 + 最近经验。没项目时是空串（模板里那一行会留白，不影响阅读）。
    projectContext: String(projectContext ?? '').trim(),
    noScreenOnly: '不要只在屏幕上回复「已完成」，必须把报告写到指定文件',
    changeRequestHint: '发现方向不对 / 范围要改时，不要只在屏幕上说明，写 change-requests/<crId>.json',
  };
}

export function assertPromptComplete(prompt, values) {
  const missing = REQUIRED_PROMPT_SLOTS.filter((slot) => {
    const value = String(values[slot] ?? '').trim();
    return !value || !String(prompt).includes(value);
  });
  if (!String(prompt).includes('completion.json')) missing.push('completion.json 字面路径');
  if (missing.length) {
    throw new Error(`提示词模板缺少必备内容，拒绝发送：${missing.join('、')}`);
  }
  return { ok: true, slots: REQUIRED_PROMPT_SLOTS.length };
}

export function renderPrompt({ task = {}, paths = {}, config = {}, projectContext = '' } = {}) {
  const values = promptSlotValues({ task, paths, config, projectContext });
  // reportMode: 'draft' 时换成「只写 draft」的模板；默认仍是要求完整 completion.json 的那份。
  let prompt = config.promptTemplate
    ?? (config.reportMode === 'draft' ? DRAFT_PROMPT_TEMPLATE : DEFAULT_PROMPT_TEMPLATE);
  const templateHasContextSlot = String(prompt).includes('{{projectContext}}');
  for (const [slot, value] of Object.entries(values)) {
    prompt = String(prompt).replaceAll(`{{${slot}}}`, String(value));
  }
  // 自定义模板没写这个槽位：不能因此把项目规范悄悄吞掉 —— 补在末尾，让人一眼看得见。
  if (!templateHasContextSlot && values.projectContext) {
    prompt = `${prompt}\n\n${values.projectContext}`;
  }
  // 模板里出现未渲染的槽位说明配置写错了，也要拒绝。
  const leftover = /\{\{([^}]+)\}\}/.exec(prompt);
  if (leftover) throw new Error(`提示词模板含未知槽位 {{${leftover[1]}}}，拒绝发送`);
  assertPromptComplete(prompt, values);
  return { prompt, values };
}

// 操作序列完全由配置给出；这里只做白名单校验与序号归一，不提供任何默认按键。
export function normalizeSteps(config = {}) {
  const raw = config.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('gui-template 必须由配置提供 steps（源码不写死任何窗口标题或按键）');
  }
  return raw.map((step, index) => {
    if (!step || typeof step.action !== 'string' || !SUPPORTED_STEP_ACTIONS.includes(step.action)) {
      throw new Error(`steps[${index}].action 不合法；可用：${SUPPORTED_STEP_ACTIONS.join(' / ')}`);
    }
    // restoreFocus 会把焦点还给用户，之后再校验「前台是不是目标窗口」必然失败；
    // 所以它只能是最后一步，写错位置直接拒绝启动（不要等真机跑到一半才发现）。
    if (step.action === 'restoreFocus' && index !== raw.length - 1) {
      throw new Error(`steps[${index}].action = restoreFocus 必须排在最后一步（它会把焦点还给用户）`);
    }
    return { ...step, index };
  });
}
