// 运行观测台（常驻）：把引擎的「真实运行数据」按时间线记下来，出问题能复盘。
//
// 设计原则（为什么不是又一个 dashboard）：
//   · 只读打开生产库，绝不写库、绝不触发任何唤醒 —— 观测工具不许改变被观测的系统；
//   · 增量采样（audit / events / runs / tasks 都按 rowid 或状态差量取），跑一天也不会卡；
//   · 告警规则写死在这一个文件里，出问题只看一份 md，不用在四个表之间对时间戳；
//   · 关掉进程就停，不留后台任务、不改系统配置。
//
// 用法（工作根默认 work-prod）：
//   node scripts/watch.js                          # 每 5 秒采样，一直跑到 Ctrl+C
//   node scripts/watch.js --minutes 120            # 跑两小时自动收
//   node scripts/watch.js --task T-xxxx            # 盯住某一张卡
//   node scripts/watch.js --interval 3 --root work-prod
// 产物：work-prod/watch/watch-<时间戳>.jsonl（机器读）+ 同名 .md（人读，持续覆盖写）

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? true;
}

const intervalSec = Number(arg('interval', 5)) || 5;
const minutes = Number(arg('minutes', 0)) || 0;
const root = String(arg('root', 'work-prod'));
const focusArg = arg('task', null);
const dbPath = String(arg('db', path.join(root, 'aicompany.db')));
const outDir = path.join(root, 'watch');
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonlPath = path.join(outDir, `watch-${stamp}.jsonl`);
const mdPath = path.join(outDir, `watch-${stamp}.md`);
// 逐条追加落盘（不是流缓冲）：进程被强杀也不会丢已经记下来的证据。
const appendJsonl = (obj) => fs.appendFileSync(jsonlPath, `${JSON.stringify(obj)}\n`, 'utf8');

// 阈值（分钟）。GUI 席位一次能跑几分钟，所以 stallWarn 不能太小。
const stallWarnMin = Number(arg('stall-warn', 10)) || 10;
const stallAlertMin = Number(arg('stall-alert', 30)) || 30;
const runWarnMin = Number(arg('run-warn', 15)) || 15;
const runAlertMin = Number(arg('run-alert', 45)) || 45;
const eventWarnMin = Number(arg('event-warn', 5)) || 5;
const eventAlertMin = Number(arg('event-alert', 15)) || 15;
const blockedAlertMin = Number(arg('blocked-alert', 5)) || 5;

// 这些审计动作本身就代表「系统做了个决定」，时间线上必须留下。
const HOT = new Set([
  'create_task', 'reported_upward', 'reported_to_board', 'escalated', 'blocked_escalated',
  'change_request', 'change_request_handed_up', 'suspend_for_decision', 'resumed_after_escalation',
  'review_rejected', 'review_passed', 'review_requeued', 'review_stuck', 'review_rework',
  'report_rejected', 'run_timeout', 'run_orphaned', 'run_closed_by_seat', 'stuck_escalated',
  'wake_deferred', 'review_deferred', 'stale_wake_skipped', 'wake_failed', 'pump_failed',
  'children_settled', 'escalate_to_rescue', 'deliver_failed', 'snapshot_failed',
  'gate_retry', 'gate_blocked', 'change_request_denied',
]);
// 告警级别：warn 只是提示，alert 需要人（或我）看一眼。
const AUDIT_LEVEL = {
  reported_upward: 'info', reported_to_board: 'alert', blocked_escalated: 'warn',
  escalated: 'info', escalated_change: 'info', change_request: 'warn', suspend_for_decision: 'alert',
  review_stuck: 'alert', run_timeout: 'alert', run_orphaned: 'warn', pump_failed: 'alert',
  report_rejected: 'warn', review_rejected: 'info', stuck_escalated: 'alert',
  wake_deferred: 'info', review_deferred: 'warn', wake_failed: 'alert', escalate_to_rescue: 'info',
  deliver_failed: 'warn', snapshot_failed: 'warn', gate_blocked: 'info',
};
const NOISE = /^(transition|wake|run_params|memory_written|quota_|progress_only|brief|message_)/;

const startedAt = Date.now();
const state = {
  lastAuditRow: null,
  lastEventRow: null,
  tasks: new Map(),      // taskId -> { status, updatedAt, since, attempt }
  runs: new Map(),
  focus: focusArg ? String(focusArg) : null,
  alerts: [],            // { at, level, kind, text }
  alertCooldown: new Map(),
  logOffset: new Map(),
  ticks: 0,
  baseline: true,        // 第一轮只登记历史卡，不当成「新下单」
  children: new Map(),   // parentTaskId -> [taskIds]
  pendingApprovals: new Set(),
};

let db = null;
function openDb() {
  db = new DatabaseSync(dbPath, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 3000'); } catch { /* 老版本没有，可忽略 */ }
  const rowidOf = (t) => Number(db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${t}`).get().n);
  state.lastAuditRow = rowidOf('audit');
  state.lastEventRow = rowidOf('events');
}

function write(kind, payload) {
  appendJsonl({ t: new Date().toISOString(), kind, ...payload });
}

function say(line) {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  appendJsonl({ t: new Date().toISOString(), kind: 'stdout', line });
}

function alert(level, kind, text, key = null) {
  if (key) {
    const last = state.alertCooldown.get(key) ?? 0;
    if (Date.now() - last < 5 * 60 * 1000) return; // 同一条 5 分钟内只报一次
    state.alertCooldown.set(key, Date.now());
  }
  const entry = { at: new Date().toISOString(), level, kind, text };
  state.alerts.push(entry);
  if (state.alerts.length > 200) state.alerts.shift();
  say(`${level === 'alert' ? '!! ALERT' : level.toUpperCase()} ${kind}｜${text}`);
  write('alert', entry);
}

function minutesBetween(a, b = Date.now()) {
  const t = Date.parse(a);
  return Number.isNaN(t) ? 0 : (b - t) / 60000;
}

// ---------- 采样：任务 ----------
const oneLine = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function sampleTasks() {
  const rows = db.prepare(`SELECT taskId, parentTaskId, title, role, assignee, status,
    createdAt, updatedAt, attempt FROM tasks`).all();
  for (const row of rows) {
    const prev = state.tasks.get(row.taskId);
    if (!prev) {
      state.tasks.set(row.taskId, { ...row, since: row.updatedAt });
      write('task-new', { ...row, title: oneLine(row.title, 200) });
      // 第一轮扫描到的是「历史卡」，不是「新下的单」：只登记、不报警、不抢聚焦。
      if (state.baseline) continue;
      if (!state.focus && row.createdAt && Date.parse(row.createdAt) > startedAt - 60 * 1000) {
        state.focus = row.taskId;
        say(`聚焦新卡 ${row.taskId}｜${oneLine(row.title)}`);
      }
      alert('info', 'task', `新卡 ${row.taskId}｜${oneLine(row.title)}｜${row.assignee}`, `new:${row.taskId}`);
      continue;
    }
    if (prev.status !== row.status) {
      const line = `${row.taskId}｜${prev.status} → ${row.status}｜${row.assignee}｜${oneLine(row.title, 60)}`;
      say(line);
      write('task-status', { taskId: row.taskId, from: prev.status, to: row.status, title: oneLine(row.title, 200) });
      alert('info', 'task-status', line, `st:${row.taskId}:${row.status}`);
      state.tasks.set(row.taskId, { ...row, since: row.updatedAt, prevStatus: prev.status });
      continue;
    }
    if (prev.updatedAt !== row.updatedAt) {
      state.tasks.set(row.taskId, { ...row, since: row.updatedAt, prevStatus: prev.prevStatus });
    }
  }
  state.baseline = false;
  state.children.clear();
  for (const row of rows) {
    if (!row.parentTaskId) continue;
    const list = state.children.get(row.parentTaskId) ?? [];
    list.push({ taskId: row.taskId, status: row.status, role: row.role });
    state.children.set(row.parentTaskId, list);
  }
}

// ---------- 采样：审计（增量） ----------
function sampleAudit() {
  const rows = db.prepare(`SELECT rowid, auditId, actor, action, oldValue, newValue, taskId, runId, createdAt
    FROM audit WHERE rowid > ? ORDER BY rowid`).all(state.lastAuditRow ?? 0);
  if (!rows.length) return;
  state.lastAuditRow = Number(rows[rows.length - 1].rowid);
  for (const row of rows) {
    write('audit', row);
    if (NOISE.test(row.action)) continue;
    const short = `${row.action}${row.taskId ? ` ${row.taskId}` : ''}${
      row.newValue ? `｜${String(row.newValue).replace(/\s+/g, ' ').slice(0, 260)}` : ''
    }`;
    if (HOT.has(row.action)) say(`audit ${short}`);
    const level = AUDIT_LEVEL[row.action];
    if (level) {
      alert(level, 'audit', short, `au:${row.action}:${row.taskId ?? '-'}:${Math.floor(Date.now() / (5 * 60 * 1000))}`);
    }
  }
}

// ---------- 采样：事件（增量） ----------
function sampleEvents() {
  const rows = db.prepare(`SELECT rowid, eventId, type, agentId, taskId, processed, createdAt
    FROM events WHERE rowid > ? ORDER BY rowid`).all(state.lastEventRow ?? 0);
  if (!rows.length) return;
  state.lastEventRow = Number(rows[rows.length - 1].rowid);
  for (const row of rows) write('event', row);
}

// ---------- 采样：runs ----------
function sampleRuns() {
  const rows = db.prepare(`SELECT runId, taskId, agentId, wakeReason, status, startedAt, finishedAt
    FROM runs`).all();
  for (const row of rows) {
    const prev = state.runs.get(row.runId);
    if (!prev) {
      state.runs.set(row.runId, row);
      write('run-new', row);
      if (row.status === 'running') say(`run 开跑 ${row.runId}｜${row.agentId}｜${row.taskId}｜${row.wakeReason}`);
      continue;
    }
    if (prev.status !== row.status) {
      state.runs.set(row.runId, row);
      const min = minutesBetween(row.startedAt);
      write('run-status', { ...row, minutes: Number(min.toFixed(1)) });
      say(`run ${row.status} ${row.runId}｜${row.agentId}｜${row.taskId}｜跑了 ${min.toFixed(1)} 分钟`);
      if (row.status !== 'success') alert('warn', 'run', `${row.runId} ${row.status}｜${row.taskId}｜${min.toFixed(1)} 分钟`, `run:${row.runId}`);
    }
  }
}

// ---------- 采样：等待中的事件 ----------
function sampleBacklog() {
  const rows = db.prepare(`SELECT eventId, type, taskId, createdAt FROM events WHERE processed = 0`).all();
  write('backlog', { n: rows.length });
  for (const row of rows) {
    const age = minutesBetween(row.createdAt);
    if (age > eventAlertMin) alert('alert', 'backlog', `事件 ${row.type} 积压 ${age.toFixed(1)} 分钟（${row.taskId ?? '-'}）`, `bl:${row.eventId}`);
    else if (age > eventWarnMin) alert('warn', 'backlog', `事件 ${row.type} 积压 ${age.toFixed(1)} 分钟`, `bl:${row.eventId}`);
  }
}

// ---------- 规则：卡住判断 ----------
function checkStalls() {
  const now = Date.now();
  for (const [taskId, info] of state.tasks) {
    if (['done', 'cancelled'].includes(info.status)) continue;
    const idleMin = minutesBetween(info.since, now);
    const openKids = (state.children.get(taskId) ?? []).filter((k) => !['done', 'cancelled'].includes(k.status));
    if (info.status === 'blocked') {
      const hasOpenEsc = openKids.some((k) => k.role === 'escalation');
      if (idleMin > blockedAlertMin && !hasOpenEsc) {
        alert('alert', 'stall', `卡 ${taskId} 停在 blocked ${idleMin.toFixed(0)} 分钟，没有处置卡、也没有待批单`, `stall:${taskId}:blocked`);
      }
      continue;
    }
    if (info.status === 'awaiting_decision' && idleMin > stallAlertMin) {
      alert('alert', 'stall', `卡 ${taskId} 挂起 ${idleMin.toFixed(0)} 分钟没人拍板`, `stall:${taskId}:sus`);
      continue;
    }
    if (idleMin > stallAlertMin) alert('alert', 'stall', `卡 ${taskId} 停在 ${info.status} ${idleMin.toFixed(0)} 分钟`, `stall:${taskId}:alert`);
    else if (idleMin > stallWarnMin) alert('warn', 'stall', `卡 ${taskId} 停在 ${info.status} ${idleMin.toFixed(0)} 分钟`, `stall:${taskId}:warn`);
  }
  // 跑太久的 run
  for (const [runId, run] of state.runs) {
    if (run.status !== 'running') continue;
    const min = minutesBetween(run.startedAt, now);
    if (min > runAlertMin) alert('alert', 'run', `run ${runId} 已 running ${min.toFixed(0)} 分钟（${run.taskId}）`, `rlong:${runId}`);
    else if (min > runWarnMin) alert('warn', 'run', `run ${runId} 已 running ${min.toFixed(0)} 分钟`, `rlong:${runId}`);
  }
}

// ---------- 采样：日志尾 ----------
function sampleLogs() {
  const logDir = path.join(root, 'logs');
  if (!fs.existsSync(logDir)) return;
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(logDir, `server-${today}.log`);
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  const offset = state.logOffset.get(file) ?? Math.max(0, size - 2000); // 首轮只看尾部，不重放历史
  if (size < offset) state.logOffset.set(file, 0);
  const start = size < offset ? 0 : offset;
  const buf = fs.readFileSync(file);
  const chunk = buf.subarray(start).toString('utf8');
  state.logOffset.set(file, size);
  if (!chunk.trim()) return;
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    write('log', { line });
    if (/ExperimentalWarning|trace-warnings/.test(line)) continue;
    if (/(ERROR|error\]|Exception|异常|被拒|启动失败|未捕获)/.test(line)) {
      say(`log ${line.slice(0, 240)}`);
      alert('alert', 'log', line.slice(0, 300), `log:${line.slice(0, 60)}`);
    }
  }
}

// ---------- 人读摘要 ----------
function renderMd() {
  const now = new Date();
  const counts = {};
  for (const info of state.tasks.values()) counts[info.status] = (counts[info.status] ?? 0) + 1;
  const running = [...state.runs.values()].filter((r) => r.status === 'running');
  const focus = state.focus ? state.tasks.get(state.focus) : null;
  const recentAlerts = state.alerts.slice(-12);
  const lines = [];
  lines.push(`# 运行观测台 · ${now.toLocaleString('zh-CN', { hour12: false })}`);
  lines.push('');
  lines.push(`采样：每 ${intervalSec}s · 已跑 ${Math.round((Date.now() - startedAt) / 60000)} 分钟 · 采样 ${state.ticks} 轮`);
  lines.push(`数据库：\`${dbPath}\`（只读）`);
  lines.push('');
  lines.push('## 现在');
  lines.push(`- 任务：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || '（空）'}`);
  lines.push(`- 正在跑：${running.length ? running.map((r) => `${r.runId}（${r.agentId}，${minutesBetween(r.startedAt).toFixed(0)} 分钟）`).join('；') : '无'}`);
  if (focus) {
    lines.push(`- 聚焦：${focus.taskId}｜${focus.title}｜${focus.assignee}｜**${focus.status}**｜`
      + `停在当前状态 ${minutesBetween(focus.since).toFixed(0)} 分钟｜attempt ${focus.attempt ?? 0}`);
  } else {
    lines.push('- 聚焦：未指定（可用 `--task T-xxx` 指定）');
  }
  lines.push('');
  lines.push('## 告警');
  if (!recentAlerts.length) lines.push('- 还没有告警。');
  for (const a of recentAlerts) {
    lines.push(`- ${a.level === 'alert' ? '**[ALERT]**' : a.level === 'warn' ? '[warn]' : '[info]'} `
      + `${a.at.slice(11, 19)} ${a.kind}：${a.text}`);
  }
  lines.push('');
  lines.push('## 时间线（最近关键动作）');
  lines.push(...(state.timeline ?? ['- （还没采到关键动作）']));
  lines.push('');
  lines.push('## 怎么看这份东西');
  lines.push('- `[ALERT]` 需要有人动手；`[warn]` 只是「有点慢」，通常自己会好；');
  lines.push('- 卡在同一状态超过阈值、blocked 没有处置卡、事件积压、run 跑太久，都会在这里出现；');
  lines.push('- 原始数据在同名 `.jsonl` 里（每行一个采样/审计/事件/日志），复盘时按时间戳对。');
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
}

function recordTimeline() {
  // 只留关键行，避免 md 越写越长
  state.timeline = state.timeline ?? [];
  const last = state.alerts[state.alerts.length - 1];
  if (!last) return;
  const line = `- ${last.at.slice(11, 19)} ${last.kind}：${last.text}`;
  if (state.timeline[state.timeline.length - 1] !== line) {
    state.timeline.push(line);
    if (state.timeline.length > 40) state.timeline.shift();
  }
}

async function tick() {
  try {
    if (!db) openDb();
    sampleTasks();
    sampleAudit();
    sampleEvents();
    sampleRuns();
    sampleBacklog();
    sampleLogs();
    checkStalls();
    recordTimeline();
    state.ticks += 1;
    renderMd();
    write('heartbeat', {
      ticks: state.ticks,
      tasks: [...state.tasks.values()].reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {}),
      running: [...state.runs.values()].filter((r) => r.status === 'running').length,
      alerts: state.alerts.length,
    });
  } catch (error) {
    alert('alert', 'watch', `采样失败：${String(error.message ?? error)}`, 'watch:error');
  }
}

say(`观测台启动：db=${dbPath} 输出=${mdPath}`);
openDb();
tick();
const timer = setInterval(tick, intervalSec * 1000);
if (minutes > 0) setTimeout(() => { say('到点收工'); clearInterval(timer); process.exit(0); }, minutes * 60 * 1000);
process.on('SIGINT', () => { say('收到 Ctrl+C，收工'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
