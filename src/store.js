/**
 * store.js — Pinch's memory, on disk, in plain JSON.
 *
 * No database, no cloud, no telemetry: data/ is yours. Files are
 * written atomically (tmp + fsync + rename) so a crash mid-write cannot
 * corrupt your conversation history.
 *
 * Reads are cached in-process. A turn used to read and re-parse the session and
 * the memory file four times, synchronously, on the main thread — measured at
 * ~2 ms per turn on an SSD and 20-100 ms on a Pi's SD card, blocking the SSE
 * stream and every other channel while it happened. The cache removes those
 * re-reads; writes are still synchronous and still atomic, because a debounced
 * write trades durability for a millisecond and this is someone's chat history.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync, lstatSync, realpathSync, fstatSync, readSync, constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "./config.js";

const DATA = config.dataDir;

export function ensureData() {
  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(DATA, "sessions"), { recursive: true });
}

/**
 * The single choke point where anything reaches disk.
 *
 * Everything written here ultimately came off a socket (a chat message, a
 * memory fact, a reminder), so this is the one function worth being paranoid
 * in: the destination must resolve inside data/, and the payload must be JSON
 * that parses back. A caller that gets either wrong fails here, loudly, instead
 * of writing something unexpected somewhere unexpected.
 */
function atomicWrite(path, text) {
  const target = resolve(String(path));
  if (!isInside(resolve(DATA), target)) {
    throw new Error(`refusing to write outside the data directory: ${target}`);
  }
  if (typeof text !== "string") throw new TypeError("atomicWrite expects a string");

  // Round-trip the payload when it claims to be JSON. Cheap, and it means a
  // half-serialised object can never reach disk.
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    JSON.parse(text);
  }

  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  // Without the fsync, a power cut between write and rename can leave a
  // zero-length file where a conversation used to be: the rename is durable,
  // the data behind it is not.
  try {
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* some filesystems refuse to fsync; the rename is still atomic */
  }
  renameSync(tmp, target);
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Parsed-file cache, keyed by absolute path.
 *
 * Every entry is handed out as a deep copy, so a caller that mutates what it
 * read cannot corrupt the cache for the next caller — the same guarantee the
 * old read-every-time behaviour gave for free.
 */
const cache = new Map();

function readCached(path, fallback) {
  if (cache.has(path)) return structuredClone(cache.get(path));
  const parsed = readJson(path, fallback);
  cache.set(path, parsed);
  return structuredClone(parsed);
}

/** Called by every writer so the next reader sees what was just written. */
function writeCached(path, value, text) {
  atomicWrite(path, text);
  cache.set(path, value);
}

export function invalidate(path) {
  if (path) cache.delete(path);
  else cache.clear();
}

/* ───────────────────────────── memory (facts) ──────────────────────────── */

const MEMORY_FILE = join(DATA, "memory.json");

export function loadMemory() {
  const m = readCached(MEMORY_FILE, null);
  return m && typeof m === "object"
    ? { facts: m.facts || [], profile: m.profile || {}, updatedAt: m.updatedAt || null }
    : { facts: [], profile: {}, updatedAt: null };
}

export function saveMemory(memory) {
  memory.updatedAt = new Date().toISOString();
  writeCached(MEMORY_FILE, memory, JSON.stringify(memory, null, 2));
  return memory;
}

/** Remember a fact once (case-insensitive dedupe), newest kept last. */
export function remember(text, tag = "general") {
  const memory = loadMemory();
  const clean = String(text || "").trim().slice(0, 500);
  if (!clean) return memory;
  if (!memory.facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) {
    memory.facts.push({ text: clean, tag, at: new Date().toISOString() });
  }
  if (memory.facts.length > 500) memory.facts = memory.facts.slice(-500);
  return saveMemory(memory);
}

export function forget(text) {
  const memory = loadMemory();
  const needle = String(text || "").toLowerCase();
  const before = memory.facts.length;
  memory.facts = memory.facts.filter((f) => !f.text.toLowerCase().includes(needle));
  return { memory: saveMemory(memory), removed: before - memory.facts.length };
}

/* ──────────────────────────── sessions (chats) ─────────────────────────── */

const SESSIONS = join(DATA, "sessions");

/**
 * A session id comes straight off an HTTP request, so it is the one piece of
 * user input that decides a file path. Allowlist the shape, refuse anything
 * that could walk out of `data/sessions`, then assert the result really is
 * inside it — belt, braces, and a check that does not depend on my regex being
 * perfect forever.
 */
export function sessionPath(id) {
  const raw = String(id ?? "");
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100).replace(/^\.+/, "_");
  const file = join(SESSIONS, `${safe}.json`);
  if (!resolve(file).startsWith(resolve(SESSIONS) + sep)) {
    throw new Error("invalid session id");
  }
  return file;
}

/** Search persisted user/assistant turns, never the stale parsed-file cache.
 * Literal, case-insensitive substring search; newest message timestamp first.
 * Empty queries return before any filesystem access. No query becomes a path.
 * Root/file symlinks are refused; O_NOFOLLOW guards the final component when
 * supported. Like the rest of this store, this is not a sandbox against a local
 * process concurrently replacing parent directories.
 */
export function searchSessions(query, { limit = 10 } = {}) {
  if (typeof query !== "string" || !query.trim()) return [];
  const needle = query.trim().toLowerCase();
  if (needle.length > 1000) return [];
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
  let root, entries;
  try {
    if (!lstatSync(SESSIONS).isDirectory()) return [];
    root = realpathSync(SESSIONS);
    entries = readdirSync(SESSIONS, { withFileTypes: true });
  } catch { return []; }
  const hits = [];
  // Stable ordering for equal/missing timestamps, independent of filesystem order.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,99}\.json$/.test(entry.name)) continue;
    const file = join(SESSIONS, entry.name);
    let fd;
    try {
      if (!lstatSync(file).isFile() || dirname(realpathSync(file)) !== root) continue;
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const info = fstatSync(fd);
      const maxBytes = 2 * 1024 * 1024;
      if (!info.isFile() || info.size > maxBytes) continue;
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0, n;
      while (size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null))) size += n;
      if (size > maxBytes) continue;
      const session = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      if (!Array.isArray(session?.messages)) continue;
      // Derive identity from the confined filename, never an untrusted JSON id.
      const sessionId = entry.name.slice(0, -5);
      for (const message of session.messages) {
        if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") continue;
        const at = message.content.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const text = message.content;
        const start = Math.max(0, at - 60);
        const prefix = start ? "…" : "";
        const available = 240 - prefix.length;
        let snippet = prefix + text.slice(start, start + available);
        if (start + available < text.length) snippet = snippet.slice(0, 239) + "…";
        const date = typeof message.at === "string" ? Date.parse(message.at) : NaN;
        const ts = Number.isFinite(date) ? new Date(date).toISOString() : null;
        hits.push({ sessionId, role: message.role, snippet, ts });
        hits.sort((a, b) => (b.ts === null ? -Infinity : Date.parse(b.ts)) - (a.ts === null ? -Infinity : Date.parse(a.ts)));
        if (hits.length > count) hits.length = count;
      }
    } catch { /* malformed, unreadable, deleted or replaced file: skip */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return hits;
}

export function loadSession(id) {
  return readCached(sessionPath(id), { id, messages: [], createdAt: new Date().toISOString() });
}

export function saveSession(id, session) {
  session.updatedAt = new Date().toISOString();
  // Keep the tail bounded: 200 messages is plenty of context and keeps
  // the file small enough to read on a Raspberry Pi.
  if (session.messages.length > 200) session.messages = session.messages.slice(-200);
  writeCached(sessionPath(id), session, JSON.stringify(session, null, 2));
  sessionIndex.set(session.id || String(id), {
    id: session.id || String(id),
    messages: session.messages.length,
    updatedAt: session.updatedAt,
    preview: previewOf(session),
  });
  return session;
}

export function appendMessage(id, message) {
  const session = loadSession(id);
  session.messages.push({ at: new Date().toISOString(), ...message });
  return saveSession(id, session);
}

function previewOf(session) {
  const last = [...(session.messages || [])].reverse().find((m) => m.role === "user");
  return last ? String(last.content).slice(0, 80) : "—";
}

/** Sidebar metadata, built once, then maintained by saveSession(). */
const sessionIndex = new Map();
let indexBuilt = false;

export function listSessions() {
  if (!existsSync(SESSIONS)) return [];
  if (!indexBuilt) {
    // One scan at boot. After this the panel reads memory, not 200 files.
    for (const file of readdirSync(SESSIONS)) {
      if (!file.endsWith(".json")) continue;
      const full = join(SESSIONS, file);
      const s = readJson(full, null);
      if (!s) continue;
      cache.set(full, s);
      sessionIndex.set(s.id || file.replace(/\.json$/, ""), {
        id: s.id || file.replace(/\.json$/, ""),
        messages: (s.messages || []).length,
        updatedAt: s.updatedAt || s.createdAt,
        preview: previewOf(s),
      });
    }
    indexBuilt = true;
  }
  return [...sessionIndex.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function deleteSession(id) {
  const path = sessionPath(id);
  if (existsSync(path)) unlinkSync(path);
  cache.delete(path);
  sessionIndex.delete(String(id));
}

/* ─────────────────────────── reminders/timers ──────────────────────────── */

const REMINDERS_FILE = join(DATA, "reminders.json");

export function loadReminders() {
  return readJson(REMINDERS_FILE, []);
}

function writeReminders(list) {
  atomicWrite(REMINDERS_FILE, JSON.stringify(list.slice(-500), null, 2));
  return list;
}

export function addReminder(reminder) {
  const list = loadReminders();
  list.push(reminder);
  writeReminders(list);
  return reminder;
}

export function updateReminder(id, patch) {
  const list = loadReminders();
  const index = list.findIndex((r) => r.id === id);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch };
  writeReminders(list);
  return list[index];
}

export function removeReminder(id) {
  const list = loadReminders();
  const next = list.filter((r) => r.id !== id);
  writeReminders(next);
  return list.length - next.length;
}

export function pendingReminders() {
  return loadReminders().filter((r) => !r.fired && !r.cancelled);
}

/* ──────────────────────── schedules (unattended runs) ──────────────────── */

const SCHEDULES_FILE = join(DATA, "schedules.json");

export function loadSchedules() {
  const list = readJson(SCHEDULES_FILE, []);
  return Array.isArray(list) ? list : [];
}

function writeSchedules(list) {
  writeCached(SCHEDULES_FILE, list.slice(0, 50), JSON.stringify(list.slice(0, 50), null, 2));
  return list;
}

export function saveSchedule(schedule) {
  const list = loadSchedules();
  const index = list.findIndex((s) => s.id === schedule.id);
  if (index === -1) list.push(schedule);
  else list[index] = schedule;
  writeSchedules(list);
  return schedule;
}

export function updateSchedule(id, patch) {
  const list = loadSchedules();
  const index = list.findIndex((s) => s.id === id);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch };
  writeSchedules(list);
  return list[index];
}

export function removeSchedule(id) {
  const list = loadSchedules();
  const next = list.filter((s) => s.id !== id);
  writeSchedules(next);
  return list.length - next.length;
}

/* ─────────────────────────── tasks (agent queue) ───────────────────────── */

const TASKS_FILE = join(DATA, "tasks.json");

export function loadTasks() {
  return readJson(TASKS_FILE, []);
}

export function saveTask(task) {
  const tasks = loadTasks();
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i === -1) tasks.unshift(task);
  else tasks[i] = task;
  atomicWrite(TASKS_FILE, JSON.stringify(tasks.slice(0, 100), null, 2));
  return task;
}
