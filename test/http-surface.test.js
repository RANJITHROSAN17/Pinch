/**
 * Regression tests for the HTTP surface — the half of Pinch that the original
 * test suite never touched.
 *
 * Findings covered (see docs/AUDIT.md):
 *   • no Origin check  → any website you visit could drive the assistant and
 *                        read the answer back (ACAO was reflected verbatim)
 *   • no Host check    → DNS rebinding from attacker.example reached the API
 *   • malformed JSON   → silently accepted as prompt text
 *   • oversized body   → 500 instead of 413
 *   • bad URL encoding → 500 instead of 400
 *
 * The server is spawned as a real child process and probed over TCP, because
 * the point of these tests is the behaviour a *browser* would see.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PORT = 7900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

let child;

before(async () => {
  child = spawn(process.execPath, [join(root, "src", "index.js")], {
    cwd: root,
    env: {
      ...process.env,
      WHISPER_URL: "",
      LLM_PROVIDER: "mock",
      PINCH_KEY: "",
      PINCH_PORT: String(PORT),
      PINCH_HOST: "0.0.0.0",
      PINCH_DATA: mkdtempSync(join(tmpdir(), "pinch-http-data-")),
      PINCH_WORKSPACE: mkdtempSync(join(tmpdir(), "pinch-http-ws-")),
      TELEGRAM_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start in time");
});

after(() => {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
});

/** Raw request so we can forge Host, which fetch() rightly refuses to do. */
function raw(pathname, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method, headers },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolvePromise({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const chat = (headers = {}, body = JSON.stringify({ text: "what is 2+2" })) =>
  fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

// ── the panel still works for its owner ──────────────────────────────────────

test("health responds over plain loopback", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("the panel is served", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/i);
});

test("a same-origin browser request is allowed", async () => {
  const res = await chat({ origin: BASE });
  assert.equal(res.status, 200);
});

test("a request with no Origin (curl, CLI, native app) is allowed", async () => {
  const res = await chat();
  assert.equal(res.status, 200);
});

// ── finding 5: cross-site request forgery ────────────────────────────────────

test("a foreign Origin cannot drive the assistant", async () => {
  const res = await chat({ origin: "https://evil.example" });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /origin/i);
});

test("a foreign Origin never gets an Access-Control-Allow-Origin header", async () => {
  const res = await chat({ origin: "https://evil.example" });
  const acao = res.headers.get("access-control-allow-origin");
  assert.ok(!acao || !acao.includes("evil.example"), `reflected ACAO: ${acao}`);
});

test("an opaque sandbox Origin is refused", async () => {
  const res = await chat({ origin: "null" });
  assert.equal(res.status, 403);
});

// ── finding 5b: DNS rebinding ────────────────────────────────────────────────

test("a Host header that is not this machine is refused", async () => {
  const res = await raw("/api/health", { headers: { host: "attacker.example" } });
  assert.equal(res.status, 403);
});

test("a DNS-rebinding attempt is refused even with a matching Origin", async () => {
  const res = await raw("/api/health", {
    headers: { host: "attacker.example:7777", origin: "http://attacker.example:7777" },
  });
  assert.equal(res.status, 403);
});

test("loopback and LAN names are still accepted", async () => {
  for (const host of ["localhost", `127.0.0.1:${PORT}`, `[::1]:${PORT}`]) {
    const res = await raw("/api/health", { headers: { host } });
    assert.equal(res.status, 200, `host ${host} was refused`);
  }
});

// ── minor findings: HTTP semantics ──────────────────────────────────────────

test("malformed JSON is rejected with 400, not silently accepted", async () => {
  const res = await chat({}, "{oops");
  assert.equal(res.status, 400);
});

test("an oversized body is rejected with 413", async () => {
  const res = await chat({}, JSON.stringify({ text: "x".repeat(3_000_000) }));
  assert.equal(res.status, 413);
});

test("malformed percent-encoding is a 4xx, never a 500", async () => {
  // The path does not resolve to an endpoint, so a flat 404 is the honest
  // answer; what matters is that it is not a server error.
  const res = await fetch(`${BASE}/api/%zz`);
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
});

test("a static path traversal attempt cannot read /etc/passwd", async () => {
  // raw() sends the path untouched; fetch() would normalise the escapes away.
  const res = await raw("/..%2f..%2f..%2fetc%2fpasswd");
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  assert.doesNotMatch(res.text, /root:x:0:0/);
});

test("an unknown endpoint is a clean 404", async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
});


test("voice: rejects non-audio and oversized bodies before upstream configuration", async () => {
  const unsupported = await raw("/api/transcribe", { method: "POST", headers: { "content-type": "text/plain" }, body: "not audio" });
  assert.equal(unsupported.status, 415);
  assert.match(JSON.parse(unsupported.text).error, /MIME/);
  const oversized = await fetch(`${BASE}/api/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: Buffer.alloc(10_000_001) });
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
});

test("voice: unset WHISPER_URL returns actionable JSON", async () => {
  const res = await raw("/api/transcribe", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: "audio" });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.text).error, /WHISPER_URL.*not configured/);
});

test("voice: hung Whisper aborts and HTTP server remains healthy", async () => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    req.resume();
    // A partial response tests that the deadline covers the body, not just headers.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"text":');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = PORT + 100;
  const proc = spawn(process.execPath, [join(root, "src/index.js")], {
    cwd: root,
    env: { ...process.env, LLM_PROVIDER: "mock", PINCH_KEY: "", PINCH_HOST: "127.0.0.1", PINCH_PORT: String(port), TELEGRAM_TOKEN: "", PINCH_DATA: mkdtempSync(join(tmpdir(), "pinch-voice-")), WHISPER_URL: `http://127.0.0.1:${upstream.address().port}/transcribe` },
    stdio: "ignore",
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: "audio" });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /timed out/);
    assert.ok(Date.now() - started < 9000);
    assert.equal(calls, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally {
    proc.kill("SIGKILL");
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
});
