/**
 * telemetry.js — a local record of what each turn actually did.
 *
 * "Local" is the whole point: one append-only NDJSON file in data/, readable
 * with `tail`, never sent anywhere. There was no instrumentation at all before,
 * so "it got slow" and "it lied to me" had no artefact to look at — and the
 * honesty guard's false-positive rate, which decides whether the guard survives
 * contact with real users, could not be measured.
 *
 * What is recorded per turn: duration, rounds, tool count, approximate tokens,
 * guard flags, error class. Not the message text — a log of everything you ever
 * asked is a second copy of your conversations with none of the protections.
 */
import { appendFileSync, existsSync, statSync, renameSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const FILE = join(config.dataDir, "telemetry.ndjson");
const ROTATE_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const RING = 200;

/** The last few hundred records, kept in memory so /api/health is a read of RAM. */
const ring = [];
let loaded = false;

function loadTail() {
  if (loaded) return;
  loaded = true;

  // Open first, then fstat the descriptor. Asking the path how big it is and
  // then opening it is a check-then-use window: the file can change in between,
  // and the read offset is then computed from a size that is no longer true.
  let fd;
  try {
    fd = openSync(FILE, "r");
  } catch {
    return; // no file yet, which is the normal first run
  }
  try {
    const size = fstatSync(fd).size;
    if (!size) return;
    const start = Math.max(0, size - 64 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // The first line is very likely a partial record after a tail read.
    for (const line of lines.slice(start === 0 ? 0 : 1).slice(-RING)) {
      try {
        ring.push(JSON.parse(line));
      } catch {
        /* a torn final line from a crash — skip it, it is not a fact */
      }
    }
  } catch {
    /* telemetry is never worth failing a turn over */
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function rotate() {
  try {
    if (!existsSync(FILE) || statSync(FILE).size < ROTATE_BYTES) return;
    for (let i = KEEP; i > 1; i--) {
      const from = `${FILE}.${i - 1}`;
      const to = `${FILE}.${i}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(FILE, `${FILE}.1`);
  } catch {
    /* if rotation fails we just keep appending */
  }
}

/** Record one turn. Never throws: instrumentation must not break the product. */
export function record(event) {
  const entry = { at: new Date().toISOString(), ...event };
  ring.push(entry);
  if (ring.length > RING) ring.shift();
  try {
    rotate();
    appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    /* a full disk is the user's problem, not this turn's */
  }
  return entry;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

/**
 * A summary small enough to sit in /api/health.
 *
 * p50/p95 of the last turns, plus the two rates that matter operationally: how
 * often a turn errors, and how often the honesty guard raises a flag (a number
 * that is worthless if it is always 0 and useless if it is always 1).
 */
export function stats() {
  loadTail();
  const turns = ring.filter((r) => r.kind === "turn");
  if (!turns.length) return { turns: 0 };

  const durations = turns.map((t) => t.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const guards = turns.filter((t) => (t.guardFlags || 0) > 0).length;
  const errors = turns.filter((t) => t.error).length;

  return {
    turns: turns.length,
    p50Ms: pct(durations, 50),
    p95Ms: pct(durations, 95),
    errorRate: Number((errors / turns.length).toFixed(3)),
    guardFlagRate: Number((guards / turns.length).toFixed(3)),
    avgRounds: Number((turns.reduce((n, t) => n + (t.rounds || 0), 0) / turns.length).toFixed(2)),
    avgTokens: Math.round(turns.reduce((n, t) => n + (t.tokens || 0), 0) / turns.length),
  };
}

/** For tests and for anyone who wants to start clean. */
export function reset() {
  ring.length = 0;
  loaded = true;
}

export const TELEMETRY_FILE = FILE;
