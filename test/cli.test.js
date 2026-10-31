/**
 * smoke tests for bin/pinch.js — the entry point every user touches first.
 * argv arrays only; nothing here goes through a shell.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/pinch.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const pinch = (...args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [bin, ...args], { timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    ),
  );

test("--version exits 0 and prints the version from package.json", async () => {
  const r = await pinch("--version");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), version);
});

test("an unknown verb exits non-zero, names the verb and prints usage", async () => {
  const r = await pinch("definitely-not-a-verb");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Unknown command: definitely-not-a-verb/);
  assert.match(r.stdout, /pinch doctor/);
});

test("help exits 0 and lists real verbs", async () => {
  const r = await pinch("help");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /pinch doctor/);
  assert.match(r.stdout, /pinch audit/);
});
