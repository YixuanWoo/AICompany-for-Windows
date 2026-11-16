// 每份 schema 的 3 个正例 + 3 个反例。测试直接引用本文件（任务书 §12 P0 / §15.1）。
// 反例的 reason 是元数据，不参与校验，只说明「为什么必须被拒」。

const T = '2026-11-15T06:00:00.000Z';

const baseTask = {
  schema: 'aicompany.task/v1',
  taskId: 'T-20261115-0001',
  requestId: 'REQ-20261115-0001',
  parentTaskId: null,
  title: '把第 3 章译稿转成 16:9 分镜表',
  role: 'batch-render',
  revision: 1,
  mode: 'direct',
  addressedTo: 'exec-batch-01',
  cc: ['ceo'],
  assignedBy: 'human',
  threadId: null,
  assignee: 'exec-batch-01',
  reportsTo: 'tech-lead',
  status: 'todo',
  priority: 'normal',
  createdAt: T,
  lease: null,
  budget: { maxRuns: 3, maxMinutes: 30, quotaUnits: 1 },
  input: { workDir: 'work/tasks/T-20261115-0001/input', files: ['chapter3.md'] },
  instructions: '严格按 brief.md 的 5 步执行。',
  acceptance: ['output/分镜表.md 存在且非空'],
  completionReportPath: 'output/completion.json',
  retry: { attempt: 0, max: 2, backoffSec: 30 },
  tags: ['批量'],
  origin: null,
};
const { taskId: _omitTaskId, ...taskWithoutId } = baseTask;

const baseProgress = {
  schema: 'aicompany.progress/v1',
  taskId: 'T-1', runId: 'R-1', percent: 60,
  text: '已完成 30/50 条', updatedAt: T,
};
const { runId: _omitRunId, ...progressWithoutRunId } = baseProgress;

const baseCompletion = {
  schema: 'aicompany.completion/v1',
  taskId: 'T-1', runId: 'R-1', agent: 'exec-batch-01', revision: 1,
  status: 'success', summary: '已生成分镜表，共 50 镜',
  artifacts: ['output/分镜表.md'],
  checksum: { 'output/分镜表.md': 'sha256:abc' },
  acceptanceResults: [{ rule: 'output/分镜表.md 存在且非空', pass: true }],
  usage: { elapsedSec: 412, quotaUnits: 1 },
  finishedAt: T,
};
const { checksum: _omitChecksum, ...completionWithoutChecksum } = baseCompletion;

const baseRecurring = {
  schema: 'aicompany.recurring/v1',
  jobId: 'JOB-cleanup-weekly', jobVersion: 3, title: '每周清理候选文件扫描',
  kind: 'cleanup', owner: 'ceo', assignee: 'ops-01', reportsTo: 'ceo', status: 'active',
  trigger: { type: 'cron', rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=3;BYMINUTE=0', timezone: 'Asia/Shanghai', eventTrigger: null },
  misfirePolicy: 'run_once', misfireGraceMin: 720, overlapPolicy: 'skip', concurrencyKey: 'JOB-cleanup-weekly',
  termination: { validUntil: null, maxCycles: null, pauseOnConsecutiveFailures: 3, budgetTotal: { quotaUnits: 2000 } },
  budgetPerCycle: { maxRuns: 2, maxMinutes: 20, quotaUnits: 1 },
  retention: { keepCycles: 52, keepTranscripts: false },
  review: { everyNCycles: 12, reviewer: 'ceo', requiresHumanApproval: true },
  requiresHumanEachCycle: true,
  taskTemplate: {
    role: 'ops-maintenance',
    instructions: '只读扫描白名单目录，输出候选清单 JSON；不得移动或删除任何文件。',
    acceptance: ['output/candidates.json 存在且非空', '报告中每个路径都在 whitelist 内'],
    completionReportPath: 'output/completion.json',
  },
  carryOver: { enabled: true, maxItems: 20, injectField: 'input.previousFindings' },
  dedupeWindowMin: 60, lastCycleNo: 41, nextFireAt: '2026-11-21T19:00:00.000Z',
};

const baseCycleSummary = {
  schema: 'aicompany.cycle-summary/v1',
  jobId: 'JOB-cleanup-weekly', jobVersion: 3, cycleNo: 42,
  periodStart: '2026-11-15T19:00:00.000Z', periodEnd: '2026-11-21T19:00:00.000Z',
  taskId: 'T-20261122-0031', status: 'done',
  metrics: { scannedFiles: 1842, candidates: 37, deletedCount: 0, durationSec: 96, quotaUnits: 1 },
  deltaVsPrev: { candidates: -8, scannedFiles: 23 },
  findings: [{ id: 'F-0117', text: '缓存目录三个月未动', state: 'pending_human', ageCycles: 2 }],
  carryOver: [{ id: 'F-0117', text: '连续 2 轮未处理', ageCycles: 2 }],
  derivedTasks: ['T-20261122-0032'],
  humanDecision: 'approved_scan_only',
  runIds: ['RUN-20261122-0088'],
  transcriptPath: 'runs/RUN-20261122-0088.ndjson',
};
const { jobId: _omitJobId, ...cycleWithoutJobId } = baseCycleSummary;

const baseChangeRequest = {
  schema: 'aicompany.change-request/v1',
  changeRequestId: 'CR-20261115-0003', taskId: 'T-1', runId: 'R-1',
  agentId: 'exec-batch-01', reportsTo: 'tech-lead', revision: 1,
  kind: 'direction', severity: 'needsDecision',
  reason: 'brief 要求英式术语，但 glossary 是美式；继续做会整批返工',
  evidence: ['input/glossary.md:12', 'output/分镜表.md:3'],
  doneSoFar: { artifacts: ['output/分镜表.md'], percent: 40 },
  suggestedOptions: [{ id: 'A', text: '按美式术语续做', cost: 'low' }],
  requestedDecisionBy: 'tech-lead',
  createdAt: T,
};
const { changeRequestId: _omitCrId, ...crWithoutId } = baseChangeRequest;

const baseDecision = {
  schema: 'aicompany.decision/v1',
  changeRequestId: 'CR-20261115-0003', taskId: 'T-1',
  decidedBy: 'tech-lead', decision: 'resume', chosenOption: 'A',
  newInstructions: null, newAcceptance: null,
  needsHumanApproval: false, approvalId: null,
  reason: '只续做，不动目标与验收条件', createdAt: T,
};

const baseThread = {
  schema: 'aicompany.thread/v1',
  threadId: 'TH-20261115-0001', mode: 'cowork', title: '第 3 章译稿 · 术语来回',
  sourceTaskId: null, participants: ['you', 'exec-batch-01'],
  wakePolicy: 'onMessage', ceoVisibility: 'none',
  sharedFiles: ['output/chapter3-zh.md', 'input/glossary.md'],
  ttlDays: 30, state: 'active', createdAt: T,
  lastActiveAt: '2026-11-15T07:42:00.000Z', archivedAt: null, promotedTo: null,
};

export const fixtures = {
  'task': {
    valid: [
      baseTask,
      { ...baseTask, taskId: 'T-2', mode: 'delegate', addressedTo: null, cc: [], assignedBy: 'ceo', status: 'backlog' },
      { ...baseTask, taskId: 'T-3', status: 'awaiting_decision', revision: 2, cc: [], origin: { jobId: 'JOB-1', cycleNo: 2 } },
    ],
    invalid: [
      { data: taskWithoutId, reason: '缺必填 taskId' },
      { data: { ...baseTask, mode: 'direct', addressedTo: null, cc: ['exec-batch-01'] }, reason: '把 cc 当成 addressedTo 用' },
      { data: { ...baseTask, status: 'finished' }, reason: '状态不在封闭枚举里' },
    ],
  },
  'progress': {
    valid: [
      baseProgress,
      { ...baseProgress, percent: 0, text: '' },
      { ...baseProgress, percent: 100, text: '全部完成', updatedAt: '2026-11-15T07:00:00.000Z' },
    ],
    invalid: [
      { data: { ...baseProgress, percent: 150 }, reason: 'percent 越界' },
      { data: progressWithoutRunId, reason: '缺必填 runId' },
      { data: { ...baseProgress, schema: 'aicompany.progress/v2' }, reason: 'schema 标识不匹配' },
    ],
  },
  'completion': {
    valid: [
      baseCompletion,
      { ...baseCompletion, status: 'failed', reason: '窗口焦点被抢', summary: '执行失败' },
      { ...baseCompletion, status: 'blocked', revision: 2, artifacts: [] },
    ],
    invalid: [
      { data: { ...baseCompletion, status: 'cancelled' }, reason: 'cancelled 是任务状态，不是报告值' },
      { data: completionWithoutChecksum, reason: '缺必填 checksum' },
      { data: { ...baseCompletion, status: 'failed' }, reason: 'failed 没带 reason' },
    ],
  },
  'recurring': {
    valid: [
      baseRecurring,
      { ...baseRecurring, jobId: 'JOB-brief-daily', kind: 'brief', title: '每日晨报', taskTemplate: { ...baseRecurring.taskTemplate, instructions: '汇总昨日状态与阻塞' } },
      { ...baseRecurring, jobId: 'JOB-inspection', kind: 'inspection', trigger: { type: 'event', rrule: null, timezone: 'Asia/Shanghai', eventTrigger: 'disk_usage > 85%' }, termination: { ...baseRecurring.termination, maxCycles: 10 } },
    ],
    invalid: [
      { data: { ...baseRecurring, requiresHumanEachCycle: false }, reason: '清理类循环关掉了每轮人审' },
      { data: { ...baseRecurring, trigger: { ...baseRecurring.trigger, rrule: null } }, reason: 'cron 触发却没给 rrule' },
      { data: { ...baseRecurring, termination: { pauseOnConsecutiveFailures: 3 } }, reason: '没有任何终止条件' },
    ],
  },
  'cycle-summary': {
    valid: [
      baseCycleSummary,
      { schema: 'aicompany.cycle-summary/v1', jobId: 'JOB-1', jobVersion: 1, cycleNo: 1, taskId: 'T-1', status: 'done', metrics: {}, runIds: [] },
      { ...baseCycleSummary, status: 'failed', metrics: { deletedCount: 0 }, runIds: ['RUN-2'] },
    ],
    invalid: [
      { data: cycleWithoutJobId, reason: '缺必填 jobId' },
      { data: { ...baseCycleSummary, metrics: { ...baseCycleSummary.metrics, deletedCount: 1 } }, reason: '清理轮次竟然删了文件' },
      { data: { ...baseCycleSummary, cycleNo: 0 }, reason: 'cycleNo 必须 ≥ 1' },
    ],
  },
  'change-request': {
    valid: [
      baseChangeRequest,
      { ...baseChangeRequest, changeRequestId: 'CR-2', kind: 'clarify', severity: 'advisory', reason: '术语表路径需要确认' },
      { schema: 'aicompany.change-request/v1', changeRequestId: 'CR-3', taskId: 'T-1', runId: 'R-1', agentId: 'worker-01', reportsTo: null, revision: 1, kind: 'scope', severity: 'needsDecision', reason: '交付范围要改', doneSoFar: {}, createdAt: T },
    ],
    invalid: [
      { data: { ...baseChangeRequest, severity: 'urgent' }, reason: 'severity 不在封闭枚举里' },
      { data: crWithoutId, reason: '缺必填 changeRequestId（无法去重）' },
      { data: { ...baseChangeRequest, kind: 'blocked', severity: 'needsDecision' }, reason: 'blocked 应走 escalation，不得挂起' },
    ],
  },
  'decision': {
    valid: [
      baseDecision,
      { ...baseDecision, decision: 'cancel', reason: '方向废弃' },
      { ...baseDecision, decision: 'resume', newInstructions: '改按美式术语续做', newAcceptance: ['术语命中 glossary 美式条目'], needsHumanApproval: true, approvalId: 'AP-1', reason: '改动验收条件须人审' },
    ],
    invalid: [
      { data: { ...baseDecision, decision: 'restart' }, reason: '第五类 / 未知决策出口' },
      { data: { ...baseDecision, newInstructions: '改用英式术语', needsHumanApproval: false }, reason: '改了目标却没走 replan 人审' },
      { data: { ...baseDecision, newAcceptance: ['放宽验收条件'], needsHumanApproval: true }, reason: 'CEO 试图单方面放宽验收' },
    ],
  },
  'thread': {
    valid: [
      baseThread,
      { ...baseThread, mode: 'meeting', participants: ['you', 'ceo', 'tech-lead'], wakePolicy: 'never', ceoVisibility: 'cc', sharedFiles: [] },
      { schema: 'aicompany.thread/v1', threadId: 'TH-2', mode: 'cowork', title: '术语', participants: ['you'], wakePolicy: 'onRollCall', ceoVisibility: 'none', ttlDays: 7, state: 'active', createdAt: T, lastActiveAt: T },
    ],
    invalid: [
      { data: { ...baseThread, mode: 'delegate' }, reason: 'delegate 建任务卡，不是协作空间' },
      { data: { ...baseThread, participants: [] }, reason: '协作空间至少要 1 个参与者' },
      { data: { ...baseThread, ttlDays: 0 }, reason: 'TTL 必须 ≥ 1 天' },
    ],
  },
};
