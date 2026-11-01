/**
 * brain.js — the thinking part, behind one tiny interface.
 *
 *   const out = await brain.chat(messages, { tools })
 *   → { content, toolCalls: [{ id, name, arguments }], provider }
 *
 * Providers:
 *   ollama  — local, private, free (default)
 *   openai  — any OpenAI-compatible endpoint (Groq, LM Studio, vLLM,
 *             OpenRouter, OpenAI itself); used for tool calling when
 *             the local model is busy or you want more muscle
 *   mock    — deterministic canned answers, for tests and for
 *             `npm run demo` on a machine with no model installed
 */
import { config } from "./config.js";
import { fit, ctx } from "./budget.js";

const TIMEOUT_MS = 180_000;

async function postJson(url, body, headers = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const detail = json?.error?.message || json?.error || text.slice(0, 300);
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────────── streaming ─────────────────────────────── */

/**
 * Read an NDJSON or SSE body line-by-line and hand each parsed object over.
 * Both providers stream, but in different envelopes; the callers differ only
 * in how they unwrap them.
 */
async function streamLines(res, onObject, isSse) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = isSse ? (trimmed.startsWith("data:") ? trimmed.slice(5).trim() : null) : trimmed;
      if (!payload) continue;
      if (payload === "[DONE]") return;
      try {
        onObject(JSON.parse(payload));
      } catch {
        /* keep-alive or partial frame — ignore */
      }
    }
  }
}

async function postStream(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { res, done: () => clearTimeout(timer) };
}

/* ──────────────────────────────── ollama ───────────────────────────────── */

/** Provider-neutral history → Ollama's wire format. */
function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", content: m.content, tool_name: m.name };
    if (m.toolCalls?.length) {
      return {
        role: m.role,
        content: m.content || "",
        tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })),
      };
    }
    const out = { role: m.role, content: m.content ?? "" };
    // Ollama takes raw base64 in an `images` array on the message itself —
    // strings, not the richer objects the attachment layer keeps, so the
    // provider never has to know about our record shape.
    if (m.images?.length) out.images = m.images.map((img) => (typeof img === "string" ? img : img.data));
    return out;
  });
}

const ollama = {
  name: "ollama",

  async chat(messages, { tools = [], model, onDelta } = {}) {
    // Trim to the window *before* the provider does it for us. Ollama drops
    // from the front on overflow, which deletes the system prompt first.
    const { messages: fitted, dropped } = fit(messages, { tools });
    const body = {
      model: model || config.llm.ollamaModel,
      messages: toOllamaMessages(fitted),
      stream: Boolean(onDelta),
      options: { temperature: 0.4, num_ctx: ctx.numCtx, num_predict: ctx.numPredict },
    };
    if (tools.length) body.tools = tools;

    const url = `${config.llm.ollamaUrl}/api/chat`;

    // Non-streaming path: one request, one answer.
    if (!onDelta) {
      const out = await postJson(url, body);
      const message = out.message || {};
      return {
        content: message.content || "",
        toolCalls: (message.tool_calls || []).map((call, i) =>
          toCall(`call_${Date.now()}_${i}`, call.function?.name, call.function?.arguments)),
        provider: "ollama",
        raw: out,
      };
    }

    // Streaming path: emit text as it arrives, collect tool calls at the end.
    const { res, done } = await postStream(url, body);
    let content = "";
    let finished = false;
    const calls = [];
    try {
      await streamLines(res, (chunk) => {
        if (chunk.done === true) finished = true;
        const piece = chunk.message?.content;
        if (piece) {
          content += piece;
          onDelta(piece);
        }
        for (const call of chunk.message?.tool_calls || []) {
          calls.push(toCall(`call_${Date.now()}_${calls.length}`, call.function?.name, call.function?.arguments));
        }
      }, false);
    } finally {
      done();
    }
    // Without this, a provider that closes the socket mid-sentence returned
    // "The answer is 42, and here is" as a complete reply — and it went into
    // history as fact. The honesty guard audits claims, not completeness.
    if (!finished && content.trim()) {
      throw new Error("the model stream ended before it finished — the reply was cut off");
    }
    return { content, toolCalls: calls, provider: "ollama", dropped };
  },

  async probe() {
    const res = await fetch(`${config.llm.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const json = await res.json();
    return {
      ok: true,
      models: (json.models || []).map((m) => m.name),
      url: config.llm.ollamaUrl,
    };
  },
};

/* ─────────────────────────── openai-compatible ─────────────────────────── */

function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: String(m.content ?? "") };
    }
    const out = { role: m.role, content: m.content ?? "" };
    if (m.images?.length) {
      // The OpenAI chat format wants content as parts, text first, then one
      // image_url per image as a data URI — no upload, no external host.
      out.content = [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...m.images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mime || "image/png"};base64,${img.data || img}` },
        })),
      ];
    }
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      }));
    }
    return out;
  });
}

const openai = {
  name: "openai",

  async chat(messages, { tools = [], model, onDelta } = {}) {
    if (!config.llm.openaiKey) throw new Error("OPENAI_API_KEY is not set");
    const { messages: fitted, dropped } = fit(messages, { tools });
    const body = {
      model: model || config.llm.openaiModel,
      messages: toOpenAiMessages(fitted),
      temperature: 0.4,
      max_tokens: ctx.numPredict,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: t.function }));
      body.tool_choice = "auto";
    }
    const url = `${config.llm.openaiBaseUrl}/chat/completions`;
    const headers = { authorization: `Bearer ${config.llm.openaiKey}` };

    if (!onDelta) {
      const out = await postJson(url, body, headers);
      const message = out.choices?.[0]?.message || {};
      return {
        dropped,
        content: message.content || "",
        toolCalls: (message.tool_calls || []).map((call) =>
          toCall(call.id || `call_${Date.now()}`, call.function?.name, call.function?.arguments)),
        provider: "openai",
        raw: out,
      };
    }

    // Streaming: content deltas arrive as strings; tool calls arrive as
    // fragments that must be stitched by index (the arguments string is cut
    // mid-JSON across chunks, so it can only be parsed at the end).
    const { res, done } = await postStream(url, { ...body, stream: true }, headers);
    let content = "";
    let finishReason = null;
    const partial = new Map();
    try {
      await streamLines(res, (chunk) => {
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
          const index = tc.index ?? partial.size;
          const entry = partial.get(index) || { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          partial.set(index, entry);
        }
      }, true);
    } finally {
      done();
    }

    const toolCalls = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, entry]) => toCall(entry.id || `call_${Date.now()}_${i}`, entry.name, entry.args))
      .filter((call) => call.name);

    // "length" means the model was cut off by its own output limit; no
    // finish_reason at all means the connection died. Both used to look
    // identical to a clean "stop".
    if (finishReason === "length" && content.trim()) {
      content += "\n\n_(the model hit its output limit — the reply was cut short)_";
    } else if (!finishReason && content.trim()) {
      throw new Error("the model stream ended before it finished — the reply was cut off");
    }
    return { content, toolCalls, provider: "openai", dropped };
  },

  async probe() {
    if (!config.llm.openaiKey) throw new Error("no OPENAI_API_KEY configured");
    return { ok: true, models: [config.llm.openaiModel], url: config.llm.openaiBaseUrl };
  },
};

/* ─────────────────────────────── mock brain ────────────────────────────── */

const mock = {
  name: "mock",

  async chat(messages, { onDelta } = {}) {
    // If a tool already ran this turn, summarise its output instead of
    // calling it again — that is what makes the mock brain terminate and
    // lets the full agent loop be demonstrated without a model.
    const toolResults = messages.filter((m) => m.role === "tool");
    if (toolResults.length) {
      const last = toolResults[toolResults.length - 1];
      // A tool that registered a source marks its output "(cite as [n])". The
      // mock cites it, so `npm run demo` and CI exercise the citation path —
      // registry, validation, footer — on a machine with no model installed.
      const cite = /\(cite as \[(\d+)\]\)/.exec(String(last.content))?.[1];
      const attribution = cite
        ? `\n\nThat is what [${cite}] says, verbatim.`
        : "";
      return {
        content:
          `🦞 (mock brain) **${last.name}** returned:\n\n${String(last.content).slice(0, 1200)}${attribution}\n\n` +
          `A real model would now explain this, decide the next step, or write the fix. ` +
          `The tool chain, permissions and memory you just saw are the real thing.`,
        toolCalls: [],
        provider: "mock",
      };
    }

    const last = [...messages].reverse().find((m) => m.role === "user");
    const text = String(last?.content || "");
    // "remind me in 20 minutes to stretch" → remind {when:"in 20 minutes", text:"stretch"}
    const remindMatch = /^remind me (.*?) to (.+)$/i.exec(text);
    if (remindMatch) {
      return {
        content: "",
        toolCalls: [{
          id: `mock_${Date.now()}`,
          name: "remind",
          arguments: { when: remindMatch[1].trim(), text: remindMatch[2].trim() },
        }],
        provider: "mock",
      };
    }

    const toolHints = [
      [/^(run|exec|shell)\s+/i, "shell"],
      [/^(read|cat|open)\s+/i, "read_file"],
      [/^(list|ls|dir)\s*/i, "list_dir"],
      [/remember (that )?/i, "remember"],
      [/^search /i, "search_web"],
      [/^(calc|math)\s+/i, "calculator"],
    ];
    for (const [pattern, tool] of toolHints) {
      if (pattern.test(text)) {
        const arg =
          tool === "shell"
            ? { command: text.replace(/^(run|exec|shell)\s+/i, "") }
            : tool === "remember"
              ? { fact: text.replace(/remember (that )?/i, "") }
              : tool === "search_web"
                ? { query: text.replace(/^search /i, "") }
                : tool === "calculator"
                  ? { expression: text.replace(/^(calc|math)\s+/i, "") }
                  : { path: text.replace(/^(read|cat|open|list|ls|dir)\s*/i, "") || "." };
        return {
          content: "",
          toolCalls: [{ id: `mock_${Date.now()}`, name: tool, arguments: arg }],
          provider: "mock",
        };
      }
    }
    const canned =
      `🦞 (mock brain) I heard: "${text.slice(0, 200)}".\n\n` +
      `No real model is configured yet, so this is a canned reply used to prove the plumbing works.\n` +
      `Point LLM_PROVIDER at Ollama or an OpenAI-compatible endpoint and I'll actually think.`;
    if (onDelta) {
      // Emit word by word so the streaming UI can be tested without a model.
      for (const word of canned.split(/(\s+)/)) onDelta(word);
    }
    return { content: canned, toolCalls: [], provider: "mock" };
  },

  async probe() {
    return { ok: true, models: ["mock"], url: "in-process" };
  },
};

/* ──────────────────────────────── registry ─────────────────────────────── */

export function safeParse(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Parse a tool call's arguments, but remember when it failed.
 *
 * `safeParse` returned `{}` on a bad payload, so a model that emitted
 * `{"path": "src/a.js",}` — a trailing comma, which is common — had its
 * arguments silently replaced with emptiness and the tool still ran, usually
 * doing nothing useful and reporting a confusing error. The failure is now
 * carried on the call so the agent can tell the model to re-emit it.
 */
export function parseArgs(value) {
  if (value == null) return { value: {}, error: null };
  if (typeof value === "object") return { value, error: null };
  const text = String(value).trim();
  if (!text) return { value: {}, error: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: {}, error: "arguments must be a JSON object" };
    }
    return { value: parsed, error: null };
  } catch (err) {
    return { value: {}, error: String(err.message || err) };
  }
}

/** One place where a provider's tool call becomes our shape. */
function toCall(id, name, rawArgs) {
  const { value, error } = parseArgs(rawArgs);
  return error ? { id, name, arguments: value, parseError: error } : { id, name, arguments: value };
}

const PROVIDERS = { ollama, openai, mock };

let probeCache = null;
let runtimeModel = null;

function configuredModel() {
  const provider = Object.hasOwn(PROVIDERS, config.llm.provider) ? config.llm.provider : "ollama";
  return { provider, model: provider === "ollama" ? config.llm.ollamaModel : provider === "openai" ? config.llm.openaiModel : "mock" };
}

function modelError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** One command implementation for messaging channels and the web SSE endpoint.
 * Bare names select local Ollama. Sending history to a cloud provider requires
 * an explicit `openai/` prefix and a server-side configured credential/endpoint.
 */
export async function modelCommand(text) {
  const match = /^\/model(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  const requested = (match[1] || "").trim();
  if (requested) {
    try {
      if (requested === "default") brain.resetModel();
      else {
        const prefixed = /^(ollama|openai|mock)\/(.+)$/.exec(requested);
        await brain.setModel({ provider: prefixed ? prefixed[1] : "ollama", model: prefixed ? prefixed[2] : requested });
      }
      const active = brain.active;
      return `🦞 Active model: ${active.provider} / ${active.model}. Applies globally to new turns; .env is unchanged.`;
    } catch (err) { return `🦞 Model unchanged: ${err.message}`; }
  }
  const models = await brain.probe();
  const active = brain.active;
  const local = models.ollama.ok ? models.ollama.models.join(", ") || "none installed" : "unavailable";
  return `🦞 Active model: ${active.provider} / ${active.model}\nLocal Ollama models: ${local}\nUse /model <local-name>, /model openai/<name> (configured endpoint; may send history remotely), or /model default. Changes apply globally to new turns and reset on restart.`;
}

export const brain = {
  get active() { return Object.freeze({ ...(runtimeModel || configuredModel()) }); },

  get provider() { return PROVIDERS[this.active.provider]; },

  resetModel() { runtimeModel = null; },

  async setModel(selection) {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw modelError("Expected { provider, model }.");
    if (Object.keys(selection).some((key) => !["provider", "model"].includes(key))) throw modelError("Only provider and model can be changed at runtime.");
    const { provider, model } = selection;
    if (typeof provider !== "string" || !Object.hasOwn(PROVIDERS, provider)) throw modelError("Provider must be ollama, openai or mock.");
    if (typeof model !== "string" || model.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(model)) throw modelError("Model must use letters, digits, dots, underscores, colons, slashes, @, + or - (max 200 characters).");
    let selected = model;
    if (provider === "ollama") {
      let available;
      try { available = (await ollama.probe()).models; }
      catch { throw modelError("Ollama is unreachable; start it with ollama serve and retry.", 502); }
      if (!available.includes(selected) && available.includes(`${selected}:latest`)) selected += ":latest";
      if (!available.includes(selected)) throw modelError("Model is not installed in Ollama; pull it first or choose a listed model.");
    }
    if (provider === "openai" && !config.llm.openaiKey) throw modelError("OPENAI_API_KEY is not configured; configure the endpoint and key before selecting openai.");
    if (provider === "mock" && model !== "mock") throw modelError("The mock provider only supports model 'mock'.");
    // No URL, credential or .env mutation is accepted through this interface.
    runtimeModel = Object.freeze({ provider, model: selected });
    probeCache = null;
    return this.active;
  },

  chat(messages, options = {}) {
    const { selection = this.active, ...rest } = options;
    return PROVIDERS[selection.provider].chat(messages, { ...rest, model: rest.model || selection.model });
  },

  /** Probe every provider, cached for 30 s — the panel asks on every load. */
  async probe({ fresh = false } = {}) {
    if (!fresh && probeCache && Date.now() - probeCache.at < 30_000) return probeCache.value;
    const results = {};
    for (const [name, impl] of Object.entries(PROVIDERS)) {
      try {
        results[name] = { ...(await impl.probe()), ok: true };
      } catch (err) {
        results[name] = { ok: false, error: String(err.message || err) };
      }
    }
    probeCache = { at: Date.now(), value: results };
    return results;
  },
};
