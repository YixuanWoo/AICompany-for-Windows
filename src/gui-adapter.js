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
import {
  buildTaskPaths, writeTaskBundle, pollForReport,
  buildCompletionFromDraft, writeCompletion, DRAFT_REPORT_NAME,
} from './gui-report.js';
import {
  createGuiDriver, assertForeground, captureScreenshot, GuiError,
} from './gui-driver.js';

export const GUI_ENV_KEYS = Object.freeze([
  'workRoot', 'windowTitle', 'steps', 'driver',
]);

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
      const rendered = renderPrompt({ task: { ...(ctx.task ?? {}), taskId }, paths, config });
      const steps = normalizeSteps(config);
      writeTaskBundle(paths, { task: { ...(ctx.task ?? {}), taskId, runId }, prompt: rendered.prompt });

      const focusOptions = { match: config.windowTitleMatch ?? 'exact' };
      const first = steps[0];
      // 「启动前」焦点校验只在不需要激活时做：如果第一步就是 activate，窗口本来就还没到前台，
      // 这时要求它已在前台，等于永远发不出去（真实 GUI 上必踩）。
      if (first?.action !== 'activate') {
        await assertForeground(driver, config.windowTitle, '启动前', focusOptions);
      }
      let sent = false;
      const pause = options.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
      for (const step of steps) {
        // activate 这一步本身就是用来夺取前台，它的「前」校验没有意义；「后」校验保留（激活失败立刻中止）。
        // restoreFocus 正相反：它就是要离开目标窗口，前后都不能校验焦点。
        const checkBefore = step.action !== 'activate' && step.action !== 'restoreFocus';
        if (checkBefore) {
          await assertForeground(driver, config.windowTitle, `${step.index}-前`, focusOptions);
        }
        if (step.action === 'activate') {
          // 激活失败多半不是「活干不了」，而是「现在抢不到前台」（你在用电脑 / 前台锁定）。
          // 归到 kind=focus 让引擎把它当「稍后再来」，而不是算成一次执行失败。
          try {
            await driver.activateWindow(config.windowTitle);
          } catch (error) {
            throw new GuiError('focus', `窗口激活失败：${String(error.message ?? error)}`);
          }
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
        if (step.action === 'hotkey') await driver.hotkey(step.keys);
        if (step.action === 'paste') {
          clipboardTouched = true;
          await driver.setClipboard(rendered.prompt);
          if (driver.clipboard !== rendered.prompt) {
            throw new GuiError('clipboard', '剪贴板内容与提示词长度/内容不一致，拒绝发送');
          }
          await driver.paste();
        }
        if (step.action === 'press') {
          await driver.press(step.key);
          if (!sent) {
            sent = true;
            await driver.send({ taskId, runId, paths, prompt: rendered.prompt, config, ctx });
          }
        }
        if (step.action === 'restoreFocus') {
          const out = await driver.restoreFocus();
          sessionParams.focusRestored = out ?? 'not-configured';
          continue;
        }
        await assertForeground(driver, config.windowTitle, `${step.index}-后`, focusOptions);
      }

      // 提示词已经发出去了，立刻把剪贴板还给你；轮询产物是纯读文件，不占用键鼠。
      sessionParams.clipboard = await restoreClipboard();

      const polled = await pollForReport({
        paths, config, taskId, runId,
        wait: options.wait, maxPolls: options.maxPolls ?? config.maxPolls,
        now: options.now ?? nowIso,
      });
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
