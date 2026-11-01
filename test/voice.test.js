import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkVoice, transcribeAudio } from "../src/voice.js";

async function serve(fn, testFn) {
  const server = http.createServer(fn);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await testFn(`http://127.0.0.1:${server.address().port}/v1/audio/transcriptions`); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test("doctor voice: unset is optional, malformed/unreachable is warning", async () => {
  assert.equal((await checkVoice(""))[0], "skip");
  assert.match((await checkVoice(""))[1], /not configured/);
  assert.equal((await checkVoice("file:///tmp/test"))[0], "warn");
  await serve((req, res) => { res.writeHead(503); res.end(); }, async (url) => {
    const result = await checkVoice(url);
    assert.equal(result[0], "warn");
    assert.match(result[1], /503/);
  });
});

test("doctor voice: reachable does not claim verified transcription", async () => {
  await serve((req, res) => { assert.equal(req.method, "HEAD"); assert.equal(req.url, "/"); res.writeHead(405); res.end(); }, async (url) => {
    const result = await checkVoice(url);
    assert.equal(result[0], "ok");
    assert.match(result[1], /transcription not verified/);
  });
});

test("voice adapter: multipart audio yields transcript", async () => {
  await serve((req, res) => {
    assert.equal(req.method, "POST");
    assert.match(req.headers["content-type"], /multipart\/form-data/);
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      assert.match(body, /voice.wav/);
      assert.match(body, /whisper-1/);
      res.end(JSON.stringify({ text: "hello from Whisper" }));
    });
  }, async (url) => assert.equal(await transcribeAudio(Buffer.from("audio"), "audio/wav", url), "hello from Whisper"));
});

test("voice adapter: rejects upstream errors and invalid response shape", async () => {
  await serve((req, res) => { req.resume(); res.writeHead(500); res.end(); }, async (url) => {
    await assert.rejects(transcribeAudio(Buffer.from("a"), "audio/wav", url), /HTTP 500/);
  });
  await serve((req, res) => { req.resume(); res.end("{}"); }, async (url) => {
    await assert.rejects(transcribeAudio(Buffer.from("a"), "audio/wav", url), /no text field/);
  });
});


test("doctor voice: does not request remote or credential-bearing configured URLs", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  try {
    for (const url of ["https://example.com/v1/audio?secret=abc", "http://127.0.0.1.example.com/", "http://user:password@127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/"]) {
      const result = await checkVoice(url);
      assert.equal(result[0], "warn");
      assert.match(result[1], /probe skipped/);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("doctor voice: does not follow redirects from loopback", async () => {
  let calls = 0;
  await serve((req, res) => {
    calls++;
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  }, async (url) => {
    const result = await checkVoice(url + "?secret=not-forwarded");
    assert.equal(result[0], "warn");
    assert.match(result[1], /302/);
    assert.equal(calls, 1);
  });
});
