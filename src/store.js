/**
 * store.js — Pinch's memory, on disk, in plain JSON.
 *
 * No database, no cloud, no telemetry: data/ is yours. Files are
 * written atomically (tmp + rename) so a crash mid-write cannot
 * corrupt your conversation history.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { config } from "./config.js";

const DATA = config.dataDir;

export function ensureData() {
  mkdirSync(DATA, { recursive: true });
  mkdirSync(join(DATA, "sessions"), { recursive: true });
}

function atomicWrite(path, text) {
  // Cheap, idempotent, and means callers never have to think about mkdir.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/* ───────────────────────────── memory (facts) ──────────────────────────── */

const MEMORY_FILE = join(DATA, "memory.json");

export function loadMemory() {
  const m = readJson(MEMORY_FILE, null);
  return m && typeof m === "object"
    ? { facts: m.facts || [], profile: m.profile || {}, updatedAt: m.updatedAt || null }
    : { facts: [], profile: {}, updatedAt: null };
}

export function saveMemory(memory) {
  memory.updatedAt = new Date().toISOString();
  atomicWrite(MEMORY_FILE, JSON.stringify(memory, null, 2));
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

export function loadSession(id) {
  return readJson(sessionPath(id), { id, messages: [], createdAt: new Date().toISOString() });
}

export function saveSession(id, session) {
  session.updatedAt = new Date().toISOString();
  // Keep the tail bounded: 200 messages is plenty of context and keeps
  // the file small enough to read on a Raspberry Pi.
  if (session.messages.length > 200) session.messages = session.messages.slice(-200);
  atomicWrite(sessionPath(id), JSON.stringify(session, null, 2));
  return session;
}

export function appendMessage(id, message) {
  const session = loadSession(id);
  session.messages.push({ at: new Date().toISOString(), ...message });
  return saveSession(id, session);
}

export function listSessions() {
  if (!existsSync(SESSIONS)) return [];
  return readdirSync(SESSIONS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const s = readJson(join(SESSIONS, f), null);
      if (!s) return null;
      const last = [...s.messages].reverse().find((m) => m.role === "user");
      return {
        id: s.id || f.replace(/\.json$/, ""),
        messages: s.messages.length,
        updatedAt: s.updatedAt || s.createdAt,
        preview: last ? String(last.content).slice(0, 80) : "—",
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function deleteSession(id) {
  const path = sessionPath(id);
  if (existsSync(path)) unlinkSync(path);
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
