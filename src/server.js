// P1-4 / P2-1：统一 API（REST + SSE）+ 内置 Web Board 静态页 + bridge 子集。零依赖，只用 node:http。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEngine, createNotifier } from './engine.js';
import { loadConfig, EXAMPLE_CONFIG_PATH, OVERRIDES_PATH } from './config.js';
import { openDb, writeAudit } from './core.js';
import { createBridgeApi, assertBridgeToken } from './bridge-api.js';
import { createRecurring } from './recurring.js';
import { createScheduler } from './scheduler.js';
import { cleanupScan } from './cleanup.js';
import { buildObservation, detectDirty, renderObservationMarkdown } from './observe.js';
import { tune, tuneHistory, TUNABLE, TuneError } from './tune.js';
import { listOutputs, readOutput, OutputsError } from './outputs.js';
import { readPauseFlag, writePauseFlag } from './gui-adapter.js';
import { createSeatClaim, guiSeatAgents } from './gui-seat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD_HTML = path.join(ROOT, 'src', 'web', 'board.html');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createServer({
  engine, port = 3100, host = '127.0.0.1', bridgeToken = null, onlineWindowSec = 60,
  recurring = null, scheduler = null, logger = null, now = () => new Date(),
  overridesPath = OVERRIDES_PATH, guiPauseFile = null, guiSeat = null,
  deferRequests = false,
}) {
  const sseClients = new Set();
  const bridgeApi = createBridgeApi({ engine, token: bridgeToken, onlineWindowSec });
  // GUI 席位相关：哪些席位会抢键鼠、暂停开关落在哪个文件、占位情况如何。
  const guiAgents = (engine.config?.agents ?? []).filter((a) => a?.adapter?.type === 'gui-template');
  const guiSeats = guiAgents.map((a) => ({
    agentId: a.id,
    displayName: a.displayName ?? a.id,
    gate: a.adapter?.config?.gate ?? {},
    lockPath: a.adapter?.config?.lockPath ?? null,
  }));
  const pauseFile = guiPauseFile
    ?? guiAgents.map((a) => a.adapter?.config?.gate?.pauseFile).find(Boolean)
    ?? null;
  const rec = recurring ?? createRecurring({ db: engine.db, notifier: engine.notifier });
  const sched = scheduler ?? createScheduler({ recurring: rec, logger });
  // P4-9：循环模板改版的人审通过后，落到 recurring 上（只影响新轮次）。
  if (typeof engine.setApprovalHandler === 'function') {
    engine.setApprovalHandler('recurring_change', (payload, meta = {}) =>
      rec.applyRevision(payload.jobId, payload.patch ?? {}, { approvedBy: meta.decidedBy ?? 'human' }));
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(BOARD_HTML, 'utf8'));
        return;
      }
      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache', Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      // bridge 子集仍然挂在统一 API 下面，不是另一套协议（§9.2）。
      if (pathname.startsWith('/api/bridge/')) {
        const auth = assertBridgeToken(req.headers ?? {}, bridgeToken);
        if (!auth.ok) { json(res, auth.status, { error: auth.reason }); return; }
        const body = method === 'GET' ? {} : JSON.parse((await readBody(req)) || '{}');
        const result = await bridgeApi.handle({ method, pathname, body, query: url.searchParams });
        json(res, result.status, result.data);
        return;
      }
      // 循环任务 / 定时例程：与 Web Board、bridge 共用同一套统一 API。
      if (pathname.startsWith('/api/recurring') || pathname.startsWith('/api/cycle')
        || pathname.startsWith('/api/scheduler')) {
        const body = method === 'GET' ? {} : JSON.parse((await readBody(req)) || '{}');
        const match = pathname.match(/^\/api\/recurring\/([^/]+)\/(pause|resume|fire|complete-cycle)$/);
        if (method === 'GET' && pathname === '/api/recurring') { json(res, 200, rec.listJobs()); return; }
        if (method === 'POST' && pathname === '/api/recurring') { json(res, 201, rec.registerJob(body)); return; }
        if (method === 'POST' && match) {
          const [, jobId, action] = match;
          if (action === 'pause') { json(res, 200, rec.pauseJob(jobId, body.reason ?? '人工暂停')); return; }
          if (action === 'resume') { json(res, 200, rec.resumeJob(jobId)); return; }
          if (action === 'fire') {
            json(res, 200, rec.fire({ jobId, scheduledAt: body.scheduledAt, now: body.now }));
            return;
          }
          json(res, 200, rec.completeCycle({ jobId, ...body }));
          return;
        }
        if (method === 'POST' && pathname === '/api/scheduler/tick') {
          json(res, 200, sched.runOnce({ now: body.now })); return;
        }
        if (method === 'POST' && /^\/api\/recurring\/[^/]+\/revise$/.test(pathname)) {
          const jobId = pathname.split('/')[3];
          const approval = engine.requestApproval({
            kind: 'recurring_change', title: `循环模板改版：${jobId}`,
            body: '改频率 / 模板 / 终止条件必须人审；批准后只影响新轮次，旧 CycleHistory 不动。',
            payload: { jobId, patch: body.patch ?? {} }, requestedBy: 'human',
          });
          json(res, 202, { status: 'awaiting_approval', approvalId: approval.approvalId, jobId });
          return;
        }
        if (method === 'GET' && pathname === '/api/scheduler') {
          json(res, 200, { running: sched.running, ticks: sched.ticks }); return;
        }
        if (method === 'GET' && pathname === '/api/cycles') {
          json(res, 200, rec.listCycles(url.searchParams.get('jobId') ?? '')); return;
        }
        if (method === 'GET' && pathname === '/api/cycle-history') {
          json(res, 200, rec.listHistory(url.searchParams.get('jobId') ?? '')); return;
        }
        json(res, 404, { error: `没有这个循环端点：${method} ${pathname}` });
        return;
      }
      if (method === 'POST' && pathname === '/api/requests') {
        const body = JSON.parse((await readBody(req)) || '{}');
        // deferRequests：真 GUI 席位一次能跑几分钟，HTTP 不该陪着干等。
        // 卡和事件都已落库，泵在后台推进；调用方用 /api/tasks/:id 轮询终态即可。
        const result = await engine.submit(body, { defer: deferRequests });
        json(res, 201, result);
        return;
      }
      if (method === 'POST' && /^\/api\/tasks\/[^/]+\/cancel$/.test(pathname)) {
        const body = JSON.parse((await readBody(req)) || '{}');
        json(res, 200, engine.cancelTask(pathname.split('/')[3], { reason: body.reason ?? '人工取消' }));
        return;
      }
      // ---- P6：任务产物查看（看板「看结果」与命令行 --wait 用同一套口径）----
      const outputsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/outputs?$/);
      if (method === 'GET' && outputsMatch) {
        const taskId = outputsMatch[1];
        try {
          const data = pathname.endsWith('/outputs')
            ? listOutputs(engine.workRoot, taskId)
            : readOutput(engine.workRoot, taskId, url.searchParams.get('file') ?? '');
          json(res, 200, data);
        } catch (error) {
          json(res, error instanceof OutputsError ? error.status : 500, { error: String(error.message ?? error) });
        }
        return;
      }
      // ---- P6：GUI 席位的暂停开关与状态（抢键鼠这件事必须能随时叫停）----
      if (method === 'GET' && pathname === '/api/gui/state') {
        const flag = readPauseFlag(pauseFile);
        const claim = guiSeat?.status?.() ?? null;
        json(res, 200, {
          seats: guiSeats,
          paused: flag.paused,
          pauseAt: flag.at,
          pauseReason: flag.reason,
          pauseFile,
          seatClaim: claim,
          lockHolders: guiSeats.map((seat) => {
            if (!seat.lockPath) return { agentId: seat.agentId, held: null, mode: 'memory' };
            let state = null;
            try { state = JSON.parse(fs.readFileSync(seat.lockPath, 'utf8')); } catch { state = null; }
            const held = Boolean(state && !state.released);
            return {
              agentId: seat.agentId, mode: 'file', lockPath: seat.lockPath,
              held, holder: held ? state.owner ?? null : null, acquiredAt: held ? state.acquiredAt ?? null : null,
            };
          }),
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/gui/pause') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!pauseFile) { json(res, 400, { error: '这个实例没有 GUI 席位，不需要暂停' }); return; }
        const paused = body.paused !== false;
        const state = writePauseFlag(pauseFile, {
          paused, reason: String(body.reason ?? ''), now: now(),
        });
        writeAudit(engine.db, {
          actor: body.actor ?? 'human', action: 'gui_pause',
          newValue: paused ? 'paused' : 'running',
        });
        json(res, 200, { ...state, seats: guiSeats.map((s) => s.agentId) });
        return;
      }
      // ---- P5：调参留痕（改完立刻生效，旧值新值都进 audit）----
      if (method === 'POST' && pathname === '/api/config/tune') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = tune(
          { config: engine.config, db: engine.db, overridesPath },
          {
            key: body.key, value: body.value, reason: body.reason ?? '',
            actor: body.actor ?? 'human', persist: body.persist !== false, now: now(),
          },
        );
        json(res, 200, result);
        return;
      }
      // ---- P4：审批门禁 / 配额 / 决策回环 / 协作增强 / 清理扫描 ----
      if (method === 'POST' && pathname === '/api/approvals') {
        const body = JSON.parse((await readBody(req)) || '{}');
        json(res, 201, engine.requestApproval(body));
        return;
      }
      if (method === 'POST' && /^\/api\/quotas\/[^/]+\/reset$/.test(pathname)) {
        json(res, 200, engine.resetQuota(pathname.split('/')[3]));
        return;
      }
      if (method === 'POST' && pathname === '/api/change-requests/expire') {
        const body = JSON.parse((await readBody(req)) || '{}');
        json(res, 200, engine.expireDecisions({ now: body.now ? new Date(body.now) : undefined }));
        return;
      }
      if (method === 'POST' && /^\/api\/change-requests\/[^/]+\/decision$/.test(pathname)) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const changeRequestId = pathname.split('/')[3];
        const out = await engine.submitDecision({ changeRequestId, ...body });
        json(res, 200, out);
        return;
      }
      if (method === 'POST' && /^\/api\/threads\/[^/]+\/(roll-call|promote|archive)$/.test(pathname)) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const [, , , threadId, action] = pathname.split('/');
        if (action === 'roll-call') { json(res, 200, await engine.rollCall(threadId, body)); return; }
        if (action === 'promote') {
          // promoteThread 自己会把卡推到终态（内部 pump），这里不再重复推进。
          json(res, 201, await engine.promoteThread(threadId, body));
          return;
        }
        json(res, 200, engine.archiveThread(threadId, body));
        return;
      }
      if (method === 'POST' && pathname === '/api/threads/archive-stale') {
        const body = JSON.parse((await readBody(req)) || '{}');
        json(res, 200, engine.archiveStaleThreads({ now: body.now ? new Date(body.now) : undefined }));
        return;
      }
      if (method === 'POST' && pathname === '/api/cleanup/scan') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const out = cleanupScan({
          jobId: body.jobId ?? 'manual', cycleNo: body.cycleNo ?? null,
          targets: body.targets ?? [], whitelist: body.whitelist ?? [],
          workRoot: body.workRoot ?? path.join(ROOT, 'work'), maxFiles: body.maxFiles ?? 500,
        });
        json(res, 200, out);
        return;
      }
      if (method === 'POST' && pathname === '/api/threads') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const routed = engine.route({ ...body, mode: 'cowork' });
        const pumped = await engine.pump();
        json(res, 201, { ...routed, ...pumped });
        return;
      }
      if (method === 'POST' && pathname === '/api/change-requests') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const submitted = engine.submitChangeRequest(body);
        const pumped = await engine.pump();
        json(res, 201, { ...submitted, ...pumped });
        return;
      }
      if (method === 'GET' && /^\/api\/threads\/[^/]+$/.test(pathname)) {
        const thread = engine.threadById(pathname.split('/')[3]);
        if (!thread) { json(res, 404, { error: '协作空间不存在' }); return; }
        json(res, 200, thread);
        return;
      }
      if (method === 'POST' && /^\/api\/threads\/[^/]+\/messages$/.test(pathname)) {
        const threadId = pathname.split('/')[3];
        const body = JSON.parse((await readBody(req)) || '{}');
        const posted = engine.postThreadMessage(threadId, body);
        const pumped = await engine.pump();
        json(res, 201, { ...posted, ...pumped });
        return;
      }
      if (method === 'POST' && /^\/api\/approvals\/[^/]+\/decision$/.test(pathname)) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const approvalId = pathname.split('/')[3];
        if (!engine.getApprovals().some((a) => a.approvalId === approvalId)) {
          json(res, 404, { error: `没有审批单 ${approvalId}` });
          return;
        }
        const out = engine.decideApproval(approvalId, {
          decision: body.decision ?? 'approved',
          decidedBy: body.decidedBy ?? 'human',
          reason: body.reason ?? null,
        });
        json(res, 200, { ...out, ...(await engine.pump()) });
        return;
      }
      if (method === 'POST' && pathname === '/api/runs/now') {
        const body = JSON.parse((await readBody(req)) || '{}');
        engine.emitEvent({
          type: 'issue_assigned', taskId: body.taskId, agentId: body.agentId,
          payload: { wakeReason: 'manual' },
        });
        const pumped = await engine.pump();
        json(res, 200, pumped);
        return;
      }
      if (method === 'GET') {
        const q = url.searchParams;
        const routes = {
          // P6：看板要知道「这家公司默认怎么派活、有哪些席位」，否则每次都得手选模式。
          '/api/meta': () => {
            const projects = engine.listProjects();
            return {
              company: engine.config?.company?.name ?? null,
              defaultMode: engine.config?.interaction?.defaultMode ?? 'delegate',
              defaultTarget: engine.config?.interaction?.defaultTarget ?? null,
              seats: (engine.config?.agents ?? []).map((a) => ({
                agentId: a.id,
                displayName: a.displayName ?? a.id,
                isCEO: Boolean(a.isCEO),
                capabilities: a.capabilities ?? [],
                gui: a.adapter?.type === 'gui-template',
                maxDifficulty: a.maxDifficulty ?? 'hard',
              })),
              guiPaused: readPauseFlag(pauseFile).paused,
              guiSeats: guiSeats.map((s) => s.agentId),
              // P7：配了项目就「下单必选项目」，看板得知道有哪些、默认选哪个。
              projects,
              defaultProject: projects.length === 1 ? projects[0].id : null,
            };
          },
          // P7：项目一览（规范在不在、记忆几条）——看板项目面板与 CLI 都读它。
          '/api/projects': () => engine.listProjects(),
          '/api/agents': () => engine.getAgentCandidates(),
          '/api/quotas': () => engine.getQuotas(),
          '/api/tasks': () => engine.getTasks(),
          '/api/runs': () => {
            const rows = engine.getRuns();
            return rows.filter((r) => (!q.get('taskId') || r.taskId === q.get('taskId'))
              && (!q.get('agentId') || r.agentId === q.get('agentId')));
          },
          '/api/audit': () => {
            const rows = engine.getAudit();
            return rows.filter((r) => (!q.get('taskId') || r.taskId === q.get('taskId'))
              && (!q.get('action') || r.action === q.get('action'))
              && (!q.get('runId') || r.runId === q.get('runId')));
          },
          '/api/approvals': () => engine.getApprovals({
            status: q.get('status'), taskId: q.get('taskId'), kind: q.get('kind'),
          }),
          '/api/change-requests': () => engine.getChangeRequests(q.get('taskId')),
          '/api/decisions': () => engine.getDecisions(q.get('taskId')),
          '/api/bridges': () => engine.db.prepare('SELECT * FROM bridges ORDER BY agentId').all(),
          '/api/leases': () => engine.db.prepare(`SELECT taskId, assignee, status, leaseToken, leaseExpiresAt
            FROM tasks WHERE leaseToken IS NOT NULL ORDER BY taskId`).all(),
          '/api/threads': () => engine.getThreads(),
          '/api/inbox': () => ({ briefs: engine.getBriefs(), notifications: engine.notifier.messages }),
          '/api/dashboard': () => engine.getDashboard(),
          // P5-1 / P5-3：试运行观察（五项指标 + 四项结论 + 脏状态）。
          '/api/observe': () => buildObservation({
            db: engine.db, config: engine.config, workRoot: engine.workRoot, now: now(),
          }),
          '/api/observe/dirty': () => detectDirty({
            db: engine.db, config: engine.config, workRoot: engine.workRoot, now: now(),
          }),
          // P5-2：可调项清单 + 调整历史（旧值 → 新值可查）。
          '/api/config/tuning': () => ({
            tunable: Object.entries(TUNABLE).map(([key, spec]) => ({ key, ...spec })),
            history: tuneHistory(engine.db),
            overridesPath,
          }),
        };
        if (routes[pathname]) { json(res, 200, routes[pathname]()); return; }
        // 观察记录直接出 Markdown，方便浏览器里看 / 复制进周报。
        if (pathname === '/api/observe/report') {
          const obs = buildObservation({
            db: engine.db, config: engine.config, workRoot: engine.workRoot, now: now(),
          });
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(renderObservationMarkdown(obs));
          return;
        }
        if (pathname === '/api/activity') {
          const taskId = q.get('taskId');
          if (!taskId) { json(res, 400, { error: '缺少 taskId' }); return; }
          const activity = engine.getActivity(taskId);
          if (!activity) { json(res, 404, { error: '任务不存在' }); return; }
          json(res, 200, activity);
          return;
        }
        const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (approvalMatch) {
          const approval = engine.getApprovals().find((a) => a.approvalId === approvalMatch[1]);
          if (!approval) { json(res, 404, { error: '审批单不存在' }); return; }
          json(res, 200, approval);
          return;
        }
        const crMatch = pathname.match(/^\/api\/change-requests\/([^/]+)$/);
        if (crMatch) {
          const cr = engine.getChangeRequests().find((c) => c.changeRequestId === crMatch[1]);
          if (!cr) { json(res, 404, { error: '变更请求不存在' }); return; }
          json(res, 200, cr);
          return;
        }
        const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskMatch) {
          const task = engine.taskById(taskMatch[1]);
          if (!task) { json(res, 404, { error: '任务不存在' }); return; }
          json(res, 200, task);
          return;
        }
      }
      json(res, 404, { error: `没有这个端点：${method} ${pathname}` });
    } catch (error) {
      // 项目相关的拒绝要能被前端识别（缺项目 / 未知项目 / 缺规范），所以带上 code 与可选列表。
      const body = { error: String(error.message ?? error) };
      if (error?.code) body.code = error.code;
      if (Array.isArray(error?.available)) body.available = error.available;
      json(res, Number.isInteger(error?.status) ? error.status : 400, body);
    }
  });

  // SSE 用轮询事件表实现，避免与状态机事务耦合；新增事件推给所有已连接前端。
  let lastRowId = engine.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM events').get().n;
  const timer = setInterval(() => {
    if (sseClients.size === 0) {
      lastRowId = engine.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM events').get().n;
      return;
    }
    const rows = engine.db.prepare('SELECT rowid, * FROM events WHERE rowid > ? ORDER BY rowid').all(lastRowId);
    for (const row of rows) {
      lastRowId = row.rowid;
      const payload = `data: ${JSON.stringify({ eventId: row.eventId, type: row.type, taskId: row.taskId, agentId: row.agentId, createdAt: row.createdAt })}\n\n`;
      for (const client of sseClients) client.write(payload);
    }
  }, 400);
  server.on('close', () => { clearInterval(timer); sched.stop(); });
  server.recurring = rec;
  server.scheduler = sched;
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const demoCommand = `node "${path.join(ROOT, 'scripts', 'fake-agent.js')}"`;
  const env = { ...process.env };
  // 这两行只为「示例配置没写命令」时兜底：真配置自己写了 command 就用它的。
  if (!env.AICOMPANY_CEO_CMD) env.AICOMPANY_CEO_CMD = demoCommand;
  if (!env.AICOMPANY_WORKER_CMD) env.AICOMPANY_WORKER_CMD = demoCommand;
  // P6：允许用 AICOMPANY_CONFIG 指定另一份公司配置（例如接入真实 GUI 席位的专用配置）。
  // 注意：源码里不许出现具体产品名，所以这里只提「专用配置」，具体文件名写在文档里。
  const { config } = loadConfig(env.AICOMPANY_CONFIG ?? EXAMPLE_CONFIG_PATH, env);
  // 演示模式的判据要落在「实际加载的配置」上，不能只看环境变量有没有兜底：
  // 生产配置用的是自己的派单器，若报「演示模式」会让人误以为在跑假员工。
  const demo = (config.agents ?? []).some(
    (a) => String(a.adapter?.config?.command ?? '').includes('fake-agent'),
  );
  const dbPath = env.AICOMPANY_DB ?? path.join(ROOT, 'work', 'aicompany.db');
  const port = Number(env.AICOMPANY_PORT ?? 3100);
  const host = env.AICOMPANY_HOST ?? '127.0.0.1';
  // P6：带 GUI 席位的实例必须占位。两个控制面同时带 GUI 席位会互抢键鼠、还会串单，
  // 这不是「小心一点就行」的事，所以启动时就拦，宁可不起也不双开。
  // 占位要在「开数据库」之前判：被拒的那次不该在建库/建表上留下任何痕迹。
  const seatAgents = guiSeatAgents(config);
  let seat = null;
  if (seatAgents.length) {
    const seatFile = env.AICOMPANY_GUI_SEAT ?? path.join(ROOT, 'work', 'gui-seat.json');
    seat = createSeatClaim({ file: seatFile });
    const claimed = seat.claim({
      port, configPath: env.AICOMPANY_CONFIG ?? EXAMPLE_CONFIG_PATH,
      extra: { seats: seatAgents, dbPath },
    });
    if (!claimed.ok) {
      console.error(`[启动被拒] ${claimed.reason}`);
      console.error('如果确认那个进程已经该退出了，先把它停掉再启动；不要同时跑两个带 GUI 席位的实例。');
      process.exit(5);
    }
  }
  const db = openDb(dbPath);
  const dispatchMode = env.AICOMPANY_DISPATCH_MODE ?? 'inline';
  // P4-6：出站通道按配置来（web / noop / stdout 内置；im / webhook 需显式 URL）。
  const engine = createEngine({
    db, config, notifier: createNotifier(config.notifier ?? ['web']), dispatchMode,
    // 被「你刚动过键盘」拦下的卡，4 秒后自己再试一次，而不是让看板静默等一分钟的维护心跳。
    gateRetryMs: Number(env.AICOMPANY_GATE_RETRY_MS ?? 4000),
  });
  const server = createServer({
    engine, port, host, bridgeToken: env.AICOMPANY_BRIDGE_TOKEN ?? null,
    overridesPath: env.AICOMPANY_OVERRIDES ?? OVERRIDES_PATH,
    guiPauseFile: env.AICOMPANY_GUI_PAUSE ?? null,
    guiSeat: seat,
    deferRequests: env.AICOMPANY_REQUEST_ASYNC === '1',
  });
  const shutdown = () => {
    try { seat?.release(); } catch { /* 释放失败不影响退出 */ }
    // 挂着「等会儿再试」的定时器必须带走，否则退出前还会朝一个正在关的库写事件。
    try { engine.close(); } catch { /* 引擎没这方法就当没有 */ }
  };
  server.on('close', shutdown);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    try { process.on(sig, () => { shutdown(); server.close(); process.exit(0); }); } catch { /* 平台不支持就跳过 */ }
  }
  server.scheduler.start();
  // P6-5：维护心跳。闸门拦下的卡退回 todo 后需要有人再叫它，否则「等会儿再跑」就变成「永远不跑」。
  const maintenanceSec = Number(env.AICOMPANY_MAINTENANCE_SEC ?? 60);
  let maintenanceTimer = null;
  if (Number.isFinite(maintenanceSec) && maintenanceSec > 0) {
    maintenanceTimer = setInterval(() => {
      engine.reconcile({ olderThanMs: Math.max(15_000, maintenanceSec * 1000) })
        .then((r) => { if (r.requeued) console.log(`[维护心跳] 重新投递 ${r.requeued} 张卡`); })
        .catch((error) => console.log(`[维护心跳] 失败：${String(error.message ?? error)}`));
    }, maintenanceSec * 1000);
    if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();
    server.on('close', () => clearInterval(maintenanceTimer));
  }
  server.listen(port, host, () => {
    console.log(`AICompany Web Board: http://${host}:${port}`);
    console.log(`数据库：${dbPath}`);
    console.log(`派活方式：${dispatchMode}（inline 单机直调 / bridge 拉模式）`);
    if (seatAgents.length) console.log(`GUI 席位：${seatAgents.join(', ')}（已占位，防双开）`);
    if (demo) console.log('演示模式：使用本地 fake-agent，不调用任何外部模型、不烧额度。');
    if (dispatchMode === 'bridge') {
      console.log('bridge 模式：任务先排队，需另起一个 bridge 客户端来拉活（见 docs/P2-交付说明.md）。');
    }
  });
}
