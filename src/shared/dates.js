// Natural-language dates and recurrence rules.
// Pure functions with no Node APIs, so the browser imports this same file for live quick-add previews.
// All dates are local calendar dates as 'YYYY-MM-DD'; times are 'HH:MM' (24h).

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DAY_FULL = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const DAY_ANY = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?';
const MONTH_ANY = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const ORD = '(?:st|nd|rd|th)';
const END = '(?=$|[\\s.,;!?)])';

// ---------- basic date helpers ----------

export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Adds n months, pinning to `day` and clamping to the month's length (Jan 31 + 1 month = Feb 28).
export function addMonths(d, n, day = d.getDate()) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, last));
  return r;
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmtDate(parseDate(s)) === s;
}

export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function dayIndex(word) {
  return DAYS.indexOf(word.slice(0, 3).toLowerCase());
}

function nextDow(from, dow, includeToday) {
  let diff = (dow - from.getDay() + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return addDays(from, diff);
}

// ---------- recurrence ----------
// Canonical rule strings (what is stored, shown, and what the AI is told to produce):
//   every day | every 3 days | every weekday | every week | every 2 weeks | every mon,thu
//   every month | every month on 15 | every 3 months | every year
// "every!" instead of "every" schedules from the completion date instead of the due date.

export function parseRecurrence(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase().replace(/\s+/g, ' ');
  const alias = { daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year', annually: 'every year' };
  if (alias[s]) s = alias[s];
  const m = s.match(/^every(!)?\s+(.+)$/);
  if (!m) return null;
  const after = Boolean(m[1]);
  let rest = m[2];

  let interval = 1;
  let im = rest.match(/^(other|\d+)\s+(.+)$/);
  if (im) {
    interval = im[1] === 'other' ? 2 : parseInt(im[1], 10);
    rest = im[2];
  }
  if (!(interval >= 1 && interval <= 365)) return null;

  let onDay = null;
  const on = rest.match(/^(.+?)\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?$/);
  if (on) {
    rest = on[1];
    onDay = parseInt(on[2], 10);
  }

  let rule;
  if (/^days?$/.test(rest)) rule = { unit: 'day' };
  else if (/^(week ?days?|workdays?)$/.test(rest)) rule = { unit: 'weekday' };
  else if (/^weeks?$/.test(rest)) rule = { unit: 'week' };
  else if (/^months?$/.test(rest)) rule = { unit: 'month', monthDay: onDay };
  else if (/^years?$/.test(rest)) rule = { unit: 'year' };
  else if ((im = rest.match(/^(\d{1,2})(?:st|nd|rd|th)$/))) rule = { unit: 'month', monthDay: parseInt(im[1], 10) };
  else {
    const parts = rest.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);
    if (!parts.length || !parts.every((p) => new RegExp(`^(?:${DAY_ANY})$`).test(p))) return null;
    rule = { unit: 'week', days: [...new Set(parts.map(dayIndex))].sort() };
    interval = 1;
  }
  if (onDay != null && rule.unit !== 'month') return null;
  if (rule.monthDay != null && !(rule.monthDay >= 1 && rule.monthDay <= 31)) return null;
  return { after, interval, ...rule };
}

export function formatRecurrence(r) {
  const head = r.after ? 'every!' : 'every';
  const n = r.interval > 1 ? `${r.interval} ` : '';
  const pl = r.interval > 1 ? 's' : '';
  switch (r.unit) {
    case 'day': return `${head} ${n}day${pl}`;
    case 'weekday': return `${head} weekday`;
    case 'week': return r.days ? `${head} ${r.days.map((d) => DAYS[d]).join(',')}` : `${head} ${n}week${pl}`;
    case 'month': return `${head} ${n}month${pl}${r.monthDay ? ` on ${r.monthDay}` : ''}`;
    case 'year': return `${head} ${n}year${pl}`;
  }
  return null;
}

export function normalizeRecurrence(input) {
  const r = parseRecurrence(input);
  return r ? formatRecurrence(r) : null;
}

// Next date strictly after d.
function step(r, d) {
  switch (r.unit) {
    case 'day': return addDays(d, r.interval);
    case 'weekday': {
      let x = addDays(d, 1);
      while (x.getDay() === 0 || x.getDay() === 6) x = addDays(x, 1);
      return x;
    }
    case 'week': {
      if (!r.days) return addDays(d, 7 * r.interval);
      let x = addDays(d, 1);
      while (!r.days.includes(x.getDay())) x = addDays(x, 1);
      return x;
    }
    case 'month': return addMonths(d, r.interval, r.monthDay ?? d.getDate());
    case 'year': return addMonths(d, 12 * r.interval, d.getDate());
  }
  throw new Error(`Unknown recurrence unit ${r.unit}`);
}

// First date on or after `from` that matches the rule.
export function firstOccurrence(rec, from = new Date()) {
  const r = typeof rec === 'string' ? parseRecurrence(rec) : rec;
  const f = startOfDay(from);
  if (r.unit === 'weekday' || (r.unit === 'week' && r.days)) return fmtDate(step(r, addDays(f, -1)));
  if (r.unit === 'month' && r.monthDay) {
    const x = addMonths(f, 0, r.monthDay);
    return fmtDate(x >= f ? x : addMonths(f, 1, r.monthDay));
  }
  return fmtDate(f);
}

// Due date after completing a recurring task. Like Todoist, an overdue task skips
// ahead to the next occurrence after today instead of landing in the past again.
export function nextDue(rec, due, today = new Date()) {
  const r = parseRecurrence(rec);
  if (!r) return null;
  const t = startOfDay(today);
  const base = r.after || !due ? t : parseDate(due);
  let next = step(r, base);
  while (next <= t) next = step(r, next);
  return fmtDate(next);
}

// ---------- extracting dates from free text ----------

function to24(h, min, ampm) {
  let hour = h;
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  if (hour > 23 || min > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function monthIndex(word) {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

// Builds a date from day/month and optional year; without a year, picks the next future one.
function dayMonth(day, month, year, today) {
  let y = year ?? today.getFullYear();
  if (y < 100) y += 2000;
  const d = new Date(y, month, day);
  if (d.getMonth() !== month) return null;
  if (year == null && d < today) d.setFullYear(y + 1);
  return d;
}

const DATE_PATTERNS = [
  // 2026-10-21
  [/(\d{4})-(\d{2})-(\d{2})/, (m) => (isValidDate(m[0]) ? parseDate(m[0]) : null)],
  // 21 oct, 21st of October 2026
  [new RegExp(`(\\d{1,2})${ORD}?\\s+(?:of\\s+)?(${MONTH_ANY})(?:\\s+(\\d{4}))?`, 'i'),
    (m, t) => dayMonth(+m[1], monthIndex(m[2]), m[3] ? +m[3] : null, t)],
  // oct 21, October 21st 2026
  [new RegExp(`(${MONTH_ANY})\\s+(\\d{1,2})${ORD}?(?:,?\\s+(\\d{4}))?`, 'i'),
    (m, t) => dayMonth(+m[2], monthIndex(m[1]), m[3] ? +m[3] : null, t)],
  // 21/10, 21/10/2026 (day first, European order)
  [/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/, (m, t) => dayMonth(+m[1], +m[2] - 1, m[3] ? +m[3] : null, t)],
  [/day after tomorrow/i, (m, t) => addDays(t, 2)],
  [/today/i, (m, t) => t],
  [/tonight/i, (m, t) => t, '20:00'],
  [/(?:tomorrow|tmrw?)/i, (m, t) => addDays(t, 1)],
  [/next week/i, (m, t) => nextDow(t, 1, false)],
  [/next month/i, (m, t) => new Date(t.getFullYear(), t.getMonth() + 1, 1)],
  [/(?:this\s+)?weekend/i, (m, t) => nextDow(t, 6, true)],
  [/in\s+(\d+)\s+(days?|weeks?|months?)/i, (m, t) => {
    const n = +m[1];
    if (/^d/i.test(m[2])) return addDays(t, n);
    if (/^w/i.test(m[2])) return addDays(t, 7 * n);
    return addMonths(t, n);
  }],
  // "next friday" skips this week's friday; "friday"/"on fri" means the coming one
  [new RegExp(`next\\s+(${DAY_ANY})`, 'i'), (m, t) => addDays(nextDow(t, dayIndex(m[1]), false), t.getDay() < dayIndex(m[1]) ? 7 : 0)],
  [new RegExp(`(?:this|on|by)\\s+(${DAY_ANY})|(${DAY_FULL})`, 'i'), (m, t) => nextDow(t, dayIndex(m[1] || m[2]), true)],
];

const TIME_PATTERNS = [
  [/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i, (m) => to24(+m[1], +(m[2] || 0), m[3])],
  [/(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)/i, (m) => to24(+m[1], +m[2])],
  [/(?:at\s+)?noon/i, () => '12:00'],
  // "at 5" without am/pm: 1-6 means afternoon, which is what people almost always mean
  [/at\s+(\d{1,2})/i, (m) => { const h = +m[1]; return to24(h >= 1 && h <= 6 ? h + 12 : h, 0); }],
];

const RECUR_FIND = new RegExp(
  `every!?\\s+(?:other\\s+|\\d+\\s+)?(?:days?|weeks?|months?|years?|week ?days?|workdays?|\\d{1,2}${ORD}|` +
  `(?:${DAY_ANY})(?:\\s*(?:,|and|&)\\s*(?:${DAY_ANY}))*)(?:\\s+on\\s+(?:the\\s+)?\\d{1,2}${ORD}?)?`,
  'i',
);
// Bare words are only a fallback: in "send weekly update every friday" the rule is "every friday".
const RECUR_WORD = /daily|weekly|monthly|yearly|annually/i;

function findAndRemove(text, re) {
  const full = new RegExp(`(^|\\s)(?:(?:on|by|due|at)\\s+)?(${re.source})${END}`, re.flags);
  const m = text.match(full);
  if (!m) return null;
  const inner = m[2].match(new RegExp(`^(?:${re.source})$`, re.flags));
  return { match: inner, matched: m[0].trim(), text: (text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length)) };
}

// Pulls a due date, time, and recurrence out of free text.
// Returns { text, date, time, recurrence, matched: [...] } where text has the date words removed.
export function extractDate(input, now = new Date()) {
  const today = startOfDay(now);
  let text = ` ${input} `;
  const matched = [];
  let date = null;
  let time = null;
  let recurrence = null;

  const rec = findAndRemove(text, RECUR_FIND) ?? findAndRemove(text, RECUR_WORD);
  if (rec) {
    const norm = normalizeRecurrence(rec.match[0]);
    if (norm) {
      recurrence = norm;
      text = rec.text;
      matched.push(rec.matched);
    }
  }

  for (const [re, fn, impliedTime] of DATE_PATTERNS) {
    const found = findAndRemove(text, re);
    if (!found) continue;
    const d = fn(found.match, today);
    if (!d) continue;
    date = fmtDate(d);
    if (impliedTime) time = impliedTime;
    text = found.text;
    matched.push(found.matched);
    break;
  }

  for (const [re, fn] of TIME_PATTERNS) {
    const found = findAndRemove(text, re);
    if (!found) continue;
    const t = fn(found.match);
    if (!t) continue;
    time = t;
    text = found.text;
    matched.push(found.matched);
    break;
  }

  if (recurrence && !date) date = firstOccurrence(recurrence, today);
  if (time && !date) {
    const [h, m] = time.split(':').map(Number);
    const passed = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
    date = fmtDate(passed ? addDays(today, 1) : today);
  }

  return { text: text.replace(/\s+/g, ' ').trim(), date, time, recurrence, matched };
}

// Parses a value that is either a 'YYYY-MM-DD' date or a phrase like "next friday 3pm".
export function parseDue(input, now = new Date()) {
  if (input == null || input === '') return { date: null, time: null, recurrence: null };
  const s = String(input).trim();
  if (isValidDate(s)) return { date: s, time: null, recurrence: null };
  const r = extractDate(s, now);
  if (!r.date) return null;
  return { date: r.date, time: r.time, recurrence: r.recurrence };
}

// Short human label for a due date relative to today: "Today", "Tomorrow", "Fri", "3 Nov".
export function dueLabel(date, today = new Date()) {
  if (!date) return '';
  const d = parseDate(date);
  const diff = Math.round((d - startOfDay(today)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (diff > 1 && diff < 7) return names[d.getDay()];
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${d.getDate()} ${month}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}
