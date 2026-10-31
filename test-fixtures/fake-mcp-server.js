#!/usr/bin/env node
/**
 * test/fixtures/fake-mcp-server.js — a real MCP server, 60 lines of it.
 *
 * The point of testing against the wire protocol rather than a mock is that a
 * mock proves the adapter calls the function it was written against; this
 * proves it speaks to a process the way the spec says.
 *
 * Behaviour is chosen by argv so one file can be the well-behaved server, the
 * one that hangs, and the one that dies mid-request.
 *
 *   --tools ok|none      what tools/list returns
 *   --hang <tool>        never answer tools/call for that tool
 *   --die <tool>         exit abruptly when that tool is called
 *   --garbage            print non-JSON to stdout before answering
 *   --echo-env           a tool that reports PINCH_KEY if it can see it
 */
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

const tools = has("--tools") && valueOf("--tools") === "none"
  ? []
  : [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      {
        name: "echo_env",
        description: "Report whether a secret is visible in this process's environment",
        inputSchema: { type: "object", properties: {} },
      },
      { name: "slow", description: "Never answers", inputSchema: { type: "object", properties: {} } },
      { name: "crash", description: "Kills the server", inputSchema: { type: "object", properties: {} } },
    ];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

if (has("--garbage")) process.stdout.write("this is not json { nor is this\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications have no reply

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp", version: "0.0.1" },
    });
  }
  if (method === "tools/list") return reply(id, { tools });

  if (method === "tools/call") {
    const name = params?.name;
    if (name === valueOf("--hang") || name === "slow") return; // never answers
    if (name === valueOf("--die") || name === "crash") {
      process.exit(3);
    }
    if (name === "echo_env") {
      const seen = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET/i.test(k));
      return reply(id, { content: [{ type: "text", text: JSON.stringify(seen) }] });
    }
    if (name === "add") {
      const a = Number(params?.arguments?.a ?? 0);
      const b = Number(params?.arguments?.b ?? 0);
      return reply(id, { content: [{ type: "text", text: String(a + b) }] });
    }
    return fail(id, -32601, `unknown tool: ${name}`);
  }

  return fail(id, -32601, `unknown method: ${method}`);
});
