// P3-2 / P3-3：提示词模板与操作序列。
// 铁律：窗口标题、快捷键、按键一律来自 gui-template 配置，**源码里不写死任何一个**。
// 提示词用「槽位」而不是自由文案：自定义模板也必须渲染出全部槽位，否则拒绝发送（§8.3 第 4 条）。

export const REQUIRED_PROMPT_SLOTS = Object.freeze([
  'taskId', 'inputDir', 'outputDir', 'reportPath', 'changeRequestsDir',
  'reportsTo', 'instructions', 'acceptance', 'noScreenOnly', 'changeRequestHint',
]);

export const SUPPORTED_STEP_ACTIONS = Object.freeze([
  // restoreFocus 是「把电脑还给你」的收尾动作：必须排在最后一步。
  // focusInput 是「把光标点进输入框」：应用还停在首页 / 窗口尺寸异常时，paste 会落空。
  'activate', 'newSession', 'hotkey', 'focusInput', 'paste', 'press', 'verify', 'restoreFocus',
]);

// 默认模板只讲「写什么文件、写到哪儿」，不提任何具体产品、窗口标题或按键。
// 第一句只写「一个席位」不写「执行席位」：GUI 席位里也可能坐的是工程岗 / 管理岗，
// 写死「执行」会把它往「自己动手干」的方向推（2026-11-17 真机：工程岗收到「你是执行席位」
// 后把实现活全自己干了）。真正的岗位身份由 adapter 在模板前面注入（seatBriefing）。
export const DEFAULT_PROMPT_TEMPLATE = [
  '你是本公司的一个席位。请严格按下面要求完成任务，并把结果写成文件。',
  '',
  '任务编号：{{taskId}}',
  '汇报对象：{{reportsTo}}',
  '输入素材（只读，绝对路径）：{{inputDir}}',
  '产物落点（绝对路径）：{{projectWriteDir}}',
  '{{outputDiscipline}}',
  '变更请求目录（绝对路径）：{{changeRequestsDir}}',
  '',
  '任务说明：{{instructions}}',
  '验收条件：{{acceptance}}',
  '',
  '{{reworkNote}}',
  '{{projectContext}}',
  '',
  '完成后必须把完成报告写到这个绝对路径：{{reportPath}}',
  '报告字段必须是 aicompany.completion/v1 的固定结构：schema / taskId / runId / agent /',
  'revision / status / summary / artifacts / checksum / acceptanceResults / usage / finishedAt。',
  'status 只允许 success | failed | blocked；failed 必须带 reason。',
  '{{noScreenOnly}}',
  '写完即终态，不要事后修改；产物路径越界（不在本单落点内）一律不入库。',
  '',
  '{{changeRequestHint}}',
  '变更请求字段模板见 brief.md；控制面会先检查这个目录，不会把你的请求当成超时或失败。',
  '进度可以覆盖写 progress.json，但进度不触发任何唤醒。',
  '开工前把任务目录里的 ack.md 改一行（收到｜预计 N 分钟｜我的理解：…）；不写不判失败，只是引擎对你的耐心会减半。',
].join('\n');

// P6：给「聊天窗口型助手」用的模板。区别只有一处 ——
// 不要求它写合规的 completion.json（算 sha256 不现实），只让它写三字段的 draft，
// 正式报告由控制面扫描产物生成。其余槽位一个不少，保证仍然能通过槽位校验。
export const DRAFT_PROMPT_TEMPLATE = [
  '你是本公司的一个席位。请完成任务，并把结果写成文件。',
  '',
  '任务编号：{{taskId}}',
  '汇报对象：{{reportsTo}}',
  '输入素材（只读，绝对路径）：{{inputDir}}',
  '',
  '任务说明：{{instructions}}',
  '验收条件：{{acceptance}}',
  '',
  '{{reworkNote}}',
  '{{projectContext}}',
  '',
  '【硬性要求，逐条照做】',
  '1. 产物写到这个目录（绝对路径）：{{projectWriteDir}}',
  '   落点表见【项目规范】里的 workflow.outputs：哪类产物进哪个子目录按项目规矩来，不要自己另起名字。',
  '   {{outputDiscipline}}',
  '   路径一律写绝对路径；相对路径会落到当前工作目录，控制面找不到。',
  '2. {{noScreenOnly}}',
  '3. 写完后，把这份极简报告写到：{{taskDir}}\\report.draft.json',
  '   ★ 这份草稿是唯一的例外：它不属于产物，**必须**放在任务目录（上面这个路径），',
  '   绝对不要写进 {{outputDir}} 或它的任何子目录 —— 写错位置控制面收不到单，整单会判失败。',
  '   允许的字段如下（status/summary 必填，lessons/nextHints/deliverables 可选），不要加别的：',
  '   {',
  '     "status": "success",',
  '     "summary": "一句话说明你做了什么、产出是哪个文件",',
  '     "deliverables": [{"path": "你真正交付的文件的绝对路径"}],',
  '     "lessons": ["这次踩的坑 / 怎么绕过去的（最多 8 条，每条一句话）"],',
  '     "nextHints": ["下一单同类活开工前该注意什么（最多 8 条）"]',
  '   }',
  '   {{deliverablesHint}}',
  '   lessons / nextHints 会写进公司对该项目的长期记忆，下一单的同事开工前会读到；',
  '   ★ 这两个字段请不要留空：哪怕只写一条「哪一步最费时间 / 哪条命令差点踩坑」也比空着有用。',
  '   确实没有任何经验可写，就写空数组 []，但不要为了凑数编造。',
  '   写具体、可操作的经验，不要写「做得不错」这类空话。',
  '   做不到就把 status 写成 failed 或 blocked，并加一个 "reason" 字段说明原因。',
  '4. 不要自己算校验和，也不要写 {{reportPath}} —— 那份正式报告由控制面根据你的产物自动生成。',
  '5. 开工前把任务目录里的 ack.md 改一行（收到｜预计 N 分钟｜我的理解：…）；不写不判失败，只是引擎对你的耐心会减半。',
  '',
  '{{changeRequestHint}}',
  '变更请求写到这个目录：{{changeRequestsDir}}',
].join('\n');

export function promptSlotValues({ task = {}, paths = {}, config = {}, projectContext = '', project = null }) {
  // 落盘改造（2026-11-23）：产物落点由引擎按项目配置算好（projects.<id>.rootDir + deliverSubdir），
  // 席位照写即可，不用自己猜项目目录。没项目 / 项目没配 rootDir 时退回 output/，行为同旧版。
  const writeDir = project?.writeDir ? String(project.writeDir) : null;
  return {
    taskId: task.taskId ?? '(缺 taskId)',
    taskDir: paths.taskDir ?? '(缺 taskDir)',
    inputDir: paths.inputDir ?? '(缺 inputDir)',
    outputDir: paths.outputDir ?? '(缺 outputDir)',
    projectWriteDir: writeDir ?? paths.outputDir ?? '(缺 outputDir)',
    outputDiscipline: writeDir
      ? [
        '【落盘纪律】项目产物（交付文件、代码、图片、PDF、表格等）只能写进上面的产物落点及其子目录，禁止写进 output/。',
        'output/ 只放跟任务卡有关的公司文件：ack.md、progress.json、report.draft.json、manifest.json、change-requests/、blocked.json。',
        '需要临时脚本时放在项目自己的工作目录（见项目规范），不要放 output/。',
      ].join('\n')
      : '【落盘纪律】本单没有项目落点，产物写到 output/ 目录；脚本与控制面文件不要混进产物。',
    deliverablesHint: writeDir
      ? '★ deliverables 必须列出你真正交付的文件（绝对路径，且在上面那个落点目录里）：控制面按这份清单逐个核对存在与大小，报不出来或路径对不上就收不了单。中间产物、脚本、截图不要往里写。'
      : '本单没有项目落点，控制面会自己扫描 output/，deliverables 可以省略。',
    reportPath: paths.reportPath ?? '(缺 reportPath)',
    changeRequestsDir: paths.changeRequestsDir ?? '(缺 changeRequestsDir)',
    reportsTo: task.reportsTo ?? config.reportsTo ?? '(沿汇报线)',
    instructions: task.instructions ?? '(见 brief.md)',
    acceptance: Array.isArray(task.acceptance) ? task.acceptance.join('；') : String(task.acceptance ?? ''),
    // 打回重做：把验收意见原样讲给执行人。不是打回时给空串，模板那一行自然消失。
    // 不给这段，执行人被重新叫起来只看得到原任务说明，只能猜「到底哪没过」（T-906d3686）。
    reworkNote: (() => {
      const note = String(task.reviewNote ?? '').trim();
      if (!note) return '';
      return [
        '【重要：这张卡是打回重做，不是新任务】',
        `上一轮验收没通过，验收人写的意见：${note}`,
        '只改被指出的问题，已经验收通过的部分不要推翻重做；',
        '改完仍按上面的要求把报告写到同一个位置（覆盖上一轮那份）。',
      ].join('\n');
    })(),
    // P7：项目规范 + 最近经验。没项目时是空串（模板里那一行会留白，不影响阅读）。
    projectContext: String(projectContext ?? '').trim(),
    noScreenOnly: '不要只在屏幕上回复「已完成」，必须把报告写到指定文件；也不要把问题只写在屏幕上等人回答',
    // 2026-11-23 真机事故：执行席位需要人配合时，直接在会话窗口里问"请你先关掉 X 再告诉我"，
    // 董事会没看那个窗口，于是无人应答，任务空转到 60 分钟超时才重做。
    // 原来这一句只覆盖「方向不对 / 范围要改」，把「要人配合 / 要信息 / 要权限 / 要确认」全漏掉了。
    // 现在扩成一份沟通纪律：会话窗口是工作面，不是对话渠道；要人做事只能走 change-requests。
    changeRequestHint: [
      '【沟通纪律】你看不到我，我也看不到你的对话窗口——这个窗口没有人值守，你在里面说的话不会被读到。',
      '凡是需要人配合、需要人给信息、需要人开权限、需要人确认某件事，一律不许在窗口里提问，',
      '必须写 change-requests/<crId>.json（kind=clarify，severity=needsDecision，reason 写清「要谁做什么」），然后停手。',
      '写完就停，不要等回复；控制面会把它转到能拍板的人那里，拍板后你会被重新唤醒并拿到答复。',
      '没有人答复时：按最保守的假设继续做完，并在报告里列出你替人做的假设（标注 assumed），不要停在原地等。',
      '确实做不下去（缺权限 / 缺环境 / 产物生成不了）时：写 blocked.json（{"reason":"卡在哪","need":"需要谁做什么"}）然后停手，不要反复乱试、也不要只在窗口里说。',
    ].join('\n'),
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

export function renderPrompt({ task = {}, paths = {}, config = {}, projectContext = '', project = null } = {}) {
  const values = promptSlotValues({ task, paths, config, projectContext, project });
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
