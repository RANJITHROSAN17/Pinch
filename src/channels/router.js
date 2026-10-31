/**
 * router.js — one brain, many doors.
 *
 * Every channel hands a plain {channel, text, send} to this module and gets
 * back the same behaviour: approvals, agent turn, chunked reply. That is why
 * Pinch behaves identically in Telegram, Discord, Slack, WhatsApp and web.
 */
import { runAgent, answerApproval, answerApprovalFor, pendingApprovalsFor } from "../agent.js";
import { config } from "../config.js";

const YES = /^(y|yes|yeah|yep|ok|okay|allow|approve|go|do it|sure)\.?!?$/i;
const NO = /^(n|no|nope|deny|stop|cancel|abort|nah)\.?!?$/i;

export function splitForLimit(text, limit = 4000) {
  const out = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/** Human-friendly summary of a tool call for a chat bubble. */
function approvalPrompt(description) {
  return (
    `🦞 Claws up — I want to \`${description}\`.\n\n` +
    `Reply **yes** to allow, **no** to stop. (Nothing runs without your say-so.)`
  );
}

/**
 * @param {object} opts
 * @param {string} opts.channel       "telegram" | "discord" | "slack" | "whatsapp"
 * @param {string} opts.text          the incoming message
 * @param {(text: string) => Promise<void>} opts.send
 * @param {string} [opts.sessionId]   keeps per-chat history separate
 * @param {() => Promise<void>} [opts.onProgress]
 * @param {(event: {id: string, description: string}) => Promise<void>} [opts.onApproval]
 *        channels with real buttons (Telegram) render their own prompt;
 *        everyone else gets the plain "reply yes/no" text.
 */
export async function routeMessage({ channel, text, send, sessionId, target = "", onProgress, onApproval }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { handled: false };

  // 1) Is this a reply to a permission prompt? Scoped to this conversation:
  //    two chats behind one bot are two "telegram" channels to a channel check.
  if (pendingApprovalsFor(sessionId || `${channel}-main`).length) {
    if (YES.test(trimmed)) {
      answerApprovalFor({ sessionId: sessionId || `${channel}-main`, channel }, true);
      await send("🦞 Allowed. On it.");
      return { handled: true, kind: "approval" };
    }
    if (NO.test(trimmed)) {
      answerApprovalFor({ sessionId: sessionId || `${channel}-main`, channel }, false);
      await send("🦞 Denied — I'll leave that alone. What would you rather I do?");
      return { handled: true, kind: "approval" };
    }
  }

  // 2) Built-in commands, available identically everywhere.
  if (/^\/(start|help)\b/i.test(trimmed)) {
    await send(
      `🦞 **Pinch** — your local assistant.\n\n` +
        `Just talk to me like a person. I can:\n` +
        `• read/write code and run commands (you approve each one)\n` +
        `• search the web, do maths, remember facts\n` +
        `• keep tasks, explain errors, plan projects\n\n` +
        `Commands: /help · /reset (new session) · /status\n` +
        `When I ask to run something, reply **yes** or **no**.`
    );
    return { handled: true, kind: "help" };
  }

  if (/^\/(reset|new)\b/i.test(trimmed)) {
    await send("🦞 Fresh session. Previously, on Pinch: nothing. Let's start clean.");
    return { handled: true, kind: "reset", reset: sessionId };
  }

  if (/^\/status\b/i.test(trimmed)) {
    const pending = pendingApprovalsFor(sessionId || `${channel}-main`);
    await send(
      `🦞 **Status**\n` +
        `Brain: ${config.llm.provider} / ${config.llm.provider === "ollama" ? config.llm.ollamaModel : config.llm.openaiModel}\n` +
        `Workspace: ${config.workspaceRoots.join(", ")}\n` +
        `Approvals waiting: ${pending.length}\n` +
        `Channel: ${channel}`
    );
    return { handled: true, kind: "status" };
  }

  // 3) The actual turn.
  if (onProgress) await onProgress();
  const result = await runAgent({
    sessionId: sessionId || `${channel}-main`,
    text: trimmed,
    channel,
    target: target || sessionId || `${channel}-main`,
    onEvent: async (event) => {
      if (event.type !== "approval") return;
      if (onApproval) await onApproval({ id: event.id, description: event.description });
      else await send(approvalPrompt(event.description));
    },
  });

  for (const chunk of splitForLimit(result.text, channel === "discord" ? 1900 : 4000)) {
    await send(chunk);
  }
  return { handled: true, kind: "answer", result };
}

export { answerApproval };
