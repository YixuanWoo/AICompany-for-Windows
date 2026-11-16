// P1 最小闭环引擎：路由 → 建卡 → 事件泵 → Run Policy → adapter → 报告校验 → 验收 → 简报。
// 一条需求提交后由 pump() 自动连续推进，不需要第二条命令（任务书 §4.4 / §7.3 / §12 P1）。

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, atomicWriteJson, decisionPath, revisionPath, taskDir, snapshotPath } from './ids.js';
import { validate, loadSchema } from './validate.js';
import {
  seedAgents, emit, nextEvent, markProcessed, pendingEvents,
  transition as rawTransition, writeAudit, compensationScan,
} from './core.js';
import { getAdapter, availableAdapterTypes } from './adapters.js';
import { isBridgeOnline } from './lease.js';
import { DEFAULTS, CAPABILITIES, CEO_OUTPUT_KINDS, RECURRING_KINDS, ARTIFACT_KINDS, HANDOFF_TARGETS } from './enums.js';
import { createChannels } from './channels.js';
import { ensureAllQuotas, checkQuota, consumeQuota, quotaState, resetQuota } from './quota.js';
import { assertMayAssign, resolveDecisionMaker, rankCandidates, ceoOf, isInSubtree, ancestors } from './org.js';
import {
  normalizeDifficulty, canTake, ceilingOf, describeSeat, describeDifficulty,
  DEFAULT_DIFFICULTY, NO_CEILING, DIFFICULTIES,
} from './difficulty.js';
import { createApproval, getApproval, listApprovals, closeApproval, pendingApprovals, stampRequestPayload } from './approvals.js';
import { buildSnapshot } from './snapshot.js';
import { assertProject, buildProjectContext, buildMemoryRecord, appendMemory,
  listProjects as listProjectEntries, memoryLimitOf, readRecentMemory } from './projects.js';
import { repoEntry, findRepoForPath, assertRepo } from './repos.js';
import { looksLikeCode } from './org-chart.js';
import {
  deliverTask, runningProcesses, lastDeliveryOf, appendDeliveryLog, DELIVERY_SCHEMA,
} from './deliver.js';
import { nextFireAt } from './rrule.js';
import {
  DEFAULT_SESSION_POLICY, describeCeoSession, markSessionWarned, readCeoSession, rotateCeoSession,
} from './ceo-session.js';

export function createNotifier(kind = 'web') {
  // P4-6：可传单个通道名或数组；web / noop / stdout 内置，im / webhook 需显式地址。
  return createChannels(Array.isArray(kind) ? kind : [kind]);
}

const shortId = () => randomUUID().slice(0, 8);

// 「交给董事会自己看」的各种写法：人不必记字段值，写哪个都认。
const BOARD_ALIASES = new Set(['human', 'board', 'me', 'self', '我', '董事会', '本人']);

// 按协议声明裁剪外部来源的字段（adapter 返回值常带内部标记，不能直接当业务单据用）。
function pickSchemaFields(kind, data) {
  const schema = loadSchema(kind);
  if (!schema?.properties || !data || typeof data !== 'object') return data ?? {};
  const out = {};
  for (const key of Object.keys(schema.properties)) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

export function createEngine({
  db, config, notifier = createNotifier('web'), maxSteps = 80,
  dispatchMode = 'inline', approvalHandlers = {}, workRoot = null, now = () => new Date(),
  // 被「临时条件」拦下的卡多久自己再试一次（毫秒）。0 = 关闭，只靠维护心跳。
  gateRetryMs = 0,
  // G2：卡进终态时通知外部（由 server 接到循环引擎）。钩子失败只留审计，不影响卡的状态。
  taskTerminalHook = null,
}) {
  // inline = P1 单机直调 adapter（默认，本地演示一等公民）；
  // bridge = P2 拉模式，控制面只排队，等本机 bridge 来 checkout。两者共用同一套统一 API。
  if (!['inline', 'bridge'].includes(dispatchMode)) {
    throw new Error(`未知 dispatchMode ${dispatchMode}；可用：inline / bridge`);
  }
  const clock = () => now();
  const clockIso = () => clock().toISOString();
  const workDir = workRoot ?? config.workRoot ?? path.resolve(process.cwd(), 'work');
  seedAgents(db, config);
  // P4-1：开引擎时把本周期账本对齐（缺账开账、改配额跟上配置，旧账不删）。
  ensureAllQuotas(db, config, { now: clock() });
  const ceoId = () => config.agents.find((a) => a.isCEO === true)?.id;
  const firstWorker = () => config.agents.find((a) => a.isCEO !== true)?.id;
  const cfgFor = (id) => config.agents.find((a) => a.id === id);

  function emitEvent(options) {
    return emit(db, options);
  }

  // 卡间依赖：库里存 JSON 数组，读出来统一成字符串数组；坏数据（NULL / 非法 JSON）一律当「没依赖」，
  // 绝不能因为一行脏数据把整条链堵死。
  function dependsOnOf(row) {
    if (!row?.dependsOn) return [];
    try {
      const parsed = JSON.parse(row.dependsOn);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x) : [];
    } catch { return []; }
  }

  // 前置卡的真实状态：done 才算满足；不存在（被删）也算满足，否则永远放不出来。
  function unmetDependencies(row) {
    return dependsOnOf(row).filter((id) => {
      const up = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(id);
      return up ? up.status !== 'done' : false;
    });
  }

  function taskById(taskId) {
    const row = db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(taskId);
    if (!row) return null;
    const payload = db.prepare('SELECT * FROM task_payload WHERE taskId = ? AND revision = ?')
      .get(taskId, row.revision) ?? {};
    return {
      ...row,
      project: row.project ?? null,
      instructions: payload.instructions,
      acceptance: JSON.parse(payload.acceptanceJson ?? '[]'),
      input: JSON.parse(payload.inputJson ?? '{}'),
      origin: JSON.parse(row.originJson ?? 'null'),
      retry: { max: 2 },
    };
  }

  /**
   * 董事会原话里有没有明确说「这活我要亲自看」。
   * 宁可漏认也不误判：误判会把卡莫名卡在人这里等拍板；漏认最多回到默认（董事会直投本来就是落盘）。
   * 否定说法先排除——「不用给我看」不能被认成「给我看」。
   */
  function detectBoardReview(text) {
    const s = String(text ?? '');
    if (!s) return false;
    if (/(不用|不要|无需|不必|别|甭)(给我|我)?\s*(审|看|批|过目|确认)/.test(s)) return false;
    return /(给我审|交我审|我来审|我亲自审|我自己审|我自己看|让我审|我先看|我先过目|等我审|等我批|等我过目|给我过目|我过目|给我看一眼|给我看结果|董事会审)/.test(s);
  }

  /** 下单时写的交付路由：认不出就报错，绝不静默当没写（写错了要当场知道）。 */
  function assertHandoff(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw === 'auto') return null;
    const normalized = normalizeHandoff(raw);
    if (!normalized) throw new Error(`handoff 只能是 land / review / escalate（写 ceo 等同 review）：${raw}`);
    return normalized;
  }

  /**
   * 指定的审查人必须是真实存在的岗位 / 担任者，并归一成 agent id（认人不认位子）。
   * 'human'（董事会自己审）是合法值：董事会是最高权力，可以要自己看。
   */
  function assertReviewSeat(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw === 'auto') return null;
    if (BOARD_ALIASES.has(raw.toLowerCase())) return 'human';
    const hit = (config.agents ?? []).find((a) => a.id === raw || a.postTitle === raw);
    if (!hit) {
      const seats = (config.agents ?? []).map((a) => a.postTitle ?? a.id).join(', ');
      throw new Error(`reviewBy 指向不存在的岗位：${raw}（现有：${seats}；要董事会自己审写 human）`);
    }
    return hit.id;
  }

  /** 派活人写错了路由参数：不炸整单，留痕后当没写（走默认推导）。 */
  function softRoute(fn, { action, who, taskId, field, value }) {
    try {
      return fn();
    } catch (error) {
      writeAudit(db, {
        actor: who ?? 'control-plane', action,
        newValue: `${field}=${String(value ?? '').slice(0, 60)}|${String(error.message).slice(0, 200)}`.slice(0, 300),
        taskId,
      });
      return null;
    }
  }

  function buildCard({
    requestId, title, role = 'general', assignee, mode = 'delegate',
    addressedTo = null, assignedBy = 'human', instructions = '按 brief 执行并写出完成报告。',
    acceptance = ['completion.json 通过 schema 校验且 status = success'],
    parentTaskId = null, taskId = `T-${shortId()}`, status = 'todo',
    threadId = null, assignerId = null, difficulty = DEFAULT_DIFFICULTY, project = null,
    origin = null, dependsOn = [], repo = null, reviewBy = null,
    handoff = null, allowSelfLand = false,
  }) {
    // P4-3：agent 之间派活只能派进自己的汇报子树；人是董事会，不受此限（§7.4）。
    if (assignerId && assignerId !== assignee) {
      const allowed = assertMayAssign(config, assignerId, assignee);
      if (!allowed.ok) throw new Error(`跨子树派活被拒绝：${allowed.reason}`);
    }
    // 仓库写错要在建卡时就炸，不能等执行岗干完才发现「这个 repo 根本不存在」。
    if (repo) assertRepo({ config, requested: repo });
    return {
      schema: 'aicompany.task/v1', taskId, requestId, parentTaskId, title, role,
      // direct 默认抄送 CEO，但直投对象本身就是 CEO 时不能既在 addressedTo 又在 cc（§6C.1）。
      revision: 1, mode, addressedTo,
      cc: mode === 'direct' && assignee !== ceoId() ? [ceoId()] : [],
      assignedBy, threadId: threadId ?? null, assignee,
      reportsTo: cfgFor(assignee)?.reportsTo ?? null,
      status, priority: 'normal', difficulty: normalizeDifficulty(difficulty), project,
      createdAt: nowIso(), lease: null,
      budget: { maxRuns: 3, maxMinutes: 30, quotaUnits: 1 },
      input: { files: [] }, instructions, acceptance,
      completionReportPath: 'output/completion.json',
      retry: { attempt: 0, max: 2, backoffSec: 0 }, tags: [], origin,
      // 仓库（代码在哪、推哪）与验收人：与项目解耦，都是可选。
      repo: repo ?? null,
      reviewBy: reviewBy ?? null,
      // 发布者：谁下的这张卡。交付路由默认按它算（发布者=董事会 → 落盘；= agent → 回发布者审）。
      // 'human' 是董事会；有真 agent id 就记 id（岗位与担任者分开，认人不认位子）。
      assignerId: assignerId ?? (assignedBy === 'human' ? 'human' : null),
      // 发布者显式指定的交付路由（land / review / escalate）。空 = 按发布者推导。
      handoff: handoff ?? null,
      // 发布者授权「执行者可以自己判落盘」。默认关：上级派的活，员工无权替上级免审。
      allowSelfLand: allowSelfLand === true,
      // 卡间依赖：前置卡的 taskId。空数组 = 没依赖（默认并行）。
      dependsOn: Array.isArray(dependsOn) ? dependsOn.filter((x) => typeof x === 'string' && x) : [],
    };
  }

  function insertCard(card, wakeTarget, { dispatch = true } = {}) {
    const checked = validate('task', card);
    if (!checked.ok) throw new Error(`任务卡不合法：${checked.errors.join('; ')}`);
    db.prepare(`INSERT INTO tasks
      (taskId, requestId, parentTaskId, title, role, assignee, status, mode, addressedTo,
       assignedBy, assignerId, handoff, allowSelfLand, revision, threadId, attempt, priority,
       difficulty, project, repo, reviewBy,
       createdAt, updatedAt, originJson, dependsOn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      card.taskId, card.requestId, card.parentTaskId, card.title, card.role,
      card.assignee, card.status, card.mode, card.addressedTo, card.assignedBy,
      card.assignerId ?? null, card.handoff ?? null, card.allowSelfLand === true ? 1 : 0,
      card.revision, card.threadId, card.priority, normalizeDifficulty(card.difficulty),
      card.project ?? null, card.repo ?? null, card.reviewBy ?? null,
      card.createdAt, card.createdAt, JSON.stringify(card.origin ?? null),
      card.dependsOn?.length ? JSON.stringify(card.dependsOn) : null,
    );
    db.prepare(`INSERT INTO task_payload
      (taskId, revision, instructions, acceptanceJson, completionReportPath, inputJson)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      card.taskId, card.revision, card.instructions, JSON.stringify(card.acceptance),
      card.completionReportPath, JSON.stringify(card.input ?? { files: [] }),
    );
    writeAudit(db, { actor: card.assignedBy, action: 'create_task', newValue: card.taskId, taskId: card.taskId });
    // 有前置卡的先建不派：等上游 done 由 releaseDependents 放行，避免「还没接管就先定计划」。
    if (dispatch === false) return card;
    emitEvent({
      type: 'issue_assigned', taskId: card.taskId, agentId: wakeTarget,
      payload: { wakeReason: 'issue_assigned', mode: card.mode },
      dedupeKey: `assign:${card.taskId}:1`,
    });
    return card;
  }

  function assertAssignable(agentId, { consume = false, difficulty = null } = {}) {
    const row = db.prepare('SELECT * FROM agents WHERE agentId = ?').get(agentId);
    if (!row) throw new Error(`席位不存在：${agentId}；候选：${getAgentCandidates().map((a) => a.agentId).join(', ')}`);
    if (row.status !== 'active') throw new Error(`席位 ${agentId} 状态为 ${row.status}，不可派活`);
    const caps = JSON.parse(row.capabilities ?? '[]');
    if (!caps.includes('execute') && !caps.includes('delegate')) {
      throw new Error(`席位 ${agentId} 缺少所需能力；候选：${getAgentCandidates().map((a) => a.agentId).join(', ')}`);
    }
    // G3：难度也在这里卡。配额满了拒绝人点名，难度接不了同样拒绝——同一个出口，别让人以为能绕。
    if (difficulty) {
      const ceiling = ceilingOf({ id: agentId, maxDifficulty: row.maxDifficulty });
      const seat = { agentId, maxDifficulty: ceiling };
      if (!canTake(seat, difficulty)) {
        const able = rankCandidates(getAgentCandidates(), { needCapability: 'execute', difficulty })
          .map((c) => `${c.agentId}(≤ ${c.ceiling})`).join(', ');
        throw new Error(
          `席位 ${agentId} 只接 ≤ ${ceiling}，这张卡是 ${difficulty}（${describeDifficulty(difficulty)}）；`
          + `能接的席位：${able || `无（给某个席位配 maxDifficulty: ${difficulty}，或把卡降到 ${ceiling}）`}`,
        );
      }
    }
    // P4-1：配额判定统一走 quota.js（80% 预警一次、100% 停派并通知）。
    const cfg = cfgFor(agentId);
    const verdict = checkQuota(db, cfg ?? { id: agentId, quotaDaily: row.quotaDaily }, { now: clock(), quota: config.quota });
    if (verdict.warnNow) notifyQuota('warning', agentId, verdict.state);
    if (!verdict.ok) {
      notifyQuota('exhausted', agentId, verdict.state);
      throw new Error(`席位 ${agentId} ${verdict.reason}`);
    }
    return row;
  }

  function notifyQuota(level, agentId, state) {
    writeAudit(db, {
      actor: 'scheduler', action: level === 'exhausted' ? 'quota_exhausted' : 'quota_warning',
      newValue: `${agentId} ${state.used}/${state.limit} (${Math.round(state.ratio * 100)}%)`,
    });
    notifier.send({
      title: level === 'exhausted' ? `配额触顶：${agentId} 已停派` : `配额预警：${agentId} 用掉 ${Math.round(state.ratio * 100)}%`,
      body: `本周期 ${state.period} 已用 ${state.used}/${state.limit}。` +
        (level === 'exhausted' ? '该席位停止接新活；换人或等周期重置后可恢复。' : '接近上限，建议留意。'),
      scene: 'quota',
    });
  }

  // 记完一笔账立刻判一次阈值：否则「刚好用到 80%」要等下一次派活才报，等于不报。
  // 与 checkQuota 共用同一组 warnNotifiedAt / stopNotifiedAt 去重位，一个周期各只发一次。
  function afterQuotaConsume(agentId) {
    const cfg = cfgFor(agentId);
    const verdict = checkQuota(db, cfg ?? { id: agentId }, { now: clock(), quota: config.quota });
    if (verdict.warnNow) notifyQuota('warning', agentId, verdict.state);
    if (verdict.stopNow) notifyQuota('exhausted', agentId, verdict.state);
  }

  function getAgentCandidates() {
    const rows = db.prepare(`SELECT a.agentId, a.displayName, a.isCEO, a.capabilities, a.status,
      a.reportsTo, a.escalationTo, a.maxDifficulty, a.postTitle, a.holderName, a.holderKind, a.holderId
      FROM agents a ORDER BY a.isCEO DESC, a.agentId`).all();
    // 同一个 agent 可以兼任多个岗位：这里数一下每个担任者挂了几席，看板据此标「兼任」。
    const postsPerHolder = new Map();
    for (const r of rows) {
      if (r.holderId) postsPerHolder.set(r.holderId, (postsPerHolder.get(r.holderId) ?? 0) + 1);
    }
    return rows
      .map((row) => {
        const state = quotaState(db, row.agentId, { now: clock(), periodHours: config.quota?.periodHours }) ?? {
          used: 0, limit: 0, warnAt: 0,
        };
        const busy = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE agentId = ? AND status = 'running'").get(row.agentId).n > 0;
        return {
          agentId: row.agentId, displayName: row.displayName, isCEO: Boolean(row.isCEO),
          // 岗位（席位名）与担任者（谁在干）分开返回，看板据此分两行显示，不再混成一个名字。
          postTitle: row.postTitle ?? row.displayName ?? row.agentId,
          holderName: row.holderName ?? null,
          holderKind: row.holderKind ?? null,
          holderId: row.holderId ?? null,
          holderPostCount: row.holderId ? (postsPerHolder.get(row.holderId) ?? 1) : 1,
          capabilities: JSON.parse(row.capabilities ?? '[]'), status: row.status,
          reportsTo: row.reportsTo, escalationTo: row.escalationTo,
          // G3：老库里这一列可能是 NULL（迁移前建的库 / 迁移后没重启过），统一按「不设限」解释。
          maxDifficulty: ceilingOf({ id: row.agentId, maxDifficulty: row.maxDifficulty }),
          quotaUsed: state.used, quotaLimit: state.limit, warnAt: state.warnAt,
          quotaRemaining: Math.max(0, state.limit - state.used),
          isBusy: busy,
        };
      });
  }

  const STYLE_WAKE = Object.freeze({ readonly: 'never', rollCall: 'onRollCall', full: 'onMessage' });

  function createThread(req, mode, requestId) {
    // 同一 requestId 重复投递只建一个协作空间，跟建卡共用幂等口径（§7.1）。
    const existing = db.prepare('SELECT threadId FROM threads WHERE requestId = ?').get(requestId);
    if (existing) {
      return { duplicate: true, requestId, threadId: existing.threadId, mode, taskCreated: false };
    }
    // P4-7：meeting 的点名三档（readonly / rollCall / full），full 必须二次确认（§6C.6）。
    const style = mode === 'meeting'
      ? (req.style ?? config.interaction?.meeting?.defaultStyle ?? 'rollCall')
      : 'readonly';
    if (mode === 'meeting' && !Object.keys(STYLE_WAKE).includes(style)) {
      throw new Error(`未知会议档位 ${style}；可用：${Object.keys(STYLE_WAKE).join(', ')}`);
    }
    const participantAgents = (req.participants ?? [req.addressedTo].filter(Boolean))
      .filter((id) => id !== 'you');
    for (const id of participantAgents) {
      if (!cfgFor(id)) throw new Error(`协作空间参与者不存在：${id}`);
    }
    const estimatedWakes = style === 'readonly' ? 0
      : (style === 'full' ? participantAgents.length + 1 : Math.min(2, participantAgents.length));
    if (mode === 'meeting' && style === 'full'
      && (config.interaction?.meeting?.fullRequiresConfirm ?? true) && req.confirm !== true) {
      throw new Error(`full 需要二次确认：会议室一开就是全员议事，唤醒约 ${estimatedWakes} 次（含汇总）；确认请传 confirm: true`);
    }
    const threadId = `TH-${shortId()}`;
    const thread = {
      schema: 'aicompany.thread/v1', threadId, mode,
      title: req.title ?? String(req.text ?? '协作').slice(0, 40),
      sourceTaskId: req.sourceTaskId ?? null,
      participants: ['you', ...participantAgents],
      wakePolicy: req.wakePolicy ?? STYLE_WAKE[style],
      ceoVisibility: mode === 'meeting' ? (req.ceoVisibility ?? 'cc') : 'none',
      sharedFiles: [], ttlDays: config.interaction?.thread?.ttlDays ?? 30, state: 'active',
      createdAt: clockIso(), lastActiveAt: clockIso(), archivedAt: null, promotedTo: null,
    };
    const checked = validate('thread', thread);
    if (!checked.ok) throw new Error(`协作空间不合法：${checked.errors.join('; ')}`);
    db.prepare(`INSERT INTO threads
      (threadId, requestId, mode, title, participantsJson, wakePolicy, ceoVisibility, ttlDays, state, createdAt, lastActiveAt, promotedTo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      thread.threadId, requestId, thread.mode, thread.title, JSON.stringify(thread.participants),
      thread.wakePolicy, thread.ceoVisibility, thread.ttlDays, thread.state,
      thread.createdAt, thread.lastActiveAt,
    );
    db.prepare(`INSERT INTO thread_messages (messageId, threadId, author, runId, body, createdAt)
      VALUES (?, ?, 'human', NULL, ?, ?)`).run(
      `MSG-${shortId()}`, threadId, String(req.text ?? ''), thread.createdAt,
    );
    emitEvent({ type: 'thread_message', taskId: null, payload: { threadId, wakePolicy: thread.wakePolicy } });
    writeAudit(db, { actor: 'human', action: 'create_thread', newValue: `${mode}:${style}` });
    return { requestId, mode, style, threadId, wakePolicy: thread.wakePolicy, estimatedWakes, taskCreated: false };
  }

  function threadById(threadId) {
    const row = db.prepare('SELECT * FROM threads WHERE threadId = ?').get(threadId);
    if (!row) return null;
    const messages = db.prepare('SELECT * FROM thread_messages WHERE threadId = ? ORDER BY rowid').all(threadId);
    return { ...row, participants: JSON.parse(row.participantsJson ?? '[]'), messages };
  }

  function postThreadMessage(threadId, body = {}) {
    const thread = db.prepare('SELECT * FROM threads WHERE threadId = ?').get(threadId);
    if (!thread) throw new Error(`协作空间不存在：${threadId}`);
    if (thread.state !== 'active') throw new Error(`协作空间已归档：${threadId}（归档后不再收发消息）`);
    const messageId = `MSG-${shortId()}`;
    db.prepare(`INSERT INTO thread_messages (messageId, threadId, author, runId, body, createdAt)
      VALUES (?, ?, ?, NULL, ?, ?)`).run(
      messageId, threadId, body.author ?? 'human', String(body.text ?? ''), clockIso(),
    );
    db.prepare('UPDATE threads SET lastActiveAt = ? WHERE threadId = ?').run(clockIso(), threadId);
    emitEvent({
      type: 'thread_message', taskId: null,
      payload: { threadId, messageId, wakePolicy: thread.wakePolicy },
    });
    writeAudit(db, { actor: body.author ?? 'human', action: 'thread_message', newValue: threadId });

    // P4-7 点名三档：never = 只留痕；onRollCall = 显式点名才醒；onMessage = 每条都醒（会议 full）。
    // 唤醒走事件泵（thread_wake），与任务派活同一条链路，发消息本身不阻塞。
    const participants = JSON.parse(thread.participantsJson ?? '[]').filter((id) => id !== 'you');
    let targets = [];
    if (thread.wakePolicy === 'onMessage') targets = participants;
    else if (thread.wakePolicy === 'onRollCall' && body.rollCall === true) {
      targets = (Array.isArray(body.agents) && body.agents.length ? body.agents : participants).slice(0, 2);
    }
    for (const agentId of targets) {
      emitEvent({
        type: 'thread_wake', taskId: null, agentId,
        payload: { threadId, reason: 'thread_message', note: String(body.text ?? '') },
        dedupeKey: `thread-wake:${messageId}:${agentId}`,
      });
    }
    return { threadId, messageId, wakes: 0, queued: targets.length, taskCreated: false };
  }

  // 协作唤醒：不建卡、不验收，但照常走 Run Policy 与配额（§8.3 / §7.5）。
  async function wakeThread(threadId, agentId, { reason = 'roll_call', note = '' } = {}) {
    const thread = db.prepare('SELECT * FROM threads WHERE threadId = ?').get(threadId);
    if (!thread) return { ok: false, reason: '协作空间不存在' };
    const policy = runPolicy(agentId, null, reason);
    if (!policy.ok) {
      writeAudit(db, { actor: 'scheduler', action: 'wake_rejected', newValue: `${agentId}:${policy.reason}` });
      return { ok: false, reason: policy.reason };
    }
    const cfg = cfgFor(agentId);
    if (!cfg) return { ok: false, reason: `配置里没有席位 ${agentId}` };
    const runId = `R-${shortId()}`;
    db.prepare(`INSERT INTO runs (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt)
      VALUES (?, NULL, ?, ?, 'running', 1, 1, ?)`).run(runId, agentId, reason, clockIso());
    const mod = getAdapter(cfg.adapter.type);
    const ctx = {
      runId, wakeReason: reason, taskId: null, task: null,
      agent: { id: agentId, isCEO: Boolean(cfg.isCEO), capabilities: cfg.capabilities ?? [] },
      company: { agents: config.agents.map((a) => ({ id: a.id, isCEO: a.isCEO })) },
      adapterConfig: { ...(cfg.adapter?.config ?? {}), workRoot: cfg.adapter?.config?.workRoot ?? workDir },
      extra: { threadId, note, participants: JSON.parse(thread.participantsJson ?? '[]') },
    };
    let result = {};
    try {
      if (typeof mod.execute === 'function') {
        const out = await mod.execute(ctx);
        result = out ?? {};
      }
    } catch (error) {
      db.prepare("UPDATE runs SET status = 'failed', finishedAt = ? WHERE runId = ?").run(clockIso(), runId);
      writeAudit(db, { actor: agentId, action: 'thread_wake_failed', newValue: String(error.message), runId });
      return { ok: false, reason: String(error.message) };
    }
    const reply = String(result.result?.text ?? result.result?.summary ?? result.text ?? result.summary
      ?? result.result?.reply ?? '(已发言，无正文)');
    db.prepare(`INSERT INTO thread_messages (messageId, threadId, author, runId, body, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`MSG-${shortId()}`, threadId, agentId, runId, reply, clockIso());
    db.prepare('UPDATE threads SET lastActiveAt = ? WHERE threadId = ?').run(clockIso(), threadId);
    db.prepare("UPDATE runs SET status = 'success', finishedAt = ? WHERE runId = ?").run(clockIso(), runId);
    consumeQuota(db, agentId, 1, { now: clock(), periodHours: config.quota?.periodHours });
    afterQuotaConsume(agentId);
    writeAudit(db, { actor: agentId, action: 'thread_wake', newValue: `${threadId}:${reason}`, runId });
    return { ok: true, runId, reply };
  }

  // 点名：readonly 0 唤醒；rollCall 点几醒几（最多 2）；full 全员 + 一次汇总（需确认）。
  async function rollCall(threadId, { agents = [], style = 'rollCall', confirm = false } = {}) {
    const thread = db.prepare('SELECT * FROM threads WHERE threadId = ?').get(threadId);
    if (!thread) throw new Error(`协作空间不存在：${threadId}`);
    if (thread.state !== 'active') throw new Error(`协作空间已归档：${threadId}`);
    const participants = JSON.parse(thread.participantsJson ?? '[]').filter((id) => id !== 'you');
    if (style === 'readonly') {
      writeAudit(db, { actor: 'human', action: 'roll_call_readonly', newValue: threadId });
      return { threadId, style, wakes: 0, note: 'readonly 公告：全员可读，零唤醒' };
    }
    if (style === 'full') {
      if ((config.interaction?.meeting?.fullRequiresConfirm ?? true) && confirm !== true) {
        throw new Error(`full 需要二次确认：预计唤醒 ${participants.length + 1} 次（含汇总）`);
      }
      let wakes = 0;
      for (const id of participants) {
        const r = await wakeThread(threadId, id, { reason: 'roll_call' });
        if (r.ok) wakes += 1;
      }
      const summarizer = ceoId();
      if (summarizer) {
        const r = await wakeThread(threadId, summarizer, { reason: 'meeting_summary' });
        if (r.ok) wakes += 1;
        if (r.ok) {
          db.prepare(`INSERT INTO thread_messages (messageId, threadId, author, runId, body, createdAt)
            VALUES (?, ?, 'summary', ?, ?, ?)`).run(
            `MSG-${shortId()}`, threadId, r.runId, `汇总（${summarizer}）：${r.reply}`, clockIso(),
          );
        }
      }
      return { threadId, style, wakes, note: 'full 全员议事 + 一次汇总' };
    }
    const targets = (agents.length ? agents : participants).slice(0, 2);
    const results = [];
    for (const id of targets) {
      results.push({ id, ...(await wakeThread(threadId, id, { reason: 'roll_call' })) });
    }
    return {
      threadId, style: 'rollCall',
      wakes: results.filter((r) => r.ok).length,
      replies: results.map((r) => ({ agentId: r.id, ok: r.ok, runId: r.runId ?? null, reason: r.reason ?? null })),
    };
  }

  // 唯一出口：把定稿显式、单向提升成任务卡；反向一律拒绝（§6C.5）。
  async function promoteThread(threadId, { title, assignee, instructions, acceptance } = {}) {
    const thread = db.prepare('SELECT * FROM threads WHERE threadId = ?').get(threadId);
    if (!thread) throw new Error(`协作空间不存在：${threadId}`);
    if (thread.promotedTo) throw new Error('该协作空间已提升过，promote 只能做一次（单向不可逆）');
    if (thread.state !== 'active') throw new Error('只有 active 的协作空间可以提升');
    if (!assignee) throw new Error('promote 必须显式指定 assignee（不替人猜）');
    assertAssignable(assignee);
    const card = buildCard({
      requestId: `REQ-PROMOTE-${shortId()}`, title: title ?? thread.title,
      assignee, mode: 'direct', addressedTo: assignee, assignedBy: 'human',
      instructions: instructions ?? '按协作空间里的定稿执行并写出完成报告。',
      acceptance, threadId: thread.threadId,
    });
    insertCard(card, assignee);
    db.prepare('UPDATE threads SET state = ?, archivedAt = ?, promotedTo = ? WHERE threadId = ?')
      .run('archived', clockIso(), card.taskId, threadId);
    writeAudit(db, { actor: 'human', action: 'promote_thread', oldValue: threadId, newValue: card.taskId });
    // 提升即派活：跟 submit 一样一次调用就把卡推到终态，别让人再补一次 pump。
    await pump();
    return {
      threadId, taskId: card.taskId, promotedTo: card.taskId, state: 'archived',
      taskStatus: db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(card.taskId)?.status ?? null,
    };
  }

  function archiveThread(threadId, { reason = '人工归档' } = {}) {
    const thread = db.prepare('SELECT * FROM threads WHERE threadId = ?').get(threadId);
    if (!thread) throw new Error(`协作空间不存在：${threadId}`);
    if (thread.state === 'archived') return { threadId, state: 'archived', changed: false };
    db.prepare('UPDATE threads SET state = ?, archivedAt = ? WHERE threadId = ?')
      .run('archived', clockIso(), threadId);
    writeAudit(db, { actor: 'human', action: 'archive_thread', newValue: `${threadId}:${reason}` });
    return { threadId, state: 'archived', changed: true, archivedAt: clockIso() };
  }

  // TTL 到点自动归档：只改状态，不删任何消息或文件（§6C.5 / §16 R15）。
  function archiveStaleThreads({ now = clock() } = {}) {
    const rows = db.prepare("SELECT * FROM threads WHERE state = 'active'").all();
    const archived = [];
    for (const row of rows) {
      const ttlDays = row.ttlDays ?? config.interaction?.thread?.ttlDays ?? 30;
      const ageDays = (now.getTime() - Date.parse(row.lastActiveAt ?? row.createdAt)) / 86_400_000;
      if (ageDays >= ttlDays) {
        db.prepare('UPDATE threads SET state = ?, archivedAt = ? WHERE threadId = ?')
          .run('archived', now.toISOString(), row.threadId);
        writeAudit(db, { actor: 'scheduler', action: 'archive_thread_ttl', newValue: `${row.threadId}:${Math.floor(ageDays)}天` });
        archived.push(row.threadId);
      }
    }
    return { archived, scanned: rows.length };
  }

  function pickAssignee(difficulty = DEFAULT_DIFFICULTY) {
    // §6C.4 ③：默认只推荐不替人选；这里只在 autoAssign: true 时被调用。
    // G3：先按难度筛掉接不了的，再按「刚够用」优先 —— 简单活不占用强席位。
    const ranked = rankCandidates(getAgentCandidates(), { needCapability: 'execute', difficulty });
    if (!ranked.length) {
      throw new Error(`没有能接 ${difficulty}（${describeDifficulty(difficulty)}）的执行席位`
        + `（能力 / 状态 / 配额 / 难度上限都不满足）；可调席位 maxDifficulty 或把难度降到 easy / normal`);
    }
    return ranked[0].agentId;
  }

  function route(req) {
    const mode = req.mode ?? config.interaction?.defaultMode ?? DEFAULTS.defaultMode;
    const available = ['delegate', 'direct', 'cowork', 'meeting'];
    if (!available.includes(mode)) throw new Error(`未知交互模式 ${mode}；可用：${available.join(', ')}`);
    const requestId = req.requestId ?? `REQ-${shortId()}`;
    const existing = db.prepare('SELECT taskId FROM tasks WHERE requestId = ?').get(requestId);
    if (existing) return { duplicate: true, requestId, taskId: existing.taskId, mode };
    const existingThread = db.prepare('SELECT threadId FROM threads WHERE requestId = ?').get(requestId);
    if (existingThread) return { duplicate: true, requestId, threadId: existingThread.threadId, mode, taskCreated: false };

    if (mode === 'cowork' || mode === 'meeting') return createThread(req, mode, requestId);

    // G3：难度是任务卡的属性；人给的原始需求默认 normal，非法值直接报错（不静默当 normal）。
    const difficulty = normalizeDifficulty(req.difficulty, { field: 'difficulty' });
    // P7：项目可选。人没指定就放行（project=null + auto），由执行 agent 自己判断归属：
    // 新项目 / 已有项目 / 一次性任务；提示词会把可用项目清单给它。人显式指定的仍严格校验
    // （未知 / 缺规范拒绝）——既然点名了就别让它落到别的工地上。
    const picked = assertProject({ config, workRoot: workDir, requested: req.project ?? null });
    const project = picked.project;
    const projectAuto = picked.auto === true;

    let target;
    let assignedBy = 'human';
    if (mode === 'direct') {
      target = req.addressedTo;
      if (!target) {
        if (config.interaction?.autoAssign === true) {
          target = pickAssignee(difficulty);
          assignedBy = 'policy';
          writeAudit(db, { actor: 'scheduler', action: 'assigned_by_policy', newValue: target });
        } else {
          const candidates = rankCandidates(getAgentCandidates(), { needCapability: 'execute', difficulty })
            .map((c) => `${c.agentId}(余 ${c.quotaRemaining}${c.ceiling === NO_CEILING ? '' : `，≤ ${c.ceiling}`})`).join(', ');
          throw new Error(`mode=direct 必须显式给 addressedTo；候选：${candidates || '无'}（autoAssign 未开启，系统只推荐不替选）`);
        }
      }
      assertAssignable(target, { difficulty });
    } else {
      target = ceoId();
    }
    // 董事会原话里说「给我审 / 等我批」：不用记字段名，认出来就按「董事会亲审」走。
    // 只在没显式写 reviewBy 时生效；否定说法（不用给我看）先排除。
    const explicitReview = assertReviewSeat(req.reviewBy);
    const autoReview = !explicitReview && assignedBy === 'human'
      && detectBoardReview(req.instructions ?? req.text) ? 'human' : null;
    if (autoReview) {
      writeAudit(db, {
        actor: 'human', action: 'review_intent_detected',
        newValue: '原话里明确要求董事会亲自审 → reviewBy=human', taskId: null,
      });
    }
    const card = buildCard({
      requestId, title: req.title ?? String(req.text ?? '新需求').slice(0, 60),
      role: req.role ?? 'general', assignee: target, mode,
      addressedTo: mode === 'direct' ? target : null,
      assignedBy,
      // 原始需求就是「任务说明」：不传 instructions 时用 text 兜底。
      // 缺了这一步，人写的那句话只会变成卡片标题，席位收到的指令是一句空话
      // （真机上第一次投产就踩到：产物内容跟需求无关）。
      instructions: req.instructions ?? (req.text ? String(req.text) : undefined),
      acceptance: req.acceptance ?? undefined, difficulty,
      project,
      // 董事会下单时可以直接定：交不交审（handoff）、交给谁审（reviewBy）。
      // 人越权跳过 CEO 是合法的，所以这里不套员工的那些闸。
      handoff: assertHandoff(req.handoff),
      reviewBy: explicitReview ?? autoReview,
      allowSelfLand: req.allowSelfLand === true,
    });
    insertCard(card, target);
    return {
      requestId, taskId: card.taskId, mode, target, assignedBy, taskCreated: true, difficulty, project,
    };
  }

  /**
   * 子派活：承接人把手里这张卡的一部分拆出来，派给汇报子树里的人。
   * 典型场景：工程岗领到「给这个项目加个功能」，自己写完技术方案，把实现派给执行岗。
   * 三道闸：必须是这张卡的承接人、必须有 delegate 能力、只能派进自己的子树。
   */
  function spawnChild({
    parentTaskId, assignerId, title, instructions, acceptance = [],
    assignee, difficulty = null, repo = undefined, reviewBy = undefined, project = undefined,
    handoff = undefined, allowSelfLand = false,
  } = {}) {
    const parent = taskById(parentTaskId);
    if (!parent) throw new Error(`父卡不存在：${parentTaskId}`);
    if (!assignerId) throw new Error('spawn 必须写 assignerId（谁在拆这张卡）');
    if (parent.assignee !== assignerId) {
      throw new Error(`只有这张卡的承接人才能拆它：${parentTaskId} 的承接人是 ${parent.assignee}`);
    }
    const caps = cfgFor(assignerId)?.capabilities ?? [];
    if (!caps.includes('delegate')) {
      throw new Error(`${assignerId} 没有 delegate 能力，不能往下派活（要派活请在 config 里加 capabilities: [delegate]）`);
    }
    if (!assignee) throw new Error('spawn 必须写 assignee（派给谁）');
    const allowed = assertMayAssign(config, assignerId, assignee);
    if (!allowed.ok) throw new Error(`跨子树派活被拒绝：${allowed.reason}`);
    if (!String(title ?? '').trim()) throw new Error('spawn 必须写 title');
    if (!String(instructions ?? '').trim()) throw new Error('spawn 必须写 instructions：承接人只看这一份说明');
    const level = difficulty ? normalizeDifficulty(difficulty, { field: 'difficulty' }) : parent.difficulty;
    assertAssignable(assignee, { difficulty: level });
    const child = buildCard({
      requestId: parent.requestId, title: String(title).trim().slice(0, 80),
      role: 'general', assignee, mode: 'delegate', assignedBy: 'seat',
      parentTaskId, assignerId,
      instructions: String(instructions),
      acceptance: Array.isArray(acceptance) && acceptance.length
        ? acceptance.map(String)
        : ['completion.json 通过 schema 校验且 status = success'],
      difficulty: level,
      project: project === undefined ? parent.project : project,
      repo: repo === undefined ? parent.repo : repo,
      reviewBy: reviewBy === undefined || reviewBy === null ? null : assertReviewSeat(reviewBy),
      // 拆活的人就是发布者：默认「谁派谁审」（issuerOf 认 assignerId）；显式写就按写明。
      handoff: handoff === undefined ? null : assertHandoff(handoff),
      allowSelfLand: allowSelfLand === true,
    });
    insertCard(child, child.assignee);
    writeAudit(db, {
      actor: assignerId, action: 'spawn_task',
      newValue: `${child.taskId}|${assignee}|${child.title}`, taskId: child.taskId,
    });
    return {
      taskId: child.taskId, parentTaskId, assignee, title: child.title,
      project: child.project, repo: child.repo, difficulty: child.difficulty,
    };
  }

  // 人工取消：契约里早有 POST /api/tasks/:id/cancel，服务器一直没实现。
  // 「天天用」一定要有这一下 —— 卡在错误方向上时，能立刻停手比什么都重要。
  function cancelTask(taskId, { reason = '人工取消', actor = 'human' } = {}) {
    const task = taskById(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.status === 'done' || task.status === 'cancelled') {
      return { taskId, status: task.status, cancelled: false, reason: '已经是终态，不需要取消' };
    }
    transition(db, taskId, 'cancelled', actor);
    // 卡没了就别再排重投了，否则几分钟后会给一张已作废的卡再发事件。
    clearGateRetry(taskId);
    writeAudit(db, { actor, action: 'cancel_task', newValue: String(reason).slice(0, 300), taskId });
    // 卡都作废了，挂在它身上的待办审批必须一起关掉。
    // 否则看板上会永远留一张「待你拍板」——点进去却是一张已经不存在的活，
    // 而且关不掉（审批页只认 pending），时间一长就分不清哪张是真的。
    const closed = db.prepare(`UPDATE approvals SET status = 'cancelled', decidedBy = ?, decidedAt = ?, reason = ?
      WHERE taskId = ? AND status = 'pending'`)
      .run(actor, clockIso(), `任务已取消：${String(reason).slice(0, 200)}`, taskId);
    if (closed.changes > 0) {
      writeAudit(db, {
        actor, action: 'approvals_auto_closed',
        newValue: `${closed.changes} 张待办审批随任务取消关闭`, taskId,
      });
    }
    return { taskId, status: 'cancelled', cancelled: true, closedApprovals: closed.changes };
  }

  function submitChangeRequest(cr) {    // 控制面能自己生成的字段（schema / 汇报对象 / revision / 现场快照 / 时间）由控制面填，
    // 调用方只给业务字段；仍然整单过 schema 校验，不绕过任何规矩（§6D.2）。
    const task = cr.taskId ? taskById(cr.taskId) : null;
    // P4-3：决策者由组织树解析，agent 无权指定外人拍板（requestedDecisionBy 只当建议）。
    const requestedBy = resolveDecisionMaker(config, cr.agentId ?? task?.assignee, {
      prefer: cr.requestedDecisionBy ?? null,
    });
    const normalized = {
      schema: 'aicompany.change-request/v1',
      reportsTo: cfgFor(cr.agentId)?.reportsTo ?? ceoId(),
      requestedDecisionBy: requestedBy ?? null,
      revision: task?.revision ?? 1,
      doneSoFar: {},
      createdAt: clockIso(),
      ...cr,
    };
    const checked = validate('change-request', normalized);
    if (!checked.ok) throw new Error(`变更请求不合法：${checked.errors.join('; ')}`);
    const info = db.prepare(`INSERT OR IGNORE INTO change_requests
      (changeRequestId, taskId, runId, agentId, kind, severity, reason, dedupeKey, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      normalized.changeRequestId, normalized.taskId, normalized.runId, normalized.agentId,
      normalized.kind, normalized.severity, normalized.reason,
      normalized.changeRequestId, normalized.createdAt,
    );
    if (info.changes === 0) return { inserted: false, reason: '重复 changeRequestId' };
    writeAudit(db, { actor: normalized.agentId, action: 'change_request', newValue: normalized.changeRequestId, taskId: normalized.taskId });

    // P4-8 完整档：needsDecision 真挂起 + 现场快照落盘 + 不烧额度；advisory 只留痕（§6D.3）。
    let suspended = false;
    let snapshot = null;
    if (normalized.severity === 'needsDecision' && task
      && ['in_progress', 'in_review'].includes(task.status)) {
      transition(db, task.taskId, 'awaiting_decision', 'control-plane');
      suspended = true;
      try {
        snapshot = buildSnapshot({
          workRoot: workDir,
          task: { ...task, status: 'awaiting_decision' },
          changeRequest: normalized,
          sessionParams: { dispatchMode, wakeReason: 'change_request' },
          transcriptPath: `runs/${normalized.runId}.ndjson`,
          percent: normalized.doneSoFar?.percent ?? null,
        });
      } catch (error) {
        // 快照失败不吞掉：挂起已经成立，缺现场要留痕给人看。
        writeAudit(db, { actor: 'control-plane', action: 'snapshot_failed', newValue: String(error.message), taskId: task.taskId });
      }
      writeAudit(db, {
        actor: 'control-plane', action: 'suspend_for_decision',
        oldValue: task.status, newValue: `awaiting_decision:${normalized.changeRequestId}`, taskId: task.taskId,
      });
      notifier.send({
        title: `待拍板：${task.title}`,
        body: `席位 ${normalized.agentId} 上报变更（${normalized.kind}）：${normalized.reason}\n` +
          `建议由 ${requestedBy} 先看；动验收 / 指令需人审。任务已挂起，不烧额度。`,
        scene: 'decision', changeRequestId: normalized.changeRequestId, taskId: task.taskId,
      });
    }

    emitEvent({
      type: 'change_request', taskId: normalized.taskId, agentId: normalized.agentId,
      payload: { changeRequestId: normalized.changeRequestId, wakeReason: 'escalation' },
      dedupeKey: `change:${normalized.changeRequestId}`,
    });
    return {
      inserted: true, changeRequestId: normalized.changeRequestId,
      requestedDecisionBy: requestedBy ?? null, suspended,
      snapshotPath: snapshot?.path ?? null,
    };
  }

  // Run Policy（任务书 §7.3）：每次唤醒前依次检查。返回带 code，便于试运行统计误唤醒。
  // code 取值：missing / agent_inactive / terminal / suspended / dependency / quota / concurrent / cooldown / bridge_offline
  const COOLDOWN_EXEMPT = new Set(['decision', 'review_requested', 'escalation', 'replan']);
  // 「派卡」类唤醒：受卡间依赖与 bridge 在线约束；治理类唤醒不受（否则半路的卡永远走不完）。
  const BRIDGE_GATED_REASONS = new Set([
    'issue_assigned', 'compensation', 'rework', 'checkout', 'bridge_checkout',
    'manual', 'cycle',
  ]);
  function runPolicy(agentId, taskId, wakeReason) {
    const agent = db.prepare('SELECT * FROM agents WHERE agentId = ?').get(agentId);
    if (!agent) return { ok: false, code: 'missing', reason: `席位不存在 ${agentId}` };
    if (agent.status !== 'active') return { ok: false, code: 'agent_inactive', reason: `席位状态 ${agent.status}` };
    const task = taskById(taskId);
    // P5：终态任务不该再被任何理由唤醒。之前只挡了挂起态，done/cancelled 能被反复唤醒。
    if (task && (task.status === 'done' || task.status === 'cancelled')) {
      return { ok: false, code: 'terminal', reason: `任务已终态（${task.status}），拒绝唤醒` };
    }
    if (task?.status === 'awaiting_decision' && wakeReason !== 'decision') {
      return { ok: false, code: 'suspended', reason: '任务挂起等决策，除决策出口外一律拒绝唤醒' };
    }
    // 卡间依赖：前置卡没 done 就不许开跑。防的是「CEO 拆了 4 张，接管还没做完，发布脚本已经发布」。
    // 只挡派卡类唤醒（review / 决策 / 返工是同一张卡自己的流程，与前置无关）。
    if (task && BRIDGE_GATED_REASONS.has(wakeReason)) {
      const unmet = unmetDependencies(task);
      if (unmet.length) {
        return {
          ok: false, code: 'dependency',
          reason: `还有 ${unmet.length} 张前置卡没完成（${unmet.join(', ')}），先排队`,
        };
      }
    }
    // P4-1：配额判定与通知统一走 quota.js（80% 预警一次、100% 停派并通知）。
    const cfg = cfgFor(agentId);
    const verdict = checkQuota(db, cfg ?? { id: agentId, quotaDaily: agent.quotaDaily }, {
      now: clock(), quota: config.quota,
    });
    if (verdict.warnNow) notifyQuota('warning', agentId, verdict.state);
    if (!verdict.ok) {
      notifyQuota('exhausted', agentId, verdict.state);
      return { ok: false, code: 'quota', reason: verdict.reason };
    }
    // §7.3 第 5 项：只有「派卡」类唤醒受 bridge 在线约束（事件泵在 bridge 模式下已把卡留在 todo）。
    // review / escalation 是控制面内部决策，走控制面自己的 adapter，不要求本机 bridge 在线；
    // 否则 delegate 模式完成报告回写后会永远卡在 in_review，链路跑不通。
    if (dispatchMode === 'bridge' && BRIDGE_GATED_REASONS.has(wakeReason)
      && !isBridgeOnline(db, agentId)) {
      return { ok: false, code: 'bridge_offline', reason: 'bridge 离线，任务留 todo 等待补投' };
    }
    // 席位级拉模式：任何时候控制面都不主动唤醒它（它自己 checkout 走 lease 通道，不经过这里）。
    if (cfgFor(agentId)?.dispatch === 'pull') {
      return { ok: false, code: 'pull', reason: '该席位是拉模式，只由它自己领取' };
    }
    // §7.3 第 4 项：并发上限可配（原先是写死的 3）。
    const maxConcurrent = config.runPolicy?.maxConcurrent ?? DEFAULTS.maxConcurrent;
    const running = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n;
    if (running >= maxConcurrent) {
      return { ok: false, code: 'concurrent', reason: `并发 Run 达上限 ${maxConcurrent}` };
    }
    // §7.3 第 4 项：冷却。防的是同一席位被反复空转唤醒；治理类唤醒（决策 / 返工 / 升级 / 改方案）
    // 不豁免的话会把卡在半路，所以显式放行。
    const cooldownSec = config.runPolicy?.cooldownSec ?? DEFAULTS.cooldownSec;
    if (cooldownSec > 0 && !COOLDOWN_EXEMPT.has(wakeReason)) {
      const last = db.prepare(`SELECT CAST(strftime('%s', startedAt) AS INTEGER) AS s
        FROM runs WHERE agentId = ? ORDER BY rowid DESC LIMIT 1`).get(agentId);
      const elapsed = last?.s ? clock().getTime() / 1000 - last.s : Infinity;
      if (elapsed < cooldownSec) {
        return {
          ok: false, code: 'cooldown',
          reason: `冷却未到（距上次 ${Math.floor(elapsed)}s < ${cooldownSec}s）`,
        };
      }
    }
    return { ok: true, quota: verdict.state };
  }

  // 「暂时派不出去」把卡退回 todo 让它等下一次投递 —— 但只在**这张卡确实没有 Run 在跑**时。
  // 为什么必须加这个前提：GUI 任务一次能跑几分钟，维护心跳会在这期间再叫它一次；
  // 若无条件退回 todo，正在跑的那一回收账时会撞上「todo → in_review 非法跳转」，
  // 用户看到「提交失败」，而活其实已经干完了（真机上踩过）。
  function requeueIfIdle(taskId) {
    return db.prepare(`UPDATE tasks SET status = 'todo', updatedAt = ?
      WHERE taskId = ? AND status = 'in_progress'
        AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.taskId = tasks.taskId AND runs.status = 'running')`)
      .run(clockIso(), taskId);
  }

  // 「等奖键盘」不该让人干等一分钟。
  // 真机上踩过：人在看板上点完提交（idle=0），静置闸立刻拦下 → 卡退回 todo，
  // 而重投只能等维护心跳（按服务启动时刻对齐、最长 60 秒，还要卡龄超阈值 → 最坏近 2 分钟）。
  // 用户看到的就是「点了提交，什么都没发生」。所以给这类卡排一个短延迟自检：
  // 4 秒、8 秒、12 秒…… 单次最多 20 秒，试满 12 次（约 3 分钟）就交回维护心跳。
  const gateRetries = new Map();
  const GATE_RETRY_MAX = 12;
  // P7：报告通过 schema 后先攒着，等这张卡**真的**到 done 才落记忆。
  // （先落的话，CEO 打回重做的那次也会留一条「成功记忆」，等于把废稿写进教科书。）
  const pendingMemory = new Map();
  // 只有「等一会儿就会好」的原因才自动重试。时段闸不算：差几个小时，重试没有意义。
  const TRANSIENT_GATE = new Set(['user-active', 'paused', 'session-locked']);
  let gateRetrySeq = 0;

  function clearGateRetry(taskId) {
    const entry = gateRetries.get(taskId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    gateRetries.delete(taskId);
    return true;
  }

  function scheduleGateRetry(taskId, agentId) {
    if (!(gateRetryMs > 0)) return null;
    const prev = gateRetries.get(taskId);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (prev) clearTimeout(prev.timer);
    if (attempts > GATE_RETRY_MAX) {
      // 连续拦满仍放不进去（用户一直在用电脑）：交回维护心跳，别 4 秒一次无脑刷。
      gateRetries.delete(taskId);
      writeAudit(db, {
        actor: agentId, action: 'gate_retry_gave_up',
        newValue: `连续 ${attempts} 次自检都被临时条件拦下，交回维护心跳（每分钟一次）`,
        taskId,
      });
      return null;
    }
    const delayMs = Math.min(gateRetryMs * attempts, 20_000);
    const timer = setTimeout(() => {
      try {
        const row = db.prepare('SELECT status, assignee FROM tasks WHERE taskId = ?').get(taskId);
        // 卡已经不在排队了（跑起来了 / 被取消 / 被人改过），这次重投就没有意义。
        if (!row || row.status !== 'todo') { gateRetries.delete(taskId); return; }
        gateRetrySeq += 1;
        emitEvent({
          type: 'issue_assigned', taskId, agentId: row.assignee ?? agentId,
          payload: { wakeReason: 'gate_retry' },
          // dedupeKey 必须每次都不同，否则第二次重投会被幂等吞掉。
          dedupeKey: `gate_retry:${taskId}:${gateRetrySeq}`,
        });
        // **不在这里删记录**：attempts 要留着给下次算退避，否则永远停在第一档。
        Promise.resolve(pump()).catch(() => {});
      } catch { gateRetries.delete(taskId); }
    }, delayMs);
    timer.unref?.();
    gateRetries.set(taskId, { attempts, timer });
    return delayMs;
  }

  async function wake(taskId, agentId, wakeReason, extra = {}) {
    const policy = runPolicy(agentId, taskId, wakeReason);
    if (!policy.ok) {
      // 记 code 而不是只记一句话：P5 的误唤醒率靠这个字段分类，文本改了统计就断了。
      writeAudit(db, {
        actor: 'scheduler', action: 'wake_rejected',
        newValue: `${agentId}|${policy.code}|${policy.reason}`, taskId,
      });
      // 「暂时派不出去」（配额 / 冷却 / 并发 / bridge 离线）要把卡退回 todo 等补偿扫描重投；
      // 否则卡会停在 in_progress 却没有任何 Run，看起来像卡死，也过不了脏状态检查。
      // 「本来就不该派」（挂起 / 终态 / 席位停用）则不许动状态。
      const RETRYABLE = new Set(['quota', 'cooldown', 'concurrent', 'bridge_offline']);
      if (RETRYABLE.has(policy.code)) {
        requeueIfIdle(taskId);
      }
      return { skipped: true, code: policy.code, reason: policy.reason };
    }
    const task = taskById(taskId);
    // 同一张卡不允许两条 Run 并行：重复事件（维护心跳 / 重复投递）在这张卡已经有 run
    // 在跑时必须让路，否则两个 GUI Run 会同时往一个窗口里贴提示词。
    const runningSame = db.prepare("SELECT runId FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1")
      .get(taskId);
    if (runningSame && runningSame.runId !== extra?.resumeRunId) {
      return { skipped: true, code: 'concurrent', reason: `这张卡已有 Run ${runningSame.runId} 在跑，不重复派` };
    }
    const agentRow = db.prepare('SELECT * FROM agents WHERE agentId = ?').get(agentId);
    const cfg = cfgFor(agentId);
    if (!cfg) return { skipped: true, reason: `配置里没有席位 ${agentId}` };
    const mod = getAdapter(cfg.adapter.type);
    // P3-1：GUI 型必须先把环境检查过，窗口/依赖缺失时明确失败且不派活、任务留 todo（§8.3 / §8.6）。
    const envConfig = {
      ...(cfg.adapter?.config ?? {}),
      workRoot: cfg.adapter?.config?.workRoot ?? workDir,
    };
    if (mod.strictEnvironment && typeof mod.testEnvironment === 'function') {
      // workRoot 必须和真正派活时（adapterConfig）用同一个值。
      // 只传 cfg.adapter.config 的话，配置写在文档级 workRoot 上的公司永远过不了环境检查。
      // await：testEnvironment 允许是异步的（webhook/HC 型 adapter 要发一次网络探针）。
      // 同步 adapter 的返回值被 await 也照常工作，向后兼容。
      const env = await mod.testEnvironment(envConfig);
      if (!env.ok) {
        // 事件泵已经把卡推进到 in_progress；「根本没派活」要补偿回 todo，否则会卡在半截状态（§8.6）。
        requeueIfIdle(taskId);
        writeAudit(db, { actor: agentId, action: 'env_check_failed', newValue: env.detail });
        return { skipped: true, reason: `testEnvironment 未通过：${env.detail}` };
      }
    }
    // P6-2：「现在该不该抢键鼠」是**临时条件**，不能按失败处理（否则两次就把卡打成 blocked）。
    // adapter 给出 precheck 就在这里拦下并退回 todo，等维护心跳下次再投；这张卡一次额度都不烧。
    if (typeof mod.precheck === 'function') {
      let gate;
      try {
        gate = await mod.precheck(envConfig, { taskId, agentId, wakeReason });
      } catch (error) {
        gate = { ok: false, code: 'precheck_error', reason: `准入检查异常：${String(error.message ?? error)}` };
      }
      if (gate && gate.ok === false) {
        requeueIfIdle(taskId);
        // 只有「这一轮拦挡的第一下」才写审计：用户连续用电脑几分钟的话，
        // 每次自检都记一行会把审计刷满（真机上 55 秒刷了 15 行重复的 user-active）。
        const existing = gateRetries.get(taskId);
        if (!existing) {
          writeAudit(db, {
            actor: agentId, action: 'gate_blocked',
            newValue: `${gate.code ?? 'gate'}|${gate.reason ?? ''}`.slice(0, 500), taskId,
          });
        }
        // 「你刚动过键盘」这类临时条件几秒后大概率就过了，排个自检，别让看板静默一分钟。
        const retryInMs = TRANSIENT_GATE.has(gate.code)
          ? scheduleGateRetry(taskId, agentId)
          : (clearGateRetry(taskId), null);
        return { skipped: true, code: gate.code ?? 'gate', reason: gate.reason, retryInMs };
      }
    }
    // P4-8：resume 必须沿用原 runId（续写同一个未完成的 run，不是开新 run）。
    const resumeRunId = extra?.resumeRunId ?? null;
    const runId = resumeRunId ?? `R-${shortId()}`;
    if (resumeRunId) {
      const existing = db.prepare('SELECT runId FROM runs WHERE runId = ?').get(resumeRunId);
      if (existing) {
        db.prepare("UPDATE runs SET status = 'running', finishedAt = NULL, wakeReason = ? WHERE runId = ?")
          .run(wakeReason, resumeRunId);
      } else {
        db.prepare(`INSERT INTO runs
          (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
          VALUES (?, ?, ?, ?, 'running', ?, 1, ?, NULL)`).run(
          resumeRunId, taskId, agentId, wakeReason, task?.revision ?? 1, clockIso(),
        );
      }
    } else {
      db.prepare(`INSERT INTO runs
        (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
        VALUES (?, ?, ?, ?, 'running', ?, 1, ?, NULL)`).run(
        runId, taskId, agentId, wakeReason, task?.revision ?? 1, clockIso(),
      );
    }
    // 真派下去了：之前排的「等会儿再试」就作废，否则等会儿会拿一张已经在跑的卡再投一次。
    clearGateRetry(taskId);
    // P7：项目规范 + 最近记忆随 brief 一起下发。规范在派活前已校验过存在；
    // 这里读盘失败也不阻断（brief 少一段总比整单派不出去好），但要在审计里看得见。
    const projectContext = task?.project
      ? buildProjectContext({ workRoot: workDir, config, id: task.project })
      : null;
    const ctx = {
      runId, wakeReason, taskId,
      task: task ? {
        taskId: task.taskId, title: task.title, mode: task.mode, status: task.status,
        revision: task.revision, attempt: task.attempt, instructions: task.instructions,
        acceptance: task.acceptance, parentTaskId: task.parentTaskId,
        project: task.project ?? null, repo: task.repo ?? null, reviewBy: task.reviewBy ?? null,
        difficulty: task.difficulty ?? DEFAULT_DIFFICULTY,
        // 这张卡的交付路由：谁发布的、默认交给谁、能不能自己判落盘。
        // 提示词据此讲清「这活是董事会下的单，还是你上级派的」——不写清，
        // 员工会把上级派的活当自己的事，干完自己结案，发布者永远看不到结果。
        handoffPolicy: handoffPolicyOf(task),
      } : null,
      // 项目上下文单独给一份：adapter 拿它拼提示词，process/http 型也照此透传给真模型。
      project: projectContext,
      agent: {
        id: agentId, isCEO: Boolean(agentRow?.isCEO),
        capabilities: JSON.parse(agentRow?.capabilities ?? '[]'),
      },
      // 名册要完整：CEO 要据此决定「这活派给谁」。岗位名与担任者分开给，别把 agent 名当岗位。
      company: {
        agents: config.agents.map((a) => ({
          id: a.id, postTitle: a.postTitle ?? a.displayName ?? a.id,
          holderName: a.holderName ?? null, holderKind: a.holderKind ?? null,
          displayName: a.displayName ?? a.id, isCEO: a.isCEO === true,
          capabilities: a.capabilities ?? [], status: a.status ?? 'active',
          reportsTo: a.reportsTo ?? null, maxDifficulty: a.maxDifficulty ?? null,
          adapter: a.adapter?.type ?? null,
          // 岗位说明书：提示词靠它说清「你是谁、边界在哪、能派给谁」。
          duties: a.duties ?? null,
          boundaries: a.boundaries ?? null,
          escalationTo: a.escalationTo ?? null,
          mayDelegateTo: a.mayDelegateTo ?? null,
        })),
      },
      // 仓库台账与产物政策：提示词要带上「代码在哪、推哪、什么算受管代码」。
      repos: Object.values(config.repos ?? {}),
      artifacts: config.artifacts ?? {},
      workRoot: workDir,
      // 会话复用策略（interaction.ceoSession）：adapter 据此决定「共用会话还是每轮新开」。
      interaction: config.interaction ?? {},
      // P7：项目可选。没指定项目时把「可用项目清单」交给 agent，由它自己判断归属
      // （新项目 / 复用已有 / 一次性任务），而不是逼人在下单时先选。
      projectAuto: task?.project == null && (config.projects ? Object.keys(config.projects).length > 0 : false),
      availableProjects: listProjectEntries({ config, workRoot: workDir }).map((p) => ({
        id: p.id, displayName: p.displayName, specExists: p.specExists,
        rootDir: p.rootDir, deliverSubdir: p.deliverSubdir, memoryCount: p.memoryCount ?? 0,
        // CEO 要「根据现有项目信息给建议」，光有项目名不够：得看到各项目最近干了什么、踩过什么坑。
        // 只取最近 3 条、每条压成一句话——每次唤醒都塞全文太贵，而摘要足够它判断「这项目卡在哪」。
        recentMemory: readRecentMemory(workDir, p.id, { limit: 3 }).entries.map((m) => ({
          at: String(m.finishedAt ?? m.at ?? '').slice(0, 10),
          title: String(m.title ?? '').slice(0, 60),
          summary: String(m.summary ?? '').slice(0, 140),
          lesson: Array.isArray(m.lessons) && m.lessons.length ? String(m.lessons[0]).slice(0, 120) : null,
        })),
      })),
      adapterConfig: { ...(cfg.adapter?.config ?? {}), workRoot: cfg.adapter?.config?.workRoot ?? workDir },
      extra,
    };
    let outcome;
    try {
      outcome = await mod.execute(ctx);
    } catch (error) {
      db.prepare("UPDATE runs SET status = 'failed', finishedAt = ? WHERE runId = ?").run(clockIso(), runId);
      writeAudit(db, { actor: agentId, action: 'adapter_failed', newValue: String(error.message), runId, taskId });
      if (task && task.status === 'in_progress') transition(db, taskId, 'blocked', 'scheduler', runId);
      return { failed: true, error: String(error.message), runId };
    }
    db.prepare('UPDATE runs SET status = ?, finishedAt = ? WHERE runId = ?')
      .run(outcome.status ?? 'success', clockIso(), runId);
    consumeQuota(db, agentId, 1, { now: clock(), periodHours: config.quota?.periodHours });
    afterQuotaConsume(agentId);
    writeAudit(db, { actor: agentId, action: resumeRunId ? 'wake_resume' : 'wake', newValue: `${wakeReason}:${runId}`, runId, taskId });
    // adapter 报上来的运行参数（会话是否新开、轮询次数、截图路径、报告来源）必须留痕：
    // 否则「这次到底在不在新会话里跑的」事后查不到，等于白跑。
    if (outcome.sessionParams && Object.keys(outcome.sessionParams).length > 0) {
      writeAudit(db, {
        actor: agentId, action: 'run_params',
        newValue: JSON.stringify(outcome.sessionParams).slice(0, 2000), runId, taskId,
      });
    }
    maybeWarnCeoSession(outcome, task);
    return { ...outcome, runId, agentId, wakeReason, resumed: Boolean(resumeRunId) };
  }

  // 共用会话是为了省钱（前缀缓存命中），但不能让它无限变长：越长越脏、每轮输入也越贵。
  // 到 warnTurns 提醒董事会「可以换个新的」，同一档位只提醒一次（记在会话文件里，重启不重发）。
  function maybeWarnCeoSession(outcome, task) {
    const sp = outcome?.sessionParams ?? {};
    const turns = Number(sp.sessionTurns ?? 0);
    if (sp.mode !== 'ceo' || !sp.sessionId || !(turns > 0)) return;
    const warnAt = Number(config.interaction?.ceoSession?.warnTurns ?? DEFAULT_SESSION_POLICY.warnTurns);
    if (!(warnAt > 0) || turns < warnAt) return;
    const bucket = Math.floor(turns / warnAt);
    const state = readCeoSession(workDir, ceoId());
    if (Array.isArray(state?.warnAts) && state.warnAts.includes(bucket)) return;
    markSessionWarned(workDir, ceoId(), bucket);
    const short = String(sp.sessionId).slice(-12);
    writeAudit(db, {
      actor: 'control-plane', action: 'ceo_session_warn',
      newValue: `${short}|${turns} 轮`, taskId: task?.taskId ?? null,
    });
    notifier.send({
      title: `总经理会话已 ${turns} 轮，要不要换个新的`,
      body: `共用会话是为了命中缓存省钱，但跑久了上下文会脏、每轮输入也越来越贵。\n`
        + `看板「席位与配额」里点「新建会话」就能换，下一轮起用新会话；手上在跑的卡不受影响。\n`
        + `（不动也行：到 ${Number(config.interaction?.ceoSession?.maxTurns ?? DEFAULT_SESSION_POLICY.maxTurns)} 轮会自动换。）`,
      scene: 'answer', taskId: task?.taskId ?? null,
    });
  }

  // 模型偶尔会把「只回话」写成 type:"report"。四类出口是 P0 冻结的，不能为它加第五类，
  // 所以在这里归一成 task-create + 空 tasks（＝不派卡、只把话交回去），而不是判它非法。
  function assertCeoOutput(result) {
    if (result && typeof result === 'object' && !CEO_OUTPUT_KINDS.includes(result.type)
      && ['report', 'answer', 'reply'].includes(String(result.type))) {
      return { ...result, type: 'task-create', tasks: [] };
    }
    if (!result || !CEO_OUTPUT_KINDS.includes(result.type)) {
      throw new Error(`CEO 输出必须是这几类之一 [${CEO_OUTPUT_KINDS.join(', ')}]，收到 ${String(result?.type)}`);
    }
    return result;
  }

  // 判「这是不是一张卡」：得带实质字段。只写 summary / 建议的对象是回话，不是卡。
  function looksLikeTaskCard(x) {
    return Boolean(x && typeof x === 'object'
      && (x.title || x.instructions || x.assignee
        || (Array.isArray(x.acceptance) && x.acceptance.length)));
  }

  // 「只回话、不派卡」的收尾：父卡直接结案，答复原样交回董事会。
  // 不建子卡、不进项目、不再唤醒第二次。答复同时写审计（可追）与收件箱（看得见、能弹气泡）。
  // 依据：任务与项目解耦——问一句「你好」不该变成一张给员工的活。
  function closeAsReport(task, result, runId) {
    const answer = String(result.answer ?? result.summary ?? '').trim();
    if (!answer) {
      throw new Error('CEO 这一轮既没派卡、也没排班、也没给答复（answer / summary 都是空的），等于什么都没做');
    }
    writeAudit(db, {
      actor: 'ceo', action: 'ceo_report',
      newValue: answer.slice(0, 2000), runId, taskId: task.taskId,
    });
    notifier.send({
      title: `总经理回复：${String(task.title ?? '(无标题)').slice(0, 60)}`,
      body: answer.slice(0, 1500),
      scene: 'answer', taskId: task.taskId,
    });
    transition(db, task.taskId, 'in_review', 'ceo', runId);
    transition(db, task.taskId, 'done', 'ceo', runId);
    return { reported: true, chars: answer.length };
  }

  // G3：子卡派给谁。CEO 点了名且接得了 → 尊重；接不了 → 在它的子树里找一个「刚够用」的替补；
  // 一个都没有 → 返回 assignee=null，由调用方卡住父卡并通知人（绝不硬塞、也不整单报错）。
  function resolveChildSeat({ preferred, difficulty, managerId }) {
    const wanted = preferred ?? firstWorker();
    const seat = cfgFor(wanted);
    // 总经理岗永不接执行卡：哪怕它在输出里点了自己的名字（想自己干），也强制改派给执行席位。
    // 这是「严禁 CEO 自己干活」的第二道闸——第一道是提示词，第三道是契约校验。
    if (seat && seat.isCEO !== true && canTake({ agentId: wanted, maxDifficulty: ceilingOf(seat) }, difficulty)) {
      return { assignee: wanted, reassignedFrom: null };
    }
    const pool = rankCandidates(getAgentCandidates(), { needCapability: 'execute', difficulty })
      .filter((c) => !managerId || isInSubtree(config, managerId, c.agentId));
    if (!pool.length) return { assignee: null, reassignedFrom: wanted ?? null };
    return { assignee: pool[0].agentId, reassignedFrom: wanted ?? null };
  }

  // 难度卡住：不把父卡当成完成，也不偷偷塞给接不了的席位。挂起 + 通知人（改配置或降难度）。
  function parkForDifficulty(task, { wanted, difficulty }) {
    const why = `${wanted ?? '（未指定）'} 接不了 ${difficulty}（${describeDifficulty(difficulty)}），且其子树里没有别的席位能接`;
    writeAudit(db, {
      actor: 'control-plane', action: 'difficulty_blocked',
      oldValue: task.status, newValue: why, taskId: task.taskId,
    });
    notifier.send({
      title: `卡住了：${task.title}`,
      body: `${why}。\n两条路：给某个席位把 maxDifficulty 调到 ${difficulty}，或者把任务降到席位接得住的难度。`
        + `\n任务没有派出去，也没有烧额度，等你处理。`,
      scene: 'difficulty', taskId: task.taskId,
    });
    // 状态机只允许这几条进「等人处理」的路，其余（挂起 / 终态）不动。
    const parkPath = {
      todo: ['paused'], in_progress: ['blocked'], in_review: ['in_progress', 'blocked'],
    }[task.status];
    for (const to of parkPath ?? []) transition(db, task.taskId, to, 'control-plane');
    return null;
  }

  function deriveAndCancel(task, result) {
    const difficulty = normalizeDifficulty(result.difficulty ?? task.difficulty, { field: 'difficulty' });
    const seat = resolveChildSeat({
      preferred: result.assignee, difficulty, managerId: ceoId(),
    });
    if (!seat.assignee) {
      parkForDifficulty(task, { wanted: result.assignee ?? firstWorker(), difficulty });
      return null;
    }
    if (seat.reassignedFrom && seat.reassignedFrom !== seat.assignee) {
      writeAudit(db, {
        actor: 'ceo', action: 'difficulty_reassigned',
        oldValue: seat.reassignedFrom, newValue: seat.assignee, taskId: task.taskId,
      });
    }
    let derivedProject = task.project ?? null;
    if (typeof result.project === 'string' && result.project.trim()) {
      try {
        derivedProject = assertProject({ config, workRoot: workDir, requested: result.project }).project;
      } catch { /* 写错项目名不改判，沿用父卡归属，审计里另有记录 */ }
    }
    const child = buildCard({
      requestId: `REQ-DERIVED-${shortId()}`, title: result.title ?? '派生任务',
      role: result.role ?? 'general', assignee: seat.assignee,
      mode: 'delegate', assignedBy: 'ceo',
      instructions: result.instructions ?? undefined,
      acceptance: result.acceptance ?? undefined, parentTaskId: task.taskId,
      difficulty, project: derivedProject,
    });
    insertCard(child, child.assignee);
    if (task.status === 'in_progress' || task.status === 'todo') {
      transition(db, task.taskId, 'cancelled', 'control-plane');
    }
    writeAudit(db, { actor: 'ceo', action: 'derive_from_change_request', oldValue: task.taskId, newValue: child.taskId });
    return child;
  }

  function requestApproval({ kind, taskId = null, title, body = '', payload = {}, requestedBy = 'control-plane' }) {
    const approval = createApproval(db, { kind, taskId, title, body, payload, requestedBy });
    writeAudit(db, {
      actor: requestedBy, action: 'approval_requested',
      newValue: `${kind}:${approval.approvalId}`, taskId,
    });
    notifier.requestApproval({
      approvalId: approval.approvalId, kind, taskId, title, body,
    });
    return approval;
  }

  // 把 CEO 的「排班建议」组装成循环协议要求的完整 job。
  // CEO 只填人能看懂的那几样（多久一次、干什么、怎么算干完、派给谁、归哪个项目），
  // 协议要求的其余字段由控制面补齐——不让它去背 schema，也不给它机会写坏字段。
  function buildRecurringJob(sug = {}, { task, requestedBy = null } = {}) {
    const title = String(sug.title ?? '').trim().slice(0, 120);
    if (!title) return { error: '缺 title（这条循环任务叫什么）' };
    const rrule = String(sug.rrule ?? '').trim();
    if (!rrule) return { error: '缺 rrule（多久跑一次）' };
    const timezone = String(sug.timezone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai';
    try { nextFireAt(rrule, nowIso(), timezone); } catch (error) {
      return { error: `rrule 不合法：${error.message}` };
    }
    const instructions = String(sug.instructions ?? '').trim();
    if (!instructions) return { error: '缺 instructions（每轮具体要干什么）' };
    const acceptance = (Array.isArray(sug.acceptance) ? sug.acceptance : [])
      .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8);
    if (!acceptance.length) return { error: '缺 acceptance（怎么算这一轮干完了）' };
    // 承接人：必须是真能干的执行席位；CEO 在输出里点自己也会被改派（严禁自干）。
    const difficulty = normalizeDifficulty(sug.difficulty ?? 'normal', { field: 'difficulty' });
    const picked = resolveChildSeat({ preferred: sug.assignee ?? firstWorker(), difficulty, managerId: requestedBy });
    if (!picked.assignee) return { error: '没有能接这活的执行席位' };
    // 归属项目：只认已有且配了规范的；写了不存在的就拒，别让循环卡落到野地里。
    let project = null;
    if (sug.project) {
      try { project = assertProject({ config, workRoot: workDir, requested: sug.project }).project; }
      catch (error) { return { error: `项目不可用：${error.message}` }; }
    }
    const kind = RECURRING_KINDS.includes(sug.kind) ? sug.kind : 'maintenance';
    // 协议不允许「永不停」的循环：终止条件必须至少有一个。
    // 默认给一年有效期——长期任务也该有个到期复核点，到期自动暂停，董事会续期才继续跑。
    const validUntil = typeof sug.validUntil === 'string' && sug.validUntil
      ? sug.validUntil
      : new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    // 任务号：优先用 CEO 给的名字，转成可读的短 slug；撞号就加序号，绝不覆盖已有任务。
    const base = String(sug.id ?? title).toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
    let jobId = `JOB-${base}`;
    for (let n = 2; db.prepare('SELECT 1 FROM recurring_jobs WHERE jobId = ?').get(jobId); n += 1) {
      jobId = `JOB-${base}-${n}`;
    }
    return {
      job: {
        schema: 'aicompany.recurring/v1',
        jobId, jobVersion: 1, title, kind,
        owner: ceoId() ?? 'ceo', assignee: picked.assignee, reportsTo: ceoId() ?? null,
        project, status: 'active',
        trigger: { type: 'cron', rrule, timezone },
        misfirePolicy: sug.misfirePolicy ?? 'run_once', misfireGraceMin: 720,
        overlapPolicy: 'skip',
        termination: {
          validUntil,
          maxCycles: Number.isInteger(sug.maxCycles) ? sug.maxCycles : null,
          pauseOnConsecutiveFailures: 3,
        },
        requiresHumanEachCycle: sug.requiresHumanEachCycle === true,
        taskTemplate: {
          role: String(sug.role ?? 'execute'),
          instructions, acceptance,
          completionReportPath: 'output/completion.json',
        },
        budgetPerCycle: { maxRuns: 2 },
        dedupeWindowMin: 60,
      },
      reassignedFrom: picked.reassignedFrom ?? null,
    };
  }

  // 董事会不会读 rrule：把常见频率翻成人话，翻不出来就原样给 rrule 让它自己判断。
  function describeRRule(rrule) {
    const parts = Object.fromEntries(String(rrule).split(';').map((kv) => kv.split('=')));
    const hh = parts.BYHOUR !== undefined ? String(parts.BYHOUR).padStart(2, '0') : null;
    const mm = parts.BYMINUTE !== undefined ? String(parts.BYMINUTE).padStart(2, '0') : '00';
    const clock = hh ? `${hh}:${mm}` : null;
    const n = Number(parts.INTERVAL ?? 1);
    const DAY = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' };
    switch (parts.FREQ) {
      case 'HOURLY': return n > 1 ? `每 ${n} 小时` : '每小时';
      case 'DAILY': return clock ? `每天 ${clock}` : '每天';
      case 'WEEKLY': {
        const days = String(parts.BYDAY ?? '').split(',').filter(Boolean).map((d) => DAY[d] ?? d).join('、');
        return `${n > 1 ? `每 ${n} 周` : '每周'}${days ? days : ''}${clock ? ` ${clock}` : ''}`;
      }
      case 'MONTHLY': {
        const dom = parts.BYMONTHDAY ? `${parts.BYMONTHDAY} 号` : '';
        return `${n > 1 ? `每 ${n} 个月` : '每月'}${dom ? ` ${dom}` : ''}${clock ? ` ${clock}` : ''}`;
      }
      default: return String(rrule);
    }
  }

  // 审批单正文：董事会要能一眼判断「该不该让它长期跑」——频率、干什么、谁干、归哪儿、烧多少。
  function describeRecurringJob(job, reason) {
    const seat = cfgFor(job.assignee);
    const lines = [
      reason ? `为什么建：${String(reason).slice(0, 600)}` : '为什么建：CEO 判断这活是长期重复的，值得排班。',
      `多久一次：${describeRRule(job.trigger.rrule)}（时区 ${job.trigger.timezone}）`,
      `每轮干什么：${job.taskTemplate.instructions.slice(0, 400)}`,
      `谁干：${seat?.postTitle ?? job.assignee}（担任：${seat?.holderName ?? job.assignee}）`,
      `归属项目：${job.project ?? '不归属任何项目（产物只留在公司）'}`,
      `每轮怎么算干完：${job.taskTemplate.acceptance.join('；')}`,
      `消耗：每轮最多 2 次唤醒；连续失败 3 轮会自动暂停等你处理。`,
      `有效期：到 ${String(job.termination?.validUntil ?? '').slice(0, 10)} 自动暂停${job.termination?.maxCycles ? `；最多 ${job.termination.maxCycles} 轮` : ''}，要续再点一次。`,
      '通过就按这个节奏自动跑；拒绝或改完再提交都行，有意见写在下面。',
    ];
    return lines.join('\n');
  }

  // CEO 提的排班建议 → 逐条出审批单。真正的注册发生在董事会点「通过」之后（server 的 handler）。
  // 一轮最多 3 条；同一条已在等审批时不重复出单；不合协议的记审计后丢掉，绝不静默吞掉。
  function requestRecurringApprovals(result, task, agentId) {
    const list = [
      ...(Array.isArray(result?.recurringSuggestions) ? result.recurringSuggestions : []),
      ...(result?.recurringSuggestion ? [result.recurringSuggestion] : []),
    ].filter((x) => x && typeof x === 'object').slice(0, 3);
    for (const sug of list) {
      const built = buildRecurringJob(sug, { task, requestedBy: agentId });
      if (built.error) {
        writeAudit(db, {
          actor: agentId, action: 'recurring_suggestion_rejected',
          newValue: `${String(sug.title ?? '(无标题)').slice(0, 60)}|${built.error}`.slice(0, 300),
          taskId: task.taskId,
        });
        continue;
      }
      const dup = db.prepare(`SELECT approvalId FROM approvals
        WHERE kind = 'recurring_create' AND status = 'pending' AND requestJson LIKE ?`)
        .get(`%"jobId":"${built.job.jobId}"%`);
      if (dup) continue;
      const approval = requestApproval({
        kind: 'recurring_create', taskId: task.taskId,
        title: `循环任务申请：${built.job.title}`,
        body: describeRecurringJob(built.job, sug.reason),
        payload: { job: built.job, rruleText: describeRRule(built.job.trigger.rrule) },
        requestedBy: agentId,
      });
      writeAudit(db, {
        actor: agentId, action: 'recurring_suggested',
        newValue: `${built.job.jobId}|${approval.approvalId}`, taskId: task.taskId,
      });
    }
  }

  // 阻塞 / 返工耗尽的统一上报：生成 escalation 事件，沿汇报线找决策者（§7.4）。
  function escalateTask(task, reason) {
    const dm = resolveDecisionMaker(config, task.assignee);
    emitEvent({
      type: 'escalation', taskId: task.taskId, agentId: dm,
      payload: { wakeReason: 'escalation', reason },
      dedupeKey: `blocked:${task.taskId}:${task.attempt ?? 0}`,
    });
    writeAudit(db, {
      actor: 'control-plane', action: 'blocked_escalated',
      newValue: `${task.assignee}→${dm}:${reason}`, taskId: task.taskId,
    });
    return { decisionMaker: dm };
  }

  function pendingApprovalFor(taskId, kind) {
    return db.prepare("SELECT * FROM approvals WHERE taskId = ? AND kind = ? AND status = 'pending'")
      .get(taskId, kind);
  }

  // 返工 2 次：优先转 company.yaml 配的救火席位（P4-5），没配就走人审。
  function escalateToRescue(task, reason) {
    const cfg = cfgFor(task.assignee);
    // G3：救火席位也得接得住这张卡的难度，否则「救火」等于把硬活塞给更弱的席位。
    const rescueSeat = cfg?.escalationTo ? cfgFor(cfg.escalationTo) : null;
    const rescueFits = rescueSeat
      && canTake({ agentId: rescueSeat.id, maxDifficulty: ceilingOf(rescueSeat) },
        task.difficulty ?? DEFAULT_DIFFICULTY);
    const rescue = rescueFits ? rescueSeat.id : null;
    if (!rescue || !cfgFor(rescue)) {
      return { escalated: false, ...escalateTask(task, reason) };
    }
    db.prepare('UPDATE tasks SET assignee = ?, attempt = 0, updatedAt = ? WHERE taskId = ?')
      .run(rescue, clockIso(), task.taskId);
    if (task.status === 'blocked') transition(db, task.taskId, 'todo', 'control-plane');
    writeAudit(db, {
      actor: 'control-plane', action: 'escalate_to_rescue',
      oldValue: task.assignee, newValue: rescue, taskId: task.taskId,
    });
    emitEvent({
      type: 'issue_assigned', taskId: task.taskId, agentId: rescue,
      payload: { wakeReason: 'rework', escalatedFrom: task.assignee },
      dedupeKey: `rescue:${task.taskId}:${reason.slice(0, 12)}`,
    });
    notifier.send({
      title: `返工二次：已转救火席位 ${rescue}`,
      body: `任务「${task.title}」连续返工，按配置转给 ${rescue} 接手（原席位 ${task.assignee}）。`,
      scene: 'escalation', taskId: task.taskId,
    });
    return { escalated: true, rescue };
  }

  function bumpRevision(task, { newInstructions, newAcceptance, approvedBy }) {
    const oldRev = task.revision ?? 1;
    const nextRev = oldRev + 1;
    const oldFile = revisionPath(workDir, task.taskId, oldRev);
    if (!fs.existsSync(oldFile)) {
      atomicWriteJson(oldFile, {
        taskId: task.taskId, revision: oldRev,
        instructions: task.instructions, acceptance: task.acceptance,
        approvedBy: 'original', createdAt: clockIso(),
      });
    }
    const instructions = newInstructions ?? task.instructions;
    const acceptance = newAcceptance ?? task.acceptance;
    atomicWriteJson(revisionPath(workDir, task.taskId, nextRev), {
      taskId: task.taskId, revision: nextRev, instructions, acceptance,
      approvedBy, createdAt: clockIso(),
    });
    db.prepare(`INSERT OR REPLACE INTO task_revisions
      (taskId, revision, instructionsSnapshot, acceptanceSnapshot, approvedBy, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      task.taskId, nextRev, instructions, JSON.stringify(acceptance), approvedBy, clockIso(),
    );
    db.prepare(`INSERT INTO task_payload
      (taskId, revision, instructions, acceptanceJson, completionReportPath, inputJson)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      task.taskId, nextRev, instructions, JSON.stringify(acceptance),
      task.completionReportPath ?? 'output/completion.json', JSON.stringify(task.input ?? { files: [] }),
    );
    db.prepare('UPDATE tasks SET revision = ?, updatedAt = ? WHERE taskId = ?')
      .run(nextRev, clockIso(), task.taskId);
    writeAudit(db, {
      actor: approvedBy, action: 'revision_bumped',
      oldValue: `rev${oldRev}`, newValue: `rev${nextRev}`, taskId: task.taskId,
    });
    return nextRev;
  }

  // P4-8 四种出口。resume 沿用原 runId；redo 换新 run；derive 另起卡；cancel 终态（§6D.5）。
  async function applyDecision(d) {
    const cr = db.prepare('SELECT * FROM change_requests WHERE changeRequestId = ?').get(d.changeRequestId);
    if (!cr) throw new Error(`变更请求不存在：${d.changeRequestId}`);
    const task = taskById(cr.taskId);
    if (!task) throw new Error(`任务不存在：${cr.taskId}`);
    if (task.status !== 'awaiting_decision') {
      throw new Error(`任务 ${task.taskId} 当前 ${task.status}，不在挂起态，不能决策`);
    }
    // 先验人能派到哪，再落决策记录：否则被拒的决策会在 decisions 里留一条假的「已拍板」。
    if (d.decision === 'derive' && d.deriveAssignee && cfgFor(d.decidedBy)) {
      const allowed = assertMayAssign(config, d.decidedBy, d.deriveAssignee);
      if (!allowed.ok) throw new Error(`跨子树派活被拒绝：${allowed.reason}`);
    }
    const decisionId = `DC-${shortId()}`;
    const record = { ...d, decisionId, createdAt: d.createdAt ?? clockIso() };
    db.prepare(`INSERT INTO decisions (decisionId, changeRequestId, taskId, decidedBy, decision, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      decisionId, d.changeRequestId, task.taskId, d.decidedBy, d.decision, record.createdAt,
    );
    atomicWriteJson(decisionPath(workDir, task.taskId, d.changeRequestId), record);
    writeAudit(db, {
      actor: d.decidedBy, action: 'decision_applied',
      newValue: `${d.decision}:${decisionId}`, taskId: task.taskId,
    });

    if (d.decision === 'cancel') {
      transition(db, task.taskId, 'cancelled', d.decidedBy);
      return { decisionId, decision: 'cancel', status: 'cancelled', wakes: 0 };
    }
    if (d.decision === 'derive') {
      const child = buildCard({
        requestId: `REQ-DERIVE-${shortId()}`, title: d.deriveTitle ?? `${task.title}（另起）`,
        assignee: d.deriveAssignee ?? task.assignee, mode: 'delegate', assignedBy: d.decidedBy,
        instructions: d.newInstructions ?? task.instructions,
        acceptance: d.newAcceptance ?? task.acceptance, parentTaskId: task.taskId,
        assignerId: cfgFor(d.decidedBy) ? d.decidedBy : null,
        project: task.project ?? null,
      });
      insertCard(child, child.assignee);
      transition(db, task.taskId, 'cancelled', d.decidedBy);
      writeAudit(db, { actor: d.decidedBy, action: 'derive_task', oldValue: task.taskId, newValue: child.taskId, taskId: child.taskId });
      return { decisionId, decision: 'derive', status: 'cancelled', childTaskId: child.taskId, wakes: 0 };
    }

    // resume / redo：先按需升版本，再回到 in_progress 唤醒同一席位。
    const touchesTarget = (typeof d.newInstructions === 'string' && d.newInstructions !== task.instructions)
      || (Array.isArray(d.newAcceptance) && d.newAcceptance.length > 0);
    let revision = task.revision ?? 1;
    if (touchesTarget) {
      revision = bumpRevision(task, {
        newInstructions: d.newInstructions, newAcceptance: d.newAcceptance, approvedBy: d.decidedBy,
      });
    }
    const isRedo = d.decision === 'redo';
    if (isRedo) {
      db.prepare('UPDATE tasks SET attempt = attempt + 1, updatedAt = ? WHERE taskId = ?').run(clockIso(), task.taskId);
    }
    transition(db, task.taskId, 'in_progress', d.decidedBy);
    const fresh = taskById(task.taskId);
    const outcome = await wake(task.taskId, fresh.assignee, 'decision', {
      resumeRunId: isRedo ? null : cr.runId,
      changeRequestId: d.changeRequestId,
      chosenOption: d.chosenOption ?? null,
      newInstructions: d.newInstructions ?? null,
      revision,
    });
    if (!outcome || outcome.skipped || outcome.failed) {
      return { decisionId, decision: d.decision, status: 'in_progress', wakes: 0, wakeSkipped: outcome?.reason ?? null };
    }
    await handleResult(outcome, fresh, fresh.assignee, { wakeReason: 'decision' });
    return { decisionId, decision: d.decision, status: 'in_progress', revision, runId: outcome.runId, wakes: 1 };
  }

  // 决策入口：动指令 / 验收必须走 replan 人审，其余直接执行（§6D.4）。
  async function submitDecision(payload) {
    const d = {
      schema: 'aicompany.decision/v1',
      createdAt: clockIso(),
      ...payload,
    };
    // 调 HTTP 的人手里只有 changeRequestId（在 URL 上）；taskId 由变更请求反查补全，
    // 免得每个客户端都要自己拼一份。给了就必须对得上，防止张冠李戴。
    const cr = db.prepare('SELECT * FROM change_requests WHERE changeRequestId = ?').get(d.changeRequestId);
    if (!cr) throw new Error(`变更请求不存在：${d.changeRequestId}`);
    if (!d.taskId) d.taskId = cr.taskId;
    else if (d.taskId !== cr.taskId) {
      throw new Error(`决策的 taskId ${d.taskId} 与变更请求所属任务 ${cr.taskId} 不一致`);
    }
    const checked = validate('decision', d);
    if (!checked.ok) throw new Error(`决策不合法：${checked.errors.join('; ')}`);
    const existing = db.prepare('SELECT decisionId, decision FROM decisions WHERE changeRequestId = ?').get(d.changeRequestId);
    if (existing) {
      // 同一份决策重投 = 幂等，回放原结果；换了结论再投 = 对已拍板的卡二次拍板，直接拒绝。
      if (existing.decision === d.decision) {
        return { duplicate: true, decisionId: existing.decisionId, changeRequestId: d.changeRequestId };
      }
      throw new Error(`变更请求 ${d.changeRequestId} 已按「${existing.decision}」拍板，不能改成「${d.decision}」重复决策`);
    }
    const task = taskById(cr.taskId);
    if (!task) throw new Error(`任务不存在：${cr.taskId}`);
    if (task.status !== 'awaiting_decision') {
      throw new Error(`任务 ${task.taskId} 当前 ${task.status}，不在挂起态，不能决策`);
    }
    const touches = (typeof d.newInstructions === 'string' && d.newInstructions.trim() !== '')
      || (Array.isArray(d.newAcceptance) && d.newAcceptance.length > 0);
    // 已经过审的决策：凭 approvalId 直接执行（否则每次重提都会再造一张 replan 审批，永远走不到执行）。
    const preApproved = d.approvalId ? getApproval(db, d.approvalId) : null;
    if (preApproved && preApproved.status === 'approved' && preApproved.kind === 'replan'
      && preApproved.taskId === task.taskId) {
      const applied2 = await applyDecision(d);
      const pumped2 = await pump();
      return { ...applied2, ...pumped2, approvedBy: preApproved.request?.payload?.decision?.decidedBy ?? null };
    }
    if (touches) {
      const approval = requestApproval({
        kind: 'replan', taskId: task.taskId,
        title: `改方案需人审：${task.title}`,
        body: `决策者 ${d.decidedBy} 提交 ${d.decision}，改动了 ${[
          d.newInstructions ? 'instructions' : null, d.newAcceptance ? 'acceptance' : null,
        ].filter(Boolean).join(' / ')}；任务继续挂起，等董事会点头。`,
        payload: {
          decision: d,
          before: { revision: task.revision, instructions: task.instructions, acceptance: task.acceptance },
          after: { instructions: d.newInstructions ?? task.instructions, acceptance: d.newAcceptance ?? task.acceptance },
        },
        requestedBy: d.decidedBy,
      });
      return { changeRequestId: d.changeRequestId, status: 'awaiting_approval', approvalId: approval.approvalId };
    }
    const applied = await applyDecision(d);
    const pumped = await pump();
    return { ...applied, ...pumped };
  }

  function decideApproval(approvalId, { decision, decidedBy = 'human', reason = null }) {
    const approval = getApproval(db, approvalId);
    if (!approval) throw new Error(`没有审批单 ${approvalId}`);
    if (approval.status !== 'pending') throw new Error(`审批单 ${approvalId} 已处理（${approval.status}）`);
    const closed = closeApproval(db, approvalId, { decision, decidedBy, reason });
    writeAudit(db, {
      actor: decidedBy, action: `approval_${decision}`,
      oldValue: approval.status, newValue: `${approval.kind}:${approvalId}`, taskId: approval.taskId,
    });
    const task = approval.taskId ? taskById(approval.taskId) : null;
    const payload = approval.request?.payload ?? {};

    if (approval.kind === 'recurring_change') {
      if (decision !== 'approved') return { approvalId, decision, applied: false, status: 'unchanged' };
      const handler = approvalHandlers.recurring_change;
      if (!handler) throw new Error('没有注册循环模板改版处理器（approvalHandlers.recurring_change）');
      return { approvalId, decision, applied: true, ...handler(payload, { decidedBy }) };
    }

    // 循环任务：CEO 提建议，董事会通过后才真注册进调度器。
    // 不批 = 调度器完全不知道有这条，绝不会自己开跑（长期烧额度的事必须人点头）。
    if (approval.kind === 'recurring_create') {
      if (decision !== 'approved') {
        writeAudit(db, {
          actor: decidedBy, action: 'recurring_create_rejected',
          newValue: `${approvalId}:${decision}`, taskId: approval.taskId,
        });
        notifier.send({
          title: `循环任务未通过：${approval.request?.title ?? approvalId}`,
          body: `董事会结论「${decision}」，这条排班不建；需要的话让总经理重新提。`,
          scene: 'recurring', taskId: approval.taskId,
        });
        return { approvalId, decision, applied: false, status: 'rejected' };
      }
      const handler = approvalHandlers.recurring_create;
      if (!handler) throw new Error('没有注册循环任务处理器（approvalHandlers.recurring_create）');
      try {
        const out = handler(payload, { decidedBy, approval });
        writeAudit(db, {
          actor: decidedBy, action: 'recurring_created',
          newValue: `${out?.jobId ?? payload?.job?.jobId ?? ''}`, taskId: approval.taskId,
        });
        return { approvalId, decision, applied: true, ...out };
      } catch (error) {
        // 注册不成（协议不合法 / 席位已删）不能留在「已通过」：退回待办并说清原因。
        db.prepare("UPDATE approvals SET status = 'pending', decidedAt = NULL WHERE approvalId = ?").run(approvalId);
        writeAudit(db, {
          actor: decidedBy, action: 'recurring_create_failed',
          newValue: `${approvalId}:${String(error.message).slice(0, 300)}`, taskId: approval.taskId,
        });
        return {
          approvalId, decision, applied: false, status: 'pending',
          error: `没建成，审批单已退回待办：${error.message}`,
        };
      }
    }

    // 董事会亲自验收（reviewBy: human）：通过就收账落盘，打回就带意见退回执行人。
    // 人只看结果：批不批不需要懂卡的状态机。
    if (approval.kind === 'task_review') {
      if (!task) {
        return { approvalId, decision, applied: false, error: '这张卡已经不在了（可能被取消）' };
      }
      const fresh = taskById(task.taskId);
      if (decision === 'approved') {
        if (fresh?.status !== 'in_review') {
          return { approvalId, decision, applied: false, status: fresh?.status, error: '卡已经不在待审状态，可能已处理过' };
        }
        // 服务可能中途重启过，内存里的报告没了：用审批单里存的快照补回去，
        // 否则记忆不写、审计上只剩「通过了」却查不到这次学到了什么。
        if (!pendingMemory.has(task.taskId)) {
          pendingMemory.set(task.taskId, {
            status: 'success',
            summary: String(payload.summary ?? ''),
            artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
            acceptanceResults: Array.isArray(payload.acceptanceResults) ? payload.acceptanceResults : [],
          });
        }
        transition(db, task.taskId, 'done', decidedBy, null);
        writeAudit(db, {
          actor: decidedBy, action: 'board_accepted',
          newValue: `${approvalId}|${String(reason ?? '').slice(0, 200) || '无意见'}`, taskId: task.taskId,
        });
        flushProjectMemory(fresh ?? task, null);
        deliverAccepted(fresh ?? task, null);
        return { approvalId, decision, applied: true, taskId: task.taskId, status: 'done' };
      }
      // 打回：退回执行人重做，人的话原样带过去（这是它下一次唯一的依据）。
      if (fresh?.status !== 'in_review') {
        return { approvalId, decision, applied: false, status: fresh?.status, error: '卡已经不在待审状态' };
      }
      const note = String(reason ?? '').trim() || '董事会打回，但没写具体意见：按验收条件逐条自查后重交。';
      transition(db, task.taskId, 'in_progress', decidedBy, null);
      writeAudit(db, {
        actor: decidedBy, action: 'board_rework',
        newValue: `${approvalId}|${note.slice(0, 300)}`, taskId: task.taskId,
      });
      emitEvent({
        type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
        payload: { wakeReason: 'rework', reviewNote: note },
        dedupeKey: `board-rework:${task.taskId}:${Date.now()}`,
      });
      return { approvalId, decision, applied: true, taskId: task.taskId, status: 'in_progress' };
    }

    if (approval.kind === 'project_create') {
      // 被项目闸拦下、正在等这张单的父卡：批或拒都要把它放出来，不能永远停在挂起态。
      const releaseGatedTask = (note) => {
        if (!task) return false;
        const cur = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(task.taskId)?.status;
        if (cur !== 'awaiting_decision') return false;
        transition(db, task.taskId, 'in_progress', decidedBy);
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
          payload: { wakeReason: 'decision', note },
          dedupeKey: `project-decided:${task.taskId}:${approvalId}`,
        });
        writeAudit(db, { actor: decidedBy, action: 'project_gate_released', newValue: note, taskId: task.taskId });
        return true;
      };
      // CEO 建议建项目 → 董事会点头才真建。通过 = 建目录 + 写起步规范 + 记进配置。
      if (decision !== 'approved') {
        writeAudit(db, {
          actor: decidedBy, action: 'project_create_rejected',
          newValue: `${approvalId}:${decision}`, taskId: approval.taskId,
        });
        notifier.send({
          title: `建项目未通过：${approval.request?.title ?? approvalId}`,
          body: `董事会结论「${decision}」，这个项目不建；相关任务按一次性任务或已有项目处理。`,
          scene: 'project', taskId: approval.taskId,
        });
        // 这一轮按一次性任务继续：项目不批不等于活不做。
        releaseGatedTask('项目未通过，按一次性任务继续（产物只留在公司）');
        return { approvalId, decision, applied: false, status: 'rejected' };
      }
      const handler = approvalHandlers.project_create;
      if (!handler) throw new Error('没有注册建项目处理器（approvalHandlers.project_create）');
      try {
        const out = handler(payload, { decidedBy, approval });
        writeAudit(db, {
          actor: decidedBy, action: 'project_created',
          newValue: String(out?.project?.id ?? payload?.project?.id ?? ''), taskId: approval.taskId,
        });
        // 项目建好了：把当初等它的父卡放出来重拆，这轮才会带上项目归属（产物/经验/交付才有着落）。
        releaseGatedTask(`项目 ${out?.project?.id ?? ''} 已批准，重新拆解`);
        return { approvalId, decision, applied: true, ...out };
      } catch (error) {
        // 建不成（例：CEO 填的落盘目录不存在）不能把审批单留在「已通过」——
        // 回滚成待办，把原因原样给董事会，项目一点都没建。
        db.prepare("UPDATE approvals SET status = 'pending', decidedAt = NULL WHERE approvalId = ?").run(approvalId);
        writeAudit(db, {
          actor: decidedBy, action: 'project_create_failed',
          newValue: `${approvalId}:${String(error.message).slice(0, 300)}`, taskId: approval.taskId,
        });
        return {
          approvalId, decision, applied: false, status: 'pending',
          error: `没建成，审批单已退回待办：${error.message}`,
        };
      }
    }

    if (approval.kind === 'replan') {
      if (decision !== 'approved') {
        writeAudit(db, {
          actor: decidedBy, action: 'replan_rejected',
          newValue: `${approvalId}:${decision}`, taskId: approval.taskId,
        });
        notifier.send({
          title: `改方案未通过：${task?.title ?? approval.taskId}`,
          body: `董事会对 replan 的结论是「${decision}」，任务保持挂起，等决策者重新提交。`,
          scene: 'replan', taskId: approval.taskId,
        });
        return { approvalId, decision, applied: false, status: 'awaiting_decision' };
      }
      // 盖授权章：同一份 decision 带着 approvalId 重提时直接执行，不再二次生成审批。
      stampRequestPayload(db, approvalId, {
        decision: { ...(payload.decision ?? {}), approvalId },
      });
      writeAudit(db, {
        actor: decidedBy, action: 'replan_approved',
        newValue: `${approvalId}:${payload.decision?.decision ?? '?'}`, taskId: approval.taskId,
      });
      return { approvalId, decision, applied: true };
    }

    if (!task) return { approvalId, decision, applied: false, status: 'no_task' };

    if (approval.kind === 'strategy') {
      if (decision === 'approved') {
        const child = payload.child ?? {};
        if (child.assignee) {
          const card = buildCard({
            requestId: task.requestId, title: child.title ?? '子任务',
            role: child.role ?? 'general', assignee: child.assignee, mode: 'delegate',
            assignedBy: 'ceo', parentTaskId: task.taskId,
            instructions: child.instructions, acceptance: child.acceptance,
            assignerId: ceoId(), project: task.project ?? null,
          });
          insertCard(card, card.assignee);
        }
        transition(db, task.taskId, 'in_review', 'ceo');
        transition(db, task.taskId, 'done', 'ceo');
        writeAudit(db, { actor: decidedBy, action: 'strategy_approved', newValue: task.taskId, taskId: task.taskId });
        return { approvalId, decision, applied: true, taskId: task.taskId };
      }
      if (decision === 'rewrite') {
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
          payload: { wakeReason: 'rework', note: reason ?? '战略拆解被要求重写' },
          dedupeKey: `strategy-rewrite:${task.taskId}:${approvalId}`,
        });
        return { approvalId, decision, applied: true, action: 'rework' };
      }
      transition(db, task.taskId, 'cancelled', decidedBy);
      return { approvalId, decision, applied: true, action: 'cancelled' };
    }

    if (approval.kind === 'review_reject') {
      if (decision === 'approved') {
        // 打回返工
        if (task.status === 'blocked') transition(db, task.taskId, 'todo', decidedBy);
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
          payload: { wakeReason: 'rework', note: reason ?? '验收打回，按意见重做' },
          dedupeKey: `approval-rework:${task.taskId}:${approvalId}`,
        });
        return { approvalId, decision, applied: true, action: 'rework' };
      }
      if (decision === 'rewrite') {
        // 换人：优先 escalationTo（且接得住这张卡的难度），其次配额最充足、接得住的执行席位
        const cfg = cfgFor(task.assignee);
        const roomFor = (id) => {
          const target = cfgFor(id);
          return target && canTake({ agentId: id, maxDifficulty: ceilingOf(target) }, task.difficulty ?? DEFAULT_DIFFICULTY);
        };
        const candidate = (cfg?.escalationTo && roomFor(cfg.escalationTo) ? cfg.escalationTo : null)
          ?? rankCandidates(getAgentCandidates(), {
            needCapability: 'execute', difficulty: task.difficulty ?? DEFAULT_DIFFICULTY,
          })
            .find((c) => c.agentId !== task.assignee)?.agentId;
        if (!candidate) throw new Error('没有可替换的执行席位');
        db.prepare('UPDATE tasks SET assignee = ?, attempt = 0, updatedAt = ? WHERE taskId = ?')
          .run(candidate, clockIso(), task.taskId);
        if (task.status === 'blocked') transition(db, task.taskId, 'todo', decidedBy);
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId: candidate,
          payload: { wakeReason: 'rework', reassignedFrom: task.assignee },
          dedupeKey: `approval-reassign:${task.taskId}:${approvalId}`,
        });
        writeAudit(db, {
          actor: decidedBy, action: 'approval_reassign',
          oldValue: task.assignee, newValue: candidate, taskId: task.taskId,
        });
        return { approvalId, decision, applied: true, action: 'reassign', assignee: candidate };
      }
      if (task.status !== 'cancelled') transition(db, task.taskId, 'cancelled', decidedBy);
      return { approvalId, decision, applied: true, action: 'cancelled' };
    }

    // hiring_budget：只记录结论，不自动改任务状态。
    return { approvalId, kind: approval.kind, decision, applied: false, status: decision };
  }

  // 挂起超时：24h 提醒、72h 自动取消，绝不自动恢复（§6D.3）。
  function expireDecisions({ now = clock() } = {}) {
    const remindH = config.decision?.remindAfterHours ?? DEFAULTS.decisionRemindHours;
    const maxH = config.decision?.maxPendingHours ?? DEFAULTS.decisionMaxPendingHours;
    const rows = db.prepare(`SELECT c.changeRequestId, c.taskId, c.createdAt AS crCreatedAt, t.status
      FROM change_requests c JOIN tasks t ON t.taskId = c.taskId
      WHERE t.status = 'awaiting_decision'`).all();
    const cancelled = [];
    const reminded = [];
    for (const row of rows) {
      const ageH = (now.getTime() - Date.parse(row.crCreatedAt)) / 3_600_000;
      if (ageH >= maxH) {
        transition(db, row.taskId, 'cancelled', 'control-plane');
        writeAudit(db, {
          actor: 'scheduler', action: 'decision_timeout',
          newValue: `${row.changeRequestId}:${Math.floor(ageH)}h`, taskId: row.taskId,
        });
        crMarkDecision(row.changeRequestId, 'expired');
        notifier.send({
          title: `挂起超时已自动取消：${row.taskId}`,
          body: `变更请求 ${row.changeRequestId} 挂了 ${Math.floor(ageH)} 小时无人拍板，按规则自动取消；快照与产物保留可查，不会自动恢复。`,
          scene: 'decision_timeout', taskId: row.taskId,
        });
        cancelled.push(row.taskId);
      } else if (ageH >= remindH) {
        const seen = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'decision_reminder' AND newValue = ?")
          .get(row.changeRequestId).n;
        if (seen === 0) {
          writeAudit(db, {
            actor: 'scheduler', action: 'decision_reminder',
            newValue: row.changeRequestId, taskId: row.taskId,
          });
          notifier.send({
            title: `还在等拍板：${row.taskId}`,
            body: `变更请求 ${row.changeRequestId} 已挂起 ${Math.floor(ageH)} 小时；超过 ${maxH} 小时会自动取消。`,
            scene: 'decision_reminder', taskId: row.taskId,
          });
          reminded.push(row.taskId);
        }
      }
    }
    return { scanned: rows.length, cancelled, reminded };
  }

  function crMarkDecision(changeRequestId, decision) {
    // 只写审计，不删任何记录；change_requests 表本身没有状态列（协议冻结不动）。
    writeAudit(db, {
      actor: 'scheduler', action: `change_request_${decision}`, newValue: changeRequestId,
    });
  }

  // P7：卡真的到 done 才落记忆。元数据由引擎补，员工只能影响「本次新增的这一条」。
  function flushProjectMemory(task, runId) {
    const report = pendingMemory.get(task?.taskId);
    pendingMemory.delete(task?.taskId);
    if (!task?.project) return null;
    try {
      const built = buildMemoryRecord({
        task, report, agentId: task.assignee ?? null, at: clockIso(),
      });
      if (!built.ok) {
        // 校验不过只留审计、不入库：记忆宁缺毋滥，写花了不污染库。
        writeAudit(db, {
          actor: task.assignee ?? 'control-plane', action: 'memory_rejected',
          newValue: String(built.error).slice(0, 300), runId, taskId: task.taskId,
        });
        return null;
      }
      appendMemory(workDir, task.project, built.record);
      writeAudit(db, {
        actor: 'control-plane', action: 'memory_written',
        newValue: `${task.project}|${built.record.lessons.length} 条教训 / ${built.record.nextHints.length} 条下次`.slice(0, 300),
        runId, taskId: task.taskId,
      });
      return built.record;
    } catch (error) {
      writeAudit(db, {
        actor: 'control-plane', action: 'memory_write_failed',
        newValue: String(error.message).slice(0, 300), runId, taskId: task.taskId,
      });
      return null;
    }
  }

  // P7-5：卡真正 done 才把产物落到项目自己的文件夹。
  // 三条纪律：没配 rootDir 的项目不落；别人占着（译台等）就先不落、等心跳重试；落盘失败不改卡状态。
  const deliverAttempts = new Map();
  function deliverAccepted(task, runId) {
    if (!task?.project || !task?.taskId) return null;
    const entry = config?.projects?.[task.project] ?? {};
    if (!entry.rootDir) return null;
    const running = runningProcesses(entry.deliverBlockers ?? []);
    if (running.length) {
      writeAudit(db, {
        actor: 'control-plane', action: 'deliver_deferred',
        newValue: `${task.project}|${running.join(',')} 正在占用，等它关掉再落`.slice(0, 300),
        runId, taskId: task.taskId,
      });
      return { deferred: true, running };
    }
    const out = deliverTask({ workRoot: workDir, config, task, at: clockIso() });
    if (out.ok) {
      writeAudit(db, {
        actor: 'control-plane', action: 'delivered',
        newValue: `${task.project}|${out.copied.length} 个文件 → ${out.targetDir}`.slice(0, 300),
        runId, taskId: task.taskId,
      });
    } else if (out.code === 'NO_ARTIFACTS') {
      // 「这卡天生没有产物」（只排班 / 只给建议 / 只做验收）不是失败：
      // 记一条账就算结案，否则维护心跳每重启一次就再刷 5 条 deliver_failed，
      // 把真正的落盘失败埋进噪音里。
      try {
        appendDeliveryLog(workDir, task.project, {
          schema: DELIVERY_SCHEMA,
          taskId: task.taskId,
          project: task.project,
          at: clockIso(),
          targetDir: out.targetDir ?? null,
          copied: [],
          failed: [],
          code: 'NO_ARTIFACTS',
          note: '本卡没有产物，无物可落（不是失败）',
        });
      } catch { /* 账写不进去也不该改卡状态 */ }
      writeAudit(db, {
        actor: 'control-plane', action: 'deliver_skipped',
        newValue: `${task.project}|本卡无产物，记一次账不再重试`.slice(0, 300),
        runId, taskId: task.taskId,
      });
    } else {
      const why = out.error ?? (out.failed ?? []).map((f) => f.reason).join('; ') ?? '';
      writeAudit(db, {
        actor: 'control-plane', action: 'deliver_failed',
        newValue: `${out.code ?? 'ERROR'}|${why}`.slice(0, 300),
        runId, taskId: task.taskId,
      });
    }
    return out;
  }

  // 维护心跳顺手补落盘：卡已 done、清单里没有成功记录 → 再试一次，最多 5 次。
  function retryPendingDeliveries({ limit = 5 } = {}) {
    const rows = db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND project IS NOT NULL
      ORDER BY updatedAt DESC LIMIT 30`).all();
    let retried = 0;
    for (const row of rows) {
      const entry = config?.projects?.[row.project] ?? {};
      if (!entry.rootDir) continue;
      const last = lastDeliveryOf(workDir, row.project, row.taskId);
      // 已记过账就结案：要么真落成了（copied 有文件），要么是「天生没产物」（NO_ARTIFACTS）。
      // 后者以前会被当成失败反复重试，重启一次刷一轮，纯噪音。
      if (last && (last.code === 'NO_ARTIFACTS'
        || (Array.isArray(last.failed) && last.failed.length === 0 && last.copied?.length))) continue;
      const attempts = deliverAttempts.get(row.taskId) ?? 0;
      if (attempts >= 5) continue;
      if (runningProcesses(entry.deliverBlockers ?? []).length) continue;
      deliverAttempts.set(row.taskId, attempts + 1);
      deliverAccepted(row, null);
      retried += 1;
      if (retried >= limit) break;
    }
    return retried;
  }

  // G2：状态机是全国的统一出口，终态通知挂在这里，任何路径进 done/blocked/cancelled 都不会漏。
  // 循环引擎自己收账走的是直接 UPDATE（completeCycle），不经过这里，不会自激。
  // 上游 done → 放行下游：只放「所有前置都已 done」的，已经在排队的不重复投。
  // 除了 done 时立刻调，维护心跳也会扫一遍兜底（事件丢了 / 重启后卡住都能自己恢复）。
  function releaseReadyDependencies() {
    const rows = db.prepare("SELECT * FROM tasks WHERE status = 'todo' AND dependsOn IS NOT NULL").all();
    let released = 0;
    for (const row of rows) {
      const deps = dependsOnOf(row);
      if (!deps.length) continue;
      if (unmetDependencies(row).length) continue;
      const pending = db.prepare(`SELECT 1 FROM events WHERE taskId = ? AND processed = 0
        AND type = 'issue_assigned' LIMIT 1`).get(row.taskId);
      if (pending) continue;
      emitEvent({
        type: 'issue_assigned', taskId: row.taskId, agentId: row.assignee,
        payload: { wakeReason: 'issue_assigned', after: deps.join(',') },
        // 每次都不同：被闸门拦下后还要能重投，靠上面那条 pending 检查防重复。
        dedupeKey: `dep-release:${row.taskId}:${nowIso()}`,
      });
      writeAudit(db, {
        actor: 'control-plane', action: 'dependency_released',
        newValue: `${row.taskId} 的前置已全部完成（${deps.join(',')}）`, taskId: row.taskId,
      });
      released += 1;
    }
    return released;
  }

  // 看板要一句话说清「这张卡为什么停着」。只看最近一条相关记录，不扫全历史。
  // 返回 { taskId: '原因' }；没停着的卡不出现（前端据此决定要不要显示那一行小字）。
  const HOLD_LABEL = {
    difficulty_blocked: '没人接得住这个难度',
    gate_blocked: '闸门拦着',
    wake_rejected: '派不出去',
    blocked_escalated: '员工报卡住了',
    review_rejected: '被打回返工',
    deliver_deferred: '等对方程序关掉再落盘',
  };
  function holdReasons() {
    const rows = db.prepare(`SELECT taskId, status, dependsOn FROM tasks
      WHERE status IN ('todo','in_progress','in_review','blocked','paused','awaiting_decision')`).all();
    const out = {};
    for (const row of rows) {
      if (row.status === 'awaiting_decision') { out[row.taskId] = '等你拍板'; continue; }
      // 董事会亲审：卡停在 in_review，要让人看出这是「等他」而不是「等员工」。
      if (row.status === 'in_review') {
        const card = taskById(row.taskId);
        if (card && reviewerOf(card) === 'human') {
          out[row.taskId] = '等你拍板（审批区里能看到结果）';
          continue;
        }
      }
      const unmet = unmetDependencies(row);
      if (unmet.length) {
        out[row.taskId] = `等前置卡 ${unmet.map((x) => String(x).replace(/^T-/, '')).join('、')} 做完`;
        continue;
      }
      const last = db.prepare(`SELECT action, newValue FROM audit WHERE taskId = ?
        AND action IN ('difficulty_blocked','gate_blocked','wake_rejected','blocked_escalated','review_rejected')
        ORDER BY rowid DESC LIMIT 1`).get(row.taskId);
      if (!last) continue;
      const label = HOLD_LABEL[last.action] ?? last.action;
      const detail = String(last.newValue ?? '').slice(0, 80);
      out[row.taskId] = detail ? `${label}：${detail}` : label;
    }
    return out;
  }

  function transition(dbHandle, taskId, to, actor = 'control-plane', runId = null) {
    const out = rawTransition(dbHandle, taskId, to, actor, runId);
    if (to === 'done' || to === 'blocked' || to === 'cancelled') noteTaskTerminal(taskId, to, runId);
    if (to === 'done') releaseReadyDependencies();
    return out;
  }

  // G2：卡到终态时通知外部。循环引擎据此做「完成即触发下一轮」。
  // 钩子是外部注入的，失败绝不能把一张已经办完的卡拖回失败态——只留审计。
  function noteTaskTerminal(taskId, status, runId = null) {
    if (typeof taskTerminalHook !== 'function') return;
    try {
      taskTerminalHook({ taskId, status, runId, at: clockIso() });
    } catch (error) {
      writeAudit(db, {
        actor: 'control-plane', action: 'terminal_hook_failed',
        newValue: `${status}|${String(error.message).slice(0, 200)}`, runId, taskId,
      });
    }
  }

  // ── 产物分类与交付路由（2026-11-16）──────────────────────────────
  // 执行岗干完自己判「这算什么产物、该往哪走」，引擎只做兜底与校验：
  //   · 受管代码必须登记仓库，否则打回（代码流到没人管的地方，比没写更糟）；
  //   · 一次性脚本（scratch-code）不建审查、不入 git，只归档；
  //   · 判成 review 且验收人不是总经理时，卡留在 in_review 等人来审（拉模式席位不能被直调）。
  function inferArtifactKind(task, report = {}) {
    const declared = String(report.artifactKind ?? '').trim();
    if (ARTIFACT_KINDS.includes(declared)) return { kind: declared, inferred: false };
    if (task.repo) return { kind: 'managed-code', inferred: true };
    const exts = config.artifacts?.codeExtensions ?? [];
    const files = Array.isArray(report.artifacts) ? report.artifacts : [];
    const codeFiles = files.filter((f) => exts.some((ext) => String(f).toLowerCase().endsWith(ext)));
    if (codeFiles.length && looksLikeCode(task, config.artifacts)) return { kind: 'managed-code', inferred: true };
    if (codeFiles.length) return { kind: 'scratch-code', inferred: true };
    return { kind: 'document', inferred: true };
  }

  /**
   * 发布者：这张卡是谁下的。
   * 「谁发布谁负责」是整条交付路由的地基：
   *   董事会（人）派的 → 只对董事会负责，干完直接落盘，不惊动 CEO；
   *   上级 agent 派的 → 回上级审，发布者必须看到结果；
   *   认不出（老数据）→ unknown，走全局兜底（保守：交审）。
   */
  function issuerOf(task) {
    const raw = String(task?.assignerId ?? '').trim();
    if (raw && raw !== 'human') {
      // 存的可能是岗位 id（ceo）也可能是担任者 id，两种都认。
      const hit = (config.agents ?? []).find((a) => a.id === raw || a.postTitle === raw);
      return { kind: 'agent', id: hit?.id ?? raw };
    }
    if (raw === 'human') return { kind: 'board', id: null };
    const by = String(task?.assignedBy ?? '').trim();
    // policy = 人提需求、系统按规则挑的人：责任还在董事会这一侧。
    if (by === 'human' || by === 'policy') return { kind: 'board', id: null };
    if (by === 'ceo') return { kind: 'agent', id: ceoId() };
    // 'seat' 但没记 assignerId 的老数据：认不出发布者，不能拿它当免审理由。
    return { kind: 'unknown', id: null };
  }

  /** 口头写法归一：'ceo' 就是「交总经理验收」；认不出的返回 null（当没写）。 */
  function normalizeHandoff(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (raw === 'ceo') return 'review';
    return HANDOFF_TARGETS.includes(raw) ? raw : null;
  }

  function resolveHandoff(task, kind, report = {}) {
    const issuer = issuerOf(task);
    // ① 发布者建卡时就写死的路由：最权威。
    const pinned = normalizeHandoff(task.handoff);
    // ② 执行者交活时自报的路由：只能往「更严」的方向改。
    const declared = normalizeHandoff(report.handoff);
    const out = { issuer, source: 'derived', downgraded: null, inferred: true };

    if (pinned) {
      out.source = 'card';
      out.inferred = false;
      // 发布者定了「落盘」，执行者发现不对要交审 / 上报：允许（往上调是负责，不是越权）。
      if (pinned === 'land' && (declared === 'review' || declared === 'escalate')) {
        out.handoff = declared;
        out.source = 'worker-upgraded';
        return out;
      }
      // 发布者定了「要审 / 要上报」，执行者想改成直接落盘：只有发布者明确授权才行。
      if (pinned !== 'land' && declared === 'land' && !task.allowSelfLand) {
        out.downgraded = 'self-land-ignored';
      }
      out.handoff = pinned;
      return out;
    }

    if (declared) {
      // ③ 上级派的活，员工无权替上级免审：自报 land 一律降级为交审（除非发布者授权）。
      if (declared === 'land' && issuer.kind === 'agent' && !task.allowSelfLand) {
        out.downgraded = 'agent-card-cannot-self-land';
        out.handoff = 'review';
      } else {
        out.handoff = declared;
        out.source = 'report';
        out.inferred = false;
      }
    } else {
      // ④ 都没写：按发布者推。这是本轮改动的核心——不再全局一刀切。
      // 但卡上写明了「谁来审」，那就是要审的意思，别再猜成落盘。
      if (task.reviewBy) {
        out.handoff = 'review';
        out.source = 'review-by';
      } else if (issuer.kind === 'board') out.handoff = 'land';
      else if (issuer.kind === 'agent') out.handoff = 'review';
      else out.handoff = config.artifacts?.defaultHandoff === 'land' ? 'land' : 'review';
    }

    // ⑤ 受管代码永远要审：这是「以后还要改的东西」，不能靠谁的一句话免掉。
    if (kind === 'managed-code' && out.handoff !== 'review') {
      out.handoff = 'review';
      out.codeForced = true;
    }
    return out;
  }

  function reviewerOf(task, kind = null) {
    if (task.reviewBy) return task.reviewBy;
    // 没传 kind 时（手工审 / 查待审列表），用「这张卡有没有仓库」兜底判断是不是代码活。
    const isCode = kind === 'managed-code' || (!kind && Boolean(task.repo));
    if (isCode) {
      const repo = repoEntry(config, task.repo);
      if (repo?.reviewer) return repo.reviewer;
      if (config.artifacts?.defaultReviewer) return config.artifacts.defaultReviewer;
    }
    // 「谁发布谁审」：上级派的活回上级，不再一律丢给总经理。
    const issuer = issuerOf(task);
    if (issuer.kind === 'agent') return issuer.id;
    return ceoId();
  }

  /** 一张卡的交付路由快照：给提示词用，也给看板用（不用前端再啃一遍规则）。 */
  function handoffPolicyOf(task) {
    const issuer = issuerOf(task);
    const kind = inferArtifactKind(task, {}).kind;
    const reviewer = reviewerOf(task, kind);
    return {
      issuerKind: issuer.kind,
      issuerId: issuer.id,
      issuerLabel: issuer.kind === 'board' ? '董事会' : (issuer.id ?? '未知'),
      pinned: normalizeHandoff(task.handoff),
      defaultHandoff: resolveHandoff(task, kind, {}).handoff,
      reviewer,
      reviewerIsCeo: reviewer === ceoId(),
      allowSelfLand: task.allowSelfLand === true,
    };
  }

  /** 执行者想在报告里指定「交给谁审」，必须过这道闸：
   * 只能指自己汇报链上的上级（或配置里的默认审查人）。
   * 不加这道闸，员工就能把审查人换成自己人，甚至换成自己——审查形同虚设。
   */
  function checkReviewBy(task, wanted) {
    const target = String(wanted ?? '').trim();
    if (!target) return { ok: true, reviewer: null };
    // 请董事会自己看：永远合法（他是最高权力，谈不上「越权指定上级」）。
    if (BOARD_ALIASES.has(target.toLowerCase())) return { ok: true, reviewer: 'human' };
    if (target === task.assignee) return { ok: false, reason: '不能指定自己审自己' };
    if (!(config.agents ?? []).some((a) => a.id === target || a.postTitle === target)) {
      return { ok: false, reason: `没有这个岗位：${target}` };
    }
    const norm = (config.agents ?? []).find((a) => a.id === target || a.postTitle === target)?.id ?? target;
    const allow = new Set(ancestors(config, task.assignee));
    if (config.artifacts?.defaultReviewer) allow.add(config.artifacts.defaultReviewer);
    // 董事会点名的审查人可以放宽（人自己定的责任链，引擎不替他改）。
    if (issuerOf(task).kind === 'agent') allow.add(issuerOf(task).id);
    if (!allow.has(norm)) {
      return { ok: false, reason: `${target} 不在 ${task.assignee} 的汇报链上，不能当审查人` };
    }
    return { ok: true, reviewer: norm };
  }

  /** 执行岗主动上报：卡转 blocked，不重试；给上级建一张「处理升级」的卡，让他带着证据决定。 */
  function openEscalation(task, report, agentId, runId, { reason }) {
    const to = task.escalationTo
      ?? cfgFor(task.assignee)?.escalationTo
      ?? task.reportsTo
      ?? resolveDecisionMaker(config, task.assignee);
    if (task.status !== 'blocked') transition(db, task.taskId, 'blocked', agentId, runId);
    writeAudit(db, {
      actor: agentId, action: 'escalated',
      newValue: `${to ?? '(无上级)'}|${String(reason ?? '').slice(0, 400)}`, runId, taskId: task.taskId,
    });
    if (!to || to === agentId) return { to: null, card: null };
    const evidence = [
      `【原卡】${task.taskId}｜${task.title}`,
      `【执行人】${task.assignee}`,
      `【卡在哪】${String(reason ?? report.reason ?? '(没写原因)').slice(0, 1500)}`,
      report.summary ? `【已做到哪】${String(report.summary).slice(0, 800)}` : null,
      Array.isArray(report.artifacts) && report.artifacts.length
        ? `【产物】${report.artifacts.join(', ')}` : null,
      task.repo ? `【仓库】${task.repo}（别在没定方案前提交/推送）` : null,
      '',
      '【你要决定的一件事】',
      '1）改方案返工：把「改成什么」写清，让原执行人重跑；',
      '2）改派给别人；',
      '3）如果这会改变项目方向/对外承诺，上报总经理（你只负责把技术事实说清，不要自己拍板）。',
    ].filter(Boolean).join('\n');
    const card = buildCard({
      requestId: task.requestId,
      title: `处理升级：${task.title}`.slice(0, 80),
      role: 'escalation', assignee: to, mode: 'delegate', assignedBy: 'control-plane',
      parentTaskId: task.taskId,
      instructions: evidence,
      acceptance: ['明确给出一条处置：返工（改什么）/ 改派（给谁）/ 上报总经理（为什么必须他拍板）'],
      difficulty: task.difficulty, project: task.project, repo: task.repo,
    });
    insertCard(card, to);
    return { to, card: card.taskId };
  }

  /**
   * 交审查结论。人、CEO、工程岗都走这一个入口。
   * 为什么单独成一个动作而不是「再唤醒一次」：拉模式席位（工程岗）不能被直调，
   * 它只能自己来查、自己来判。把审查做成动作，谁审都一样。
   */
  function reviewTask(taskId, {
    reviewer, verdict, reason = '', summary = '', commit = null,
  } = {}) {
    const task = taskById(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.status !== 'in_review') {
      throw new Error(`只有 in_review 的卡能验收，${taskId} 现在是 ${task.status}`);
    }
    const expected = reviewerOf(task, null);
    if (reviewer && reviewer !== expected && reviewer !== ceoId()) {
      throw new Error(`这张卡该由 ${expected} 验收，不是 ${reviewer}`);
    }
    const actor = reviewer ?? expected;
    const pass = verdict === 'pass';
    if (!pass && !String(reason ?? '').trim()) {
      throw new Error('打回必须写 reason：要改什么，执行人只看这一句');
    }
    writeAudit(db, {
      actor, action: pass ? 'review_passed' : 'review_rejected',
      newValue: `${taskId}|${String(reason || summary || '').slice(0, 500)}`
        + (commit ? `|commit:${String(commit).slice(0, 80)}` : ''),
      taskId,
    });
    if (pass) {
      transition(db, taskId, 'done', actor);
      flushProjectMemory(taskById(taskId) ?? task);
      deliverAccepted(taskById(taskId) ?? task);
      return { taskId, status: 'done', verdict: 'pass' };
    }
    transition(db, taskId, 'in_progress', actor);
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE taskId = ? AND wakeReason IN ('review_requested','rework')")
      .get(taskId).n;
    if (rounds <= 2) {
      emitEvent({
        type: 'issue_assigned', taskId, agentId: task.assignee,
        payload: { wakeReason: 'rework', reviewNote: String(reason).slice(0, 800) },
        dedupeKey: `review-reject:${taskId}:${Date.now()}`,
      });
    } else {
      escalateToRescue(task, '验收连续多次打回');
    }
    return { taskId, status: 'in_progress', verdict: 'reject' };
  }

  /**
   * 董事会自己审：把结果摊成一张待拍板单。
   * 人看到的必须是「结果」而不是「一张卡的元数据」：干了什么、产出哪些文件、验收条件过没过。
   * 通过 → 卡自动 done 并落盘；打回 → 卡退回执行人，附上人写的意见。
   */
  function requestTaskReview(task, report, kind, runId = null) {
    const pending = db.prepare(`SELECT approvalId FROM approvals
      WHERE kind = 'task_review' AND taskId = ? AND status = 'pending'`).get(task.taskId);
    if (pending) return { approvalId: pending.approvalId, reused: true };
    const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
    const checks = Array.isArray(report.acceptanceResults) ? report.acceptanceResults : [];
    const taskRow = taskById(task.taskId) ?? task;
    const body = [
      `谁干的：${task.assignee}`,
      `干了什么：${String(report.summary ?? '(未写总结)').slice(0, 600)}`,
      artifacts.length ? `产出：${artifacts.join('、')}` : '产出：没有文件（结果写在报告里）',
      `产物类型：${kind}`,
      checks.length
        ? `验收条件：${checks.map((c) => `${c.pass === false ? '✗' : '✓'} ${c.rule}`).join('；')}`
        : '验收条件：未逐条回执',
      taskRow?.project ? `归属项目：${taskRow.project}` : '归属项目：无（一次性任务）',
    ].join('\n');
    return requestApproval({
      kind: 'task_review',
      taskId: task.taskId,
      title: `待拍板：${task.title}`,
      body,
      payload: {
        taskId: task.taskId, title: task.title, assignee: task.assignee,
        summary: String(report.summary ?? ''), artifacts, kind,
        acceptanceResults: checks, runId,
        project: taskRow?.project ?? null,
        repo: taskRow?.repo ?? null,
        // 产物在磁盘上的位置（看板直接给人点）
        workDir: workDir ? path.join(workDir, 'tasks', task.taskId, 'output') : null,
      },
      requestedBy: task.assignee,
    });
  }

  async function handleResult(outcome, task, agentId, payload) {
    let result = outcome.result ?? {};
    // 卡在跑的过程中被人工取消：结果照样留档，但不再推进状态机。
    // 不加这道护栏会撞「cancelled → in_review」的非法跳转，日志里全是假错误，
    // 而人看到的只是「我按了取消，系统却在报状态机异常」。
    const fresh = taskById(task.taskId);
    if (!fresh || fresh.status === 'cancelled') {
      writeAudit(db, {
        actor: agentId, action: 'result_dropped_after_cancel',
        newValue: String(outcome.status ?? '').slice(0, 60), runId: outcome.runId, taskId: task.taskId,
      });
      return { dropped: true, reason: '任务已取消，结果只留档不推进' };
    }
    // P3-4：GUI 轮询先发现 needsDecision 的变更请求 —— 不当成超时或失败、不重试（§8.3 4b / §8.6）。
    if (outcome.status === 'change_requested') {
      // adapter 会在 result 里带上自己的 status / usage 等元字段；变更请求协议不接受这些，
      // 这里按协议字段白名单取，别把 adapter 的内部标记当成业务字段写进单子。
      const submitted = submitChangeRequest({
        ...pickSchemaFields('change-request', result),
        taskId: task.taskId, runId: outcome.runId, agentId,
      });
      writeAudit(db, {
        actor: agentId, action: 'change_requested_from_gui',
        newValue: String(result.changeRequestId ?? '(缺 id)'), runId: outcome.runId,
      });
      return submitted;
    }
    if (payload.wakeReason === 'escalation') {
      result = assertCeoOutput(result);
      // 只回话（空 tasks / 只有 summary）不派生新卡：变更请求的处置要么给方案，要么明确不动。
      const cards = [...(Array.isArray(result.tasks) ? result.tasks : []), result];
      if (result.type === 'task-create' && cards.some(looksLikeTaskCard)) {
        deriveAndCancel(task, result);
      }
      return;
    }
    // 「现在抢不到前台 / 你正在用电脑」是临时条件，adapter 会明确报 deferred：
    // 卡退回排队等下一次投递，**不累加重试次数、不出审批卡**（真机上踩过：
    // 我在电脑前坐着，两张卡就被打成 blocked 并生成审批）。
    if (outcome.status === 'deferred') {
      requeueIfIdle(task.taskId);
      writeAudit(db, {
        actor: agentId, action: 'wake_deferred',
        newValue: String(outcome.sessionParams?.deferredReason ?? '临时条件，稍后再派').slice(0, 300),
        runId: outcome.runId, taskId: task.taskId,
      });
      return { deferred: true };
    }
    if (agentId === ceoId()) {
      result = assertCeoOutput(result);
      // 「只回话、不派卡」：寒暄 / 咨询 / 让 CEO 出主意 / 让它根据现有信息汇报现状。
      // 这类不需要员工动手，硬派一张卡等于为了回一句「你好」烧一次桌面席位。
      if (result.type === 'task-create') {
        // CEO 可以一次拆多张卡（result.tasks）；只给一张时也用顶层字段，兼容老的派单器脚本。
        // 「只排班不派卡」是合法产出：显式给空 tasks + 带了排班建议时，不该硬凑一张空壳卡出来。
        const recList = [
          ...(Array.isArray(result.recurringSuggestions) ? result.recurringSuggestions : []),
          ...(result.recurringSuggestion ? [result.recurringSuggestion] : []),
        ].filter((x) => x && typeof x === 'object');
        const explicitTasks = Array.isArray(result.tasks) ? result.tasks : null;
        // 少了这道判定，CEO 没写 tasks 时会把整个结果当卡派下去——问句「你好」也会变成一张给员工的活。
        const requested = (explicitTasks ?? [result]).filter(looksLikeTaskCard).slice(0, 8);
        if (!requested.length && !recList.length) {
          // 没卡没排班，但有答复 → 这就是「只汇报」。真的什么都没有才算空产出。
          return closeAsReport(task, result, outcome.runId);
        }
        // 项目归属：人没指定时由 CEO 改判（这是「不逼人选项目」的另一半）。
        // 但它只能指向「已有且配了规范」的项目；写了不存在的项目照样拒，绝不让产物落到野地里。
        let childProject = task.project ?? null;
        const wantedProject = requested.find((c) => typeof c.project === 'string' && c.project.trim())?.project
          ?? (typeof result.project === 'string' && result.project.trim() ? result.project : null);
        if (wantedProject) {
          try {
            childProject = assertProject({ config, workRoot: workDir, requested: wantedProject }).project;
          } catch (error) {
            writeAudit(db, {
              actor: 'ceo', action: 'project_rejected',
              newValue: `${wantedProject}|${error.message}`.slice(0, 300), taskId: task.taskId,
            });
          }
        }
        // 建议新建项目 → 只出一张审批单。CEO 不许自己改公司配置，董事会点头才真建。
        const suggestion = result.projectSuggestion
          ?? requested.find((c) => c.projectSuggestion)?.projectSuggestion;
        if (suggestion && typeof suggestion === 'object' && suggestion.id
          && !pendingApprovalFor(task.taskId, 'project_create')) {
          const s = {
            id: String(suggestion.id).trim().toLowerCase(),
            displayName: String(suggestion.displayName ?? suggestion.id).trim(),
            rootDir: suggestion.rootDir ? String(suggestion.rootDir).trim() : null,
            deliverSubdir: suggestion.deliverSubdir ? String(suggestion.deliverSubdir).trim() : null,
            reason: String(suggestion.reason ?? '').slice(0, 600),
            // CEO 连规范一起拟好：董事会只做「通过 / 拒绝 + 写意见」，不用自己填任何数据。
            acceptance: (Array.isArray(suggestion.acceptance) ? suggestion.acceptance : [])
              .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8),
            rules: (Array.isArray(suggestion.rules) ? suggestion.rules : [])
              .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8),
          };
          const approval = requestApproval({
            kind: 'project_create', taskId: task.taskId,
            title: `新建项目申请：${s.displayName}（${s.id}）`,
            body: `${s.reason || 'CEO 认为这活值得单开一个项目。'}\n`
              + '项目信息与规范草案已由 CEO 填好，董事会只需选「通过」或「拒绝」，有意见写在下面。',
            payload: { project: s }, requestedBy: 'ceo',
          });
          writeAudit(db, {
            actor: 'ceo', action: 'project_suggested',
            newValue: `${s.id}|${approval.approvalId}`, taskId: task.taskId,
          });
        }
        // ★ 项目闸：卡片显式写了「归某个还不存在的项目」时，不许先跑。
        // 先跑完再批 = 产物不归这个项目、经验不进项目记忆、交付不落盘，等于白批（真机踩过这个坑）。
        // 只拦「显式指了不存在的项目」的卡；顺带建议建新项目（没写具体归属）不阻塞当前工作。
        const projectExists = (id) => Boolean(id && config.projects?.[String(id).trim().toLowerCase()]);
        const waitingFor = [];
        for (const c of requested) {
          if (typeof c.project !== 'string' || !c.project.trim()) continue;
          const pid = c.project.trim().toLowerCase();
          if (!projectExists(pid) && !waitingFor.includes(pid)) waitingFor.push(pid);
        }
        if (wantedProject && !projectExists(wantedProject)) {
          const pid = String(wantedProject).trim().toLowerCase();
          if (!waitingFor.includes(pid)) waitingFor.push(pid);
        }
        // 董事会已经拒过 / 要求重写的项目不再拦：按一次性任务跑，别把链路堵死。
        const blockedOn = waitingFor.find((id) => !db.prepare(`SELECT 1 FROM approvals
          WHERE kind = 'project_create' AND status IN ('rejected', 'rewrite') AND requestJson LIKE ?`)
          .get(`%"id":"${id}"%`));
        if (blockedOn) {
          const pendingAp = db.prepare(`SELECT approvalId FROM approvals
            WHERE kind = 'project_create' AND status = 'pending' AND requestJson LIKE ?`)
            .get(`%"id":"${blockedOn}"%`);
          writeAudit(db, {
            actor: 'control-plane', action: 'project_gate_blocked',
            newValue: `${blockedOn}|${pendingAp?.approvalId ?? '无待批单'}`, taskId: task.taskId,
          });
          const cur = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(task.taskId)?.status;
          if (cur === 'todo') transition(db, task.taskId, 'in_progress', 'control-plane');
          if (cur === 'todo' || cur === 'in_progress') {
            transition(db, task.taskId, 'awaiting_decision', 'control-plane');
          }
          notifier.send({
            title: `这单在等项目审批：${blockedOn}`,
            body: 'CEO 判断这活要归这个项目，但它还没批。批了会自动接着拆；不批则按一次性任务跑。',
            scene: 'project', taskId: task.taskId,
          });
          return { gated: 'project_pending', project: blockedOn, approvalId: pendingAp?.approvalId ?? null };
        }
        // 建议「这活是长期的，得按节奏反复做」→ 组装成完整循环任务，出审批单。
        // 循环任务会长期反复消耗额度（GUI 席位还抢键鼠），所以必须董事会点头才真注册；
        // CEO 只能提，不能自己排班。一次最多提 3 条，多的截掉不静默堆积。
        for (const sug of recList.slice(0, 3)) {
          const built = buildRecurringJob(sug, { task, requestedBy: agentId });
          if (built.error) {
            writeAudit(db, {
              actor: 'ceo', action: 'recurring_suggestion_rejected',
              newValue: `${String(sug.title ?? '(无标题)').slice(0, 60)}|${built.error}`.slice(0, 300),
              taskId: task.taskId,
            });
            continue;
          }
          // 同一条循环任务已经在等董事会时不出第二张单（CEO 一轮可能重复提同一条）。
          const dup = db.prepare(`SELECT approvalId FROM approvals
            WHERE kind = 'recurring_create' AND status = 'pending' AND requestJson LIKE ?`)
            .get(`%"jobId":"${built.job.jobId}"%`);
          if (dup) continue;
          const approval = requestApproval({
            kind: 'recurring_create', taskId: task.taskId,
            title: `循环任务申请：${built.job.title}`,
            body: describeRecurringJob(built.job, sug.reason),
            payload: { job: built.job, rruleText: describeRRule(built.job.trigger.rrule) },
            requestedBy: 'ceo',
          });
          writeAudit(db, {
            actor: 'ceo', action: 'recurring_suggested',
            newValue: `${built.job.jobId}|${approval.approvalId}`, taskId: task.taskId,
          });
        }
        // 拆解说明：看板「运行与审计」里能查到 CEO 当时是怎么想的，不是黑盒。
        if (result.summary) {
          writeAudit(db, {
            actor: 'ceo', action: 'ceo_plan',
            newValue: String(result.summary).slice(0, 1200), taskId: task.taskId,
          });
        }

        // 先把每张卡的承接人都定好：有一张派不出去就整单挂起，不做「半单」。
        const specs = [];
        for (const c of requested) {
          // G3：CEO 可以给子任务标难度；没标就继承父卡（拆出来的活不会比原活更简单）。
          const childDifficulty = normalizeDifficulty(c.difficulty ?? task.difficulty, { field: 'difficulty' });
          const seat = resolveChildSeat({
            preferred: c.assignee, difficulty: childDifficulty, managerId: ceoId(),
          });
          if (!seat.assignee) {
            parkForDifficulty(task, { wanted: c.assignee ?? firstWorker(), difficulty: childDifficulty });
            return;
          }
          if (seat.reassignedFrom && seat.reassignedFrom !== seat.assignee) {
            writeAudit(db, {
              actor: 'ceo', action: 'difficulty_reassigned',
              oldValue: seat.reassignedFrom, newValue: seat.assignee, taskId: task.taskId,
            });
          }
          specs.push({
            title: c.title ?? '子任务', role: c.role ?? 'general',
            assignee: seat.assignee, difficulty: childDifficulty,
            instructions: c.instructions ?? undefined,
            acceptance: c.acceptance ?? undefined,
            // 卡间依赖：CEO 写 after（同批序号，1 基；也可以写同批卡的标题）。没写 = 并行。
            after: Array.isArray(c.after) ? c.after : (c.after === undefined || c.after === null ? [] : [c.after]),
            // 代码类活：CEO 可以指定仓库和验收人；没指定就走引擎的默认（受管代码默认工程岗审）。
            repo: c.repo ? String(c.repo) : null,
            // 写错了不炸整单：留痕后当没写，走默认推导（拆卡不能因为一个字段名写错就全废）。
            reviewBy: softRoute(() => assertReviewSeat(c.reviewBy), {
              action: 'route_field_rejected', who: 'ceo', taskId: task.taskId, field: 'reviewBy', value: c.reviewBy,
            }),
            // 交付路由：CEO 可以在派活时就定死（land = 干完直接落盘、不用回来看）。
            handoff: softRoute(() => assertHandoff(c.handoff), {
              action: 'route_field_rejected', who: 'ceo', taskId: task.taskId, field: 'handoff', value: c.handoff,
            }),
            // 授权执行者自己判落盘。默认不给：上级派的活，员工无权替上级免审。
            allowSelfLand: c.allowSelfLand === true,
          });
        }
        // P4-2 战略门禁：开着就必须人点头才派活；任务停在 in_progress 等审批，不额外烧额度。
        if (config.gates?.strategy === true) {
          const approval = requestApproval({
            kind: 'strategy', taskId: task.taskId,
            title: `战略门禁：${task.title}`,
            body: `CEO 提交本轮目标拆解（${specs.length} 张卡，首张派给 ${specs[0]?.assignee}），等你通过 / 要求重写 / 驳回。`,
            payload: { child: specs[0], children: specs }, requestedBy: 'ceo',
          });
          writeAudit(db, {
            actor: 'ceo', action: 'strategy_gate_waiting',
            newValue: approval.approvalId, taskId: task.taskId,
          });
          return;
        }
        const created = [];
        for (const spec of specs) {
          const child = buildCard({
            requestId: task.requestId, ...spec,
            // 依赖留到所有卡都建完、拿到真实 taskId 再回填。
            dependsOn: [],
            mode: 'delegate', assignedBy: 'ceo', parentTaskId: task.taskId, assignerId: ceoId(),
            project: childProject,
            origin: { ceoNote: result.summary ? String(result.summary).slice(0, 600) : null },
          });
          // 先建不派：有前置卡的等上游 done 再放行，避免「接管还没做完，发布脚本已经发布了」。
          insertCard(child, child.assignee, { dispatch: false });
          created.push(child);
        }
        // 回填依赖：序号是 1 基（对 CEO 来说「第 1 张」最自然），也接受同批卡的标题。
        const wired = [];
        created.forEach((child, i) => {
          const deps = [];
          for (const ref of specs[i].after ?? []) {
            const byIndex = /^\d+$/.test(String(ref)) ? created[Number(ref) - 1] : null;
            const target = byIndex ?? created.find((c) => c.title === String(ref));
            if (target && target.taskId !== child.taskId) deps.push(target.taskId);
          }
          const unique = [...new Set(deps)];
          if (!unique.length) return;
          db.prepare('UPDATE tasks SET dependsOn = ?, updatedAt = ? WHERE taskId = ?')
            .run(JSON.stringify(unique), nowIso(), child.taskId);
          wired.push(`${child.taskId}←${unique.join('+')}`);
        });
        // 只派「没有前置」的；有前置的由 releaseReadyDependencies 在上游 done 时放行。
        let dispatched = 0;
        for (const child of created) {
          if (dependsOnOf({ dependsOn: db.prepare('SELECT dependsOn FROM tasks WHERE taskId = ?').get(child.taskId)?.dependsOn }).length) continue;
          emitEvent({
            type: 'issue_assigned', taskId: child.taskId, agentId: child.assignee,
            payload: { wakeReason: 'issue_assigned', mode: child.mode },
            dedupeKey: `assign:${child.taskId}:1`,
          });
          dispatched += 1;
        }
        if (wired.length) {
          writeAudit(db, {
            actor: 'ceo', action: 'dependencies_wired',
            newValue: `${wired.length} 张有前置：${wired.join(' | ')}`.slice(0, 400),
            taskId: task.taskId,
          });
        }
        writeAudit(db, {
          actor: 'ceo', action: 'tasks_created',
          newValue: `${created.length} 张（先派 ${dispatched} 张）：${created.map((c) => c.taskId).join(', ')}｜项目 ${childProject ?? '(一次性)'}`.slice(0, 400),
          taskId: task.taskId,
        });
        transition(db, task.taskId, 'in_review', 'ceo', outcome.runId);
        transition(db, task.taskId, 'done', 'ceo', outcome.runId);
      } else if (result.type === 'review') {
        if (result.verdict === 'pass') {
          transition(db, task.taskId, 'done', 'ceo', outcome.runId);
          // CEO 放行了才算这张卡真的收账，这时才把这次的经验写进项目记忆。
          flushProjectMemory(task, outcome.runId);
          // 同一时刻把产物落进项目自己的文件夹（不落盘不影响卡的状态）。
          deliverAccepted(task, outcome.runId);
        } else {
          transition(db, task.taskId, 'in_progress', 'ceo', outcome.runId);
          emitEvent({
            type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
            payload: { wakeReason: 'rework' },
            dedupeKey: `review-reject:${task.taskId}:${outcome.runId}`,
          });
        }
      }
      return;
    }
    // 执行席位：结果必须是 CompletionReport
    const report = result;
    const checked = validate('completion', report);

    // ① 主动上报：不重试、不重投。方向错了，再跑一遍只会更错，还白烧一次额度。
    if (String(report?.handoff ?? '').trim() === 'escalate') {
      const opened = openEscalation(task, report, agentId, outcome.runId, {
        reason: report.reason ?? report.summary ?? '执行岗主动上报',
      });
      return { escalated: true, ...opened };
    }

    const passed = checked.ok && report.status === 'success';
    if (!passed) {
      const attempt = (task.attempt ?? 0) + 1;
      db.prepare('UPDATE tasks SET attempt = ?, updatedAt = ? WHERE taskId = ?').run(attempt, nowIso(), task.taskId);
      // 只记 status 的话，blocked 的真实原因（失焦 / 超时 / 环境不通过）就查无可查。
      const why = checked.errors.join('; ')
        || [report.status, report.reason].filter(Boolean).join('：')
        || '无原因';
      writeAudit(db, { actor: agentId, action: 'report_rejected', newValue: `第 ${attempt} 次：${why}`, runId: outcome.runId });
      if (attempt < 2) {
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId,
          payload: { wakeReason: 'retry' }, dedupeKey: `retry:${task.taskId}:${attempt}`,
        });
      } else {
        transition(db, task.taskId, 'blocked', 'control-plane', outcome.runId);
        // P4-3 / P4-5：连续两次不合格 → 先试救火席位，没配就出人审批卡（§7.4 / §7.6）。
        escalateToRescue({ ...task, attempt }, '报告连续两次不合格');
      }
      return;
    }

    const kindInfo = inferArtifactKind(task, report);
    const kind = kindInfo.kind;
    const handoffInfo = resolveHandoff(task, kind, report);
    const handoff = handoffInfo.handoff;

    // ② 受管代码必须登记仓库。不登记就打回：代码是以后还要改的东西，
    //    连它在哪个仓库都说不清，交上来只是一堆没人接手的文件。
    if (kind === 'managed-code' && !task.repo && config.artifacts?.requireRepoForManagedCode !== false) {
      const attempt = (task.attempt ?? 0) + 1;
      db.prepare('UPDATE tasks SET attempt = ?, updatedAt = ? WHERE taskId = ?').run(attempt, nowIso(), task.taskId);
      const why = '产物被判定为受管代码，但卡上没有 repo：'
        + `补上 repo（已登记：${Object.keys(config.repos ?? {}).join(', ') || '无'}）后重交；`
        + '如果这只是一次性计算脚本（跑完就归档），把 artifactKind 写成 scratch-code。';
      writeAudit(db, {
        actor: agentId, action: 'code_repo_missing',
        newValue: `第 ${attempt} 次：${why}`, runId: outcome.runId, taskId: task.taskId,
      });
      if (attempt < 2) {
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId,
          payload: { wakeReason: 'retry', reviewNote: why },
          dedupeKey: `repo-missing:${task.taskId}:${attempt}`,
        });
      } else {
        transition(db, task.taskId, 'blocked', 'control-plane', outcome.runId);
        escalateToRescue({ ...task, attempt }, why);
      }
      return;
    }

    // 报告合格：先攒下这份报告，等卡到 done 再落项目记忆（打回重做的不算数）。
    pendingMemory.set(task.taskId, report);

    // 执行者自己指定了审查人：先过闸（只能指汇报链上的上级 / 默认审查人）。
    // 过了就写回卡上，审计才查得出「这活当初是谁说要交给谁审的」。
    const wantedReviewer = checkReviewBy(task, report.reviewBy);
    if (wantedReviewer.reviewer) {
      db.prepare('UPDATE tasks SET reviewBy = ?, updatedAt = ? WHERE taskId = ?')
        .run(wantedReviewer.reviewer, nowIso(), task.taskId);
      Object.assign(task, { reviewBy: wantedReviewer.reviewer });
      writeAudit(db, {
        actor: agentId, action: 'review_by_set',
        newValue: `${wantedReviewer.reviewer}（执行者指定）`, runId: outcome.runId, taskId: task.taskId,
      });
    } else if (!wantedReviewer.ok) {
      writeAudit(db, {
        actor: agentId, action: 'review_by_rejected',
        newValue: `${String(report.reviewBy).slice(0, 40)}|${wantedReviewer.reason}`.slice(0, 300),
        runId: outcome.runId, taskId: task.taskId,
      });
    }

    transition(db, task.taskId, 'in_review', 'control-plane', outcome.runId);
    if (task.mode === 'direct' && handoff !== 'review') {
      // 直投跳过 CEO：验收条件由人写清、机器判定，合格即完成，不产生 CEO 的 Run。
      // 只对董事会负责——这就是「直投不上报」的落地。执行者要求审时走下一条。
      transition(db, task.taskId, 'done', 'control-plane', outcome.runId);
      writeAudit(db, { actor: 'human', action: 'machine_acceptance', newValue: task.taskId, runId: outcome.runId });
      flushProjectMemory(task, outcome.runId);
      deliverAccepted(task, outcome.runId);
      return;
    }
    // ③ 直接落盘：发布者（或获授权的执行者）判断「这活不需要第二个人再看」，
    //    就不叫任何人跑一轮验收（省一次按量计费的 Run）。
    if (handoff === 'land') {
      transition(db, task.taskId, 'done', 'control-plane', outcome.runId);
      const issuer = handoffInfo.issuer;
      writeAudit(db, {
        actor: agentId, action: 'handoff_land',
        newValue: [
          `产物 ${kind}${kindInfo.inferred ? '(推断)' : '(自报)'}`,
          `发布者 ${issuer.kind === 'board' ? '董事会' : (issuer.id ?? '未知')}`,
          `路由来源 ${handoffInfo.source}`,
          handoffInfo.codeForced ? '代码强制改审' : null,
          handoffInfo.downgraded ? `已拦下降级：${handoffInfo.downgraded}` : null,
        ].filter(Boolean).join('｜').slice(0, 400),
        runId: outcome.runId, taskId: task.taskId,
      });
      flushProjectMemory(task, outcome.runId);
      deliverAccepted(task, outcome.runId);
      return;
    }
    // ④ 交审：谁发布谁审（上级派的活回上级）；代码类仍走工程岗。
    const reviewer = reviewerOf(task, kind);
    // 被拦下过「私自落盘」的，留一条痕：这不是错误，但董事会该看得见谁想跳过审。
    if (handoffInfo.downgraded) {
      writeAudit(db, {
        actor: agentId, action: 'handoff_downgraded',
        newValue: `${handoffInfo.downgraded}｜改交 ${reviewer} 审`.slice(0, 300),
        runId: outcome.runId, taskId: task.taskId,
      });
    }
    if (reviewer === ceoId()) {
      // 按 Run 去重：同一次执行的报告只请一次验收，但返工后的新 Run 可以再请一次。
      emitEvent({
        type: 'review_requested', taskId: task.taskId, agentId: ceoId(),
        payload: { wakeReason: 'review_requested', kind },
        dedupeKey: `review:${task.taskId}:${outcome.runId}`,
      });
      return;
    }
    // 董事会自己审：不叫醒任何 agent，出一张「待我拍板」单。
    // 人从看板点进去就能看到结果（summary + 产物清单 + 验收条件），通过即自动走下一步。
    if (reviewer === 'human') {
      const approval = requestTaskReview(task, report, kind, outcome.runId);
      writeAudit(db, {
        actor: 'control-plane', action: 'task_review_waiting',
        newValue: `${approval.approvalId}|${kind}|产物 ${(report.artifacts ?? []).length} 个`,
        runId: outcome.runId, taskId: task.taskId,
      });
      notifier.send({
        title: `待你拍板：${task.title}`,
        body: `「${task.assignee}」说干完了：${String(report.summary ?? '').slice(0, 120)}`,
        scene: 'review', taskId: task.taskId,
      });
      return;
    }
    // 拉模式席位（工程岗）不能被直调：卡留在 in_review，等它自己来审（seat.js reviews / verdict）。
    writeAudit(db, {
      actor: 'control-plane', action: 'review_queued',
      newValue: `${reviewer}|${kind}|${task.repo ?? '无仓库'}`, runId: outcome.runId, taskId: task.taskId,
    });
  }

  async function handleEvent(ev) {
    const payload = JSON.parse(ev.payloadJson ?? '{}');
    if (ev.type === 'issue_assigned') {
      const task = taskById(ev.taskId);
      if (!task) {
        // P5：静默丢弃等于「误唤醒查无可查」。这里必须留痕，否则试运行统计不到。
        writeAudit(db, {
          actor: 'scheduler', action: 'wake_rejected',
          newValue: `${ev.agentId ?? 'unknown'}|orphan|任务不存在|${ev.source ?? 'control-plane'}`,
          taskId: ev.taskId,
        });
        return;
      }
      if (['done', 'cancelled', 'awaiting_decision', 'blocked'].includes(task.status)) {
        const code = task.status === 'awaiting_decision' ? 'suspended'
          : (task.status === 'blocked' ? 'blocked' : 'terminal');
        writeAudit(db, {
          actor: 'scheduler', action: 'wake_rejected',
          newValue: `${ev.agentId ?? task.assignee}|${code}|事件泵拦截：任务 ${task.status}|${ev.source ?? 'control-plane'}`,
          taskId: ev.taskId,
        });
        return;
      }
      if (dispatchMode === 'bridge') {
        // 拉模式：控制面不直调 adapter，卡保持 todo；离线期间不派不发，开机由 bridge 补领（§9.3）。
        const target = ev.agentId ?? task.assignee;
        const online = isBridgeOnline(db, target);
        writeAudit(db, {
          actor: 'scheduler', action: online ? 'queued_for_bridge' : 'queued_offline',
          newValue: task.taskId,
        });
        return;
      }
      // 席位级拉模式：交互式 agent（人叫才醒、没有常驻进程）不能由控制面直调 ——
      // 它不在的时候派活只会白烧一次 Run。卡留 todo，等它自己来领。
      // 与全局 dispatchMode=bridge 是两件事：bridge 是「整台机器都在拉」，这里只影响这一个席位。
      {
        const seat = ev.agentId ?? task.assignee;
        if (cfgFor(seat)?.dispatch === 'pull') {
          writeAudit(db, {
            actor: 'scheduler', action: 'queued_for_pull',
            newValue: `${seat}|${task.taskId}`,
            // 带上 taskId：按卡追溯时这是唯一入口，漏了就得靠字符串搜 newValue。
            taskId: task.taskId,
          });
          return;
        }
      }
      if (task.status === 'todo' || task.status === 'backlog') transition(db, task.taskId, 'in_progress', 'scheduler');
      const target = ev.agentId ?? task.assignee;
      const fresh = taskById(task.taskId);
      const outcome = await wake(task.taskId, target, payload.wakeReason ?? 'issue_assigned', payload);
      if (!outcome || outcome.skipped || outcome.failed) return;
      await handleResult(outcome, fresh, target, payload);
      return;
    }
    if (ev.type === 'review_requested') {
      const task = taskById(ev.taskId);
      if (!task || task.status !== 'in_review') return;
      const outcome = await wake(task.taskId, ceoId(), 'review_requested', payload);
      if (!outcome || outcome.skipped || outcome.failed) return;
      assertCeoOutput(outcome.result ?? {});
      if (outcome.result.verdict === 'pass') {
        transition(db, task.taskId, 'done', 'ceo', outcome.runId);
      } else {
        transition(db, task.taskId, 'in_progress', 'ceo', outcome.runId);
        // 验收打回只自动重跑一次；第二次打回留痕等人审，避免无限空转烧额度（§7.6 / P1-6）。
        const rounds = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE taskId = ? AND wakeReason = 'review_requested'")
          .get(task.taskId).n;
        if (rounds <= 1) {
          emitEvent({
            type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
            payload: { wakeReason: 'rework' },
            dedupeKey: `review-reject:${task.taskId}:${outcome.runId}`,
          });
          writeAudit(db, { actor: 'ceo', action: 'review_rework', newValue: task.taskId, runId: outcome.runId });
        } else {
          // P4-5 升级规则：返工 2 次转救火席位（escalationTo 决定）；没配就出人审批卡。
          escalateToRescue(taskById(task.taskId), '验收连续两次打回');
        }
      }
      return;
    }
    if (ev.type === 'change_request') {
      const task = taskById(ev.taskId);
      if (!task) return;
      // P4-8：needsDecision 已经真挂起，决策走 POST /api/change-requests/:id/decision，
      // 不再自动叫 CEO 跑一轮（挂起不烧额度，避免「叫了也没权拍板」的空转）。
      if (task.status === 'awaiting_decision') {
        writeAudit(db, {
          actor: 'control-plane', action: 'awaiting_decision',
          newValue: String(payload.changeRequestId ?? ''), taskId: task.taskId,
        });
        return;
      }
      const outcome = await wake(task.taskId, ceoId(), 'escalation', payload);
      if (!outcome || outcome.skipped || outcome.failed) return;
      await handleResult(outcome, task, ceoId(), payload);
      return;
    }
    if (ev.type === 'escalation') {
      // §7.4 阻塞上报：沿汇报线给出审批卡，交给决策者 / 董事会，不额外烧一次模型。
      const task = taskById(ev.taskId);
      if (!task) return;
      if (pendingApprovalFor(task.taskId, 'review_reject')) return;
      const dm = resolveDecisionMaker(config, task.assignee);
      requestApproval({
        kind: 'review_reject', taskId: task.taskId,
        title: `阻塞上报：${task.title}`,
        body: `${task.assignee} 的任务卡在 blocked（${payload.reason ?? '原因见任务卡'}）。` +
          `按汇报线建议由 ${dm} 先看；你可以通过 / 要求重写（换人）/ 驳回（放弃）。`,
        payload: { assignee: task.assignee, decisionMaker: dm, reason: payload.reason ?? null },
        requestedBy: 'control-plane',
      });
      return;
    }
    if (ev.type === 'thread_wake') {
      await wakeThread(payload.threadId, ev.agentId, {
        reason: payload.reason ?? 'thread_message', note: payload.note ?? '',
      });
      return;
    }
    // state_changed 等：只留痕，不重复处理。
  }

  function buildBrief(doneCount) {
    const counts = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
    const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));
    const runs = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
    return {
      briefId: `BRIEF-${doneCount}`,
      body: [
        'AICompany 简报',
        `今日完成：${doneCount}`,
        `进行中：${by.in_progress ?? 0}｜待验收：${by.in_review ?? 0}`,
        `阻塞：${by.blocked ?? 0}｜已取消：${by.cancelled ?? 0}`,
        `累计唤醒：${runs} 次（Run 可追 runId）`,
        `待你拍板：${pendingApprovals(db)} 条审批 · ${db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'awaiting_decision'").get().n} 张挂起待决策`,
      ].join('\n'),
    };
  }

  function maybeBrief() {
    const doneCount = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'").get().n;
    const last = db.prepare('SELECT briefId FROM briefs ORDER BY rowid DESC LIMIT 1').get();
    const lastN = last ? Number(String(last.briefId).split('-').pop()) : 0;
    if (doneCount <= lastN) return null;
    const brief = buildBrief(doneCount);
    db.prepare('INSERT INTO briefs (briefId, body, createdAt) VALUES (?, ?, ?)')
      .run(brief.briefId, brief.body, nowIso());
    notifier.send({ title: 'AICompany 简报', body: brief.body, scene: 'brief' });
    return brief;
  }

  // bridge 回写完成报告的统一入口：仍走 P1 那套报告校验 → 状态机 → 验收 → 简报，不开第二条链路。
  async function acceptCompletion({ taskId, agentId, runId, report }) {
    const checked = validate('completion', report);
    const task = taskById(taskId);
    if (!task) return { accepted: false, error: '任务不存在' };
    db.prepare(`INSERT OR IGNORE INTO runs
      (runId, taskId, agentId, wakeReason, status, revision, quotaUnits, startedAt, finishedAt)
      VALUES (?, ?, ?, 'bridge_checkout', ?, ?, 1, ?, ?)`).run(
      runId, taskId, agentId,
      checked.ok ? (report.status ?? 'success') : 'failed',
      task.revision, nowIso(), nowIso(),
    );
    consumeQuota(db, agentId, 1, { now: clock(), periodHours: config.quota?.periodHours });
    afterQuotaConsume(agentId);
    const outcome = { result: report, runId, agentId, status: report?.status ?? 'success' };
    await handleResult(outcome, task, agentId, { wakeReason: 'bridge_checkout' });
    const pumped = await pump();
    return { accepted: checked.ok, errors: checked.errors, ...pumped };
  }

  // 事件泵在同一进程里只能有一个在跑：GUI 任务一次几分钟，这期间维护心跳 / HTTP 都可能来叫，
  // 两个 pump 并发跑同一批事件会把同一张卡派两次（真机上踩过：两个 Run 抢一个窗口）。
  let pumping = null;
  async function pumpOnce() {
    let steps = 0;
    while (steps < maxSteps) {
      const ev = nextEvent(db);
      if (!ev) break;
      markProcessed(db, ev.eventId);
      steps += 1;
      try {
        await handleEvent(ev);
      } catch (error) {
        // 一个坏事件不能拖死整条队列： pump() 的调用方很多是 .catch(() => {})（后台触发），
        // 异常一旦从 pumpOnce 逃出去，泵就没人再拉，后面的事件永远排队（T-af72158d 事故）。
        // 这里记审计后继续消化队列，让「哪一步坏了」留痕可查。
        writeAudit(db, {
          actor: 'control-plane', action: 'pump_step_failed',
          newValue: `${ev.type}|${ev.taskId ?? '-'}|${String(error.message ?? error).slice(0, 300)}`,
        });
      }
    }
    const brief = maybeBrief();
    return { steps, pending: pendingEvents(db), brief };
  }

  async function pump() {
    if (pumping) return pumping;
    pumping = pumpOnce();
    try { return await pumping; } finally { pumping = null; }
  }

  async function submit(req, { defer = false } = {}) {
    const routed = route(req);
    // 空壳判据：defer 只是「别在 HTTP 里等」——卡和事件都已经落库，泵在后台推进。
    // GUI 席位一次能跑几分钟，让浏览器 / 命令行干等是没必要的折磨。
    if (defer) {
      setTimeout(() => {
        pump().catch((error) => {
          writeAudit(db, { actor: 'control-plane', action: 'pump_failed', newValue: String(error.message ?? error) });
        });
      }, 0);
      return { ...routed, steps: 0, pending: pendingEvents(db), deferred: true };
    }
    const pumped = await pump();
    return { ...routed, ...pumped };
  }

  // P6-5：维护心跳。为什么必须有：闸门拦下 / 配额触顶 这类「暂时派不出去」的卡会退回 todo，
  // 但退回 todo 之后没有任何事件再叫它 —— 没人扫就永远停在那儿（看着像卡死）。
  // 这里只补「既没有待处理事件、又确实躺了一会儿」的卡，避免每轮都往审计里灌垃圾。
  async function reconcile({ olderThanMs = 60_000, limit = 20 } = {}) {
    // 先把「上游已完成、下游该放行」的补投掉：同一轮心跳里的 pump 就能直接推进，
    // 不用拖到下一分钟。重启后卡在依赖上的链，靠这一步自己活过来。
    const releasedDeps = releaseReadyDependencies();
    const rows = db.prepare(`SELECT taskId, status, updatedAt, assignee, dependsOn FROM tasks
      WHERE status IN ('todo', 'in_progress') ORDER BY updatedAt`).all();
    const cutoff = clock().getTime() - olderThanMs;
    let requeued = 0;
    let waiting = 0;
    for (const row of rows) {
      if (Date.parse(row.updatedAt) > cutoff) continue;
      // 正在跑的卡不算「躺着」：GUI 一次能跑几分钟，不能因为 updatedAt 旧了就再投一次。
      const active = db.prepare("SELECT 1 AS n FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1")
        .get(row.taskId);
      if (active) { waiting += 1; continue; }
      // 依赖没满足的卡也不是「躺着」：它在等上游。重投只会被 runPolicy 拦下来白记一条。
      if (unmetDependencies(row).length) { waiting += 1; continue; }
      // 拉模式席位的卡更不是「躺着」：它在等那个人来领。重投只会每 60 秒刷一条 pull 拦截。
      if (cfgFor(row.assignee)?.dispatch === 'pull') { waiting += 1; continue; }
      const pending = db.prepare(`SELECT 1 AS n FROM events
        WHERE taskId = ? AND processed = 0 AND type = 'issue_assigned' LIMIT 1`).get(row.taskId);
      if (pending) { waiting += 1; continue; }
      emitEvent({
        type: 'issue_assigned', taskId: row.taskId, agentId: row.assignee,
        payload: { wakeReason: 'reconcile' },
        dedupeKey: `reconcile:${row.taskId}:${row.updatedAt}`,
      });
      requeued += 1;
      if (requeued >= limit) break;
    }
    // 泵可能已经死了（上一次 drain 抛异常被后台调用方吞掉）：
    // 只看 requeued 的话，「todo 卡有待处理投递事件」会让心跳永远不 pump，
    // 而死泵又永远不消费这些事件 —— 互相死锁。所以只要队列里有事件就先泵一次。
    let pumped = { steps: 0, pending: pendingEvents(db), brief: null };
    if (requeued > 0 || pumped.pending > 0) {
      try { pumped = await pump(); } catch (error) {
        writeAudit(db, { actor: 'scheduler', action: 'pump_failed', newValue: String(error.message ?? error) });
      }
    }
    if (requeued) {
      writeAudit(db, { actor: 'scheduler', action: 'reconcile_requeue', newValue: String(requeued) });
    }
    // P7-5：顺手补落盘 —— 被译台挡住、或上次落盘失败的卡，在这里重试。
    const deliveries = retryPendingDeliveries();
    return { scanned: rows.length, requeued, waiting, deliveries, releasedDeps, ...pumped };
  }

  async function onProgressReport() {
    // ProgressReport 是覆盖写、不触发事件：这里只留痕，绝不唤醒任何人。
    writeAudit(db, { actor: 'worker', action: 'progress_only', newValue: 'no_wake' });
    return { wakes: 0 };
  }

  return {
    db, config, notifier, dispatchMode, ceoId, firstWorker, taskById, getAgentCandidates,
    // P5：观测与调参要按同一个产物根目录算，避免服务端自己又猜一遍。
    workRoot: workDir,
    threadById, postThreadMessage, acceptCompletion,
    bridgeOnline: (agentId) => isBridgeOnline(db, agentId),
    // P7：项目层。项目清单由引擎给（规范在不在、记忆有几条），看板 / CLI 不用自己猜路径。
    listProjects: () => listProjectEntries({ config, workRoot: workDir }),
    projectFor: (id) => {
      const found = listProjectEntries({ config, workRoot: workDir }).find((p) => p.id === id);
      if (!found) return null;
      return { ...found, memoryLimit: memoryLimitOf(config, id) };
    },
    // P7-6：看板项目面板展开时读最近 N 条记忆。只读、只给最近几条，不给全库。
    projectMemory: (id, { limit = 10 } = {}) => {
      const found = listProjectEntries({ config, workRoot: workDir }).find((p) => p.id === id);
      if (!found) return null;
      const got = readRecentMemory(workDir, id, { limit });
      return { project: id, count: got.count, limit, items: got.entries };
    },
    submit, pump, route, emitEvent, wake, submitChangeRequest, onProgressReport,
    cancelTask,
    // 子派活与审查：工程岗既是执行者也是工头，还要当代码审查人。
    spawnChild, reviewTask, reviewerOf,
    // 看板/CLI 用：现在有哪些卡在等「我」审（拉模式席位靠它知道该干活了）。
    pendingReviews: (agentId = null) => {
      const rows = db.prepare("SELECT * FROM tasks WHERE status = 'in_review' ORDER BY rowid").all();
      return rows.filter((t) => {
        const kind = inferArtifactKind(t, {}).kind;
        const expect = reviewerOf(t, kind);
        return agentId ? expect === agentId : true;
      }).map((t) => ({ ...t, reviewer: reviewerOf(t, inferArtifactKind(t, {}).kind) }));
    },
    reconcile,
    // 短延迟自检：测试要能看到「还有哪张卡排着等重试」。
    clearGateRetry,
    pendingGateRetries: () => [...gateRetries.keys()],
    // P7-5：落盘（测试与手工补偿用）。
    deliverAccepted: (task, runId = null) => deliverAccepted(task, runId),
    retryPendingDeliveries: (opts) => retryPendingDeliveries(opts),
    compensationScan: (opts) => compensationScan(db, opts),
    // 公司工作目录：新建项目 / 落盘补偿等外部动作要按它定位，别再各自猜一遍。
    workDir,
    getTasks: () => db.prepare('SELECT * FROM tasks ORDER BY rowid').all(),
    // P8：每张「停着的」卡一句话原因，看板直接用（不用前端自己去啃审计）。
    holdReasons: () => holdReasons(),
    getRuns: () => db.prepare('SELECT * FROM runs ORDER BY rowid').all(),
    getAudit: () => db.prepare('SELECT * FROM audit ORDER BY rowid').all(),
    // 总经理会话（外部按量计费席位）：看板显示 + 手动换新。
    getCeoSession: () => ({
      ...describeCeoSession(readCeoSession(workDir, ceoId())),
      policy: { ...DEFAULT_SESSION_POLICY, ...(config.interaction?.ceoSession ?? {}) },
    }),
    resetCeoSession: ({ reason = '董事会手动新建', actor = 'board' } = {}) => {
      const state = rotateCeoSession(workDir, ceoId(), { reason, actor });
      writeAudit(db, {
        actor, action: 'ceo_session_reset',
        newValue: `${state.sessionId}｜${String(reason).slice(0, 200)}`.slice(0, 300),
      });
      return {
        ...describeCeoSession(state),
        policy: { ...DEFAULT_SESSION_POLICY, ...(config.interaction?.ceoSession ?? {}) },
      };
    },
    getBriefs: () => db.prepare('SELECT * FROM briefs ORDER BY rowid').all(),
    getThreads: () => db.prepare('SELECT * FROM threads ORDER BY rowid').all(),
    getEvents: () => db.prepare('SELECT * FROM events ORDER BY rowid').all(),
    getQuotas: () => getAgentCandidates(),
    resetQuota: (agentId) => {
      const result = resetQuota(db, agentId, { now: clock(), periodHours: config.quota?.periodHours });
      writeAudit(db, { actor: 'human', action: 'quota_reset', newValue: agentId });
      return result;
    },
    getApprovals: (filter = {}) => listApprovals(db, filter),
    requestApproval, decideApproval, submitDecision, expireDecisions,
    setApprovalHandler: (kind, fn) => { approvalHandlers[kind] = fn; return true; },
    setTaskTerminalHook: (fn) => { taskTerminalHook = typeof fn === 'function' ? fn : null; return true; },
    rollCall, promoteThread, archiveThread, archiveStaleThreads,
    getChangeRequests: (taskId = null) => {
      const rows = db.prepare('SELECT * FROM change_requests ORDER BY rowid').all();
      return taskId ? rows.filter((r) => r.taskId === taskId) : rows;
    },
    getDecisions: (taskId = null) => {
      const rows = db.prepare('SELECT * FROM decisions ORDER BY rowid').all();
      return taskId ? rows.filter((r) => r.taskId === taskId) : rows;
    },
    getRevisions: (taskId) => db.prepare('SELECT * FROM task_revisions WHERE taskId = ? ORDER BY revision').all(taskId),
    getSnapshot: (taskId, crId) => {
      const file = snapshotPath(workDir, taskId, crId);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    // P4-4：一条任务的时间线（状态转换 / Run / 变更 / 决策 / 审批 / 版本），按时间串起来。
    getActivity: (taskId) => {
      const task = taskById(taskId);
      if (!task) return null;
      const runs = db.prepare('SELECT * FROM runs WHERE taskId = ? ORDER BY rowid').all(taskId);
      const audit = db.prepare('SELECT * FROM audit WHERE taskId = ? OR runId IN (SELECT runId FROM runs WHERE taskId = ?) ORDER BY rowid')
        .all(taskId, taskId);
      const changes = db.prepare('SELECT * FROM change_requests WHERE taskId = ? ORDER BY rowid').all(taskId);
      const decisions = db.prepare('SELECT * FROM decisions WHERE taskId = ? ORDER BY rowid').all(taskId);
      const approvals = db.prepare('SELECT * FROM approvals WHERE taskId = ? ORDER BY rowid').all(taskId);
      const revisions = db.prepare('SELECT * FROM task_revisions WHERE taskId = ? ORDER BY revision').all(taskId);
      const snapshots = changes.map((c) => {
        const file = snapshotPath(workDir, taskId, c.changeRequestId);
        return {
          changeRequestId: c.changeRequestId,
          snapshotPath: fs.existsSync(file) ? file : null,
          snapshot: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
        };
      });
      return { task, runs, audit, changeRequests: changes, decisions, approvals, revisions, snapshots };
    },
    getDashboard: () => {
      const counts = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
      const stuckMs = 30 * 60 * 1000;
      const stuck = db.prepare("SELECT taskId, title, assignee, updatedAt FROM tasks WHERE status IN ('todo','in_progress')")
        .all().filter((t) => clock().getTime() - Date.parse(t.updatedAt) > stuckMs);
      return {
        tasks: Object.fromEntries(counts.map((r) => [r.status, r.n])),
        runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
        threads: db.prepare('SELECT COUNT(*) AS n FROM threads').get().n,
        briefs: db.prepare('SELECT COUNT(*) AS n FROM briefs').get().n,
        agents: getAgentCandidates(),
        quotas: getAgentCandidates().map((a) => ({
          agentId: a.agentId, used: a.quotaUsed, limit: a.quotaLimit,
          ratio: a.quotaLimit ? a.quotaUsed / a.quotaLimit : 0,
        })),
        pendingApprovals: pendingApprovals(db),
        awaitingDecision: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'awaiting_decision'").get().n,
        decisions: db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n,
        recurringJobs: db.prepare('SELECT COUNT(*) AS n FROM recurring_jobs').get().n,
        stuck,
        dispatchMode,
      };
    },
    close: () => {
      // 先把挂着的「等会儿再试」清掉，再关库：否则定时器醒来会朝一个已关的库写事件。
      for (const entry of gateRetries.values()) clearTimeout(entry.timer);
      gateRetries.clear();
      deliverAttempts.clear();
      db.close();
    },
    adapterTypes: availableAdapterTypes,
  };
}
