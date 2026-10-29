/**
 * agent.js — the loop that makes Pinch an agent instead of a chat toy.
 *
 *   user message → model → (tool call → permission? → run → observe) → … → answer
 *
 * Hard rules:
 *  • max 8 tool rounds per turn, so a confused model cannot spin forever;
 *  • a dangerous tool never runs without either explicit approval or
 *    PINCH_AUTO_APPROVE=true;
 *  • every tool failure is fed back to the model as text, never swallowed.
 */
import { config } from "./config.js";
import { brain } from "./brain.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_MAP, DANGEROUS, toolSchemas, SafePathError } from "./tools.js";
import { loadSession, appendMessage } from "./store.js";

const MAX_ROUNDS = 8;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/* ───────────────────────────── approvals ───────────────────────────────── */

const approvals = new Map(); // id -> { resolve, timer, channel, description, createdAt }

/**
 * Create a permission prompt. Returns { id, promise } so the blocking
 * caller and the channel that draws the buttons share the same id.
 */
export function createApproval({ channel, description }) {
  const id = `ap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let entry;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    entry = { resolve, timer, channel, description, createdAt: Date.now() };
    approvals.set(id, entry);
  });
  return { id, promise };
}

/** Called by any channel/handler when the user says yes/no or taps a button. */
export function answerApproval(id, allowed) {
  const entry = approvals.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  approvals.delete(id);
  entry.resolve(Boolean(allowed));
  return true;
}

/** "yes" / "no" typed in chat: resolves the newest pending prompt for that channel. */
export function answerApprovalByChannel(channel, allowed) {
  const entries = [...approvals.entries()]
    .filter(([, v]) => v.channel === channel)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  if (!entries.length) return false;
  return answerApproval(entries[0][0], allowed);
}

export function pendingApprovals(channel) {
  return [...approvals.entries()]
    .filter(([, v]) => !channel || v.channel === channel)
    .map(([id, v]) => ({ id, channel: v.channel, description: v.description }));
}

/* ──────────────────────────────── agent ────────────────────────────────── */

function describeCall(name, args) {
  if (name === "shell") return `run: ${args.command}${args.cwd ? `  (in ${args.cwd})` : ""}`;
  if (name === "write_file") return `write ${args.path} (${Buffer.byteLength(args.content || "", "utf8")} bytes)`;
  return `${name}(${Object.keys(args || {}).join(", ")})`;
}

/**
 * Run one turn.
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.text
 * @param {string} opts.channel
 * @param {(event: object) => void} [opts.onEvent] live progress for the UI
 */
export async function runAgent({ sessionId, text, channel = "web", onEvent = () => {} }) {
  const session = loadSession(sessionId);
  const history = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content }));

  appendMessage(sessionId, { role: "user", content: text });

  let messages = [
    { role: "system", content: buildSystemPrompt({ channel }) },
    ...history,
    { role: "user", content: text },
  ];

  const trace = [];
  let finalText = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onEvent({ type: "status", message: round === 0 ? "thinking" : "thinking again" });

    let out;
    try {
      out = await brain.chat(messages, { tools: toolSchemas() });
    } catch (err) {
      finalText =
        `🦞 My brain is unreachable: ${err.message}\n\n` +
        `Check that \`LLM_PROVIDER=${config.llm.provider}\` is running — for Ollama that is ` +
        `\`ollama serve\` and \`ollama pull ${config.llm.ollamaModel}\`.`;
      break;
    }

    if (!out.toolCalls?.length) {
      finalText = (out.content || "").trim() || "(The model returned an empty reply.)";
      break;
    }

    messages.push({ role: "assistant", content: out.content || "", toolCalls: out.toolCalls });

    for (const call of out.toolCalls) {
      const tool = TOOL_MAP.get(call.name);
      const label = describeCall(call.name, call.arguments);

      if (!tool) {
        messages.push({
          role: "tool", name: call.name, toolCallId: call.id,
          content: `No such tool: ${call.name}. Available: ${[...TOOL_MAP.keys()].join(", ")}`,
        });
        continue;
      }

      if (DANGEROUS.has(tool.name) && !config.autoApprove) {
        const { id, promise } = createApproval({ channel, description: label });
        onEvent({ type: "approval", id, description: label });
        const allowed = await promise;
        if (!allowed) {
          messages.push({
            role: "tool", name: call.name, toolCallId: call.id,
            content: "The user denied permission for this action. Do not retry it; ask what they would prefer.",
          });
          trace.push({ tool: tool.name, args: call.arguments, denied: true });
          continue;
        }
      }

      onEvent({ type: "tool", name: tool.name, label });
      let result;
      try {
        result = await tool.run(call.arguments || {});
      } catch (err) {
        result = {
          ok: false,
          output:
            err instanceof SafePathError
              ? err.message
              : `Tool ${tool.name} threw: ${err.message}`,
        };
      }

      trace.push({ tool: tool.name, args: call.arguments, ok: result.ok, output: String(result.output).slice(0, 400) });
      onEvent({ type: "tool_done", name: tool.name, ok: result.ok, preview: String(result.output).slice(0, 300) });

      messages.push({
        role: "tool", name: call.name, toolCallId: call.id,
        content: String(result.output ?? "").slice(0, 12_000),
      });
    }
  }

  if (!finalText) {
    finalText =
      "🦞 I hit my tool limit for one turn (8 rounds) without landing an answer. " +
      "Ask me to continue and I'll pick up from here.";
  }

  appendMessage(sessionId, { role: "assistant", content: finalText, trace });
  return { text: finalText, trace, sessionId };
}

/* ──────────────────────────── one-shot helper ──────────────────────────── */

export async function ask(text, { channel = "cli" } = {}) {
  const sessionId = `oneshot-${channel}`;
  const { text: answer } = await runAgent({ sessionId, text, channel });
  return answer;
}

