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
  listProjects as listProjectEntries, memoryLimitOf, readRecentMemory, archiveMemoryIfNeeded } from './projects.js';
import { repoEntry, findRepoForPath, assertRepo } from './repos.js';
import { assetOwnerOf, needsAssetAck, assetAckInstructions } from './asset-ack.js';
import { looksLikeCode, seatPreamble, reviewerBriefing } from './org-chart.js';
import { buildScheduleJob } from './schedule-request.js';
import { wakeSession } from './wake.js';
import {
  recordMessage, listMessages, markMessagesRead as markReadInDb, unreadMessageCount, speakerLabel,
  composeDoneMessage, composeBlockedMessage, composeAnswerMessage, plainText,
} from './messages.js';
import {
  deliverTask, runningProcesses, lastDeliveryOf, appendDeliveryLog, DELIVERY_SCHEMA, resolveDeliverDir,
} from './deliver.js';
import { nextFireAt } from './rrule.js';
import { createGuiLock } from './gui-lock.js';
import { probeRun, EVIDENCE_LEVEL, writeStopSignal } from './evidence.js';
import {
  DEFAULT_SESSION_POLICY, describeCeoSession, markSessionWarned, readCeoSession, rotateCeoSession,
} from './ceo-session.js';

export function createNotifier(kind = 'web') {
  // P4-6：可传单个通道名或数组；web / noop / stdout 内置，im / webhook 需显式地址。
  return createChannels(Array.isArray(kind) ? kind : [kind]);
}

const shortId = () => randomUUID().slice(0, 8);
// 事件处理超时的哨兵值：用唯一对象比较，绝不可能和 adapter 的正常返回值撞上。
const TIMED_OUT = Symbol('pump-event-timeout');

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

// 这单产物该落到哪个绝对路径（项目没配 rootDir → dir=null，提示词退回 output/）。
// 2026-11-24 从 dispatch 里抽出来：派活和证据层必须共用同一口径，
// 否则「让它写项目目录」和「只在 output/ 里找证据」会互相打架（T-5457e8a0）。
function projectWriteDirOf(config, task) {
  if (!task?.project) return { dir: null, error: 'PROJECT_UNSET' };
  try {
    const target = resolveDeliverDir({ config, id: task.project, subdir: task?.deliverSubdir ?? null });
    return target.ok
      ? { dir: target.targetDir, error: null }
      : { dir: null, error: target.error ?? 'NOT_OK' };
  } catch (error) {
    return { dir: null, error: String(error?.message ?? error) };
  }
}

export function createEngine({
  db, config, notifier = createNotifier('web'), maxSteps = 80,
  dispatchMode = 'inline', approvalHandlers = {}, workRoot = null, now = () => new Date(),
  // 被「临时条件」拦下的卡多久自己再试一次（毫秒）。0 = 关闭，只靠维护心跳。
  gateRetryMs = 0,
  // G2：卡进终态时通知外部（由 server 接到循环引擎）。钩子失败只留审计，不影响卡的状态。
  taskTerminalHook = null,
  // 2026-11-23：控制面关键路径日志。审计在 SQLite 里，翻起来要拷库；日志是给人翻的。
  // log 是可选的函数 (text, level?)，不传就完全不写 —— 单测里建引擎不该碰文件系统。
  log = null,
}) {
  // inline = P1 单机直调 adapter（默认，本地演示一等公民）；
  // bridge = P2 拉模式，控制面只排队，等本机 bridge 来 checkout。两者共用同一套统一 API。
  if (!['inline', 'bridge'].includes(dispatchMode)) {
    throw new Error(`未知 dispatchMode ${dispatchMode}；可用：inline / bridge`);
  }
  const clock = () => now();
  const clockIso = () => clock().toISOString();
  // 日志永远不能反过来影响调度：写日志失败就吞掉，审计仍然照常写。
  const logEvent = (text, level = 'info') => {
    try { if (typeof log === 'function') log(text, level); } catch { /* ignore */ }
  };
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

  /** 日常循环任务的默认审查人：工程岗。
   * 为什么不能在代码里写死 'engineering'：这家公司是可以换人的，配置里没这个岗就该按能力找。
   * 为什么绝不默认回总经理：巡检 / 体检 / 清理这类活，CEO 看得再勤也只是一句「知道了」，
   * 每轮都烧一次按量计费的 CEO Run，是纯浪费；方向性的东西才该惊动他。
   */
  function defaultRoutineReviewer(assignee = null) {
    const agents = (config.agents ?? []).filter((a) => a.status !== 'disabled');
    const byRef = (id) => (id ? agents.find((a) => a.id === id || a.postTitle === id) : null);
    const preferred = byRef(config.artifacts?.routineReviewer)
      ?? byRef(config.artifacts?.defaultReviewer)
      ?? agents.find((a) => a.isCEO !== true && (a.capabilities ?? []).includes('review'));
    // 没有工程岗也不能默认回 CEO：交给董事会亲审（出一张待拍板单），至少不会白烧额度。
    let reviewer = preferred?.id ?? 'human';
    // 审查人不能是执行人自己；撞车就上升一级（它的上级），再撞就交董事会。
    if (reviewer === assignee) {
      const boss = cfgFor(assignee)?.reportsTo;
      reviewer = boss && boss !== assignee ? boss : 'human';
    }
    return reviewer;
  }

  /** 排班时定审查人：CEO 写了就按它（可写 ceo / human / 岗位 id），没写就用日常默认。
   *  2026-11-18：撞车（审查人＝执行人）不再把整条建议拒掉，改成**自动上升一级**。
   *  起因：CEO 提「工作台月度体检」，执行人写了工程岗、审查人也写了工程岗，
   *  引擎判「不能自己审自己」→ 整条建议被丢、只写了一条审计，CEO 却在回话里说「已安排」。
   *  这条规则在治理上是对的（不能自审），但拒绝的方式错了：该抬一级，而不是把活扔掉还不吭声。 */
  function resolveCycleReviewer({ wanted = null, assignee }) {
    const raw = String(wanted ?? '').trim();
    const escalate = (from) => {
      const boss = cfgFor(assignee)?.reportsTo;
      const next = boss && boss !== assignee ? boss : 'human';
      return { reviewer: next, explicit: Boolean(raw), escalatedFrom: from };
    };
    if (raw) {
      const explicit = assertReviewSeat(raw);
      if (explicit === assignee) return escalate(explicit);
      return { reviewer: explicit, explicit: true };
    }
    const fallback = defaultRoutineReviewer(assignee);
    if (fallback === assignee) return escalate(fallback);
    return { reviewer: fallback, explicit: false };
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
      // 董事会也可以点仓库（代码类需求写 repo=仓库 id）：不点就按普通产物处理。
      // 归口闸只认卡上的 repo，所以这一步漏了，代码卡就绕过了仓库台账。
      repo: req.repo ? String(req.repo) : null,
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
    // 「拆成 N 张全派给自己」不是拆活，是换个名字继续自己干。
    // 2026-11-17 真机：工程岗把一张实现卡拆成 5 张「逐条复核与验收取证」全派给自己，
    // 表面上走了拆解流程，实际一张都没落到执行岗手里。有下级就别自派。
    if (assignee === assignerId) {
      const subs = config.agents.filter((a) => a.reportsTo === assignerId && a.status !== 'disabled');
      if (subs.length) {
        writeAudit(db, {
          actor: assignerId, action: 'spawn_self_rejected',
          oldValue: null, newValue: `派给自己被拒（下级：${subs.map((a) => a.id).join('/')}）`,
          taskId: parentTaskId,
        });
        throw new Error(
          `${assignerId} 是管理岗，不能把子卡派给自己：请派给下级（${subs.map((a) => `${a.postTitle ?? a.id}=${a.id}`).join('、')}）。`
          + '如果你判断这件事本来就该你自己做，那就别 spawn —— 直接在本卡上写方案/结论，'
          + '需要动手实现的仍然派下去。',
        );
      }
    }
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
    // 发布者不许自己把子卡作废。2026-11-17 真机：工程岗派了子卡，等不到下级接单，
    // 就自己 cancel 掉子卡、改由自己实施 —— 派活变成了「派了可以反悔」，
    // 而且它作废的那一刻，下级根本还没机会被叫醒（它的会话占着引擎的手）。
    // 要停子卡就按上报规则交上级决定：作废是治理动作，不是执行动作。
    const parent = task.parentTaskId ? taskById(task.parentTaskId) : null;
    if (parent && actor !== 'human' && actor === parent.assignee) {
      writeAudit(db, {
        actor, action: 'cancel_child_rejected',
        newValue: `${task.taskId}|发布者不能自己作废子卡|${String(reason).slice(0, 120)}`, taskId,
      });
      return {
        taskId, status: task.status, cancelled: false, code: 'PARENT_CANNOT_CANCEL',
        reason: '你是这张子卡的发布者，不能自己把它作废。下级叫不起来请用 reportUpward 交上级处理；'
          + '确实要停这张卡，让上级或董事会来取消。',
      };
    }
    transition(db, taskId, 'cancelled', actor);
    // 光把卡标成 cancelled 不够：会话还在窗口里干、库里那一趟还挂着 running，
    // reconcile 会一直等它交一个永远不会来的结果（T-a4d59e96：人取消了，系统还在等重派那趟）。
    const liveRuns = db.prepare("SELECT runId, agentId FROM runs WHERE taskId = ? AND status = 'running'").all(taskId);
    for (const live of liveRuns) {
      db.prepare("UPDATE runs SET status = 'interrupted', finishedAt = ?, interruptedReason = ? WHERE runId = ?")
        .run(clockIso(), 'task_cancelled', live.runId);
      if (workDir) {
        writeStopSignal({
          workRoot: workDir, taskId, by: actor,
          reason: `任务被人取消：${String(reason).slice(0, 120)}`,
        });
      }
      try { releaseGuiLockForRun(live.agentId, live.runId); } catch { /* 非 GUI 席位没有锁 */ }
    }
    // 排队里的 issue_assigned 一并作废：取消九秒后还在 reconcile_requeue 就是这么来的。
    const droppedEvents = db.prepare('UPDATE events SET processed = 1 WHERE taskId = ? AND processed = 0').run(taskId);
    if (liveRuns.length || droppedEvents.changes) {
      writeAudit(db, {
        actor, action: 'cancel_settled',
        newValue: `停掉 ${liveRuns.length} 趟在跑的会话｜作废 ${droppedEvents.changes} 条排队事件`.slice(0, 300),
        taskId,
      });
    }
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
      // 决策者是员工（总经理 / 工程岗）时，不能只把卡挂着等人点按钮 —— 没人点它就永远躺着。
      // 走同一套「向上汇报」：给决策者建一张处置卡并叫醒他；处置完原卡自动回执行人手上
      // （见 resumeParentAfterEscalation）。只有决策者是董事会/人时，才真的进消息箱等人拍板。
      const dmIsAgent = config.runPolicy?.escalateToBoss === true
        && Boolean(requestedBy) && requestedBy !== 'human' && requestedBy !== 'board' && cfgFor(requestedBy);
      if (dmIsAgent && !hasOpenEscalationCard(task.taskId)) {
        const opened = openEscalation(task, { summary: '', reason: normalized.reason }, normalized.agentId, normalized.runId, {
          reason: `变更请求 ${normalized.changeRequestId}：${normalized.reason ?? ''}`,
          keepStatus: true, to: requestedBy,
        });
        writeAudit(db, {
          actor: 'control-plane', action: 'change_request_handed_up',
          newValue: `${requestedBy}｜处置卡 ${opened?.card ?? '(未建)'}`, taskId: task.taskId,
        });
      }
      const whyText = plainText(normalized.reason, 240) || '没说原因';
      // 只有真到董事会这一级才进消息箱；CEO 自己能定的不打扰人（挂起面板里还是能查到）。
      if (requestedBy === 'human' || requestedBy === 'board') {
        recordMessage(db, {
          from: normalized.agentId ?? 'system', kind: 'decision', taskId: task.taskId,
          project: task.project ?? null,
          title: `等你定：${task.title}`,
          body: [
            `${speakerLabel(config, normalized.agentId)} 做不下去了，要你定一件事：${task.title}`,
            `原因：${whyText}`,
            '它已经停下来等你，不会再自己乱试；定完它接着干。',
          ].join('\n'),
        });
      }
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
  // 2026-11-22 董事会定规矩：这几个原因是**让路**（你在用电脑 / 人工暂停 / 锁屏），
  // 不是「验收失败」。让路一次就扣一次补审额度的话，人一忙起来 5 次很快烧光，
  // 卡就永久停在待验收（T-faf7ddf8 就是这么挂了两天）。所以让路单独记账、不计额度。
  const YIELD_CODES = new Set(['user-active', 'paused', 'session-locked']);
  // 这次验收被挡下，是「让路」还是「失败」：让路不扣补审额度，其余（额度、桥离线、真跑挂）才算。
  function isReviewYield(code) {
    return YIELD_CODES.has(String(code ?? ''));
  }
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
      // 这里原来完全静默：一条僵死的 run 会因此把同一张卡的**验收**也挡掉，
      // 卡永远停在 in_review，看板只显示「待验收」（T-7a284ca4 事故）。至少要留一行账。
      writeAudit(db, {
        actor: 'scheduler', action: 'wake_deferred',
        newValue: `${agentId}|same_run|${runningSame.runId} 仍在 running，本次 ${wakeReason} 让路`,
        taskId,
      });
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
    // 落盘改造（2026-11-23）：把「这单产物该落到哪」直接算给席位，别让它猜项目目录。
    // writeDir 是绝对路径；项目没配 rootDir 时为 null，提示词会退回「留在 output/」。
    if (projectContext) {
      const target = projectWriteDirOf(config, task);
      projectContext.writeDir = target.dir;
      projectContext.writeDirError = target.error;
    }
    logEvent(`dispatch ${taskId} → ${agentId} run=${runId} reason=${wakeReason} project=${task?.project ?? '-'} writeDir=${projectContext?.writeDir ?? '(output)'}`);
    const ctx = {
      runId, wakeReason, taskId,
      task: task ? {
        taskId: task.taskId, title: task.title, mode: task.mode, status: task.status,
        revision: task.revision, attempt: task.attempt, instructions: task.instructions,
        acceptance: task.acceptance, parentTaskId: task.parentTaskId,
        project: task.project ?? null, repo: task.repo ?? null, reviewBy: task.reviewBy ?? null,
        difficulty: task.difficulty ?? DEFAULT_DIFFICULTY,
        // 打回重做时把验收意见带下去：提示词据此讲清「这张卡是打回，要改哪一条」。
        // 不带的话执行人被重新叫起来只看到原任务说明，根本不知道上一轮为什么没过（T-906d3686）。
        reviewNote: (typeof extra?.reviewNote === 'string' && extra.reviewNote.trim())
          ? extra.reviewNote.trim() : null,
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
    // 【统一前置】所有席位开工前先拿同一段话：我是谁 → 第 0 步先判断 → 怎么把活派下去。
    // 2026-11-17：这段话原来由各 adapter 自己拼，只有 webhook-exec 与 gui-template 两份；
    // process / http / cli-acp 是把 ctx 原样 JSON 丢给外部命令的，一句散文都没有，
    // 换个 adapter 身份就整体消失（工程岗换轨那天就是这么丢的）。现在在引擎里算一次，
    // adapter 只管用；ctx.briefing 还会跟着 JSON 一起透传给外部命令。
    ctx.briefing = seatPreamble(config, agentId, {
      task: ctx.task, repos: ctx.repos, artifacts: ctx.artifacts, workRoot: workDir,
    });
    // 验收请求发给「真审查人」之后，被叫醒的可能是一个中层席位：它这一趟不是干活，
    // 而是给这张卡一个结论。不单列这一段，它会照着执行模板再改一遍代码（等于谁审谁重做）。
    if (wakeReason === 'review_requested' && agentId !== ceoId()) {
      const reviewBlock = reviewerBriefing(config, agentId, {
        task: ctx.task, bridgeUrl: config.bridge?.url ?? null,
      });
      if (reviewBlock) ctx.briefing = [ctx.briefing, reviewBlock].filter(Boolean).join('\n\n');
      ctx.review = { asReviewer: true, taskId, taskTitle: ctx.task?.title ?? null };
    }
    let outcome;
    try {
      outcome = await mod.execute(ctx);
    } catch (error) {
      db.prepare("UPDATE runs SET status = 'failed', finishedAt = ? WHERE runId = ?").run(clockIso(), runId);
      writeAudit(db, { actor: agentId, action: 'adapter_failed', newValue: String(error.message), runId, taskId });
      if (task && task.status === 'in_progress') transition(db, taskId, 'blocked', 'scheduler', runId);
      return { failed: true, error: String(error.message), runId };
    }
    // 只关「自己开的那一趟」：这趟要是已经被判死（强制重派打断 / 收尸），
    // 回来时不许把 interrupted 又改回 success —— 那会让看板显示「跑成功了」，
    // 而实际上它的结果已经被丢掉，等于说假话。
    const closed = db.prepare("UPDATE runs SET status = ?, finishedAt = ? WHERE runId = ? AND status = 'running'")
      .run(outcome.status ?? 'success', clockIso(), runId);
    if (closed.changes === 0) {
      writeAudit(db, {
        actor: agentId, action: 'run_result_after_abandon',
        newValue: `${runId}｜${String(outcome.status ?? '')}`.slice(0, 200), runId, taskId,
      });
      return { ignored: true, runId, agentId, wakeReason };
    }
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
    // 回话本身就是给董事会的那条消息：落库（重启还在）+ 推气泡。
    const composed = composeAnswerMessage({ config, task, answer });
    recordMessage(db, {
      from: ceoId() ?? 'ceo', kind: 'answer', taskId: task.taskId,
      project: task.project ?? null, title: composed.title, body: composed.body,
    });
    // 父卡随后转 done，但答案是上面那条，不再重复播报一次「总经理干完了」。
    boardSilent.add(task.taskId);
    notifier.send({
      title: composed.title,
      body: composed.body.slice(0, 1500),
      scene: 'answer', taskId: task.taskId,
    });
    transition(db, task.taskId, 'in_review', 'ceo', runId);
    transition(db, task.taskId, 'done', 'ceo', runId);
    return { reported: true, chars: answer.length };
  }

  // ── 制度回执（2026-11-18）────────────────────────────────────
  // 「引擎拒绝」的正确语义是**打回 + 告诉他怎么改**，不是「把这条删掉、当没发生」。
  // 报告不合格早就这么做了（report_rejected → 重投 → 两轮后交人）；
  // 排班建议、路由字段却是静默丢弃，于是 CEO 回话说「已经安排好了」、看板写「完成」，
  // 库里其实什么都没落地。这里把后者归一到前者。
  //
  // 三条纪律：
  //   ① 回执必须说清三件事：违反哪条（code）、为什么（撞了谁 / 缺什么）、正确写法（能照抄）；
  //   ② 回执必须重新唤醒**同一个** agent（不是换个更弱的去猜），且这一轮不留任何副作用；
  //   ③ 上限 2 次，第 3 次 blocked 并沿汇报线上报——和人类公司一样：改两遍还不对，就交给人定。
  const RULE_RETRY_MAX = 2;

  function formatRuleViolations(violations = []) {
    const lines = ['【引擎打回：这一轮不合制度，一件事都没落地】'];
    violations.forEach((v, i) => {
      lines.push(`${i + 1}) ${v.reason}`);
      if (v.hint) lines.push(`   正确写法：${v.hint}`);
    });
    lines.push('（上面这些都已经撤回，没有派卡、没有出审批单。按回执改完后重来一轮。）');
    return lines.join('\n');
  }

  function feedbackRuleViolation({ task, agentId, violations, runId = null }) {
    const attempt = (task.attempt ?? 0) + 1;
    const why = violations.map((v) => `${v.code}：${v.reason}`).join(' / ').slice(0, 600);
    db.prepare('UPDATE tasks SET attempt = ?, updatedAt = ? WHERE taskId = ?').run(attempt, nowIso(), task.taskId);
    writeAudit(db, {
      actor: agentId, action: 'rule_violation',
      newValue: `第 ${attempt} 次：${why}`, runId, taskId: task.taskId,
    });
    if (attempt <= RULE_RETRY_MAX) {
      emitEvent({
        type: 'issue_assigned', taskId: task.taskId, agentId,
        payload: { wakeReason: 'rule_retry', reviewNote: formatRuleViolations(violations) },
        dedupeKey: `rule-retry:${task.taskId}:${attempt}`,
      });
      writeAudit(db, {
        actor: 'control-plane', action: 'rule_retry',
        newValue: `第 ${attempt}/${RULE_RETRY_MAX} 次打回，已带原因重新唤醒 ${agentId}`, runId, taskId: task.taskId,
      });
      return { retried: attempt };
    }
    transition(db, task.taskId, 'blocked', 'control-plane', runId);
    escalateToRescue({ ...task, attempt }, `同一轮 ${violations.length} 处不合制度，改了两轮仍不对：${why}`);
    return { blocked: true };
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
    const instructions = String(sug.instructions ?? '').trim();
    if (!instructions) return { error: '缺 instructions（每轮具体要干什么）' };
    const acceptance = (Array.isArray(sug.acceptance) ? sug.acceptance : [])
      .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 8);
    if (!acceptance.length) return { error: '缺 acceptance（怎么算这一轮干完了）' };
    // 承接人：必须是真能干的执行席位；CEO 在输出里点自己也会被改派（严禁自干）。
    const difficulty = normalizeDifficulty(sug.difficulty ?? 'normal', { field: 'difficulty' });
    const picked = resolveChildSeat({ preferred: sug.assignee ?? firstWorker(), difficulty, managerId: requestedBy });
    if (!picked.assignee) return { error: '没有能接这活的执行席位' };
    // 每一轮由谁审：日常巡检 / 体检 / 清理 / 简报默认交工程岗，
    // 只有「方向性」的循环（改项目走向、对外承诺、技术路线）才由 CEO 在建议里写 reviewBy: ceo。
    // 这个判断在排班时就定死写进 job，之后每一轮照着用，不用每轮再猜一次。
    let review;
    try {
      review = resolveCycleReviewer({ wanted: sug.reviewBy, assignee: picked.assignee });
    } catch (error) {
      return { error: `reviewBy 不可用：${error.message}` };
    }
    // 撞车被抬一级时把「原写的是谁」带回去，好让调用方留痕、也让董事会看见为什么审的人变了。
    const reviewEscalated = review.escalatedFrom
      ? `${review.escalatedFrom}→${review.reviewer}`
      : null;
    // 归属项目：只认已有且配了规范的；写了不存在的就拒，别让循环卡落到野地里。
    let project = null;
    if (sug.project) {
      try { project = assertProject({ config, workRoot: workDir, requested: sug.project }).project; }
      catch (error) { return { error: `项目不可用：${error.message}` }; }
    }
    const kind = RECURRING_KINDS.includes(sug.kind) ? sug.kind : 'maintenance';

    // 一次性定时：CEO 写 at（几点）而不是 rrule ——「视频发完第二天复盘」这种活只需跑一次，
    // 排成循环只会每周把董事会吵一遍。走同一条审批与注册通道，只是 maxCycles=1、overlap=queue。
    const at = typeof sug.at === 'string' ? sug.at.trim() : '';
    if (at) {
      let built;
      try {
        built = buildScheduleJob({
          text: instructions,
          at,
          date: typeof sug.date === 'string' && sug.date.trim() ? sug.date.trim() : null,
          title,
          project,
          assignee: picked.assignee,
          reviewBy: review.reviewer === 'human' ? 'human' : review.reviewer,
          acceptance,
          tz: String(sug.timezone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai',
        });
      } catch (error) {
        return { error: `at 不合法：${error.message}` };
      }
      built.kind = kind;
      built.owner = ceoId() ?? 'ceo';
      built.reportsTo = review.reviewer === 'human' ? null : review.reviewer;
      built.reviewNote = String(sug.reviewNote ?? '').trim().slice(0, 300) || null;
      built.taskTemplate.role = String(sug.role ?? 'execute');
      return { job: built, reassignedFrom: picked.reassignedFrom ?? null, oneShot: true, reviewEscalated };
    }

    const rrule = String(sug.rrule ?? '').trim();
    if (!rrule) return { error: '缺 rrule（多久跑一次）；一次性定时请写 at（几点）' };
    const timezone = String(sug.timezone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai';
    try { nextFireAt(rrule, nowIso(), timezone); } catch (error) {
      return { error: `rrule 不合法：${error.message}` };
    }
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
        owner: ceoId() ?? 'ceo', assignee: picked.assignee,
        // 汇报对象跟着审查人走：日常循环报给工程岗，别让执行人每轮都以为要惊动总经理。
        // 审查人是董事会时留空（它汇报的是人，不是某个席位）。
        reportsTo: review.reviewer === 'human' ? null : review.reviewer,
        reviewBy: review.reviewer,
        reviewNote: String(sug.reviewNote ?? '').trim().slice(0, 300) || null,
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
      reviewEscalated,
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
  function describeRecurringJob(job, reason, { oneShot = false } = {}) {
    const seat = cfgFor(job.assignee);
    const whenText = job.nextFireAt
      ? new Date(job.nextFireAt).toLocaleString('zh-CN', { hour12: false })
      : describeRRule(job.trigger.rrule);
    const lines = [
      reason
        ? `为什么建：${String(reason).slice(0, 600)}`
        : (oneShot
          ? '为什么建：CEO 判断这活只做一次，但要在某个时间点做（不是长期重复）。'
          : '为什么建：CEO 判断这活是长期重复的，值得排班。'),
      oneShot
        ? `什么时候跑：只跑一次，${whenText}（错过 12 小时内会补一次）`
        : `多久一次：${describeRRule(job.trigger.rrule)}（时区 ${job.trigger.timezone}）`,
      `每轮干什么：${job.taskTemplate.instructions.slice(0, 400)}`,
      `谁干：${seat?.postTitle ?? job.assignee}（担任：${seat?.holderName ?? job.assignee}）`,
      `每轮谁来审：${job.reviewBy === 'human'
        ? '董事会亲审（每轮出一张待你拍板的单）'
        : (cfgFor(job.reviewBy)?.postTitle ?? job.reviewBy ?? '未指定')}`
        + `${job.reviewNote ? `　←　${job.reviewNote}` : ''}`,
      `归属项目：${job.project ?? '不归属任何项目（产物只留在公司）'}`,
      `每轮怎么算干完：${job.taskTemplate.acceptance.join('；')}`,
      '消耗：每轮最多 2 次唤醒；连续失败 3 轮会自动暂停等你处理。',
      oneShot
        ? '结束方式：跑完这一轮就自动结束，不会每周重复。'
        : `有效期：到 ${String(job.termination?.validUntil ?? '').slice(0, 10)} 自动暂停${job.termination?.maxCycles ? `；最多 ${job.termination.maxCycles} 轮` : ''}，要续再点一次。`,
      '通过就按这个节奏自动跑；拒绝或改完再提交都行，有意见写在下面。',
    ];
    return lines.join('\n');
  }

  // CEO 提的排班建议 → 逐条出审批单。真正的注册发生在董事会点「通过」之后（server 的 handler）。
   // 2026-11-18 拆成两段，因为「校验」必须能跑在「动手」之前：
   //   ① planRecurringApprovals：纯读、可重复调用，只算「这条能不能出单、出成什么样」；
   //   ② commitRecurringApprovals：把算好的单真的写进 approvals。
   // 原来只有一个「边校验边写」的版本（另有一份一模一样的死代码），所以「有建议不合规」时
   // 前面的单已经写了一半、后面的被静默丢掉，CEO 还以为自己排上班了。
  // 一轮最多 3 条；同一条已在等审批时不重复出单。
  function planRecurringApprovals(list = [], { task, requestedBy = null } = {}) {
    const items = [];
    const errors = [];
    for (const sug of list.slice(0, 3)) {
      const built = buildRecurringJob(sug, { task, requestedBy });
      const label = String(sug?.title ?? '(无标题)').slice(0, 60);
      if (built.error) {
        // 示例里的执行人取「公司里真有的执行席位」，不写死任何产品名/人名：
        // 换一家公司、换一批席位，这份回执照样能照抄。
        const sampleAssignee = firstWorker() ?? '<执行岗位 id>';
        errors.push({
          code: 'recurring_suggestion_invalid',
          reason: `排班建议「${label}」不成立：${built.error}`,
          hint: `照这个写：{"title":"月度项目体检","assignee":"${sampleAssignee}","rrule":"FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=20;BYMINUTE=0",`
            + '"instructions":"每一轮照着做就能做完的完整说明",'
            + '"acceptance":["怎么算这一轮干完"],"reason":"为什么值得长期排班"}'
            + ' —— 不用写 reviewBy（审的人引擎按执行人的上级自动定）。',
        });
        continue;
      }
      // 同一条循环任务已经在等董事会时不出第二张单（CEO 一轮可能重复提同一条）。
      const dup = db.prepare(`SELECT approvalId FROM approvals
        WHERE kind = 'recurring_create' AND status = 'pending' AND requestJson LIKE ?`)
        .get(`%"jobId":"${built.job.jobId}"%`);
      items.push({ sug, built, oneShot: built.oneShot === true, dup: dup?.approvalId ?? null });
    }
    return { items, errors };
  }

  function commitRecurringApprovals(plan, { task, requestedBy = null } = {}) {
    const created = [];
    for (const item of plan?.items ?? []) {
      if (item.dup) continue;
      const { built, sug, oneShot } = item;
      const approval = requestApproval({
        kind: 'recurring_create', taskId: task.taskId,
        title: oneShot
          ? `定时任务申请（只跑一次）：${built.job.title}`
          : `循环任务申请：${built.job.title}`,
        body: describeRecurringJob(built.job, sug.reason, { oneShot }),
        payload: {
          job: built.job,
          oneShot,
          rruleText: oneShot
            ? `只跑一次 · ${built.job.nextFireAt
              ? new Date(built.job.nextFireAt).toLocaleString('zh-CN', { hour12: false })
              : describeRRule(built.job.trigger.rrule)}`
            : describeRRule(built.job.trigger.rrule),
        },
        requestedBy,
      });
      writeAudit(db, {
        actor: requestedBy ?? 'ceo', action: oneShot ? 'schedule_suggested' : 'recurring_suggested',
        newValue: `${built.job.jobId}|${approval.approvalId}`, taskId: task.taskId,
      });
      // 审查人被抬了一级：留痕，让董事会知道「为什么审的人不是 CEO 写的那位」。
      if (built.reviewEscalated) {
        writeAudit(db, {
          actor: 'control-plane', action: 'review_by_escalated',
          newValue: `${built.job.jobId}|${built.reviewEscalated}`, taskId: task.taskId,
        });
      }
      if (built.reassignedFrom && built.reassignedFrom !== built.job.assignee) {
        writeAudit(db, {
          actor: requestedBy ?? 'ceo', action: 'difficulty_reassigned',
          oldValue: built.reassignedFrom, newValue: built.job.assignee, taskId: task.taskId,
        });
      }
      created.push({
        approvalId: approval.approvalId, jobId: built.job.jobId, oneShot,
        assignee: built.job.assignee, reviewer: built.job.reviewBy,
      });
    }
    return { created };
  }

  // 阻塞 / 返工耗尽的统一上报：生成 escalation 事件，沿汇报线找决策者（§7.4）。
  function escalateTask(task, reason) {
    const dm = resolveDecisionMaker(config, task.assignee);
    // 汇报线到顶时 resolveDecisionMaker 会把总经理自己再返回一遍（它就是最后一个节点）。
    // 总经理自己卡住了，能拍板的只有董事会：必须映射成 human，否则「上报告诉自己」＝自己叫自己。
    const target = dm === task.assignee ? 'human' : dm;
    emitEvent({
      type: 'escalation', taskId: task.taskId, agentId: target,
      payload: { wakeReason: 'escalation', reason },
      dedupeKey: `blocked:${task.taskId}:${task.attempt ?? 0}`,
    });
    writeAudit(db, {
      actor: 'control-plane', action: 'blocked_escalated',
      newValue: `${task.assignee}→${target}:${reason}`, taskId: task.taskId,
    });
    return { decisionMaker: target };
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
    // 打回待办要从库里重读状态：outcome 链路传进来的 task 是转 blocked **之前**的快照
    // （调用方刚 transition 完 blocked 才走到这里），拿它判断会跳过 blocked→todo——
    // 卡就永远停在 blocked，而救火席位只领 todo 卡，直接死锁（T-465c3869 事故回归）。
    const freshStatus = db.prepare('SELECT status FROM tasks WHERE taskId = ?').get(task.taskId)?.status;
    if (freshStatus === 'blocked') transition(db, task.taskId, 'todo', 'control-plane');
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
        const fin = finalizeAccepted(task.taskId, decidedBy, null);
        writeAudit(db, {
          actor: decidedBy, action: 'board_accepted',
          newValue: `${approvalId}|${String(reason ?? '').slice(0, 200) || '无意见'}`,
          taskId: task.taskId,
        });
        if (!fin.closed) {
          return {
            approvalId, decision, applied: true, taskId: task.taskId,
            status: 'in_review', pendingAssetAck: true, assetOwner: fin.owner,
          };
        }
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
      // 记忆只追加不淘汰会无限变长：超量时把最老的挪进 archive-YYYY-MM.jsonl（归档不是删除）。
      const gc = archiveMemoryIfNeeded(workDir, task.project, { keep: memoryLimitOf(config, task.project) });
      if (gc.archived > 0) {
        writeAudit(db, {
          actor: 'control-plane', action: 'memory_archived',
          newValue: `${task.project}|归档 ${gc.archived} 条，现留 ${gc.count} 条`.slice(0, 300),
          runId, taskId: task.taskId,
        });
      }
      writeAudit(db, {
        actor: 'control-plane', action: 'memory_written',
        newValue: `${task.project}|${built.record.lessons.length} 条教训 / ${built.record.nextHints.length} 条下次`.slice(0, 300),
        runId, taskId: task.taskId,
      });
      // 2026-11-23 维护：实测 69 条记忆里 15 条 lessons/nextHints 双空（22%），
      // 空条目照样占 memoryLimit 读窗口，把有用的老经验挤出去。
      // 这里不拒绝入库（避免改动既有行为），只补一条可统计的审计，
      // 用来回答「哪个席位一直在交白卷」。
      if (built.record.lessons.length === 0 && built.record.nextHints.length === 0) {
        writeAudit(db, {
          actor: 'control-plane', action: 'memory_empty',
          newValue: `${task.project}|${task.assignee ?? '-'}|教训与下次提示均为空`.slice(0, 300),
          runId, taskId: task.taskId,
        });
      }
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
// 三条纪律：没配 rootDir 的项目不落；别人占着（独占进程）就先不落、等心跳重试；落盘失败不改卡状态。
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
      amendDoneMessage(task.taskId, `文件先没放过去：${running.join('、')} 正占着那个文件夹，等它关掉我再自动放。`);
      return { deferred: true, running };
    }
    // 落盘改造：把 completion 一起交给交付层 —— artifacts 是绝对路径说明产物已在项目目录，
    // 只核验记账，不再复制副本。
    let completion = null;
    try {
      completion = JSON.parse(fs.readFileSync(path.join(workDir, 'tasks', task.taskId, 'completion.json'), 'utf8'));
    } catch { completion = null; }
    const out = deliverTask({ workRoot: workDir, config, task, at: clockIso(), report: completion });
    logEvent(`deliver ${task.taskId} project=${task.project} ok=${out.ok} mode=${out.mode ?? 'copy'} code=${out.code ?? '-'} target=${out.targetDir ?? '-'}`, out.ok ? 'info' : 'warn');
    if (out.ok) {
      writeAudit(db, {
        actor: 'control-plane', action: 'delivered',
        newValue: `${task.project}|${out.mode === 'in-place' ? `${out.files?.length ?? 0} 个文件已在项目目录（不复制）` : `${out.copied.length} 个文件 → ${out.targetDir}`}`.slice(0, 300),
        runId, taskId: task.taskId,
      });
      // 完成消息在状态流转时就发了，那时还不知道落没落成；这里回来补一句「放哪了」。
      const projectName = config?.projects?.[task.project]?.displayName ?? task.project;
      const target = String(out.targetDir ?? '').split(/[\\/]/).filter(Boolean).slice(-1)[0];
      amendDoneMessage(
        task.taskId,
        out.mode === 'in-place'
          ? `产物已按项目规矩落在「${projectName}」${target ? ` 的 ${target}` : ''}（${out.files?.length ?? 0} 个文件，已核对，不再复制副本）。`
          : `已经放进「${projectName}」${target ? ` 的 ${target} 文件夹` : '的项目文件夹'}（${out.copied.length} 个文件）。`,
      );
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
        || (last.mode === 'in-place' && Array.isArray(last.failed) && last.failed.length === 0 && last.files?.length)
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
    const rows = db.prepare(`SELECT taskId, status, dependsOn, waitingChildren, assignee FROM tasks
      WHERE status IN ('todo','in_progress','in_review','blocked','paused','awaiting_decision')`).all();
    const out = {};
    for (const row of rows) {
      if (row.status === 'awaiting_decision') { out[row.taskId] = '等你拍板'; continue; }
      // 父卡挂起等子卡：看板要一眼看出「不是没人管，是在等下面几张回来」。
      if (Number(row.waitingChildren ?? 0) === 1) {
        const kids = childrenOf(row.taskId);
        const closed = kids.filter((k) => CHILD_CLOSED.includes(k.status)).length;
        out[row.taskId] = `等子卡：${closed}/${kids.length} 已收尾`;
        continue;
      }
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
      // 拉模式席位（人叫才醒）的卡停在 todo，不是在等系统，是在等**那个人**来领。
      // 不说这一句，看板上只剩「排队中」三个字 —— 董事会会以为系统坏了（真机上踩过）。
      if (cfgFor(row.assignee)?.dispatch === 'pull'
        && (row.status === 'todo' || row.status === 'in_progress')) {
        const post = cfgFor(row.assignee)?.postTitle ?? row.assignee;
        out[row.taskId] = `等「${post}」来领：该席位人叫才醒，不叫不会自己动`;
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
    if (to === 'done' || to === 'blocked') noteBoardMessage(taskId, to, actor, runId);
    if (to === 'done') releaseReadyDependencies();
    // 子卡收尾 → 看看父卡是不是「拆出去的活全回来了」，是就拼总汇报送审。
    // 放在状态机之后：父卡能收束的前提是这张子卡已经真的到终态。
    if (to === 'done' || to === 'blocked' || to === 'cancelled') settleParent(taskId);
    // 处置卡收尾 → 原卡不能继续躺着：回到执行人手上重跑，或再往上一层报。
    // 只在公司档打开了 escalateToBoss 时生效（默认关，保持老语义）。
    if (config.runPolicy?.escalateToBoss === true
      && (to === 'done' || to === 'blocked' || to === 'cancelled')) resumeParentAfterEscalation(taskId);
    return out;
  }

  // ── 董事会消息：卡到终态就对人说一句人话 ────────────────────────────
  // 谁 → 干了什么 → 结果 → 东西在哪 → 我要不要动手。技术细节一概不进消息，
  // 想深究就点消息里的「看这张卡」，那里有完整审计与产物。
  // 只对「人关心的卡」发：循环巡检这类内部卡不发，否则消息区会被日程噪音刷满。
  const doneMessageOf = new Map(); // taskId → msgId，落盘成功后回来补一句「放哪了」
  // 已经用别的形式说过话的卡（比如总经理只回话不派活）：卡照样转 done，但不再重复播报。
  const boardSilent = new Set();

  /**
   * 卡排进「人叫才醒」的席位手里时，必须主动说一句。
   *
   * 为什么：拉模式席位（工程岗）没有常驻进程，卡会一直停在 todo。以前这里只写一条审计，
   * 董事会在看板上看到的只有「排队中」三个字 —— 他以为系统坏了，实际上在等他开口叫人。
   * 一条消息讲清三件事：谁派的、为什么停着、怎么让它动。
   */
  function notePullWaiting(task, seat) {
    try {
      // 同一张卡只提醒一次：反复排队（打回重做、依赖放行）不该刷满消息区。
      const dup = db.prepare(`SELECT 1 AS n FROM board_messages
        WHERE taskId = ? AND kind = 'notice' AND title LIKE '等你领%' LIMIT 1`).get(task.taskId);
      if (dup) return null;
      const post = cfgFor(seat)?.postTitle ?? seat;
      const assigner = task.assignerId ?? task.assignedBy;
      const who = (!assigner || assigner === 'human' || assigner === 'board')
        ? '你' : (cfgFor(assigner)?.postTitle ?? assigner);
      const msg = recordMessage(db, {
        from: 'system', kind: 'notice', taskId: task.taskId, project: task.project ?? null,
        title: `等你领：${String(task.title ?? '(无标题)').slice(0, 50)}`,
        body: [
          `${who}把这张卡交给了「${post}」，现在停在队列里。`,
          `它不是坏了——这个席位是「人叫才醒」的：没有常驻进程，不叫它这张卡不会自己动。`,
          '',
          '让它动：在对话框里说一句「领活」就行（或跑 npm run seat -- inbox）。',
        ].join('\n'),
      });
      notifier.send({
        title: `有活等「${post}」来领`,
        body: `「${String(task.title ?? '').slice(0, 60)}」——说一句「领活」它就到手。`,
        scene: 'pull', taskId: task.taskId,
      });
      return msg;
    } catch { /* 提醒是旁路：写不进去不能让卡本身出问题 */ }
    return null;
  }

  /**
   * 真的去叫醒「人叫才醒」的席位。
   *
   * 为什么提醒不够：提醒只是让人知道「有活」，活还在原地。会话宿主的网关能往
   * 当前会话投一条消息，收到消息会话里的 agent 就醒了 —— 这是本机唯一一条
   * 「不用常驻进程、不用外部 API key」的唤醒路（剪辑工作台「交给 Agent」用的就是它）。
   *
   * 叫不醒（宿主没开、凭据过期）就安静退回上一步那条提醒，绝不假装叫过。
   */
  function wakePullSeat(task, seat) {
    if (config.wake?.enabled === false) return;
    const cooldownMs = Number(config.wake?.cooldownMs ?? 10 * 60 * 1000);
    // 冷却：同一张卡反复排队（打回重做、心跳重投）不该把会话刷爆。
    const last = db.prepare(`SELECT createdAt FROM audit
      WHERE taskId = ? AND action IN ('wake_sent','wake_queued','wake_failed')
      ORDER BY rowid DESC LIMIT 1`).get(task.taskId);
    if (last && Date.now() - Date.parse(last.createdAt) < cooldownMs) return;

    const post = cfgFor(seat)?.postTitle ?? seat;
    const text = [
      `【AICompany 自动叫醒】「${post}」有一张卡在队列里等你领：`,
      `${String(task.title ?? '(无标题)').slice(0, 80)}`,
      '',
      `领活并干完（在本项目根目录下执行）：`,
      `AICOMPANY_AGENT_ID=${seat} node scripts/seat.js inbox`,
      '（这条不是董事会发的，是 AICompany 控制面在叫醒你）',
    ].join('\n');

    const mark = (action, detail) => {
      try {
        writeAudit(db, {
          actor: 'control-plane', action, newValue: `${seat}|${String(detail).slice(0, 200)}`, taskId: task.taskId,
        });
      } catch { /* 唤醒是旁路：库已经关了（收尾/测试）也不能把回调变成未捕获异常 */ }
    };

    // 不 await：唤醒是旁路，卡已经落库；叫不醒不能把控制面卡住。
    wakeSession({
      text,
      key: task.taskId,
      files: config.wake?.credsFiles ?? [],
      maxWaitMs: Number(config.wake?.maxWaitMs ?? 10 * 60 * 1000),
      pollMs: Number(config.wake?.pollMs ?? 2000),
      // 投出去不算数：要观察到会话真的忙起来才算叫醒（哑火重投，见 wake.js 顶部说明）。
      graceMs: Number(config.wake?.graceMs ?? 4000),
      verifyMs: Number(config.wake?.verifyMs ?? 20000),
      retryDelayMs: Number(config.wake?.retryDelayMs ?? 8000),
      maxAttempts: Number(config.wake?.maxAttempts ?? 4),
      // 排队之后真正发出的那一次只能从回调里知道。
      onResult: (result) => mark(result.ok ? 'wake_sent' : 'wake_failed',
        result.ok ? (result.runId ?? 'ok') : result.error),
    }).then((result) => {
      if (!result.ok) mark('wake_failed', result.reason ?? 'unknown');
      else if (result.queued) mark('wake_queued', result.reason ?? 'busy');
      // 直发成功的情况由 onResult 记 wake_sent，这里不重复。
    }).catch((error) => mark('wake_failed', error?.message ?? String(error)));
  }

  function noteBoardMessage(taskId, to, actor = 'control-plane', runId = null) {
    try {
      const task = taskById(taskId);
      if (!task) return null;
      if (task.origin?.internal === true) return null;
      // 「处理升级」这类由引擎自己建的系统卡：它本身就是一条消息，不再重复播报。
      if (task.origin?.escalationOf) return null;
      if (boardSilent.has(taskId)) return null;
      // 只派活、不干活的父卡分两种：
      //   · 拆完就交（子卡还在跑）→ 不播报，成果由子卡各自报；
      //   · 子卡全收尾后才收账 → 单独播一条「总任务收束」，
      //     否则董事会看完 N 条子卡消息，也不知道这一摊整体收没收。
      const kids = childrenOf(taskId);
      const allClosed = kids.length > 0 && kids.every((k) => CHILD_CLOSED.includes(k.status));
      if (kids.length && !allClosed) return null;
      const isParent = allClosed;

      if (to === 'done') {
        const report = pendingMemory.get(taskId) ?? null;
        const approvedByBoard = actor === 'human' || actor === 'board';
        const reviewedBy = (!approvedByBoard && task.reviewBy && task.reviewBy !== task.assignee)
          ? task.reviewBy : null;
        const composed = composeDoneMessage({
          config, task, report, reviewedBy, approvedByBoard, actor: task.assignee,
        });
        // 父卡（拆过子卡的卡）到 done = 整摊活收账。子卡消息讲的是「每一件」，
        // 这一条讲的是「总共」，并且由**验收的那个人**对董事会说 ——
        // 总经理派下来的活由他验，自然由他向董事会汇报；不署名成工程岗，
        // 否则董事会会以为是干活的人在自说自话。
        const doneN = kids.filter((k) => k.status === 'done').length;
        const badN = kids.length - doneN;
        const byCeo = isParent && actor === ceoId();
        const shortTitle = String(task.title ?? '(无标题任务)').slice(0, 40);
        const kidsLine = `拆下去的 ${kids.length} 张子卡：${doneN} 张完成${badN ? `，${badN} 张没成` : ''}。`;
        const title = isParent
          ? `${byCeo ? '总经理汇报' : '总任务收束'}：${shortTitle}`
          : composed.title;
        const body = isParent
          ? [
            byCeo ? `总经理说：这摊活办完了。${kidsLine}` : kidsLine,
            '每张子卡的结果都有记录，点开这张卡就能逐条看。',
            byCeo ? '董事会不用管，这一单已经收账。' : '',
          ].filter(Boolean).join('\n')
          : composed.body;
        const msg = recordMessage(db, {
          from: byCeo ? ceoId() : (task.assignee ?? 'system'),
          kind: 'done', taskId, project: task.project ?? null,
          title, body,
          docs: (report?.artifacts ?? []).slice(0, 20),
        });
        if (msg) doneMessageOf.set(taskId, msg.msgId);
        return msg;
      }

      // blocked：卡住 / 上报，都是「需要你定」，只是措辞不同。
      const latest = db.prepare(`SELECT newValue FROM audit
        WHERE taskId = ? AND action IN ('report_rejected', 'escalated', 'handoff_escalate')
        ORDER BY rowid DESC LIMIT 1`).get(taskId);
      const composed = composeBlockedMessage({
        config, task, reason: latest?.newValue ?? null, actor: task.assignee,
      });
      return recordMessage(db, {
        from: task.assignee ?? 'system', kind: 'blocked', taskId, project: task.project ?? null,
        title: composed.title, body: composed.body,
      });
    } catch (error) {
      // 消息是旁路：写不进去只留审计，绝不影响卡的状态流转。
      writeAudit(db, {
        actor: 'control-plane', action: 'board_message_failed',
        newValue: String(error.message).slice(0, 200), runId, taskId,
      });
      return null;
    }
  }

  // ── 父卡收束：拆出去的活全回来了，才轮到总任务交账 ──────────────────
  // 真公司里，工程岗把活拆给执行岗之后不是「交完就走」：子卡一张张回来，
  // 他得逐张验，全部收齐了再对发布者（总经理 / 董事会）交一次总账。
  // 固化两条规则：
  //   ① 还有子卡没收尾时交活 → 父卡挂起（waitingChildren=1），不送审；
  //   ② 最后一张子卡到终态 → 自动拼总汇报，按父卡自己的路由送审。
  // 有这两条，「8 张子卡完成 = 总任务完成」才真的成立：
  // 总任务是在子卡全收尾之后才出现在总经理面前的，而不是拆完卡那一刻。
  const CHILD_CLOSED = ['done', 'blocked', 'cancelled'];
  const STATUS_WORD = { done: '完成', blocked: '卡住了', cancelled: '取消', in_progress: '在做', in_review: '待验收' };

  function childrenOf(taskId) {
    return db.prepare('SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY rowid').all(taskId);
  }

  /** 子卡的一句话结论：优先用它报给董事会的那句人话，其次验收记录。 */
  function childOutcome(kid) {
    const msg = db.prepare("SELECT body FROM board_messages WHERE taskId = ? AND kind = 'done' ORDER BY rowid DESC LIMIT 1")
      .get(kid.taskId);
    if (msg) {
      const said = String(msg.body ?? '').split('\n').map((s) => s.trim()).find((s) => s.startsWith('它说：'));
      if (said) return said.replace(/^它说：/, '').slice(0, 160);
    }
    const hit = db.prepare(`SELECT newValue FROM audit WHERE taskId = ? AND action IN
      ('review_passed','review_rejected','handoff_land','report_rejected') ORDER BY rowid DESC LIMIT 1`).get(kid.taskId);
    const raw = String(hit?.newValue ?? '').split('|').slice(1).join('|').trim();
    return raw ? raw.slice(0, 160) : '';
  }

  /**
   * 把 N 张子卡的结果写成一份人话汇总，落到父卡的任务目录。
   * 为什么必须落文件：总经理验收时是去读 output 目录和 completion.json 的，
   * 只把汇总放在内存里，它看到的还是那句「我拆了 8 张」。
   */
  function writeChildrenSummary(parent, kids, lines) {
    try {
      const dir = path.join(workDir, 'tasks', parent.taskId);
      fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
      const md = [
        `# 总任务：${parent.title}`,
        '',
        `共 ${kids.length} 张子卡，全部收尾。`,
        '',
        ...lines.map((x) => `- ${x}`),
        '',
        `时间：${nowIso()}`,
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'output', '总任务汇总.md'), `${md}\n`, 'utf8');

      const reportPath = path.join(dir, 'completion.json');
      let card = {};
      try { card = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { card = {}; }
      // 第一次收束前先把「拆解方案」那份原件留一份：覆盖掉就再也查不到它当初怎么拆的了。
      if (!card.children && Object.keys(card).length) {
        fs.writeFileSync(path.join(dir, 'completion.plan.json'), `${JSON.stringify(card, null, 2)}\n`, 'utf8');
      }
      const merged = {
        ...card,
        schema: card.schema ?? 'aicompany.completion/v1',
        taskId: parent.taskId,
        status: 'success',
        summary: `总任务收束：${kids.length} 张子卡全部收尾（${kids.filter((k) => k.status === 'done').length} 张完成${kids.some((k) => k.status !== 'done') ? `，${kids.filter((k) => k.status !== 'done').length} 张没成` : ''}）。逐张结果见 output/总任务汇总.md。`,
        artifacts: [...new Set([...(Array.isArray(card.artifacts) ? card.artifacts : []), 'output/总任务汇总.md'])],
        children: kids.map((k) => ({
          taskId: k.taskId, title: k.title, status: k.status, assignee: k.assignee,
        })),
        finishedAt: nowIso(),
      };
      fs.writeFileSync(reportPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    } catch (error) {
      writeAudit(db, {
        actor: 'control-plane', action: 'children_summary_failed',
        newValue: String(error.message).slice(0, 200), taskId: parent.taskId,
      });
    }
  }

  /**
   * 子卡到终态时调用：父卡如果正挂着等它，且这是最后一张，就收束父卡。
   * 收束 ≠ 自动完成：只是把「总任务的结果」交到发布者手里，让发布者验收。
   * 发布者是总经理就叫他审，是董事会就出待拍板单，明确要落盘才直接落。
   */
  function settleParent(childTaskId) {
    try {
      const child = taskById(childTaskId);
      if (!child?.parentTaskId) return false;
      const parent = taskById(child.parentTaskId);
      if (!parent || ['done', 'cancelled'].includes(parent.status)) return false;
      // 父卡自己还没交活（还在做 / 还在拆）→ 等它自己交，别替它收。
      if (Number(parent.waitingChildren ?? 0) !== 1) return false;
      const kids = childrenOf(parent.taskId);
      if (!kids.length) return false;
      if (kids.some((k) => !CHILD_CLOSED.includes(k.status))) return false;

      // 多张子卡可能同一时刻收尾：CAS 抢位，只有一张能出总汇报。
      const claimed = db.prepare('UPDATE tasks SET waitingChildren = 0, updatedAt = ? WHERE taskId = ? AND waitingChildren = 1')
        .run(nowIso(), parent.taskId);
      if (!Number(claimed.changes ?? 0)) return false;

      let seed = {};
      try { seed = JSON.parse(parent.parentReportJson ?? '{}') ?? {}; } catch { seed = {}; }
      const lines = kids.map((k, i) => {
        const said = childOutcome(k);
        return `${i + 1}. ${k.title}｜${STATUS_WORD[k.status] ?? k.status}｜${k.assignee}${said ? `｜${said}` : ''}`;
      });
      writeChildrenSummary(parent, kids, lines);

      const doneN = kids.filter((k) => k.status === 'done').length;
      const badN = kids.length - doneN;
      const summary = [
        seed.summary ? plainText(seed.summary, 300) : `${parent.title}：拆成 ${kids.length} 张交给下级，现在全部收尾。`,
        `子卡结果：${doneN} 张完成${badN ? `，${badN} 张没成` : ''}。`,
        ...lines,
      ].join('\n');
      const report = {
        schema: 'aicompany.completion/v1',
        taskId: parent.taskId, runId: null, agent: parent.assignee,
        revision: parent.revision ?? 1,
        status: 'success',
        summary,
        artifacts: [...new Set([...(Array.isArray(seed.artifacts) ? seed.artifacts : []), 'output/总任务汇总.md'])],
        acceptanceResults: Array.isArray(seed.acceptanceResults) ? seed.acceptanceResults : [],
        usage: seed.usage ?? {},
        children: kids.map((k) => ({ taskId: k.taskId, title: k.title, status: k.status, assignee: k.assignee })),
        finishedAt: nowIso(),
      };
      pendingMemory.set(parent.taskId, report);
      writeAudit(db, {
        actor: 'control-plane', action: 'children_settled',
        newValue: `${kids.length} 张子卡全部收尾（${doneN} 完成${badN ? `，${badN} 没成` : ''}）`, taskId: parent.taskId,
      });

      // 父卡按自己的路由走：发布者是谁就交给谁。这一步就是「最终收束到发布者」。
      // 类型固定按 document 算：子卡里的代码已经各自过过代码审查，父卡收的是总账，不是代码。
      const kind = 'document';
      const handoffInfo = resolveHandoff(parent, kind, report);
      transition(db, parent.taskId, 'in_review', 'control-plane', null);
      if (handoffInfo.handoff === 'land') {
        const fresh = taskById(parent.taskId) ?? parent;
        transition(db, parent.taskId, 'done', 'control-plane', null);
        flushProjectMemory(fresh, null);
        deliverAccepted(fresh, null);
        return true;
      }
      const reviewer = reviewerOf(parent, kind);
      writeAudit(db, {
        actor: 'control-plane', action: 'children_settle_routed',
        newValue: `${reviewer}|${handoffInfo.source ?? '默认'}`, taskId: parent.taskId,
      });
      if (reviewer === ceoId()) {
        emitEvent({
          type: 'review_requested', taskId: parent.taskId, agentId: ceoId(),
          payload: { wakeReason: 'review_requested', kind, children: kids.length },
          dedupeKey: `review:${parent.taskId}:children:${nowIso()}`,
        });
        return true;
      }
      if (reviewer === 'human') {
        requestTaskReview(parent, report, kind, null);
        notifier.send({
          title: `待你拍板：${parent.title}`,
          body: `${kids.length} 张子卡全部收尾，${doneN} 张完成。总汇报已汇总，等你过目。`,
          scene: 'review', taskId: parent.taskId,
        });
        return true;
      }
      writeAudit(db, {
        actor: 'control-plane', action: 'review_queued',
        newValue: `${reviewer}|${kind}|子卡汇总`, taskId: parent.taskId,
      });
      return true;
    } catch (error) {
      writeAudit(db, {
        actor: 'control-plane', action: 'children_settle_failed',
        newValue: String(error.message).slice(0, 300), taskId: childTaskId,
      });
      return false;
    }
  }

  /** 落盘成功回来补一句「东西放哪了」——董事会最想知道的就是这个。 */
  function amendDoneMessage(taskId, suffix) {
    try {
      // 按库查最近一条完成消息，不靠内存映射：落盘重试、重启后再补，也照样补得上。
      const row = db.prepare(`SELECT msgId, body FROM board_messages
        WHERE taskId = ? AND kind = 'done' ORDER BY rowid DESC LIMIT 1`).get(taskId);
      if (!row) return;
      const body = String(row.body ?? '');
      if (body.includes(suffix)) return;
      db.prepare('UPDATE board_messages SET body = ? WHERE msgId = ?')
        .run(`${body}\n${suffix}`.slice(0, 4000), row.msgId);
    } catch { /* 补句子失败不值得报错 */ }
  }

  // G2：卡到终态时通知外部。循环引擎据此做「完成即触发下一轮」。
  // 钩子是外部注入的，失败绝不能把一张已经办完的卡拖回失败态——只留审计。
  function noteTaskTerminal(taskId, status, runId = null) {
    // 归口核对卡到终态时，父卡要么收账、要么打回 —— 先结算，再走外部钩子。
    if (['done', 'failed', 'blocked', 'cancelled'].includes(status)) {
      logEvent(`task_terminal ${taskId} ${status} run=${runId ?? '-'}`, status === 'done' ? 'info' : 'warn');
    }
    if (['done', 'blocked', 'cancelled'].includes(status)) {
      try { settleAssetAck(taskId); } catch (error) {
        writeAudit(db, {
          actor: 'control-plane', action: 'asset_ack_settle_failed',
          newValue: String(error.message).slice(0, 300), taskId,
        });
      }
    }
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

  // ── 资产归口（2026-11-18）─────────────────────────────────────
  // 交付验收管「结果对不对」，归口回执管「东西进没进仓库」。
  // 代码卡（managed-code + 登记了 repo）由非归口人执行时，验收通过后自动派生一张
  // 「归口核对」卡给仓库主人（默认工程执行）：它只核对 diff / 提交 / 推送，不重做实现。
  function assetAckNeed(task, kindHint = null) {
    const kind = kindHint ?? inferArtifactKind(task, pendingMemory.get(task.taskId) ?? {}).kind;
    return needsAssetAck({ task, kind, config });
  }

  function openAssetAckCard(task, need) {
    // 已经派过核对卡：还在跑就复用；已经完成就直接补结算（重启后也能接上）。
    const existingId = String(task.assetAckTaskId ?? '').trim();
    if (existingId) {
      const existing = taskById(existingId);
      if (existing && !['done', 'blocked', 'cancelled'].includes(existing.status)) return existingId;
      if (existing?.status === 'done') {
        settleAssetAck(existingId);
        return existingId;
      }
    }
    const report = pendingMemory.get(task.taskId) ?? {};
    const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
    const owner = need.owner;
    const ackTaskId = `T-${shortId()}`;
    const card = buildCard({
      taskId: ackTaskId,
      requestId: task.requestId,
      title: `归口核对：${String(task.title ?? '').slice(0, 60)}`,
      role: 'general',
      assignee: owner,
      mode: 'delegate',
      assignedBy: 'control-plane',
      assignerId: owner,
      parentTaskId: null,
      instructions: assetAckInstructions({ task, owner, repo: need.repo, artifacts }),
      acceptance: [
        'completion.json 通过 schema 校验且 status = success',
        'summary 必须写清落地结果：commit 短哈希 + 远端分支，或「无需变更」及依据',
      ],
      project: task.project ?? null,
      repo: task.repo ?? null,
      reviewBy: null,
      // 归口人就是资产主人：它交的回执不需要再找人验收，落盘即关单。
      handoff: 'land',
      allowSelfLand: true,
    });
    insertCard(card, owner);
    db.prepare(`UPDATE tasks SET assetAck = 'pending', assetOwner = ?, assetAckTaskId = ?, updatedAt = ?
      WHERE taskId = ?`).run(owner, ackTaskId, nowIso(), task.taskId);
    writeAudit(db, {
      actor: 'control-plane', action: 'asset_ack_opened',
      newValue: `${owner}|${need.repo?.id ?? task.repo}|${ackTaskId}`, taskId: task.taskId,
    });
    return ackTaskId;
  }

  /**
   * 验收通过后的统一出口：需要归口的先挂起，不需要的才真的 done。
   * 所有「通过即完成」的路径都必须走它，否则 CEO 直派代码活又能绕过仓库主人。
   */
  function finalizeAccepted(taskId, actor, runId = null, { kindHint = null } = {}) {
    const task = taskById(taskId);
    if (!task) return { closed: false, reason: '任务不存在' };
    const need = assetAckNeed(task, kindHint);
    if (need) {
      const ackTaskId = openAssetAckCard(task, need);
      writeAudit(db, {
        actor, action: 'asset_ack_required',
        newValue: `${taskId}|验收通过，待 ${need.owner} 归口回执（${need.repo?.id ?? task.repo}）|${ackTaskId}`,
        runId, taskId,
      });
      return { closed: false, pendingAssetAck: true, owner: need.owner, ackTaskId };
    }
    transition(db, taskId, 'done', actor, runId);
    const fresh = taskById(taskId) ?? task;
    flushProjectMemory(fresh, runId);
    deliverAccepted(fresh, runId);
    return { closed: true };
  }

  /** 归口核对卡到终态：done → 父卡收账；blocked/cancelled → 父卡打回执行岗。 */
  function settleAssetAck(ackTaskId) {
    const ack = taskById(ackTaskId);
    if (!ack) return false;
    const parent = db.prepare("SELECT * FROM tasks WHERE assetAckTaskId = ? AND assetAck = 'pending'").get(ackTaskId);
    if (!parent) return false;
    if (ack.status === 'done') {
      const note = db.prepare("SELECT body FROM board_messages WHERE taskId = ? AND kind = 'done' ORDER BY rowid DESC LIMIT 1")
        .get(ackTaskId);
      db.prepare(`UPDATE tasks SET assetAck = 'done', assetAckAt = ?, assetAckNote = ?, updatedAt = ?
        WHERE taskId = ?`).run(nowIso(), String(note?.body ?? '').slice(0, 600), nowIso(), parent.taskId);
      writeAudit(db, {
        actor: 'control-plane', action: 'asset_ack_passed',
        newValue: `${parent.taskId}|${ackTaskId}`, taskId: parent.taskId,
      });
      if (parent.status === 'in_review') {
        transition(db, parent.taskId, 'done', 'control-plane');
        const fresh = taskById(parent.taskId);
        if (fresh) {
          flushProjectMemory(fresh, null);
          deliverAccepted(fresh, null);
        }
      }
      return true;
    }
    if (['blocked', 'cancelled'].includes(ack.status)) {
      db.prepare(`UPDATE tasks SET assetAck = 'failed', assetAckNote = ?, updatedAt = ?
        WHERE taskId = ?`).run(`归口核对${ack.status === 'blocked' ? '卡住' : '被取消'}（${ackTaskId}）`, nowIso(), parent.taskId);
      writeAudit(db, {
        actor: 'control-plane', action: 'asset_ack_failed',
        newValue: `${parent.taskId}|${ackTaskId}|${ack.status}`, taskId: parent.taskId,
      });
      if (!['done', 'cancelled'].includes(parent.status)) {
        transition(db, parent.taskId, 'in_progress', 'control-plane');
        emitEvent({
          type: 'issue_assigned', taskId: parent.taskId, agentId: parent.assignee,
          payload: {
            wakeReason: 'rework',
            reviewNote: `归口核对没过（${ackTaskId}）：改动没进仓库 / 提交推送失败。请按归口意见修正后重交，`
              + '必要时先向工程执行确认落地方案。',
          },
          dedupeKey: `asset-ack-rework:${parent.taskId}:${Date.now()}`,
        });
      }
      return true;
    }
    return false;
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
      // 卡上已经写死「谁来审」的也一样：那是排班 / 下单时定的责任链，执行人不能自己把它改成落盘。
      if (declared === 'land' && (issuer.kind === 'agent' || task.reviewBy) && !task.allowSelfLand) {
        out.downgraded = task.reviewBy ? 'reviewer-pinned-cannot-self-land' : 'agent-card-cannot-self-land';
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
  function openEscalation(task, report, agentId, runId, { reason, keepStatus = false, to: toOverride = null }) {
    const to = toOverride ?? task.escalationTo
      ?? cfgFor(task.assignee)?.escalationTo
      ?? task.reportsTo
      ?? resolveDecisionMaker(config, task.assignee);
    // keepStatus：原卡已经处在「等人处置」的状态（blocked / awaiting_decision），不要再把它改写成 blocked。
    if (!keepStatus && task.status !== 'blocked') transition(db, task.taskId, 'blocked', agentId, runId);
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
      '【第一步：先判它到底在不在动 —— 别把「看不到」当成「没干」】',
      '1）产物：去它的交付目录（项目目录；没项目就看任务目录 output/）看有没有**本轮新文件**（改动时间晚于本次派单）。',
      '2）进程：process / CLI 席位的活，隔十秒看两次 CPU，有增量就是在跑。',
      '3）输出：桥接落了 cli-output.log 的话，看最后几行有没有新内容。',
      '任何一条成立 → 判「在动」：结论写「判为在动：让它继续」，并写清你是靠哪一条判的。',
      '  控制面会把原卡送回**同一个执行人**接着干（不是换人重做），它已经写下的产物都还在，不会白干。',
      '  这种情况不要改派、不要改验收条件、更不要自己动手重做。',
      '三条都不成立、或根本查不到 → 再按下面的三选一给处置。',
      '',
      '【你要决定的一件事】',
      ...(task.status === 'in_review' ? [
        '0）代验收并收束（你有权代审这张卡）：核对产物 / 证据后，用 `node scripts/seat.js verdict --as <你的 agentId> '
          + `--task ${task.taskId} --pass --reason "..." 通过；不同意就 --reject 并写清要改什么。`,
      ] : []),
      '1）改方案返工：把「改成什么」写清，让原执行人重跑；',
      '2）改派给别人；',
      '3）如果这会改变项目方向/对外承诺，上报总经理（你只负责把技术事实说清，不要自己拍板）。',
      '',
      '【底线】不许你自己动手重做这张卡的活，也不许让流程停在这里：处置完给一条明确结论，原卡会自动往下走。',
    ].filter(Boolean).join('\n');
    const card = buildCard({
      requestId: task.requestId,
      title: `处理升级：${task.title}`.slice(0, 80),
      role: 'escalation', assignee: to, mode: 'delegate', assignedBy: 'control-plane',
      parentTaskId: task.taskId,
      instructions: evidence,
      acceptance: ['明确给出一条处置：判为在动（写清依据，让它继续）/ 返工（改什么）/ 改派（给谁）/ 上报总经理（为什么必须他拍板）'],
      difficulty: task.difficulty, project: task.project, repo: task.repo,
    });
    insertCard(card, to);
    return { to, card: card.taskId };
  }

  // 已经有一张「处置卡」在跑：别为同一件事再建第二张（否则上级会被同一张卡反复叫醒）。
  function hasOpenEscalationCard(taskId) {
    return childrenOf(taskId)
      .some((k) => k.role === 'escalation' && !CHILD_CLOSED.includes(k.status));
  }

  /**
   * 所有「卡住」最终都要走到这里：向上汇报。
   *
   * 为什么必须是一个统一出口：以前卡住有三种去向 —— 转救火席位（重新派活）、
   * 直接出审批单给人、或者什么都不做就挂着。三种混着用，结果就是「有时自己动、
   * 有时等人、有时永远不动」，人根本猜不到下一次会不会有反应。
   *
   * 现在的规矩（对应董事会 2026-11-17 的要求）：
   *   ① 上级是员工 → 给他建一张「处置卡」并叫醒他，原卡不动在原地干等；
   *   ② 只有汇报线真的到人（board / human）才出审批单 —— 这是唯一合法的人工停点；
   *   ③ 同一张卡不会重复建处置卡。
   */
  function reportUpward(task, { reason = '', agentId = 'control-plane', runId = null, report = null } = {}) {
    const escalateToBoss = config.runPolicy?.escalateToBoss === true;
    const rawTo = task.escalationTo
      ?? cfgFor(task.assignee)?.escalationTo
      ?? task.reportsTo
      ?? resolveDecisionMaker(config, task.assignee);
    // 汇报线到顶时，resolveDecisionMaker 会把总经理自己再返回一遍（它就是最后一个节点）。
    // 那时候再「建一张卡给自己」没有意义，也不是「向上汇报」——只能交给董事会。
    const to = rawTo === task.assignee ? 'human' : rawTo;
    const isAgent = Boolean(to) && to !== 'human' && to !== 'board' && cfgFor(to);
    if (escalateToBoss && isAgent) {
      if (hasOpenEscalationCard(task.taskId)) {
        return { to, card: null, skipped: '已有处置卡在跑' };
      }
      const opened = openEscalation(task, report ?? { summary: '' }, agentId, runId, {
        reason: reason || '卡住了，需要你处置', keepStatus: true,
      });
      writeAudit(db, {
        actor: 'control-plane', action: 'reported_upward',
        oldValue: task.status, newValue: `${task.assignee}→${to}|${String(reason).slice(0, 260)}`,
        runId, taskId: task.taskId,
      });
      if (opened?.card) {
        notifier.send({
          title: `已向上汇报：${task.title}`,
          body: `${task.assignee} 的这张卡走不下去了（${String(reason).slice(0, 120)}），`
            + `已交给 ${to} 处置（处置卡 ${opened.card}）。处置完原卡会自动回到执行人手上，不用你插手。`,
          scene: 'escalation', taskId: task.taskId,
        });
      }
      return opened;
    }
    // 汇报线到顶：这是唯一允许停下来等人的情况。
    if (pendingApprovalFor(task.taskId, 'review_reject')) {
      return { to: 'human', skipped: '已有待批单' };
    }
    requestApproval({
      kind: 'review_reject', taskId: task.taskId,
      title: `阻塞上报：${task.title}`,
      body: `${task.assignee} 的任务卡在 ${task.status}（${String(reason).slice(0, 200)}）。`
        + '按汇报线已经汇报到顶，只能由你定：通过 / 要求重写（换人）/ 驳回（放弃）。',
      payload: { assignee: task.assignee, reason: String(reason).slice(0, 600) },
      requestedBy: 'control-plane',
    });
    writeAudit(db, {
      actor: 'control-plane', action: 'reported_to_board',
      newValue: String(reason).slice(0, 300), runId, taskId: task.taskId,
    });
    return { to: 'human', card: null };
  }

  /**
   * 处置卡收了 → 原卡自己活过来。
   *
   * 没有这一步，「向上汇报」就只是把停摆从下级搬到上级：上级写完处置意见，
   * 原卡还躺在 blocked / awaiting_decision 里等人来推。现在由控制面收账：
   * 上级说完了就让原执行人带着这段意见重跑；上级也办不下去就让再上一层接手。
   */
  function resumeParentAfterEscalation(childTaskId) {
    const child = taskById(childTaskId);
    if (!child || child.role !== 'escalation' || !child.parentTaskId) return false;
    const parent = taskById(child.parentTaskId);
    if (!parent || ['done', 'cancelled'].includes(parent.status)) return false;
    if (!CHILD_CLOSED.includes(child.status)) return false;
    const said = childOutcome(child) || (child.status === 'done' ? '上级已处置' : '上级也没办成');
    if (child.status !== 'done') {
      // 上级也办不下去：往再上一层报，不要停在中间层。
      const up = reportUpward(parent, {
        reason: `处置卡 ${child.taskId} 没办成：${said}`.slice(0, 500),
        agentId: 'control-plane',
      });
      return Boolean(up?.to);
    }
    const fromStatus = parent.status;
    // 同一张卡最多被处置卡「救活」两次：再往上就是上级也解决不了的问题，
    // 无限复活会把同一张卡变成额度黑洞（一次处置 → 一轮返工 → 再上报 → 再返工）。
    const resumedBefore = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'resumed_after_escalation'")
      .get(parent.taskId).n;
    if (resumedBefore >= 2) {
      reportUpward(parent, { reason: `已经被处置卡救活 ${resumedBefore} 次，仍走不完`, agentId: 'control-plane' });
      return false;
    }
    if (fromStatus === 'blocked') transition(db, parent.taskId, 'todo', 'control-plane');
    else if (fromStatus === 'awaiting_decision') transition(db, parent.taskId, 'in_progress', 'control-plane');
    // todo / in_progress：卡本来就在排队，只需叫一声 + 把上级的意见带进去。
    db.prepare('UPDATE tasks SET attempt = 0, updatedAt = ? WHERE taskId = ?').run(nowIso(), parent.taskId);
    emitEvent({
      type: 'issue_assigned', taskId: parent.taskId, agentId: parent.assignee,
      payload: { wakeReason: 'rework', reviewNote: `上级处置：${said}`.slice(0, 800) },
      dedupeKey: `resume-after-escalation:${parent.taskId}:${child.taskId}`,
    });
    writeAudit(db, {
      actor: 'control-plane', action: 'resumed_after_escalation',
      oldValue: fromStatus, newValue: `${child.taskId}｜${said}`.slice(0, 300), taskId: parent.taskId,
    });
    return true;
  }

  /**
   * 手动重新派单（看板按钮 / CLI / 接口共用）。
   *
   * 为什么必须有这个入口：卡会留在 in_progress / blocked 而没有 Run —— 配额刚好触顶、
   * 临时闸拦下、上一趟异常退出，都会留下这种形状。自动补偿（看门狗、补投）要等阈值，
   * 人在看板前看着它不动却没处下手。这个动作就是「我现在就要它再跑一趟」。
   *
   * 边界：
   *   · done / cancelled 不给派（终态就是终态）；
   *   · 还有子卡没做完不给派（该做的事在子卡手里，重派只会白烧一趟）；
   *   · 已经在跑的卡默认不给派（INLINE 模式下控不住那趟执行），要打断得显式 force；
   *   · 挂起待决策 / 待验收同样默认不给派，先处置那张单。
   */
  /**
   * 手动重派验收（2026-11-22 真机事故后新增）。
   *
   * 背景：验收补审满 5 次仍走不完时会写 review_stuck 并停手 —— 那时自动补审判据用完了，
   * 但卡本身可能是好的（活早干完了），只是当初连续几次都被「人正在用键鼠」挡下。
   * 之前没有出口：卡就一直挂着「待验收」，人只能干看着。这个方法就是那个出口：
   * 人看一眼，确认该由谁审，手动再发一次 review_requested（计数不再受限，审计留痕）。
   *
   * 边界：只处理 in_review；人审卡不代拍板；有 run 在跑时让路。
   */
  async function retryReview(taskId, { actor = 'human', reason = '董事会手动重派验收' } = {}) {
    const task = taskById(taskId);
    if (!task) return { ok: false, code: 'TASK_UNKNOWN', message: `没有这张卡：${taskId}` };
    if (task.status !== 'in_review') {
      return { ok: false, code: 'NOT_IN_REVIEW', message: `这张卡当前是 ${task.status}，不在待验收` };
    }
    const busy = db.prepare("SELECT runId FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1").get(taskId);
    if (busy) {
      return { ok: false, code: 'REVIEW_RUNNING', message: `已经有一趟验收在跑（${busy.runId}），等它出结果` };
    }
    const kind = inferArtifactKind(task, {}).kind;
    const expect = reviewerOf(task, kind);
    if (expect === 'human') {
      return { ok: false, code: 'HUMAN_REVIEW', message: '这张卡等人审，请在看板的审批单里处理，agent 不替你拍板' };
    }
    emitEvent({
      type: 'review_requested', taskId, agentId: expect,
      payload: { wakeReason: 'review_requested', kind, via: 'manual_retry' },
      // 手动重派只认「这一下」，不去跟自动补审的分钟桶去重（否则同一分钟点了没反应）。
      dedupeKey: `review-retry:${taskId}:${clock().getTime()}`,
    });
    writeAudit(db, {
      actor, action: 'review_retried',
      newValue: `${expect}|${String(reason).slice(0, 200)}`, taskId,
    });
    // 按钮立刻回，泵在后台推进（验收也可能卡在 GUI 上几分钟）。
    Promise.resolve(pump()).catch(() => {});
    return { ok: true, taskId, reviewer: expect };
  }

  async function redispatchTask(taskId, {
    reason = '董事会手动重派', actor = 'human', force = false,
    // 看板接口传 false：按钮要立刻有反馈，泵在后台推进。
    // 测试 / CLI 默认 true，等泵跑完再返回，断言才拿得到后续状态。
    awaitPump = true,
  } = {}) {
    const task = taskById(taskId);
    // 提示词里可能带着人写的多行理由，压成一行再落审计（看板/CLI 都按一行显示）。
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || '董事会手动重派';
    logEvent(`redispatch ${taskId} by=${actor} force=${force} reason=${why}`, 'warn');
    if (!task) return { ok: false, code: 'TASK_UNKNOWN', message: `没有这张卡：${taskId}` };
    if (['done', 'cancelled'].includes(task.status)) {
      return { ok: false, code: 'TASK_TERMINAL', message: `这张卡已经 ${task.status}，不需要重派` };
    }
    const openKids = db.prepare(`SELECT taskId, status FROM tasks WHERE parentTaskId = ?
      AND status NOT IN ('done', 'cancelled') ORDER BY rowid`).all(taskId);
    if (openKids.length && !force) {
      return {
        ok: false, code: 'HAS_OPEN_CHILDREN',
        message: `这张卡还在等 ${openKids.length} 张子卡（${openKids.map((k) => k.taskId).join(', ')}）做完；重派它不会推进任何事`,
      };
    }
    const running = db.prepare(`SELECT runId, agentId, startedAt FROM runs
      WHERE taskId = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1`).get(taskId);
    const runMinutes = running ? Math.round((clock().getTime() - Date.parse(running.startedAt)) / 60000) : 0;
    if (running && !force) {
      return {
        ok: false, code: 'RUNNING', runId: running.runId,
        message: `这张卡正在跑（${running.runId}，已 ${runMinutes} 分钟）。等它交活；确认它已经卡死，再点「强制重派」打断这一趟。`,
      };
    }
    if (task.status === 'awaiting_decision' && !force) {
      return { ok: false, code: 'AWAITING_DECISION', message: '这张卡在等拍板（变更请求或审批单）；先处置那张单，重派不会让任何人替它拍板' };
    }
    if (task.status === 'in_review' && !force) {
      return { ok: false, code: 'IN_REVIEW', message: '这张卡已经交活、在等验收；先看验收，确认要重跑再用「强制重派」' };
    }
    if (running && force) {
      // 只是把库里的这一趟判死：INLINE 模式下没人能真的掐断那个 promise，
      // 它以后要是还回来了，wake 的「只关自己开的那一趟」与 handleResult 的护栏会把它丢掉。
      db.prepare("UPDATE runs SET status = 'interrupted', finishedAt = ? WHERE runId = ? AND status = 'running'")
        .run(nowIso(), running.runId);
      writeAudit(db, {
        actor, action: 'run_interrupted_by_redispatch',
        newValue: `${running.runId}｜已 ${runMinutes} 分钟｜${why}`.slice(0, 300),
        runId: running.runId, taskId,
      });
      // GUI 锁跟着放：不放的话新那一趟会被 env_check 拦在门外，人点了「强制重派」却什么也没发生。
      if (releaseGuiLockForRun(running.agentId, running.runId)) {
        writeAudit(db, {
          actor, action: 'gui_lock_released_redispatch',
          newValue: `${running.runId}|${running.agentId}`, taskId,
        });
      }
      // 只改库不改现场，等于「假装这一趟死了」：会话还在干，交回结果又被丢掉（T-a4d59e96）。
      // 落一个停手信号，适配器下一轮轮询看到就自己退，旧会话不再和新会话抢同一个目录。
      if (workDir) {
        writeStopSignal({
          workRoot: workDir, taskId, by: actor,
          reason: `被强制重派，这一趟停止：${String(why).slice(0, 100)}`,
        });
      }
    }
    clearGateRetry(taskId);
    const fromStatus = task.status;
    db.prepare("UPDATE tasks SET status = 'todo', attempt = 0, updatedAt = ? WHERE taskId = ?").run(nowIso(), taskId);
    writeAudit(db, {
      actor, action: 'manual_redispatch',
      oldValue: fromStatus, newValue: why, taskId,
    });
    // 同一张卡已经有一条还没消费的派活事件时不再叠一条：连点两下按钮不该排出两趟。
    const pending = db.prepare(`SELECT eventId FROM events WHERE taskId = ?
      AND processed = 0 AND type = 'issue_assigned' LIMIT 1`).get(taskId);
    if (!pending) {
      emitEvent({
        type: 'issue_assigned', taskId, agentId: task.assignee ?? null,
        payload: { wakeReason: 'manual_redispatch', redispatch: true, reason: why, by: actor },
      });
    }
    // 泵在后台跑，不在这里等：一次重派可能要去抢 GUI、等上游服务好几分钟，
    // 让人点完按钮盯着转圈没意义 —— 卡和事件都已落库，泵还有维护心跳兜底。
    let pumped = { steps: 0, pending: pendingEvents(db), brief: null };
    if (awaitPump) {
      pumped = await pump();
    } else {
      Promise.resolve(pump()).catch(() => {});
    }
    return {
      ok: true, taskId, from: fromStatus, to: 'todo',
      interruptedRun: running?.runId ?? null, deduped: Boolean(pending), pumped,
    };
  }

  /**
   * 交审查结论。人、CEO、工程岗都走这一个入口。
   * 为什么单独成一个动作而不是「再唤醒一次」：拉模式席位（工程岗）不能被直调，
   * 它只能自己来查、自己来判。把审查做成动作，谁审都一样。
   */
  /**
   * 让「真审查人」（中层席位）自己去审一张卡（2026-11-17）。
   *
   * 为什么不能只是发个通知：拉模式席位不会被任何东西叫醒，它的「下次」可能是几小时后；
   * 而验收卡停在 in_review 时没人会再推进它。所以这里直接把它叫起来跑一趟验收会话，
   * 结论有两条合法来路：
   *   ① 会话里执行 `seat.js verdict`（走 reviewTask，已经落库）——这趟回来时卡已不在 in_review；
   *   ② 报告里给 verdict 字段 —— 由这里补调 reviewTask。
   * 两条都没有 = 它跑了一趟但没给结论：不猜、不替它判，卡留在 in_review 交给心跳兜底。
   */
  async function seatReview(task, reviewer, payload = {}) {
    const outcome = await wake(task.taskId, reviewer, 'review_requested', {
      ...payload, asReviewer: true,
    });
    if (!outcome || outcome.skipped || outcome.failed) {
      // 被闸门挡下（席位在忙 / 人在用键鼠 / 额度）不是错误：卡留在 in_review，
      // 心跳（reconcile 的补审）会再来一次，超时再转 CEO。这里只留账。
      // 2026-11-22：让路（你在用电脑等）记成 review_yielded —— 它不扣补审额度。
      const code = outcome?.code ?? outcome?.status ?? 'skipped';
      writeAudit(db, {
        actor: 'scheduler', action: isReviewYield(code) ? 'review_yielded' : 'review_deferred',
        newValue: `${task.taskId}|${reviewer}|${code}|${
          String(outcome?.reason ?? outcome?.error ?? '')}`.slice(0, 300),
        taskId: task.taskId,
      });
      return { deferred: true, reviewer, yielded: isReviewYield(code) };
    }
    const fresh = taskById(task.taskId) ?? task;
    if (fresh.status !== 'in_review') {
      // 席位在会话里已经用 verdict 把结论落了库 —— 这是首选路径，不用引擎替它判。
      writeAudit(db, {
        actor: reviewer, action: 'seat_review_settled',
        newValue: `${task.taskId}|${fresh.status}`, runId: outcome.runId, taskId: task.taskId,
      });
      return { settled: true, status: fresh.status, reviewer };
    }
    const raw = String(
      outcome.result?.verdict ?? outcome.result?.review?.verdict ?? '',
    ).trim().toLowerCase();
    if (raw !== 'pass' && raw !== 'reject') {
      // 它跑完了却没给结论：不替它判（谁审谁负责），留账让心跳补审、超时再转 CEO。
      writeAudit(db, {
        actor: reviewer, action: 'seat_review_no_verdict',
        newValue: `${task.taskId}|${String(outcome.result?.summary ?? '').slice(0, 120)}`,
        runId: outcome.runId, taskId: task.taskId,
      });
      return { pending: true, reviewer };
    }
    const reason = String(
      outcome.result?.reason ?? outcome.result?.note ?? outcome.result?.summary ?? '',
    ).trim().slice(0, 800);
    try {
      const out = reviewTask(task.taskId, { reviewer, verdict: raw, reason });
      writeAudit(db, {
        actor: reviewer, action: 'seat_review_verdict',
        newValue: `${task.taskId}|${raw}|${reason.slice(0, 120)}`,
        runId: outcome.runId, taskId: task.taskId,
      });
      return { ...out, reviewer };
    } catch (error) {
      // 状态在两条路之间被改过（比如会话里已经 verdict 了又写了报告）：以库里为准，不重复落。
      writeAudit(db, {
        actor: reviewer, action: 'seat_review_rejected_result',
        newValue: `${task.taskId}|${String(error.message ?? error).slice(0, 200)}`,
        runId: outcome.runId, taskId: task.taskId,
      });
      return { ignored: true, reviewer };
    }
  }

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
      const fin = finalizeAccepted(taskId, actor, null, { kindHint: task.repo ? 'managed-code' : null });
      if (!fin.closed) {
        return {
          taskId, status: 'in_review', verdict: 'pass',
          pendingAssetAck: true, assetOwner: fin.owner, ackTaskId: fin.ackTaskId,
        };
      }
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
    // 同理：这一趟已经被「强制重派」判死（run.interrupted），它后来的产物只留档不推进 ——
    // 否则新一趟刚开跑，旧一趟的迟到结果会把卡直接推到 in_review。
    if (outcome.runId) {
      const runRow = db.prepare('SELECT status FROM runs WHERE runId = ?').get(outcome.runId);
      if (runRow && runRow.status === 'interrupted') {
        const live = taskById(task.taskId);
        // 这一趟是被「强制重派」判死的，但会话并没人真的掐断 —— 它可能还在窗口里干，
        // 而且真干完了。旧逻辑一律把结果丢掉，于是新那一趟永远等不到自己的回执、卡挂着不动
        // （T-a4d59e96 二次事故：人看到「工程做完了」，系统还在等重派那趟）。
        // 这里改成「任务级」认领：报告合规、status=success，就是这张卡的交付。
        const adoptable = outcome.status === 'success' && live && !['done', 'cancelled'].includes(live.status);
        if (!adoptable) {
          writeAudit(db, {
            actor: agentId, action: 'run_result_after_abandon',
            newValue: `${outcome.runId}｜${String(outcome.status ?? '')}`.slice(0, 200),
            runId: outcome.runId, taskId: task.taskId,
          });
          return { dropped: true, reason: '这一趟已被判死，结果只留档不推进' };
        }
        // 认领之前先让别的会话停手：同一张卡两个会话同时往一个目录写，谁都不干净。
        const liveRuns = db.prepare("SELECT runId, agentId FROM runs WHERE taskId = ? AND status = 'running'").all(task.taskId);
        for (const other of liveRuns) {
          db.prepare("UPDATE runs SET status = 'interrupted', finishedAt = ?, interruptedReason = ? WHERE runId = ?")
            .run(nowIso(), 'adopted_by_older_run', other.runId);
          if (workDir) {
            writeStopSignal({
              workRoot: workDir, taskId: task.taskId, by: 'control-plane',
              reason: `另一趟 ${outcome.runId} 已交回合格结果，本趟不用再做`,
            });
          }
          try { releaseGuiLockForRun(other.agentId, other.runId); } catch { /* 不是 GUI 席位就没有锁 */ }
        }
        writeAudit(db, {
          actor: agentId, action: 'run_result_adopted_after_abandon',
          newValue: `${outcome.runId}｜被判死的会话交回合格结果，按任务级认领｜停掉 ${liveRuns.length} 趟`.slice(0, 300),
          runId: outcome.runId, taskId: task.taskId,
        });
        // 重派已经把卡退回 todo 了：认领时要把它接回 in_progress，否则后面对不上状态机。
        if (live.status === 'todo') transition(db, task.taskId, 'in_progress', agentId, outcome.runId);
      }
    }
    const fresh = taskById(task.taskId);
    if (!fresh || fresh.status === 'cancelled') {
      writeAudit(db, {
        actor: agentId, action: 'result_dropped_after_cancel',
        newValue: String(outcome.status ?? '').slice(0, 60), runId: outcome.runId, taskId: task.taskId,
      });
      return { dropped: true, reason: '任务已取消，结果只留档不推进' };
    }
    // 席位明确停手的分支放在下面「主动上报」之后：带 handoff=escalate 的停手要先走建处置卡，
    // 不能被这里截走只写一条等人消息（R6 回归）。
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
        // ★ 先全量校验，再动手（2026-11-18 结构性修复）
        // 一轮里既有「要派卡的任务」又有「排班建议」时，必须先把「会不会被引擎打回」全部算清：
        // 否则会出现「一半的审批单已经写进库、另一半被静默丢掉」，CEO 回话里说「已经安排好了」，
        // 而库里什么都没落地（T-51a0595b 真机事故）。校验是纯读的，错了就整轮不落任何东西，
        // 带回执重新唤醒同一个 agent —— 与「报告不合格 → 重投」同一条脾气。
        const violations = [];
        const recurringPlan = planRecurringApprovals(recList, { task, requestedBy: agentId });
        violations.push(...recurringPlan.errors);
        requested.forEach((c, i) => {
          const n = i + 1;
          const label = String(c.title ?? '无标题').slice(0, 40);
          if (c.reviewBy !== undefined && c.reviewBy !== null && String(c.reviewBy).trim()) {
            try { assertReviewSeat(c.reviewBy); } catch (error) {
              violations.push({
                code: 'review_by_invalid',
                reason: `第 ${n} 张卡（${label}）的 reviewBy=${c.reviewBy} 不可用：${error.message}`,
                hint: '派卡不必写 reviewBy：不写就按「执行人的上级」自动定审查人（代码类活会落到工程岗）；'
                  + '只有「必须董事会自己看」才写 human。',
              });
            }
          }
          if (c.handoff !== undefined && c.handoff !== null && String(c.handoff).trim()) {
            try { assertHandoff(c.handoff); } catch (error) {
              violations.push({
                code: 'handoff_invalid',
                reason: `第 ${n} 张卡（${label}）的 handoff=${c.handoff} 不合法：${error.message}`,
                hint: 'handoff 只能写 land / review / escalate，或者不写（引擎按「谁派的活」自动定）。',
              });
            }
          }
        });
        if (violations.length) {
          return feedbackRuleViolation({ task, agentId, violations, runId: outcome.runId });
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
        let projectApprovalId = null;
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
          projectApprovalId = approval.approvalId;
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
        // 建议已经在上面的预校验里全部算过（能不能建、建给谁、审的人是谁）；
        // 这里只做「写审批单」这一件有副作用的事，重复单在 plan 里已标掉。
        // 循环任务会长期反复消耗额度（GUI 席位还抢键鼠），所以必须董事会点头才真注册：
        // CEO 有「提」的权，没有「直接排」的权。
        const recurringCreated = commitRecurringApprovals(recurringPlan, { task, requestedBy: agentId }).created;
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
            // 这两个字段已在预校验阶段验过：不合法的写法会整轮回执重来，不会被静默当没写。
            reviewBy: assertReviewSeat(c.reviewBy),
            // 交付路由：CEO 可以在派活时就定死（land = 干完直接落盘、不用回来看）。
            handoff: assertHandoff(c.handoff),
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
        // ★ 零落地不许标「完成」（2026-11-18）
        // 这一轮如果既没建卡、也没出审批单，它本质上就是「回话」，不是「办完了一件事」。
        // 原来不管落没落地都走「完成：…」，于是写下「已安排好」、看板显示已完成、
        // 库里却连一条 job 都没有（T-51a0595b 真机事故）。宁可措辞保守，也不给假回执。
        const delivered = created.length + recurringCreated.length + (projectApprovalId ? 1 : 0);
        if (delivered === 0) {
          const said = String(result.answer ?? result.summary ?? '').trim();
          if (said) {
            writeAudit(db, {
              actor: 'ceo', action: 'ceo_no_delivery',
              newValue: '本轮只回话：没有新卡、没有审批单', runId: outcome.runId, taskId: task.taskId,
            });
            // 合法的产出（只是没落地）→ 把「连续不合规」计数清零，别让一次回话拖累下一单。
            if ((task.attempt ?? 0) !== 0) {
              db.prepare('UPDATE tasks SET attempt = 0, updatedAt = ? WHERE taskId = ?').run(nowIso(), task.taskId);
            }
            return closeAsReport(task, result, outcome.runId);
          }
          return feedbackRuleViolation({
            task, agentId,
            violations: [{
              code: 'empty_round',
              reason: '这一轮既没有可落地的任务，也没有审批单，而且没有给董事会的回话',
              hint: '三选一：派卡（tasks 至少一张）；提排班 / 项目建议；把话写进 summary 或 answer 直接回话。',
            }],
            runId: outcome.runId,
          });
        }
        if ((task.attempt ?? 0) !== 0) {
          db.prepare('UPDATE tasks SET attempt = 0, updatedAt = ? WHERE taskId = ?').run(nowIso(), task.taskId);
        }
        transition(db, task.taskId, 'in_review', 'ceo', outcome.runId);
        transition(db, task.taskId, 'done', 'ceo', outcome.runId);
      } else if (result.type === 'review') {
        if (result.verdict === 'pass') {
          // 验收通过只是「交付没问题」；代码卡还要等仓库主人回执才算收账。
          const fin = finalizeAccepted(task.taskId, 'ceo', outcome.runId);
          if (!fin.closed) {
            writeAudit(db, {
              actor: 'ceo', action: 'ceo_accepted_waiting_asset',
              newValue: `${task.taskId}|待 ${fin.owner} 归口回执`, runId: outcome.runId, taskId: task.taskId,
            });
          }
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

    // 席位明确停手（写了 blocked.json / 桥接判断环境不允许）：这是有效信号，不是报告格式错误。
    // 旧逻辑把它当「报告不合格」重试两次再转救火席位 —— 白烧两趟额度还换人（T-a4d59e96）。
    // 放在 handoff=escalate 之后，是为了不截走「主动上报」那条路（R6）。
    if (outcome.status === 'blocked') {
      const why = String(outcome.result?.summary ?? outcome.result?.reason ?? '席位停手但没写原因').slice(0, 300);
      if (fresh.status !== 'blocked') transition(db, task.taskId, 'blocked', agentId, outcome.runId);
      db.prepare('UPDATE tasks SET humanWait = 1, humanWaitNote = ?, humanWaitAt = ?, updatedAt = ? WHERE taskId = ?')
        .run(why, nowIso(), nowIso(), task.taskId);
      writeAudit(db, {
        actor: agentId, action: 'run_blocked_human_wait',
        newValue: why, runId: outcome.runId, taskId: task.taskId,
      });
      recordMessage(db, {
        from: agentId, kind: 'decision', taskId: task.taskId,
        title: `它停下来等人：${task.title}`,
        body: `原因：${why}\n它已经停手，不会再自己乱试；卡停在 blocked、标了「等人」，等处理完再派。`,
      });
      return { blocked: true, reason: why };
    }

    const passed = checked.ok && report.status === 'success';
    if (!passed) {
      const attempt = (task.attempt ?? 0) + 1;
      db.prepare('UPDATE tasks SET attempt = ?, updatedAt = ? WHERE taskId = ?').run(attempt, nowIso(), task.taskId);
      // 只记 status 的话，blocked 的真实原因（失焦 / 超时 / 环境不通过）就查无可查。
      const why = checked.errors.join('; ')
        || [report.status, report.reason].filter(Boolean).join('：')
        || '无原因';
      // 上一次为什么被拒，必须带回去 —— 不带原因的重试，等于让席位把同一个错再犯一遍。
      const prevReject = db.prepare(`SELECT newValue FROM audit WHERE taskId = ? AND action = 'report_rejected'
        ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(task.taskId);
      const prevWhy = prevReject?.newValue ? String(prevReject.newValue).replace(/^第 \d+ 次：/, '') : null;
      // 只有「同一轮派活里紧挨着的上一次」才算连犯。上一轮被处置卡救活后重新开跑，
      // 哪怕错的还是同一处，也必须给它一次正常重试 —— 否则一救活就立刻再上报，变成死循环。
      const prevAttemptNo = prevReject?.newValue
        ? Number(/^第 (\d+) 次：/.exec(String(prevReject.newValue))?.[1] ?? NaN) : NaN;
      const repeatSame = prevWhy !== null && prevWhy === why
        && Number.isFinite(prevAttemptNo) && prevAttemptNo === attempt - 1;
      writeAudit(db, {
        actor: agentId, action: 'report_rejected',
        newValue: `第 ${attempt} 次：${why}`, runId: outcome.runId, taskId: task.taskId,
      });
      // C2 轻量版：窗口里「说做完了」却一处产物都没落 —— 这种完成在控制面这里不成立。
      // 不读屏、不动状态机，只把它显式标出来：否则这类情况只会表现为「静默等满超时才失败」，
      // 人看到的只是一张迟迟不动的卡。
      const draftIssue = String(outcome.sessionParams?.draftIssue ?? '');
      if (attempt === 1 && (draftIssue === 'no_artifacts' || draftIssue === 'no_draft')) {
        writeAudit(db, {
          actor: agentId, action: 'claimed_done_no_artifact',
          newValue: `${outcome.runId}｜${draftIssue === 'no_artifacts' ? 'draft 说成功但 output 空' : '没有 report.draft.json'}`.slice(0, 300),
          runId: outcome.runId, taskId: task.taskId,
        });
        recordMessage(db, {
          from: 'control-plane', kind: 'notice', taskId: task.taskId,
          title: `疑似「嘴上完成」：${task.title}`,
          body: draftIssue === 'no_artifacts'
            ? '它在窗口里说做完了，但 output/ 里一个非空文件都没有 —— 要么只在对话里说了，要么产物写到别处去了。这趟不能按成功收账。'
            : '它这趟没写 report.draft.json：窗口里可能说了「已完成」，但控制面只认文件，交不上就等于没交。',
        });
      }
      if (attempt < 2 && !repeatSame) {
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId,
          payload: {
            wakeReason: 'retry',
            reviewNote: `上一趟报告被打回，原因：${why}。先把格式改对再交，别把同一处错误再犯一遍。`,
          },
          dedupeKey: `retry:${task.taskId}:${attempt}`,
        });
      } else {
        transition(db, task.taskId, 'blocked', 'control-plane', outcome.runId);
        // P4-3 / P4-5：连续两次不合格 → 先试救火席位，没配就出人审批卡（§7.4 / §7.6）。
        // 但「两趟错在同一处」不是偶发，是格式或能力问题：换个人也照样错，得让人看一眼。
        if (repeatSame) {
          recordMessage(db, {
            from: 'control-plane', kind: 'decision', taskId: task.taskId,
            title: `报告格式卡住了：${task.title}`,
            body: `同一处错误连犯两次，已停在 blocked，不再自动重试。\n原因：${why}\n`
              + '要么改席位/桥接的输出，要么点「强制重派」时把这条原因带上，别让它再撞一次。',
          });
        }
        escalateToRescue({ ...task, attempt }, repeatSame
          ? '报告两趟错在同一处（不是偶发，是格式或能力问题）'
          : '报告连续两次不合格');
      }
      return;
    }

    // 交上来的报告合格 = 「交付能力没问题」，把「连续不合格」计数清零。
    // 不在成功这里清零，这个计数就变成「累计」而不是「连续」：一次早期超时（no_draft）之后，
    // 返工时任何一次小磕碰都会直接跳到 blocked + 转救火席位（T-906d3686 事故）。
    if ((task.attempt ?? 0) !== 0) {
      db.prepare('UPDATE tasks SET attempt = 0, updatedAt = ? WHERE taskId = ?').run(nowIso(), task.taskId);
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

    // ★ 父卡等子卡：这张卡已经拆给下级了（有子卡还没收尾），现在交上来的只是「拆解方案」，
    //   不是「总任务的结果」。先挂在这里，别请发布者来验收半成品 ——
    //   否则总经理会看到一张写着「我拆了 8 张」的完成报告，而八件事一件都还没干。
    const kids = childrenOf(task.taskId);
    const openKids = kids.filter((k) => !CHILD_CLOSED.includes(k.status));
    if (kids.length && openKids.length) {
      // 挂起也要算「在手上」：拉模式席位领卡前状态还是 todo，
      // 停在 todo 会被看板当成「没人接」，也让下一轮唤醒以为卡还没开始。
      if (task.status === 'todo' || task.status === 'backlog') {
        transition(db, task.taskId, 'in_progress', agentId, outcome.runId);
      }
      const seed = {
        summary: report.summary, artifacts: report.artifacts, acceptanceResults: report.acceptanceResults,
        usage: report.usage, boardNote: report.boardNote,
      };
      db.prepare('UPDATE tasks SET waitingChildren = 1, parentReportJson = ?, updatedAt = ? WHERE taskId = ?')
        .run(JSON.stringify(seed), nowIso(), task.taskId);
      writeAudit(db, {
        actor: agentId, action: 'parent_waiting_children',
        newValue: `${kids.length} 张子卡，还有 ${openKids.length} 张没收尾：${openKids.map((k) => k.taskId).join(',')}`.slice(0, 400),
        runId: outcome.runId, taskId: task.taskId,
      });
      return { waitingChildren: true, open: openKids.length, total: kids.length };
    }

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
      const fin = finalizeAccepted(task.taskId, 'control-plane', outcome.runId, { kindHint: kind });
      if (!fin.closed) return;
      writeAudit(db, { actor: 'human', action: 'machine_acceptance', newValue: task.taskId, runId: outcome.runId });
      return;
    }
    // ③ 直接落盘：发布者（或获授权的执行者）判断「这活不需要第二个人再看」，
    //    就不叫任何人跑一轮验收（省一次按量计费的 Run）。
    if (handoff === 'land') {
      const fin = finalizeAccepted(task.taskId, 'control-plane', outcome.runId, { kindHint: kind });
      if (!fin.closed) return;
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
    // 中层的活：它是这张卡的审查人，卡就留在 in_review 等它给结论。
    // 2026-11-17 补：以前这里只写一条 review_queued 就撒手，等着它「下次被叫醒时顺手看一眼」——
    // 而它下次被叫醒可能是几小时后，中间心跳补审又把卡塞给了 CEO（中层名义上审，实际从没审过）。
    // 现在直接把验收请求发给真审查人，它立刻被叫起来审这一张。
    writeAudit(db, {
      actor: 'control-plane', action: 'review_queued',
      newValue: `${reviewer}|${kind}|${task.repo ?? '无仓库'}`, runId: outcome.runId, taskId: task.taskId,
    });
    emitEvent({
      type: 'review_requested', taskId: task.taskId, agentId: reviewer,
      payload: { wakeReason: 'review_requested', kind, asReviewer: true },
      dedupeKey: `review-seat:${task.taskId}:${outcome.runId}`,
    });
    // 循环轮次卡在「人叫才醒」的席位手上时，必须提醒董事会一句：
    // 这一轮不收账，下一轮到点就会被 overlapPolicy=skip 当成「上一轮还没完」跳掉，
    // 而循环卡本身不出声 —— 不说一句，董事会会以为它一直在正常跑。
    if (task.origin?.jobId) {
      try {
        recordMessage(db, {
          from: 'system', kind: 'notice', taskId: task.taskId, project: task.project ?? null,
          title: `等你审：${String(task.title ?? '').slice(0, 60)}`,
          body: [
            `第 ${task.origin.cycleNo ?? '?'} 轮做完了，按排班交给${cfgFor(reviewer)?.postTitle ?? reviewer}审。`,
            '它审完这一轮才收账；一直没人审的话，下一轮到点会按「上一轮还没完」跳过。',
          ].join('\n'),
        });
      } catch { /* 提醒是旁路，写不进去不影响收账 */ }
    }
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
          // 排队必须出声：拉模式席位不叫不动，静默排队等于把活扔进黑洞。
          notePullWaiting(task, seat);
          // 出声只让人「知道」，还得真把它叫起来 —— 这才叫「随时能被唤醒」。
          wakePullSeat(task, seat);
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
      // 验收事件可能被补审重发、也可能在途中换了审查人：投递地址优先，
      // 但「该由谁审」仍以库里为准（人能拍板的卡，任何 agent 都不许代审）。
      //   地址是 CEO = 兜底/补审明确交给总经理 → 就走总经理那一趟（中层超时后不再回踢给它）；
      //   地址不是 CEO → 只认真实审查人，防止事件过期把卡塞给一个不该审的人。
      const kind = inferArtifactKind(task, {}).kind;
      const reviewer = reviewerOf(task, kind);
      if (reviewer === 'human') {
        // 人审的卡已经出了「待我拍板」单：任何 agent 都不许代审。
        // 不拦这一下，人还没点，CEO 那一轮验收就把卡判过了（审批单还挂着没人收）。
        writeAudit(db, {
          actor: 'scheduler', action: 'review_skip_human',
          newValue: `${task.taskId}|审批单已出，等董事会拍板`, taskId: task.taskId,
        });
        return;
      }
      const target = ev.agentId === ceoId() ? ceoId() : reviewer;
      // 中层自己审：叫醒它、拿它的结论落库。它不再把卡转给 CEO 代审。
      if (target !== ceoId()) {
        await seatReview(task, target, payload);
        return;
      }
      const outcome = await wake(task.taskId, ceoId(), 'review_requested', payload);
      if (!outcome || outcome.skipped || outcome.failed) {
        // 验收事件是**一次性**的：泵已经把它标成 processed，这里一 return 就再也没人叫 CEO 审，
        // 卡会永远停在 in_review（T-7a284ca4：干完了、看板一直「待验收」）。
        // 所以被挡下必须出声；真正的补审交给维护心跳（reconcile 的 review_requeued），
        // 不能在这里立刻重发事件，否则同一 tick 里会自旋。
        // 让路（你在用电脑等）记 review_yielded：不扣这张卡的补审额度。
        const deferCode = outcome?.code ?? outcome?.status ?? 'skipped';
        writeAudit(db, {
          actor: 'scheduler', action: isReviewYield(deferCode) ? 'review_yielded' : 'review_deferred',
          newValue: `${task.taskId}|${deferCode}|${String(outcome?.reason ?? outcome?.error ?? '')}`.slice(0, 300),
          taskId: task.taskId,
        });
        return;
      }
      assertCeoOutput(outcome.result ?? {});
      if (outcome.result.verdict === 'pass') {
        // 验收通过才算真收账。这里原来只改了状态：卡显示「完成」，产物却一直留在任务目录里，
        // 项目记忆也没落——跟 reviewTask / 审批通过两条路不一致（真机上是「说办完了，文件没进项目」）。
        // 2026-11-18：统一过归口闸，代码卡先等仓库主人回执。
        finalizeAccepted(task.taskId, 'ceo', outcome.runId);
      } else {
        transition(db, task.taskId, 'in_progress', 'ceo', outcome.runId);
        // CEO 的打回意见绝不能丢：只说「rework」等于让人猜要改什么（T-906d3686 事故）。
        // 它要同时进三处 —— 事件（→ 提示词）、审计（→ 看板与按卡追溯）、下面 escalate 的理由。
        const rejectReason = String(
          outcome.result?.reason ?? outcome.result?.summary ?? outcome.result?.note ?? '',
        ).trim().slice(0, 800);
        // 验收打回只自动重跑一次；第二次打回留痕等人审，避免无限空转烧额度（§7.6 / P1-6）。
        const rounds = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE taskId = ? AND wakeReason = 'review_requested'")
          .get(task.taskId).n;
        if (rounds <= 1) {
          emitEvent({
            type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
            payload: { wakeReason: 'rework', reviewNote: rejectReason || null },
            dedupeKey: `review-reject:${task.taskId}:${outcome.runId}`,
          });
          writeAudit(db, {
            actor: 'ceo', action: 'review_rework',
            newValue: `${task.taskId}|${rejectReason || '(CEO 未写原因)'}`,
            runId: outcome.runId, taskId: task.taskId,
          });
        } else {
          // P4-5 升级规则：返工 2 次转救火席位（escalationTo 决定）；没配就出人审批卡。
          escalateToRescue(taskById(task.taskId), `验收连续两次打回${rejectReason ? `：${rejectReason}` : ''}`);
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
      // §7.4 阻塞上报：先沿汇报线交给「人」（上级 agent）处置，实在到顶才出人审批单。
      // 以前这里直接 requestApproval（人审）—— 结果每一张走不下去的卡都要人接手，
      // 上级形同虚设，而人又看不懂技术细节（2026-11-17 董事会反馈）。
      const task = taskById(ev.taskId);
      if (!task) return;
      const dmRaw = resolveDecisionMaker(config, task.assignee);
      const dm = dmRaw === task.assignee ? 'human' : dmRaw;
      const dmIsAgent = Boolean(dm) && dm !== 'human' && dm !== 'board' && cfgFor(dm);
      if (config.runPolicy?.escalateToBoss === true && dmIsAgent) {
        reportUpward(task, {
          reason: payload.reason ?? '执行席位报阻塞，需要你处置',
          agentId: 'control-plane',
        });
        return;
      }
      if (pendingApprovalFor(task.taskId, 'review_reject')) return;
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

  // 事件泵：默认单趟在跑（两个 pump 并发跑同一批事件会把同一张卡派两次 —— 真机上踩过）。
  // 但 2026-11-18 真机事故暴露了单趟的代价：GUI 一趟活要跑 5～20 分钟，handleEvent 里 await 着
  // adapter 不放，**整条队列就被这一张卡堵死** —— 新下单的任务连事件都排不上，看起来像宕机。
  // 现在：一趟泵占住超过 pumpUnblockMs（默认 20 秒）且外面还有排队事件、还有并发名额时，
  // 允许再开一趟。事件认领是原子的（core.markProcessed 的 WHERE processed=0），不会重复处理；
  // 单卡不并行由 wake() 的 runningSame 检查兜住。
  const activePumps = [];
  const pumpUnblockMs = () => {
    const raw = Number(process.env.AICOMPANY_PUMP_UNBLOCK_MS ?? 20_000);
    return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
  };
  // 一趟泵里单条事件最多处理多久（2026-11-20 真机事故）：
  // GUI adapter 的派发一旦挂死（窗口抢不到 / 应用不响应），handleEvent 会永远 await，
  // pumpOnce 就永远不返回 → activePumps 里那一条永远不摘 → 后面所有事件（审批返工、手动重派）
  // 全部排着没人处理，看板点「通过」像什么都没发生。
  // 超时只放弃「等这一条」，不杀 run：run 仍由证据看门狗按无回执/无进度收账。
  // 默认 3 分钟：证据看门狗本身就在 2 分钟左右判「没送到」，泵没必要比它更能忍。
  // 卡死的派发放掉之后，run 照样由看门狗收账；正常的长活（webhook 轮询）也只会等 3 分钟就放泵，
  // 后面的卡不会陪着一起排队。
  const pumpEventTimeoutMs = () => {
    const raw = Number(process.env.AICOMPANY_PUMP_EVENT_TIMEOUT_MS ?? 3 * 60_000);
    return Number.isFinite(raw) && raw > 0 ? raw : 3 * 60_000;
  };
  const pumpStaleMs = () => {
    const raw = Number(process.env.AICOMPANY_PUMP_STALE_MS ?? (pumpEventTimeoutMs() + 60_000));
    return Number.isFinite(raw) && raw > 0 ? raw : pumpEventTimeoutMs() + 60_000;
  };

  async function pumpOnce() {
    let steps = 0;
    while (steps < maxSteps) {
      const ev = nextEvent(db);
      if (!ev) break;
      // 认领失败 = 别的泵已经拿走这条事件，跳过（绝不重复处理）。
      if (!markProcessed(db, ev.eventId)) continue;
      steps += 1;
      const timeoutMs = pumpEventTimeoutMs();
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref?.();
      });
      try {
        const outcome = await Promise.race([handleEvent(ev), timeout]);
        if (outcome === TIMED_OUT) {
          // 事件已经认领过，不会再被重放；这里只保证「泵能继续走下一张卡」。
          writeAudit(db, {
            actor: 'control-plane', action: 'pump_event_timeout',
            newValue: `${ev.type}|${ev.taskId ?? '-'}|等 ${Math.round(timeoutMs / 1000)}s 未返回，先放泵（run 交给证据看门狗收账）`,
          });
        }
      } catch (error) {
        // 一个坏事件不能拖死整条队列： pump() 的调用方很多是 .catch(() => {})（后台触发），
        // 异常一旦从 pumpOnce 逃出去，泵就没人再拉，后面的事件永远排队（T-af72158d 事故）。
        // 这里记审计后继续消化队列，让「哪一步坏了」留痕可查。
        writeAudit(db, {
          actor: 'control-plane', action: 'pump_step_failed',
          newValue: `${ev.type}|${ev.taskId ?? '-'}|${String(error.message ?? error).slice(0, 300)}`,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const brief = maybeBrief();
    return { steps, pending: pendingEvents(db), brief };
  }

  async function pump() {
    const nowMs = clock().getTime();
    // 僵尸泵清理：某条 entry 超过 stale 阈值还没返回，就当它已经挂死，先摘掉再判断。
    // 不摘的话，newest 永远是它，pump() 就一直返回那个 never 的 promise —— 点按钮也像没反应。
    for (let i = activePumps.length - 1; i >= 0; i -= 1) {
      const staleFor = nowMs - activePumps[i].startedAt;
      if (staleFor > pumpStaleMs()) {
        const victim = activePumps.splice(i, 1)[0];
        writeAudit(db, {
          actor: 'control-plane', action: 'pump_stale_released',
          newValue: `一趟泵 ${Math.round(staleFor / 1000)}s 未返回，已从并发里摘掉（事件认领是原子的，不会重复派）`,
        });
      }
    }
    const newest = activePumps[activePumps.length - 1];
    if (newest) {
      const age = nowMs - newest.startedAt;
      const pending = pendingEvents(db);
      const running = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n;
      const maxConcurrent = config.runPolicy?.maxConcurrent ?? DEFAULTS.maxConcurrent;
      // 扇出条件：手上这趟泵被慢活占住 + 外面还有事件排队 + 并发名额没用满。
      // 只放行到这个上限，不会因为扇出把 maxConcurrent 冲爆。
      const canFanout = pending > 0 && age >= pumpUnblockMs() && running < maxConcurrent
        && activePumps.length < maxConcurrent;
      if (!canFanout) return newest.promise;
      writeAudit(db, {
        actor: 'control-plane', action: 'pump_fanout',
        newValue: `已有 ${activePumps.length} 趟泵在跑（最老 ${Math.round(age / 1000)}s），`
          + `外面还排着 ${pending} 条事件，再开一趟免得全公司等一张卡`,
      });
    }
    const entry = { startedAt: nowMs, promise: null };
    const run = pumpOnce();
    entry.promise = run;
    activePumps.push(entry);
    // 收尾时把自己摘掉；失败也摘（错误交给真正的调用方去记）。
    run.then(
      () => { const i = activePumps.indexOf(entry); if (i >= 0) activePumps.splice(i, 1); },
      () => { const i = activePumps.indexOf(entry); if (i >= 0) activePumps.splice(i, 1); },
    );
    return run;
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
  // 重启后收尸：进程没了，库里还挂着 status='running' 的 run 就是死的。
  // 不清掉会一直占着两个地方：runPolicy.maxConcurrent 的并发名额、以及「这台席位正忙」的判断，
  // 结果就是重启后新的卡一直不派、看板显示「干活中」但什么都没动。
  // 只改 run 的账，不动任务卡状态（卡该怎么等还是怎么等，交给 reconcile 去补投）。
  //
  // GUI 锁必须一起放：文件锁按 runId 记 owner，还带 30 分钟 stale 保护。
  // 进程已经死了，锁却还写着「被 R-xxx 占用」—— 重启之后新卡全被 env_check 拦下（20:50 真机踩到）。
  function releaseGuiLockForRun(agentId, runId) {
    const lockPath = cfgFor(agentId)?.adapter?.config?.lockPath;
    if (!lockPath || !runId) return false;
    try {
      const lock = createGuiLock({ lockPath, now: nowIso });
      const holder = lock.isHeld();
      if (holder && holder !== runId) return false; // 是别人的锁，不许越权
      lock.release(runId);
      return true;
    } catch { return false; }
  }

  // 「锁的主人不在了」也要放：重启时先把跑着的 run 收尸（上一段），但有些锁是**更早一次重启**
  // 留下的 —— 那时 run 已经被判成 interrupted，这一次启动扫不到 running，锁就跟着留了下来。
  // 不改的话，锁要等 30 分钟 stale 才自愈，中间派什么都被 env_check 拦住。
  function releaseStaleGuiLocks() {
    const released = [];
    for (const agent of config.agents) {
      const lockPath = agent.adapter?.config?.lockPath;
      if (!lockPath) continue;
      try {
        const lock = createGuiLock({ lockPath, now: nowIso });
        const holder = lock.isHeld();
        if (!holder) continue;
        const row = db.prepare('SELECT status, taskId FROM runs WHERE runId = ?').get(holder);
        if (row && row.status === 'running') continue; // 真在跑，不许动
        lock.release(holder);
        writeAudit(db, {
          actor: 'control-plane', action: 'gui_lock_released_stale',
          newValue: `${holder}|${agent.id}|那一趟已经不在跑了，锁却还挂着`,
          taskId: row?.taskId ?? null,
        });
        released.push({ agentId: agent.id, holder });
      } catch { /* 锁文件坏了不阻断启动：下次 acquire 会自己接管 */ }
    }
    return released;
  }

  function recoverOrphanRuns() {
    const rows = db.prepare("SELECT runId, taskId, agentId, startedAt FROM runs WHERE status = 'running'").all();
    for (const row of rows) {
      db.prepare("UPDATE runs SET status = 'interrupted', finishedAt = ? WHERE runId = ?").run(nowIso(), row.runId);
      writeAudit(db, {
        actor: 'control-plane', action: 'run_orphaned',
        newValue: `${row.runId}|${row.agentId ?? '?'}|重启时仍在 running（起于 ${row.startedAt ?? '?'}），按中断收账`,
        taskId: row.taskId,
      });
      if (releaseGuiLockForRun(row.agentId, row.runId)) {
        writeAudit(db, {
          actor: 'control-plane', action: 'gui_lock_released_orphan',
          newValue: `${row.runId}|${row.agentId}|锁跟着死掉的 Run 一起放掉，否则重启后谁都派不出去`,
          taskId: row.taskId,
        });
      }
    }
    releaseStaleGuiLocks();
    return rows.length;
  }

  /**
   * 证据看门狗（2026-11-18，L1/L2/L3 三步合一的机械兜底）。
   *
   * 解决的老毛病：run 只要在表里写着 running，引擎就一律当「在干活」。
   * 于是「提示词粘歪了 / 窗口没激活 / agent 卡在自我确认」全都能伪装成干活，
   * 直到 2 小时的僵死收尸才发现 —— 这中间没有任何人会收到消息。
   *
   * 现在的判定链（不看 agent 说了什么，只看盘上留下了什么）：
  *   L0 没证据 → 派出去 ackTimeoutSec 还没 dispatch.json → 判「没启动」→ 中断重派；
  *   L1 已启动 → 有 dispatch.json / 心跳（只代表进程/窗口起来了，**不代表 agent 开工**）；
  *   L2 在动   → ack / progress / output 产物 / 草稿 任一有新鲜 mtime；
  *   L3 已交活 → completion.json / report.draft.json 本轮已写。
   *
   * 2026-11-19 补一条（B1）：**心跳还在就不重派**。心跳只证明「这一趟还在 adapter 的轮询里」，
   * 不证明「agent 在写盘」，所以它只用来推迟重派、不抬证据等级；但也不能无限续命 ——
   * 席位自己承诺的 maxMinutes 到了再宽限一会儿仍无产出，就直接收掉并向上收束。
   *
   * 缺证据不判死，只做两件事：先探一次盘（探到就继续等），探不到就重派一次；
   * 重派次数用尽 → 走 reportUpward 开处置卡交给上级 agent（L3），不许停在这儿等人。
   */
  function evidenceWatch({ limit = 20 } = {}) {
    if (config.runPolicy?.evidenceEnabled !== true) {
      return { checked: 0, redispatched: 0, escalated: 0 };
    }
    const ackMs = Math.max(1000, Number(config.runPolicy?.ackTimeoutSec ?? DEFAULTS.ackTimeoutSec) * 1000);
    const idleMs = Math.max(1000, Number(config.runPolicy?.idleTimeoutSec ?? DEFAULTS.idleTimeoutSec) * 1000);
    const maxAttempts = Math.max(1, Number(config.runPolicy?.maxDispatchAttempts ?? DEFAULTS.maxDispatchAttempts));
    // 心跳续命的两个参数（2026-11-19，见下面 B1 段的真机误伤说明）。
    const heartbeatGraceMs = Math.max(30_000, Number(config.runPolicy?.heartbeatGraceSec ?? DEFAULTS.heartbeatGraceSec) * 1000);
    const budgetSlackMs = Math.max(0, Number(config.runPolicy?.seatBudgetSlackSec ?? DEFAULTS.seatBudgetSlackSec) * 1000);
    // 席位自己承诺的最长跑法（gui-template 的 maxMinutes）。有它才谈得上「超预算」；
    // 没配的席位（cli / http）没有这个承诺，就只按心跳判。
    const seatBudgetMs = (agentId) => {
      const minutes = Number(cfgFor(agentId)?.adapter?.config?.maxMinutes);
      return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
    };
    const rows = db.prepare(`SELECT runId, taskId, agentId, wakeReason, startedAt, evidenceLevel
      FROM runs WHERE status = 'running'`).all();
    let checked = 0;
    let redispatched = 0;
    let escalated = 0;

    const attemptsOf = (taskId) => db.prepare(`SELECT COUNT(*) AS n FROM audit
      WHERE taskId = ? AND action IN ('redispatch_no_dispatch','redispatch_no_evidence')`).get(taskId).n;

    const persist = (run, probe) => {
      const nowTxt = clockIso();
      if (probe.dispatch.confirmed) {
        db.prepare('UPDATE runs SET dispatchConfirmedAt = COALESCE(dispatchConfirmedAt, ?) WHERE runId = ?')
          .run(probe.dispatch.at ?? nowTxt, run.runId);
      }
      if (probe.ackAt) {
        db.prepare('UPDATE runs SET ackAt = COALESCE(ackAt, ?) WHERE runId = ?').run(probe.ackAt, run.runId);
      }
      if (probe.activityAt) {
        db.prepare('UPDATE runs SET lastActivityAt = ? WHERE runId = ?').run(probe.activityAt, run.runId);
      }
      db.prepare('UPDATE runs SET evidenceLevel = ?, evidenceKinds = ? WHERE runId = ?')
        .run(probe.level, JSON.stringify(probe.kinds), run.runId);
    };

    const interrupt = (task, run, reason, action) => {
      const changed = db.prepare(`UPDATE runs SET status = 'interrupted', finishedAt = ?, interruptedReason = ?
        WHERE runId = ? AND status = 'running'`).run(clockIso(), String(reason).slice(0, 300), run.runId);
      if (!Number(changed.changes ?? 0)) return false;
      if (releaseGuiLockForRun(run.agentId, run.runId)) {
        writeAudit(db, { actor: 'control-plane', action: 'gui_lock_released', newValue: run.runId, taskId: task.taskId, runId: run.runId });
      }
      writeAudit(db, {
        actor: 'control-plane', action,
        newValue: `${run.runId}|${run.agentId}|${String(reason).slice(0, 400)}`,
        taskId: task.taskId, runId: run.runId,
      });
      return true;
    };

    const requeue = (task, run, reason, opts = {}) => {
      const attempt = attemptsOf(task.taskId);
      // maxDispatchAttempts 的口径是「一共派几次（含首次）」，不是「重派几次」。
      // attempt 记的是已经重派过几次：首次失败 attempt=0 → 还能再派一次；再失败 attempt=1 → 用尽。
      // 「再派一次也一样」时也能直接跳升级：心跳在、但席位已经跑穿了自己的预算。
      const exhausted = opts.escalate === true || (attempt + 1 >= maxAttempts);
      if (exhausted) {
        // L3：自动手段用尽 → 先把这趟假跑的 run 收掉（否则它会一直占并发、并让卡看起来「在干活」），
        // 再向上收束，带证据包，让上级 agent 决定代验收还是打回。
        // 这一步以前漏了中断：第三趟没起来的 run 会一直挂着 running，直到 2 小时僵死收尸。
        interrupt(task, run, reason, opts.action ?? 'run_interrupted_by_evidence');
        if (!hasOpenEscalationCard(task.taskId)) {
          const summary = [
            `【证据】level=${opts.level ?? 0} kinds=${(opts.kinds ?? []).join(',') || '(无)'}`,
            `【判断】${String(reason).slice(0, 500)}`,
            opts.evidence ? `【现场】${String(opts.evidence).slice(0, 500)}` : null,
          ].filter(Boolean).join('\n');
          // 执行卡：置为 blocked（等上级处置）再开处置卡。保持 todo 的话，常规补投每分钟会再派一次，
          // 等于「边等上级、边继续烧额度」。验收卡不能置 blocked：验收动作只认 in_review。
          let waiting = task;
          if (task.status !== 'in_review'
            && (task.status === 'todo' || task.status === 'in_progress')) {
            db.prepare(`UPDATE tasks SET status = 'blocked', updatedAt = ?
              WHERE taskId = ? AND status IN ('todo','in_progress')`)
              .run(clockIso(), task.taskId);
            writeAudit(db, {
              actor: 'control-plane', action: 'blocked_by_evidence',
              oldValue: task.status, newValue: 'blocked', taskId: task.taskId, runId: run.runId,
            });
            waiting = taskById(task.taskId) ?? task;
          }
          const up = reportUpward(waiting, {
            reason: `证据看门狗：重派 ${attempt} 次仍无有效证据（${String(reason).slice(0, 240)}）`,
            agentId: 'control-plane', runId: run.runId,
            report: { summary, artifacts: [] },
          });
          writeAudit(db, {
            actor: 'control-plane', action: 'evidence_escalated',
            newValue: `${task.taskId}|第 ${attempt + 1} 次派单用尽|${up?.to ?? 'human'}`, taskId: task.taskId, runId: run.runId,
          });
        }
        return true;
      }
      // 卡还在跑（库里 running）→ 先中断这一趟，再把卡送回待派状态；否则 wake 会被并发上限挡住。
      interrupt(task, run, reason, opts.action ?? 'run_interrupted_by_evidence');
      if (task.status === 'in_review') {
        const expect = reviewerOf(task, null);
        if (!expect || expect === 'human') {
          reportUpward(task, { reason: `验收 run 无证据可看：${reason}`, agentId: 'control-plane', runId: run.runId });
          return false;
        }
        emitEvent({
          type: 'review_requested', taskId: task.taskId, agentId: expect,
          payload: { wakeReason: 'review_requested', via: 'evidence-watchdog' },
          dedupeKey: `evidence-review:${task.taskId}:${run.runId}`,
        });
      } else {
        // 走和「人工强制重派」同一条写路径：in_progress → todo 不是合法的用户态跳转，
        // 但引擎自己有资格把「已被判死的那一趟」撤掉、把卡放回待派队列。
        if (task.status === 'in_progress') {
          db.prepare("UPDATE tasks SET status = 'todo', attempt = 0, updatedAt = ? WHERE taskId = ?")
            .run(clockIso(), task.taskId);
          writeAudit(db, {
            actor: 'control-plane', action: 'requeue_by_evidence',
            oldValue: task.status, newValue: 'todo', taskId: task.taskId, runId: run.runId,
          });
        }
        emitEvent({
          type: 'issue_assigned', taskId: task.taskId, agentId: task.assignee,
          payload: { wakeReason: 'redispatch', evidenceReason: String(reason).slice(0, 300), attempt: attempt + 1 },
          dedupeKey: `evidence-requeue:${task.taskId}:${run.runId}`,
        });
      }
      writeAudit(db, {
        actor: 'control-plane', action: opts.auditAction ?? 'redispatch_no_evidence',
        newValue: `${task.taskId}|第 ${attempt + 1} 次派单|${String(reason).slice(0, 360)}`,
        taskId: task.taskId, runId: run.runId,
      });
      return true;
    };

    for (const run of rows) {
      if (redispatched >= limit) break;
      const task = taskById(run.taskId);
      if (!task) continue;
      // 拉模式席位（人自己来领 / 桥接客户端来 checkout）没有「引擎启动回执」这回事：
      // 它领走之前本来就不会有 dispatch.json，拿启动超时去杀它等于把 pull 席位全判死。
      if (cfgFor(run.agentId)?.dispatch === 'pull') continue;
      // 不看板上的卡：已 done/cancelled 的 run 由收尸逻辑处理。
      if (['done', 'cancelled'].includes(task.status)) continue;
      checked += 1;
      const probe = probeRun({
        workRoot: workDir, taskId: run.taskId, run, now: clock,
        // 产物可能写在项目交付目录（落盘改造后的默认），只盯任务目录 output/ 会看不见它在干活。
        extraDirs: [projectWriteDirOf(config, task).dir].filter(Boolean),
      });
      persist(run, probe);
      const ageMs = clock().getTime() - Date.parse(run.startedAt ?? clockIso());

      // A）连启动都没确认：这不是「干得慢」，是「进程根本没起来」。
      if (!probe.dispatch.confirmed && ageMs > ackMs) {
        const ok = requeue(task, run, `派出去 ${Math.round(ageMs / 1000)} 秒仍无启动回执（dispatch.json 不存在，进程没起来）`, {
          action: 'run_interrupted_no_dispatch',
          auditAction: 'redispatch_no_dispatch',
          level: probe.level,
          kinds: probe.kinds,
          evidence: `machineAt=${probe.machineAt ?? '(无)'} activityAt=${probe.activityAt ?? '(无)'}`,
        });
        if (ok) redispatched += 1;
        continue;
      }
      if (!probe.dispatch.confirmed) continue;

      // B）起来了（dispatch.json / 心跳有），但多久都看不到 agent 侧的任何痕迹。
      //    耐心的口径（2026-11-19 二次修正）：**不再按「有没有 ack」减半**。
      //    真机：GUI 席位的 agent 常整趟不写 ack.md；再叠加 idleTimeoutSec 减半 → 7.5 分钟就掀翻，
      //    而它接的实际是一小时的活，七八分钟可能才把文件读完。接入的模型/工具/运营商各不相同，
      //    慢是常态不是故障 —— 拿「没回执」当「不干活」，等于用最不靠谱的信号做最贵的决定（重派 = 同一件活干两遍）。
      //    所以耐心按「座位自己承诺的预算」给：有预算的席位给到预算的一半（最多 2×idle），没预算的退回 idle。
      const budgetMs = seatBudgetMs(run.agentId);
      const patienceMs = budgetMs
        ? Math.max(idleMs, Math.min(budgetMs / 2, idleMs * 2))
        : idleMs;
      const lastAgentMs = probe.activityAt ? Date.parse(probe.activityAt) : null;
      const quietMs = lastAgentMs == null ? ageMs : clock().getTime() - lastAgentMs;
      if (quietMs > patienceMs) {
        // B1）心跳还在 → 这一趟仍在 adapter 的轮询里，窗口还开着，只是还没写盘。
        //   2026-11-19 真机误伤（T-6493fc51）：执行席位这趟 dispatch✓ heartbeat✓，7.9 分钟没写 progress，
        //   被按「无 ack 耐心减半 = 7.5 分钟」砍掉；重派的那一趟 3 分钟就干完了 —— 说明第一趟本来就在干，
        //   我们只是看不到它在写什么。看门狗比干活的人还不耐烦，根因在这儿。
        //   所以只要心跳新鲜就继续等：心跳只证明「机器还在跑这一趟」，不证明「agent 在产出」，
        //   因此它只用来**推迟重派**，不给它抬证据等级（level 仍是 1）。
        // 判活体只认心跳：dispatch.json 是「送出去那一下」的回执，不是持续心跳。
        const hbMs = probe.heartbeatAt ? Date.parse(probe.heartbeatAt) : null;
        const hbFresh = hbMs != null && (clock().getTime() - hbMs) <= heartbeatGraceMs;
        const overBudget = budgetMs != null && ageMs > budgetMs + budgetSlackMs;
        // P1（2026-11-23）：心跳只证明「适配器还在轮询」。产出心跳（run-progress.json）
        // 只在本轮产物真的增长时才更新，它过期 = 这一趟可能没在长东西（在长考，或在等人）。
        // 两个阈值都默认 0 = 关闭，老配置行为不变。
        const pbMs = probe.progressBeatAt ? Date.parse(probe.progressBeatAt) : null;
        const noProgressMs = pbMs == null ? ageMs : clock().getTime() - pbMs;
        const alertMin = Number(config.runPolicy?.noProgressAlertMinutes ?? 0);
        const stopMin = Number(config.runPolicy?.noProgressStopMinutes ?? 0);

        if (hbFresh && !overBudget) {
          // P1-5（2026-11-23）：心跳在、产出心跳过期 —— 分两档处理，不把「长考」当「等人」误杀。
          //   ① 过 alert 线：报一次董事会（不改状态、不打断）；
          //   ② 过 stop 线：判「疑似中途等人」，收掉这一趟、把卡挂起并置 humanWait，不再耗到 60 分钟。
          if (alertMin > 0 && noProgressMs > alertMin * 60_000) {
            const alerted = db.prepare(`SELECT 1 AS x FROM audit
              WHERE runId = ? AND action = 'no_progress_alert' LIMIT 1`).get(run.runId);
            if (!alerted) {
              writeAudit(db, {
                actor: 'control-plane', action: 'no_progress_alert',
                newValue: `${run.runId}|心跳在，但 ${Math.round(noProgressMs / 60_000)} 分钟没有新产物（可能长考，也可能在等人）`,
                taskId: task.taskId, runId: run.runId,
              });
              notifier.send({
                title: `这趟很久没产出：${task.taskId}`,
                body: `心跳还在，但任务目录 ${Math.round(noProgressMs / 60_000)} 分钟没有新文件。`
                  + '可能它还在长考，也可能在会话里等人回答。先不动它，只是让你知道。',
                scene: 'decision', taskId: task.taskId,
              });
            }
          }
          if (stopMin > 0 && noProgressMs > stopMin * 60_000
            && (task.status === 'todo' || task.status === 'in_progress')) {
            const stopped = interrupt(task, run,
              `心跳在，但 ${Math.round(noProgressMs / 60_000)} 分钟零产出，判疑似中途等人`,
              'run_interrupted_no_progress');
            if (stopped) {
              db.prepare(`UPDATE tasks SET status = 'blocked', humanWait = 1, humanWaitNote = ?, humanWaitAt = ?, updatedAt = ?
                WHERE taskId = ? AND status IN ('todo','in_progress')`).run(
                `心跳在但 ${Math.round(noProgressMs / 60_000)} 分钟零产出，系统判为「等人配合」并停手`,
                clockIso(), clockIso(), task.taskId,
              );
              writeAudit(db, {
                actor: 'control-plane', action: 'no_progress_human_wait',
                newValue: `${task.taskId}|${run.runId}|停手，置等人配合，等董事会一句话再放行`,
                taskId: task.taskId, runId: run.runId,
              });
              recordMessage(db, {
                from: run.agentId, kind: 'decision', taskId: task.taskId,
                project: task.project ?? null,
                title: `它停下来等人：${task.title}`,
                body: [
                  `${speakerLabel(config, run.agentId)} 已经 ${Math.round(noProgressMs / 60_000)} 分钟没有任何产出，`
                    + '心跳还在，判断是在会话里等人回答（不是在干活）。',
                  '我已经替你把这趟停手、把卡挂起，不再空耗到 60 分钟超时。',
                  '你看一眼它的窗口（任务目录 screenshots/ 里有截图），把要它做的事写进答复，再点重派，它就会带着答复继续。',
                ].join('\n'),
              });
              continue;
            }
          }
          // 每分钟写一条会把审计刷满；每一趟只记一次「看见了，所以没动手」，事后能答「为什么它没被砍」。
          const seen = db.prepare(`SELECT 1 AS x FROM audit
            WHERE runId = ? AND action = 'stall_wait_heartbeat' LIMIT 1`).get(run.runId);
          if (!seen) {
            writeAudit(db, {
              actor: 'control-plane', action: 'stall_wait_heartbeat',
              newValue: `${run.runId}|安静 ${Math.round(quietMs / 60000)} 分钟，但心跳在（${
                Math.round((clock().getTime() - hbMs) / 1000)} 秒前）→ 不重派`,
              taskId: task.taskId, runId: run.runId,
            });
          }
          continue;
        }

        if (hbFresh && overBudget) {
          // 心跳在、席位承诺的 maxMinutes 都过了还是一个字没产出：这不是「慢」，是这趟失控了。
          // 重派只会再失控一次，所以直接收掉，向汇报线上的上级收束（L3 同一出口）。
          const ok = requeue(task, run,
            `席位已跑超自身预算 ${Math.round(budgetMs / 60000)} 分钟（+${Math.round(budgetSlackMs / 60000)} 分钟宽限）仍无任何产出，心跳尚在但已不可能是正常慢`,
            {
              escalate: true,
              level: probe.level,
              kinds: probe.kinds,
              evidence: `ageMin=${Math.round(ageMs / 60000)} budgetMin=${Math.round(budgetMs / 60000)} heartbeatAgeSec=${Math.round((clock().getTime() - hbMs) / 1000)}`,
            });
          if (ok) escalated += 1;
          continue;
        }

        // B2）心跳也没有了（adapter 死了 / 这一趟根本没在轮询）→ 老逻辑：探不到证据就重派。
        const ok = requeue(task, run, `进程已起来但 ${Math.round(quietMs / 60000)} 分钟没有任何产出痕迹（ack=${probe.ackAt ?? '无'}，level=${probe.level}，心跳=${hbMs ? '有但不新鲜' : '无'}）`, {
          auditAction: 'redispatch_no_evidence',
          level: probe.level,
          kinds: probe.kinds,
          evidence: `machineAt=${probe.machineAt ?? '(无)'} deliverable=${probe.deliverable.kind ?? '(无)'}`,
        });
        if (ok) redispatched += 1;
      }
    }
    if (redispatched > 0) {
      writeAudit(db, { actor: 'control-plane', action: 'evidence_watch', newValue: `checked=${checked} redispatched=${redispatched}` });
    }
    return { checked, redispatched, escalated };
  }

  // P1-3（2026-11-23）：每趟 run 落一条结构化记录，出问题不用再翻五个文件拼时间线。
  // 只回填最近几趟已结束的；已写过就跳过（幂等），绝不碰正在跑的 run。
  function writeRunRecords({ limit = 10 } = {}) {
    const rows = db.prepare(`SELECT runId, taskId, agentId, wakeReason, status, revision, quotaUnits,
      startedAt, finishedAt, dispatchConfirmedAt, ackAt, lastActivityAt, evidenceLevel,
      evidenceKinds, interruptedReason
      FROM runs WHERE status != 'running' ORDER BY COALESCE(finishedAt, startedAt) DESC LIMIT ${Number(limit)}`).all();
    const dir = path.join(workDir, 'runs');
    let wrote = 0;
    for (const r of rows) {
      const file = path.join(dir, `${r.runId}.json`);
      if (fs.existsSync(file)) continue;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const durationSec = r.startedAt && r.finishedAt
          ? Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) : null;
        let kinds = [];
        try { kinds = JSON.parse(r.evidenceKinds ?? '[]'); } catch { kinds = []; }
        fs.writeFileSync(file, `${JSON.stringify({ ...r, evidenceKinds: kinds, durationSec, writtenAt: clockIso() }, null, 2)}\n`, 'utf8');
        wrote += 1;
      } catch { /* 记录失败不影响引擎 */ }
    }
    return wrote;
  }

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
      // 父卡还有子卡没收尾：它现在的职责是「等子卡回来」，不是重新开跑。
      // 2026-11-17 真机：父卡派完子卡、交活没成功（报告被判退）→ 卡回 todo →
      // 补投又把它叫起来 → 它照着原指令再拆一遍，子卡越派越多、活没人收。
      // 这里顺手把它正式置为「等子卡」，等最后一张收尾时 settleParent 才会拼总汇报。
      const openKids = childrenOf(row.taskId).filter((k) => !CHILD_CLOSED.includes(k.status));
      if (openKids.length) {
        const marked = db.prepare('UPDATE tasks SET waitingChildren = 1, updatedAt = ? WHERE taskId = ? AND waitingChildren = 0')
          .run(nowIso(), row.taskId);
        if (Number(marked.changes ?? 0)) {
          writeAudit(db, {
            actor: 'scheduler', action: 'parent_marked_waiting',
            newValue: `还有 ${openKids.length} 张子卡没收尾，父卡改为等子卡（不再重投）`, taskId: row.taskId,
          });
        }
        waiting += 1;
        continue;
      }
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
    // ① 僵死 run 收尸：进程被 kill / 卡在适配器里，表里还挂着 running 的 run 会同时做三件坏事 ——
    //    占全局并发名额、让同一张卡的重投与验收全部「让路」、看板显示「干活中」但其实没人干活。
    //    超过 runPolicy.maxRunHours（默认 2h）的一律按中断收账。真在跑的长任务不会超过这个上限。
    const maxRunHours = config.runPolicy?.maxRunHours ?? DEFAULTS.maxRunHours;
    const runCutoff = clock().getTime() - maxRunHours * 3600 * 1000;
    let recoveredRuns = 0;
    for (const r of db.prepare("SELECT runId, taskId, agentId, startedAt FROM runs WHERE status = 'running'").all()) {
      if (Date.parse(r.startedAt) > runCutoff) continue;
      db.prepare("UPDATE runs SET status = 'interrupted', finishedAt = ? WHERE runId = ?").run(clockIso(), r.runId);
      writeAudit(db, {
        actor: 'control-plane', action: 'run_timeout',
        newValue: `${r.runId}|${r.agentId ?? '?'}|running 超过 ${maxRunHours}h（起于 ${r.startedAt ?? '?'}），按中断收账`,
        taskId: r.taskId,
      });
      recoveredRuns += 1;
    }
    // ①b 证据看门狗：先按「盘上证据」判断 run 是真跑还是假跑，再走 ② 的补审 / ③ 的状态看门狗。
    //    放在这里是因为它要赶在补审之前把假跑的 run 收掉，否则「有 run 在跑」会一直让补审让路。
    const evidence = evidenceWatch({ limit });
    // P1-3：顺手把最近几趟已结束的 run 落成 run.json（幂等，几毫秒）。
    writeRunRecords({ limit: 10 });
    // ② 验收补审：in_review 但既没 Run 在跑、也没有排队中的验收事件 —— 说明那次 review_requested
    //    被吞掉了（并发让路 / 适配器失败 / 进程重启）。事件是一次性的，不补就永远停在「待验收」。
    //    60 秒一次心跳补，按分钟去重；补满 5 次仍走不完就停下来交给董事会，别再自动烧 CEO 额度。
    let reviewRequeued = 0;
    const reviewMs = Math.max(30_000, olderThanMs);
    // 补审该发给「真审查人」，不是一律发给 CEO（2026-11-17）。
    //   原来的写法让中层的验收职责形同虚设：子卡交活 60 秒后，本该工程岗审的活就摆到了 CEO 面前，
    //   工程岗既没被叫醒也没机会审，CEO 的额度却被代审吃掉。
    //   新规矩：人审 → 不补（审批单已经出了）；中层 → 先叫它，等 seatReviewFallbackMinutes 还不审才转 CEO；
    //   CEO → 照旧。0 = 不等待，立即归 CEO（保持老配置语义）。
    const seatFallbackMs = Number(config.runPolicy?.seatReviewFallbackMinutes ?? 0) * 60 * 1000;
    for (const row of db.prepare("SELECT taskId, updatedAt FROM tasks WHERE status = 'in_review'").all()) {
      if (Date.parse(row.updatedAt) > clock().getTime() - reviewMs) continue;
      const busy = db.prepare("SELECT 1 AS n FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1").get(row.taskId);
      if (busy) continue;
      const queued = db.prepare(`SELECT 1 AS n FROM events
        WHERE taskId = ? AND processed = 0 AND type = 'review_requested' LIMIT 1`).get(row.taskId);
      if (queued) continue;
      const reviewTaskRow = taskById(row.taskId);
      if (!reviewTaskRow) continue;
      // P0-1（2026-11-23）：等归口回执 / 等人配合，是「有正当理由不动」，不是验收事件被吞。
      // 真机事故：父卡验收 pass 后在等归口，补审循环把它当成「没人审」反复补，5 次后停手，
      // 白烧了 4 次验收 run（每次 3～4 分钟），卡却一步没动。
      if (String(reviewTaskRow.assetAck ?? '') === 'pending') continue;
      if (Number(reviewTaskRow.humanWait ?? 0) === 1) continue;
      // 这张卡的验收已经交给上级处置（证据层升级卡在跑）：不要再自动补审。
      // 否则「上级在审」和「引擎每 5 分钟再派一次验收」会同时发生，额度白烧、结论还可能打架。
      if (hasOpenEscalationCard(row.taskId)) continue;
      const reviewKind = inferArtifactKind(reviewTaskRow, {}).kind;
      const expect = reviewerOf(reviewTaskRow, reviewKind);
      // 人审：审批单已经在看板上等人了，agent 不许替人拍板。
      if (expect === 'human') continue;
      const waitingMs = clock().getTime() - Date.parse(row.updatedAt);
      let target = expect;
      let fallbackNote = null;
      if (expect !== ceoId()) {
        if (!(seatFallbackMs > 0) || waitingMs > seatFallbackMs) {
          target = ceoId();
          fallbackNote = `${expect}|待验收 ${Math.round(waitingMs / 60_000)} 分钟仍未审，转总经理兜底`;
        }
      }
      // 补审额度只算「真失败」：被你正在用电脑让路（review_yielded）的不算。
      // 2026-11-22 董事会定规矩 —— 人一忙，5 次很快烧光，卡就永久停在待验收。
      const requeuedN = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_requeued'")
        .get(row.taskId).n;
      const yieldedN = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'review_yielded'")
        .get(row.taskId).n;
      const attempts = Math.max(0, requeuedN - yieldedN);
      if (attempts >= 5) {
        // 2026-11-22 真机事故：这里原本是「attempts === 5 时记一条」，但那只是计数，
        // 下个 60 秒心跳 attempts 依然是 5 → 每分钟又记一条 review_stuck + 又转一次 CEO，
        // 一张卡两天刷了 1600 多条审计、一直在刷 updatedAt。现在按「是否已经记过」去重：
        // 只要卡上已经有 review_stuck，就彻底静默，等董事会手工处理（或调 review-retry）。
        const alreadyStuck = db.prepare(
          "SELECT 1 AS n FROM audit WHERE taskId = ? AND action = 'review_stuck' LIMIT 1",
        ).get(row.taskId);
        if (!alreadyStuck) {
          writeAudit(db, {
            actor: 'control-plane', action: 'review_stuck',
            newValue: `补审 ${attempts} 次仍停在待验收（当前该由 ${target} 审；另有 ${yieldedN} 次因让路未计额度），`
              + '已停止自动补审，请董事会手工处理',
            taskId: row.taskId,
          });
          notifier.send({
            title: `这张卡验收走不完：${row.taskId}`,
            body: `自动补了 ${attempts} 次验收都没走完（该由 ${cfgFor(target)?.postTitle ?? target} 审）。已停止自动补审，`
              + '请你看一眼它到底做完了没，手工验收或打回。',
            scene: 'decision', taskId: row.taskId,
          });
        }
        continue;
      }
      // 第二道兜底：就算额度还没用完，等得实在太久了（默认 12 小时）也要有人知道 ——
      // 只让路不失败的话额度永远用不完，卡就能无声地等下去。
      const escalateMin = Number(config.runPolicy?.reviewEscalateMinutes ?? 0);
      if (escalateMin > 0 && waitingMs > escalateMin * 60_000) {
        const told = db.prepare(
          "SELECT 1 AS n FROM audit WHERE taskId = ? AND action = 'review_escalated' LIMIT 1",
        ).get(row.taskId);
        if (!told) {
          writeAudit(db, {
            actor: 'control-plane', action: 'review_escalated',
            newValue: `待验收已 ${Math.round(waitingMs / 60_000)} 分钟（让路 ${yieldedN} 次、真失败 ${attempts} 次），`
              + `已报董事会；自动补审继续，该由 ${target} 审`,
            taskId: row.taskId,
          });
          notifier.send({
            title: `这张卡挂了很久没人审：${row.taskId}`,
            body: `等了 ${Math.round(waitingMs / 60_000)} 分钟还在待验收（让路 ${yieldedN} 次多是你正在用电脑，`
              + `真失败 ${attempts} 次）。自动补审我没停，但它一直没走完，你看一眼。`,
            scene: 'decision', taskId: row.taskId,
          });
        }
      }
      // 席位不是人喊就到的：叫它一次别每分钟刷一遍（被挡下也只是白记一条账）。
      const bucketMs = target === ceoId() ? 60_000 : 5 * 60_000;
      const minuteBucket = Math.floor(clock().getTime() / bucketMs);
      emitEvent({
        type: 'review_requested', taskId: row.taskId, agentId: target,
        payload: { wakeReason: 'review_requested', kind: reviewKind, via: 'reconcile' },
        dedupeKey: `review-requeue:${row.taskId}:${target}:${minuteBucket}`,
      });
      writeAudit(db, {
        actor: 'scheduler', action: 'review_requeued',
        newValue: `第 ${attempts + 1} 次补审：发给 ${target}（该审的人 ${expect}${
          yieldedN ? `；让路 ${yieldedN} 次未计额度` : ''}）`, taskId: row.taskId,
      });
      // 只有真的补审了才记「为什么转给 CEO」—— 之前写在判断分支里，卡住以后每分钟都记一条。
      if (fallbackNote) {
        writeAudit(db, {
          actor: 'scheduler', action: 'review_fallback_ceo',
          newValue: fallbackNote, taskId: row.taskId,
        });
      }
      reviewRequeued += 1;
      if (reviewRequeued >= limit) break;
    }
    // ★ 派了子卡却守在会话里等（2026-11-17 真机父子互卡）。
    //   事件泵是一趟一趟串行跑的：一次 GUI 会话在跑的时候，别的席位的唤醒事件只能排队。
    //   于是「父卡派完子卡留在会话里等下级接单」必然等不到 —— 它等的正是被它自己挡住的那条队列。
    //   真机结局：等了 6 分钟，自己判定「叫不起来」，把子卡取消、改自己干。
    //   制度层面已经把「派完即交活」写死了（org-chart），这一条是机械兜底：规矩被无视时引擎自己动手 ——
    //   父卡有未收尾子卡、却还占着一趟 run 超过 parentWaitMinutes，就把那趟 run 按中断收账，
    //   并把父卡正式置为「等子卡」（waitingChildren=1），子卡随后就能被补投唤醒。
    const parentWaitMinutes = Number(config.runPolicy?.parentWaitMinutes ?? 0);
    let parentWaitCut = 0;
    if (parentWaitMinutes > 0) {
      const parentCutoff = clock().getTime() - parentWaitMinutes * 60 * 1000;
      for (const row of db.prepare(`SELECT taskId, updatedAt FROM tasks
        WHERE status IN ('todo','in_progress') AND waitingChildren = 0`).all()) {
        const kids = childrenOf(row.taskId).filter((k) => !CHILD_CLOSED.includes(k.status));
        if (!kids.length) continue;
        const run = db.prepare("SELECT runId, agentId, startedAt FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1")
          .get(row.taskId);
        if (!run) continue;
        if (Date.parse(run.startedAt) > parentCutoff) continue;
        const ranMin = Math.floor((clock().getTime() - Date.parse(run.startedAt)) / 60_000);
        db.prepare("UPDATE runs SET status = 'interrupted', finishedAt = ? WHERE runId = ?").run(clockIso(), run.runId);
        releaseGuiLockForRun(run.agentId, run.runId);
        db.prepare('UPDATE tasks SET waitingChildren = 1, updatedAt = ? WHERE taskId = ? AND waitingChildren = 0')
          .run(nowIso(), row.taskId);
        writeAudit(db, {
          actor: 'control-plane', action: 'parent_wait_cut',
          newValue: `${run.runId}|${run.agentId}|派了 ${kids.length} 张子卡却还占着会话 ${ranMin} 分钟，`
            + '按中断收账并置为「等子卡」；子卡现在才排得上队',
          taskId: row.taskId,
        });
        parentWaitCut += 1;
      }
    }
    // ③ 卡住看门狗（董事会 2026-11-17：卡长时间停在同一状态，必须有跳出机制）。
    //    为什么放在心跳里：它不需要谁记得点按钮。每分钟扫一遍，停久了就自己往上推。
    //    · blocked / awaiting_decision：正常重投路径根本不管这两种状态（它们本就不是「该派」的卡），
    //      所以只有这里会把它们捞出来 —— 没有待处置的卡、也没待批单，就向上汇报。
    //    · todo / in_progress：常规补投一分钟一次已经在推；这里只在「叫过 ≥3 次仍没动」时升级，
    //      避免和常规补投互相打架（以前两条路同时补投，等于一分钟叫它三次）。
    //    · 有人在跑 / 依赖没满足 / 已有处置卡 / 已经报过 → 跳过，不刷噪音。
    const stuckMinutes = Number(config.runPolicy?.stuckMinutes ?? 0);
    const stuckMs = stuckMinutes * 60 * 1000;
    let stuckRequeued = 0;
    let stuckEscalated = 0;
    const stuckRows = stuckMinutes > 0 ? db.prepare(`SELECT taskId, status, updatedAt, assignee FROM tasks
      WHERE status IN ('todo','in_progress','blocked','awaiting_decision')`).all() : [];
    for (const row of stuckRows) {
      if (Date.parse(row.updatedAt) > clock().getTime() - stuckMs) continue;
      const stuckTask = taskById(row.taskId);
      if (!stuckTask) continue;
      // P0-2（2026-11-23）：等人配合的卡是「按规矩停着」，不是卡住，别每分钟往上汇报一遍。
      // 解除方式：看板点重派 / 人给答复后派发时自动清零（见 markHumanWait 与派发路径）。
      if (Number(stuckTask.humanWait ?? 0) === 1) continue;
      const busy = db.prepare("SELECT 1 AS n FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1").get(row.taskId);
      if (busy) continue;
      const alreadyEscalated = db.prepare("SELECT 1 AS n FROM audit WHERE taskId = ? AND action = 'stuck_escalated'").get(row.taskId);
      if (alreadyEscalated) continue;
      if (row.status === 'blocked' || row.status === 'awaiting_decision') {
        if (hasOpenEscalationCard(row.taskId) || pendingApprovalFor(row.taskId, 'review_reject')) continue;
        reportUpward(stuckTask, { reason: `停在 ${row.status} 超过 ${stuckMinutes} 分钟没有任何动静` });
        writeAudit(db, {
          actor: 'scheduler', action: 'stuck_escalated',
          oldValue: row.status, newValue: `${stuckMinutes} 分钟无进展，已向上汇报`, taskId: row.taskId,
        });
        stuckEscalated += 1;
        if (stuckEscalated >= limit) break;
        continue;
      }
      if (unmetDependencies(row.taskId).length) continue;
      if (cfgFor(row.assignee)?.dispatch === 'pull') continue;
      const pendingIssue = db.prepare(`SELECT 1 AS n FROM events
        WHERE taskId = ? AND processed = 0 AND type = 'issue_assigned' LIMIT 1`).get(row.taskId);
      if (pendingIssue) continue;
      // 已经被叫过几次还不动（wake 审计按卡计），说明不是「没叫醒」而是「叫不醒」。
      const tries = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE taskId = ? AND action = 'wake'")
        .get(row.taskId).n;
      if (tries < 3) continue;
      reportUpward(stuckTask, { reason: `叫过 ${tries} 次仍停在 ${row.status}（${stuckMinutes} 分钟阈值）` });
      writeAudit(db, {
        actor: 'scheduler', action: 'stuck_escalated',
        oldValue: row.status, newValue: `${tries} 次唤醒无效，已向上汇报`, taskId: row.taskId,
      });
      stuckEscalated += 1;
      if (stuckEscalated >= limit) break;
    }
    // 主动唤醒的兜底：排队那一刻叫过一次但没叫醒（凭据还没刷新 / 会话宿主重启 /
    // 引擎重启丢了排队定时器）的卡，靠心跳周期补叫。冷却在 wakePullSeat 里面。
    // 唤醒成功（wake_sent）也照补：人被叫起来 ≠ 活被领走，躺过冷却期还没人领就再叫一声。
    let wakes = 0;
    if (config.wake?.enabled !== false) {
      const pullCards = rows.filter((row) => cfgFor(row.assignee)?.dispatch === 'pull'
        && !unmetDependencies(row).length
        && !db.prepare("SELECT 1 AS n FROM runs WHERE taskId = ? AND status = 'running' LIMIT 1").get(row.taskId));
      for (const row of pullCards) {
        const last = db.prepare(`SELECT createdAt FROM audit
          WHERE taskId = ? AND action IN ('wake_sent','wake_queued','wake_failed')
          ORDER BY rowid DESC LIMIT 1`).get(row.taskId);
        if (last && Date.now() - Date.parse(last.createdAt)
          < Number(config.wake?.cooldownMs ?? 10 * 60 * 1000)) continue;
        const task = taskById(row.taskId);
        if (!task) continue;
        wakePullSeat(task, row.assignee);
        wakes += 1;
      }
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
// P7-5：顺手补落盘 —— 被占用进程挡住、或上次落盘失败的卡，在这里重试。
    const deliveries = retryPendingDeliveries();
    return {
      scanned: rows.length, requeued, waiting, wakes, deliveries, releasedDeps,
      recoveredRuns, reviewRequeued, stuckRequeued, stuckEscalated, parentWaitCut,
      evidenceChecked: evidence.checked, evidenceRedispatched: evidence.redispatched,
      ...pumped,
    };
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
    // 看板/CLI：卡停住了，人要能立刻让它再跑一趟（不是只有等补偿扫描）。
    redispatchTask,
    // 看板/CLI：验收补满 5 次被判「卡住」之后，人看一眼确认该由谁审，手动再发一次验收。
    retryReview,
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
    recoverOrphanRuns,
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
    // 董事会消息箱：agent 对人说的话（完成 / 卡住 / 等拍板 / 回话）。
    getMessages: (opts = {}) => listMessages(db, opts),
    unreadMessages: () => unreadMessageCount(db),
    markMessagesRead: (opts = {}) => markReadInDb(db, opts),
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


