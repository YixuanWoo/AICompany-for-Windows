// P0 冻结的三份契约 + 统一 API 端点清单 + Web Board 页面范围。
// 依据：任务书 §6B.7 / §6B.8 / §6C.8 / §6D.4 / §18 D5。

import { isPlainObject } from './enums.js';

export const ADAPTER_CONTRACT = Object.freeze({
  name: 'AdapterModule',
  methods: ['type', 'execute', 'testEnvironment'],
  note: 'execute(ctx) → { status, usage, sessionParams?, result }；差异全封装在 adapter 里',
});

export const CHANNEL_CONTRACT = Object.freeze({
  name: 'Channel（入站，可插拔）',
  methods: ['start', 'stop', 'onInbound'],
  forbidden: ['直接写数据库', '直接唤醒 agent', '猜测交互模式'],
  note: '只做白名单鉴权、message_id 去重、把消息翻译成统一 API 调用',
});

export const NOTIFIER_CONTRACT = Object.freeze({
  name: 'Notifier（出站，可换）',
  methods: ['send', 'requestApproval'],
  forbidden: ['readInbox'],
  note: 'v0.4 起 readInbox() 移出；读消息是入站职责',
});

export const WEB_BOARD_MIN_PAGES = Object.freeze([
  'Tasks', 'Approvals', 'Inbox',
  '模式下拉 + 「交付给」候选选择器', '最小 Threads 消息流',
]);

export const WEB_BOARD_FULL_PAGES = Object.freeze([
  'Dashboard', 'Runs / Audit', 'RecurringJobs', 'Threads 完整页', 'ChangeRequests（改动前后对照）',
]);

export const API_ENDPOINTS = Object.freeze([
  { method: 'POST', path: '/api/requests', purpose: '提交需求（幂等键 requestId；可选 mode/addressedTo/cc）', section: '§6B.8 / §6C.9' },
  { method: 'POST', path: '/api/tasks', purpose: '建卡', section: '§6B.8' },
  { method: 'GET', path: '/api/tasks', purpose: '看板列表', section: '§6B.8' },
  { method: 'POST', path: '/api/tasks/:id/comments', purpose: '过程纠偏 / 回答提问', section: '§6B.8' },
  { method: 'POST', path: '/api/approvals/:id/decision', purpose: '三道常规门禁 + replan 人审', section: '§6B.8 / §7.6' },
  { method: 'POST', path: '/api/runs/now', purpose: '人工叫醒某席位', section: '§6B.8' },
  { method: 'POST', path: '/api/recurring/:id/pause', purpose: '循环暂停', section: '§6A' },
  { method: 'POST', path: '/api/recurring/:id/resume', purpose: '循环恢复', section: '§6A' },
  { method: 'GET', path: '/api/agents', purpose: '候选卡片聚合（席位码 / 能力 / 忙闲 / 配额）', section: '§6C.4' },
  { method: 'POST', path: '/api/threads', purpose: '建协作空间', section: '§6C.8' },
  { method: 'GET', path: '/api/threads/:id', purpose: '读协作空间', section: '§6C.8' },
  { method: 'POST', path: '/api/threads/:id/messages', purpose: '发消息（按 wakePolicy 唤醒）', section: '§6C.8' },
  { method: 'POST', path: '/api/threads/:id/roll-call', purpose: '点名（readonly/full 确认）', section: '§6C.8' },
  { method: 'POST', path: '/api/threads/:id/promote', purpose: '单向提升为卡或附件', section: '§6C.8' },
  { method: 'POST', path: '/api/threads/:id/archive', purpose: 'TTL 到点或人工归档', section: '§6C.8' },
  { method: 'POST', path: '/api/change-requests', purpose: '上报变更请求（与文件落盘同一 schema）', section: '§6D.2 / §6.2' },
  { method: 'GET', path: '/api/change-requests/:id', purpose: '读取变更请求', section: '§6D.2' },
  { method: 'POST', path: '/api/change-requests/:id/decision', purpose: '拍板；动目标时生成 replan 人审', section: '§6D.4' },
  { method: 'POST', path: '/api/tasks/:id/cancel', purpose: '取消收尾', section: '§6D.5' },
  { method: 'GET', path: '/api/tasks/:id/revisions', purpose: '查指令版本历史', section: '§6D.6' },
  { method: 'GET', path: '/api/inbox', purpose: '待办', section: '§6B.8' },
  { method: 'GET', path: '/api/dashboard', purpose: '状态汇总', section: '§6B.8' },
  { method: 'GET', path: '/api/runs', purpose: 'Run transcript 查询', section: '§6B.8' },
  { method: 'GET', path: '/api/audit', purpose: '审计查询', section: '§6B.8' },
  { method: 'GET', path: '/api/events', purpose: 'SSE / WS 推状态变更（含 thread/change/decision）', section: '§6B.8' },
  // P2 增量：bridge 子集、循环任务与定时例程。仍然全部挂在同一个 /api 下面（§9.2）。
  { method: 'GET', path: '/api/bridges', purpose: 'bridge 心跳状态', section: '§9.3 / P2' },
  { method: 'GET', path: '/api/leases', purpose: '当前 lease 占用', section: '§9.4 / P2' },
  { method: 'GET', path: '/api/bridge/inbox', purpose: '按席位拉待领任务', section: '§9.2 / P2' },
  { method: 'POST', path: '/api/bridge/checkout', purpose: 'lease 独占领取，抢不到 409', section: '§9.4 / P2' },
  { method: 'POST', path: '/api/bridge/heartbeat', purpose: '上报心跳与本机状态', section: '§9.3 / P2' },
  { method: 'POST', path: '/api/bridge/progress', purpose: '进度报告，0 唤醒', section: '§9.2 / P2' },
  { method: 'POST', path: '/api/bridge/complete', purpose: '完成报告回写（验 lease）', section: '§9.2 / P2' },
  { method: 'POST', path: '/api/bridge/change-request', purpose: '变更请求回写（验 lease）', section: '§6D.2 / P2' },
  { method: 'POST', path: '/api/bridge/snapshot', purpose: '现场快照留痕', section: '§6D.3 / P2' },
  { method: 'GET', path: '/api/bridge/status', purpose: '在线状态与待补投数', section: '§9.3 / P2' },
  { method: 'GET', path: '/api/recurring', purpose: '循环任务列表', section: '§6A / P2' },
  { method: 'POST', path: '/api/recurring', purpose: '注册循环任务（过 schema）', section: '§6A.3 / P2' },
  { method: 'POST', path: '/api/recurring/:id/fire', purpose: '手动触发一次实例化', section: '§6A.5 / P2' },
  { method: 'POST', path: '/api/recurring/:id/complete-cycle', purpose: '收账并写 CycleHistory', section: '§6A.4 / P2' },
  { method: 'GET', path: '/api/cycles', purpose: '轮次实例查询', section: '§6A.2 / P2' },
  { method: 'GET', path: '/api/cycle-history', purpose: '周期历史查询', section: '§6A.4 / P2' },
  { method: 'GET', path: '/api/scheduler', purpose: '定时例程状态', section: '§10.3 / P2' },
  { method: 'POST', path: '/api/scheduler/tick', purpose: '手动跑一次 tick（可注入时间）', section: '§6A.5 / P2' },
  // P4 增量：配额 / 审批 / 决策回环 / 查询 / 协作增强 / 清理扫描。
  { method: 'GET', path: '/api/quotas', purpose: '各席位本周期配额用量与上限', section: '§7.5 / P4-1' },
  { method: 'POST', path: '/api/quotas/:id/reset', purpose: '人工清零本周期用量（历史周期保留）', section: '§7.5 / P4-1' },
  { method: 'POST', path: '/api/approvals', purpose: '发起一道人审（strategy / hiring_budget / review_reject / replan / recurring_change）', section: '§7.6 / P4-2' },
  { method: 'GET', path: '/api/approvals', purpose: '审批列表（可按 status / taskId / kind 过滤）', section: '§7.6 / P4-2' },
  { method: 'POST', path: '/api/change-requests/expire', purpose: '挂起超时扫描：24h 提醒一次、72h 自动取消，绝不自动恢复', section: '§6D.3 / P4-8' },
  { method: 'GET', path: '/api/change-requests', purpose: '变更请求查询（可按 taskId 过滤）', section: '§6D.2 / P4-4' },
  { method: 'GET', path: '/api/decisions', purpose: '决策查询（可按 taskId 过滤）', section: '§6D.4 / P4-4' },
  { method: 'GET', path: '/api/activity', purpose: '一张卡的时间线：状态流转 / Run / 变更 / 决策 / 审批 / 版本 / 快照', section: '§7.2 / P4-4' },
  { method: 'POST', path: '/api/threads/archive-stale', purpose: 'TTL 到点批量归档协作空间', section: '§6C.5 / P4-7' },
  { method: 'POST', path: '/api/recurring/:id/revise', purpose: '循环模板改版（返回 202，等 recurring_change 人审）', section: '§6A.9 / P4-9' },
  { method: 'POST', path: '/api/cleanup/scan', purpose: '清理扫描：只出报告，deletedCount 恒 0；敏感目录直接拒绝', section: '§6A.9 / P4-9' },
  // P5 增量：试运行观测与调参。
  { method: 'GET', path: '/api/observe', purpose: '五分项指标 + 四项 §6C/§6D 结论 + 脏状态检查', section: '§12 P5 / P5-1 / P5-3' },
  { method: 'GET', path: '/api/observe/dirty', purpose: '只跑脏状态检查（11 条规则）', section: '§12.6 / G-P5' },
  { method: 'GET', path: '/api/observe/report', purpose: '观察记录 Markdown 直出', section: '§12 P5 / P5-1' },
  { method: 'GET', path: '/api/config/tuning', purpose: '可调项白名单 + 调整历史（旧值 → 新值）', section: '§12 P5 / P5-2' },
  { method: 'POST', path: '/api/config/tune', purpose: '调 cooldown / 配额 / 挂起时长，立刻生效并写 audit', section: '§12 P5 / P5-2' },
  // P6 增量：让 GUI 席位「天天能用」的配套（产物查看 + 抢键鼠闸门）。
  { method: 'GET', path: '/api/tasks/:id/outputs', purpose: '列任务产物（只有 output/ 下的普通文件）', section: '§8.3 / P6' },
  { method: 'GET', path: '/api/tasks/:id/output', purpose: '读单个产物文本（越界 / 软链接 / 超大一律拒）', section: '§8.3 / P6' },
  { method: 'GET', path: '/api/gui/state', purpose: 'GUI 席位状态：暂停开关 / 闸门参数 / 跨进程锁占用', section: '§8.3 / P6' },
  { method: 'POST', path: '/api/gui/pause', purpose: '暂停或恢复 GUI 席位抢键鼠（不取消已排的卡）', section: '§8.3 / P6' },
  { method: 'GET', path: '/api/meta', purpose: '公司默认模式 / 席位清单 / GUI 暂停状态（看板初始化用）', section: '§6B.8 / P6' },
  // P7 增量：项目层（规范与记忆都在公司文件夹内，项目文件夹只出交付物）。
  { method: 'GET', path: '/api/projects', purpose: '项目清单：规范在不在、记忆几条、归档目录授权了没', section: 'P7 / P7-1' },
]);

export const WEB_BOARD_P2_PANELS = Object.freeze([
  'Bridge 状态（在线 / 待补投 / 已领）', 'RecurringJobs 最小列表',
]);

export const WEB_BOARD_P4_PANELS = Object.freeze([
  '审批 · Approvals（通过 / 要求重写或换人 / 驳回）',
  '挂起待决策 · Decisions（resume / redo / derive / cancel 四出口）',
  '配额 · Quotas（80% 预警、100% 触顶、可重置）',
  '运行与审计 · Activity（一条任务的时间线）',
  '清理扫描 · Cleanup（只出报告，敏感目录拒绝）',
  '协作空间点名 / 提升 / 归档控件',
]);

// P5：试运行的观测与调参面板。观察记录必须能在页面上看，不能只躺在日志里。
export const WEB_BOARD_P5_PANELS = Object.freeze([
  '试运行观测 · Observe（五项指标 + 四项结论 + 脏状态）',
  '观察记录 Markdown 直出（/api/observe/report）',
  '调参 · Tune（改完立刻生效，旧值新值进审计）',
  '调参历史（谁在什么时候把哪个值从多少改到多少）',
]);

// P6：真实 GUI 席位「能天天用」的两块面板 —— 看结果、随时叫停。
export const WEB_BOARD_P6_PANELS = Object.freeze([
  '任务产物 · Outputs（看结果：列出 output/ 下文件并直接读内容）',
  'GUI 席位开关（暂停 / 继续抢键鼠，当前状态可见）',
]);

// P5 的五项指标口径。单独列出来，便于契约测试校验「指标不会被悄悄改名」。
export const OBSERVE_METRICS_CONTRACT = Object.freeze([
  'falseWake', 'idleRun', 'reportReject', 'guiFailure', 'quotaBurn',
]);

// P5 的四项 §6C / §6D 结论。
export const OBSERVE_FINDINGS_CONTRACT = Object.freeze([
  'directBypassesCeo', 'coworkCreatesTask', 'awaitingRerun', 'decisionTimeout',
]);

export function assertImplements(impl, contract) {
  const errors = [];
  if (!isPlainObject(impl)) return { ok: false, errors: ['实现必须是对象'] };
  for (const method of contract.methods) {
    if (impl[method] === undefined || impl[method] === null) errors.push(`缺少 ${method}`);
  }
  for (const forbidden of contract.forbidden || []) {
    if (forbidden === 'readInbox') {
      if (typeof impl.readInbox === 'function') errors.push('Notifier 不得包含 readInbox()');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function listEndpoints() {
  return API_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
}
