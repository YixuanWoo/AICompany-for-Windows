// 定时下达：把董事会说的「几点、传什么」翻译成一条只跑一轮的循环任务。
//
// 为什么单列一个模块：命令入口（scripts/schedule.js）和看板入口（POST /api/schedule）
// 必须产出**同一份**循环任务，否则两边能排出的东西不一样，出问题也查不到一处。
//
// 语义全部复用既有循环引擎（src/recurring.js + src/rrule.js + src/scheduler.js）：
//   · 到点才建卡           —— rrule + 调度器每 15 秒 tick
//   · 只跑一轮             —— termination.maxCycles = 1（rrule 不支持 COUNT）
//   · 忙就等               —— overlapPolicy = 'queue'
//   · 错过了只补一次        —— misfirePolicy = 'run_once' + 宽限 12 小时

const DEFAULT_TZ = 'Asia/Shanghai';

const DEFAULT_ACCEPTANCE = [
  '按任务说明完成，产物写在 output/',
  'completion.json 说清做了什么、完成度、还剩什么',
];

/** 解析「02:30」或「2026-11-18 02:30」。 */
export function parseTime(text) {
  const raw = String(text ?? '').trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (hm) {
    const hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour > 23 || minute > 59) throw new Error(`时间不合法：${raw}`);
    return { kind: 'hm', hour, minute };
  }
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(raw);
  if (full) {
    const [, y, m, d, hour, minute] = full;
    if (Number(hour) > 23 || Number(minute) > 59) throw new Error(`时间不合法：${raw}`);
    return {
      kind: 'date', hour: Number(hour), minute: Number(minute),
      date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    };
  }
  throw new Error(`看不懂的时间：${raw}（写 "02:30" 或 "2026-11-18 02:30"）`);
}

const rand4 = () => Math.random().toString(36).slice(2, 6);

function short(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * 把「几点 + 传什么」变成一条只跑一轮的循环任务。
 * date 给了就钉在那一天（用 nextFireAt 钉首个触发点，maxCycles=1 在首轮后收口）。
 */
export function buildScheduleJob({
  text, at, date = null, title = null, project = null, assignee = 'ceo',
  reviewBy = null, difficulty = 'normal', acceptance = null,
  tz = DEFAULT_TZ, now = new Date().toISOString(), jobId = null,
} = {}) {
  if (!String(text ?? '').trim()) throw new Error('需求是空的 —— 至少写一句话。');
  const atText = date && !/\d{4}-\d{1,2}-\d{1,2}/.test(String(at ?? ''))
    ? `${date} ${at}`
    : at;
  const parsed = parseTime(atText);
  const rrule = `FREQ=DAILY;BYHOUR=${parsed.hour};BYMINUTE=${parsed.minute}`;
  const firstFireAt = parsed.kind === 'date'
    ? `${parsed.date}T${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}:00+08:00`
    : null;
  const acc = Array.isArray(acceptance) && acceptance.length ? acceptance : DEFAULT_ACCEPTANCE;
  const resolvedTz = parsed.kind === 'date' ? DEFAULT_TZ : tz;
  return {
    schema: 'aicompany.recurring/v1',
    jobId: jobId ?? `SCH-${Date.parse(now).toString(36)}-${rand4()}`,
    jobVersion: 1,
    title: title ?? short(text, 24),
    // kind 只有 brief / inspection / cleanup / maintenance 四档：董事会下的活按 maintenance 走。
    kind: 'maintenance',
    owner: 'human',
    assignee,
    project: project ?? null,
    reportsTo: null,
    reviewBy: reviewBy ?? null,
    reviewNote: reviewBy ? '董事会定时下达的任务，指定由该席位验收。' : null,
    status: 'active',
    trigger: { type: 'cron', rrule, timezone: resolvedTz },
    misfirePolicy: 'run_once',
    misfireGraceMin: 720,
    // 上一轮没完就等：不重复建卡，也不跳过 —— 队列语义正是「忙就等」。
    overlapPolicy: 'queue',
    termination: {
      validUntil: null,
      maxCycles: 1,
      pauseOnConsecutiveFailures: 1,
    },
    requiresHumanEachCycle: false,
    taskTemplate: {
      role: 'general',
      instructions: String(text).trim(),
      acceptance: acc,
      completionReportPath: 'output/completion.json',
    },
    carryOver: { enabled: false },
    dedupeWindowMin: 30,
    lastCycleNo: 0,
    nextFireAt: firstFireAt,
  };
}

/**
 * 一批排班按顺序摆好：时间相同的自动往后错开 gapMin 分钟。
 * 同一分钟齐发会让几张卡同时进队列，谁先谁后就成了运气；错开之后顺序是确定的。
 */
export function planBatch(entries, { gapMin = 10, tz = DEFAULT_TZ } = {}) {
  const used = new Map();
  return entries.map((entry) => {
    const parsed = parseTime(entry.at);
    let hour = parsed.hour;
    let minute = parsed.minute;
    let date = parsed.date ?? null;
    for (let guard = 0; guard < 200; guard += 1) {
      const key = `${date ?? tz}-${hour}:${minute}`;
      if (!used.has(key)) { used.set(key, true); break; }
      const total = hour * 60 + minute + gapMin;
      hour = Math.floor((total % 1440) / 60);
      minute = total % 60;
      if (total >= 1440 && date) {
        const d = new Date(`${date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        date = d.toISOString().slice(0, 10);
      }
    }
    return {
      ...entry,
      at: date ? `${date} ${hour}:${String(minute).padStart(2, '0')}` : `${hour}:${String(minute).padStart(2, '0')}`,
    };
  });
}

/** 看板与命令行共用的「这是什么」判断：董事会自己排的、且只跑一轮。 */
export function isScheduledByBoard(job = {}) {
  return job.owner === 'human'
    || String(job.jobId ?? '').startsWith('SCH-')
    || job?.termination?.maxCycles === 1;
}
