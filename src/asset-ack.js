// 资产归口（2026-11-18 董事会拍板）。
//
// 问题：CEO 直派一张「改代码」的卡给执行岗，CEO 验收完就关单，工程岗全程不知道，
// 仓库没提交、没推送。根因不是分工错，是流程里只有「交付验收」一个关单条件，
// 没有「资产落地」这一步。
//
// 规则：
//   · 指挥线：谁派单谁验收，交付验收只看结果对不对；
//   · 归口线：谁拥有资产谁确认落地状态（提交 / 推送 / 或明确无需入库）；
//   · 两个条件都齐，卡才能 done。
//
// 触发条件按「动不动资产」判，不按「是不是技术活」判：
//   kind = managed-code 且卡上登记了 repo，且执行人不是这个仓库的归口人 → 需要归口回执。
// 一次性脚本（scratch-code）不触发，避免「写个小脚本也要层层转包」。

/**
 * 这张卡对应的资产归口人。
 * 仓库台账里 reviewer 就是归口人（谁审这份代码、谁负责提交推送）。
 * @returns {{ owner: string, repo: object }|null}
 */
export function assetOwnerOf({ task, config = {}, repos = undefined } = {}) {
  const repoId = task?.repo;
  if (!repoId) return null;
  const table = repos ?? config.repos ?? {};
  const repo = table[repoId];
  if (!repo) return null;
  const owner = repo.reviewer || config.artifacts?.defaultReviewer || null;
  if (!owner) return null;
  return { owner, repo };
}

/**
 * 是否需要工程岗的「归口回执」。
 * 返回 null = 不需要；返回 { owner, repo } = 需要，且归口人是谁。
 */
export function needsAssetAck({ task, kind, config = {}, repos = undefined } = {}) {
  if (config.artifacts?.requireAssetAck === false) return null;
  if (String(kind ?? '') !== 'managed-code') return null;
  const hit = assetOwnerOf({ task, config, repos });
  if (!hit) return null;
  if (!task?.assignee) return null;
  // 归口人自己干的活不需要再给自己回执（他就是资产主人）。
  if (task.assignee === hit.owner) return null;
  if (String(task.assetAck ?? '') === 'done') return null;
  return hit;
}

/** 归口核对卡的说明：只核对落地，不重做实现。 */
export function assetAckInstructions({ task = {}, owner = '', repo = {}, artifacts = [] } = {}) {
  const repoBits = [
    `仓库：${repo.displayName ?? repo.id ?? '(未命名)'}（id=${repo.id ?? task.repo ?? '-'}）`,
    repo.path ? `本机目录：${repo.path}` : null,
    repo.remote ? `远端：${repo.remote}（分支 ${repo.branch ?? 'main'}）` : '远端：未登记（只做本地留档）',
    `推送策略：${repo.allowPush ? '允许按仓库政策推送' : '本仓库配置为不允许自动推送；提交前先报董事会'}`,
  ].filter(Boolean);
  const artifactLines = (Array.isArray(artifacts) ? artifacts : []).slice(0, 12)
    .map((a) => `- ${a}`);
  return [
    `这是一张「资产归口核对」卡，不是重做交付。父卡 ${task.taskId ?? '-'}（${task.title ?? '-'}）的交付已经由派单人验收通过；`,
    '你只负责确认改动有没有真的落进仓库并推送。不要重新实现、不要改动业务代码（除非只是解决提交冲突）。',
    '',
    ...repoBits,
    '',
    '执行人在父卡上报的产物：',
    ...(artifactLines.length ? artifactLines : ['- （父卡未列产物，以父卡目录 output/ 和 completion.json 为准）']),
    '',
    '请按这个顺序做：',
    '1）读父卡的 completion.json 与产物，确认这次改了哪些文件；',
    '2）在仓库里只读检查：git status / git diff，核对改动是否就是父卡说的那些；',
    '3）改动正确 → 提交并推送（遵守本仓库策略与提交规范）；',
    '4）确认无需入库（产物不在仓库里 / 上一单已经提交过）→ 在报告里写「无需变更」并给出依据；',
    '5）改动不对或夹带了无关修改 → 不要自己重构，写 status=failed + reason，父卡会打回执行岗重做。',
    '',
    '完成报告 summary 必须能看出落地结果：',
    '- 已提交推送：写 commit 短哈希 + 远端 + 分支；',
    '- 无需变更：写「无需变更：<依据>」；',
    '- 失败：写清卡在哪一步。',
  ].join('\n');
}
