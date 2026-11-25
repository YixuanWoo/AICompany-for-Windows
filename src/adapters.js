// P1-5：adapter 插件注册表 + process / cli-acp 两个通用型 + 测试用 mock。
// 统一 execute(ctx) → { status, usage, result, sessionParams }；差异全封装在这里。

import { spawn } from 'node:child_process';
import { writeDispatchReceipt } from './evidence.js';

const registry = new Map();

export function registerAdapter(type, module) {
  registry.set(type, module);
  return module;
}

export function getAdapter(type) {
  const found = registry.get(type);
  if (!found) {
    throw new Error(`未注册 adapter type: ${String(type)}；已注册：[${availableAdapterTypes().join(', ')}]（拒绝启动，不静默降级）`);
  }
  return found;
}

export function availableAdapterTypes() {
  return [...registry.keys()];
}

function parseLastJson(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((line) => line.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // JSONL 事件流里非 JSON 行（日志）跳过，取最后一条可解析的。
    }
  }
  throw new Error(`adapter 没有输出可解析的 JSON：${String(text).slice(0, 200)}`);
}

function spawnWithJson(command, ctx) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (error) {
      reject(error);
      return;
    }
    // L1：进程真的起来了，算「已启动」。这件事只靠系统观测，agent 自报不算。
    // 注意：spawn 成功 ≠ 任务送达 ≠ agent 开工 —— CLI 可能在凭据检查/授权轮询里卡住
    //（真机 T-5457e8a0：进程活了、心跳在写，10 分钟零产出）。所以看板把这一级叫「已启动」，
    // 「已收到」要等 ack.md，「有进度」要等产物/进度增长。
    const workRoot = ctx.adapterConfig?.workRoot ?? ctx.workRoot ?? null;
    const taskId = ctx.task?.taskId ?? ctx.taskId ?? null;
    if (workRoot && taskId) {
      writeDispatchReceipt({
        workRoot, taskId, runId: ctx.runId ?? null,
        agentId: ctx.agent?.id ?? null, via: 'process',
      });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`adapter 退出码 ${code}：${stderr.slice(0, 300)}`));
        return;
      }
      try {
        resolve(parseLastJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify(ctx));
    child.stdin.end();
  });
}

// 最后一行 JSON 有两种合法形态，这里统一拆包：
//   ① 裸结果（推荐）：最后一行直接就是业务对象（完成报告 / 变更请求 / 停手说明）；
//   ② 信封（历史桥接写法）：{ status, usage, result, sessionParams }，业务对象在 result 里。
// 老写法一律把 raw 当 result，信封就被当完成报告去校验，报「缺 schema/taskId…、
// 多 result/sessionParams」整份打回 —— T-a4d59e96 事故（CLI 席位交回信封报告被拒两次）。
function normalize(raw, ctx) {
  const isEnvelope = Boolean(raw) && typeof raw === 'object' && !('schema' in raw)
    && 'status' in raw && raw.result && typeof raw.result === 'object';
  const body = isEnvelope ? raw.result : (raw ?? {});
  let status = raw?.status ?? body?.status;
  // 裸变更请求没有 status 字段：按 schema 认出来，交回引擎走汇报链路。
  if (!status) status = body?.schema === 'aicompany.change-request/v1' ? 'change_requested' : 'success';
  return {
    status,
    usage: raw?.usage ?? body?.usage ?? { quotaUnits: 1 },
    sessionParams: raw?.sessionParams ?? null,
    result: body,
    agentId: ctx.agent.id,
    runId: ctx.runId,
  };
}

export const processAdapter = registerAdapter('process', {
  type: 'process',
  testEnvironment(config) {
    return { ok: Boolean(config?.command), detail: config?.command ?? '缺 command 配置' };
  },
  async execute(ctx) {
    const raw = await spawnWithJson(ctx.adapterConfig.command, ctx);
    return normalize(raw, ctx);
  },
});

export const cliAcpAdapter = registerAdapter('cli-acp', {
  type: 'cli-acp',
  testEnvironment(config) {
    return { ok: Boolean(config?.command), detail: config?.command ?? '缺 command 配置' };
  },
  async execute(ctx) {
    // cli-acp 形态：spawn CLI 并解析 JSONL；最后一条可解析记录即结果。
    const raw = await spawnWithJson(ctx.adapterConfig.command, ctx);
    return normalize(raw, ctx);
  },
});

// P3：`gui-template` 是 §6B.6 五通用型之一，实现放在 gui-adapter.js（不 import 本文件，避免循环）。
import { guiTemplateAdapter } from './gui-adapter.js';
export const guiAdapter = registerAdapter('gui-template', guiTemplateAdapter);

// webhook-exec：通用外部执行服务客户端，把任务 POST 给一个带工具的远程 agent。
// 实现独立在 adapter-webhook-exec.js，零第三方依赖；配置里不启用就不生效。
import { webhookExecAdapter } from './adapter-webhook-exec.js';
export const webhookExec = registerAdapter('webhook-exec', webhookExecAdapter);

// 人机席位：担任者是「人叫才醒」的交互式 agent，没有常驻进程。
// 它只通过 scripts/seat.js 自己来领卡（dispatch: pull），控制面永远不该直调它。
// 真被直调了 —— 说明配置写错了（没写 pull），这里必须炸，不能假装干完了。
export const seatAdapter = registerAdapter('seat', {
  type: 'seat',
  testEnvironment() {
    return { ok: true, detail: '人机席位：由本人用 scripts/seat.js 领取，控制面不直调' };
  },
  async execute(ctx) {
    throw new Error(
      `席位 ${ctx.agent?.id} 是拉模式（seat），控制面不该直调它；`
      + '请在配置里把该岗位的 dispatch 写成 pull',
    );
  },
});

export const mockAdapter = registerAdapter('mock', {
  type: 'mock',
  testEnvironment() {
    return { ok: true, detail: '内存 mock，不启动子进程' };
  },
  async execute(ctx) {
    const raw = typeof ctx.adapterConfig.result === 'function'
      ? ctx.adapterConfig.result(ctx)
      : (ctx.adapterConfig.result ?? { type: 'review', verdict: 'pass' });
    return normalize(raw, ctx);
  },
});
