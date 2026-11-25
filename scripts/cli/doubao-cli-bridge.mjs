// 豆包 CLI 席位桥接（P3，2026-11-23）
//
// 为什么要有这个脚本：
//   CLI 在「没有终端」的环境里会静默卡在授权轮询（实测：每 10 秒查一次 cli_dispatch_authorization，
//   十分钟不干活）。所以必须用伪终端（winpty）启动；又因为本机 CLI 的沙箱 SDK 初始化失败
//   （failed to initialize sandbox sdk / approvals are unavailable in non-interactive mode），
//   写文件必须带 --dangerously-bypass-approvals-and-sandbox。
//
// 它对接 AICompany 的 process adapter：stdin 收 ctx JSON，stdout 最后一行输出结果 JSON。
//   - 送出去之后写 dispatch.json（L1 证据）
//   - 轮询期间只在产物真的增长时写 run-progress.json（产出心跳，不是 ping）
//   - CLI 正常结束：优先用 report.draft.json 组装正式报告；没有 draft 但有产物时按产物兜底
//   - 出现 change-requests / blocked.json：如实回报，交给引擎走汇报链路
//   - 永远 exit 0：状态放在 JSON 里，process adapter 才不会把「业务失败」当「进程失败」

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
// 项目根：越界审计要扫 src/ scripts/ config/，得先知道根在哪（不能靠 cwd，cwd 是任务目录）。
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// node-pty 是「可选依赖」：AICompany 的硬规矩是零运行时依赖（tests/p2 守着），
// 所以它不写进 package.json。要启用 CLI 席位时手动 `npm i node-pty` 即可（本机已装）。
let pty = null;
try { pty = (await import('node-pty')).default ?? null; } catch { pty = null; }
import { createHash } from 'node:crypto';
import { buildTaskPaths, buildCompletionFromDraft, writeCompletion } from '../../src/gui-report.js';
import { buildCliPrompt } from '../../src/cli-prompt.js';
import { writeDispatchReceipt, writeRunProgress, writeRunHeartbeat } from '../../src/evidence.js';

// 2026-11-23 真机：winpty 在「无控制台的 spawn + 管道 stdio」环境里会直接断言退出
// （ASSERT_CONDITION wp != nullptr && cols > 0 && rows > 0），CLI 根本没起来。
// 控制面是常驻 node 进程，没有 console 可继承 —— 所以必须用 ConPTY（node-pty）给它一个真终端。
const RUN_CJS = process.env.AICOMPANY_DOUBAO_RUN
  || 'D:\\npm-global\\node_modules\\@bytedance\\doubao-cli\\scripts\\run.cjs';

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function taskDirOf(workRoot, taskId) {
  return path.join(workRoot, 'tasks', String(taskId));
}

function scanOutput(outputDir, { maxFiles = Infinity } = {}) {
  const files = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || seen >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= maxFiles) return;
      seen += 1;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        if (st.size === 0) continue;
        files.push({ abs, name: path.relative(outputDir, abs).split(path.sep).join('/'), size: st.size });
      } catch { /* 跳过 */ }
    }
  };
  walk(outputDir, 0);
  return files;
}

function digestOf(outputDir) {
  // 采样上限：项目目录可能很大，心跳每 5 秒一拍，不能每拍都把整个项目扫一遍。
  const files = scanOutput(outputDir, { maxFiles: 2000 });
  const newest = files.reduce((n, f) => {
    try { return Math.max(n, fs.statSync(f.abs).mtimeMs); } catch { return n; }
  }, 0);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  return `${files.length}:${bytes}:${Math.round(newest)}`;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 越界审计（C1）：这个席位带 --dangerously-bypass-approvals-and-sandbox，能改整台机器。
// 任务只说「产物写 output」，它却顺手改过 scripts/cli/doubao-cli-bridge.mjs（T-a4d59e96）。
// 拦不住（沙箱已经绕过了），但必须留痕：开工前拍一次 src/scripts/config 的指纹，收工比对。
// 只在「改动被看见」这一层做文章 —— 不阻断、不自动回滚，免得把正当的基建修复也误杀。
const GUARDED_DIRS = ['src', 'scripts', 'config'];

function snapshotGuarded(root) {
  const snap = {};
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs, depth + 1); continue; }
      try {
        const st = fs.statSync(abs);
        snap[path.relative(root, abs).split(path.sep).join('/')] = `${st.size}:${Math.round(st.mtimeMs)}`;
      } catch { /* 读不到就跳过 */ }
    }
  };
  for (const dir of GUARDED_DIRS) walk(path.join(root, dir), 0);
  return snap;
}

function diffGuarded(before, after) {
  const changed = [];
  for (const [file, stamp] of Object.entries(after)) if (before[file] !== stamp) changed.push(file);
  for (const file of Object.keys(before)) if (!(file in after)) changed.push(file);
  return changed;
}

// 提示词已抽成纯函数 src/cli-prompt.js（可单测）；这里只负责喂给 CLI。
function buildPrompt(ctx, paths) {
  return buildCliPrompt(ctx, paths);
}

function fail(status, reason, extra = {}) {
  const shell = {
    schema: 'aicompany.completion/v1',
    taskId: extra.taskId ?? null, runId: extra.runId ?? null, agent: extra.agent ?? 'unknown',
    revision: extra.revision ?? 1, status, summary: reason, reason,
    artifacts: [], checksum: {}, acceptanceResults: [], usage: { quotaUnits: 0 },
    finishedAt: new Date().toISOString(),
  };
  return { status, usage: { quotaUnits: 0 }, result: shell, sessionParams: extra.sessionParams ?? null };
}

async function main() {
  const raw = readStdin();
  let ctx = {};
  try { ctx = JSON.parse(raw); } catch { /* 空 ctx 走报错分支 */ }

  const workRoot = ctx.adapterConfig?.workRoot ?? ctx.workRoot ?? null;
  const taskId = ctx.task?.taskId ?? ctx.taskId ?? null;
  const runId = ctx.runId ?? null;
  const agent = ctx.agent?.id ?? 'doubao-cli';
  const revision = ctx.task?.revision ?? 1;
  if (!workRoot || !taskId || !runId) {
    process.stdout.write(`${JSON.stringify(fail('failed', '桥接缺少 workRoot / taskId / runId：配置或调用方式不对'))}\n`);
    return;
  }
  if (!pty) {
    process.stdout.write(`${JSON.stringify(fail('failed',
      'CLI 席位缺少 node-pty：先执行 npm i node-pty（可选依赖，不计入工程运行时依赖）',
      { taskId, runId, agent, revision }))}\n`);
    return;
  }

  const paths = buildTaskPaths(workRoot, taskId);
  const taskDir = taskDirOf(workRoot, taskId);
  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.mkdirSync(paths.changeRequestsDir, { recursive: true });

  writeDispatchReceipt({ workRoot, taskId, runId, agentId: agent, via: 'cli' });
  // 开工前拍一次「不该被碰的目录」指纹（越界审计，见 GUARDED_DIRS）。
  const guardBefore = snapshotGuarded(PROJECT_ROOT);

  const prompt = buildPrompt(ctx, paths);
  const maxMinutes = Number(ctx.adapterConfig?.maxMinutes ?? 60);
  const effort = String(ctx.adapterConfig?.effort ?? 'low');
  const extraArgs = ['--json', '--effort', effort];
  // 本机沙箱 SDK 起不来（非交互模式无法提权），只能显式绕过；这是接入当前版本的必要条件。
  if (ctx.adapterConfig?.bypassSandbox !== false) extraArgs.push('--dangerously-bypass-approvals-and-sandbox');

  // node-pty 在 Windows 上不解析裸命令名，必须给 node.exe 绝对路径。
  const nodeExe = process.env.AICOMPANY_NODE || process.execPath;
  const child = pty.spawn(nodeExe, [RUN_CJS, '-p', prompt, ...extraArgs], {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: taskDir,
    env: process.env,
    // 本机 conpty 启动失败（Cannot launch conpty）：退回 node-pty 自带的 winpty 后端。
    // 它自己分配隐藏 console，不依赖父进程有没有终端 —— 正是我们要的。
    useConpty: false,
  });

  let stdout = '';
  let stderr = '';
  let result = null;
  let sessionId = null;
  let lastDigest = null;
  let changeRequestHit = null;
  let blockedHit = null;
  // 本轮开工时刻：只认这之后写的 stop.json（上一轮的残留不能拿来误杀这一趟）。
  const runStartedMs = Date.now();
  let stopped = null;
  // 越界硬拦截（C1）：这个席位带 bypass 参数，能改整台机器。发现它动了 src/scripts/config
  // 就立刻掐断这一趟（不是等交活时再事后留痕）——上次它顺手改过桥接脚本本身（T-a4d59e96）。
  let guardTrip = null;
  const stopChild = () => {
    try { child.kill(); } catch { /* ignore */ }
    try { if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  };

  // 产出心跳同时盯 output/ 和项目落点：产物现在直接写项目目录，
  // 只盯 output/ 会把「正在项目目录里正常产出」误判成停摆。
  const writeDir = ctx.project?.writeDir ? String(ctx.project.writeDir) : null;
  const sample = () => {
    try {
      const base = digestOf(paths.outputDir);
      return writeDir ? `${base}|${digestOf(writeDir)}` : base;
    } catch { return null; }
  };
  lastDigest = sample();

  // 终端原始输出落盘（2026-11-25：子卡在 CLI 上跑满 60 分钟零产物，而 stdout 只留在内存里，
  // 事后完全看不到 CLI 卡在哪一步。这一行是给「下次卡住」留的现场：tasks/<taskId>/cli-raw.log）。
  const rawLog = path.join(taskDir, 'cli-raw.log');
  try { if (fs.statSync(rawLog).size > 20 * 1024 * 1024) fs.writeFileSync(rawLog, ''); } catch { /* 首次运行没有这个文件 */ }
  // 2026-11-25 真机，这是「CLI 席位唤不醒」的真凶：
  //   豆包 CLI 发现新版本（2.37.2 → 2.38.2），启动第一屏就问「是否现在更新？[Y/N]」。
  //   pty 里没有人按键，它就原地死等 —— 进程活着、心跳照跳、一个文件不写，跑满 maxMinutes 被掐。
  //   这里自动答 N：本趟正在干活，升级会重启 CLI 把这一趟丢掉；升级交给人另找时间做。
  let updateAnswered = 0;
  child.onData((data) => {
    try { fs.appendFileSync(rawLog, data); } catch { /* 落盘失败不影响干活 */ }
    stdout += data;
    const clean0 = String(data).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    if (updateAnswered < 2 && (/是否现在更新|\[Y\/N\]|Update now/i.test(clean0))) {
      updateAnswered += 1;
      try { child.write('N\r'); } catch { /* 写不进去就靠 MAX 兜住 */ }
    }
    // 去掉 ANSI 转义后逐行找结果；其余是 [cli-chat] 日志，忽略即可。
    const clean = String(data).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
    for (const line of clean.split(/\n/)) {
      const text = line.trim();
      if (!text.startsWith('{')) continue;
      try {
        const obj = JSON.parse(text);
        if (obj.type === 'result') { result = obj; sessionId = obj.session_id ?? sessionId; }
      } catch { /* 非完整 JSON 行 */ }
    }
  });

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;    // 停手信号：人取消 / 强制重派时控制面落 stop.json。看到了就真的掐断 CLI，
    // 否则它会把活干完、交回结果又被「已判死」丢掉，新那一趟永远等不到回执（T-a4d59e96）。
    try {
      const st = fs.statSync(path.join(taskDir, 'stop.json'));
      if (st.size > 0 && st.mtimeMs >= runStartedMs) {
        stopped = JSON.parse(fs.readFileSync(path.join(taskDir, 'stop.json'), 'utf8')) || { reason: '任务已停止' };
        stopChild();
        return;
      }
    } catch { /* 没有停手信号 */ }
    // 越界检测：每拍比一次指纹，动了不该动的目录就直接掐断。
    if (!guardTrip) {
      let changed = [];
      try { changed = diffGuarded(guardBefore, snapshotGuarded(PROJECT_ROOT)); } catch { changed = []; }
      if (changed.length) {
        guardTrip = { files: changed.slice(0, 80) };
        stopChild();
        return;
      }
    }
    const digest = sample();
    if (lastDigest !== null && digest !== lastDigest && digest !== '0:0:0') {
      writeRunProgress({ workRoot, taskId, runId, polls: tick, digest });
    }
    lastDigest = digest;
    // 适配器心跳（每 6 拍 ≈ 30 秒一次）：证明这一趟的机器还活着。
    // 缺了它，证据看门狗会以为「连心跳都没有」，沉默检测（no_progress）就永远不触发。
    if (tick % 6 === 0) {
      writeRunHeartbeat({ workRoot, taskId, runId, polls: tick, note: null });
    }
    // 中途信号：change-requests 里出现 needsDecision，或写了 blocked.json —— 都不必等它跑完。
    try {
      for (const f of fs.readdirSync(paths.changeRequestsDir)) {
        if (!f.endsWith('.json')) continue;
        const data = JSON.parse(fs.readFileSync(path.join(paths.changeRequestsDir, f), 'utf8'));
        if (data?.severity === 'needsDecision') { changeRequestHit = { data, file: f }; break; }
      }
    } catch { /* 目录还不存在 */ }
    try {
      const st = fs.statSync(path.join(taskDir, 'blocked.json'));
      if (st.size > 0) blockedHit = JSON.parse(fs.readFileSync(path.join(taskDir, 'blocked.json'), 'utf8'));
    } catch { /* 没有 */ }
  }, 5_000);

  const killer = setTimeout(stopChild, maxMinutes * 60_000);

  const code = await new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
  clearInterval(timer);
  clearTimeout(killer);

  const base = { taskId, runId, agent, revision, sessionParams: { sessionId, via: 'cli', exitCode: code } };

  // ---- 收工：越界审计 + 停手判定 ----
  const guardAfter = snapshotGuarded(PROJECT_ROOT);
  const outOfScope = guardTrip ? guardTrip.files : diffGuarded(guardBefore, guardAfter);
  if (outOfScope.length) {
    try {
      fs.writeFileSync(path.join(taskDir, 'out-of-scope.json'),
        JSON.stringify({ files: outOfScope.slice(0, 80), at: new Date().toISOString() }, null, 2));
    } catch { /* 留痕失败不影响交付 */ }
  }
  // 越界优先：这一趟已经被掐断，交上位去定，绝不按「完成」交卷。
  if (guardTrip) {
    return fail('failed',
      `任务期间 src/scripts/config 出现改动：动了 ${guardTrip.files.slice(0, 6).join(', ')}。` +
      '已掐断这一趟并记 out-of-scope.json。注意：控制面维护时人/助手也会同时改代码，未必是本席位所为，由上级核对。',
      base);
  }
  const outScopeNote = outOfScope.length
    ? `　⚠ 越界改动 ${outOfScope.length} 个非任务目录文件（${outOfScope.slice(0, 4).join(', ')}），已记 out-of-scope.json`
    : '';
  const withNote = (text) => `${text}${outScopeNote}`;

  // 人叫停了这一趟（取消 / 强制重派）：如实交回「已停手」，让引擎留档，不装成功。
  if (stopped) {
    return fail('failed', withNote(`已按要求停手：${String(stopped.reason ?? '任务被取消或重派')}`), base);
  }

  if (changeRequestHit) {
    return {
      status: 'change_requested',
      usage: { quotaUnits: 1 },
      result: changeRequestHit.data,
      sessionParams: { ...base.sessionParams, changeRequestFile: changeRequestHit.file },
    };
  }
  if (blockedHit) {
    return fail('blocked', `席位停手：${String(blockedHit.reason ?? '写了 blocked.json')}`, {
      ...base, sessionParams: { ...base.sessionParams, blockedNeed: blockedHit.need ?? null },
    });
  }
  if (result?.is_error) {
    return fail('failed', `CLI 执行报错：${String(result.result?.content ?? result.errors?.join(';') ?? '未知').slice(0, 300)}`, base);
  }

  // 优先吃 agent 自己写的 draft；它没写就看 output 里有没有真东西。
  const draft = buildCompletionFromDraft({
    paths, taskId, runId, agent, revision, writeDir, now: () => new Date().toISOString(),
  });
  if (draft.ok) {
    draft.report.summary = withNote(String(draft.report.summary ?? ''));
    writeCompletion(paths, draft.report);
    return {
      status: 'success', usage: draft.report.usage ?? { quotaUnits: 1 },
      result: draft.report,
      sessionParams: { ...base.sessionParams, reportSource: 'cli-draft', files: draft.files.map((f) => f.artifact) },
    };
  }

  const files = scanOutput(paths.outputDir);
  if (files.length) {
    const checksum = {};
    for (const f of files) checksum[f.name] = sha256File(f.abs);
    const report = {
      schema: 'aicompany.completion/v1', taskId, runId, agent, revision,
      status: 'success',
      summary: withNote(String(result?.result?.content ?? 'CLI 席位产出了文件').slice(0, 200)),
      artifacts: files.map((f) => f.name), checksum,
      acceptanceResults: [{
        rule: '控制面核实：产物真实存在且非空',
        pass: true,
        detail: `${files.length} 个文件，共 ${files.reduce((n, f) => n + f.size, 0)} 字节`,
      }],
      usage: { quotaUnits: 1 },
      finishedAt: new Date().toISOString(),
    };
    writeCompletion(paths, report);
    return {
      status: 'success', usage: { quotaUnits: 1 }, result: report,
      sessionParams: { ...base.sessionParams, reportSource: 'cli-artifacts' },
    };
  }

  return fail('failed',
    `CLI 跑完但没有可用产物（draft: ${draft.kind ?? 'none'}${draft.reason ? `：${String(draft.reason).slice(0, 200)}` : ''}，exit=${code}，${String(stderr).slice(0, 120)}）`,
    base);
}

const out = await main();
// adapter 取「最后一行可解析 JSON」当本轮结果。执行席位的 result 必须是完整的
// CompletionReport；若照旧把 {status, usage, result, sessionParams} 信封整体抛出去，
// 引擎 handleResult 会把信封当报告校验，报「缺 schema/taskId/runId…」整份打回（T-a4d59e96）。
// 所以信封里 result 已是完成报告时，最后一行只吐报告本身；其余形态（change_requested 等）
// 仍吐信封，保持原语义。
const last = out?.result?.schema === 'aicompany.completion/v1' ? out.result : out;
process.stdout.write(`${JSON.stringify(last)}\n`);
process.exit(0);
