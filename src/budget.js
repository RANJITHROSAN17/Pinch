/**
 * budget.js — what a turn is allowed to cost, in tokens, before it is sent.
 *
 * Nothing enforced this before. `num_ctx` was a hard-coded 8192, the tool
 * schemas alone are ~2 000 tokens, the system prompt ~800, and an attachment
 * up to ~4 400 — so one long document plus a modest history overflowed the
 * window, and Ollama truncates from the *front*, which deletes the system
 * prompt first. The personality, the "never claim what you did not do"
 * instruction and the honesty contract all vanish silently, and they vanish
 * exactly when the user attached something long, which is when instructions
 * matter most.
 *
 * So: reserve room for the answer, never drop the system message, and drop
 * whole old messages from the middle — saying so in the transcript — until the
 * rest fits.
 */
import { config } from "./config.js";

/** ~3.6 chars/token is close enough for English and JSON on llama-family
 *  tokenisers, and an estimate that is 20 % wrong still beats no budget. */
export const approxTokens = (text) => Math.ceil(String(text ?? "").length / 3.6);

export const ctx = {
  get numCtx() {
    return Number(config.numCtx) || 8192;
  },
  get numPredict() {
    return Number(config.numPredict) || 2048;
  },
};

/** The fixed overhead of one request: system prompt + tool schemas. */
export function fixedCost(messages, tools = []) {
  const system = messages.find((m) => m.role === "system");
  return approxTokens(system?.content || "") + approxTokens(tools.length ? JSON.stringify(tools) : "");
}

/**
 * Trim `messages` until it fits, keeping the system prompt and the newest turns.
 *
 * @param {Array} messages provider-neutral history, system message first
 * @param {{tools?: Array, numCtx?: number, numPredict?: number}} [opts]
 * @returns {{messages: Array, dropped: number, tokens: number}}
 */
export function fit(messages, { tools = [], numCtx = ctx.numCtx, numPredict = ctx.numPredict } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages: messages || [], dropped: 0, tokens: 0 };

  const system = messages[0]?.role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : messages.slice();

  // Leave room for the reply as well as the prompt; a prompt that exactly fills
  // the window gets truncated by the provider in the least convenient place.
  let budget = numCtx - numPredict - fixedCost(system ? [system] : [], tools);

  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = approxTokens(rest[i].content) + (rest[i].toolCalls?.length ? approxTokens(JSON.stringify(rest[i].toolCalls)) : 0) + 8;
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(rest[i]);
  }

  // A tool result whose assistant tool_calls message was trimmed is not valid
  // input for either provider — drop the orphans from the front.
  while (kept.length && kept[0].role === "tool") kept.shift();

  const dropped = rest.length - kept.length;
  const out = system ? [system, ...kept] : kept;
  if (dropped > 0 && out.length > 1) {
    out.splice(1, 0, {
      role: "user",
      content: `[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted to fit the context window]`,
    });
  }

  const tokens = out.reduce((n, m) => n + approxTokens(m.content) + 8, 0) + approxTokens(tools.length ? JSON.stringify(tools) : "");
  return { messages: out, dropped, tokens };
}
