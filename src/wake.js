// 主动唤醒：把「人叫才醒」的席位真的叫起来，而不是只留一句提醒。
//
// 【为什么需要它】
//   工程执行岗配的是 dispatch: pull —— 它的担任者是一个会话里的 agent，没有常驻进程。
//   控制面把卡排进队列后只能等人来领；人不在，卡就一直躺着（真机事故：董事会投卡后
//   盯着「排队中」等了半小时，以为系统坏了）。
//
// 【怎么做】
//   会话宿主的网关能往「当前会话」里投一条用户消息，收到消息会话里的 agent 就醒了。
//   这是本机唯一一条「不用常驻进程、不用外部 API key」的唤醒路：剪辑工作台
//   「交给 Agent」按钮用的就是它（工具/agent-bridge）。这里只保留最小必要：
//   读凭据 → 探忙闲 → 投一条唤醒。
//
// 【凭据从哪来】
//   网关的端口和密码**每个会话都不一样**。本机已有一个 SessionStart / UserPromptSubmit
//   hook（工作台的 refresh-creds.sh）把当前凭据写到：
//     %LOCALAPPDATA%\LiteCut\bridge-creds.json
//   我们只读那个文件，不碰密码、不落盘、不打日志。读不到就安静退回「提醒」。
//
// 【一条纪律】
//   绝不静默失败：叫没叫醒、为什么没叫醒，都要能追溯（审计里记 wake_sent / wake_failed）。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const DEFAULT_TIMEOUT_MS = 8_000;
const WAKE_POLL_MS = 2_000;
const WAKE_MAX_WAIT_MS = 10 * 60 * 1000;

/** 可能藏着网关凭据的文件，按优先级排。全部只读。 */
export function credsCandidates(extra = []) {
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    ...extra,
    process.env.AICOMPANY_GATEWAY_CREDS,
    local ? path.join(local, 'LiteCut', 'bridge-creds.json') : null,
  ].filter(Boolean);
}

/**
 * 读当前会话的网关凭据。
 * 返回 { port, password, source, updatedAt } 或 null（宿主没开过 / hook 没写过凭据）。
 *
 * 注意 files 的语义：**显式给了就只认这几个**，不再回落到系统默认路径 ——
 * 否则调用方想隔离（测试、连另一台网关）时，会意外读到本机另一个会话的凭据。
 */
export function loadGatewayCreds({ files = [], staleMs = 12 * 3600 * 1000 } = {}) {
  const list = (Array.isArray(files) && files.length) ? files : credsCandidates();
  for (const file of list) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const port = Number(data.port ?? 0);
    const password = String(data.password ?? '');
    if (!port || !password) continue;
    // 时间戳只用来判断「这份凭据是不是上一场会话留下的」：过期也照样试一次，
    // 因为 hook 可能没跑而端口恰好没变 —— 试一次比直接放弃划算。
    const updatedAt = data.updatedAt ?? null;
    const ageMs = updatedAt ? Date.now() - Date.parse(updatedAt) : null;
    return {
      port, password, source: file, updatedAt,
      stale: Number.isFinite(ageMs) ? ageMs > staleMs : false,
    };
  }
  return null;
}

function request({ port, password, method, urlPath, body = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        Authorization: `Bearer ${password}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: '网关超时' }); });
    req.on('error', (error) => resolve({ status: 0, body: '', error: error.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 会话忙不忙。true=正在干活，false=空闲，null=探不到（网关没开 / 凭据过期）。 */
export async function probeSession(creds) {
  const res = await request({ ...creds, method: 'GET', urlPath: '/api/v1/status' });
  if (res.status !== 200) return { ok: false, busy: null, reason: res.error ?? `HTTP ${res.status}` };
  try {
    const data = JSON.parse(res.body)?.data ?? {};
    return {
      ok: true,
      busy: typeof data.busy === 'boolean' ? data.busy : null,
      activeSessionId: data.activeSessionId ?? null,
      runStatus: data.runStatus ?? null,
    };
  } catch {
    return { ok: false, busy: null, reason: '网关返回不是 JSON' };
  }
}

/** 往当前会话投一条消息 —— 这一步就是「叫醒」。 */
export async function sendWake(creds, text, { senderName = 'AICompany 控制面' } = {}) {
  const res = await request({
    ...creds,
    method: 'POST',
    urlPath: '/api/v1/runs',
    body: {
      id: `aicompany-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'user_message',
      // 网关只认 payload.text；写成 content 会 EMPTY_PROMPT 秒退（工作台踩过的坑）。
      text,
      sender: { id: 'aicompany-control-plane', name: senderName },
    },
    timeoutMs: 20_000,
  });
  if (res.status >= 200 && res.status < 300) {
    let runId = null;
    try { runId = JSON.parse(res.body)?.data?.runId ?? null; } catch { /* 没有 runId 也算成功 */ }
    return { ok: true, status: res.status, runId };
  }
  return { ok: false, status: res.status, error: res.error ?? String(res.body ?? '').slice(0, 300) };
}

// 排队：agent 忙的时候硬发会被网关直接丢掉（它只判一句"还在跑别的回合"）。
// 所以忙就先记着，等它空闲再发；同一个 key 只留最后一次，避免连投几张卡刷出多条唤醒。
const pending = new Map(); // key → { queuedAt, timer, tries }

export function pendingWakeCount() { return pending.size; }

/**
 * 叫醒当前会话里的 agent。
 *
 * @param {object} opts
 * @param {string} opts.text    唤醒内容（要能让人一眼看懂「该干什么」）
 * @param {string} opts.key     合并键，通常用 taskId
 * @param {number} opts.maxWaitMs 忙时最多等多久（默认 10 分钟）
 * @returns {Promise<{ok:boolean, queued?:boolean, reason?:string, runId?:string}>}
 */
export async function wakeSession({
  text, key = 'default', files = [], maxWaitMs = WAKE_MAX_WAIT_MS, pollMs = WAKE_POLL_MS,
  onResult = null,
} = {}) {
  const creds = loadGatewayCreds({ files });
  if (!creds) return { ok: false, reason: '没找到网关凭据（会话宿主没开过，或 hook 没写过）' };

  const probe = await probeSession(creds);
  if (!probe.ok) return { ok: false, reason: `网关探不通：${probe.reason}` };

  if (probe.busy === false) {
    const sent = await sendWake(creds, text);
    if (onResult) { try { onResult(sent); } catch { /* 回调是旁路 */ } }
    return sent;
  }

  // 忙：排队等空闲。每次重读凭据（端口可能随会话变）。
  const old = pending.get(key);
  if (old?.timer) clearTimeout(old.timer);
  const queuedAt = Date.now();
  const entry = { queuedAt, timer: null, tries: 0 };
  pending.set(key, entry);

  const tick = async () => {
    const cur = pending.get(key);
    if (!cur || cur.queuedAt !== queuedAt) return;      // 被更新的唤醒取代
    if (Date.now() - queuedAt > maxWaitMs) {
      pending.delete(key);
      if (onResult) { try { onResult({ ok: false, error: `排队超时（等满 ${Math.round(maxWaitMs / 60000)} 分钟）` }); } catch { /* 旁路 */ } }
      return;
    }
    cur.tries += 1;
    const fresh = loadGatewayCreds({ files }) ?? creds;
    const again = await probeSession(fresh);
    if (again.busy === false) {
      const sent = await sendWake(fresh, text);
      pending.delete(key);
      if (onResult) { try { onResult(sent); } catch { /* 旁路 */ } }
      return;
    }
    cur.timer = setTimeout(tick, pollMs);
    if (cur.timer.unref) cur.timer.unref();
  };
  entry.timer = setTimeout(tick, 300);
  if (entry.timer.unref) entry.timer.unref();

  return { ok: true, queued: true, reason: `会话正忙（${probe.runStatus ?? 'busy'}），已排队等它空闲` };
}
