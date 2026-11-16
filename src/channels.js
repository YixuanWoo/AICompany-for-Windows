// P4-6：可选出站通道（Channel / Notifier）。web / stdout / noop 内置；
// im / webhook 走通用 HTTP POST，地址从配置环境变量来，源码里没有任何具体产品名。
// 铁律：禁用全部非 web 通道后，最小闭环、机机唤醒、循环任务必须照常跑。
// 依据：任务书 §6B.8 / §7.6 / §12 P4。

import { spawn } from 'node:child_process';

const registry = new Map();

// 桌面气泡：看板关掉时也能收到「待你拍板」。只在 Windows 上真弹，其它平台静默跳过。
// 参数走 -EncodedCommand（UTF-16LE base64）：命令行直接传中文会按控制台代码页解坏。
function desktopChannel() {
  const esc = (s) => String(s ?? '').replace(/'/g, "''").slice(0, 400);
  const pop = (title, body) => {
    if (process.platform !== 'win32') return;
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      `$n.ShowBalloonTip(12000, '${esc(title)}', '${esc(body)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
      'Start-Sleep -Seconds 13',
      '$n.Visible = $false',
      '$n.Dispose()',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true, detached: true, stdio: 'ignore',
    }).unref();
  };
  return {
    name: 'desktop',
    // 只弹「要人处理」的：拍板 / 项目 / 排班 / 卡住 / 额度。日常进展不打扰。
    send(message) {
      const scene = String(message?.scene ?? '');
      // answer：CEO 只回话不派卡时给你的答复 —— 你问了就得让你看见，别藏在看板里等你自己翻。
      if (!['decision', 'project', 'recurring', 'difficulty', 'quota', 'approval', 'answer'].includes(scene)) return;
      pop(message.title ?? 'AICompany', message.body ?? '');
    },
    requestApproval(request) {
      pop(`待你拍板：${request?.title ?? request?.approvalId ?? ''}`, '打开看板点「通过 / 拒绝」；这条不点，相关任务会一直等着。');
    },
  };
}

registerChannel('desktop', desktopChannel);

export function registerChannel(name, factory) {
  registry.set(name, factory);
  return factory;
}

export function channelNames() {
  return [...registry.keys()];
}

function memoryChannel(name) {
  return { name, send() {}, requestApproval() {} };
}

registerChannel('web', () => memoryChannel('web'));
registerChannel('noop', () => memoryChannel('noop'));
registerChannel('cli', () => memoryChannel('cli'));
registerChannel('stdout', () => ({
  name: 'stdout',
  send(message) { console.log(`[notify] ${message.title ?? ''}\n${message.body ?? ''}`); },
  requestApproval(request) { console.log(`[approval] ${request.title ?? request.approvalId ?? ''}`); },
}));

function webhookChannel(name, { url, fetchImpl = globalThis.fetch } = {}) {
  if (!url) throw new Error(`${name} 通道缺少地址（配置 ${name} 时必须显式给 URL，不静默降级）`);
  const post = (payload) => {
    if (typeof fetchImpl !== 'function') return;
    // 出站是旁路：失败只记日志，绝不影响任务推进。
    Promise.resolve(fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })).catch(() => {});
  };
  return {
    name,
    send(message) { post({ kind: 'notify', message }); },
    requestApproval(request) { post({ kind: 'approval', request }); },
  };
}

registerChannel('webhook', (options = {}) => webhookChannel('webhook', options));
registerChannel('im', (options = {}) => webhookChannel('im', options));

export function createChannels(names = ['web'], { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const active = list.length ? list : ['noop'];
  const messages = [];
  const channels = active.map((name) => {
    const factory = registry.get(name);
    if (!factory) throw new Error(`未知出站通道 ${name}；已注册：${channelNames().join(', ')}`);
    if (name === 'im') return factory({ url: env.AICOMPANY_IM_WEBHOOK_URL ?? null, fetchImpl });
    if (name === 'webhook') return factory({ url: env.AICOMPANY_WEBHOOK_URL ?? null, fetchImpl });
    return factory();
  });
  return {
    kind: active.join('+'),
    channels: active,
    messages,
    send(message) {
      const entry = { ...message, at: new Date().toISOString() };
      messages.push(entry);
      for (const channel of channels) {
        try { channel.send(entry); } catch { /* 旁路通道失败不影响主链路 */ }
      }
    },
    requestApproval(request) {
      const entry = { ...request, kind: 'approval', at: new Date().toISOString() };
      messages.push(entry);
      for (const channel of channels) {
        try { channel.requestApproval(entry); } catch { /* 同上 */ }
      }
      return { status: 'pending' };
    },
  };
}
