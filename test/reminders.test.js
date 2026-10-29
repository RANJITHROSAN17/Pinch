/**
 * Reminders end to end: the tool parses a phrase, stores it, the scheduler
 * fires it, and the outbound registry delivers it to the address that asked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-rem-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-rem-data-"));
process.env.LLM_PROVIDER = "mock";

const { TOOL_MAP } = await import("../src/tools.js");
const { registerSender, sendTo } = await import("../src/outbound.js");
const { tick } = await import("../src/scheduler.js");
const { pendingReminders, loadReminders, updateReminder } = await import("../src/store.js");

const ctx = { channel: "web", target: "web:main", sessionId: "s1" };

test("remind stores a parsed time against the asking chat", async () => {
  const out = await TOOL_MAP.get("remind").run({ text: "drink water", when: "in 30 minutes" }, ctx);
  assert.equal(out.ok, true);
  const list = pendingReminders();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "drink water");
  assert.equal(list[0].address, "web:main");
  const delta = new Date(list[0].at).getTime() - Date.now();
  assert.ok(delta > 29 * 60000 && delta <= 30 * 60000, `unexpected delta ${delta}`);
});

test("an unparseable time is refused rather than guessed", async () => {
  const out = await TOOL_MAP.get("remind").run({ text: "call mom", when: "whenever" }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.output, /could not understand/i);
  assert.match(out.output, /ask the user/i);
  assert.equal(pendingReminders().length, 1, "nothing new should have been stored");
});

test("the scheduler fires a due reminder to its channel", async () => {
  const delivered = [];
  registerSender("web", async (target, text) => delivered.push({ target, text }));

  const list = loadReminders();
  updateReminder(list[0].id, { at: new Date(Date.now() - 120_000).toISOString() });

  const fired = await tick();
  assert.equal(fired, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].target, "main");
  assert.match(delivered[0].text, /drink water/);
  assert.match(delivered[0].text, /late by 2 min/);
  assert.equal(pendingReminders().length, 0);
});

test("a dead channel falls back to the web panel instead of vanishing", async () => {
  const delivered = [];
  registerSender("web", async (target, text) => delivered.push(text));
  await TOOL_MAP.get("remind").run({ text: "stretch", when: "in 1 minute" }, { channel: "telegram", target: "telegram:999" });
  const r = pendingReminders()[0];
  updateReminder(r.id, { at: new Date(Date.now() - 1000).toISOString() });

  await tick();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /stretch/);
  assert.match(delivered[0], /could not reach telegram:999/);
});

test("sendTo rejects addresses that are not registered", async () => {
  const res = await sendTo("nowhere:1", "hi");
  assert.equal(res.ok, false);
  assert.match(res.error, /no live sender/);
});

test("cancel_reminder removes matching pending reminders", async () => {
  await TOOL_MAP.get("remind").run({ text: "pay electricity bill", when: "in 2 hours" }, ctx);
  const out = await TOOL_MAP.get("cancel_reminder").run({ query: "electricity" });
  assert.equal(out.ok, true);
  assert.equal(pendingReminders().length, 0);
});
