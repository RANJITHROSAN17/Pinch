/**
 * schedules.js — "do this every morning and tell me the answer".
 *
 * The cadence language is deliberately tiny. Three shapes, all explainable:
 *
 *   every 30m          fixed interval, measured from the last run
 *   daily at 09:00     once a day, in the owner's timezone
 *   weekly on mon at 8:00
 *
 * Nothing else, because a schedule you cannot predict is a schedule you cannot
 * trust, and cron syntax in a personal assistant is a support burden dressed up
 * as a feature.
 *
 * The safety-relevant part of a scheduled run lives in agent.js, not here: an
 * unattended turn refuses every dangerous tool. This file only decides *when*.
 */
import { loadSchedules as load, saveSchedule as save, removeSchedule as remove, updateSchedule as update } from "./store.js";

const MAX_SCHEDULES = 20;

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Parse a cadence phrase. Returns null rather than throwing: this input is typed by a human. */
export function parseCadence(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return null;

  let m = /^every (\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(raw);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0] === "m" ? 60_000 : m[2][0] === "h" ? 3_600_000 : 86_400_000;
    if (n <= 0) return null;
    const everyMs = n * unit;
    // A one-minute loop is a runaway; five is the floor that still feels alive.
    if (everyMs < 5 * 60_000) return null;
    return { kind: "interval", everyMs, label: `every ${n}${m[2][0]}` };
  }

  m = /^daily at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (m) {
    const at = toMinutes(m[1], m[2], m[3]);
    if (at === null) return null;
    return { kind: "daily", minuteOfDay: at, label: `daily at ${pad(at)}` };
  }

  m = /^(?:weekly )?on (sun|mon|tue|wed|thu|fri|sat)[a-z]* at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (m) {
    const at = toMinutes(m[2], m[3], m[4]);
    if (at === null) return null;
    const day = DAYS.indexOf(m[1]);
    return { kind: "weekly", day, minuteOfDay: at, label: `weekly on ${DAYS[day]} at ${pad(at)}` };
  }

  return null;
}

function toMinutes(hoursText, minutesText, meridiem) {
  let h = Number(hoursText);
  const mins = minutesText === undefined ? 0 : Number(minutesText);
  if (!Number.isFinite(h) || h < 0 || h > 23 || mins < 0 || mins > 59) return null;
  if (meridiem === "pm" && h < 12) h += 12;
  if (meridiem === "am" && h === 12) h = 0;
  return h * 60 + mins;
}

const pad = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * When should this run next, after `from`?
 *
 * Always strictly after `from`, so a schedule can never fire twice for the same
 * slot however often the tick looks at it.
 */
export function nextRun(schedule, from = new Date(), timeZone = undefined) {
  const cadence = schedule.cadence || parseCadence(schedule.when);
  if (!cadence) return null;
  const now = from.getTime();

  if (cadence.kind === "interval") {
    // Count from the last run, so "every 2h" means two hours after the last one
    // rather than two hours after whenever the tick happened to look. If that
    // moment has already passed (the machine was asleep), the next slot is one
    // interval from now — not a burst of catch-up runs back to back.
    const last = schedule.lastRun ? Date.parse(schedule.lastRun) : null;
    const ideal = (last ?? now - cadence.everyMs) + cadence.everyMs;
    return new Date(ideal > now ? ideal : now + cadence.everyMs);
  }

  // For clock-based cadences the "day" is the owner's day, not UTC's.
  const zoned = zonedParts(from, timeZone);
  const targetMinutes = cadence.minuteOfDay;
  const nowMinutes = zoned.hour * 60 + zoned.minute;

  for (let addDays = 0; addDays <= 8; addDays++) {
    if (cadence.kind === "weekly") {
      const dayDelta = (cadence.day - zoned.weekday + 7) % 7;
      if (addDays !== dayDelta) continue;
    }
    if (addDays === 0 && nowMinutes >= targetMinutes) continue;
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    // Convert back from the owner's wall clock to an instant.
    candidate.setTime(candidate.getTime() + (addDays * 86_400_000) + (targetMinutes - nowMinutes) * 60_000);
    return candidate;
  }
  return null;
}

function zonedParts(date, timeZone) {
  if (!timeZone) {
    return { hour: date.getHours(), minute: date.getMinutes(), weekday: date.getDay() };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    return {
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
      weekday: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    };
  } catch {
    return { hour: date.getHours(), minute: date.getMinutes(), weekday: date.getDay() };
  }
}

/* ─────────────────────────────── the store ─────────────────────────────── */

/**
 * Create a schedule.
 *
 * @param {{task: string, when: string, address: string, channel?: string, sessionId?: string, timeZone?: string}} spec
 * @returns {{ok: true, schedule: object} | {ok: false, output: string}}
 */
export function addSchedule({ task, when, address, channel = "web", sessionId = null, timeZone }) {
  const text = String(task || "").trim();
  if (!text) return { ok: false, output: "A scheduled task needs something to do." };
  if (text.length > 500) return { ok: false, output: "That task is too long (500 characters)." };

  const cadence = parseCadence(when);
  if (!cadence) {
    return {
      ok: false,
      output:
        `I could not read "${when}" as a schedule. Three shapes work: "every 30m", ` +
        `"daily at 09:00", "weekly on mon at 8:00". Do not guess — ask the user to restate it.`,
    };
  }

  const existing = load();
  if (existing.length >= MAX_SCHEDULES) {
    return { ok: false, output: `There are already ${MAX_SCHEDULES} schedules. Remove one before adding another.` };
  }

  const now = new Date();
  const schedule = {
    id: `sch_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    task: text,
    when: String(when).trim(),
    cadence,
    address: address || "web:main",
    channel,
    sessionId: sessionId || null,
    timeZone: timeZone || null,
    createdAt: now.toISOString(),
    lastRun: null,
    runs: 0,
    enabled: true,
  };
  schedule.nextRun = nextRun(schedule, now, timeZone)?.toISOString() || null;
  save(schedule);
  return { ok: true, schedule };
}

export function listSchedules() {
  return load().sort((a, b) => String(a.nextRun).localeCompare(String(b.nextRun)));
}

export function dueSchedules(now = new Date()) {
  return load().filter((s) => s.enabled !== false && s.nextRun && Date.parse(s.nextRun) <= now.getTime());
}

/** Record a run and compute the next one. Called after delivery, never before. */
export function markRun(id, at = new Date(), timeZone = undefined) {
  const list = load();
  const schedule = list.find((s) => s.id === id);
  if (!schedule) return null;
  schedule.lastRun = at.toISOString();
  schedule.runs = (schedule.runs || 0) + 1;
  schedule.nextRun = nextRun(schedule, at, timeZone || schedule.timeZone)?.toISOString() || null;
  update(schedule.id, schedule);
  return schedule;
}

export function deleteSchedule(id) {
  return remove(id);
}

export { MAX_SCHEDULES };
