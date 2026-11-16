// P3-2 / P3-5：可注入的 GUI 驱动 + 截图留证。
// 默认 simulation：不激活任何真实窗口、不抢焦点、不按键，只把动作记进 trace，
// 由 onSend 回调模拟「对面那个 agent 收到提示词后把报告写到文件」。
// 真实驱动给 config.commands.* 命令模板即可，源码不写死任何窗口标题 / 快捷键 / 按键。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 1x1 透明 PNG，模拟驱动截图留证用（保证 screenshots/ 里是真文件，不是空壳）。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export class GuiError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'GuiError';
    this.kind = kind;
    this.detail = detail;
  }
}

export function createSimulationDriver({
  onSend = null, stolenTitle = null, overlay = null, initialTitle = null,
  idleSec = 999, locked = false, clipChars = 0, clipText = null,
} = {}) {
  let title = initialTitle;
  let activated = initialTitle;
  let clipboard = '';
  const trace = [];
  return {
    kind: 'simulation',
    trace,
    get clipboard() { return clipboard; },
    async activateWindow(windowTitle) { title = windowTitle; activated = windowTitle; trace.push({ action: 'activate', windowTitle }); },
    // 新会话 = 窗口标题回到「纯产品名」，真实应用正是这个表现（进了会话才会带上「 - 会话名」）。
    async newSession() { title = activated ?? title; trace.push({ action: 'newSession', title }); },
    async hotkey(keys) { trace.push({ action: 'hotkey', keys }); },
    async setClipboard(text) { clipboard = String(text ?? ''); trace.push({ action: 'clipboard', length: clipboard.length }); },
    async paste() { trace.push({ action: 'paste', length: clipboard.length }); },
    async press(key) { trace.push({ action: 'press', key }); },
    async foregroundTitle() {
      if (overlay) trace.push({ action: 'overlay', overlay });
      return overlay ?? stolenTitle ?? title;
    },
    async preflight({ clipboardFile = null } = {}) {
      // 探测不算动作：不进 trace，否则「步骤严格按配置顺序执行」的断言会被这次只读探测污染。
      if (clipChars > 0 && clipboardFile) {
        fs.writeFileSync(clipboardFile, clipText ?? 'C'.repeat(clipChars), 'utf8');
      }
      return { idleSec, locked, clipChars, clipboardFile: clipboardFile ?? null };
    },
    async restoreFocus() { trace.push({ action: 'restoreFocus' }); return 'simulated'; },
    async send(payload) { if (onSend) await onSend({ ...payload, clipboard, trace }); },
    async screenshot() { return Buffer.from(PNG_1PX, 'base64'); },
  };
}

function renderCommand(template, vars) {
  let out = String(template);
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{{${key}}}`, String(value ?? ''));
  if (/\{\{[^}]+\}\}/.test(out)) throw new Error(`GUI 命令模板有未填占位：${out}`);
  if (!out.trim()) throw new Error('GUI 命令模板为空；必须由配置显式给出');
  return out;
}

function runCommand(command, vars) {
  return new Promise((resolve, reject) => {
    const line = renderCommand(command, vars);
    let stdout = '';
    let stderr = '';
    let child;
    try { child = spawn(line, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(error); return; }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new GuiError('command', `GUI 命令退出码 ${code}：${stderr.slice(0, 200)}`));
      else resolve(stdout.trim());
    });
  });
}

export function createCommandDriver(config = {}) {
  const commands = config.commands ?? {};
  const need = (name) => {
    if (!commands[name]) throw new GuiError('config', `gui-template 配置缺 commands.${name}（源码不写死任何窗口标题或按键）`);
    return commands[name];
  };
  const trace = [];
  let clipboard = '';
  return {
    kind: 'command',
    trace,
    get clipboard() { return clipboard; },
    async activateWindow(windowTitle) { await runCommand(need('activate'), { windowTitle }); trace.push({ action: 'activate' }); },
    async newSession() { await runCommand(need('newSession'), {}); trace.push({ action: 'newSession' }); },
    async hotkey(keys) { await runCommand(need('hotkey'), { keys: Array.isArray(keys) ? keys.join('+') : keys }); trace.push({ action: 'hotkey' }); },
    async setClipboard(text) {
      clipboard = String(text ?? '');
      // 提示词是几百字带换行的中文，塞进命令行会被引号 / 换行 / 长度三重坑死，
      // 所以落成临时文件、让助手脚本自己读。{{text}} 仍然传（兼容旧配置里的短文本模板）。
      const tmp = path.join(os.tmpdir(), `aicompany-clip-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(tmp, clipboard, 'utf8');
      try {
        await runCommand(need('setClipboard'), { textFile: tmp, text: clipboard });
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响主流程 */ }
      }
      trace.push({ action: 'clipboard' });
    },
    async paste() { await runCommand(need('paste'), {}); trace.push({ action: 'paste' }); },
    async press(key) { await runCommand(need('press'), { key }); trace.push({ action: 'press' }); },
    async foregroundTitle() { return runCommand(need('foregroundTitle'), {}); },
    // 一次拿齐「你闲了多久 / 锁没锁屏 / 剪贴板原来是啥」。三条都要跑 PowerShell，
    // 合成一次能省两秒（每次启动 PowerShell 约 0.8 秒），在抢键鼠这件事上秒数就是打扰。
    async preflight({ clipboardFile = null } = {}) {
      if (!commands.preflight) return null;
      const out = await runCommand(commands.preflight, { outputFile: clipboardFile ?? '' });
      const m = /idle=(-?\d+);session=(\w+);clip=(-?\d+)/.exec(out);
      if (!m) throw new GuiError('preflight', `preflight 输出无法解析：${out.slice(0, 200)}`);
      return {
        idleSec: Number(m[1]),
        locked: m[2] === 'locked',
        clipChars: Number(m[3]),
        clipboardFile: clipboardFile ?? null,
      };
    },
    async restoreFocus() {
      if (!commands.restoreFocus) return null;
      return runCommand(commands.restoreFocus, {});
    },
    async send(payload) {
      // send 是「发出去之后还要额外做点什么」的补充回调，不是发送动作本身 ——
      // 真正按下去的是 steps 里的 press(enter)。所以没配 commands.send 就不做任何事，
      // 绝不能在这里抛错：那时提示词已经发出去了，抛错会让控制面把「已发送」当成失败。
      if (!commands.send) { trace.push({ action: 'send', skipped: 'no-command' }); return; }
      await runCommand(commands.send, { taskId: payload.taskId ?? '' });
    },
    async screenshot(vars = {}) {
      const out = await runCommand(need('screenshot'), { outputFile: vars.outputFile ?? '' });
      const file = vars.outputFile ?? out;
      return file && fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(PNG_1PX, 'base64');
    },
  };
}

export function createGuiDriver(config = {}) {
  if (config.driver === 'command') return createCommandDriver(config);
  // 模拟「目标窗口本来就开着」，否则启动前的焦点校验会误报失焦。
  const sim = { ...(config.simulation ?? {}) };
  if (sim.initialTitle === undefined) sim.initialTitle = config.windowTitle;
  return createSimulationDriver(sim);
}

// 每步前后校验前台窗口标题；失焦 / 弹窗遮挡立即中止并留证（§8.3 可靠性设计）。
// match：exact（默认，一字不差）| contains（标题包含即可）。
// 为什么需要 contains：桌面客户端的标题前面会挂当前会话名（每开一个新会话就变），
// 配置里只能填稳定片段；exact 匹配会把「同一个窗口」误判成「被抢焦点」。
export async function assertForeground(driver, windowTitle, stage, { match = 'exact' } = {}) {
  const current = await driver.foregroundTitle();
  const expected = String(windowTitle ?? '');
  const ok = match === 'contains'
    ? String(current ?? '').includes(expected) && expected.length > 0
    : current === windowTitle;
  if (!ok) {
    throw new GuiError('focus', `第 ${stage} 步前台窗口不是目标窗口（${current ?? '未知/被遮挡'}），中止以免误判完成`, {
      stage, expected: windowTitle, actual: current ?? null, match,
    });
  }
  return { ok: true, stage, current };
}

export async function captureScreenshot({ paths, taskId, runId, driver }) {
  fs.mkdirSync(paths.screenshotsDir, { recursive: true });
  const file = path.join(paths.screenshotsDir, `${taskId}-${runId}.png`);
  const buffer = await driver.screenshot({ outputFile: file });
  if (Buffer.isBuffer(buffer) && buffer.length) fs.writeFileSync(file, buffer);
  else if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(PNG_1PX, 'base64'));
  return file; // 只新增留证，不删除任何文件
}
