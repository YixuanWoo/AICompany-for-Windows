#!/usr/bin/env node
// 定时下达（命令行入口）：给公司排一条「到点再传」的任务。
//
// 为什么不用新造一套调度：控制面本来就有循环引擎（src/recurring.js + src/rrule.js + src/scheduler.js），
// 它已经处理了「到点建卡、错过补投、上一轮没完就等」这些硬问题。这里只做两件事：
//   ① 把「几点、传什么」交给 src/schedule-request.js 翻成一条只跑一轮的循环任务（与看板同一份逻辑）；
//   ② 把「多个排班」按时间顺序摆好，同一时刻的自动错开，避免齐发。
//
// 看板里也能排（POST /api/schedule）：两处产出必须一致，所以构建逻辑只放 src。
//
// 用法：
//   npm run schedule                                 列出已排的定时任务
//   npm run schedule -- add "把第三批文档处理完" --at 02:30 --project demo
//   npm run schedule -- add "写本周简报" --at "2026-11-18 07:00" --to ceo
//   npm run schedule -- batch queue.txt             按文件里的顺序一次排一批
//   npm run schedule -- pause SCH-xxx               取消一条（循环引擎没有删除，只有暂停）
//   npm run schedule -- fire SCH-xxx                不等时间，立刻试跑一次
//   npm run schedule -- add ... --dry               只打印将要提交的 JSON，不真的排
//
// 语义（全部由现有引擎提供，不是这里造的）：
//   · 到点时如果席位正忙：卡照建，但唤醒会被并发/冷却挡住，卡留在 todo 等下一次补投 —— 这就是「等待」。
//   · overlapPolicy=queue：这条排班自己上一轮没完时，不重复建卡，等它完了再建。
//   · misfirePolicy=run_once + 宽限 12 小时：机器睡着错过了，醒来只补一次，不补一串。

import { buildScheduleJob, planBatch, isScheduledByBoard } from '../src/schedule-request.js';

export { buildScheduleJob, planBatch };

const DEFAULT_PORT = Number(process.env.AICOMPANY_PORT ?? 3100);
const HOST = process.env.AICOMPANY_HOST ?? '127.0.0.1';
const DEFAULT_TZ = process.env.AICOMPANY_TZ ?? 'Asia/Shanghai';

function usage() {
  return [
    '用法：npm run schedule -- <命令> [选项]',
    '',
    '命令：',
    '  list                                   列出已排的定时任务（含下次触发时间）',
    '  add "<一句话需求>" --at <时间>          排一条（只跑一轮）',
    '  batch <文件>                            按文件顺序排一批（每行：时间 | 需求 | 项目）',
    '  pause <jobId>                           取消（引擎只有暂停，没有删除）',
    '  resume <jobId>                          恢复',
    '  fire <jobId>                            不等时间，立刻试跑一轮',
    '',
    '选项：',
    '  --at <时间>        "02:30" 或 "2026-11-18 02:30"；只写时分＝最近一次该时刻（过了就排明天）',
    '  --project <项目>   归属项目（继承项目规范与交付目录）',
    '  --to <席位>        交给谁，默认 ceo（由总经理拆活；写执行岗则直接干活）',
    '  --review <席位>    谁验收；默认不写＝按发布者（董事会）直接落盘',
    '  --difficulty <档>  easy | normal | hard',
    '  --accept "条件1;条件2"  验收条件，分号分隔',
    '  --title <标题>     卡标题，默认取需求前 24 字',
    '  --tz <时区>        默认 Asia/Shanghai',
    '  --gap-min <分钟>   batch 时同一时刻的排班自动错开多少分钟，默认 10',
    '  --port <端口>      控制面端口，默认 3100',
    '  --dry              只打印 JSON，不提交',
    '  --json             机器可读输出',
  ].join('\n');
}

function short(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function baseUrl(port) { return `http://${HOST}:${port}`; }

async function api(port, routePath, options = {}) {
  const res = await fetch(`${baseUrl(port)}${routePath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}（${routePath}）`);
  return data;
}

function parseArgs(argv) {
  const opts = {
    at: null, project: null, to: null, review: null, difficulty: 'normal',
    accept: null, title: null, tz: DEFAULT_TZ, gapMin: 10, port: DEFAULT_PORT,
    dry: false, json: false,
  };
  const words = [];
  let command = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 缺参数值`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--at') { opts.at = next(); continue; }
    if (arg === '--project') { opts.project = next(); continue; }
    if (arg === '--to') { opts.to = next(); continue; }
    if (arg === '--review') { opts.review = next(); continue; }
    if (arg === '--difficulty') { opts.difficulty = next(); continue; }
    if (arg === '--accept') { opts.accept = next().split(';').map((s) => s.trim()).filter(Boolean); continue; }
    if (arg === '--title') { opts.title = next(); continue; }
    if (arg === '--tz') { opts.tz = next(); continue; }
    if (arg === '--gap-min') { opts.gapMin = Number(next()); continue; }
    if (arg === '--port') { opts.port = Number(next()); continue; }
    if (arg === '--dry') { opts.dry = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--')) throw new Error(`不认识的选项：${arg}`);
    if (!command) { command = arg; continue; }
    words.push(arg);
  }
  opts.command = command;
  opts.text = words.join(' ').trim();
  opts.words = words;
  return opts;
}

function fmtFire(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseBatchLine(line) {
  const raw = String(line ?? '').replace(/\r/g, '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.split('|').map((s) => s.trim());
  if (parts.length < 2) throw new Error(`这一行看不懂（要写「时间 | 需求 | 项目」）：${raw}`);
  return { at: parts[0], text: parts[1], project: parts[2] || null };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (opts.help || !opts.command) { console.log(usage()); return; }

  const fs = await import('node:fs');

  switch (opts.command) {
    case 'list': {
      const jobs = await api(opts.port, '/api/recurring');
      const mine = (Array.isArray(jobs) ? jobs : []).filter(isScheduledByBoard);
      if (opts.json) { console.log(JSON.stringify(mine, null, 2)); return; }
      if (!mine.length) { console.log('（没有定时下达的任务）'); return; }
      console.log('jobId'.padEnd(22), '下次触发'.padEnd(18), '状态'.padEnd(8), '交给'.padEnd(6), '标题');
      for (const j of mine) {
        const once = j?.termination?.maxCycles === 1 ? '一次' : '循环';
        console.log(
          String(j.jobId).padEnd(22),
          fmtFire(j.nextFireAt).padEnd(18),
          String(j.status).padEnd(8),
          String(j.assignee ?? '—').padEnd(6),
          `${j.title}（${once}）`,
        );
      }
      return;
    }
    case 'add': {
      const job = buildScheduleJob({
        text: opts.text, at: opts.at, title: opts.title, project: opts.project,
        assignee: opts.to ?? 'ceo', reviewBy: opts.review, difficulty: opts.difficulty,
        acceptance: opts.accept, tz: opts.tz,
      });
      if (opts.dry) { console.log(JSON.stringify(job, null, 2)); return; }
      const created = await api(opts.port, '/api/recurring', { method: 'POST', body: JSON.stringify(job) });
      if (opts.json) { console.log(JSON.stringify(created, null, 2)); return; }
      console.log(`已排：${created.jobId}｜下次触发 ${fmtFire(created.nextFireAt)}｜交给 ${job.assignee}｜${job.title}`);
      console.log('改主意就暂停它：npm run schedule -- pause ' + created.jobId);
      return;
    }
    case 'batch': {
      const file = opts.words[0];
      if (!file) throw new Error('batch 要给一个文件路径');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const entries = lines.map(parseBatchLine).filter(Boolean);
      if (!entries.length) throw new Error(`文件里没有可用的行：${file}`);
      const planned = planBatch(entries, { gapMin: opts.gapMin, tz: opts.tz });
      const jobs = planned.map((entry) => ({
        job: buildScheduleJob({
          text: entry.text,
          at: entry.at,
          project: entry.project ?? opts.project,
          assignee: opts.to ?? 'ceo',
          reviewBy: opts.review,
          difficulty: opts.difficulty,
          acceptance: opts.accept,
          tz: opts.tz,
        }),
        entry,
      }));
      if (opts.dry) { console.log(JSON.stringify(jobs.map((x) => x.job), null, 2)); return; }
      let n = 0;
      for (const { job, entry } of jobs) {
        const created = await api(opts.port, '/api/recurring', { method: 'POST', body: JSON.stringify(job) });
        n += 1;
        console.log(`${n}. ${created.jobId}｜${fmtFire(created.nextFireAt)}｜${short(entry.text, 30)}`);
      }
      console.log(`共排 ${n} 条，按上面的时间顺序执行；到点时若正忙，卡会留在队列里等。`);
      return;
    }
    case 'pause':
    case 'resume': {
      const jobId = opts.words[0];
      if (!jobId) throw new Error(`${opts.command} 要给 jobId`);
      const out = await api(opts.port, `/api/recurring/${encodeURIComponent(jobId)}/${opts.command}`, { method: 'POST', body: '{}' });
      console.log(`${opts.command} → ${JSON.stringify(out)}`);
      return;
    }
    case 'fire': {
      const jobId = opts.words[0];
      if (!jobId) throw new Error('fire 要给 jobId');
      const out = await api(opts.port, `/api/recurring/${encodeURIComponent(jobId)}/fire`, { method: 'POST', body: '{}' });
      console.log(`已触发：${JSON.stringify(out)}`);
      return;
    }
    default:
      console.error(`不认识的命令：${opts.command}`);
      console.error(usage());
      process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/schedule.js');
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`出错了：${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
