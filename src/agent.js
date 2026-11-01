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
import { createSources, addSource, listSources } from "./sources.js";
import { validateCitations, renderSourceBlock } from "./citations.js";
import { classifyCommand, describeTier, READ as TIER_READ, BLOCKED as TIER_BLOCKED } from "./risk.js";
import { TOOL_MAP, DANGEROUS, toolSchemas, SafePathError, screenCommand } from "./tools.js";
import { loadSession, appendMessage, loadMemory } from "./store.js";
import { auditReply, renderGuardNote } from "./guard.js";
import { addressFor } from "./outbound.js";
import { renderForPrompt } from "./attachments.js";
import { record } from "./telemetry.js";

const MAX_ROUNDS = 8;
/** Characters of tool output one turn may carry into the context, in total. */
const TOOL_OUTPUT_BUDGET = 24_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/* ───────────────────────────── approvals ───────────────────────────────── */

const approvals = new Map(); // id -> { resolve, timer, channel, description, createdAt }

/**
 * Create a permission prompt. Returns { id, promise } so the blocking
 * caller and the channel that draws the buttons share the same id.
 */
export function createApproval({ channel, sessionId = "", description }) {
  const id = `ap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let entry;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    // A prompt nobody answers must not be the only reason the process is alive.
    timer.unref?.();
    entry = { resolve, timer, channel, sessionId, description, createdAt: Date.now() };
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

/**
 * "yes" / "no" typed in chat.
 *
 * Matches on session first: two conversations on one channel (two Telegram
 * chats behind one bot, two browser tabs) both looked like "telegram", so a
 * yes in one could approve a command raised in the other. Falls back to the
 * channel when the caller has no session to offer.
 */
export function answerApprovalFor({ sessionId, channel }, allowed) {
  if (sessionId) {
    const entries = [...approvals.entries()]
      .filter(([, v]) => v.sessionId === sessionId)
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
    if (entries.length) return answerApproval(entries[0][0], allowed);
  }
  return answerApprovalByChannel(channel, allowed);
}

/** @deprecated prefer answerApprovalFor — a channel is not an identity. */
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
    .map(([id, v]) => ({ id, channel: v.channel, sessionId: v.sessionId, description: v.description }));
}

/** Pending prompts for one conversation — what the panel and router ask for. */
export function pendingApprovalsFor(sessionId) {
  return [...approvals.entries()]
    .filter(([, v]) => v.sessionId === sessionId)
    .map(([id, v]) => ({ id, channel: v.channel, sessionId: v.sessionId, description: v.description }));
}

/* ─────────────────────────── tool argument contract ────────────────────── */

/**
 * Check a call against the tool's own JSON Schema before anything runs.
 *
 * The schema was documentation: the model was trusted to fill required fields
 * and not invent others, and `write_file` with `path: undefined` reached the
 * filesystem as `.`. A missing argument is now a sentence the model can act
 * on, which measurably improves small-model tool use — and an unknown one is
 * usually a hallucinated parameter name, which is worth saying out loud.
 *
 * @returns {string|null} a message for the model, or null if the call is fine
 */
export function validateArgs(tool, args) {
  const schema = tool.parameters || {};
  const required = schema.required || [];
  const allowed = Object.keys(schema.properties || {});
  const given = Object.keys(args || {});

  const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
  if (missing.length) {
    return `Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Call ${tool.name} again with ${missing.join(", ")}.`;
  }
  if (allowed.length) {
    const unknown = given.filter((k) => !allowed.includes(k));
    if (unknown.length) {
      return `Unknown argument${unknown.length === 1 ? "" : "s"} for ${tool.name}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`;
    }
  }
  return null;
}

/* ──────────────────────────────── agent ────────────────────────────────── */

/**
 * One line a human can actually judge.
 *
 * This used to fall back to `name(key, key, key)` for everything except shell
 * and write_file — so the prompt for the tool that takes a filename said
 * "screenshot(path)" and showed the word "path". The human gate is the
 * load-bearing control here; a gate that withholds the argument is theatre.
 * Values are shown, truncated, with shell metacharacters called out.
 */
export function describeCall(name, args) {
  const a = args || {};
  if (name === "shell") {
    const screen = screenCommand(a.command || "");
    // Surface paths outside the workspace in the prompt itself: the human
    // decision is the real control, so give them the one detail that matters.
    const outside = screen.escapes?.length ? `  ⚠ outside workspace: ${screen.escapes.join(", ")}` : "";
    return `run: ${a.command}${a.cwd ? `  (in ${a.cwd})` : ""}${outside}`;
  }
  if (name === "write_file") return `write ${a.path} (${Buffer.byteLength(a.content || "", "utf8")} bytes)`;

  const shown = Object.entries(a)
    .map(([key, value]) => {
      const flat = String(value).replace(/\s+/g, " ");
      const clipped = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
      const risky = /[$`(){}|;&<>]/.test(flat) ? "  ⚠ shell metacharacters" : "";
      return `${key}=${clipped}${risky}`;
    })
    .join(", ");
  return `${name}(${shown})`;
}

/**
 * Run one turn.
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.text
 * @param {string} opts.channel
 * @param {(event: object) => void} [opts.onEvent] live progress for the UI
 */
export async function runAgent({
  sessionId,
  text,
  attachments = [],
  channel = "web",
  target = "",
  onEvent = () => {},
  // "interactive" is a human in the loop. "unattended" is a scheduled run with
  // nobody to ask — every dangerous tool is refused instead of prompted, and
  // nothing can create another schedule, because a schedule that can spawn
  // schedules is a fork bomb with a calendar.
  autonomy = "interactive",
  allowSchedule = true,
}) {
  const activeModel = brain.active; // Pin provider/model for the entire tool loop.
  const unattended = autonomy === "unattended";
  const startedAt = Date.now();
  const session = loadSession(sessionId);
  const recent = session.messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-24);
  // Only the last attachment-bearing message keeps its excerpt; older ones keep
  // the one-line "you attached X" note, which is enough to answer follow-ups
  // without carrying 2 KB of document per turn.
  const lastAttached = recent.map((m) => Boolean(m.attachments?.length)).lastIndexOf(true);
  const history = recent.map((m, i) => {
    if (!m.attachments?.length) return { role: m.role, content: m.content };
    const names = m.attachments.map((a) => `${a.name} (${a.kind})`).join(", ");
    const note = `[attached: ${names}]`;
    return { role: m.role, content: i === lastAttached && m.excerpt ? `${m.content}\n\n${note}\n${m.excerpt}` : `${m.content}\n\n${note}` };
  });

  // The document itself lives for one turn (it is in memory, not on disk), but
  // the *fact* that it was attached has to outlive it: "and what was the total
  // on page 2?" was unanswerable because the next turn saw only the typed text.
  // A bounded excerpt, not the whole file, so history stays history-sized.
  const attached = attachments.map((a) => ({
    name: a.name,
    kind: a.kind,
    bytes: a.bytes,
    chars: (a.text || "").length,
    images: (a.images || []).length,
  }));
  appendMessage(sessionId, {
    role: "user",
    content: text,
    // Plain extracted text, never the <untrusted-document> wrapper: a stale
    // wrapper replayed into history would look like a live attachment and would
    // still be carrying its "this is data" preamble three turns later.
    ...(attached.length
      ? { attachments: attached, excerpt: attachments.map((a) => a.text || "").join("\n").slice(0, 2000) }
      : {}),
  });

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
  let rounds = 0;
  let tokens = 0;
  let toolBudget = TOOL_OUTPUT_BUDGET;
  let autoRan = 0;
  // What this turn actually retrieved. Only these can be cited; see sources.js.
  const sources = createSources();
  for (const a of attachments) {
    addSource(sources, { kind: "attachment", title: a.name, ref: a.name, snippet: (a.text || "").slice(0, 160) });
  }
  const ctx = { channel, target: addressFor(channel, target), sessionId, sources };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    onEvent({ type: "status", message: round === 0 ? "thinking" : "thinking again" });

    let out;
    let streamed = "";
    try {
      // Stream the model's words straight to whoever is waiting. Tool rounds
      // usually produce no text, so this costs nothing when it does not apply.
      out = await brain.chat(messages, {
        selection: activeModel,
        tools: toolSchemas(),
        onDelta: (chunk) => {
          streamed += chunk;
          onEvent({ type: "delta", text: chunk });
        },
      });
    } catch (err) {
      finalText =
        `🦞 My brain is unreachable: ${err.message}\n\n` +
        `Check ${activeModel.provider} / ${activeModel.model}; for Ollama use \`ollama serve\` and pull the selected model.`;
      break;
    }

    tokens += out.tokens || 0;

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

      // A call the model malformed is not the human's decision to make, so it
      // is answered before the approval gate — and before the tool runs.
      const invalid = call.parseError
        ? `Your arguments were not valid JSON (${call.parseError}). Re-emit ${call.name} with valid JSON.`
        : validateArgs(tool, call.arguments);
      if (invalid) {
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: invalid });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, invalid: true });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: invalid.slice(0, 200) });
        continue;
      }

      // A scheduled run has no human to ask, so the approval gate cannot apply.
      // The tool is refused — not auto-approved, which would make a schedule a
      // way to launder an approval, and not queued for later, which would make
      // it a way to ambush the user with a prompt they never saw raised.
      if (unattended && (DANGEROUS.has(tool.name) || (tool.name === "schedule" && !allowSchedule))) {
        const why = tool.name === "schedule"
          ? "a scheduled run cannot create another schedule"
          : `${tool.name} needs a human's approval and nobody is here`;
        messages.push({
          role: "tool", name: call.name, toolCallId: call.id,
          content: `Refused: ${why}. Do the part you can do without it, and say plainly in your answer what you could not do and why.`,
        });
        trace.push({ tool: tool.name, args: call.arguments, denied: true, reason: "unattended" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: `refused (unattended): ${why}` });
        continue;
      }

      // Risk tiers. A shell command proven read-only, inside the workspace, does
      // not cost a human's attention — these are things read_file, list_dir and
      // grep already do unprompted. Everything else asks, exactly as before.
      // Unattended turns never reach here: they refuse all of DANGEROUS above.
      let tier = null;
      if (config.riskTiers && !config.autoApprove && tool.name === "shell" && !unattended) {
        tier = classifyCommand(call.arguments?.command, {
          workspaceRoots: config.workspaceRoots,
          cwd: call.arguments?.cwd,
        });

        if (tier.tier === TIER_BLOCKED) {
          messages.push({
            role: "tool", name: call.name, toolCallId: call.id,
            content: `Refused: ${tier.why}. This command is not runnable at all, with or without approval.`,
          });
          trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason: "screen", tier: "blocked" });
          onEvent({ type: "tool_done", name: tool.name, ok: false, preview: `refused: ${tier.why}` });
          continue;
        }

        if (tier.tier === TIER_READ) {
          autoRan += 1;
          onEvent({ type: "auto", name: tool.name, why: describeTier(tier) });
        }
      }

      const mustAsk = DANGEROUS.has(tool.name) && !config.autoApprove && tier?.tier !== TIER_READ;
      if (mustAsk) {
        const { id, promise } = createApproval({ channel, sessionId, description: label });
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

      // Per call it was already capped at 12 000 chars; eight rounds of eight
      // calls could still push ~750 KB into one context. The budget is per
      // turn, and when it runs out the model is told why rather than fed a
      // silently truncated wall of text.
      const raw = String(result.output ?? "");
      const room = Math.max(0, toolBudget);
      const kept = raw.slice(0, Math.min(12_000, room));
      toolBudget -= kept.length;
      const content = kept.length < raw.length
        ? `${kept}\n\n[output truncated — ${raw.length - kept.length} characters not shown; the per-turn tool output budget is ${TOOL_OUTPUT_BUDGET} characters]`
        : kept;

      toolOutputs.push(kept);
      trace.push({
        tool: tool.name,
        args: call.arguments,
        ok: result.ok,
        output: kept.slice(0, 400),
        ...(tier?.tier === TIER_READ ? { tier: "read", auto: true } : {}),
      });
      onEvent({ type: "tool_done", name: tool.name, ok: result.ok, preview: kept.slice(0, 300) });

      messages.push({ role: "tool", name: call.name, toolCallId: call.id, content });
    }
  }

  if (!finalText) {
    finalText =
      "🦞 I hit my tool limit for one turn (8 rounds) without landing an answer. " +
      "Ask me to continue and I'll pick up from here.";
  }

  // Post-hoc honesty check: does the reply match what actually happened?
  // Citation validation runs on the model's own words, before the source block
  // is appended — otherwise the footer's URLs would look like invented links.
  const citations = validateCitations({ text: finalText, sources: listSources(sources) });

  let guard = { flags: [], clean: true };
  if (!config.disableGuard && !/^🦞 My brain is unreachable/.test(finalText)) {
    guard = auditReply({
      reply: finalText,
      trace,
      sources: listSources(sources),
      citedIds: citations.cited,
      memoryFacts: loadMemory().facts,
      // A document the user attached IS evidence. Passing only `text` meant a
      // reply that quoted an invoice's sender was flagged as inventing an
      // address — a false positive on correct behaviour, which is how an
      // honesty check gets switched off and stops catching the real thing.
      userText: attachmentBlock.text ? `${text}\n${attachmentBlock.text}` : text,
      toolOutput: toolOutputs.join("\n"),
    });
    if (!guard.clean) {
      finalText += renderGuardNote(guard.flags);
      onEvent({ type: "guard", flags: guard.flags });
    }
  }

  // The footer is evidence, so it appears only when the reply cites something.
  // An answer from memory must not wear a "Sources" heading: the heading itself
  // implies research, and a heading with nothing under it is a small lie.
  const sourceBlock = renderSourceBlock(citations);
  if (sourceBlock) finalText += sourceBlock;

  if (sources.items.length) {
    onEvent({
      type: "sources",
      items: sources.items.map((s) => ({ ...s, cited: citations.cited.includes(s.id) })),
    });
  }

  appendMessage(sessionId, { role: "assistant", content: finalText, trace, guard: guard.flags });

  const ms = Date.now() - startedAt;
  record({
    kind: "turn",
    sessionId,
    channel,
    autonomy,
    provider: activeModel.provider,
    // Which model, not just which vendor: a price table keys on the model, and
    // "we spent tokens on openai" is not a number anyone can act on.
    model: activeModel.model,
    ms,
    rounds,
    tokens,
    tools: trace.length,
    auto: autoRan,
    guardFlags: guard.flags.length,
    error: /^🦞 My brain is unreachable/.test(finalText) ? "brain-unreachable" : null,
  });

  return {
    text: finalText,
    trace,
    sessionId,
    guard: guard.flags,
    sources: sources.items.map((s) => ({ ...s, cited: citations.cited.includes(s.id) })),
    ms,
  };
}

/* ──────────────────────────── one-shot helper ──────────────────────────── */

export async function ask(text, { channel = "cli" } = {}) {
  const sessionId = `oneshot-${channel}`;
  const { text: answer } = await runAgent({ sessionId, text, channel });
  return answer;
}

