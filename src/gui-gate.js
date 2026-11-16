// P6-2：GUI 席位的「代价闸门」。
//
// 为什么需要：GUI 型席位要靠抢键鼠才能干活，这是它相对 CLI 型席位的**真实代价**。
// 抢 20 秒、覆盖剪贴板、必须在你正用电脑时把窗口顶到前台 —— 不设闸，天天用就是天天被打断。
// 这里只做「能不能现在动手」的判定，是纯函数：不碰文件、不跑命令、不读时钟（now 由调用方注入）。
//
// 四道闸（全部可选，不配就是旧行为，一个字节都不影响）：
//   paused        人工暂停开关（看板按钮 / 落地文件）
//   allowedHours  只在这些整点区间里跑（支持跨午夜，如 [23, 7]）
//   requireIdleSec 你刚动过键盘鼠标就不抢（等你自己停下来）
//   requireUnlocked 锁屏时不要瞎按（锁屏按下去谁也看不见，还容易按进别的窗口）
//
// 判据只影响「这次派不派 GUI 活」，**不影响任务是否完成** —— 完成永远只认磁盘文件。

export const GATE_CODES = Object.freeze({
  paused: 'paused',
  hours: 'outside-window',
  busy: 'user-active',
  locked: 'session-locked',
});

function pad(n) {
  return String(n).padStart(2, '0');
}

// 小时区间判定。from / to 用 0-24 的整数（24 等价于次日 0 点）。
// from === to 视为「全天」，from > to 视为跨午夜。
export function inAllowedHours(date, allowedHours) {
  if (!Array.isArray(allowedHours) || allowedHours.length !== 2) return true;
  const [from, to] = allowedHours.map((v) => Number(v));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  if (from === to) return true;
  const hour = date.getHours() + date.getMinutes() / 60;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

export function formatHours(allowedHours) {
  if (!Array.isArray(allowedHours) || allowedHours.length !== 2) return '不限时段';
  const [from, to] = allowedHours.map((v) => pad(Number(v)) + ':00');
  return `${from} - ${to}`;
}

// 返回第一个原因即对外口径；details 全给看板/审计用。
export function evaluateGate({
  paused = false,
  pausedAt = null,
  pauseReason = '',
  now = new Date(),
  allowedHours = null,
  locked = null,
  idleSec = null,
  requireIdleSec = 0,
  requireUnlocked = false,
} = {}) {
  const blocked = [];

  if (paused) {
    const at = pausedAt ? `（${pausedAt}）` : '';
    blocked.push({
      code: GATE_CODES.paused,
      reason: `GUI 已人工暂停${at}${pauseReason ? '：' + pauseReason : ''}，恢复后再派活`,
    });
  }

  if (allowedHours && !inAllowedHours(now, allowedHours)) {
    blocked.push({
      code: GATE_CODES.hours,
      reason: `现在 ${pad(now.getHours())}:${pad(now.getMinutes())} 不在允许时段（${formatHours(allowedHours)}）`,
    });
  }

  if (requireUnlocked && locked === true) {
    blocked.push({ code: GATE_CODES.locked, reason: '当前会话已锁屏，GUI 按键会落到错误的窗口，等解锁再跑' });
  }

  // idleSec 读不到（null）时不做判断：宁可放过，也不要因为探测失败让活永久派不出去。
  if (requireIdleSec > 0 && typeof idleSec === 'number' && idleSec >= 0 && idleSec < requireIdleSec) {
    blocked.push({
      code: GATE_CODES.busy,
      reason: `你 ${idleSec} 秒前还在操作键鼠（要求静置 ${requireIdleSec} 秒），先让你用，稍后自动重排`,
    });
  }

  return {
    ok: blocked.length === 0,
    code: blocked[0]?.code ?? null,
    reason: blocked[0]?.reason ?? null,
    details: blocked,
    checked: {
      paused, allowedHours, locked, idleSec, requireIdleSec, requireUnlocked,
    },
  };
}

// 看板/日志用的一句话状态，避免前端自己拼规则。
export function describeGate(gate) {
  if (!gate) return '未配置闸门';
  if (!gate.ok) return `拦下：${gate.reason}`;
  const bits = [];
  if (gate.checked.allowedHours) bits.push(`时段 ${formatHours(gate.checked.allowedHours)}`);
  if (gate.checked.requireIdleSec > 0) bits.push(`空闲 ≥ ${gate.checked.requireIdleSec}s`);
  if (gate.checked.requireUnlocked) bits.push('要求未锁屏');
  return bits.length ? `可用（${bits.join(' / ')}）` : '可用（无额外限制）';
}
