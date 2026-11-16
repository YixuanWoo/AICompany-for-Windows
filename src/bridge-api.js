// P2-1 / P2-2 / P2-3：统一 API 的「本机 bridge 子集」。
// 依据：任务书 §9.1 / §9.2 / §9.3 / §9.4 —— 这不是另一套协议，只是 /api 下面的一组端点。

import {
  checkout, assertLease, releaseLease, renewLease, heartbeat, listBridges, isBridgeOnline,
} from './lease.js';
import { writeAudit } from './core.js';
import { nowIso } from './ids.js';

export const BRIDGE_ENDPOINTS = Object.freeze([
  { method: 'GET', path: '/api/bridge/inbox', purpose: '按席位拉待领任务（todo、无 lease、按 createdAt）' },
  { method: 'POST', path: '/api/bridge/checkout', purpose: 'lease 独占领取，抢不到 409' },
  { method: 'POST', path: '/api/bridge/renew', purpose: '续租：长活干不完时延长 lease，不换 token' },
  { method: 'POST', path: '/api/bridge/heartbeat', purpose: '上报心跳与本机可用状态' },
  { method: 'POST', path: '/api/bridge/progress', purpose: '进度报告，只留痕、0 唤醒' },
  { method: 'POST', path: '/api/bridge/complete', purpose: '完成报告回写，必须带 leaseToken' },
  { method: 'POST', path: '/api/bridge/change-request', purpose: '变更请求回写，必须带 leaseToken' },
  { method: 'POST', path: '/api/bridge/snapshot', purpose: '现场快照留痕（P4 完整档再挂起落盘）' },
  { method: 'GET', path: '/api/bridge/status', purpose: 'bridge 在线状态与待补投数量' },
  { method: 'GET', path: '/api/bridge/reviews', purpose: '按席位查「等我审」的卡（拉模式审查）' },
  { method: 'POST', path: '/api/bridge/review', purpose: '交审查结论（pass / reject），不需要 lease' },
  { method: 'POST', path: '/api/bridge/spawn', purpose: '子派活：把手里这张卡的一部分派给汇报子树里的人' },
]);

// 本地单机模式（绑定 127.0.0.1）默认免 token；跨机器必须显式配 AICOMPANY_BRIDGE_TOKEN。
export function assertBridgeToken(headers, expected) {
  if (!expected) return { ok: true, mode: 'localhost-no-token' };
  const raw = headers['x-bridge-token'] ?? headers.authorization ?? '';
  const got = String(raw).replace(/^Bearer\s+/i, '');
  return got === expected
    ? { ok: true, mode: 'token' }
    : { ok: false, status: 401, reason: 'bridge token 无效；跨机器请配置 AICOMPANY_BRIDGE_TOKEN' };
}

const reply = (status, data) => ({ status, data });

// now 可注入，便于「断机 30 分钟 / lease 过期」这类场景做确定性验收；
// 生产路径不传，默认取系统时钟。
export function createBridgeApi({ engine, token = null, onlineWindowSec = 60, now = () => new Date() }) {
  const db = engine.db;

  function inbox(agentId) {
    if (!agentId) return reply(400, { error: '缺 agentId' });
    const tasks = db.prepare(`SELECT t.*, p.instructions, p.acceptanceJson, p.inputJson
      FROM tasks t LEFT JOIN task_payload p ON p.taskId = t.taskId AND p.revision = t.revision
      WHERE t.status = 'todo' AND t.assignee = ? AND t.leaseToken IS NULL
      ORDER BY t.createdAt, t.rowid`).all(agentId).map((row) => ({
      taskId: row.taskId,
      title: row.title,
      mode: row.mode,
      assignee: row.assignee,
      revision: row.revision,
      instructions: row.instructions,
      acceptance: JSON.parse(row.acceptanceJson ?? '[]'),
      input: JSON.parse(row.inputJson ?? '{}'),
      origin: JSON.parse(row.originJson ?? 'null'),
      createdAt: row.createdAt,
    }));
    return reply(200, {
      agentId, tasks, count: tasks.length,
      online: isBridgeOnline(db, agentId, onlineWindowSec, now()), at: nowIso(),
    });
  }

  async function handle({ method, pathname, body = {}, query = new URLSearchParams() }) {
    if (method === 'POST' && pathname === '/api/bridge/heartbeat') {
      if (!body.agentId) return reply(400, { error: '缺 agentId' });
      return reply(200, heartbeat(db, {
        agentId: body.agentId, meta: body.meta ?? {}, onlineWindowSec, now: now(),
      }));
    }

    if (method === 'GET' && pathname === '/api/bridge/inbox') {
      return inbox(query.get('agentId'));
    }

    if (method === 'GET' && pathname === '/api/bridge/status') {
      const bridges = listBridges(db, onlineWindowSec, now());
      const queued = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'todo' AND leaseToken IS NULL").get().n;
      const leased = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE leaseToken IS NOT NULL').get().n;
      return reply(200, { bridges, queued, leased, onlineWindowSec, dispatchMode: engine.dispatchMode });
    }

    if (method === 'POST' && pathname === '/api/bridge/checkout') {
      if (!body.taskId || !body.agentId) return reply(400, { error: '缺 taskId / agentId' });
      const result = checkout(db, {
        taskId: body.taskId, agentId: body.agentId,
        runId: body.runId, ttlSec: body.ttlSec, now: now(),
      });
      return reply(result.status, result);
    }

    if (method === 'POST' && pathname === '/api/bridge/renew') {
      if (!body.taskId || !body.leaseToken) return reply(400, { error: '缺 taskId / leaseToken' });
      const result = renewLease(db, {
        taskId: body.taskId, leaseToken: body.leaseToken,
        ttlSec: body.ttlSec, now: now(),
      });
      return reply(result.status, result);
    }

    if (method === 'GET' && pathname === '/api/bridge/reviews') {
      const agentId = query.get('agentId');
      if (!agentId) return reply(400, { error: '缺 agentId' });
      const rows = engine.pendingReviews(agentId);
      return reply(200, {
        agentId,
        count: rows.length,
        tasks: rows.map((t) => ({
          taskId: t.taskId, title: t.title, assignee: t.assignee, kind: t.artifactKind ?? null,
          project: t.project ?? null, repo: t.repo ?? null, reviewBy: t.reviewer ?? null,
          updatedAt: t.updatedAt,
        })),
      });
    }

    // 审查结论：不要求 lease —— 审查人不是执行人，手里没有这张卡的租约。
    // 身份由 agentId 校验（必须是这张卡该由谁审），防止随便哪个席位把别人的活放过去。
    if (method === 'POST' && pathname === '/api/bridge/review') {
      if (!body.taskId || !body.agentId) return reply(400, { error: '缺 taskId / agentId' });
      if (!['pass', 'reject'].includes(body.verdict)) return reply(400, { error: 'verdict 只能是 pass / reject' });
      try {
        const out = engine.reviewTask(body.taskId, {
          reviewer: body.agentId, verdict: body.verdict,
          reason: body.reason ?? '', summary: body.summary ?? '', commit: body.commit ?? null,
        });
        return reply(200, { ok: true, ...out });
      } catch (error) {
        return reply(409, { ok: false, error: String(error.message ?? error) });
      }
    }

    if (method === 'POST' && pathname === '/api/bridge/spawn') {
      const assignerId = body.assignerId ?? body.agentId;
      if (!assignerId) return reply(400, { error: '缺 agentId（谁在拆这张卡）' });
      try {
        const child = engine.spawnChild({ ...body, assignerId });
        return reply(201, { ok: true, ...child });
      } catch (error) {
        return reply(409, { ok: false, error: String(error.message ?? error) });
      }
    }

    // 以下三类回写一律先验 lease（§9.2）；过期 token 一律拒绝（§9.4）。
    if (method === 'POST' && ['/api/bridge/progress', '/api/bridge/complete',
      '/api/bridge/change-request', '/api/bridge/snapshot'].includes(pathname)) {
      const lease = assertLease(db, body.taskId, body.leaseToken, now());
      if (!lease.ok) return reply(lease.status, { error: lease.reason });

      if (pathname === '/api/bridge/progress') {
        // ProgressReport 是覆盖写，绝不触发事件、绝不唤醒任何人。
        writeAudit(db, { actor: 'bridge', action: 'progress_only', newValue: body.taskId });
        return reply(200, { ok: true, wakes: 0 });
      }

      if (pathname === '/api/bridge/snapshot') {
        writeAudit(db, { actor: 'bridge', action: 'snapshot', newValue: body.taskId });
        return reply(200, { ok: true, note: 'P2 只留痕；挂起与现场落盘属 P4 完整档' });
      }

      if (pathname === '/api/bridge/change-request') {
        const submitted = engine.submitChangeRequest({
          ...(body.changeRequest ?? {}), taskId: body.taskId, runId: body.runId,
        });
        const pumped = await engine.pump();
        return reply(201, { ...submitted, ...pumped });
      }

      const task = engine.taskById(body.taskId);
      const agentId = body.agentId ?? task?.assignee ?? 'unknown';
      const accepted = await engine.acceptCompletion({
        taskId: body.taskId, agentId, runId: body.runId, report: body.report ?? {},
      });
      releaseLease(db, body.taskId, body.leaseToken);
      return reply(accepted.accepted ? 200 : 422, { ok: accepted.accepted, ...accepted });
    }

    return reply(404, { error: `没有这个 bridge 端点：${method} ${pathname}` });
  }

  return { handle, inbox, token, onlineWindowSec };
}
