// P3：`gui-template` 通用型 adapter（§6B.6 五通用型之一 / §8.3 GUI 可靠性设计）。
// 组装顺序：环境检查 → 全局互斥锁 → 落任务包 → 渲染提示词 → 逐步焦点校验 → 发指令
//          → 轮询文件（先看变更请求）→ 校验报告 → 回收；任何异常都截图留证并释放锁。
// 源码零产品名、零写死窗口标题 / 快捷键 / 按键；全部来自 ctx.adapterConfig。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowIso } from './ids.js';
import { createGuiLock } from './gui-lock.js';
import { evaluateGate } from './gui-gate.js';
import { renderPrompt, normalizeSteps, assertPromptComplete } from './gui-prompt.js';
import { seatBriefing, delegationBriefing, taskIntakeBriefing } from './org-chart.js';
import {
  buildTaskPaths, writeTaskBundle, pollForReport,
  buildCompletionFromDraft, writeCompletion, DRAFT_REPORT_NAME,
} from './gui-report.js';
import {
  createGuiDriver, assertForeground, waitForeground, captureScreenshot, GuiError,
} from './gui-driver.js';
// 证据层：启动回执与轮询心跳。GUI 是「聊天窗口型」席位，agent 未必写得出结构化文件，
// 所以「已启动」这一级必须由 adapter 自己写，不能靠 agent 自报。
import { writeDispatchReceipt, writeRunHeartbeat, writeRunProgress, ensureAckTemplate, readStopSignal } from './evidence.js';

export const GUI_ENV_KEYS = Object.freeze([
  'workRoot', 'windowTitle', 'steps', 'driver',
]);

// P1（2026-11-23）：产物 digest —— 只回答一件事：「任务目录里真的长东西了吗」。
// 采样成本只是几次 stat（轮询本来每 5 秒一次），不读文件内容、不截图、不碰窗口。
function sampleOutputDigest(outputDir, { maxFiles = 2000 } = {}) {
  let count = 0;
  let bytes = 0;
  let newest = 0;
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || seen >= maxFiles) return; // 项目目录可能很大：心跳只采样，不扫爆磁盘
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
        count += 1;
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* 文件刚被删 / 被占用，跳过 */ }
    }
  };
  walk(outputDir, 0);
  return `${count}:${bytes}:${Math.round(newest)}`;
}

function completionShell(ctx, status, reason, extra = {}) {
  return {
    schema: 'aicompany.completion/v1',
    taskId: ctx.taskId ?? ctx.task?.taskId ?? 'T-unknown',
    runId: ctx.runId ?? 'R-unknown',
    agent: ctx.agent?.id ?? 'unknown',
    revision: ctx.task?.revision ?? 1,
    status,
    summary: reason,
    artifacts: [], checksum: {}, acceptanceResults: [],
    usage: { quotaUnits: 0 },
    finishedAt: nowIso(),
    ...(reason ? { reason } : {}),
    ...extra,
  };
}

// sessionParams 是「给控制面看的运行参数」，不是完成报告的一部分。
// 混进 result 会被 completion schema 判成多余字段，把真正的失败原因覆盖掉（真实 GUI 上踩过）。
function splitExtra(extra = {}) {
  const { sessionParams, ...reportExtra } = extra ?? {};
  return { sessionParams: sessionParams ?? {}, reportExtra };
}

// 开新会话之后怎么确认「真的开了」：窗口标题回到「纯产品名」才算数
// （进了会话标题会变成「会话名 - 产品名」）。这是防错信号，不是完成判据——
// 任务是否完成仍然只认磁盘文件。核对不上不硬闯：默认照旧发，但打上 reused 标记。
async function openFreshSession(driver, config, pause) {
  const expect = String(config.freshTitle ?? config.windowTitle ?? '');
  const attempts = Math.max(1, Number(config.newSessionAttempts ?? 2));
  const polls = Math.max(1, Number(config.newSessionPolls ?? 3));
  const intervalMs = Math.max(0, Number(config.newSessionPollMs ?? 300));
  let title = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await driver.newSession();
    for (let i = 0; i < polls; i += 1) {
      if (intervalMs) await pause(intervalMs);
      title = await driver.foregroundTitle();
      if (title === expect) return { fresh: true, attempts: attempt, title };
    }
  }
  return { fresh: false, attempts, title };
}

const failed = (ctx, reason, extra) => {
  const { sessionParams, reportExtra } = splitExtra(extra);
  return {
    status: 'failed', result: completionShell(ctx, 'failed', reason, reportExtra),
    usage: { quotaUnits: 0 }, sessionParams: { blockedReason: reason, ...sessionParams },
  };
};

const blocked = (ctx, reason, extra) => {
  const { sessionParams, reportExtra } = splitExtra(extra);
  return {
    status: 'blocked', result: completionShell(ctx, 'blocked', reason, reportExtra),
    usage: { quotaUnits: 0 }, sessionParams: { blockedReason: reason, ...sessionParams },
  };
};

// 暂停开关落地形式：一个 JSON 文件。**内容坏掉不算暂停** —— 否则文件一坏，
// GUI 席位就永久停摆，还得人工去删文件才知道。
export function readPauseFlag(pauseFile) {
  if (!pauseFile) return { paused: false, at: null, reason: '', file: null };
  try {
    if (!fs.existsSync(pauseFile)) return { paused: false, at: null, reason: '', file: pauseFile };
    const raw = JSON.parse(fs.readFileSync(pauseFile, 'utf8'));
    return {
      paused: raw?.paused !== false,
      at: raw?.at ?? null,
      reason: raw?.reason ?? '',
      file: pauseFile,
    };
  } catch {
    return { paused: false, at: null, reason: '', file: pauseFile };
  }
}

export function writePauseFlag(pauseFile, { paused = true, reason = '', now = new Date() } = {}) {
  if (!pauseFile) throw new Error('未配置暂停开关文件（gui.gate.pauseFile）');
  fs.mkdirSync(path.dirname(pauseFile), { recursive: true });
  fs.writeFileSync(pauseFile, `${JSON.stringify({
    paused: Boolean(paused), at: now.toISOString(), reason,
  }, null, 2)}\n`, 'utf8');
  return readPauseFlag(pauseFile);
}

export function createGuiAdapter(options = {}) {
  // 锁按 lockPath 分实例缓存：同一进程里可以有「演示席位」和「真实席位」两套配置，
  // 但它们只要指向同一个 lockPath，就还是同一把跨进程锁（这才是 GUI 不能并发的真约束）。
  const lockCache = new Map();
  function lockFor(config = {}) {
    if (options.lock) return options.lock;
    const lockPath = options.lockPath ?? config.lockPath ?? null;
    const key = lockPath ?? '';
    if (!lockCache.has(key)) lockCache.set(key, createGuiLock({ lockPath, now: options.now }));
    return lockCache.get(key);
  }
  const lock = lockFor({});

  function testEnvironment(config = {}) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    const workRoot = config.workRoot ?? options.workRoot;

    let rootOk = false;
    try {
      rootOk = Boolean(workRoot) && fs.existsSync(workRoot)
        && fs.statSync(workRoot).isDirectory() && (() => {
          try { fs.accessSync(workRoot, fs.constants.W_OK); return true; } catch { return false; }
        })();
    } catch { rootOk = false; }
    add('任务根目录存在且可写', rootOk, workRoot ?? '未配置 workRoot');

    const title = config.windowTitle;
    add('目标窗口标题由配置给出', typeof title === 'string' && title.trim().length > 0, title ?? '未配置 windowTitle');

    let steps = [];
    try { steps = normalizeSteps(config); add('操作步骤由配置给出', true, `${steps.length} 步`); } catch (error) {
      add('操作步骤由配置给出', false, error.message);
    }
    const driverKind = config.driver ?? 'simulation';
    const driverOk = ['simulation', 'command'].includes(driverKind)
      && (driverKind !== 'command' || Boolean(config.commands?.activate && config.commands?.foregroundTitle));
    add('GUI 驱动配置齐全', driverOk, driverKind);

    let promptOk = true;
    let promptDetail = '默认模板';
    try {
      const probePaths = workRoot
        ? buildTaskPaths(workRoot, 'T-probe', config)
        : {
          inputDir: 'x/input', outputDir: 'x/output', reportPath: 'x/completion.json',
          changeRequestsDir: 'x/change-requests',
        };
      const probe = renderPrompt({
        task: { taskId: 'T-probe', instructions: 'probe', acceptance: ['probe'] },
        paths: probePaths, config,
      });
      promptOk = assertPromptComplete(probe.prompt, probe.values).ok;
      if (config.promptTemplate) promptDetail = '自定义模板已过槽位校验';
    } catch (error) { promptOk = false; promptDetail = error.message; }
    add('提示词模板含全部必备槽位', promptOk, promptDetail);

    const held = lockFor(config).isHeld();
    add('无其它任务占用 GUI', held === null, held ? `正被 ${held} 占用` : '空闲');

    const errors = checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail}`);
    return {
      ok: errors.length === 0,
      detail: errors.length ? errors.join('；') : `${checks.length} 项环境检查通过`,
      checks,
    };
  }

  async function execute(ctx) {
    const config = { ...(options.config ?? {}), ...(ctx.adapterConfig ?? {}) };
    const taskId = ctx.taskId ?? ctx.task?.taskId;
    const runId = ctx.runId ?? `R-${taskId ?? 'unknown'}`;
    const retry = { max: 2, backoffSec: 0, ...(config.retry ?? {}) };
    const sessionParams = { retry, guiLock: lockFor(config).mode, driver: config.driver ?? 'simulation' };

    let paths;
    try { paths = buildTaskPaths(config.workRoot ?? options.workRoot, taskId, config); } catch (error) {
      return failed(ctx, `任务目录不合法：${error.message}`);
    }
    const env = testEnvironment(config);
    if (!env.ok) return blocked(ctx, `testEnvironment 未通过：${env.detail}`, { sessionParams });

    const driver = options.driver ?? createGuiDriver(config);

    // ---- 闸门：先问「现在该不该抢键鼠」，再决定动不动作 ----
    // 探测失败不拦（宁可放过，也不要因为读不到空闲时长让活永久派不出去）。
    const gateConfig = config.gate ?? {};
    const clipBackFile = path.join(os.tmpdir(), `aicompany-clipback-${runId}.txt`);
    let pre = null;
    try {
      pre = await driver.preflight?.({ clipboardFile: clipBackFile }) ?? null;
      if (pre) {
        sessionParams.idleSec = pre.idleSec;
        sessionParams.locked = pre.locked;
        sessionParams.clipChars = pre.clipChars;
      }
    } catch (error) {
      sessionParams.preflightError = String(error.message ?? error);
    }
    const pauseFlag = readPauseFlag(gateConfig.pauseFile);
    const gate = evaluateGate({
      paused: pauseFlag.paused,
      pausedAt: pauseFlag.at,
      pauseReason: pauseFlag.reason,
      now: options.clockNow?.() ?? new Date(),
      allowedHours: gateConfig.allowedHours ?? null,
      locked: pre?.locked ?? null,
      idleSec: pre?.idleSec ?? null,
      requireIdleSec: Number(gateConfig.requireIdleSec ?? 0),
      requireUnlocked: Boolean(gateConfig.requireUnlocked),
    });
    if (!gate.ok) {
      return blocked(ctx, `GUI 闸门拦下：${gate.reason}`, {
        sessionParams: { ...sessionParams, gate: gate.code, gateChecks: gate.checked },
      });
    }

    const got = lockFor(config).acquire(runId);
    if (!got.ok) return blocked(ctx, got.reason, { sessionParams });

    let screenshot = null;
    let clipboardTouched = false;
    // 发完把剪贴板还回去：提示词几百字，把你正在复制的东西顶掉就是硬伤。
    // 只在真的改过剪贴板、且原内容非空时才还原（不能把空剪贴板"还原"成空，那等于又清一次）。
    let clipboardState = 'not-needed';
    async function restoreClipboard() {
      if (!clipboardTouched) { clipboardState = 'not-needed'; return clipboardState; }
      if (config.restoreClipboard === false) { clipboardState = 'disabled'; return clipboardState; }
      if (!pre || !(pre.clipChars > 0) || !fs.existsSync(clipBackFile)) {
        clipboardState = 'nothing-to-restore'; return clipboardState;
      }
      try {
        const original = fs.readFileSync(clipBackFile, 'utf8');
        await driver.setClipboard(original);
        clipboardState = 'restored';
      } catch (error) {
        clipboardState = `failed: ${String(error.message ?? error)}`;
      }
      return clipboardState;
    }

    try {
      const rendered = renderPrompt({
        task: { ...(ctx.task ?? {}), taskId }, paths, config,
        // P7：项目规范 + 最近经验拼在硬性要求之前；没项目时是空串。
        projectContext: ctx.project?.contextText ?? '',
        project: ctx.project ?? null,
      });
      const steps = normalizeSteps(config);
      // 身份必须在模板前面：模板只讲「写什么文件、写到哪儿」，谁都能用；
      // 「你是谁、谁是你上级、你能派给谁、什么不许自己干、上级给了做法要不要照抄」只能来自配置。
      // 以前只有 webhook-exec 席位注入这段，GUI 席位拿到的是光秃秃的「你是执行席位」，
      // 工程岗据此把实现活全自己干了（2026-11-17 真机复现）。
      // 现在统一由引擎算好塞进 ctx.briefing（一种来源、所有 adapter 共享）；
      // 这里保留自拼回退，只为让直接构造 ctx 的测试与单点调试仍然成立。
      const roster = { agents: ctx.company?.agents ?? [] };
      const header = ctx.briefing ?? [
        seatBriefing(roster, ctx.agent?.id, { repos: ctx.repos ?? null, artifacts: ctx.artifacts ?? null }),
        taskIntakeBriefing(roster, ctx.agent?.id, { task: ctx.task ?? null, artifacts: ctx.artifacts ?? null }),
        delegationBriefing(roster, ctx.agent?.id, { workRoot: ctx.workRoot ?? null }),
      ].filter(Boolean).join('\n\n');
      const prompt = header ? `${header}\n\n───\n\n${rendered.prompt}` : rendered.prompt;
      writeTaskBundle(paths, { task: { ...(ctx.task ?? {}), taskId, runId }, prompt });
      // 预置回执模板：agent 只需改一行字，不用写 JSON；没改也不判死（引擎只减耐心）。
      ensureAckTemplate({
        workRoot: config.workRoot ?? options.workRoot, taskId, runId,
        agentId: ctx.agent?.id ?? ctx.agentId ?? null,
      });

      const focusOptions = {
        match: config.windowTitleMatch ?? 'exact',
        // 部分桌面客户端标题会随会话名变，配了进程名就按进程认前台。
        process: config.windowProcess ?? null,
      };
      // 「动作之间等一会儿」：操作系统切前台、桌面客户端重绘、输入法上屏都要时间。
      // 真机踩过两件事：① 刚 activate 完立刻 hotkey，键打进了上一个窗口；
      // ② 激活慢半拍就被紧跟的焦点校验判失焦 → 整趟 deferred，人看到的就是「GUI 没起来」。
      // 默认 command 驱动：每步之间 1.2 秒、激活后 6 秒观察窗；simulation 保持 0（测试不该被拖慢）。
      const isSim = (config.driver ?? 'simulation') === 'simulation';
      const settleMs = Number(config.settleMs ?? (isSim ? 0 : 1200));
      const focusTimeoutMs = Number(config.focusTimeoutMs ?? (isSim ? 0 : 6000));
      const focusIntervalMs = Math.max(100, Number(config.focusPollMs ?? 500));
      const pause = options.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
      const settle = async () => { if (settleMs > 0) await pause(settleMs); };
      const focusWait = { ...focusOptions, timeoutMs: focusTimeoutMs, intervalMs: focusIntervalMs, pause };
      const first = steps[0];
      // 「启动前」焦点校验只在不需要激活时做：如果第一步就是 activate，窗口本来就还没到前台，
      // 这时要求它已在前台，等于永远发不出去（真实 GUI 上必踩）。
      if (first?.action !== 'activate') {
        await waitForeground(driver, config.windowTitle, '启动前', focusWait);
      }
      let sent = false;
      for (const step of steps) {
        // activate 这一步本身就是用来夺取前台，它的「前」校验没有意义；「后」校验保留（激活失败立刻中止）。
        // restoreFocus 正相反：它就是要离开目标窗口，前后都不能校验焦点。
        const checkBefore = step.action !== 'activate' && step.action !== 'restoreFocus';
        if (checkBefore) {
          await waitForeground(driver, config.windowTitle, `${step.index}-前`, focusWait);
        }
        if (step.action === 'activate') {
          // 激活失败多半不是「活干不了」，而是「现在抢不到前台」（你在用电脑 / 前台锁定）。
          // 归到 kind=focus 让引擎把它当「稍后再来」，而不是算成一次执行失败。
          try {
            await driver.activateWindow(config.windowTitle);
          } catch (error) {
            throw new GuiError('focus', `窗口激活失败：${String(error.message ?? error)}`);
          }
          // 激活是异步的：先让系统真的把窗口提到前台，再往下按快捷键 / 粘贴。
          await settle();
        }
        if (step.action === 'newSession') {
          const opened = await openFreshSession(driver, config, pause);
          sessionParams.session = opened.fresh ? 'fresh' : 'reused';
          sessionParams.sessionAttempts = opened.attempts;
          sessionParams.sessionTitle = opened.title ?? null;
          if (!opened.fresh && config.onNewSessionMismatch === 'blocked') {
            throw new GuiError('session', `连开 ${opened.attempts} 次新会话，标题仍是「${opened.title ?? '未知/读不到'}」，拒绝在旧会话里发（上下文会串）`);
          }
        }
        if (step.action === 'hotkey') { await driver.hotkey(step.keys); await settle(); }
        // 聚焦输入框：唤醒后光标不一定在输入框里（应用还停在首页 / 上次的怪窗口尺寸），
        // 不点这一下，粘贴会落空，引擎却会以为发出去了。
        if (step.action === 'focusInput') {
          try {
            sessionParams.focusInput = await driver.focusInput();
          } catch (error) {
            throw new GuiError('focus', `输入框聚焦失败：${String(error.message ?? error)}`);
          }
          await settle();
        }
        if (step.action === 'paste') {
          clipboardTouched = true;
          await driver.setClipboard(prompt);
          if (driver.clipboard !== prompt) {
            throw new GuiError('clipboard', '剪贴板内容与提示词长度/内容不一致，拒绝发送');
          }
          await driver.paste();
          await settle();
        }
        if (step.action === 'press') {
          await driver.press(step.key);
          if (!sent) {
            sent = true;
            await driver.send({ taskId, runId, paths, prompt, config, ctx });
            // L1 的硬凭据：直到这一步才算「真的送出去了」。写失败也不阻断（引擎会按未确认处理）。
            writeDispatchReceipt({
              workRoot: config.workRoot ?? options.workRoot, taskId, runId,
              agentId: ctx.agent?.id ?? ctx.agentId ?? null,
              via: 'gui', windowTitle: config.windowTitle ?? null,
            });
          }
          await settle();
        }
        if (step.action === 'restoreFocus') {
          const out = await driver.restoreFocus();
          sessionParams.focusRestored = out ?? 'not-configured';
          continue;
        }
        await waitForeground(driver, config.windowTitle, `${step.index}-后`, focusWait);
      }

      // 提示词已经发出去了，立刻把剪贴板还给你；轮询产物是纯读文件，不占用键鼠。
      sessionParams.clipboard = await restoreClipboard();

      // 验收轮和干活轮的时限分开：验收 30 分钟、执行 60 分钟（董事会口径）。
      // 只在有 reviewMaxMinutes 时才切，老配置行为不变。
      const effectiveMaxMinutes = (ctx.review === true || ctx.review?.asReviewer === true)
        && config.reviewMaxMinutes
        ? Number(config.reviewMaxMinutes) : config.maxMinutes;
      const heartbeatEveryPolls = Math.max(1, Number(config.heartbeatEveryPolls ?? 6));
      // P1（2026-11-23）：每次轮询都采样产物 digest，只有真的变了才写产出心跳。
      // run-heartbeat 继续每 N 轮写一次，但它只代表「适配器还在轮询」；
      // 看门狗判「有没有在产出」只认这份 run-progress.json。
      let lastDigest = null;
      // 本轮开工时刻：只认这之后写的 stop.json，避免吃掉上一轮残留把人刚派的活误杀。
      const runStartedMs = Number(options.runStartedMs ?? Date.now());
      const onPoll = ({ index, progressSeen }) => {
        // 停手信号：人取消了卡、或点了强制重派，控制面会落 stop.json。
        // GUI 没法真的掐断人的窗口，但至少能立刻停手，不再往下贴提示词、不再抢前台。
        const stop = readStopSignal({ workRoot: config.workRoot ?? options.workRoot, taskId, since: runStartedMs });
        if (stop) throw new GuiError('stopped', `人让这一趟停手：${String(stop.reason ?? '已取消或已重派')}`);
        // 产出心跳也要看项目落点：产物现在直接写项目目录，output/ 可能一直不变，
        // 只看 output/ 会把「正在项目目录里正常产出」误判成停摆。
        const writeDir = ctx.project?.writeDir ?? null;
        const digest = writeDir && path.resolve(writeDir) !== path.resolve(paths.outputDir)
          ? `${sampleOutputDigest(paths.outputDir)}|${sampleOutputDigest(writeDir)}`
          : sampleOutputDigest(paths.outputDir);
        if (lastDigest !== null && digest !== lastDigest && digest !== '0:0:0') {
          writeRunProgress({
            workRoot: config.workRoot ?? options.workRoot, taskId, runId,
            polls: index, digest,
          });
        }
        lastDigest = digest;
        if (index % heartbeatEveryPolls !== 0) return;
        writeRunHeartbeat({
          workRoot: config.workRoot ?? options.workRoot, taskId, runId,
          polls: index, note: progressSeen ? 'progress-present' : null,
        });
      };
      let polled = await pollForReport({
        paths, config: { ...config, maxMinutes: effectiveMaxMinutes }, taskId, runId,
        wait: options.wait, maxPolls: options.maxPolls ?? config.maxPolls,
        now: options.now ?? nowIso, onPoll,
        writeDir: ctx.project?.writeDir ?? null,
      });
      // P2-3（2026-11-23）：跑满预算没交报告，但写了 partial.md（推进说明 + 阻塞点）时，
      // 说明它在稳步做、只是没到终点 —— 再给一段补交窗口，不一刀切判失败。
      // 只延一次，且只认 30 分钟内写的 partial.md，避免吃上一轮的残留。
      if (polled.kind === 'timeout') {
        const partialFile = path.join(paths.taskDir, 'partial.md');
        let st = null;
        try { st = fs.statSync(partialFile); } catch { st = null; }
        const freshPartial = st && st.size > 0 && (Date.now() - st.mtimeMs) < 30 * 60_000;
        if (freshPartial) {
          sessionParams.partialExtended = true;
          polled = await pollForReport({
            paths,
            config: { ...config, maxMinutes: Math.max(5, Math.round(Number(effectiveMaxMinutes) / 4)) },
            taskId, runId,
            wait: options.wait, maxPolls: options.maxPolls ?? config.maxPolls,
            now: options.now ?? nowIso, onPoll,
            writeDir: ctx.project?.writeDir ?? null,
          });
        }
      }
      // P2-4（2026-11-23）：席位主动写了 blocked.json —— 它自己承认做不下去。
      // 这类停手是有效的信号，别再让它空转到 60 分钟，也别当成"超时失败"。
      if (polled.kind === 'blocked') {
        const why = String(polled.data?.reason ?? '席位写了 blocked.json 但没写原因');
        screenshot = await captureScreenshot({ paths, taskId, runId, driver });
        return blocked(ctx, `席位停手：${why}`, {
          sessionParams: {
            ...sessionParams, screenshot, polls: polled.polls,
            blockedNeed: polled.data?.need ?? null,
          },
        });
      }
      if (polled.kind === 'change_request') {
        return {
          status: 'change_requested',
          result: polled.data,
          usage: { quotaUnits: 1 },
          sessionParams: { ...sessionParams, changeRequestFile: polled.file, polls: polled.polls },
        };
      }
      if (polled.kind === 'completion') {
        return {
          status: 'success', result: polled.data, usage: polled.data.usage ?? { quotaUnits: 1 },
          sessionParams: { ...sessionParams, polls: polled.polls, checksum: polled.verified.computed },
        };
      }
      if (polled.kind === 'invalid_report') {
        const reason = polled.verified
          ? `完成报告不合格：${polled.verified.errors.join('；')}`
          : `完成报告不是合法 JSON：${polled.error}`;
        screenshot = await captureScreenshot({ paths, taskId, runId, driver });
        return blocked(ctx, reason, { sessionParams: { ...sessionParams, screenshot } });
      }

      // P6：draft 模式 —— 聊天窗口型助手不会自己算校验和，只写 report.draft.json。
      // 这里由控制面扫描 output/ 生成正式报告；扫不出东西就照旧判失败，绝不放行。
      if (config.reportMode === 'draft') {
        const built = buildCompletionFromDraft({
          paths, taskId, runId,
          agent: ctx.agent?.id ?? ctx.agentId ?? 'unknown',
          revision: ctx.task?.revision ?? 1,
          writeDir: ctx.project?.writeDir ?? null,
          now: options.now ?? nowIso,
        });
        if (built.ok) {
          writeCompletion(paths, built.report);
          return {
            status: 'success',
            result: built.report,
            usage: built.report.usage,
            sessionParams: {
              ...sessionParams, polls: polled.polls,
              reportSource: 'control-plane-draft',
              files: built.files.map((f) => f.artifact),
            },
          };
        }
        screenshot = await captureScreenshot({ paths, taskId, runId, driver });
        return failed(ctx, `等了 ${polled.polls} 次仍拿不到可用产物（${built.kind}）：${built.reason}`, {
          sessionParams: {
            ...sessionParams, screenshot, polls: polled.polls,
            draftIssue: built.kind, draftFile: DRAFT_REPORT_NAME,
          },
        });
      }

      screenshot = await captureScreenshot({ paths, taskId, runId, driver });
      return failed(ctx, `等待 ${polled.polls} 次仍未收到 completion.json，按超时处理`, {
        sessionParams: { ...sessionParams, screenshot, polls: polled.polls },
      });
    } catch (error) {
      // 出错也要把剪贴板还回去：用户不该因为一次失败而丢掉自己复制的东西。
      try { sessionParams.clipboard = await restoreClipboard(); } catch { /* 还原失败不影响判定 */ }
      screenshot = await captureScreenshot({ paths, taskId, runId, driver });
      // 停手信号命中：不是失败，也不是超时 —— 这一趟被人叫停了，库里也已判死，
      // 直接把结果交回去（引擎按「已判死」留档，不推进状态）。
      if (error instanceof GuiError && error.kind === 'stopped') {
        return {
          status: 'interrupted',
          result: completionShell(ctx, 'failed', `停手：${error.message}`),
          usage: { quotaUnits: 0 },
          sessionParams: { ...sessionParams, stopped: true, stopReason: error.message },
        };
      }
      // 抢不到前台（focus）是**临时条件**：这张卡要退回排队等下次，
      // 不能算成「执行失败」——否则你在电脑前一坐，两张卡就被打成 blocked。
      if (error instanceof GuiError && error.kind === 'focus') {
        return {
          status: 'deferred',
          result: completionShell(ctx, 'blocked', `稍后再试：${error.message}`),
          usage: { quotaUnits: 0 },
          sessionParams: {
            ...sessionParams, screenshot, retryable: true,
            deferredReason: error.message, errorKind: error.kind,
          },
        };
      }
      const reason = error instanceof GuiError
        ? `${error.kind}：${error.message}`
        : `GUI 执行异常：${String(error.message ?? error)}`;
      return blocked(ctx, reason, {
        sessionParams: { ...sessionParams, screenshot, errorKind: error?.kind ?? 'unexpected' },
      });
    } finally {
      lockFor(config).release(runId);
    }
  }

  // 派活前的「准入」检查：临时条件（暂停 / 时段 / 你正在用电脑 / 锁屏）在这里拦，
  // 引擎会把卡退回 todo 等维护心跳重投，**不算失败、不扣额度、不累加重试次数**。
  async function precheck(config = {}) {
    const driver = options.driver ?? createGuiDriver(config);
    const gateConfig = config.gate ?? {};
    let pre = null;
    try { pre = (await driver.preflight?.({ clipboardFile: null })) ?? null; } catch { pre = null; }
    const pauseFlag = readPauseFlag(gateConfig.pauseFile);
    const gate = evaluateGate({
      paused: pauseFlag.paused,
      pausedAt: pauseFlag.at,
      pauseReason: pauseFlag.reason,
      now: options.clockNow?.() ?? new Date(),
      allowedHours: gateConfig.allowedHours ?? null,
      locked: pre?.locked ?? null,
      idleSec: pre?.idleSec ?? null,
      requireIdleSec: Number(gateConfig.requireIdleSec ?? 0),
      requireUnlocked: Boolean(gateConfig.requireUnlocked),
    });
    return gate.ok
      ? { ok: true, checked: gate.checked }
      : { ok: false, code: gate.code, reason: gate.reason, checked: gate.checked };
  }

  return {
    type: 'gui-template',
    // 只有 GUI 型要求「环境不过就不派活」；其它通用型保留 testEnvironment() 仅作诊断（§8.6）。
    strictEnvironment: true,
    testEnvironment,
    precheck,
    execute,
    lock,
    lockFor,
    options,
  };
}

// 默认实例：从 ctx.adapterConfig 读全部配置；测试/演示可用 createGuiAdapter 注入驱动与锁。
export const guiTemplateAdapter = createGuiAdapter();
