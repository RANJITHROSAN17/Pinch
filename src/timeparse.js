/**
 * timeparse.js — turn "in 30 minutes" / "at 6pm" / "tomorrow 9am" into a Date.
 *
 * Pure and dependency-free so it can be unit-tested without a clock: every
 * function takes the "now" it should reason from. If it cannot understand the
 * phrase it returns null, and the caller must say so rather than guessing —
 * a silently wrong reminder is worse than a refused one.
 */

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45,
  sixty: 60, ninety: 90, half: 0.5, quarter: 0.25,
};

/** "6pm", "6:30 pm", "18:30", "9 in the morning", "noon", "midnight" → {h, m} */
export function parseClock(text) {
  const t = String(text).toLowerCase().trim();
  if (/\bnoon\b/.test(t)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };

  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (min > 59) return null;
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (!mer && h > 23) return null;
  return { h, m: min };
}

function addDays(date, n) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + n);
  return copy;
}

function atClock(base, { h, m }) {
  const d = new Date(base.getTime());
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * @param {string} phrase e.g. "in 30 minutes", "tomorrow at 9", "18:30"
 * @param {Date} now reference point (defaults to real now)
 * @returns {{at: Date, kind: string, phrase: string}|null}
 */
export function parseWhen(phrase, now = new Date()) {
  const raw = String(phrase || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!raw) return null;

  // ── absolute ISO-ish first: "2026-11-05", "2026-11-05 14:30" ──
  // Must be checked before the loose clock matcher, which would otherwise read
  // the year "2026" as the hour "20".
  const iso = /(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}:\d{2}))?/.exec(raw);
  if (iso) {
    const at = new Date(iso[2] ? `${iso[1]}T${iso[2]}:00` : `${iso[1]}T09:00:00`);
    if (!Number.isNaN(at.getTime()) && at.getTime() > now.getTime()) {
      return { at, kind: "absolute", phrase: raw };
    }
  }

  // ── relative: "in 30 minutes", "in 2h", "in an hour", "in half an hour" ──
  if (/\bin\b/.test(raw)) {
    const half = /\bin\s+(?:an?\s+)?half\s+(?:an?\s+)?(hours?|minutes?|mins?|days?|weeks?)\b/.exec(raw);
    if (half) {
      const unit = UNIT_MS[half[1]] || UNIT_MS[half[1].replace(/s$/, "")];
      if (unit) return { at: new Date(now.getTime() + 0.5 * unit), kind: "relative", phrase: raw };
    }
    const rel = /\bin\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty|ninety)\s*([a-z]+)\b/.exec(raw);
    if (rel) {
      const amount = /^\d/.test(rel[1]) ? Number(rel[1]) : NUMBER_WORDS[rel[1]];
      const unit = UNIT_MS[rel[2]] || UNIT_MS[rel[2].replace(/s$/, "")];
      if (amount && unit) {
        return { at: new Date(now.getTime() + amount * unit), kind: "relative", phrase: raw };
      }
    }
  }

  // ── "tomorrow", "tomorrow at 9am" ──
  if (/\btomorrow\b/.test(raw)) {
    const clock = parseClock(raw.replace(/tomorrow/, ""));
    const base = addDays(now, 1);
    return {
      at: clock ? atClock(base, clock) : atClock(base, { h: 9, m: 0 }),
      kind: "tomorrow",
      phrase: raw,
    };
  }

  // ── "at 6pm", "by 18:30", bare "6pm", "noon" ──
  const atMatch = /\b(?:at|by)\s+(.+)$/.exec(raw);
  const clockSource = atMatch ? atMatch[1] : raw;
  const looksLikeTime = /(\d{1,2}:\d{2})|(\d{1,2}\s*(am|pm))\b|\b(noon|midnight)\b/.test(clockSource);
  if (looksLikeTime) {
    const clock = parseClock(clockSource);
    if (clock) {
      let at = atClock(now, clock);
      if (at.getTime() <= now.getTime()) at = addDays(at, 1); // already gone → tomorrow
      return { at, kind: "clock", phrase: raw };
    }
  }

  return null;
}

/** "in 2 hours 15 minutes" for a human-facing confirmation. */
export function humaniseDuration(ms) {
  const abs = Math.max(0, ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return `${Math.round(abs / 1000)} seconds`;
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}${hours % 24 ? ` ${hours % 24} hr` : ""}`;
}

/** "6:30 pm" in a given timezone, for confirmations. */
export function formatClock(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      day: "numeric",
      month: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
