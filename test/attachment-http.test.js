/**
 * test/attachment-http.test.js — the end-to-end proof for issue #12.
 *
 * The unit tests prove the extractor parses a PDF. They do not prove that a
 * file attached in the panel ever reaches the model, which is the actual
 * complaint: every comparable assistant lets you drop a document in and ask
 * about it; Pinch did not.
 *
 * So this test stands up a fake model server, points a real Pinch at it, posts
 * a real PDF through the real upload endpoint, and then asserts on the request
 * body the model actually received. If the wiring breaks anywhere — endpoint,
 * queue, agent, brain message shape — this fails.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A tiny Flate-compressed PDF with one legible line. */
function makePdf(line) {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const compressed = deflateSync(Buffer.from(content, "latin1"));
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream\n%%EOF\n", "latin1"),
  ]);
}

let model;          // the fake Ollama
let modelPort;
let pinch;          // the real server
let pinchPort;
let dataDir;
let received = [];  // request bodies the model saw

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  model = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ raw: body });
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // The shape Ollama streams back.
      res.write(JSON.stringify({ message: { role: "assistant", content: "The file says so." }, done: false }) + "\n");
      res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
    });
  });
  modelPort = await listen(model);

  dataDir = mkdtempSync(join(tmpdir(), "pinch-att-"));
  pinchPort = 20000 + Math.floor(Math.random() * 20000);
  pinch = spawn(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PINCH_PORT: String(pinchPort),
      PINCH_KEY: "",
      PINCH_DATA: dataDir,
      PINCH_WORKSPACE: dataDir,
      LLM_PROVIDER: "ollama",
      OLLAMA_URL: `http://127.0.0.1:${modelPort}`,
      OLLAMA_MODEL: "fake-vision-model",
    },
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${pinchPort}/api/health`);
});

after(() => {
  try {
    pinch?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    model?.close();
  } catch {
    /* already closed */
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("a PDF uploaded through the API is text the model actually receives", async () => {
  received = [];
  const upload = await fetch(`http://127.0.0.1:${pinchPort}/api/attach`, {
    method: "POST",
    headers: { "x-filename": "quarterly.pdf" },
    body: makePdf("Quarterly revenue rose 12 percent"),
  });
  assert.equal(upload.status, 200);
  const info = await upload.json();
  assert.equal(info.kind, "pdf");
  assert.match(info.preview, /Quarterly revenue rose 12 percent/);

  const chat = await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "what number is in the report?", attachments: [info.id] }),
  });
  assert.equal(chat.status, 200);
  await chat.text(); // drain the SSE stream

  assert.ok(received.length > 0, "the model should have been called");
  const sent = JSON.stringify(received[0]);
  assert.match(sent, /Quarterly revenue rose 12 percent/, "the document text must reach the model");
  assert.match(sent, /untrusted-document/, "it must arrive labelled as data");
  assert.match(sent, /what number is in the report\?/, "and the question must still be there");
});

test("an attachment id is single-use: the next message does not carry it", async () => {
  received = [];
  const upload = await fetch(`http://127.0.0.1:${pinchPort}/api/attach`, {
    method: "POST",
    headers: { "x-filename": "once.txt" },
    body: Buffer.from("SENTINEL-ONE-TIME-VALUE"),
  });
  const info = await upload.json();

  await (await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "first", attachments: [info.id] }),
  })).text();
  assert.match(JSON.stringify(received[0]), /SENTINEL-ONE-TIME-VALUE/);

  received = [];
  await (await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "second", attachments: [info.id] }),
  })).text();

  const body = JSON.stringify(received[0]);
  // The id must not resurrect the file as a live attachment: no untrusted
  // document block is built for this turn.
  assert.doesNotMatch(body, /<untrusted-document>/, "replaying an id must not replay the file");
  // The text may, however, still be present as *history* — that is the fix for
  // "and what did the document say?", and it is clearly labelled as such.
  assert.match(body, /\[attached: once\.txt \(text\)\]/, "the earlier attachment is not marked as history");
});

test("an oversized upload is refused with 413, not accepted and truncated", async () => {
  const big = Buffer.alloc(13 * 1024 * 1024, 0x61);
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/attach`, {
    method: "POST",
    headers: { "x-filename": "huge.txt" },
    body: big,
  });
  assert.equal(res.status, 413);
});

test("an empty upload is refused rather than queued as a blank attachment", async () => {
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/attach`, {
    method: "POST",
    headers: { "x-filename": "nothing.txt" },
    body: Buffer.alloc(0),
  });
  assert.equal(res.status, 400);
});

test("a file name cannot escape the response, whatever it contains", async () => {
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/attach`, {
    method: "POST",
    headers: { "x-filename": "../../../etc/passwd" },
    body: Buffer.from("not the real passwd"),
  });
  const info = await res.json();
  assert.equal(info.name, "passwd", "the path is stripped to a display name");
});
