/**
 * test/batch2.test.js — the second round of review fixes.
 *
 * The first round (test/hardening.test.js) closed the two exploitable holes.
 * This round is the rest of the list: the things that were wrong rather than
 * dangerous, plus the two the review named as "next".
 *
 *   budget.js       the context window is now budgeted instead of hoped for
 *   validateArgs()  a tool call is checked against its own schema before it runs
 *   approvals       scoped to a session, not to a channel name
 *   store.js        reads are cached, so a turn no longer re-parses four times
 *   attachments     queued per owner, and remembered across the next turn
 *   telemetry       every turn is recorded, and /api/health reports the numbers
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "pinch-batch2-"));
process.env.PINCH_DATA = dataDir;

/* ─────────────────────────── context budget ────────────────────────────── */

test("budget: the system prompt is never the thing that gets dropped", async () => {
  const { fit } = await import("../src/budget.js");
  const system = { role: "system", content: "SYSTEM-PROMPT-MARKER " + "s".repeat(2000) };
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `message ${i} ` + "x".repeat(2000),
  }));

  const { messages, dropped, tokens } = fit([system, ...history], { tools: [], numCtx: 8192, numPredict: 1024 });

  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /SYSTEM-PROMPT-MARKER/, "the system prompt was truncated away");
  assert.ok(dropped > 0, "nothing was dropped, so this proves nothing");
  assert.ok(tokens < 8192, `still over the window: ${tokens}`);
  // The newest message survives; old ones go.
  assert.match(messages.at(-1).content, /message 39/);
  // And the model is told the history is incomplete rather than quietly losing it.
  assert.ok(messages.some((m) => /earlier messages? omitted/.test(m.content)));
});

test("budget: a tool result never survives without its assistant call", async () => {
  const { fit } = await import("../src/budget.js");
  const big = "y".repeat(6000);
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: big },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "ls" } }] },
    { role: "tool", name: "shell", toolCallId: "c1", content: big },
    { role: "user", content: "and now?" },
  ];
  const { messages: out } = fit(messages, { numCtx: 8192, numPredict: 500 });
  // Whatever survives, it must not begin with an orphaned tool message.
  assert.notEqual(out[1].role, "tool");
});

test("budget: a small conversation is untouched", async () => {
  const { fit } = await import("../src/budget.js");
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ];
  const { messages: out, dropped } = fit(messages, { numCtx: 8192 });
  assert.deepEqual(out, messages);
  assert.equal(dropped, 0);
});

/* ────────────────────── the tool argument contract ─────────────────────── */

test("validateArgs: a missing required argument is refused before it runs", async () => {
  const { validateArgs } = await import("../src/agent.js");
  const tool = { name: "write_file", parameters: { properties: { path: {}, content: {} }, required: ["path", "content"] } };
  const msg = validateArgs(tool, { path: "a.txt" });
  assert.match(msg, /Missing required argument: content/);
  assert.match(msg, /write_file/, "the model is told which tool to re-call");
});

test("validateArgs: an invented argument name is refused", async () => {
  const { validateArgs } = await import("../src/agent.js");
  const tool = { name: "read_file", parameters: { properties: { path: {}, lines: {} }, required: ["path"] } };
  const msg = validateArgs(tool, { path: "a.txt", filename: "a.txt" });
  assert.match(msg, /Unknown argument.*filename/);
  assert.match(msg, /Allowed: path, lines/);
});

test("validateArgs: a valid call passes, including optional arguments", async () => {
  const { validateArgs } = await import("../src/agent.js");
  const tool = { name: "read_file", parameters: { properties: { path: {}, lines: {} }, required: ["path"] } };
  assert.equal(validateArgs(tool, { path: "a.txt" }), null);
  assert.equal(validateArgs(tool, { path: "a.txt", lines: 10 }), null);
});

test("bad JSON arguments are reported, not silently emptied", async () => {
  const { parseArgs } = await import("../src/brain.js");
  const bad = parseArgs('{"path": "a.txt",}');
  assert.ok(bad.error, "a trailing comma was accepted silently");
  assert.deepEqual(bad.value, {});

  const good = parseArgs('{"path": "a.txt"}');
  assert.equal(good.error, null);
  assert.equal(good.value.path, "a.txt");
});

/* ───────────────────── approvals belong to a session ───────────────────── */

test("an approval is answered by its own session, not by whoever says yes first", async () => {
  const { createApproval, answerApprovalFor, pendingApprovalsFor, answerApproval } = await import("../src/agent.js");

  const a = createApproval({ channel: "telegram", sessionId: "telegram-chat-A", description: "run: rm -rf build" });
  const b = createApproval({ channel: "telegram", sessionId: "telegram-chat-B", description: "run: npm publish" });

  assert.equal(pendingApprovalsFor("telegram-chat-A").length, 1);

  // A yes in chat B must answer B's prompt, never A's.
  assert.equal(answerApprovalFor({ sessionId: "telegram-chat-B", channel: "telegram" }, true), true);

  const bResult = await b.promise;
  const aPending = pendingApprovalsFor("telegram-chat-A");
  assert.equal(bResult, true);
  assert.equal(aPending.length, 1, "chat A's prompt was consumed by chat B's yes");

  answerApproval(a.id, false);
  assert.equal(await a.promise, false);
});

/* ──────────────────────────── store caching ────────────────────────────── */

test("the session cache returns what was just written, and it is a copy", async () => {
  const { ensureData, appendMessage, loadSession, invalidate } = await import("../src/store.js");
  ensureData();
  invalidate();

  appendMessage("cache-check", { role: "user", content: "first" });
  const one = loadSession("cache-check");
  assert.equal(one.messages.length, 1);

  // Mutation must not leak into the cache.
  one.messages.push({ role: "user", content: "tampered" });
  assert.equal(loadSession("cache-check").messages.length, 1, "a caller mutated the cache");

  appendMessage("cache-check", { role: "assistant", content: "second" });
  assert.equal(loadSession("cache-check").messages.length, 2);
});

test("reads are cached: a repeat load does not touch the disk", async () => {
  const { ensureData, saveSession, loadSession, invalidate, sessionPath } = await import("../src/store.js");
  ensureData();
  invalidate();
  saveSession("read-count", { id: "read-count", messages: [{ role: "user", content: "hi" }], createdAt: new Date().toISOString() });

  // Delete the file behind the cache: a cached read still answers, a disk read
  // would fall back to an empty session.
  const path = sessionPath("read-count");
  const first = loadSession("read-count");
  assert.equal(first.messages.length, 1);
  rmSync(path, { force: true });
  try {
    assert.equal(loadSession("read-count").messages.length, 1, "the cache was not used");
  } finally {
    saveSession("read-count", first);
  }
});

test("listSessions keeps its index in step with saves and deletes", async () => {
  const { ensureData, saveSession, listSessions, deleteSession, invalidate } = await import("../src/store.js");
  ensureData();
  invalidate();
  saveSession("index-a", { id: "index-a", messages: [{ role: "user", content: "hello" }], createdAt: new Date().toISOString() });
  const entry = listSessions().find((s) => s.id === "index-a");
  assert.ok(entry, "a new session did not reach the sidebar index");
  assert.equal(entry.messages, 1);
  assert.match(entry.preview, /hello/);

  deleteSession("index-a");
  assert.ok(!listSessions().some((s) => s.id === "index-a"), "a deleted session stayed in the index");
});

/* ───────────────────── attachments: owner + memory ─────────────────────── */

test("an attachment queued by one owner cannot be taken by another", async () => {
  const { putAttachment, takeAttachments, extract, clearAttachments } = await import("../src/attachments.js");
  clearAttachments();

  const id = putAttachment(extract(Buffer.from("secret notes"), "a.txt"), "session-A");
  assert.equal(takeAttachments([id], "session-B").length, 0, "another session consumed the file");
  const taken = takeAttachments([id], "session-A");
  assert.equal(taken.length, 1);
  assert.match(taken[0].text, /secret notes/);
});

test("an attachment id carries 72 bits of randomness and does not collide", async () => {
  const { putAttachment, extract, clearAttachments } = await import("../src/attachments.js");
  clearAttachments();

  // This test used to `split("_")` and assert on the tail. base64url contains
  // "_", so whether it passed depended on the random bytes — it failed on Node
  // 22 and 24 in CI and passed on 26. Same code, different bytes, different
  // answer: that is a test telling you nothing. Assert the format, and the
  // property that actually matters.
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = putAttachment(extract(Buffer.from("x"), "a.txt"), "s");
    const tail = id.slice(id.lastIndexOf("_") + 1);
    assert.match(tail, /^[0-9a-f]{18}$/, `id tail is not 18 hex characters: ${tail}`);
    ids.add(id);
  }
  assert.equal(ids.size, 200, "two ids collided");
});

/* ─────────────────────────── telemetry ─────────────────────────────────── */

test("a completed turn is recorded, and health reports the numbers", async () => {
  const { record, stats, reset } = await import("../src/telemetry.js");
  reset();
  record({ kind: "turn", ms: 120, rounds: 1, tokens: 900, tools: 0, guardFlags: 0 });
  record({ kind: "turn", ms: 380, rounds: 2, tokens: 1500, tools: 1, guardFlags: 1 });
  const s = stats();
  assert.equal(s.turns, 2);
  assert.ok(s.p50Ms >= 120 && s.p50Ms <= 380);
  assert.equal(s.guardFlagRate, 0.5);
  assert.equal(s.errorRate, 0);
});

test("telemetry never writes the message text", async () => {
  const { record, TELEMETRY_FILE, reset } = await import("../src/telemetry.js");
  reset();
  record({ kind: "turn", ms: 5, rounds: 1, tokens: 10, tools: 0, guardFlags: 0, sessionId: "s1" });
  const line = readFileSync(TELEMETRY_FILE, "utf8").trim().split("\n").pop();
  assert.ok(!line.includes("content"), "the log carries message content");
  assert.ok(line.includes("\"ms\":5"));
});

/* ───────────────────── the whole thing, over HTTP ──────────────────────── */

let pinch;
let pinchPort;
let pinchData;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  pinchData = mkdtempSync(join(tmpdir(), "pinch-batch2-live-"));
  const probe = createServer();
  pinchPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  pinch = spawn(process.execPath, [join(ROOT, "src/index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PINCH_DATA: pinchData,
      PINCH_PORT: String(pinchPort),
      PINCH_HOST: "127.0.0.1",
      PINCH_WORKSPACE: pinchData,
      LLM_PROVIDER: "mock",
      PINCH_GUARD: "off",
    },
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${pinchPort}/api/health`);
});

after(() => {
  pinch?.kill("SIGKILL");
  rmSync(pinchData, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("health reports the budget and the turn statistics", async () => {
  const health = await (await fetch(`http://127.0.0.1:${pinchPort}/api/health`)).json();
  assert.equal(health.contextWindow.tokens, 8192);
  assert.ok(health.contextWindow.reserveForReply > 0);
  assert.ok(health.turns !== undefined, "health does not report turn statistics");

  // A turn, then the numbers move.
  await (await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello there", sessionId: "stats" }),
  })).text();

  const after = await (await fetch(`http://127.0.0.1:${pinchPort}/api/health`)).json();
  assert.equal(after.turns.turns, 1, "the turn was not recorded");
  assert.ok(after.turns.p50Ms >= 0);
});

test("a document is still readable one turn later, marked as history", async () => {
  const upload = await fetch(`http://127.0.0.1:${pinchPort}/api/attach`, {
    method: "POST",
    headers: { "x-filename": "invoice.txt", "x-pinch-session": "followup" },
    body: Buffer.from("Invoice 4471 · total 1,240.00 · due 14 November"),
  });
  const { id } = await upload.json();

  await (await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "what is the total?", sessionId: "followup", attachments: [id] }),
  })).text();

  // Second turn, no attachment this time.
  await (await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "and when is it due?", sessionId: "followup" }),
  })).text();

  const stored = await (await fetch(`http://127.0.0.1:${pinchPort}/api/session/followup`)).json();
  const first = stored.messages.find((m) => m.attachments?.length);
  assert.ok(first, "the attachment was not recorded on the message");
  assert.match(first.excerpt, /1,240\.00/, "the extracted text was not kept");
  assert.equal(first.attachments[0].name, "invoice.txt");
});
