#!/usr/bin/env node
// P2：本机 bridge 客户端 CLI（拉模式）。
// 控制面地址、席位码、adapter 命令全部由环境变量给；源码零产品名、零写死主机路径。
// 用法：AICOMPANY_DISPATCH_MODE=bridge npm start（另一个终端）→ npm run bridge

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../src/bridge.js';
import { getAdapter } from '../src/adapters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const baseUrl = env.AICOMPANY_BRIDGE_URL ?? 'http://127.0.0.1:3100';
const agentId = env.AICOMPANY_AGENT_ID ?? 'worker-01';
const token = env.AICOMPANY_BRIDGE_TOKEN ?? null;
const adapterType = env.AICOMPANY_BRIDGE_ADAPTER ?? 'process';
const pollMs = Number(env.AICOMPANY_BRIDGE_POLL_MS ?? 1000);
// 0 / 不设 = 常驻轮询；设成 N 表示拉 N 次就退出（一次性补领 / 冒烟验收用）。
const maxLoops = Number(env.AICOMPANY_BRIDGE_MAX_LOOPS ?? 0) || Infinity;
const demoCommand = `"${process.execPath}" "${path.join(ROOT, 'scripts', 'fake-agent.js')}"`;
const command = env.AICOMPANY_BRIDGE_CMD ?? demoCommand;

// 未知 adapter 明确报错拒绝启动（§6B.6），不静默 fallback 到 process。
const adapter = getAdapter(adapterType);
const bridge = createBridge({
  baseUrl, agentId, token, adapter,
  adapterConfig: { command },
  pollMs, maxLoops,
});

process.on('SIGINT', () => bridge.stop());
process.on('SIGTERM', () => bridge.stop());

console.log(`[bridge] 席位 ${agentId} → ${baseUrl}（${adapterType}，每 ${pollMs}ms 拉一次）`);
if (!env.AICOMPANY_BRIDGE_CMD) {
  console.log('[bridge] 演示模式：未设置 AICOMPANY_BRIDGE_CMD，使用本地 fake-agent，不调用外部模型。');
}

bridge.start((tick) => {
  if (tick.error) { console.error(`[bridge] ${tick.error}`); return; }
  for (const item of tick.done) {
    console.log(`[bridge] ${item.taskId} → ${item.ok ? '完成' : `失败(${item.reason ?? item.status})`}`);
  }
}).then(({ loops }) => {
  console.log(`[bridge] 已停止，共轮询 ${loops} 次。`);
});
