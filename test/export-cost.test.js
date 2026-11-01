import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pinch-export-"));
process.env.PINCH_DATA = dataDir;
process.env.LLM_PROVIDER = "mock";

const { ensureData, remember, appendMessage, addReminder, saveSchedule } = await import("../src/store.js");
const { buildExport, writeExport, describeExport, EXPORT_VERSION } = await import("../src/export.js");
const { costSummary, costReport, priceFor, costOfTurn, PRICES } = await import("../src/cost.js");

ensureData();

/* ───────────────────────── export ──────────────────────────────────────── */

test("an export carries every kind of thing Pinch knows about you", () => {
  remember("deploys happen on Fridays");
  appendMessage("s-export-1", { role: "user", content: "hello" });
  appendMessage("s-export-1", { role: "assistant", content: "hi" });
  addReminder({ id: "r1", text: "stretch", at: new Date(Date.now() + 60_000).toISOString(), address: "web:main", fired: false });
  saveSchedule({
    id: "sch1",
    task: "check CI",
    when: "daily at 09:00",
    cadence: { kind: "daily", minuteOfDay: 540, label: "daily at 09:00" },
    address: "web:main",
    runs: 0,
  });

  const doc = buildExport();
  assert.equal(doc.$schema, "pinch-export/1");
  assert.equal(doc.version, EXPORT_VERSION);
  assert.match(doc.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.ok(doc.memory.facts.some((f) => /Fridays/i.test(f.text)), "a memory fact survives");
  const session = doc.sessions.find((s) => s.id === "s-export-1");
  assert.ok(session, "the session is there");
  assert.equal(session.messages.length, 2);
  assert.equal(doc.reminders.length, 1);
  assert.equal(doc.schedules.length, 1);
  assert.equal(doc.counts.messages >= 2, true);
});

test("telemetry is excluded unless asked for, because it is not 'your data'", () => {
  writeFileSync(
    join(dataDir, "telemetry.ndjson"),
    `${JSON.stringify({ at: new Date().toISOString(), kind: "turn", tokens: 100, ms: 10 })}\n`
  );
  assert.equal(buildExport().telemetry, null, "default excludes the log");
  const withLog = buildExport({ includeTelemetry: true });
  assert.equal(withLog.telemetry.length, 1);
  assert.equal(withLog.counts.telemetryTurns, 1);
});

test("optional telemetry skips corrupt lines and preserves readable records", () => {
  const path = join(dataDir, "telemetry.ndjson");
  const previous = readFileSync(path, "utf8");
  const record = { kind: "turn", model: "local-test", tokens: 12 };
  try {
    writeFileSync(path, `{not json}\n${JSON.stringify(record)}\n\n{broken too}\n`);
    const doc = buildExport({ includeTelemetry: true });
    assert.deepEqual(doc.telemetry, [record]);
    assert.equal(doc.counts.telemetryTurns, 1);
    assert.equal(buildExport().telemetry, null);
    rmSync(path);
    assert.deepEqual(buildExport({ includeTelemetry: true }).telemetry, []);
  } finally {
    writeFileSync(path, previous);
  }
});

test("an export never contains .env, keys, or the config object", () => {
  const json = JSON.stringify(buildExport({ includeTelemetry: true }));
  for (const leak of ["PINCH_KEY", "OPENAI_API_KEY", "TELEGRAM_TOKEN", ".env", "apiKey"]) {
    assert.equal(json.includes(leak), false, `export leaked ${leak}`);
  }
});

test("a corrupt session file does not abort the whole export", () => {
  writeFileSync(join(dataDir, "sessions", "broken.json"), "{not json at all");
  const doc = buildExport();
  assert.ok(Array.isArray(doc.sessions), "the export still produces sessions");
});

test("writing an export puts it at the path asked for, readable only by its owner", () => {
  const out = join(dataDir, "nested", "backup.json");
  const res = writeExport({ path: out });
  assert.equal(res.path, out);
  assert.equal(existsSync(out), true);
  const parsed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(parsed.$schema, "pinch-export/1");
  // 0600: this file is your conversations. Other users on the box should not read it.
  if (process.platform !== "win32") {
    assert.equal(statSync(out).mode & 0o077, 0, "export file must not be group/world readable");
  }
  assert.match(describeExport(res), /sessions\s+\d+/);
});

/* ───────────────────────── cost ────────────────────────────────────────── */

test("a local model costs nothing, and says so rather than guessing", () => {
  const p = priceFor({ provider: "ollama", model: "qwen2.5-coder:7b" });
  assert.equal(p.known, true);
  assert.equal(p.local, true);
  const c = costOfTurn({ provider: "ollama", model: "qwen2.5-coder:7b", tokens: 5000 });
  assert.equal(c.state, "local");
  assert.equal(c.low, 0);
  assert.equal(c.high, 0);
});

test("a known cloud model is priced, and a suffixed name still matches", () => {
  assert.equal(priceFor({ provider: "openai", model: "gpt-4o-mini" }).known, true);
  const dated = priceFor({ provider: "openai", model: "gpt-4o-mini-2024-07-18" });
  assert.equal(dated.known, true);
  assert.equal(dated.model, "gpt-4o-mini");
});

test("an unknown model reports unknown — never zero, which would read as free", () => {
  const c = costOfTurn({ provider: "openai", model: "some-new-model", tokens: 1000 });
  assert.equal(c.state, "unknown");
  assert.equal(c.low, undefined, "no price is invented for a model that is not in the table");
});

test("cost is a range, because telemetry has no input/output split", () => {
  const c = costOfTurn({ provider: "openai", model: "gpt-4o", tokens: 1_000_000 });
  assert.equal(c.low, PRICES["gpt-4o"].in);
  assert.equal(c.high, PRICES["gpt-4o"].out);
  assert.ok(c.high > c.low);
});

test("the summary separates priced, local and unknown turns instead of lumping them", () => {
  writeFileSync(
    join(dataDir, "telemetry.ndjson"),
    [
      { at: new Date().toISOString(), kind: "turn", provider: "openai", model: "gpt-4o", tokens: 1000 },
      { at: new Date().toISOString(), kind: "turn", provider: "ollama", model: "qwen2.5-coder:7b", tokens: 4000 },
      { at: new Date().toISOString(), kind: "turn", provider: "openai", model: "mystery-model", tokens: 500 },
      { at: new Date().toISOString(), kind: "session", tokens: 9999 },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n"
  );

  const s = costSummary({ days: 30 });
  assert.equal(s.turns, 3, "only kind=turn records count");
  assert.equal(s.tokens, 5500);
  assert.equal(s.localTurns, 1);
  assert.equal(s.unknownTurns, 1);
  assert.ok(s.low > 0 && s.high > s.low);
  assert.equal(s.priceTableDate, "2026-11-01");
});

test("the window is respected", () => {
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
  writeFileSync(
    join(dataDir, "telemetry.ndjson"),
    JSON.stringify({ at: old, kind: "turn", provider: "ollama", model: "x", tokens: 10 }) + "\n"
  );
  assert.equal(costSummary({ days: 30 }).turns, 0, "a 90-day-old turn is outside a 30-day window");
  assert.equal(costSummary({ days: 365 }).turns, 1);
});

test("an empty window says so instead of printing a confident zero", () => {
  writeFileSync(join(dataDir, "telemetry.ndjson"), "");
  const text = costReport({ days: 30 });
  assert.match(text, /No turns recorded/);
  assert.doesNotMatch(text, /\$0\.00/, "an empty log is not the same as having spent nothing");
});

test("the report is readable and never claims a precise number it cannot know", () => {
  writeFileSync(
    join(dataDir, "telemetry.ndjson"),
    [
      { at: new Date().toISOString(), kind: "turn", provider: "openai", model: "gpt-4o", tokens: 1000 },
      { at: new Date().toISOString(), kind: "turn", provider: "ollama", model: "qwen2.5-coder:7b", tokens: 4000 },
      { at: new Date().toISOString(), kind: "turn", provider: "openai", model: "mystery-model", tokens: 500 },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n"
  );
  const text = costReport({ days: 30 });
  assert.match(text, /unknown model|free|Spent/);
  assert.doesNotMatch(text, /exactly/i);
  const json = JSON.parse(costReport({ days: 30, json: true }));
  assert.equal(json.days, 30);
});

process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
