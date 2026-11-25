// 单卡透视：把一张卡从「下单」到「现在」的全部证据按时间摆在一起。
// 出问题时先跑这个，再决定要不要去看 watch 的时间线。
//
// 用法：
//   node scripts/trace.js T-xxxx          # 指定卡
//   node scripts/trace.js --latest        # 最新一张（按创建时间）
//   node scripts/trace.js --latest --root work-prod
//
// 只读打开数据库，不改任何状态、不唤醒任何人。

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

const root = String(arg('root', 'work-prod'));
const dbPath = String(arg('db', path.join(root, 'aicompany.db')));
const latest = process.argv.includes('--latest');
const given = process.argv.slice(2).find((a) => /^T-/.test(a));

const db = new DatabaseSync(dbPath, { readOnly: true });
try { db.exec('PRAGMA busy_timeout = 3000'); } catch { /* 忽略 */ }

let taskId = given;
if (!taskId || latest) {
  const row = db.prepare('SELECT taskId FROM tasks ORDER BY rowid DESC LIMIT 1').get();
  if (!row && !taskId) {
    console.error('库里还没有任务卡。');
    process.exit(1);
  }
  taskId = latest || !taskId ? row.taskId : taskId;
}

const task = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(taskId);
if (!task) {
  console.error(`找不到这张卡：${taskId}`);
  process.exit(1);
}

const line = (s = '') => process.stdout.write(`${s}\n`);
const fmt = (iso) => (iso ? String(iso).replace('T', ' ').replace('Z', '') : '-');

line(`\n=== ${task.taskId}｜${task.title} ===`);
line(`状态：${task.status}｜承接：${task.assignee}｜角色：${task.role}｜难度：${task.difficulty ?? '-'}`
  + `｜attempt：${task.attempt ?? 0}｜waitingChildren：${task.waitingChildren ?? 0}`);
line(`创建：${fmt(task.createdAt)}｜更新：${fmt(task.updatedAt)}｜父卡：${task.parentTaskId ?? '-'}`);
if (task.project) line(`项目：${task.project}｜仓库：${task.repo ?? '(未登记)'}`);

// 指令与验收：这是「它被要求做什么」，判断跑偏时的第一手依据。
const payload = db.prepare('SELECT * FROM task_payload WHERE taskId = ? ORDER BY revision DESC LIMIT 1').get(taskId);
if (payload) {
  line('\n--- 指令（最新 revision） ---');
  line(String(payload.instructions ?? '').slice(0, 4000));
  try {
    const acc = JSON.parse(payload.acceptanceJson ?? '[]');
    line('\n验收条件：');
    for (const a of acc) line(`  · ${typeof a === 'string' ? a : JSON.stringify(a)}`);
  } catch { /* 老数据可能不是 JSON */ }
}

// 任务目录：报告在不在、产物有哪些 —— 「干完了却显示待验收」第一眼就能看出来。
const taskDir = path.join(root, 'tasks', taskId);
line(`\n--- 任务目录 ${taskDir} ---`);
if (fs.existsSync(taskDir)) {
  const walk = (dir, depth = 0) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'brief.md' && depth > 0) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        line(`${'  '.repeat(depth)}${name}/`);
        if (depth < 2) walk(full, depth + 1);
      } else {
        line(`${'  '.repeat(depth)}${name}（${st.size} 字节）`);
      }
    }
  };
  walk(taskDir);
  for (const f of ['completion.json', 'report.draft.json', path.join('output', 'completion.json')]) {
    const full = path.join(taskDir, f);
    if (!fs.existsSync(full)) continue;
    line(`\n--- ${f} 摘要 ---`);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      line(`status=${data.status ?? '-'}｜summary=${String(data.summary ?? '').slice(0, 300)}`);
      if (Array.isArray(data.artifacts)) line(`artifacts=${data.artifacts.join(', ') || '(空)'}`);
    } catch { line('（不是合法 JSON）'); }
  }
} else {
  line('（这张卡还没有任务目录）');
}

// 子卡与处置卡：卡住时「谁还在替它做事」。
const kids = db.prepare('SELECT taskId, title, role, status, assignee, createdAt FROM tasks WHERE parentTaskId = ? ORDER BY rowid').all(taskId);
line('\n--- 子卡 / 处置卡 ---');
if (!kids.length) line('（没有）');
for (const k of kids) line(`  ${k.taskId}｜${k.role}｜${k.status}｜${k.assignee}｜${k.title}`);

// runs：谁真的跑过、跑多久、结果如何。
const runs = db.prepare('SELECT * FROM runs WHERE taskId = ? ORDER BY rowid').all(taskId);
line('\n--- Runs ---');
if (!runs.length) line('（一次都没跑）');
for (const r of runs) {
  const start = Date.parse(r.startedAt ?? '');
  const end = r.finishedAt ? Date.parse(r.finishedAt) : Date.now();
  const min = Number.isNaN(start) ? '?' : ((end - start) / 60000).toFixed(1);
  line(`  ${r.runId}｜${r.agentId}｜${r.wakeReason ?? '-'}｜${r.status}｜${min} 分钟｜`
    + `${fmt(r.startedAt)} → ${r.finishedAt ? fmt(r.finishedAt) : '（没结束）'}`);
}

// 变更请求：它有没有「想问你」—— 这是「agent 在会话里问人」的正式通道。
const crs = db.prepare('SELECT * FROM change_requests WHERE taskId = ? ORDER BY rowid').all(taskId);
line('\n--- 变更请求（它想问的事） ---');
if (!crs.length) line('（没有）');
for (const c of crs) line(`  ${c.changeRequestId}｜${c.kind}｜${c.severity}｜${String(c.reason ?? '').slice(0, 200)}`);

// 事件：谁被叫过、叫了几次、有没有卡住没处理。
const events = db.prepare('SELECT * FROM events WHERE taskId = ? ORDER BY rowid').all(taskId);
line('\n--- 事件 ---');
if (!events.length) line('（没有）');
for (const e of events) line(`  ${e.type}｜${e.agentId ?? '-'}｜processed=${e.processed}｜${fmt(e.createdAt)}`);

// 审计：状态机与升级的完整轨迹（这是最可靠的一条线）。
const audits = db.prepare('SELECT * FROM audit WHERE taskId = ? ORDER BY rowid').all(taskId);
line('\n--- 审计时间线 ---');
if (!audits.length) line('（没有）');
for (const a of audits) {
  const val = [a.oldValue, a.newValue].filter(Boolean).join(' → ');
  line(`  ${fmt(a.createdAt).slice(5, 23)}｜${a.action}｜${a.actor ?? '-'}${val ? `｜${String(val).replace(/\s+/g, ' ').slice(0, 240)}` : ''}`);
}

// 审批单：唯一合法的人工停点。
const approvals = db.prepare('SELECT * FROM approvals WHERE taskId = ? ORDER BY rowid').all(taskId);
line('\n--- 审批单 ---');
if (!approvals.length) line('（没有）');
for (const a of approvals) line(`  ${a.approvalId}｜${a.kind}｜${a.status}｜${a.title}`);

line('\n（只读取证，没有改动任何状态。）\n');
db.close();
