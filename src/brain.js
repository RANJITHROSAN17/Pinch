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
    return { role: m.role, content: m.content ?? "" };
  });
}

const ollama = {
  name: "ollama",

  async chat(messages, { tools = [], model } = {}) {
    const body = {
      model: model || config.llm.ollamaModel,
      messages: toOllamaMessages(messages),
      stream: false,
      options: { temperature: 0.4, num_ctx: 8192 },
    };
    if (tools.length) body.tools = tools;
    const out = await postJson(`${config.llm.ollamaUrl}/api/chat`, body);
    const message = out.message || {};
    return {
      content: message.content || "",
      toolCalls: (message.tool_calls || []).map((call, i) => ({
        id: `call_${Date.now()}_${i}`,
        name: call.function?.name,
        arguments:
          typeof call.function?.arguments === "string"
            ? safeParse(call.function.arguments)
            : call.function?.arguments || {},
      })),
      provider: "ollama",
      raw: out,
    };
  },

  async probe() {
    const res = await fetch(`${config.llm.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
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

  async chat(messages, { tools = [], model } = {}) {
    if (!config.llm.openaiKey) throw new Error("OPENAI_API_KEY is not set");
    const body = {
      model: model || config.llm.openaiModel,
      messages: toOpenAiMessages(messages),
      temperature: 0.4,
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: t.function }));
      body.tool_choice = "auto";
    }
    const out = await postJson(
      `${config.llm.openaiBaseUrl}/chat/completions`,
      body,
      { authorization: `Bearer ${config.llm.openaiKey}` }
    );
    const message = out.choices?.[0]?.message || {};
    return {
      content: message.content || "",
      toolCalls: (message.tool_calls || []).map((call) => ({
        id: call.id || `call_${Date.now()}`,
        name: call.function?.name,
        arguments: safeParse(call.function?.arguments),
      })),
      provider: "openai",
      raw: out,
    };
  },

  async probe() {
    if (!config.llm.openaiKey) throw new Error("no OPENAI_API_KEY configured");
    return { ok: true, models: [config.llm.openaiModel], url: config.llm.openaiBaseUrl };
  },
};

/* ─────────────────────────────── mock brain ────────────────────────────── */

const mock = {
  name: "mock",

  async chat(messages) {
    // If a tool already ran this turn, summarise its output instead of
    // calling it again — that is what makes the mock brain terminate and
    // lets the full agent loop be demonstrated without a model.
    const toolResults = messages.filter((m) => m.role === "tool");
    if (toolResults.length) {
      const last = toolResults[toolResults.length - 1];
      return {
        content:
          `🦞 (mock brain) **${last.name}** returned:\n\n${String(last.content).slice(0, 1200)}\n\n` +
          `A real model would now explain this, decide the next step, or write the fix. ` +
          `The tool chain, permissions and memory you just saw are the real thing.`,
        toolCalls: [],
        provider: "mock",
      };
    }

    const last = [...messages].reverse().find((m) => m.role === "user");
    const text = String(last?.content || "");
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
    return {
      content:
        `🦞 (mock brain) I heard: "${text.slice(0, 200)}".\n\n` +
        `No real model is configured yet, so this is a canned reply used to prove the plumbing works.\n` +
        `Point LLM_PROVIDER at Ollama or an OpenAI-compatible endpoint and I'll actually think.`,
      toolCalls: [],
      provider: "mock",
    };
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

const PROVIDERS = { ollama, openai, mock };

export const brain = {
  get provider() {
    return PROVIDERS[config.llm.provider] || ollama;
  },

  chat(messages, options = {}) {
    return this.provider.chat(messages, options);
  },

  async probe() {
    const results = {};
    for (const [name, impl] of Object.entries(PROVIDERS)) {
      try {
        results[name] = { ...(await impl.probe()), ok: true };
      } catch (err) {
        results[name] = { ok: false, error: String(err.message || err) };
      }
    }
    return results;
  },
};
