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
import { TOOL_MAP, DANGEROUS, toolSchemas, SafePathError, screenCommand } from "./tools.js";
import { loadSession, appendMessage, loadMemory } from "./store.js";
import { auditReply, renderGuardNote } from "./guard.js";
import { addressFor } from "./outbound.js";
import { renderForPrompt } from "./attachments.js";
import { config as cfg } from "./config.js";

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
  if (name === "shell") {
    const screen = screenCommand(args.command || "");
    // Surface paths outside the workspace in the prompt itself: the human
    // decision is the real control, so give them the one detail that matters.
    const outside = screen.escapes?.length ? `  ⚠ outside workspace: ${screen.escapes.join(", ")}` : "";
    return `run: ${args.command}${args.cwd ? `  (in ${args.cwd})` : ""}${outside}`;
  }
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
export async function runAgent({ sessionId, text, attachments = [], channel = "web", target = "", onEvent = () => {} }) {
  const session = loadSession(sessionId);
  const history = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content }));

  appendMessage(sessionId, { role: "user", content: text });

  // Attached files become a labelled block ahead of the question, and images
  // travel with the message itself for a vision-capable model. The wrapper is
  // the mitigation against a document that contains instructions; see
  // docs/AUDIT.md for why it is a mitigation and not a promise.
  const attachmentBlock = renderForPrompt(attachments);
  const userTurn = { role: "user", content: attachmentBlock.text ? `${attachmentBlock.text}\n\n---\n\n${text}` : text };
  if (attachmentBlock.images.length) userTurn.images = attachmentBlock.images;

  let messages = [
    { role: "system", content: buildSystemPrompt({ channel }) },
    ...history,
    userTurn,
  ];

  const trace = [];
  const toolOutputs = [];
  let finalText = "";
  const ctx = { channel, target: addressFor(channel, target), sessionId };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    onEvent({ type: "status", message: round === 0 ? "thinking" : "thinking again" });

    let out;
    let streamed = "";
    try {
      // Stream the model's words straight to whoever is waiting. Tool rounds
      // usually produce no text, so this costs nothing when it does not apply.
      out = await brain.chat(messages, {
        tools: toolSchemas(),
        onDelta: (chunk) => {
          streamed += chunk;
          onEvent({ type: "delta", text: chunk });
        },
      });
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
        result = await tool.run(call.arguments || {}, ctx);
      } catch (err) {
        result = {
          ok: false,
          output:
            err instanceof SafePathError
              ? err.message
              : `Tool ${tool.name} threw: ${err.message}`,
        };
      }

      toolOutputs.push(String(result.output));
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

  // Post-hoc honesty check: does the reply match what actually happened?
  let guard = { flags: [], clean: true };
  if (!cfg.disableGuard && !/^🦞 My brain is unreachable/.test(finalText)) {
    guard = auditReply({
      reply: finalText,
      trace,
      memoryFacts: loadMemory().facts,
      userText: text,
      toolOutput: toolOutputs.join("\n"),
    });
    if (!guard.clean) {
      finalText += renderGuardNote(guard.flags);
      onEvent({ type: "guard", flags: guard.flags });
    }
  }

  appendMessage(sessionId, { role: "assistant", content: finalText, trace, guard: guard.flags });
  return { text: finalText, trace, sessionId, guard: guard.flags };
}

/* ──────────────────────────── one-shot helper ──────────────────────────── */

export async function ask(text, { channel = "cli" } = {}) {
  const sessionId = `oneshot-${channel}`;
  const { text: answer } = await runAgent({ sessionId, text, channel });
  return answer;
}

