// 董事会消息箱：所有 agent（总经理 / 各席位）向董事会说的话，都落这一张表。
//
// 为什么要单独一层：原来的「简报」是**统计**（今天完成几张、跑了几次），
// 董事会看不懂也不想看；而真正该让人看到的是**谁干了什么、结果如何、要不要人动手**。
// 所以这里只收「人话消息」，一条讲清一件事，其余细节留在审批单 / 报告文件里按需点开。
//
// 三条纪律：
//   1. 一条消息只讲一件事，正文不超过几行，先给结论；
//   2. 不摆内部文件名（completion.json / report.draft.json 这类是机器的，不是给人的）；
//   3. 消息必须持久化：重启、关机后回来还能看，不能只存内存。

import { randomUUID } from 'node:crypto';

export const MESSAGE_KINDS = ['done', 'blocked', 'decision', 'answer', 'notice'];

const shortId = () => randomUUID().slice(0, 8);
// 任务标题常常是一整句话；消息里只留能认出是哪一单的那一截。
const clip = (text, n = 42) => {
  const s = String(text ?? '').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const nowIso = () => new Date().toISOString();

// 内部产物：机器读的，不列给董事会。
const INTERNAL_ARTIFACT = /(^|\/)(completion\.json|report\.draft\.json|progress\.json|cycle\.json)$/i;

/** 把一段可能很技术的话压成一句人话：去 markdown / JSON / 路径噪音，取第一段。 */
export function plainText(text, limit = 200) {
  let s = String(text ?? '').trim();
  if (!s) return '';
  // 整段是 JSON 的，说明写的人没打算给人看——直接不给。
  if (/^\s*[[{]/.test(s)) {
    try {
      const parsed = JSON.parse(s);
      s = String(parsed.summary ?? parsed.answer ?? parsed.note ?? '').trim();
    } catch { s = ''; }
    if (!s) return '';
  }
  s = s
    .replace(/```[\s\S]*?```/g, ' ')        // 代码块
    .replace(/^#{1,6}\s*/gm, '')            // markdown 标题符号
    .replace(/\*\*|__|`/g, '')              // 粗体 / 行内代码记号
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ');
  // 只取开头：后面的往往是「附录 / 明细」，看板里不需要。
  // 但第一段常常只是个标题（「报告」两个字），那样等于什么都没说——补上第二段。
  const blocks = s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  let head = blocks[0] ?? '';
  if (head.length < 12 && blocks[1]) head = `${head} ${blocks[1]}`;
  s = head.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' ');
  if (s.length > limit) s = `${s.slice(0, limit)}…`;
  return s;
}

/** 席位怎么称呼：优先岗位名，其次担任者名，最后 id。 */
export function speakerOf(config, agentId) {
  const agent = (config?.agents ?? []).find((a) => a.id === agentId);
  if (!agent) return { id: agentId ?? 'system', name: agentId === 'human' ? '董事会' : (agentId ?? '系统'), post: null };
  const post = agent.postTitle ?? null;
  const name = agent.holderName ?? agent.displayName ?? agent.id;
  return { id: agent.id, name, post };
}

/** 人名 +（岗位），例：豆包（执行）。没有岗位名就只给人名。 */
export function speakerLabel(config, agentId) {
  const { name, post } = speakerOf(config, agentId);
  return post && post !== name ? `${name}（${post}）` : name;
}

function visibleArtifacts(report) {
  return (Array.isArray(report?.artifacts) ? report.artifacts : [])
    .map((x) => String(x))
    .filter((x) => x && !INTERNAL_ARTIFACT.test(x));
}

function shortName(filePath) {
  return String(filePath).split(/[\\/]/).filter(Boolean).pop() ?? String(filePath);
}

/**
 * 「活干完了」这条消息。
 * 顺序严格按董事会关心的顺序：谁 → 干了什么 → 结果 → 东西在哪 → 我要不要动手。
 */
export function composeDoneMessage({
  config, task, report, deliver = null, reviewedBy = null, approvedByBoard = false, actor = null,
}) {
  const who = speakerLabel(config, actor ?? task?.assignee);
  const title = clip(task?.title ?? '(无标题任务)');
  const said = plainText(report?.boardNote || report?.summary, 220);
  const lines = [];

  if (approvedByBoard) {
    lines.push(`你点通过了：${title}`);
  } else if (reviewedBy) {
    lines.push(`${speakerLabel(config, reviewedBy)} 看过了，没问题：${title}`);
  } else {
    lines.push(`${who} 干完了：${title}`);
  }

  if (said) lines.push(`它说：${said}`);
  else lines.push('它说：做完了（没留说明）。');

  const files = visibleArtifacts(report);
  if (files.length) {
    const shown = files.slice(0, 3).map(shortName).join('、');
    const more = files.length > 3 ? ` 等 ${files.length} 个` : '';
    lines.push(`东西是这些：${shown}${more}。`);
  }
  if (deliver?.ok) {
    const project = config?.projects?.[task?.project]?.displayName ?? task?.project;
    const target = String(deliver.targetDir ?? '').split(/[\\/]/).filter(Boolean).slice(-1)[0];
    lines.push(`已经放进「${project}」${target ? ` 的 ${target} 文件夹` : '的项目文件夹'}。`);
  } else if (deliver?.deferred) {
    lines.push('文件还没放过去：那个文件夹正被别的程序占着，等我下次自动重试。');
  } else if (!task?.project) {
    lines.push('这次没归到任何项目，东西留在任务目录里。');
  }

  lines.push('你不用管，这件事已经办完。');
  return { title: `完成：${title}`, body: lines.join('\n') };
}

/** 「卡住了 / 要你定」这条消息。 */
export function composeBlockedMessage({ config, task, reason, actor = null, kind = 'blocked' }) {
  const who = speakerLabel(config, actor ?? task?.assignee);
  const title = clip(task?.title ?? '(无标题任务)');
  const why = plainText(reason ?? task?.holdReason, 240) || '没说原因';
  const lines = [
    kind === 'decision' ? `${who} 有件事需要你定：${title}` : `${who} 卡住了，需要你定：${title}`,
    `原因：${why}`,
    '它已经停下来等你，不会再自己乱试。',
  ];
  return { title: kind === 'decision' ? `等你定：${title}` : `卡住了：${title}`, body: lines.join('\n') };
}

/** 「总经理只回话、不派活」这条消息（沿用原来的 answer 通道，但落库）。 */
export function composeAnswerMessage({ config, task, answer }) {
  const title = String(task?.title ?? '(问了一句)').trim();
  const text = plainText(answer, 1200);
  return { title: `总经理回复：${title}`, body: text || '（空回复）' };
}

/** 写一条消息。body 为空就不写（宁缺毋滥，不制造空消息）。 */
export function recordMessage(db, {
  from = 'system', kind = 'notice', taskId = null, project = null, title = '', body = '',
  docs = null, at = null,
} = {}) {
  if (!String(body).trim()) return null;
  const msgId = `MSG-${shortId()}`;
  db.prepare(`INSERT INTO board_messages
    (msgId, fromAgent, kind, taskId, project, title, body, docsJson, createdAt, readAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
    msgId, from, MESSAGE_KINDS.includes(kind) ? kind : 'notice', taskId, project,
    String(title).slice(0, 200), String(body).slice(0, 4000),
    docs ? JSON.stringify(docs) : null, at ?? nowIso(),
  );
  return { msgId, from, kind, taskId, project, title, body };
}

export function listMessages(db, { limit = 60, unreadOnly = false } = {}) {
  const rows = db.prepare(`SELECT * FROM board_messages
    ${unreadOnly ? 'WHERE readAt IS NULL' : ''}
    ORDER BY rowid DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit) || 60)));
  return rows.map((r) => ({
    msgId: r.msgId, from: r.fromAgent, kind: r.kind, taskId: r.taskId, project: r.project,
    title: r.title, body: r.body,
    docs: r.docsJson ? JSON.parse(r.docsJson) : [],
    createdAt: r.createdAt, readAt: r.readAt,
  }));
}

export function unreadMessageCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM board_messages WHERE readAt IS NULL').get().n;
}

/** 标记已读：传 ids 就标这些，传 all 就全标。 */
export function markMessagesRead(db, { ids = null, all = false } = {}) {
  const at = nowIso();
  if (all) {
    const info = db.prepare('UPDATE board_messages SET readAt = ? WHERE readAt IS NULL').run(at);
    return { marked: Number(info.changes ?? 0) };
  }
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean);
  let marked = 0;
  const stmt = db.prepare('UPDATE board_messages SET readAt = ? WHERE msgId = ? AND readAt IS NULL');
  for (const id of list) marked += Number(stmt.run(at, id).changes ?? 0);
  return { marked };
}
