// 唤醒实验：确定「空闲多久后发、发出去能不能真的拉起一轮对话」。
// 全程写时间线到 work-prod/wake-experiment.log，不依赖任何人在场观察。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const LOG = path.resolve('work-prod/wake-experiment.log');
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function creds() {
  const file = path.join(process.env.LOCALAPPDATA ?? '', 'LiteCut', 'bridge-creds.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d.port || !d.password) return null;
    return { port: Number(d.port), password: String(d.password) };
  } catch { return null; }
}

function req(creds, method, urlPath, body = null, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: creds.port, path: urlPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        Authorization: `Bearer ${creds.password}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

async function probe() {
  const c = creds();
  if (!c) return { ok: false, busy: null };
  const res = await req(c, 'GET', '/api/v1/status');
  if (res.status !== 200) return { ok: false, busy: null, error: res.error ?? res.status };
  try {
    const d = JSON.parse(res.body)?.data ?? {};
    return { ok: true, busy: d.busy, runStatus: d.runStatus };
  } catch { return { ok: false, busy: null }; }
}

const WAKE_TEXT = [
  '【AICompany 唤醒实验】如果你看到这条：说明「会话空闲后投递消息 → 自动拉起新一轮对话」已经打通。',
  '请做两件事：1) 读 D:/开源/AICompany/work-prod/wake-experiment.log 分析哪次尝试成功；',
  '2) 领取卡 T-65d1b37e 并交付（AICOMPANY_AGENT_ID=engineering node scripts/seat.js inbox）。',
].join('\n');

async function sendWake() {
  const c = creds();
  const id = `aicompany-exp-${Date.now().toString(36)}`;
  const res = await req(c, 'POST', '/api/v1/runs', {
    id, type: 'user_message', text: WAKE_TEXT,
    sender: { id: 'aicompany-control-plane', name: 'AICompany 控制面' },
  }, 20000);
  let runId = null;
  try { runId = JSON.parse(res.body)?.data?.runId ?? null; } catch { /* 忽略 */ }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, runId, error: res.error };
}

async function main() {
  log(`实验启动 pid=${process.pid}`);
  let idleSince = null;
  let attempt = 0;
  let lastBusy = null;

  // 阶段 1：等会话空闲（我本轮还没结束时会一直忙）
  while (true) {
    const p = await probe();
    const now = Date.now();
    if (p.ok && p.busy === false) {
      if (idleSince === null) { idleSince = now; log('观测到空闲'); }
    } else if (p.ok && p.busy === true) {
      if (idleSince !== null) log(`重新变忙（runStatus=${p.runStatus}），实验继续等`);
      idleSince = null;
    } else {
      log(`网关探不通（${p.error ?? '未知'}），凭据可能刷新，继续等`);
      idleSince = null;
    }
    lastBusy = p;
    // 连续空闲 ≥4 秒（跨过 killWorker 的 1 秒回收窗口）才进入阶段 2
    if (idleSince !== null && now - idleSince >= 4000) break;
    await sleep(1000);
  }
  log(`会话已连续空闲 ≥4s，开始投递尝试`);

  // 阶段 2：投递 + 观察忙闲翻转，不翻转就重试（最多 4 次）
  while (attempt < 4) {
    attempt += 1;
    const sent = await sendWake();
    log(`尝试 ${attempt}：POST ${sent.ok ? '成功' : `失败(${sent.error ?? sent.status})`} runId=${sent.runId ?? '-'}`);
    if (!sent.ok) { await sleep(10000); continue; }

    // 发出后 45 秒内观察：busy 翻转为 true = 一轮对话被拉起来了
    let flipped = false;
    const deadline = Date.now() + 45000;
    let firstRunActive = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      const p = await probe();
      if (p.ok && p.busy === true) { flipped = true; log(`尝试 ${attempt}：busy 翻转 true（runStatus=${p.runStatus}）→ 唤醒成功！`); break; }
      if (sent.runId && firstRunActive === null) {
        const c = creds();
        const r = await req(c, 'GET', `/api/v1/runs/${sent.runId}`);
        firstRunActive = r.body.slice(0, 120);
        log(`尝试 ${attempt}：run 状态 ${r.status} ${firstRunActive}`);
      }
    }
    if (flipped) { log(`实验结论：空闲 ≥4s 后第 ${attempt} 次投递成功`); return; }
    log(`尝试 ${attempt}：45s 内 busy 一直没翻转 → 这条 run 哑火了。10s 后重试`);
    await sleep(10000);
    // 重试前确认还空闲（可能已经被别的东西叫醒）
    const p = await probe();
    if (p.ok && p.busy === true) { log('重试前发现会话已经忙了（可能被引擎的补叫唤醒）→ 实验结束'); return; }
  }
  log(`实验结论：4 次投递全部哑火。需要换路径（保活 / 其他注入通道）`);
}

main().catch((e) => log(`实验异常：${e?.stack ?? e}`));
