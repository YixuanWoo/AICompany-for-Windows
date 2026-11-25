// 所有封闭枚举集中在这里。引擎只认这些标签，不认任何产品名（任务书 §6B.2 / §6C.2）。

export const SCHEMA_KINDS = [
  'task', 'progress', 'completion', 'recurring',
  'cycle-summary', 'change-request', 'decision', 'thread',
];

export const SCHEMA_IDS = {
  'task': 'aicompany.task/v1',
  'progress': 'aicompany.progress/v1',
  'completion': 'aicompany.completion/v1',
  'recurring': 'aicompany.recurring/v1',
  'cycle-summary': 'aicompany.cycle-summary/v1',
  'change-request': 'aicompany.change-request/v1',
  'decision': 'aicompany.decision/v1',
  'thread': 'aicompany.thread/v1',
};

export const INTERACTION_MODES = ['delegate', 'direct', 'cowork', 'meeting'];
export const DECISION_OUTCOMES = ['resume', 'redo', 'derive', 'cancel'];
// 四类出口是 P0 冻结的封闭枚举，不许加第五类（契约测试会拦）。
// 「只回话、不派卡」不占新类型：用 task-create + 空 tasks + summary 表达（同「只排班不派卡」一脉）。
export const CEO_OUTPUT_KINDS = ['task-create', 'review', 'escalation', 'decision'];
// 循环任务的类别（协议写死的四个）：简报 / 巡检 / 清理 / 维护。
export const RECURRING_KINDS = ['brief', 'inspection', 'cleanup', 'maintenance'];

export const TASK_STATUSES = [
  'backlog', 'todo', 'in_progress', 'awaiting_decision',
  'in_review', 'done', 'cancelled', 'blocked', 'paused',
];
export const COMPENSATION_SCAN_WHITELIST = ['todo', 'in_progress'];
export const COMPLETION_STATUSES = ['success', 'failed', 'blocked'];

// webhook-exec：可选的外部执行 adapter，通过 HTTP 把任务递给一个带工具的远程 agent。
// 只是注册一个可用的类型名，不配就不会启用，对核心零影响。
// 'seat' = 人机席位：担任者是人叫才醒的交互式 agent，只能自己来领（dispatch: pull），控制面不直调。
export const ADAPTER_TYPES = ['process', 'http', 'cli-acp', 'gui-template', 'polling', 'webhook-exec', 'seat'];
export const CAPABILITIES = ['plan', 'delegate', 'review', 'execute', 'escalate', 'readOnly'];
export const CLIENT_TYPES = ['web', 'im', 'cli', 'noop'];
export const NOTIFIER_TYPES = ['web', 'im', 'webhook', 'stdout', 'noop', 'desktop'];

export const CHANGE_KINDS = ['direction', 'clarify', 'scope', 'blocked'];
export const CHANGE_SEVERITIES = ['needsDecision', 'advisory'];
export const WAKE_POLICIES = ['never', 'onRollCall', 'onMessage'];
export const THREAD_STATES = ['active', 'archived'];
export const THREAD_STYLES = ['readonly', 'rollCall', 'full'];

// 产物分类：决定「干完之后往哪走」，与项目无关。
//   managed-code = 要长期维护的代码 → 进仓库、要人审；
//   scratch-code = 一次性计算脚本（渲染视频 / 清洗数据）→ 归档当资料，不进 git；
//   document / data / media = 交付物，落盘即可。
export const ARTIFACT_KINDS = ['managed-code', 'scratch-code', 'document', 'data', 'media'];
// 交付路由：执行岗干完自己判。
//   land = 直接落盘结案；review = 交人审；escalate = 上报（方向不对 / 超权限）。
export const HANDOFF_TARGETS = ['land', 'review', 'escalate'];

// P4：三道常规人审门禁 + 两类按需事件型人审（replan / 循环模板改版）。
export const APPROVAL_KINDS = ['strategy', 'hiring_budget', 'review_reject', 'replan', 'recurring_change', 'recurring_create', 'project_create', 'task_review'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rewrite', 'rejected', 'expired'];
export const APPROVAL_DECISIONS = ['approved', 'rewrite', 'rejected'];

export const DEFAULTS = Object.freeze({
  defaultMode: 'delegate',
  autoAssign: false,
  fullRequiresConfirm: true,
  ttlDays: 30,
  promoteRequiresExplicit: true,
  warnRatio: 0.8,
  stopRatio: 1,
  decisionRemindHours: 24,
  decisionMaxPendingHours: 72,
  // P5：Run Policy 第 4 条。cooldownSec 默认 0 = 关闭，保持老配置行为不变。
  maxConcurrent: 3,
  cooldownSec: 0,
  maxRunHours: 2,
  staleEventMinutes: 10,
  // 证据层默认值（2026-11-18）。默认全关 = 老配置行为不变；
  // 公司档里显式打开，测试里也显式给数值，不靠默认值生效。
  evidenceEnabled: false,
  ackTimeoutSec: 120,
  idleTimeoutSec: 600,
  maxDispatchAttempts: 2,
  // 2026-11-19 真机误伤：GUI 席位在干活但没写 progress，被当宕机重派（重派的活 3 分钟就干完了，
  // 说明第一趟本来就在干）。心跳只能「续命」，不能无限续 —— 所以还给一个席位预算作封顶。
  // grace 给到 10 分钟：adapter 等一次长模型回复时本来就不轮询，三分钟就判「心跳没了」等于逼它秒回。
  heartbeatGraceSec: 600,
  seatBudgetSlackSec: 300,
  // 2026-11-23 产出心跳两条线（默认 0 = 关闭，老配置行为不变）。
  // alert：心跳在但产物零增长超过这么多分钟 → 报一次董事会提醒，不打断。
  // stop：再久这么多分钟仍零产出 → 判疑似中途等人，收掉 run 并把卡置「等人配合」，不再等满 60 分钟。
  noProgressAlertMinutes: 0,
  noProgressStopMinutes: 0,
});

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOneOf(value, allowed) {
  return allowed.includes(value);
}

export function assertEnum(value, allowed, label) {
  if (!isOneOf(value, allowed)) {
    throw new Error(`${label} 必须是 [${allowed.join(', ')}] 之一，收到：${String(value)}`);
  }
  return value;
}
