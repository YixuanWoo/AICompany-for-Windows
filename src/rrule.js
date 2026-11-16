// P2-6：零依赖的受限 rrule 解析与触发点计算。
// 支持 FREQ=HOURLY / DAILY / WEEKLY / MONTHLY + INTERVAL / BYHOUR / BYMINUTE / BYDAY / BYMONTHDAY。
// 偏差（已在交付说明标注）：只做固定时区偏移，不处理夏令时；不支持 BYSETPOS / COUNT / EXDATE。

const DAY_CODES = Object.freeze({ MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 });
const FIXED_ZONES = Object.freeze({
  UTC: 0, 'Etc/UTC': 0, 'Asia/Shanghai': 480, 'Asia/Hong_Kong': 480,
  'Asia/Taipei': 480, 'Asia/Singapore': 480, 'Asia/Tokyo': 540,
  'America/New_York': -300, 'America/Los_Angeles': -480,
  'Europe/London': 0, 'Europe/Berlin': 60,
});

export function timezoneOffsetMin(tz = 'UTC') {
  if (!tz || FIXED_ZONES[tz] !== undefined) return FIXED_ZONES[tz ?? 'UTC'] ?? 0;
  const fixed = /^([+-])(\d{1,2}):?(\d{2})$/.exec(String(tz));
  if (fixed) {
    const sign = fixed[1] === '-' ? -1 : 1;
    return sign * (Number(fixed[2]) * 60 + Number(fixed[3]));
  }
  throw new Error(`不支持的时区 ${tz}；请用 UTC、±HH:MM 或已登记的固定偏移时区（P2 未实现夏令时）`);
}

function intList(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const nums = String(value).split(',').map((x) => Number(x.trim()));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`rrule ${label} 含非数字：${value}`);
  return nums;
}

export function parseRRule(text) {
  const parts = String(text ?? '').split(';').map((p) => p.trim()).filter(Boolean);
  const map = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) throw new Error(`rrule 片段格式错误：${part}`);
    map[part.slice(0, idx).toUpperCase()] = part.slice(idx + 1);
  }
  const freq = String(map.FREQ ?? 'DAILY').toUpperCase();
  if (!['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) {
    throw new Error(`不支持的 FREQ ${freq}；可用 HOURLY / DAILY / WEEKLY / MONTHLY`);
  }
  const interval = Number(map.INTERVAL ?? 1);
  if (!Number.isInteger(interval) || interval < 1) throw new Error(`rrule INTERVAL 必须是正整数：${map.INTERVAL}`);
  const byday = map.BYDAY
    ? String(map.BYDAY).split(',').map((d) => {
      const code = d.trim().toUpperCase();
      if (!(code in DAY_CODES)) throw new Error(`rrule BYDAY 未知：${d}`);
      return DAY_CODES[code];
    })
    : null;
  return {
    freq,
    interval,
    byhour: freq === 'HOURLY' ? [0] : intList(map.BYHOUR, [0], 'BYHOUR'),
    byminute: intList(map.BYMINUTE, [0], 'BYMINUTE'),
    byday,
    bymonthday: intList(map.BYMONTHDAY, [1], 'BYMONTHDAY'),
  };
}

// 内部一律把「本地墙钟毫秒」当成 UTC 毫秒来算，最后再减掉时区偏移换回真实 UTC，避免宿主时区干扰。
function alignLocal(rule, ms) {
  const d = new Date(ms);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(0);
  if (rule.freq === 'HOURLY') return d.getTime();
  d.setUTCHours(0);
  if (rule.freq === 'WEEKLY') {
    const idx = (d.getUTCDay() + 6) % 7; // 周一 = 0
    d.setUTCDate(d.getUTCDate() - idx);
  }
  if (rule.freq === 'MONTHLY') d.setUTCDate(1);
  return d.getTime();
}

function stepLocal(rule, ms, n = 1) {
  const d = new Date(ms);
  if (rule.freq === 'HOURLY') d.setUTCHours(d.getUTCHours() + n * rule.interval);
  else if (rule.freq === 'DAILY') d.setUTCDate(d.getUTCDate() + n * rule.interval);
  else if (rule.freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + n * 7 * rule.interval);
  else d.setUTCMonth(d.getUTCMonth() + n * rule.interval);
  return d.getTime();
}

function daysInPeriod(rule, periodStartMs) {
  if (rule.freq === 'HOURLY' || rule.freq === 'DAILY') return [periodStartMs];
  if (rule.freq === 'WEEKLY') {
    return (rule.byday ?? [0]).map((idx) => {
      const d = new Date(periodStartMs);
      d.setUTCDate(d.getUTCDate() + idx);
      return d.getTime();
    });
  }
  return rule.bymonthday.map((day) => {
    const d = new Date(periodStartMs);
    d.setUTCDate(day);
    return d.getTime();
  });
}

export function occurrencesBetween(ruleOrText, fromIso, toIso, timezone = 'UTC', limit = 500) {
  const rule = typeof ruleOrText === 'string' ? parseRRule(ruleOrText) : ruleOrText;
  const offset = timezoneOffsetMin(timezone);
  const fromLocal = Date.parse(fromIso) + offset * 60000;
  const toLocal = Date.parse(toIso) + offset * 60000;
  if (!Number.isFinite(fromLocal) || !Number.isFinite(toLocal) || toLocal <= fromLocal) return [];
  const found = [];
  let period = alignLocal(rule, fromLocal);
  for (let p = 0; p < 2000 && found.length < limit; p += 1) {
    if (period > toLocal + 400 * 86400000) break;
    const hours = rule.freq === 'HOURLY' ? [0] : rule.byhour;
    for (const dayMs of daysInPeriod(rule, period)) {
      for (const hour of hours) {
        for (const minute of rule.byminute) {
          const candidate = dayMs + hour * 3600000 + minute * 60000;
          if (candidate > fromLocal && candidate <= toLocal) {
            found.push(new Date(candidate - offset * 60000).toISOString());
            if (found.length >= limit) break;
          }
        }
        if (found.length >= limit) break;
      }
      if (found.length >= limit) break;
    }
    period = stepLocal(rule, period);
  }
  return found.sort();
}

export function nextFireAt(ruleOrText, fromIso, timezone = 'UTC') {
  const horizon = Date.parse(fromIso) + 800 * 86400000;
  return occurrencesBetween(ruleOrText, fromIso, new Date(horizon).toISOString(), timezone, 1)[0] ?? null;
}
