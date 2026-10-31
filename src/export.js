/**
 * export.js — everything Pinch knows about you, in one file you can read.
 *
 * The README makes a promise: "your conversations are JSON files in data/ —
 * `rm -rf data` is a valid uninstall". That promise is only worth something if
 * the data is portable, and a directory of ad-hoc JSON is not. This produces one
 * document with a version, so leaving is a supported operation rather than a
 * salvage one.
 *
 * What it deliberately does NOT do:
 *
 *   - It does not read `.env`. That file holds your keys, and an export is a
 *     thing you email to yourself — the two should never be the same file.
 *   - It does not include `telemetry.ndjson` unless asked. That file is a log of
 *     every turn's timing; it is not part of "your data" in the sense a reader
 *     means, and including it by default makes the archive bigger and stranger.
 *   - It does not upload anything or write outside the path you name.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config, ROOT } from "./config.js";
import { loadMemory, loadReminders, loadSchedules, listSessions, loadSession } from "./store.js";

export const EXPORT_VERSION = 1;

/** Read a JSON file, or return a fallback. A corrupt file must not abort an export. */
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Build the export as a plain object. Pure with respect to the filesystem: it
 * reads, sorts, and returns. Writing is the caller's job.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeTelemetry] default false
 */
export function buildExport({ includeTelemetry = false } = {}) {
  const memories = loadMemory();
  const reminders = loadReminders();
  const schedules = loadSchedules();

  // listSessions() returns index rows, not full sessions; loadSession() is what
  // has the messages. Sorted by id so two exports of the same data produce the
  // same bytes and a diff shows only what actually changed.
  const sessions = listSessions()
    .map((row) => loadSession(row.id))
    .filter((s) => s && Array.isArray(s.messages))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const profilePath = config.profilePath;
  const profile = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";

  const doc = {
    $schema: "pinch-export/1",
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    generator: { name: "pinch", from: ROOT.replace(/.*[\\/]/, "") },
    counts: {
      sessions: sessions.length,
      messages: sessions.reduce((n, s) => n + (s.messages?.length || 0), 0),
      memories: memories.facts?.length || 0,
      reminders: reminders.length,
      schedules: schedules.length,
      profileChars: profile.length,
    },
    profile,
    memory: memories,
    reminders,
    schedules,
    sessions,
    telemetry: null,
  };

  if (includeTelemetry) {
    const path = join(config.dataDir, "telemetry.ndjson");
    doc.telemetry = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [];
    doc.counts.telemetryTurns = doc.telemetry.length;
  }

  return doc;
}

/**
 * Write the export. Returns a summary rather than the document, because a CLI
 * that prints the whole archive to the terminal is a CLI nobody uses.
 */
export function writeExport({ path, includeTelemetry = false } = {}) {
  const doc = buildExport({ includeTelemetry });
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (path) {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, json, { mode: 0o600 });
    return { path: abs, bytes: Buffer.byteLength(json), counts: doc.counts };
  }
  return { path: null, bytes: Buffer.byteLength(json), counts: doc.counts, json };
}

/** Human summary for the CLI. */
export function describeExport({ path, bytes, counts }) {
  const kb = (bytes / 1024).toFixed(1);
  return [
    `sessions   ${counts.sessions} (${counts.messages} messages)`,
    `memories   ${counts.memories}`,
    `reminders  ${counts.reminders}`,
    `schedules  ${counts.schedules}`,
    counts.telemetryTurns !== undefined ? `telemetry  ${counts.telemetryTurns} turns` : `telemetry  not included`,
    path ? `written    ${path} · ${kb} KB` : `size       ${kb} KB on stdout — save it with: pinch export > backup.json`,
  ].join("\n");
}

/** Sessions the export would contain — used by the CLI to warn before writing. */
export function sessionCount() {
  try {
    return readdirSync(join(config.dataDir, "sessions")).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
