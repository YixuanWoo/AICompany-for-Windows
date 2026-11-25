#!/usr/bin/env node
// 一句话下单：不用拼 JSON、不用开看板，敲一句就走。
//
//   npm run task -- "写一份本周工作简报"
//   npm run task -- "把 output 里的周报改成 200 字" --wait
//   npm run task -- "这个难活" --difficulty hard --to doubao
//   npm run task -- "把第三批文档处理完" --project demo --wait
//
// 为什么要有它：控制面已经有 REST 接口，但「天天用」的门槛是**记不住 curl 和字段**。
// 这里只做三件事：拼请求、打印任务号、可选地等到出结果并把产物摘要打出来。

const DEFAULT_PORT = Number(process.env.AICOMPANY_PORT ?? 3100);
const HOST = process.env.AICOMPANY_HOST ?? '127.0.0.1';

function usage() {
  return [
    '用法：npm run task -- "一句话需求" [选项]',
    '',
    '选项：',
    '  --project <项目>   项目 id（只配了一个项目时可省）；规范与经验跟着项目走',
    '  --to <席位>        指定的执行席位（只有一个执行席位时可省）',
    '  --mode <模式>      direct（默认）| delegate',
    '  --difficulty <档>  easy | normal（默认）| hard',
    '  --title <标题>     任务卡标题，默认取需求前 30 字',
    '  --wait             等它跑完，并打印产物摘要',
    '  --timeout <秒>     配合 --wait，默认 1800 秒',
    '  --port <端口>      控制面端口，默认 3100',
    '  --json             机器可读输出（脚本里用）',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    text: '', to: null, mode: null, difficulty: 'normal', title: null, project: null,
    wait: false, timeoutSec: 1800, port: DEFAULT_PORT, json: false,
  };
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 缺参数值`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--project') { opts.project = next(); continue; }
    if (arg === '--to') { opts.to = next(); continue; }
    if (arg === '--mode') { opts.mode = next(); continue; }
    if (arg === '--difficulty') { opts.difficulty = next(); continue; }
    if (arg === '--title') { opts.title = next(); continue; }
    if (arg === '--timeout') { opts.timeoutSec = Number(next()); continue; }
    if (arg === '--port') { opts.port = Number(next()); continue; }
    if (arg === '--wait') { opts.wait = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg.startsWith('--')) throw new Error(`不认识的选项：${arg}`);
    words.push(arg);
  }
  opts.text = words.join(' ').trim();
  return opts;
}

function baseUrl(port) {
  return `http://${HOST}:${port}`;
}

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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function short(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) { console.log(usage()); return; }
  if (!opts.text) {
    console.error('需求是空的 —— 至少写一句话。\n');
    console.error(usage());
    process.exit(2);
  }

  let meta = {};
  try { meta = await api(opts.port, '/api/meta'); } catch (error) {
    console.error(`连不上控制面 http://${HOST}:${opts.port}（${error.message}）`);
    console.error('先确认它在跑：npm run win:status');
    process.exit(3);
  }

  const mode = opts.mode ?? meta.defaultMode ?? 'direct';
  // P7：配了项目就必选。只配了一个时替人填上，但**打出来**——不然人会以为产物会落到别处。
  const projects = Array.isArray(meta.projects) ? meta.projects : [];
  let project = opts.project;
  if (!project && projects.length === 1) project = projects[0].id;
  if (!project && projects.length > 1) {
    console.error(`有 ${projects.length} 个项目，请用 --project 指定：${projects.map((p) => `${p.id}（${p.displayName}）`).join(' / ')}`);
    process.exit(2);
  }
  if (project && projects.length && !projects.some((p) => p.id === project)) {
    console.error(`没有这个项目：${project}；可用：${projects.map((p) => p.id).join(', ')}`);
    process.exit(2);
  }
  const projectLabel = project
    ? (projects.find((p) => p.id === project)?.displayName ?? project)
    : null;

  const execSeats = (meta.seats ?? []).filter((s) => !s.isCEO);
  let target = opts.to;
  if (!target && mode === 'direct') {
    if (execSeats.length === 1) target = execSeats[0].agentId;
    else if (execSeats.length === 0) {
      console.error('这家公司没有执行席位，没人能接活。检查配置里的 agents。');
      process.exit(3);
    } else {
      console.error(`有 ${execSeats.length} 个执行席位，请用 --to 指定：${execSeats.map((s) => s.agentId).join(' / ')}`);
      process.exit(2);
    }
  }

  if (!opts.json) {
    const paused = meta.guiPaused ? '（注意：GUI 席位当前是暂停状态，会在恢复后自动跑）' : '';
    const where = projectLabel ? `项目 ${projectLabel}（${project}）` : '未配项目';
    console.log(`下单 → ${where} · ${mode}${target ? ' / ' + target : ''} 难度 ${opts.difficulty}${paused}`);
  }

  const body = {
    title: opts.title ?? short(opts.text, 30),
    text: opts.text,
    mode,
    difficulty: opts.difficulty,
  };
  if (project) body.project = project;
  if (target) body.addressedTo = target;

  let submitted;
  try { submitted = await api(opts.port, '/api/requests', { method: 'POST', body: JSON.stringify(body) }); } catch (error) {
    console.error(`提交失败：${error.message}`);
    process.exit(4);
  }

  if (opts.json && !opts.wait) { console.log(JSON.stringify(submitted, null, 2)); return; }

  const taskId = submitted.taskId;
  console.log(`已接单：${taskId}${submitted.duplicate ? '（同一 requestId 之前提过，未重复建卡）' : ''}`);
  if (!opts.wait) {
    console.log('不用等它：看板上能看到进度 → http://127.0.0.1:' + opts.port + '/');
    console.log(`想直接等结果就加一步：npm run task -- "${short(opts.text, 20)}" --wait`);
    return;
  }

  // ---- 等结果：只认控制面给的终态，不猜 ----
  const deadline = Date.now() + Math.max(10, opts.timeoutSec) * 1000;
  const terminal = new Set(['done', 'cancelled', 'blocked', 'paused', 'awaiting_decision']);
  let task = null;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    try { task = await api(opts.port, `/api/tasks/${taskId}`); } catch { continue; }
    if (task.status !== lastStatus) {
      if (!opts.json) console.log(`  · ${task.status}`);
      lastStatus = task.status;
    }
    if (terminal.has(task.status)) break;
  }

  if (!task || !terminal.has(task.status)) {
    console.error(`等了 ${opts.timeoutSec} 秒还没到终态（当前：${task?.status ?? '未知'}），去看看板。`);
    process.exit(5);
  }

  if (opts.json) {
    let outputs = null;
    try { outputs = await api(opts.port, `/api/tasks/${taskId}/outputs`); } catch { outputs = null; }
    console.log(JSON.stringify({ task, outputs }, null, 2));
    process.exit(task.status === 'done' ? 0 : 1);
  }

  console.log('');
  if (task.status !== 'done') {
    // 没干成要说清为什么 —— 否则「天天用」的人只会看到一张写着 blocked 的卡。
    let reason = '';
    try {
      const audit = await api(opts.port, `/api/audit?taskId=${taskId}`);
      const last = [...audit].reverse().find((a) => a.action === 'report_rejected' || a.action === 'gate_blocked' || a.action === 'env_check_failed');
      reason = last ? `${last.action}：${last.newValue}` : '';
    } catch { reason = ''; }
    console.error(`结果：${task.status}${reason ? ' —— ' + reason : ''}`);
    process.exit(1);
  }

  console.log(`完成：${task.taskId} · ${task.title}`);
  let outputs = { files: [] };
  try { outputs = await api(opts.port, `/api/tasks/${taskId}/outputs`); } catch { /* 没产物就直说 */ }
  if (!outputs.files?.length) {
    console.log('（没有产物文件，只有完成报告）');
    return;
  }
  console.log(`产物 ${outputs.files.length} 个：`);
  for (const file of outputs.files) {
    console.log(`  - output/${file.name}  ${file.size} 字节${file.empty ? '（空文件）' : ''}`);
  }
  const first = outputs.files.find((f) => !f.empty && /\.(md|txt|csv|json)$/i.test(f.name));
  if (first) {
    try {
      const one = await api(opts.port, `/api/tasks/${taskId}/output?file=${encodeURIComponent(first.name)}`);
      console.log('');
      console.log(`—— ${first.name} 前 20 行 ——`);
      console.log(one.text.split(/\r?\n/).slice(0, 20).join('\n'));
    } catch { /* 读不到就不打，别把成功的结果搞成失败 */ }
  }
}

main().catch((error) => {
  console.error(`出错了：${String(error?.stack ?? error)}`);
  process.exit(1);
});
