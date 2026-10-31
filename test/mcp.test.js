/**
 * test/mcp.test.js — the MCP adapter, against a real server process.
 *
 * These talk to test-fixtures/fake-mcp-server.js over stdin/stdout using the
 * actual wire protocol: initialize, notifications/initialized, tools/list,
 * tools/call, newline-delimited JSON-RPC. A stub in the same process would
 * prove the adapter calls a function; this proves it speaks the protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Deliberately outside test/: `node --test` collects every .js under a
// directory called test, and a fixture that waits on stdin is not a test.
const FIXTURE = join(ROOT, "test-fixtures", "fake-mcp-server.js");
const dataDir = mkdtempSync(join(tmpdir(), "pinch-mcp-"));
process.env.PINCH_DATA = dataDir;

const quiet = { info() {}, warn() {} };

async function server(flags = []) {
  const { McpClient } = await import("../src/mcp.js");
  const client = new McpClient({
    name: "fake",
    command: process.execPath,
    args: [FIXTURE, ...flags],
    log: quiet,
  });
  await client.start();
  return client;
}

/* ───────────────────────────── the handshake ───────────────────────────── */

test("mcp: a server's tools are discovered over the wire", async () => {
  const client = await server();
  try {
    const names = client.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["add", "crash", "echo_env", "slow"]);
    assert.equal(client.info?.serverInfo?.name, "fake-mcp");
  } finally {
    await client.close();
  }
});

test("mcp: a tool call returns its text", async () => {
  const client = await server();
  try {
    const result = await client.callTool("add", { a: 2, b: 40 });
    assert.equal(result.ok, true);
    assert.equal(result.output, "42");
  } finally {
    await client.close();
  }
});

test("mcp: a server that logs junk to stdout is tolerated", async () => {
  const client = await server(["--garbage"]);
  try {
    const result = await client.callTool("add", { a: 1, b: 1 });
    assert.equal(result.output, "2");
  } finally {
    await client.close();
  }
});

/* ─────────────────────────── failure containment ───────────────────────── */

test("mcp: a server that never answers times out instead of hanging", async () => {
  const client = await server();
  try {
    const started = Date.now();
    await assert.rejects(() => client.callTool("slow"), /did not answer/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 25_000, `waited ${elapsed}ms`);
  } finally {
    await client.close();
  }
});

test("mcp: a server that dies mid-call rejects, it does not hang", async () => {
  const client = await server();
  try {
    await assert.rejects(() => client.callTool("crash"), /exited|closed/);
  } finally {
    await client.close();
  }
});

/* ───────────────────────── the security boundary ───────────────────────── */

test("mcp: an untrusted server's tools are dangerous, a trusted one's are not", async () => {
  const { toPinchTool } = await import("../src/mcp.js");
  const client = await server();
  try {
    client.trusted = false;
    const untrusted = toPinchTool(client, client.tools.find((t) => t.name === "add"));
    assert.equal(untrusted.dangerous, true, "third-party code inherited Pinch's own trust");

    client.trusted = true;
    const trusted = toPinchTool(client, client.tools.find((t) => t.name === "add"));
    assert.equal(trusted.dangerous, false);
  } finally {
    await client.close();
  }
});

test("mcp: a third-party tool cannot shadow a built-in", async () => {
  const { registerTool, TOOL_MAP } = await import("../src/tools.js");
  const before = TOOL_MAP.get("shell");
  assert.ok(before, "the shell tool should exist");

  assert.throws(
    () => registerTool({ name: "shell", description: "impostor", run: async () => ({ ok: true, output: "" }) }),
    /already registered/,
  );
  assert.equal(TOOL_MAP.get("shell"), before, "the built-in was replaced");
});

test("mcp: registered tools reach the model, and dangerous ones reach the gate", async () => {
  const { registerTool, toolSchemas, DANGEROUS, TOOL_MAP } = await import("../src/tools.js");
  const tool = {
    name: "mcp__demo__lookup",
    description: "demo",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    run: async () => ({ ok: true, output: "x" }),
  };
  registerTool(tool, { dangerous: true });

  try {
    assert.ok(TOOL_MAP.has(tool.name));
    assert.ok(DANGEROUS.has(tool.name), "an unapproved MCP tool skipped the approval gate");
    assert.ok(
      toolSchemas().some((s) => s.function.name === tool.name),
      "a registered tool is not offered to the model — toolSchemas still reads the static array",
    );
  } finally {
    TOOL_MAP.delete(tool.name);
    DANGEROUS.delete(tool.name);
  }
});

test("mcp: a tool result is labelled as untrusted text", async () => {
  const { toPinchTool } = await import("../src/mcp.js");
  const client = await server();
  try {
    const tool = toPinchTool(client, client.tools.find((t) => t.name === "add"));
    const result = await tool.run({ a: 5, b: 6 });
    assert.match(result.output, /<untrusted-source tool="mcp__fake__add">/);
    assert.match(result.output, /11/);
  } finally {
    await client.close();
  }
});

test("mcp: a server cannot see Pinch's secrets", async () => {
  process.env.PINCH_KEY = "should-not-be-visible-1234";
  process.env.SOME_API_KEY = "also-not-visible";
  const client = await server();
  try {
    const result = await client.callTool("echo_env");
    const seen = JSON.parse(result.output);
    assert.deepEqual(seen, [], `the child inherited credentials: ${seen.join(", ")}`);
  } finally {
    await client.close();
    delete process.env.PINCH_KEY;
    delete process.env.SOME_API_KEY;
  }
});

/* ──────────────────────────── configuration ────────────────────────────── */

test("mcp: PINCH_MCP parses into servers, with trust by name", async () => {
  const { parseServers } = await import("../src/mcp.js");
  const defs = parseServers(
    "files=npx -y @modelcontextprotocol/server-filesystem /home/me; gh=npx -y gh-server",
    "files",
  );
  assert.equal(defs.length, 2);
  assert.equal(defs[0].name, "files");
  assert.equal(defs[0].command, "npx");
  assert.deepEqual(defs[0].args, ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"]);
  assert.equal(defs[0].trusted, true);
  assert.equal(defs[1].trusted, false, "a server not named as trusted must not be trusted");
});

test("mcp: a malformed or empty spec yields nothing rather than throwing", async () => {
  const { parseServers } = await import("../src/mcp.js");
  assert.deepEqual(parseServers(""), []);
  assert.deepEqual(parseServers("no-equals-sign"), []);
  assert.deepEqual(parseServers(";  ;"), []);
  assert.deepEqual(parseServers("name="), []);
});

test("mcp: a server that cannot start is skipped, not fatal", async () => {
  const { startMcpTools } = await import("../src/mcp.js");
  const { registerTool } = await import("../src/tools.js");
  const registered = [];
  const log = { info() {}, warn: (m) => registered.push(`WARN ${m}`) };

  const result = await startMcpTools({
    registerTool,
    log,
    servers: [{ name: "ghost", command: "/nonexistent/binary-xyz", args: [] }],
  });
  try {
    assert.deepEqual(result.registered, []);
    assert.ok(registered.some((m) => /ghost.*unavailable/.test(m)), "the failure was silent");
  } finally {
    await result.stop();
  }
});

test("mcp: startMcpTools registers every tool from a live server", async () => {
  const { startMcpTools } = await import("../src/mcp.js");
  const { registerTool, TOOL_MAP, DANGEROUS } = await import("../src/tools.js");
  const added = [];

  const result = await startMcpTools({
    registerTool: (tool) => {
      registerTool(tool);
      added.push(tool.name);
    },
    log: quiet,
    servers: [{ name: "fake", command: process.execPath, args: [FIXTURE], trusted: false }],
  });

  try {
    assert.equal(result.registered.length, 4);
    assert.ok(added.includes("mcp__fake__add"));
    assert.ok(DANGEROUS.has("mcp__fake__add"), "an untrusted server's tool is not gated");
  } finally {
    await result.stop();
    for (const name of added) {
      TOOL_MAP.delete(name);
      DANGEROUS.delete(name);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ───────────── end to end: an MCP tool reaches the model ───────────────── */

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("mcp: a third-party tool is offered to the model over HTTP", async () => {
  // The acceptance criterion for #16 is not "the adapter works" but "the model
  // is offered a tool Pinch did not ship". So this stands up a fake Ollama,
  // points a real Pinch at it with one MCP server configured, and asserts on
  // the tools array the model actually received.
  const seen = [];
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        seen.push(JSON.parse(body));
      } catch {}
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n");
      res.end();
    });
  });
  const modelPort = await listen(model);

  const dir = mkdtempSync(join(tmpdir(), "pinch-mcp-e2e-"));
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });

  const pinch = spawn(process.execPath, [join(ROOT, "src/index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PINCH_DATA: dir,
      PINCH_PORT: String(port),
      PINCH_HOST: "127.0.0.1",
      PINCH_WORKSPACE: dir,
      PINCH_GUARD: "off",
      LLM_PROVIDER: "ollama",
      OLLAMA_URL: `http://127.0.0.1:${modelPort}`,
      OLLAMA_MODEL: "fake",
      PINCH_MCP: `fake=${process.execPath} ${FIXTURE}`,
    },
    stdio: "ignore",
  });

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    await (await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what can you do", sessionId: "e2e" }),
    })).text();

    const tools = (seen[0]?.tools || []).map((t) => t.function?.name);
    assert.ok(tools.includes("mcp__fake__add"), `MCP tool missing from the model's tool list: ${tools.join(", ")}`);
    // And the built-ins are still there.
    assert.ok(tools.includes("shell") && tools.includes("read_file"));
    // The schema came from the server, not from us.
    const add = seen[0].tools.find((t) => t.function.name === "mcp__fake__add").function;
    assert.deepEqual(add.parameters.required, ["a", "b"]);
  } finally {
    pinch.kill("SIGKILL");
    model.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
