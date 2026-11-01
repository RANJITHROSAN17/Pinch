/**
 * End-to-end agent tests against the mock brain: the tool loop, the
 * permission gate, and the fact that a denied action really does not run.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const sandbox = mkdtempSync(join(tmpdir(), "pinch-agent-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-data-"));
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_AUTO_APPROVE = "false";

const modelRequests = [];
let tagsFail = false;
const modelServer = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(tagsFail ? 503 : 200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }, { name: "coder:7b" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests.push({ path: req.url, body });
  const local = req.url === "/api/chat";
  const toolRound = local && body.messages.some((m) => m.role === "user" && m.content === "force-tool-loop") && !body.messages.some((m) => m.role === "tool");
  const message = toolRound
    ? { content: "", tool_calls: [{ function: { name: "calculator", arguments: { expression: "2+2" } } }] }
    : { content: `${local ? "local" : "cloud"} ${body.model}` };
  if (local) {
    res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
    return res.end(JSON.stringify({ message, done: true }) + (body.stream ? "\n" : ""));
  }
  if (body.stream) {
    res.setHeader("content-type", "text/event-stream");
    return res.end(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message }] }));
});
await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
process.env.OLLAMA_URL = modelBase;
process.env.OPENAI_BASE_URL = `${modelBase}/v1`;
process.env.OPENAI_API_KEY = "test-model-key";
after(async () => { modelServer.closeAllConnections(); await new Promise((r) => modelServer.close(r)); });

const { runAgent, answerApproval } = await import("../src/agent.js");

test("agent runs a safe tool and reports its result", async () => {
  const events = [];
  const result = await runAgent({
    sessionId: "test-safe",
    text: "calc (1200 * 1.18) / 3",
    onEvent: (e) => events.push(e),
  });
  assert.ok(result.trace.some((t) => t.tool === "calculator" && t.ok));
  assert.match(result.text, /472/);
  assert.ok(events.some((e) => e.type === "tool" && e.name === "calculator"));
});

test("dangerous tool asks permission and runs when allowed", async () => {
  let askedId = null;
  const result = await runAgent({
    sessionId: "test-allow",
    text: "run echo lobster-ok",
    onEvent: (e) => {
      if (e.type === "approval") {
        askedId = e.id;
        answerApproval(e.id, true); // simulate the user tapping Allow
      }
    },
  });
  assert.ok(askedId, "an approval prompt should have been raised");
  assert.match(result.text, /lobster-ok/);
});

test("dangerous tool is blocked when the user denies", async () => {
  const marker = join(sandbox, "should-not-exist.txt");
  const result = await runAgent({
    sessionId: "test-deny",
    text: `run touch ${marker}`,
    onEvent: (e) => {
      if (e.type === "approval") answerApproval(e.id, false);
    },
  });
  assert.equal(existsSync(marker), false, "denied command must not execute");
  assert.ok(result.trace.some((t) => t.denied));
});

test("shell output is captured into the conversation", async () => {
  const result = await runAgent({
    sessionId: "test-shell",
    text: "run ls",
    onEvent: (e) => {
      if (e.type === "approval") answerApproval(e.id, true);
    },
  });
  const shell = result.trace.find((t) => t.tool === "shell");
  assert.ok(shell, "shell should have run");
  assert.equal(shell.ok, true);
});

test("path escapes are refused even inside a shell-free tool", async () => {
  const result = await runAgent({
    sessionId: "test-escape",
    text: "read /etc/passwd",
    onEvent: (e) => {
      if (e.type === "approval") answerApproval(e.id, true);
    },
  });
  const read = result.trace.find((t) => t.tool === "read_file");
  assert.ok(read, "read_file should have been attempted");
  assert.match(String(read.output), /outside the allowed workspace/);
});


test("models: switch local/cloud requests without writing .env; invalid changes are atomic", async () => {
  const { brain } = await import("../src/brain.js");
  const envBefore = existsSync(".env") ? readFileSync(".env", "utf8") : null;
  try {
    const available = await brain.probe({ fresh: true });
    assert.deepEqual(available.ollama.models, ["fast:latest", "coder:7b"]);
    assert.deepEqual(await brain.setModel({ provider: "ollama", model: "fast" }), { provider: "ollama", model: "fast:latest" });
    assert.match((await brain.chat([{ role: "user", content: "hello" }])).content, /local fast:latest/);
    const snapshot = brain.active;
    assert.ok(Object.isFrozen(snapshot));
    await assert.rejects(brain.setModel({ provider: "ollama", model: "not-installed" }), /not installed/);
    await assert.rejects(brain.setModel({ provider: "__proto__", model: "bad" }), /Provider/);
    await assert.rejects(brain.setModel({ provider: "ollama", model: "bad name" }), /Model must use/);
    await assert.rejects(brain.setModel({ provider: "ollama", model: "coder:7b", url: "https://attacker.invalid" }), /Only provider and model/);
    await assert.rejects(brain.setModel({ provider: "openai", model: "<svg/onload=alert(1)>" }), /Model must use/);
    assert.deepEqual(brain.active, snapshot);
    await brain.setModel({ provider: "openai", model: "cloud-code" });
    assert.match((await brain.chat([{ role: "user", content: "hello" }])).content, /cloud cloud-code/);
    assert.equal(modelRequests.at(-1).path, "/v1/chat/completions");
    assert.equal(existsSync(".env") ? readFileSync(".env", "utf8") : null, envBefore);
  } finally { brain.resetModel(); }
});

test("models: unavailable Ollama leaves the active model unchanged", async () => {
  const { brain } = await import("../src/brain.js");
  const before = brain.active;
  tagsFail = true;
  try {
    await assert.rejects(brain.setModel({ provider: "ollama", model: "coder:7b" }), /unreachable/);
    assert.deepEqual(brain.active, before);
  } finally { tagsFail = false; brain.resetModel(); }
});

test("models: an in-flight tool loop keeps its provider/model; next turn uses the switch", async () => {
  const { brain } = await import("../src/brain.js");
  try {
    await brain.setModel({ provider: "ollama", model: "coder:7b" });
    const start = modelRequests.length;
    const result = await runAgent({ sessionId: "model-snapshot", text: "force-tool-loop", onEvent(event) {
      if (event.type === "tool") void brain.setModel({ provider: "openai", model: "cloud-next" });
    } });
    assert.ok(result.trace.some((t) => t.tool === "calculator"));
    assert.match(result.text, /local coder:7b/);
    assert.equal(modelRequests.length - start, 2);
    assert.ok(modelRequests.slice(start).every((r) => r.path === "/api/chat" && r.body.model === "coder:7b"));
    const next = await runAgent({ sessionId: "model-next", text: "hello" });
    assert.match(next.text, /cloud cloud-next/);
    const rows = readFileSync(join(process.env.PINCH_DATA, "telemetry.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.find((r) => r.sessionId === "model-snapshot").model, "coder:7b");
    assert.equal(rows.find((r) => r.sessionId === "model-next").model, "cloud-next");
  } finally { brain.resetModel(); }
});

test("models: /model is shared by every channel without calling the LLM", async () => {
  const { brain } = await import("../src/brain.js");
  const { routeMessage } = await import("../src/channels/router.js");
  try {
    for (const channel of ["telegram", "discord", "slack", "whatsapp", "web"]) {
      const replies = [];
      const start = modelRequests.length;
      const show = await routeMessage({ channel, text: "/model", send: async (text) => replies.push(text) });
      assert.equal(show.kind, "model");
      assert.match(replies[0], /Active model:/);
      assert.match(replies[0], /coder:7b/);
      await routeMessage({ channel, text: "/model fast", send: async (text) => replies.push(text) });
      assert.equal(brain.active.model, "fast:latest");
      assert.equal(modelRequests.length, start);
    }
    await routeMessage({ channel: "web", text: "/model default", send: async () => {} });
    assert.equal(brain.active.provider, "mock");
  } finally { brain.resetModel(); }
});
