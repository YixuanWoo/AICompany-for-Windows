// 证据层（2026-11-18）：回答一个引擎一直答不出的问题 ——
// 「这趟 run 到底是真在干活，还是只是挂着 running？」
//
// 设计原则（董事会拍板）：
//   ① 证据必须分级，引擎只认级、不认话；缺证据不判死，只减耐心、加怀疑。
//   ② 「已启动」这一级必须靠系统观测（dispatch.json 由 adapter 在进程/窗口真的起来之后写）；
//      它只证明「席位被拉起来了」，**不证明 agent 收到任务或开工**（CLI 可能卡在授权轮询）。
//      不能只靠 agent 自报 —— 否则它一句「收到了」就能骗过引擎。
//   ③ agent 自报（ack / progress）只作强化证据；模型漂移没写，机制照样成立。
//   ④ 全部是本地文件观测：零 token、零额度、零模型调用。
//
// 证据文件（都在任务目录 workRoot/tasks/<taskId>/ 下，按 runId 归属，避免上一轮的残留）：
//   dispatch.json        adapter 写完「已启动」才写：{runId, at, via, windowTitle}
//   run-heartbeat.json   adapter 轮询期间的心跳：{runId, at, polls}（证明机器还活着，不是 agent 产出）
//   ack.md / ack.json    agent 的收到回执：收到｜预计 N 分钟｜我的理解：…
//   progress.json        agent 覆盖写的进度
//   report.draft.json    聊天型席位的极简报告
//   completion.json      正式完成报告
//   output/**            产物文件（按 mtime 判断本轮有没有产出）

import fs from 'node:fs';
import path from 'node:path';

export const EVIDENCE_FILES = Object.freeze({
  dispatch: 'dispatch.json',
  heartbeat: 'run-heartbeat.json',
  // 2026-11-23（P1）：产出心跳。只在「任务目录真的长了东西」时才更新。
  // run-heartbeat 只能证明适配器还在轮询，证明不了 agent 在产出；这个文件才是判活的第二只眼。
  progressBeat: 'run-progress.json',
  ack: 'ack.md',
  ackJson: 'ack.json',
  progress: 'progress.json',
  draft: 'report.draft.json',
  completion: 'completion.json',
});

export const EVIDENCE_LEVEL = Object.freeze({
  NONE: 0,        // 只有引擎自己的账
  DISPATCHED: 1,  // 席位已启动（进程/窗口起来了）；不等于 agent 开工，更不等于交付
  ACTIVE: 2,      // 有 agent 产出痕迹（ack / progress / 产物）
  DELIVERED: 3,   // 有可验收的交付物
});

export function taskDirOf(workRoot, taskId) {
  return path.join(workRoot, 'tasks', String(taskId));
}

// 停手信号（2026-11-23，E 组）：人按下取消 / 强制重派时，光把库里的 run 判成 interrupted 没用 ——
// 会话还活着（CLI 是子进程，GUI 是人的窗口），它会继续往任务目录里写东西，
// 而它交回的结果又因为「这一趟已判死」被丢掉（T-a4d59e96 二次事故）。
// 所以控制面落一个 stop.json，适配器每轮轮询看一眼，看到就立刻停手。
export const STOP_FILE = 'stop.json';

export function writeStopSignal({ workRoot, taskId, reason = '任务已停止', by = 'control-plane' }) {
  const dir = taskDirOf(workRoot, taskId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, STOP_FILE), JSON.stringify({ reason, by, at: new Date().toISOString() }, null, 2));
  } catch { /* 写不进去不致命：适配器还有超时兜底 */ }
}

// since 传本轮开工时刻：更早的 stop.json 是上一轮残留，不能拿来误杀这一轮。
export function readStopSignal({ workRoot, taskId, since = null }) {
  const file = path.join(taskDirOf(workRoot, taskId), STOP_FILE);
  const st = statIf(file);
  if (!st || st.size === 0) return null;
  if (since != null && st.mtimeMs < since) return null;
  const data = readJson(file) ?? {};
  return { ...data, atMs: st.mtimeMs };
}

export function clearStopSignal({ workRoot, taskId }) {
  try { fs.unlinkSync(path.join(taskDirOf(workRoot, taskId), STOP_FILE)); } catch { /* 没有就算了 */ }
}

function statIf(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

// 只认本轮写的东西：mtime 早于本趟 run 开始的一律当上一轮残留（T-906d3686 那类事故的通用防线）。
function freshSince(ms, sinceMs) {
  return ms != null && (sinceMs == null || ms >= sinceMs);
}

function readAck(dir, sinceMs) {
  const jsonFile = path.join(dir, EVIDENCE_FILES.ackJson);
  const st = statIf(jsonFile);
  if (st && freshSince(st.mtimeMs, sinceMs)) {
    const data = readJson(jsonFile);
    if (data) return { at: iso(st.mtimeMs), source: 'ack.json', etaMinutes: data.etaMinutes ?? null, understanding: data.understanding ?? null };
  }
  const mdFile = path.join(dir, EVIDENCE_FILES.ack);
  const md = statIf(mdFile);
  if (md && freshSince(md.mtimeMs, sinceMs)) {
    let line = '';
    try { line = String(fs.readFileSync(mdFile, 'utf8')).split('\n').find((x) => x.includes('｜')) ?? ''; } catch { /* 读不到就当没有 */ }
    const parts = line.split('｜').map((x) => x.trim());
    // 预置模板没改过（eta 还是 ?）不算回执：否则「模板自动生成」会让每张卡都白拿满份耐心。
    if (!line || line.includes('预计 ?') || line.includes('：?')) return null;
    const etaRaw = parts.find((x) => x.includes('预计'));
    const eta = etaRaw ? Number((etaRaw.match(/(\d+)/) ?? [])[1]) : null;
    return { at: iso(md.mtimeMs), source: 'ack.md', etaMinutes: Number.isFinite(eta) ? eta : null, understanding: line.slice(0, 120) };
  }
  return null;
}

// 扫一个目录里最新的文件 mtime。cap 防呆：项目交付目录偶尔很大（大量文件），
// 每次 reconcile 都全量 stat 会把控制面拖慢，扫到上限就停（早停也够判「有没有在写」）。
function newestArtifactAt(outputDir, sinceMs, cap = 3000) {
  const root = statIf(outputDir);
  if (!root?.isDirectory()) return null;
  let newest = null;
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 4 || seen >= cap) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (seen >= cap) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!entry.isFile()) continue;
      seen += 1;
      const st = statIf(abs);
      if (!st || st.size === 0) continue;
      if (!freshSince(st.mtimeMs, sinceMs)) continue;
      if (newest == null || st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(outputDir, 0);
  return newest;
}

/**
 * 探测一趟 run 的证据。纯读盘，不写库、不发事件。
 *
 * @returns {{
 *   level: number, kinds: string[],
 *   dispatch: {confirmed: boolean, at: string|null, via: string|null},
 *   ackAt: string|null, ack: object|null,
 *   activityAt: string|null,      // agent 侧的产出痕迹（ack / progress / 产物 / 草稿）
 *   machineAt: string|null,       // 机器侧心跳或启动时间（只作审计展示）
 *   deliverable: {present: boolean, kind: string|null, at: string|null},
 *   startedAt: string|null
 * }}
 * extraDirs: 额外要盯的产出目录（绝对路径）。2026-11-24 补：落盘改造后产物被要求直接写进
 *            项目目录，只盯任务目录 output/ 会让「真在干活」完全看不见 → 必被误判成空转。
 */
export function probeRun({ workRoot, taskId, run, now = () => new Date(), extraDirs = [] }) {
  const dir = taskDirOf(workRoot, taskId);
  const startedMs = run?.startedAt ? Date.parse(run.startedAt) : null;
  const runId = run?.runId ?? null;

  const dispatchRaw = readJson(path.join(dir, EVIDENCE_FILES.dispatch));
  const dispatchOk = Boolean(dispatchRaw && (!runId || dispatchRaw.runId === runId));
  const dispatchAt = dispatchOk ? (dispatchRaw.at ?? iso(statIf(path.join(dir, EVIDENCE_FILES.dispatch))?.mtimeMs)) : null;

  const hbRaw = readJson(path.join(dir, EVIDENCE_FILES.heartbeat));
  const hbOk = Boolean(hbRaw && (!runId || hbRaw.runId === runId));
  const hbAt = hbOk ? (hbRaw.at ?? null) : null;

  // 产出心跳（2026-11-23）：只在本轮产物真的增长时写；按 runId 归属，上一轮的文件不续命。
  const pbRaw = readJson(path.join(dir, EVIDENCE_FILES.progressBeat));
  const pbOk = Boolean(pbRaw && (!runId || pbRaw.runId === runId));
  const pbAt = pbOk ? (pbRaw.at ?? null) : null;

  const ack = readAck(dir, startedMs);
  const progressSt = statIf(path.join(dir, EVIDENCE_FILES.progress));
  const progressAt = progressSt && freshSince(progressSt.mtimeMs, startedMs) ? iso(progressSt.mtimeMs) : null;
  const artifactMs = newestArtifactAt(path.join(dir, 'output'), startedMs);
  // 项目目录里的产物：CLI 席位按提示词直接写这里，output/ 常常是空的。
  const extraArtifactMs = (Array.isArray(extraDirs) ? extraDirs : [])
    .filter((d) => typeof d === 'string' && d)
    .map((d) => newestArtifactAt(d, startedMs))
    .filter((x) => x != null);
  const projectArtifactMs = extraArtifactMs.length ? Math.max(...extraArtifactMs) : null;

  const draftSt = statIf(path.join(dir, EVIDENCE_FILES.draft));
  const completionSt = statIf(path.join(dir, EVIDENCE_FILES.completion));
  const draftFresh = draftSt && freshSince(draftSt.mtimeMs, startedMs);
  const completionFresh = completionSt && freshSince(completionSt.mtimeMs, startedMs);

  const activityCandidates = [
    ack?.at ? Date.parse(ack.at) : null,
    progressAt ? Date.parse(progressAt) : null,
    artifactMs,
    projectArtifactMs,
    draftFresh ? draftSt.mtimeMs : null,
  ].filter((x) => Number.isFinite(x));
  const activityMs = activityCandidates.length ? Math.max(...activityCandidates) : null;

  const kinds = [];
  if (dispatchOk) kinds.push('dispatch');
  if (hbOk) kinds.push('heartbeat');
  if (pbOk) kinds.push('progress-beat');
  if (ack) kinds.push('ack');
  if (progressAt) kinds.push('progress');
  if (artifactMs != null) kinds.push('artifact');
  if (projectArtifactMs != null) kinds.push('artifact-project');
  if (draftFresh) kinds.push('draft');
  if (completionFresh) kinds.push('completion');

  const deliverable = completionFresh
    ? { present: true, kind: 'completion', at: iso(completionSt.mtimeMs) }
    : (draftFresh ? { present: true, kind: 'draft', at: iso(draftSt.mtimeMs) } : { present: false, kind: null, at: null });

  let level = EVIDENCE_LEVEL.NONE;
  if (dispatchOk || hbOk) level = EVIDENCE_LEVEL.DISPATCHED;
  if (activityMs != null) level = EVIDENCE_LEVEL.ACTIVE;
  if (deliverable.present) level = EVIDENCE_LEVEL.DELIVERED;

  return {
    level,
    kinds,
    dispatch: { confirmed: dispatchOk, at: dispatchAt, via: dispatchRaw?.via ?? null },
    ackAt: ack?.at ?? null,
    ack,
    activityAt: iso(activityMs),
    // 心跳（活体）和启动回执必须分开：dispatch 是一次性事件，十分钟前启动过不能证明「现在还在轮询」。
    // machineAt 只作审计展示（老语义：心跳优先、退回启动时间）；判活体一律用 heartbeatAt。
    machineAt: hbAt ?? dispatchAt,
    heartbeatAt: hbAt,
    // 产出心跳：证明「这一趟真的在长东西」。心跳新鲜但它过期 = 适配器还在转、agent 可能在等人或空转。
    progressBeatAt: pbAt,
    deliverable,
    startedAt: run?.startedAt ?? null,
    probedAt: now().toISOString(),
  };
}

// ---- 写侧：adapter 在「真的送出去了」那一刻调用 ----

export function writeDispatchReceipt({ workRoot, taskId, runId, agentId = null, via = 'unknown', windowTitle = null, at = null }) {
  const dir = taskDirOf(workRoot, taskId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, EVIDENCE_FILES.dispatch), `${JSON.stringify({
      runId, taskId, agent: agentId, via, windowTitle, at: at ?? new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

export function writeRunHeartbeat({ workRoot, taskId, runId, polls = null, note = null, at = null }) {
  const dir = taskDirOf(workRoot, taskId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, EVIDENCE_FILES.heartbeat), `${JSON.stringify({
      runId, taskId, polls, note, at: at ?? new Date().toISOString(),
    })}\n`, 'utf8');
    return true;
  } catch { return false; }
}

// 2026-11-23（P1）：产出心跳。调用方只在「产物 digest 变了」时调用；
// 无条件每轮调用它就退化成一个 ping，又会把空转伪装成干活。
export function writeRunProgress({ workRoot, taskId, runId, polls = null, digest = null, at = null }) {
  const dir = taskDirOf(workRoot, taskId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, EVIDENCE_FILES.progressBeat), `${JSON.stringify({
      runId, taskId, polls, digest, at: at ?? new Date().toISOString(),
    })}\n`, 'utf8');
    return true;
  } catch { return false; }
}

// 派单时预置一张回执模板：agent 只需要改一行文本，不用记 schema。
// 故意不写死「必须填」：agent 漂移没改，引擎照样靠外部观测判，不判死。
export function ensureAckTemplate({ workRoot, taskId, runId, agentId = null }) {
  const dir = taskDirOf(workRoot, taskId);
  const file = path.join(dir, EVIDENCE_FILES.ack);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) return false;
    fs.writeFileSync(file, [
      `# 收到回执（run ${runId}）`,
      `# 请把下面这一行改成你的回执，保留竖线分隔；不写不会被判失败，但引擎对你的耐心会减半。`,
      `收到｜预计 ? 分钟｜我的理解：?`,
      '',
    ].join('\n'), 'utf8');
    return true;
  } catch { return false; }
}
