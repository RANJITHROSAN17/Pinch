/**
 * tests for the pure, security-sensitive bits: the maths evaluator, the
 * command screen and the workspace sandbox. These are the pieces where a bug
 * is not cosmetic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the sandbox at a temp dir before anything imports config.
const sandbox = mkdtempSync(join(tmpdir(), "pinch-test-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.LLM_PROVIDER = "mock";

const { calculate, screenCommand, resolveInWorkspace, SafePathError } = await import("../src/tools.js");
const { splitForLimit } = await import("../src/channels/router.js");
const { parseEnv } = await import("../src/config.js");

test("calculator handles precedence and parentheses", () => {
  assert.equal(calculate("2+3*4"), 14);
  assert.equal(calculate("(2+3)*4"), 20);
  assert.equal(calculate("2^3^2"), 512); // right associative
  assert.equal(calculate("-3 + 10"), 7);
  assert.equal(calculate("10 % 3"), 1);
});

test("calculator supports constants and functions", () => {
  assert.ok(Math.abs(calculate("sqrt(16)") - 4) < 1e-9);
  assert.ok(Math.abs(calculate("pi") - Math.PI) < 1e-9);
  assert.equal(calculate("max(3, 9)"), 9);
  assert.ok(Math.abs(calculate("round(2.6)") - 3) < 1e-9);
});

test("calculator refuses anything that is not arithmetic", () => {
  // No eval() anywhere, so injection is impossible by construction — the only
  // question is which error comes back.
  assert.throws(() => calculate("process.exit(1)"), /Unknown name|Only numbers/);
  assert.throws(() => calculate("require('fs')"), /Unknown name|Only numbers/);
  assert.throws(() => calculate("2+"), /Malformed|Could not/);
});

test("screenCommand blocks catastrophic commands", () => {
  assert.equal(screenCommand("rm -rf /").allowed, false);
  assert.equal(screenCommand("mkfs.ext4 /dev/sda1").allowed, false);
  assert.equal(screenCommand("dd if=/dev/zero of=/dev/sda").allowed, false);
  assert.equal(screenCommand(":(){ :|:& };:").allowed, false);
});

test("screenCommand allows ordinary development commands", () => {
  for (const cmd of ["npm test", "git status --short", "python -m pytest -q", "ls -la", "rm -rf ./build"]) {
    assert.equal(screenCommand(cmd).allowed, true, cmd);
  }
});

test("workspace sandbox allows paths inside and blocks escapes", () => {
  assert.equal(resolveInWorkspace("src/app.js").startsWith(sandbox), true);
  assert.equal(resolveInWorkspace(sandbox), sandbox);
  assert.throws(() => resolveInWorkspace("/etc/passwd"), SafePathError);
  assert.throws(() => resolveInWorkspace("../../../../etc/passwd"), SafePathError);
  assert.throws(() => resolveInWorkspace("~/../../etc/passwd"), SafePathError);
});

test("splitForLimit never loses characters and respects the limit", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of something reasonably long`).join("\n");
  const parts = splitForLimit(text, 400);
  assert.ok(parts.every((p) => p.length <= 400));
  assert.equal(parts.join("").replace(/\n/g, ""), text.replace(/\n/g, ""));
});

test("env parser ignores comments and keeps quoted values", () => {
  const env = parseEnv(`# comment\nA=1\nB="two words"\n\nC='single'\nBAD LINE\nD=`);
  assert.deepEqual(env, { A: "1", B: "two words", C: "single", D: "" });
});
