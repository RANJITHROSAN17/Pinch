/**
 * End-to-end agent tests against the mock brain: the tool loop, the
 * permission gate, and the fact that a denied action really does not run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "pinch-agent-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-data-"));
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_AUTO_APPROVE = "false";

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
