// 组织图与席位身份：让每个席位在开工前就知道「我是谁、谁是我上级、我能派给谁、什么必须上报」。
//
// 为什么必须写进提示词：三个员工的公司，最大的浪费不是干错活，而是「干错了没人知道」
// 和「该上报的自己扛」。席位只看到一张卡时，会默认自己是全公司唯一的人 ——
// 于是豆包闷头返工、工程自己写完全部代码、CEO 既拆活又干活。
// 这里把组织结构、汇报线、交付路由一次性讲清，且全部来自配置，代码里不写死人名。

import { allRepos, describeRepo } from './repos.js';

/** 组织树：从没有上级的节点往下画。 */
export function orgTreeLines(config = {}) {
  const agents = config.agents ?? [];
  const byManager = new Map();
  for (const agent of agents) {
    const key = agent.reportsTo ?? '__root__';
    if (!byManager.has(key)) byManager.set(key, []);
    byManager.get(key).push(agent);
  }
  const lines = [];
  const label = (agent) => {
    const holder = agent.holderName ? `｜担任：${agent.holderName}` : '';
    const duty = agent.duties ? ` — ${agent.duties}` : '';
    return `${agent.postTitle ?? agent.id}（${agent.id}${holder}）${duty}`;
  };
  const walk = (managerId, prefix, depth) => {
    const children = byManager.get(managerId) ?? [];
    children.forEach((agent, index) => {
      const last = index === children.length - 1;
      lines.push(`${prefix}${last ? '└─ ' : '├─ '}${label(agent)}`);
      if (depth < 4) walk(agent.id, `${prefix}${last ? '   ' : '│  '}`, depth + 1);
    });
  };
  lines.push('董事会（人｜最终拍板，所有对外承诺由他点头）');
  walk('__root__', '', 0);
  return lines;
}

/** 把某个席位的身份、上下级、边界写成一段可直接塞进提示词的说明。 */
export function seatBriefing(config = {}, agentId, { repos = null, artifacts = null } = {}) {
  const agents = config.agents ?? [];
  const me = agents.find((a) => a.id === agentId);
  if (!me) return '';
  const nameOf = (id) => {
    const a = agents.find((x) => x.id === id);
    return a ? `${a.postTitle ?? a.id}（${a.id}）` : String(id);
  };
  const boss = me.reportsTo ? agents.find((a) => a.id === me.reportsTo) : null;
  const reports = agents.filter((a) => a.reportsTo === me.id);
  const siblings = agents.filter((a) => a.reportsTo && a.reportsTo === me.reportsTo && a.id !== me.id);
  const repoList = repos ? Object.values(repos) : allRepos(config);
  const codeExt = (artifacts?.codeExtensions ?? []).join(' ');

  const lines = [];
  lines.push('【你是谁】');
  lines.push(`${nameOf(me.id)}${me.holderName ? `，担任者「${me.holderName}」` : ''}。`);
  if (me.duties) lines.push(`职责：${me.duties}`);
  if (Array.isArray(me.boundaries) && me.boundaries.length) {
    lines.push('边界：');
    for (const b of me.boundaries) lines.push(`- ${b}`);
  }

  lines.push('', '【公司组织（你在这张图里）】');
  for (const row of orgTreeLines(config)) lines.push(row);
  const ups = [];
  if (boss) ups.push(`上级：${nameOf(boss.id)}${boss.isCEO ? '（总经理）' : ''}`);
  if (reports.length) ups.push(`下级：${reports.map((r) => nameOf(r.id)).join('、')}`);
  if (siblings.length) ups.push(`同级：${siblings.map((r) => nameOf(r.id)).join('、')}（可协作，不可越级指挥）`);
  lines.push(ups.map((x) => `· ${x}`).join('\n'));

  lines.push('', '【什么必须上报，什么自己能定】');
  lines.push('- 自己能定：怎么做、先做哪步、用什么工具、文件怎么组织 —— 这些不用问。');
  lines.push('- 必须上报：方向变了（做的已经不是原来那件事）、需求自相矛盾、要动职责范围之外的东西、'
    + '要做不可逆操作（删数据、改生产配置、force push）、同一个问题连续两次没解决。');
  lines.push('- 上报不是失败，是止损：闷头干到底再交一个错的结果，比中途说一句「这条路走不通」贵得多。');

  lines.push('', '【交付怎么走：三选一，干完自己判】');
  lines.push('1）直接落盘（handoff=land）：产物本身就是结果，没人需要再动手。文档、译稿、数据、'
    + '一次性计算脚本（视频渲染、数据清洗这种跑完就归档的）都走这条。');
  lines.push('2）交人审（handoff=review）：改动会被以后的人接着用，需要有人看一眼再收。'
    + '受管代码（要长期维护的源码）必须走这条；别人仓库里的东西、配置、脚本也走这条。');
  lines.push('3）上报（handoff=escalate）：你判断这活不该按现在的路子做下去了。'
    + '把「卡在哪、你建议怎么改」写清楚，交回上级决定，不要自己改方向。');

  lines.push('', '【产物怎么分类（artifactKind）】');
  lines.push('- managed-code：要长期维护的代码（源码、配置、脚本工具）。必须写 repo，并且必须走 review。');
  lines.push('- scratch-code：一次性计算脚本（渲染视频、清洗数据），跑完归档当资料，不进 git、不需要维护。');
  lines.push('- document：文档、报告、译稿；data：表格、数据集；media：图片、音频、视频。');
  if (codeExt) lines.push(`- 判不准时看扩展名：${codeExt} 这些通常算代码；算不算「受管」看它以后还要不要改。`);

  if (repoList.length) {
    lines.push('', '【已登记的代码仓库】');
    for (const repo of repoList) lines.push(`- ${describeRepo(repo)}`);
    lines.push('只能动这里列出来的仓库；不在名单里的目录，不要提交、不要推送。');
  } else {
    lines.push('', '【代码仓库】公司还没登记任何仓库：这轮不要做 git 提交或推送。');
  }
  return lines.join('\n');
}

/** CEO 专用：多一段「什么活派给谁」的判断表。 */
export function ceoRoutingBriefing(config = {}) {
  const agents = (config.agents ?? []).filter((a) => a.isCEO !== true && a.status !== 'disabled');
  const lines = [];
  lines.push('【派活路由：先想清楚这活该谁干】');
  lines.push('你的员工不是同一种手：');
  for (const a of agents) {
    const kind = a.adapter?.type === 'gui-template'
      ? '桌面应用，抢键鼠、一次一件、慢，适合写文档 / 翻译 / 点界面'
      : a.adapter?.type === 'seat'
        ? '会话里的工程 agent，人叫才醒，能读盘改文件跑命令，适合写代码和查问题'
        : a.adapter?.type === 'webhook-exec'
          ? '常驻 agent，能读盘跑命令，按量计费'
          : '本地脚本';
    lines.push(`- ${a.id}（${a.postTitle ?? a.id}）｜${kind}${a.duties ? `｜${a.duties}` : ''}`);
  }
  lines.push('');
  lines.push('判断顺序：');
  lines.push('1）需要产出文件、译稿、文档、界面操作 → 派给手最顺的那个执行岗；');
  lines.push('2）需要写代码 / 改配置 / 跑命令 / 查系统状态 / 做技术方案 → 派给工程岗。'
    + '工程岗会自己判断哪些自己干、哪些再拆给执行岗 —— 你不用替它拆到最细；');
  lines.push('3）只是问你意见、要你根据现有信息出主意、寒暄确认 → 不派卡，自己回话（tasks 写 []）；');
  lines.push('4）需要董事会拍板（花钱、对外承诺、定方向）→ 不派卡，写成给你的回话，让董事会决定。');
  lines.push('');
  lines.push('拆卡粒度：一张卡一个交付物。跨工种才拆两张，并在后一张写 after 指向前一张。');
  lines.push('代码类活：在卡上写 repo（仓库 id），并把 reviewBy 写成工程岗 —— 代码由工程岗审完再收账。');
  return lines.join('\n');
}

/** 从一张卡推断它是不是代码活（没有显式 artifactKind 时的兜底）。 */
export function looksLikeCode(task = {}, artifacts = {}) {
  const exts = artifacts.codeExtensions ?? [];
  const haystack = [
    task.title, task.instructions,
    ...(Array.isArray(task.acceptance) ? task.acceptance : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (exts.some((ext) => haystack.includes(ext))) return true;
  return /代码|脚本|程序|函数|接口|重构|修 ?bug|commit|git|仓库/.test(haystack);
}
