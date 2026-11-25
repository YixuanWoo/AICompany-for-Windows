#!/usr/bin/env node
// 手动重新派单（命令行入口）：看板按钮之外的第二条路，给「不想开浏览器」的时候用。
//
// 走 HTTP 而不是直接开库：引擎是常驻进程，它自己拿着内存状态与 GUI 锁。
// 第二个进程写库会绕过它 —— 那才是真正的「绕开控制面」，也是这套系统最不该出现的动作。
//
// 用法：
//   npm run redispatch -- T-xxxx                    重派这张卡
//   npm run redispatch -- T-xxxx --reason "看板卡住了"
//   npm run redispatch -- T-xxxx --force            卡上还挂着一趟 Run，打断它再重派
//   npm run redispatch -- --latest                  重派最新一张没做完的卡

const PORT = Number(process.env.AICOMPANY_PORT ?? 3100);
const HOST = process.env.AICOMPANY_HOST ?? '127.0.0.1';

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? true;
}

const reason = String(arg('reason', '命令行手动重派'));
const force = process.argv.includes('--force');
let taskId = process.argv.slice(2).find((a) => /^T-/.test(a)) ?? null;

async function main() {
  if (!taskId) {
    const res = await fetch(`http://${HOST}:${PORT}/api/tasks`);
    const tasks = await res.json();
    const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
    if (!open.length) {
      console.log('没有没做完的卡，用不着重派。');
      return;
    }
    taskId = [...open].reverse()[0].taskId;
    console.log(`（按 --latest 挑了 ${taskId}：${String(open[open.length - 1].title).slice(0, 40)}）`);
  }
  const res = await fetch(`http://${HOST}:${PORT}/api/tasks/${encodeURIComponent(taskId)}/redispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, force, actor: 'cli' }),
  });
  const out = await res.json();
  if (!res.ok) {
    console.error(`接口报错：${out.error ?? res.status}`);
    process.exit(1);
  }
  if (!out.ok) {
    console.error(`没有重派：${out.message ?? out.code}`);
    console.error(out.code === 'RUNNING' ? '（确认那一趟已经卡死，加 --force 打断它）' : '');
    process.exit(2);
  }
  console.log(`已重派 ${out.taskId}：${out.from} → 排队`);
  if (out.interruptedRun) console.log(`已打断旧的那一趟：${out.interruptedRun}`);
  if (out.deduped) console.log('（这张卡已经有一条还没消费的派活事件，没有重复叠一条）');
}

main().catch((error) => {
  console.error(`连不上控制面（${HOST}:${PORT}）：${error.message}`);
  process.exit(1);
});
