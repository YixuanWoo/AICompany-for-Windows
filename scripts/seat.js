#!/usr/bin/env node
// 席位自助 CLI：给「人叫才醒」的交互式 agent 用（拉模式席位）。
// 控制面不会主动派活给它，它得自己来领；领了要记住、要交、交完要清。
//
// 用法（席位 id 与地址走环境变量，源码不写死任何人的名字）：
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js status
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js inbox
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js claim          # 领最早一张
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js claim --task T-xxx --ttl 7200
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js holding        # 我手上还有什么没交
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js renew --ttl 3600
//   AICOMPANY_AGENT_ID=wb node scripts/seat.js report --summary "做了什么" \
//        [--status success|failed|blocked] [--task T-xxx] [--acceptance "条件=通过"]

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSeat } from '../src/seat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const baseUrl = env.AICOMPANY_BRIDGE_URL ?? 'http://127.0.0.1:3100';
const token = env.AICOMPANY_BRIDGE_TOKEN ?? null;
const workRoot = path.resolve(ROOT, env.AICOMPANY_WORK_ROOT ?? 'work-prod');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { out._.push(item); continue; }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'status';
// --as 优先于环境变量：一个会话里可能同时照看多个席位，不用改全局 env。
const agentId = (args.as && args.as !== true ? String(args.as) : null) ?? env.AICOMPANY_AGENT_ID ?? null;
if (!agentId) {
  console.error('缺 AICOMPANY_AGENT_ID：席位 id 就是岗位 id（例如 AICOMPANY_AGENT_ID=wb）');
  process.exit(2);
}

const seat = createSeat({ baseUrl, agentId, token, workRoot });

const line = (text = '') => console.log(text);

function printTask(task) {
  line(`  卡号   ${task.taskId}`);
  line(`  标题   ${task.title}`);
  line(`  项目   ${task.project ?? '(一次性，不属于任何项目)'}`);
  line(`  难度   ${task.difficulty ?? 'normal'}｜模式 ${task.mode ?? '-'}｜修订 ${task.revision ?? 1}`);
  line(`  验收   ${(task.acceptance ?? []).length} 条`);
  for (const rule of task.acceptance ?? []) line(`         · ${rule}`);
  if (task.instructions) {
    line('  ── 任务指令 ──');
    for (const text of String(task.instructions).split('\n')) line(`  ${text}`);
  }
}

async function main() {
  await seat.heartbeat({ via: 'cli' });

  if (command === 'status') {
    const s = await seat.status();
    line(`席位 ${agentId} → ${baseUrl}`);
    line(`  在线    ${s.me?.online ? `是（${s.me.lastSeenAt}）` : '否'}`);
    line(`  待我领  ${s.myQueued} 张`);
    line(`  全局    队列 ${s.queued} 张｜已领未交 ${s.leased} 张｜派活方式 ${s.dispatchMode}`);
    const held = seat.holding();
    if (held) line(`  手上有  ${held.taskId}（${held.title}）租约到 ${held.leaseExpiresAt}`);
    return;
  }

  if (command === 'inbox') {
    const box = await seat.inbox();
    if (!box.tasks?.length) { line(`队列空：${agentId} 当前没有待领的卡。`); return; }
    line(`待领 ${box.tasks.length} 张：`);
    for (const task of box.tasks) { printTask(task); line(); }
    return;
  }

  if (command === 'claim') {
    const held = seat.holding();
    if (held) {
      line(`⚠ ${agentId} 手上还有一张没交：${held.taskId}（${held.title}）`);
      line(`  先交活（report）或明确放弃，否则再领会让两张卡同时占着你的手。`);
      line(`  租约到 ${held.leaseExpiresAt}；要延长用 renew。`);
      process.exit(1);
    }
    const out = await seat.claim({
      taskId: args.task === true ? null : (args.task ?? null),
      ttlSec: Number(args.ttl ?? 3600),
    });
    if (!out.ok) { line(`没领到：${out.reason}`); process.exit(1); }
    line(`已领：${out.taskId}｜run ${out.runId}`);
    line(`  租约到 ${out.leaseExpiresAt}（${args.ttl ?? 3600} 秒后到期，干了就 renew）`);
    line(`  队列还剩 ${out.queuedLeft} 张`);
    line();
    printTask(out);
    line();
    line('干完用：node scripts/seat.js report --summary "一句话说清干了什么"');
    return;
  }

  if (command === 'holding') {
    const held = seat.holding();
    if (!held) { line('手上没有未交的卡。'); return; }
    printTask(held);
    line(`  租约   ${held.leaseExpiresAt}`);
    return;
  }

  if (command === 'renew') {
    const out = await seat.renew({ ttlSec: Number(args.ttl ?? 3600) });
    if (!out.ok) { line(`续租失败：${out.reason}`); process.exit(1); }
    line(out.frozen ? `任务挂起中，租约冻结（${out.reason}）` : `已续租到 ${out.leaseExpiresAt}`);
    return;
  }

  if (command === 'report') {
    const acceptance = [];
    if (typeof args.acceptance === 'string') {
      for (const item of [args.acceptance].flat()) {
        const [rule, verdict] = String(item).split('=');
        acceptance.push({ rule: rule.trim(), pass: (verdict ?? '通过').trim() === '通过' });
      }
    }
    const out = await seat.complete({
      taskId: args.task === true ? undefined : args.task,
      status: args.status ?? 'success',
      summary: args.summary === true ? '' : (args.summary ?? ''),
      acceptanceResults: acceptance,
      reason: args.reason === true ? undefined : args.reason,
    });
    if (!out.ok) { line(`交活失败：${out.reason}`); process.exit(1); }
    line(`已交：${out.report.taskId}｜${out.report.status}`);
    line(`  产物   ${out.report.artifacts.length ? out.report.artifacts.join(', ') : '(无文件产物)'}`);
    line(`  控制面 ${JSON.stringify(out)}`.slice(0, 400));
    return;
  }

  console.error(`未知命令 ${command}；可用：status / inbox / claim / holding / renew / report`);
  process.exit(2);
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  if (error.data) console.error(JSON.stringify(error.data, null, 2));
  process.exit(1);
});
