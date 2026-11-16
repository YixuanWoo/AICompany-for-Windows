// webhook-exec：通用「外部执行服务」adapter（AICompany 侧纯 HTTP 客户端）。
//
// 它把任务通过 HTTP 递给一个外部 webhook 执行服务，那头拉起一个真·带工具的 agent
// 去干活，再把 agent 的文本输出包装成 AICompany 的 completion report，交给引擎走
// 正常的验收 / 记忆 / 落盘链路。具体接的是哪家服务由 config 的 baseUrl 决定，
// 引擎与核心源码对任何具体产品名零感知（见 io.test 的零产品名纪律）。
//
// 设计约束：
//   1. 只依赖 node 内置（node:http / node:https），零第三方依赖。
//      不在配置里启用这个 type 的用户完全不受影响。
//   2. 服务端插件是独立可选安装包；本文件只是它的通用 HTTP 客户端。
//   3. 端点全部 POST，响应包在 { ok, value } 里（webhook 契约）。
//   4. 失败一律产出 status='failed' 的 completion report（而不是 throw），
//      让引擎按既有「报告不合格 → 重试 → blocked → 人审」路径处理，不炸控制面。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { CEO_OUTPUT_KINDS } from './enums.js';
import {
  DEFAULT_SESSION_POLICY, ensureCeoSession, recordSessionTurn, withSessionLock,
} from './ceo-session.js';
import { listOutputFiles } from './deliver.js';
import { seatBriefing, ceoRoutingBriefing } from './org-chart.js';
import { describeRepo } from './repos.js';

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;   // agent 干活最久 15 分钟
const DEFAULT_POLL_MS = 2000;
const nowIso = () => new Date().toISOString();

/** 发一个 JSON POST；返回解析后的 body（不做 ok 判定，交给调用方）。 */
function postJson(baseUrl, path, payload, { token = '', timeoutMs = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(path, baseUrl); } catch (error) { reject(error); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload ?? {});
    const reqHeaders = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...headers,
    };
    if (token) reqHeaders['x-aiceo-token'] = token;
    const req = lib.request(url, { method: 'POST', headers: reqHeaders, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (error) {
          reject(new Error(`webhook 返回非 JSON（HTTP ${res.statusCode}）：${raw.slice(0, 200)}`));
          return;
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`webhook 请求超时（${timeoutMs}ms）`)); });
    req.on('error', reject);
    req.end(body);
  });
}

/** 取 { ok, value } 的 value；ok=false 时抛出带 code 的错误。 */
function unwrap(reply, what) {
  const body = reply.body;
  if (reply.statusCode < 200 || reply.statusCode >= 300) {
    throw new Error(`${what} HTTP ${reply.statusCode}：${body?.error?.message ?? ''}`);
  }
  if (!body || body.ok !== true) {
    throw new Error(`${what} 失败：${body?.error?.code ?? '?'} ${body?.error?.message ?? ''}`);
  }
  return body.value;
}

// 产物清单由控制面自己扫，不靠 agent 在回复里报。
// 以前这里写死 artifacts: []，结果「有没有产物」全靠 agent 自觉交代，
// 验收、落盘、项目面板全都跟着瞎。扫一遍 output/ 是确定性的，成本可以忽略。
function scanArtifacts(ctx) {
  const workRoot = ctx.adapterConfig?.workRoot ?? ctx.workRoot ?? null;
  const taskId = ctx.task?.taskId ?? ctx.taskId ?? null;
  if (!workRoot || !taskId) return [];
  try {
    return listOutputFiles(workRoot, taskId).map((f) => `output/${f.name}`).slice(0, 200);
  } catch { return []; }
}

function completion(ctx, status, summary, { artifacts = [], usage = {}, reason, session = {} } = {}) {
  const files = artifacts.length ? artifacts : scanArtifacts(ctx);
  const report = {
    schema: 'aicompany.completion/v1',
    taskId: ctx.taskId ?? ctx.task?.taskId ?? 'T-unknown',
    runId: ctx.runId ?? 'R-unknown',
    agent: ctx.agent?.id ?? 'ceo-agent',
    revision: ctx.task?.revision ?? 1,
    status,
    summary: String(summary ?? '').slice(0, 4000),
    artifacts: files,
    checksum: {},
    acceptanceResults: [],
    usage: { quotaUnits: 1, ...usage },
    finishedAt: nowIso(),
    ...(reason ? { reason } : {}),
  };
  // 运行参数只进 sessionParams（审计用），绝不混进 report —— completion schema 是 additionalProperties:false。
  return { status, result: report, usage: report.usage, sessionParams: { transport: 'webhook-exec', ...session } };
}

/** 从 task + project 上下文拼出给真 agent 的提示词。 */
function buildPrompt(ctx) {
  const task = ctx.task ?? {};
  const lines = [];
  // 身份先讲：不知道「我是谁、上级是谁、能派给谁」的席位，会默认自己是全公司唯一的人。
  // 这段全部来自配置（company.yaml 的 posts），换人 / 加岗不用改代码。
  const org = seatBriefing(
    { agents: ctx.company?.agents ?? [] },
    ctx.agent?.id,
    { repos: ctx.repos ?? null, artifacts: ctx.artifacts ?? null },
  );
  if (org) { lines.push(org, '', '───', ''); }
  lines.push(
    '你是 AICompany 的执行席位，请用你的工具（读文件 / 写文件 / 执行命令）完成下面的任务。',
    '',
    `任务编号：${task.taskId ?? ctx.taskId ?? '(未知)'}`,
    `任务标题：${task.title ?? '(无标题)'}`,
    `难度：${task.difficulty ?? 'normal'}`,
    '',
    '【任务说明】',
    String(task.instructions ?? '（未给出，按标题理解并执行）'),
  );
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
  if (acceptance.length) {
    lines.push('', '【验收条件】');
    for (const a of acceptance) lines.push(`- ${a}`);
  }
  const project = ctx.project;
  if (project) {
    lines.push('', '【项目规范】');
    if (project.specification) lines.push(String(project.specification).slice(0, 8000));
    if (Array.isArray(project.recentMemory) && project.recentMemory.length) {
      lines.push('', '【近期记忆】');
      for (const m of project.recentMemory.slice(0, 10)) {
        lines.push(`- ${typeof m === 'string' ? m : (m.text ?? m.content ?? JSON.stringify(m))}`);
      }
    }
  } else if (ctx.projectAuto) {
    // 执行席位不判断项目归属：那是 CEO 的活。这里只把事实说清，免得它自己另立门户。
    lines.push(
      '',
      '【项目】本卡没有项目归属（不自动落盘）。产物写在工作目录里就行，不要往任何项目文件夹里写。',
    );
  }
  if (task.repo) {
    const repo = (ctx.repos ?? []).find((r) => r.id === task.repo);
    lines.push('', '【这张卡对应哪个仓库】');
    lines.push(repo ? describeRepo(repo) : `仓库 id：${task.repo}（台账里没找到，先别动 git）`);
    lines.push('改代码就在这个目录里改；不要提交、不要推送 —— 提交与推送由审查人在审完之后做。');
  }
  // 交付路由：讲清「谁发布的、默认交给谁」。不讲清，员工会把上级派的活自己结案，
  // 发布者永远看不到结果；或者反过来，把董事会直投的活层层上报，白烧一次总经理的额度。
  const route = task.handoffPolicy;
  if (route) {
    lines.push('', '【这张卡该往哪走】');
    if (route.pinned) {
      const where = route.pinned === 'land' ? '干完直接落盘（不用惊动任何人）'
        : route.pinned === 'escalate' ? '中途发现方向不对就上报'
          : `交 ${route.reviewer} 审`;
      lines.push(`- 发布者发布时已经定好：${route.pinned} —— ${where}。`);
      lines.push('- 这个不用你重新判断：按发布者定的走。发现不对可以往上调（改成 review / escalate），不许往下调。');
    } else if (route.issuerKind === 'board') {
      lines.push('- 发布者：董事会（人）—— 这活只对他负责，**不用上报总经理**。');
      lines.push('- 默认去向：干完直接落盘（handoff=land）。产物就是结果，写清 summary 收工。');
      if (route.allowSelfLand === false) {
        lines.push('- 你觉得需要有人再看一眼，可以写 handoff=review：引擎会转给该审的人（这会多烧一次对方的额度，别滥用）。');
      }
      lines.push('- 董事会原话里要求「给我看 / 等我批」时，卡上已经带上 reviewBy=human：'
        + '那就照常交活，引擎会生成一张待拍板单，董事会点通过才落盘——你不用去催。');
    } else if (route.issuerKind === 'agent') {
      lines.push(`- 发布者：${route.issuerLabel} —— 这是他派的活，结果必须回给他看。`);
      lines.push(`- 默认去向：交回 ${route.reviewer} 审（handoff=review）。`);
      if (route.allowSelfLand === true) {
        lines.push('- 发布者已授权你可以自己判落盘：确属一次性产物就写 handoff=land，不用回他。');
      } else {
        lines.push('- **不要自己写 handoff=land 绕过验收**：上级派的活，员工无权替上级免审。'
          + '引擎会拦下并改成交审，还会记一条痕。');
      }
    } else {
      lines.push('- 发布者不明（老卡 / 系统代派）：按最稳的走，交人审，别自己结案。');
    }
    lines.push('- 想指定谁来审，写 reviewBy（岗位或担任者 id）。只能指自己汇报链上的上级或默认审查人，'
      + '引擎会校验；越权的会被忽略并留痕。');
  }
  lines.push(
    '',
    '【交付要求】',
    '1. 真正动手完成：产物写到工作目录，或在无法写文件时把完整结果写进你的回复。',
    '2. 回复里用一小段话总结：做了什么、产物在哪、验收条件是否满足。',
    '3. 不要修改与本任务无关的文件。',
    '',
    '【交活时回报三件事】（引擎按这三项决定这张卡往哪走）',
    '- artifactKind：managed-code（要长期维护的代码）/ scratch-code（一次性脚本，跑完归档）/ '
      + 'document（文档译稿）/ data（表格数据）/ media（图片音视频）。',
    '- handoff：land（直接落盘结案）/ review（交人审）/ escalate（方向不对，上报）。',
    '- boardNote：一句给董事会看的人话（见下）。',
    '- 判不准就按你实际干的东西如实写；拿不准是不是「受管代码」时，宁可按 managed-code 交 —— '
      + '多一次审查比多一份没人接手的代码便宜。',
    '',
    '【boardNote 怎么写】董事会不看技术报告，只看结论。写一句，最多两句，像对同事说话：',
    '- 写「做成了什么、结果是什么」，例：术语表理好了，42 条，按原文出现顺序排的。',
    '- 不写文件路径、不写字段名、不写「已完成任务 T-xxxx」、不复述指令、不罗列步骤。',
    '- 不确定时写你最有把握的那句结论，别写「请查看报告」。',
  );
  return lines.join('\n');
}

/**
 * CEO 模式的提示词：把「你有员工、你只负责拆解与验收、你必须输出结构化 JSON」讲死。
 * 不给名册，CEO 就只能自己动手——这正是之前的毛病。
 */
// 导出给测试用：提示词是 CEO 行为的唯一约束，改动了必须有断言盯着。
export function buildCeoPrompt(ctx) {
  const task = ctx.task ?? {};
  const workRoot = ctx.workRoot ?? ctx.adapterConfig?.workRoot ?? '';
  const agents = Array.isArray(ctx.company?.agents) ? ctx.company.agents : [];
  const employees = agents.filter((a) => a.isCEO !== true && a.status !== 'disabled');
  const projects = Array.isArray(ctx.availableProjects) ? ctx.availableProjects : [];
  const isReview = ctx.wakeReason === 'review_requested';

  // 名册按「岗位 → 担任者」写：CEO 看见的是工作岗位，不是一堆 agent 代号。
  const seatLabel = (a) => {
    const post = a.postTitle ?? a.displayName ?? a.id;
    const holder = a.holderName ? `｜担任者「${a.holderName}」` : '';
    const kind = a.adapter === 'gui-template'
      ? '桌面应用（在本机窗口里操作，抢键鼠、一次一件，慢）'
      : a.adapter === 'webhook-exec'
        ? '外部 agent（能读盘、跑命令；按量计费，贵）'
        : '本地脚本';
    const cap = Array.isArray(a.capabilities) && a.capabilities.length ? a.capabilities.join('/') : 'execute';
    const diff = a.maxDifficulty ? `｜难度上限 ${a.maxDifficulty}` : '｜难度不限';
    return `- ${a.id}｜岗位「${post}」${holder}｜${kind}｜能力 ${cap}${diff}｜状态 ${a.status ?? 'active'}`;
  };

  const lines = [];
  // 共用会话会带着历史：必须说清「历史是记录，不是这一轮的任务」。
  // 不说这句，它会看到上一轮自己拆的卡，以为还没派，于是重派一遍。
  lines.push(
    '【会话】你和董事会的往来都在这一个会话里（为了命中缓存、省额度）。',
    '你看到的历史是你自己前几轮的判断，那是记录，不是新指令：这一轮只处理下面这张卡，不要复述、不要重派已经派过的活。',
    '',
  );
  // 组织图 + 派活路由：CEO 必须知道「谁是谁的下级、什么活该谁干」，
  // 否则它会把翻译派给工程、把写代码派给桌面应用，或者干脆自己动手。
  const routing = ceoRoutingBriefing({ agents });
  if (routing) lines.push(routing, '', '───', '');
  if (isReview) {
    lines.push(
      '你是 AICompany 的总经理，现在做**验收**——不是执行，也不要修改任何文件。',
      '',
      `【被验收的卡】${task.taskId ?? '(未知)'}｜${task.title ?? '(无标题)'}`,
      '',
      '【当初的要求】',
      String(task.instructions ?? '（未记录）'),
    );
    const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
    if (acceptance.length) {
      lines.push('', '【验收条件】');
      for (const a of acceptance) lines.push(`- ${a}`);
    }
    lines.push(
      '',
      '【去这些地方找证据】',
      `- 产物目录：${workRoot ? `${workRoot}/tasks/${task.taskId}/output` : '（未知）'}`,
      `- 完成报告：${workRoot ? `${workRoot}/tasks/${task.taskId}/completion.json` : '（未知）'}`,
      '用你的工具真的去读文件、看内容，不要凭承接人的自述下结论。',
      '',
      '【输出】只输出一个 JSON 对象，不要别的文字：',
      '{"type":"review","verdict":"pass","reason":"一句话结论","summary":"给董事会看的验收意见"}',
      '- pass 才收账；要返工就把 verdict 写成 "reject"，reason 写清「要改什么」——承接人会照着返工。',
    );
    return lines.join('\n');
  }

  lines.push(
    '你是 AICompany 的总经理（CEO）。你的职责只有三件：**定方向、拆活派活、验收**。',
    '你不是执行席位：不要自己写代码、不要自己改文件、不要自己产出交付物。活必须派给下面的员工。',
    '',
    '【红线】你唯一被允许做的事，是输出下面那个 JSON（拆几张卡、派给谁、怎么算过）。',
    '一旦你开始自己动手——写文件、改代码、跑命令产出东西——这轮直接作废并退回董事会。',
    '外部 agent 的额度按量计费，你的每一个 token 都应该花在「想清楚派给谁」上，不是替员工干活。',
    '',
    '【董事会交办】',
    `标题：${task.title ?? '(无标题)'}`,
    `原话：${String(task.instructions ?? '（未给出）')}`,
  );
  if (Array.isArray(task.acceptance) && task.acceptance.length) {
    lines.push('【董事会写的验收条件】');
    for (const a of task.acceptance) lines.push(`- ${a}`);
  }
  lines.push(
    '',
    '【你能派的员工】（只能写这里的 id；每张卡一个承接人）',
    ...(employees.length ? employees.map(seatLabel) : ['（当前没有任何员工，只能把活拆成一张卡交给董事会自己处理）']),
    '',
    '【现有项目】（没列出来的＝还不存在，只能建议新建）',
  );
  if (projects.length) {
    for (const p of projects) {
      const where = p.rootDir ? `${p.rootDir}${p.deliverSubdir ? '/' + p.deliverSubdir : ''}` : '不自动落盘';
      lines.push(`- ${p.id}（${p.displayName ?? p.id}）→ ${where}${p.specExists ? '' : '｜【还没有规范，派活会被拒】'}`);
      // 项目记忆是 CEO 判断「这项目现在缺什么」的唯一依据：只给项目名，它就只会说空话。
      const memory = Array.isArray(p.recentMemory) ? p.recentMemory : [];
      if (memory.length) {
        for (const m of memory) {
          const bits = [m.at, m.title, m.summary].filter(Boolean).join('｜');
          lines.push(`    · 近事：${bits}${m.lesson ? `｜教训：${m.lesson}` : ''}`);
        }
      } else if (p.memoryCount > 0) {
        lines.push(`    · 记忆 ${p.memoryCount} 条（最近几条读不出来，别猜内容）`);
      }
    }
  } else {
    lines.push('（公司还没配项目）');
  }
  const repos = Array.isArray(ctx.repos) ? ctx.repos : [];
  if (repos.length) {
    lines.push('', '【代码仓库】（写代码的活必须挂仓库；这是独立于项目的另一本账）');
    for (const repo of repos) lines.push(`- ${describeRepo(repo)}`);
  } else {
    lines.push('', '【代码仓库】还没登记任何仓库：这轮不要派「改代码并入库」的活。');
  }
  lines.push(
    '',
    '【项目归属怎么定】三选一，别含糊：',
    '1）属于某个已有项目 → 在卡片里写 "project":"<项目id>"（必须是上面列出的、且有规范的）；',
    '2）值得单开新项目 → 写 "projectSuggestion"（你只能建议，董事会点「通过」才会真建，你不要自己建）；',
    '   申请单由你填完整：id、中文名、落盘目录（拿不准就 null）、为什么建、acceptance（验收条件）、rules（固定规矩）。',
    '   董事会只做「通过 / 拒绝 + 写意见」，不会替你补数据——所以规范要你拟好，写得越能判死越好。',
    '3）一次性任务 → 什么都不写。',
    '',
    '【重要：项目没批之前不会开跑】',
    '如果这活归某个**还不存在**的项目，就照实在卡片里写 "project":"它的id"（哪怕它还没建），同时给 projectSuggestion。',
    '引擎会把这单**挂起等董事会**，子卡一张都不建；批了自动唤醒你重拆，拒了按一次性任务跑（产物只留公司）。',
    '真的一次性活（干完就散、以后不会再做）**就该留空**：产物留在公司工作目录，不进任何项目，这是正常的；',
    '但**本来属于某个项目的活**别偷懒留空——那会让产物、经验、交付全落不到项目里，等于白干。',
    '只是「以后可以单开一个项目」的建议，可以只写 projectSuggestion 不写 project，不会阻塞当前这单。',
    '',
    '【什么活要排班（循环任务）】',
    '你自己判断：这活**不是干一次就完**，而是「每周/每月都得再来一遍」的，就该排班。典型：定期体检、定期巡检、定期清理、定期出简报。',
    '排班不是你的权限，是董事会的决定：你写 "recurringSuggestion"，董事会看「多久一次 / 干什么 / 谁干 / 谁审 / 烧多少」后决定通不通过。',
    '- 一次最多提 3 条，别把每件小事都排班；一次能干完的活不要提排班。',
    '- rrule 用标准写法，例：每周一 20:00 → "FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=0"；每天 09:30 → "FREQ=DAILY;BYHOUR=9;BYMINUTE=30"；每月 1 号 10:00 → "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0"。',
    '- instructions 要写成「每一轮照着做就能做完」的自足说明（不要写「同上」「按上次」）；acceptance 每轮都要能判死。',
    '- 已有项目里的长期工作，一定要写 project，否则那一轮产物不归这个项目。',
    '- **每一轮由谁审，你必须写明 reviewBy**：日常巡检 / 体检 / 清理 / 例行简报 → "engineering"（工程岗），'
      + '这类活审的是「有没有照做、数字对不对」，不是方向，不要每轮都来惊动你自己；'
      + '只有会动方向 / 对外承诺 / 技术路线的长期任务，才写 "ceo"（你自己审）或 "human"（请董事会），'
      + '并在 reviewNote 里说清「为什么这个必须我看」。不写就默认工程岗；写成执行人自己会被拒单。',
    '',
    '【先判断：这条到底要不要派卡】',
    '不是每条消息都是活。下面这些**直接回话，不要派卡**：',
    '- 寒暄 / 确认 / 感谢（「你好」「收到」「辛苦了」）；',
    '- 单纯咨询：问你现状、问你意见、问「这事能不能这么办」；',
    '- 让你根据现有项目信息出主意：有什么可做的、下一步该盯什么；',
    '- 你手上的信息（项目清单、近期记忆、审计）已经够答，不需要员工动手。',
    '这类**不派卡**：type 照写 task-create，把 "tasks" 写成空数组 []，想说的话写进 summary（也可以另写 answer）。',
    '为一句「你好」派一张卡，等于让员工干一件没必要干的活，还占住席位。',
    '反过来：只要这活**需要产出东西**（文件、译稿、脚本、报告、跑命令），就必须派卡，别用空 tasks 假装干完了。',
    '这类回话不建卡、不进项目、不再唤醒你；答复会原样送到董事会面前。',
    '',
    '【怎么拆：你只定「做什么、做到什么算完」】',
    '- 你是总经理，不是工程组长：把任务是什么、归哪个项目、要什么结果说清，然后把活交给能独立交付的那一级。',
    '- 默认交给工程岗一张「做成什么样」的卡，由它自己决定怎么拆实现、改哪些文件、跑什么命令 —— 那是它的判断，不是你的。',
    '- 不要写实现步骤、不要指定技术选型、不要写代码；除非董事会明确要你先出方案。',
    '- 一张卡能干完就别拆两张；只有跨工种（一边写代码、一边写文档/翻译）或确有先后依赖才拆，并在后一张写 after。',
    '- 把一件活切成五步流水账，等于提前替员工做完了判断，还把它绑死在你的方案上 —— 这是最常见的越界。',
    '- 每张卡写清三样：title（一句话）、instructions（要什么结果、产物放哪、什么不要碰）、acceptance（怎么算过，要能判死）。',
    '- difficulty 取 easy / normal / hard，按员工接得住的程度标。',
    '',
    '【输出】只输出一个 JSON 对象，不要解释、不要多余文字：',
    '{"type":"task-create","tasks":[],"summary":"给董事会的回话，可以多句"}   ← 只回话、不派卡时用这个',
    '{"type":"task-create","summary":"给董事会的一句话说明（含项目归属判断）",'
      + '"projectSuggestion":{"id":"kebab-case-id","displayName":"中文名","rootDir":null,"deliverSubdir":null,'
      + '"reason":"为什么值得单开","acceptance":["产物在哪个目录、怎么算过"],"rules":["必须遵守的规矩"]},'
      + '"recurringSuggestion":{"title":"这条循环任务叫什么","project":"项目id","rrule":"FREQ=WEEKLY;BYDAY=MO;BYHOUR=20;BYMINUTE=0",'
      + '"timezone":"Asia/Shanghai","assignee":"岗位id","kind":"maintenance","instructions":"每一轮照着做的完整说明",'
      + '"acceptance":["怎么算这一轮干完"],"reviewBy":"engineering","reviewNote":"日常巡检，工程岗看图看数就行",'
      + '"reason":"为什么值得长期排班"},'
      + '"tasks":[{"title":"...","assignee":"岗位id","difficulty":"normal","project":"项目id",'
      + '"repo":"仓库id（代码类活才写）","reviewBy":"engineering（代码类活写工程岗）",'
      + '"instructions":"...","acceptance":["..."],"after":[1]}]}',
    '- summary / projectSuggestion / recurringSuggestion / 卡片里的 project 都可省略；',
    '- 需要派活时 tasks 至少一张；**只排班不派卡**时把 "tasks" 写成空数组 []（别硬凑一张干活的卡）。',
    '- **只回话**时：tasks 写 []，summary 写你的回话。写了 task-create 却没给任何一张带标题/指令的卡，也按回话处理（不会派活）。',
    '- **卡是串着做的就写 after**：after 填同批卡的序号（从 1 数，如 "after":[1] 表示等第 1 张做完）'
      + '或那张卡的标题。不写 = 几张卡同时开跑。'
      + '凡是「后一张必须用上前一张的成果」（先接管再定计划、先写脚本再发布）就一定要写 after，'
      + '否则它们会并行，后一张会在前一张还没做完时就开始干。',
    '- 多条排班用 "recurringSuggestions":[{…},{…}]（复数，数组），单条用 "recurringSuggestion"。',
    '- kind 取 maintenance（维护）/ inspection（巡检）/ cleanup（清理）/ brief（简报）。',
  );
  return lines.join('\n');
}

/** 从一段文本里抠出第一个能解析成对象、且满足谓词的 JSON（先认 fenced 代码块，再认裸文本）。 */
function extractJsonObject(text, predicate = () => true) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const candidates = [];
  const fenced = raw.match(/```[a-zA-Z]*\s*([\s\S]*?)```/g) ?? [];
  for (const block of fenced) {
    candidates.push(block.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, ''));
  }
  candidates.push(raw);

  const tryParse = (value) => {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && predicate(parsed) ? parsed : null;
    } catch { return null; }
  };
  /** 扫出所有平衡的 {...}，取最后一个满足谓词的（模型常把正式结论放在最后）。 */
  const balanced = (value) => {
    const hits = [];
    for (let start = value.indexOf('{'); start !== -1; start = value.indexOf('{', start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < value.length; i += 1) {
        const ch = value[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            const parsed = tryParse(value.slice(start, i + 1));
            if (parsed) hits.push(parsed);
            break;
          }
        }
      }
    }
    return hits.length ? hits.at(-1) : null;
  };

  for (const candidate of candidates) {
    const direct = tryParse(candidate.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim());
    if (direct) return direct;
    const found = balanced(candidate);
    if (found) return found;
  }
  return null;
}

/** 把完成报告写到任务根目录（看门狗与验收都按这个位置找证据）。失败不影响本单成败。 */
function writeCompletionFile(workRoot, taskId, report) {
  if (!workRoot || !taskId) return null;
  try {
    const dir = path.join(workRoot, 'tasks', taskId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'completion.json');
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

export function createWebhookExecAdapter(overrides = {}) {
  const cfg = overrides.config ?? {};
  const baseUrl = cfg.baseUrl ?? process.env.AICEO_BASE_URL ?? DEFAULT_BASE;
  const token = cfg.token ?? process.env.AICEO_TOKEN ?? '';
  const timeoutMs = Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = Number(cfg.pollMs ?? DEFAULT_POLL_MS);
  const requestFn = overrides.request ?? postJson;
  const sleepFn = overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clockFn = overrides.now ?? nowIso;

  const call = (endpoint, payload, timeout, base = baseUrl, tk = token) =>
    requestFn(base, endpoint, payload, { token: tk, timeoutMs: timeout });

  /** 投一棒并等这一轮结束：返回 { text, sessionId, turn }；出错抛异常（由调用方决定怎么收场）。 */
  async function runTurn({ taskId, prompt, cwd, sessionId = null, config = {}, label = '' }) {
    const base = config.baseUrl ?? baseUrl;
    const tk = config.token ?? token;
    const budget = Number(config.timeoutMs ?? timeoutMs);
    const interval = Number(config.pollMs ?? pollMs);
    let submitted = null;
    try {
      submitted = unwrap(await call('/aiceo/api/task', {
        taskId, prompt, ...(cwd ? { cwd } : {}),
        // 带上固定会话 = 命中前缀缓存（按量计费席位省的是真金白银）。
        // 不带则服务端按 taskId 新建一个，每轮都要重新付一遍系统提示词的钱。
        ...(sessionId ? { sessionId } : {}),
      }, Math.min(budget, 30000), base, tk), `${label}投递`);
    } catch (error) {
      throw new Error(`${label}投递失败：${error.message}`);
    }
    const deadline = Date.now() + budget;
    let last = null;
    while (Date.now() < deadline) {
      let reply;
      try {
        reply = await call('/aiceo/api/result', { taskId }, Math.min(budget, 30000), base, tk);
      } catch (error) {
        throw new Error(`${label}查询结果失败：${error.message}`);
      }
      const value = unwrap(reply, `${label}结果`);
      last = value;
      if (value.status === 'done') {
        return {
          text: String(value.text ?? '').trim(),
          sessionId: value.sessionId ?? submitted?.sessionId ?? null,
          turn: value.turn,
        };
      }
      if (value.status === 'error') {
        throw new Error(`${label}agent 执行出错：${value.error ?? '(无错误信息)'}`);
      }
      await sleepFn(interval);
    }
    throw new Error(`${label}等待 agent 结果超时（${budget}ms）${last ? `，最后状态 ${last.status}` : ''}`);
  }

  /** 执行席位：干活 → 把文本包装成完成报告 → 报告落盘（看门狗/验收都按这个位置找证据）。 */
  async function executeWorker(ctx, config) {
    const taskId = ctx.task?.taskId ?? ctx.taskId;
    if (!taskId) return completion(ctx, 'failed', '缺 taskId，无法递给 webhook');
    const workRoot = ctx.adapterConfig?.workRoot ?? ctx.workRoot ?? null;
    // 派活前就把任务目录（含 output/）建好：agent 一开工就有地方写，
    // 不用它自己猜路径、也不用靠它自觉 mkdir。建不出来不影响干活（只是少个空目录）。
    if (workRoot) {
      try { fs.mkdirSync(path.join(workRoot, 'tasks', taskId, 'output'), { recursive: true }); } catch { /* 没权限就交给 agent 自己建 */ }
    }
    let done;
    try {
      done = await runTurn({
        taskId, prompt: buildPrompt(ctx), cwd: config.cwd ?? workRoot ?? null, config,
      });
    } catch (error) {
      return completion(ctx, 'failed', error.message);
    }
    if (!done.text) return completion(ctx, 'failed', 'agent 已结束但没有返回任何内容');
    const out = completion(ctx, 'success', done.text, {
      usage: { turn: done.turn },
      session: { sessionId: done.sessionId, turn: done.turn },
    });
    writeCompletionFile(workRoot, taskId, out.result);
    return out;
  }

  /** CEO 模式：只拆解 / 派活 / 验收，产出 CEO 输出契约（task-create / review …），不产出完成报告。 */
  async function executeCeo(ctx) {
    const taskId = ctx.task?.taskId ?? ctx.taskId;
    if (!taskId) throw new Error('缺 taskId，无法递给 webhook');
    const isReview = ctx.wakeReason === 'review_requested';
    // 同一张卡的「拆解」和「验收」必须是两轮，所以任务键带轮次后缀：
    // 插件对同名任务只做一次投递，重复用同一个键会拿回上一轮的旧结果。
    // 但**会话是共用的**：任务键只用于取结果，sessionId 决定上下文与缓存。
    const key = `${taskId}-${isReview ? 'review' : 'plan'}`;
    const workRoot = ctx.workRoot ?? ctx.adapterConfig?.workRoot ?? null;
    const agentId = ctx.agent?.id ?? 'ceo';
    const policy = { ...DEFAULT_SESSION_POLICY, ...(ctx.interaction?.ceoSession ?? {}) };
    const session = workRoot
      ? ensureCeoSession(workRoot, agentId, policy)
      : { sessionId: null };
    // 一个会话同时只能跑一轮（否则服务端按 sessionId 收集文本会串台），这里排队。
    const done = session.sessionId
      ? await withSessionLock(session.sessionId, () => runTurn({
        taskId: key,
        prompt: buildCeoPrompt(ctx),
        cwd: workRoot,
        sessionId: session.sessionId,
        config: { ...cfg, ...(ctx.adapterConfig ?? {}) },
        label: 'CEO ',
      }))
      : await runTurn({
        taskId: key,
        prompt: buildCeoPrompt(ctx),
        cwd: workRoot,
        config: { ...cfg, ...(ctx.adapterConfig ?? {}) },
        label: 'CEO ',
      });
    const after = workRoot ? recordSessionTurn(workRoot, agentId, { taskId }) : null;
    const parsed = extractJsonObject(done.text, (value) => CEO_OUTPUT_KINDS.includes(value.type));
    if (!parsed) {
      throw new Error(`CEO 没有给出可解析的 JSON（要 {"type":"task-create"|"review",…}）：${done.text.slice(0, 300)}`);
    }
    return {
      status: 'success',
      usage: { quotaUnits: 1, turn: done.turn },
      sessionParams: {
        transport: 'webhook-exec', mode: 'ceo',
        sessionId: done.sessionId ?? session.sessionId ?? null,
        turn: done.turn,
        sessionTurns: after?.turns ?? null,
      },
      result: parsed,
    };
  }

  return {
    type: 'webhook-exec',

    // 环境检查：webhook 端点在线才派活；离线时 requeueIfIdle 退回 todo，等维护心跳重试。
    async testEnvironment(config = {}) {
      const b = config.baseUrl ?? baseUrl;
      const t = config.token ?? token;
      try {
        const reply = await (overrides.request ?? postJson)(b, '/aiceo/api/health', {}, { token: t, timeoutMs: 5000 });
        const value = unwrap(reply, 'health');
        if (!value?.agents || !value?.presets) {
          return { ok: false, detail: 'webhook 服务在线但 agents/presets 未就绪' };
        }
        return { ok: true, detail: `${b} agents+presets ready` };
      } catch (error) {
        return { ok: false, detail: `webhook 服务不可达：${error.message}` };
      }
    },
    strictEnvironment: true,

    async execute(ctx) {
      // 同一个 adapter 两种角色：ceo 只拆解/验收，其它一切是执行。
      const config = { ...cfg, ...(ctx.adapterConfig ?? {}) };
      return config.mode === 'ceo' ? executeCeo(ctx) : executeWorker(ctx, config);
    },
  };
}

export const webhookExecAdapter = createWebhookExecAdapter();
export default webhookExecAdapter;
