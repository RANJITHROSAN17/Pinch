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
  loadReminders, pendingReminders, removeReminder,
} from "./store.js";
import { registerSender } from "./outbound.js";

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

/* ────────────────────────── live event bus ─────────────────────────────── */
// One place reminders, approvals and anything future can reach an open panel.
const subscribers = new Set();

export function broadcast(event, data) {
  for (const send of subscribers) {
    try {
      send(event, data);
    } catch {
      subscribers.delete(send);
    }
  }
}

registerSender("web", async (target, text) => {
  broadcast("reminder", { text, target, at: new Date().toISOString() });
});

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

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HTTPError(413, `body larger than ${Math.round(limit / 1000)} KB`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON used to be silently treated as prompt text. Say no.
    throw new HTTPError(400, "body must be JSON");
  }
}

/**
 * Host + Origin defence.
 *
 * Without this, any web page you visit can POST to http://localhost:7777 and
 * — because we reflect the Origin header — read the response back. That is a
 * full local-network data leak (and, with approvals pending, worse). Two rules:
 *
 *   1. the Host header must be a name we actually answer on (blocks DNS
 *      rebinding, where attacker.example resolves to 127.0.0.1);
 *   2. a browser-supplied Origin must match that same set (blocks CSRF),
 *      except for "null" origins from file:// pages, which we reject too.
 *
 * Requests with no Origin at all (curl, the CLI, native apps) are unaffected.
 */
function allowedHostnames() {
  const names = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  for (const addr of lanAddresses()) names.add(addr.address);
  if (config.host && config.host !== "0.0.0.0") names.add(config.host);
  for (const extra of config.allowedHosts) names.add(extra.toLowerCase());
  return names;
}

/** "*.e2b.app" allows any single-or-multi-level subdomain of e2b.app. */
function matchesAny(host, names) {
  if (!host) return false;
  if (names.has(host)) return true;
  for (const name of names) {
    if (!name.startsWith("*.")) continue;
    const suffix = name.slice(1); // ".e2b.app"
    if (host.endsWith(suffix) && host.length > suffix.length) return true;
  }
  return false;
}

function hostnameOf(value) {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originAllowed(req, names) {
  const hostHeader = hostnameOf(req.headers.host);
  if (hostHeader && !matchesAny(hostHeader, names)) return { ok: false, why: `host "${hostHeader}" is not one Pinch answers on` };

  const origin = req.headers.origin;
  if (!origin) return { ok: true };
  const host = hostnameOf(origin);
  if (!matchesAny(host, names)) return { ok: false, why: `origin "${origin}" is not allowed` };
  return { ok: true };
}

function authorised(req, url) {
  if (!config.authKey) return true;
  const header = req.headers["x-pinch-key"];
  const query = url.searchParams.get("key");
  const cookie = /(?:^|;\s*)pinch_key=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  let decoded = null;
  try {
    decoded = cookie ? decodeURIComponent(cookie) : null;
  } catch {
    decoded = null; // a mangled cookie is simply not a key
  }
  return [header, query, decoded].includes(config.authKey);
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
      pendingReminders: pendingReminders().length,
      streaming: true,
      guard: !config.disableGuard,
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
        target: sessionId,
        onEvent: (event) => stream.send("step", event),
      });
      stream.send("final", {
        text: result.text,
        trace: result.trace,
        guard: result.guard || [],
        sessionId,
      });
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

  if (path === "/api/events") {
    const stream = sse(res);
    const send = (event, data) => stream.send(event, data);
    subscribers.add(send);
    stream.send("hello", { at: new Date().toISOString(), pending: pendingReminders().length });
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, 25_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      subscribers.delete(send);
    });
    return; // stays open
  }

  if (path === "/api/reminders") {
    if (req.method === "GET") {
      return json(res, 200, {
        pending: pendingReminders().sort((a, b) => String(a.at).localeCompare(String(b.at))),
        recent: loadReminders().filter((r) => r.fired).slice(-10),
      });
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      return json(res, 200, { removed: id ? removeReminder(id) : 0 });
    }
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
    try {
      await respond(req, res);
    } catch (err) {
      // Last line of defence: a thrown URIError from a crafted request used to
      // escape as an unhandled rejection and take the socket with it.
      const status = err instanceof HTTPError ? err.status : err instanceof URIError ? 400 : 500;
      const message = err instanceof URIError ? "malformed URL encoding" : String(err.message || err);
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    }
  });
}

async function respond(req, res) {
    // Fixed base: the Host header is attacker-controlled, so it must never
    // influence how we parse our own URL.
    const url = new URL(req.url || "/", "http://localhost");

    const names = allowedHostnames();
    const origin = originAllowed(req, names);

    // Reflect only an origin we trust; never echo an arbitrary one.
    if (origin.ok && req.headers.origin) res.setHeader("access-control-allow-origin", req.headers.origin);
    else if (origin.ok) res.setHeader("access-control-allow-origin", "*");
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, x-pinch-key");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    if (!origin.ok) {
      if (url.pathname.startsWith("/api/")) return json(res, 403, { error: `refused: ${origin.why}` });
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end(`Pinch refused this request: ${origin.why}.\nAdd the name to PINCH_ALLOWED_HOSTS if this is your own proxy.\n`);
    }

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

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname === "/" ? "/index.html" : url.pathname);
}
