// 主动唤醒：AICompany 要能把「人叫才醒」的席位真的叫起来。
//
// 真机背景（2026-11-16）：董事会投卡给工程岗，卡一直排队，他以为系统坏了。
// 光提醒不够 —— 活还在原地。WorkBuddy 网关能往当前会话投一条消息，收到消息
// 会话里的 agent 就醒了（剪辑工作台「交给 Agent」用的就是这条）。这组测试锁住：
// 空闲就发、忙就排队等、没凭据就老实失败、别把密码写进日志。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { loadGatewayCreds, probeSession, sendWake, wakeSession } from '../src/wake.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicompany-wake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeCreds(dir, port, password = 'test-pw') {
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({
    port: String(port), password, updatedAt: new Date().toISOString(),
  }), 'utf8');
  return file;
}

/** 假网关：可控忙闲，记录收到的唤醒。 */
async function fakeGateway(t, { busy = false } = {}) {
  const state = { busy, runs: [], auths: [], setBusy(v) { state.busy = v; } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      state.auths.push(req.headers.authorization ?? null);
      if (req.url === '/api/v1/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { status: 'ok', busy: state.busy, runStatus: state.busy ? 'tool_executing' : 'idle' } }));
        return;
      }
      if (req.url === '/api/v1/runs') {
        state.runs.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { runId: `run-${state.runs.length}` } }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, port: server.address().port };
}

test('K1 · 凭据：优先读指定的文件，缺端口或密码的不认', (t) => {
  const dir = tmpDir(t);
  const good = writeCreds(dir, 45678, 'pw-1');
  const creds = loadGatewayCreds({ files: [good] });
  assert.equal(creds.port, 45678);
  assert.equal(creds.password, 'pw-1');
  assert.equal(creds.source, good);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ port: '', password: 'x' }), 'utf8');
  assert.equal(loadGatewayCreds({ files: [bad] }), null, '缺端口视为不可用');

  assert.equal(loadGatewayCreds({ files: [path.join(dir, 'nope.json')] }), null, '文件不存在不能抛');
});

test('K2 · 会话空闲：直接投一条唤醒，内容带原始文本、鉴权头正确', async (t) => {
  const dir = tmpDir(t);
  const gw = await fakeGateway(t, { busy: false });
  const file = writeCreds(dir, gw.port, 'pw-2');

  const out = await wakeSession({ text: '有卡等你领', key: 'T-1', files: [file] });
  assert.equal(out.ok, true);
  assert.equal(out.runId, 'run-1');
  assert.equal(gw.state.runs.length, 1);
  assert.equal(gw.state.runs[0].text, '有卡等你领', '网关只认 payload.text，写错会 EMPTY_PROMPT');
  assert.equal(gw.state.runs[0].type, 'user_message');
  assert.equal(gw.state.auths.at(-1), 'Bearer pw-2', '必须带 Bearer 凭据');
});

test('K3 · 会话正忙：先排队，等它空闲再发（硬发会被网关丢掉）', async (t) => {
  const dir = tmpDir(t);
  const gw = await fakeGateway(t, { busy: true });
  const file = writeCreds(dir, gw.port);

  const results = [];
  const first = await wakeSession({
    text: '忙时排队', key: 'T-2', files: [file], pollMs: 40, maxWaitMs: 5000,
    onResult: (r) => results.push(r),
  });
  assert.equal(first.ok, true);
  assert.equal(first.queued, true, '忙的时候应当排队而不是硬发');
  assert.equal(gw.state.runs.length, 0, '忙时一条都不该发出去');

  gw.state.setBusy(false);
  await new Promise((r) => setTimeout(r, 400)); // 等它轮询到空闲
  assert.equal(gw.state.runs.length, 1, '空闲后必须补发');
  assert.equal(gw.state.runs[0].text, '忙时排队');
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

test('K4 · 叫不醒就排队重试：凭据缺失 / 端口不通都不秒放弃，也不假装成功', async (t) => {
  const dir = tmpDir(t);
  const missing = await wakeSession({ text: 'x', files: [path.join(dir, 'none.json')] });
  assert.equal(missing.ok, true);
  assert.equal(missing.queued, true, '凭据缺失时排队等 hook 刷新，不秒放弃');
  assert.match(missing.reason, /排队重试|凭据/);

  // 指向一个没人监听的端口：进重试队列等凭据刷新，最终超时要认输。
  const dead = writeCreds(dir, 1);
  const refused = await wakeSession({ text: 'x', files: [dead], maxWaitMs: 400, pollMs: 80 });
  assert.equal(refused.ok, true);
  assert.equal(refused.queued, true);
  assert.match(refused.reason, /探不通/);
  // 超时由 onResult 通知：等它走完。
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'onResult 没回调' }), 2000);
    wakeSession({ text: 'x2', files: [dead], maxWaitMs: 300, pollMs: 80, onResult: (r) => { clearTimeout(timer); resolve(r); } });
  });
  assert.equal(outcome.ok, false, '重试超时必须通过 onResult 认输');
  assert.match(outcome.error ?? '', /超时/);
});

test('K5 · 探活：忙闲读得对，状态码不对不装成功', async (t) => {
  const gw = await fakeGateway(t, { busy: true });
  const probe = await probeSession({ port: gw.port, password: 'pw' });
  assert.equal(probe.ok, true);
  assert.equal(probe.busy, true);
  assert.equal(probe.runStatus, 'tool_executing');

  const dead = await probeSession({ port: 1, password: 'pw' });
  assert.equal(dead.ok, false);
  assert.equal(dead.busy, null);
});

test('K6 · 唤醒正文不许夹带密码（那会让密码进对话、进日志）', async (t) => {
  const dir = tmpDir(t);
  const gw = await fakeGateway(t, { busy: false });
  const file = writeCreds(dir, gw.port, 'super-secret-pw');
  await sendWake(
    { port: gw.port, password: 'super-secret-pw' },
    '【AICompany 自动叫醒】有卡等你领',
  );
  const sent = JSON.stringify(gw.state.runs[0]);
  assert.ok(!sent.includes('super-secret-pw'), '唤醒内容里绝不能出现网关密码');
  assert.match(sent, /自动叫醒/);
});
