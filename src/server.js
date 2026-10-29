/**
 * server.js — Pinch's local HTTP surface: web panel, REST API, SSE stream.
 *
 * Binds to 0.0.0.0 so your phone can reach it over Wi-Fi. If PINCH_KEY is
 * set, every request must present it (?key=, x-pinch-key header, or the
 * cookie the panel sets after one successful load).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { config } from "./config.js";
import { brain } from "./brain.js";
import { runAgent, answerApproval, pendingApprovals } from "./agent.js";
import {
  ensureData, loadMemory, saveMemory, remember, forget,
  listSessions, loadSession, deleteSession, loadTasks,
} from "./store.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
};

const started = Date.now();
export const status = { channels: {} };

/* ────────────────────────────── helpers ────────────────────────────────── */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function authorised(req, url) {
  if (!config.authKey) return true;
  const header = req.headers["x-pinch-key"];
  const query = url.searchParams.get("key");
  const cookie = /(?:^|;\s*)pinch_key=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  return [header, query, cookie && decodeURIComponent(cookie)].includes(config.authKey);
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return { send, close: () => res.end() };
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const target = resolve(config.publicDir, rel || "index.html");
  if (!target.startsWith(config.publicDir + sep) && target !== join(config.publicDir, "index.html")) {
    return json(res, 403, { error: "forbidden" });
  }
  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    return json(res, 404, { error: "not found" });
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

/* ─────────────────────────────── routes ────────────────────────────────── */

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (path === "/api/health") {
    return json(res, 200, {
      ok: true,
      owner: config.ownerName,
      provider: config.llm.provider,
      model:
        config.llm.provider === "ollama" ? config.llm.ollamaModel
        : config.llm.provider === "mock" ? "mock (no model)"
        : config.llm.openaiModel,
      channels: status.channels,
      memoryFacts: loadMemory().facts.length,
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      workspace: config.workspaceRoots,
    });
  }

  if (path === "/api/models") {
    return json(res, 200, await brain.probe());
  }

  if (path === "/api/sessions" && req.method === "GET") {
    return json(res, 200, listSessions());
  }

  if (path.startsWith("/api/session/")) {
    const id = decodeURIComponent(path.slice("/api/session/".length));
    if (req.method === "GET") return json(res, 200, loadSession(id));
    if (req.method === "DELETE") {
      deleteSession(id);
      return json(res, 200, { ok: true });
    }
  }

  if (path === "/api/chat" && req.method === "POST") {
    const body = await readBody(req);
    const text = String(body.text || "").trim();
    if (!text) return json(res, 400, { error: "text required" });
    const sessionId = String(body.sessionId || "web-main").replace(/[^a-zA-Z0-9._-]/g, "_");

    // Approval replies typed into the panel ("yes" / "no").
    if (/^(yes|y|allow|ok|approve)$/i.test(text) && pendingApprovals("web").length) {
      answerApproval(pendingApprovals("web").at(-1).id, true);
    } else if (/^(no|n|deny|stop|cancel)$/i.test(text) && pendingApprovals("web").length) {
      answerApproval(pendingApprovals("web").at(-1).id, false);
    }

    const stream = sse(res);
    try {
      const result = await runAgent({
        sessionId,
        text,
        channel: "web",
        onEvent: (event) => stream.send("step", event),
      });
      stream.send("final", { text: result.text, trace: result.trace, sessionId });
    } catch (err) {
      stream.send("error", { message: String(err.message || err) });
    }
    return stream.close();
  }

  if (path === "/api/approve" && req.method === "POST") {
    const body = await readBody(req);
    const ok = answerApproval(String(body.id || ""), Boolean(body.allowed));
    return json(res, ok ? 200 : 404, { ok });
  }

  if (path === "/api/approvals" && req.method === "GET") {
    return json(res, 200, pendingApprovals());
  }

  if (path === "/api/memory") {
    if (req.method === "GET") return json(res, 200, loadMemory());
    const body = await readBody(req);
    if (body.forget) return json(res, 200, forget(body.forget));
    if (body.fact) return json(res, 200, remember(body.fact, body.tag));
    if (typeof body.profile === "object" && body.profile) {
      const memory = loadMemory();
      memory.profile = { ...memory.profile, ...body.profile };
      return json(res, 200, saveMemory(memory));
    }
    return json(res, 400, { error: "nothing to do" });
  }

  if (path === "/api/tasks") {
    return json(res, 200, loadTasks());
  }

  return json(res, 404, { error: "unknown endpoint" });
}

export function createPinchServer() {
  ensureData();
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // CORS for local tools only — no wildcard credentials.
    res.setHeader("access-control-allow-origin", req.headers.origin || "*");
    res.setHeader("access-control-allow-headers", "content-type, x-pinch-key");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    if (!authorised(req, url)) {
      if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "bad or missing PINCH_KEY" });
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><meta charset="utf-8"><title>Pinch — locked</title>` +
        `<body style="font-family:ui-sans-serif,system-ui;background:#12080a;color:#ffd9c7;display:grid;place-items:center;height:100vh;margin:0">` +
        `<div style="max-width:34rem;padding:2rem"><h1>🦞 Pinch is locked</h1>` +
        `<p>This instance requires a key. Append <code>?key=YOUR_PINCH_KEY</code> to the URL once — ` +
        `Pinch will remember it in a cookie.</p>` +
        `<p style="opacity:.6">The key lives in <code>.env</code> as <code>PINCH_KEY</code>.</p></div>`
      );
    }

    // Set the cookie on a successful keyed visit so the panel stops needing ?key=.
    if (config.authKey && url.searchParams.get("key") === config.authKey) {
      res.setHeader("set-cookie", `pinch_key=${encodeURIComponent(config.authKey)}; Path=/; Max-Age=31536000; SameSite=Lax`);
    }

    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      return await serveStatic(req, res, url.pathname === "/" ? "/index.html" : url.pathname);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
      else res.end();
    }
  });
}
