// P1-1 / P1-2 + P2：SQLite 数据模型、transition() 状态机、事件表与去重、lease 与循环所需表。
// 用 Node 22 内置 node:sqlite（实验性），保持零依赖；P1 / P2 说明里已如实标注这处选型偏差。

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './ids.js';
import { periodKey } from './quota.js';
import { ceilingOf } from './difficulty.js';

export const DDL = `
CREATE TABLE IF NOT EXISTS agents (
  agentId TEXT PRIMARY KEY, displayName TEXT, isCEO INTEGER, reportsTo TEXT,
  capabilities TEXT, status TEXT, quotaDaily INTEGER, adapterType TEXT, escalationTo TEXT,
  maxDifficulty TEXT, postTitle TEXT, holderName TEXT, holderKind TEXT, holderId TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  taskId TEXT PRIMARY KEY, requestId TEXT, parentTaskId TEXT, title TEXT, role TEXT,
  assignee TEXT, status TEXT, mode TEXT, addressedTo TEXT, assignedBy TEXT,
  revision INTEGER DEFAULT 1, threadId TEXT, attempt INTEGER DEFAULT 0,
  priority TEXT, difficulty TEXT DEFAULT 'normal',
  createdAt TEXT, updatedAt TEXT, leaseToken TEXT, leaseExpiresAt TEXT,
  originJson TEXT
);
CREATE TABLE IF NOT EXISTS task_payload (
  taskId TEXT, revision INTEGER, instructions TEXT, acceptanceJson TEXT,
  completionReportPath TEXT, inputJson TEXT DEFAULT '{}', PRIMARY KEY (taskId, revision)
);
CREATE TABLE IF NOT EXISTS runs (
  runId TEXT PRIMARY KEY, taskId TEXT, agentId TEXT, wakeReason TEXT, status TEXT,
  revision INTEGER, quotaUnits INTEGER DEFAULT 1, startedAt TEXT, finishedAt TEXT
);
CREATE TABLE IF NOT EXISTS events (
  eventId TEXT PRIMARY KEY, type TEXT, source TEXT, taskId TEXT, agentId TEXT,
  payloadJson TEXT, dedupeKey TEXT UNIQUE, processed INTEGER DEFAULT 0, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  approvalId TEXT PRIMARY KEY, kind TEXT, taskId TEXT, status TEXT, decidedBy TEXT, decidedAt TEXT,
  requestJson TEXT, reason TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS quotas (
  agentId TEXT, period TEXT, used INTEGER, limitUnits INTEGER, warnAt INTEGER,
  warnNotifiedAt TEXT, stopNotifiedAt TEXT,
  PRIMARY KEY (agentId, period)
);
CREATE TABLE IF NOT EXISTS audit (
  auditId TEXT PRIMARY KEY, actor TEXT, action TEXT, oldValue TEXT, newValue TEXT,
  runId TEXT, taskId TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  threadId TEXT PRIMARY KEY, requestId TEXT, mode TEXT, title TEXT, participantsJson TEXT, wakePolicy TEXT,
  ceoVisibility TEXT, ttlDays INTEGER, state TEXT, createdAt TEXT, lastActiveAt TEXT, promotedTo TEXT,
  archivedAt TEXT
);
CREATE TABLE IF NOT EXISTS thread_messages (
  messageId TEXT PRIMARY KEY, threadId TEXT, author TEXT, runId TEXT, body TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS change_requests (
  changeRequestId TEXT PRIMARY KEY, taskId TEXT, runId TEXT, agentId TEXT,
  kind TEXT, severity TEXT, reason TEXT, dedupeKey TEXT UNIQUE, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  decisionId TEXT PRIMARY KEY, changeRequestId TEXT, taskId TEXT, decidedBy TEXT,
  decision TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS task_revisions (
  taskId TEXT, revision INTEGER, instructionsSnapshot TEXT, acceptanceSnapshot TEXT,
  approvedBy TEXT, createdAt TEXT, PRIMARY KEY (taskId, revision)
);
CREATE TABLE IF NOT EXISTS briefs (
  briefId TEXT PRIMARY KEY, body TEXT, createdAt TEXT
);
-- 董事会消息箱：agent 对人说的话（完成 / 卡住 / 等拍板 / 回话）。
-- 与 briefs 分开：briefs 是机器统计，这里是「人话」，界面主视图只显示这一张。
CREATE TABLE IF NOT EXISTS board_messages (
  msgId TEXT PRIMARY KEY, fromAgent TEXT, kind TEXT, taskId TEXT, project TEXT,
  title TEXT, body TEXT, docsJson TEXT, createdAt TEXT, readAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_board_messages_created ON board_messages(createdAt);
CREATE TABLE IF NOT EXISTS recurring_jobs (
  jobId TEXT PRIMARY KEY, jobVersion INTEGER, kind TEXT, status TEXT, rrule TEXT,
  timezone TEXT, taskTemplateJson TEXT, requiresHumanEachCycle INTEGER, lastCycleNo INTEGER,
  jobJson TEXT, nextFireAt TEXT, lastFiredAt TEXT, consecutiveFailures INTEGER DEFAULT 0,
  misfirePolicy TEXT DEFAULT 'run_once', overlapPolicy TEXT DEFAULT 'skip',
  dedupeWindowMin INTEGER DEFAULT 60, terminationJson TEXT
);
CREATE TABLE IF NOT EXISTS cycles (
  jobId TEXT, cycleNo INTEGER, jobVersion INTEGER, taskId TEXT, periodStart TEXT,
  periodEnd TEXT, status TEXT, summaryPath TEXT, PRIMARY KEY (jobId, cycleNo)
);
CREATE TABLE IF NOT EXISTS cycle_history (
  jobId TEXT, cycleNo INTEGER, metricsJson TEXT, deltaJson TEXT, findingsJson TEXT,
  carryOverJson TEXT, derivedTasksJson TEXT, humanDecision TEXT, runIds TEXT,
  PRIMARY KEY (jobId, cycleNo)
);
CREATE TABLE IF NOT EXISTS cycle_fires (
  jobId TEXT, scheduledKey TEXT, taskId TEXT, createdAt TEXT,
  PRIMARY KEY (jobId, scheduledKey)
);
CREATE TABLE IF NOT EXISTS bridges (
  agentId TEXT PRIMARY KEY, lastSeenAt TEXT, status TEXT, metaJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processed);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee, status);
`;

export function openDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);
  migrate(db);
  return db;
}

// 轻量迁移：旧库缺列就补一列，保证关机再开机、以及 P1 老库升 P2 都不丢数据（G-P1 / G-P2）。
export function migrate(db) {
  const addColumn = (table, column, ddl) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn('threads', 'requestId', 'requestId TEXT');
  // P4-7：协作空间归档留痕（promote / TTL 归档都要写时间，缺列会直接报 no such column）。
  addColumn('threads', 'archivedAt', 'archivedAt TEXT');
  addColumn('tasks', 'originJson', 'originJson TEXT');
  // G3：任务难度与席位难度上限。老库补列后旧任务一律按 normal 处理（不追溯改判）。
  addColumn('tasks', 'difficulty', "difficulty TEXT DEFAULT 'normal'");
  // P7：任务归属项目。老库补列后旧卡为 NULL（= 不属于任何项目，行为与以前一致）。
  addColumn('tasks', 'project', 'project TEXT');
  // 卡间依赖：存前置卡的 taskId 数组（JSON）。老库补列后为 NULL = 没有依赖，仍是并行。
  // CEO 拆卡时可以在卡上写 after（同批序号），引擎落成真正的依赖关系；派活前会拦。
  addColumn('tasks', 'dependsOn', 'dependsOn TEXT');
  // 仓库台账：代码在哪、往哪推。与 project 解耦，老库补列后为 NULL（= 这张卡不碰仓库）。
  addColumn('tasks', 'repo', 'repo TEXT');
  // 验收人：不写就是总经理。代码类活写工程岗，审完才收账。
  addColumn('tasks', 'reviewBy', 'reviewBy TEXT');
  // 发布者：谁下的这张卡（'human' = 董事会；其余为真 agent id）。
  // 「谁发布谁负责」：交付路由与验收人默认跟着它走，不再靠全局一刀切。
  // 老库补列后为空，回落到 assignedBy（human / policy / ceo / seat）判断。
  addColumn('tasks', 'assignerId', 'assignerId TEXT');
  // 发布者指定的交付路由（land / review / escalate）。空 = 按发布者推导。
  addColumn('tasks', 'handoff', 'handoff TEXT');
  // 是否授权执行者自己判「干完直接落盘」。默认 0：上级派的活，员工无权替上级免审。
  addColumn('tasks', 'allowSelfLand', 'allowSelfLand INTEGER DEFAULT 0');
  // 父卡等子卡：承接人把卡拆开交给下级后，先挂在这里（=1），子卡全部收尾再汇总交审。
  // 没有这一位，「拆了 8 张」会被当成成果提前送上级验收，而活其实一张都还没干完。
  addColumn('tasks', 'waitingChildren', 'waitingChildren INTEGER DEFAULT 0');
  // 挂起时暂存承接人交上来的原报告（summary/产物/验收结论）：重启后照样能拼总汇报。
  addColumn('tasks', 'parentReportJson', 'parentReportJson TEXT');
  addColumn('agents', 'maxDifficulty', 'maxDifficulty TEXT');
  // 席位模型：岗位（postTitle）与担任者（holderName）分开记，老库补列后为空，下次启动由 seedAgents 回填。
  addColumn('agents', 'postTitle', 'postTitle TEXT');
  addColumn('agents', 'holderName', 'holderName TEXT');
  addColumn('agents', 'holderKind', 'holderKind TEXT');
  // 担任者 id：同一个 agent 可以兼任多个岗位，靠这一列能看出「这几个位子是同一个人在干」。
  addColumn('agents', 'holderId', 'holderId TEXT');
  addColumn('task_payload', 'inputJson', "inputJson TEXT DEFAULT '{}'");
  // P4：审批单补请求内容与时间；审计补 taskId 以便按任务串时间线；配额补通知去重位。
  for (const [column, ddl] of [
    ['requestJson', 'requestJson TEXT'],
    ['reason', 'reason TEXT'],
    ['createdAt', 'createdAt TEXT'],
  ]) addColumn('approvals', column, ddl);
  addColumn('audit', 'taskId', 'taskId TEXT');
  addColumn('quotas', 'warnNotifiedAt', 'warnNotifiedAt TEXT');
  addColumn('quotas', 'stopNotifiedAt', 'stopNotifiedAt TEXT');
  addColumn('agents', 'escalationTo', 'escalationTo TEXT');
  for (const [column, ddl] of [
    ['jobJson', 'jobJson TEXT'],
    ['nextFireAt', 'nextFireAt TEXT'],
    ['lastFiredAt', 'lastFiredAt TEXT'],
    ['consecutiveFailures', 'consecutiveFailures INTEGER DEFAULT 0'],
    ['misfirePolicy', "misfirePolicy TEXT DEFAULT 'run_once'"],
    ['overlapPolicy', "overlapPolicy TEXT DEFAULT 'skip'"],
    ['dedupeWindowMin', 'dedupeWindowMin INTEGER DEFAULT 60'],
    ['terminationJson', 'terminationJson TEXT'],
  ]) addColumn('recurring_jobs', column, ddl);
}

export function seedAgents(db, config) {
  // 配额按「当前周期」开账；跨天 / 跨周期由 ensureQuota 自动开新账（P4-1）。
  const period = periodKey(new Date());
  const insertAgent = db.prepare(`INSERT OR REPLACE INTO agents
    (agentId, displayName, isCEO, reportsTo, capabilities, status, quotaDaily, adapterType,
     escalationTo, maxDifficulty, postTitle, holderName, holderKind, holderId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertQuota = db.prepare(`INSERT OR IGNORE INTO quotas
    (agentId, period, used, limitUnits, warnAt) VALUES (?, ?, 0, ?, ?)`);
  for (const agent of config.agents) {
    insertAgent.run(
      agent.id, agent.displayName ?? agent.id, agent.isCEO ? 1 : 0,
      agent.reportsTo ?? null, JSON.stringify(agent.capabilities),
      agent.status, agent.quotaDaily ?? 20, agent.adapter.type, agent.escalationTo ?? null,
      ceilingOf(agent),
      agent.postTitle ?? agent.displayName ?? agent.id, agent.holderName ?? null, agent.holderKind ?? null,
      agent.holderId ?? null,
    );
    const limit = agent.quotaDaily ?? 20;
    insertQuota.run(agent.id, period, limit, Math.floor(limit * (config.quota?.warnRatio ?? 0.8)));
  }
  // 名册就是配置的投影：配置里删掉的席位要从库里清掉，否则看板会一直挂着已经不存在的人
  //（例如从「研发工位」改回「执行岗由桌面应用担任」之后）。任务表里 assignee 是字符串，不受影响。
  const keep = config.agents.map((a) => a.id);
  if (keep.length) {
    db.prepare(`DELETE FROM agents WHERE agentId NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
  }
}

export function emit(db, { type, source = 'control-plane', taskId = null, agentId = null, payload = {}, dedupeKey = null }) {
  const eventId = `EV-${randomUUID()}`;
  const key = dedupeKey ?? `${type}:${taskId ?? ''}:${agentId ?? ''}:${eventId}`;
  const info = db.prepare(`INSERT OR IGNORE INTO events
    (eventId, type, source, taskId, agentId, payloadJson, dedupeKey, processed, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    eventId, type, source, taskId, agentId, JSON.stringify(payload), key, nowIso(),
  );
  return { inserted: info.changes === 1, eventId, dedupeKey: key };
}

export function nextEvent(db) {
  return db.prepare('SELECT * FROM events WHERE processed = 0 ORDER BY rowid LIMIT 1').get() ?? null;
}

export function markProcessed(db, eventId) {
  db.prepare('UPDATE events SET processed = 1 WHERE eventId = ?').run(eventId);
}

export function pendingEvents(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM events WHERE processed = 0').get().n;
}

export function writeAudit(db, { actor, action, oldValue = null, newValue = null, runId = null, taskId = null }) {
  db.prepare(`INSERT INTO audit (auditId, actor, action, oldValue, newValue, runId, taskId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `AU-${randomUUID()}`, actor, action,
    oldValue === null ? null : String(oldValue),
    newValue === null ? null : String(newValue), runId, taskId, nowIso(),
  );
}

// 合法跳转表。awaiting_decision / cancelled 是 v1.0 新增态；cancelled 与 done 都是终态。
export const TRANSITIONS = Object.freeze({
  backlog: ['todo', 'cancelled'],
  todo: ['in_progress', 'paused', 'cancelled'],
  in_progress: ['in_review', 'blocked', 'awaiting_decision', 'cancelled'],
  awaiting_decision: ['in_progress', 'cancelled'],
  in_review: ['done', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
  blocked: ['todo', 'cancelled'],
  paused: ['todo', 'cancelled'],
});

export function transition(db, taskId, to, actor = 'control-plane', runId = null) {
  const row = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(taskId);
  if (!row) throw new Error(`任务不存在：${taskId}`);
  const from = row.status;
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    writeAudit(db, { actor, action: 'illegal_transition', oldValue: from, newValue: to, runId });
    throw new Error(`非法跳转：${taskId} ${from} → ${to}（允许：${allowed.join(', ') || '无'}）`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE taskId = ?').run(to, nowIso(), taskId);
    writeAudit(db, { actor, action: 'transition', oldValue: from, newValue: to, runId });
    emit(db, { type: 'state_changed', taskId, payload: { from, to } });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { from, to };
}

// 补偿扫描：只捞 todo / in_progress；awaiting_decision / paused / cancelled / done 必须排除。
// P2-3 / P5：补偿扫描只碰 todo / in_progress，绝不碰挂起态。
// now 可注入：试运行用虚拟时钟压缩多天，若这里偷用 Date.now()，任务的时间戳都在「未来」，
// 扫描会永远跳过，长跑验证就变成了假通过。
export function compensationScan(db, { olderThanMs = 0, now = Date.now() } = {}) {
  const candidates = db.prepare('SELECT taskId, status, updatedAt, assignee FROM tasks WHERE status IN (?, ?)')
    .all('todo', 'in_progress');
  const cutoff = (now instanceof Date ? now.getTime() : Number(now)) - olderThanMs;
  let requeued = 0;
  for (const task of candidates) {
    if (Date.parse(task.updatedAt) > cutoff) continue;
    const result = emit(db, {
      type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
      dedupeKey: `compensation:${task.taskId}:${task.updatedAt}`,
      payload: { wakeReason: 'compensation' },
    });
    if (result.inserted) requeued += 1;
  }
  return { requeued, scanned: candidates.length, whitelist: ['todo', 'in_progress'] };
}
