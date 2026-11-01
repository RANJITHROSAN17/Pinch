/**
 * telegram.js — long polling against the Bot API. No webhook, no public IP,
 * works from behind your router. Approvals get real inline buttons.
 */
import { config } from "../config.js";
import { routeMessage } from "./router.js";
import { answerApproval, pendingApprovalsFor } from "../agent.js";
import { registerSender } from "../outbound.js";
import { formatIncomingTelegramText } from "./telegram-reply.js";

const API = (method) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

async function call(method, payload) {
  const res = await fetch(API(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(70_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description || "failed"}`);
  return json.result;
}

function chunk(text, size = 4000) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export function startTelegram(log = console) {
  if (!config.telegram.token) return null;

  const approved = new Set(config.telegram.allowedIds.map(String));
  let offset = 0;
  let running = true;

  const allowed = (id) => approved.size === 0 || approved.has(String(id));

  async function send(chatId, text, extra = {}) {
    for (const part of chunk(text)) {
      await call("sendMessage", { chat_id: chatId, text: part, parse_mode: "Markdown", disable_web_page_preview: true, ...extra }).catch(
        (err) => {
          // Markdown can fail on unbalanced characters — retry as plain text.
          if (String(err.message).includes("can't parse")) {
            return call("sendMessage", { chat_id: chatId, text: part, ...extra });
          }
          log.warn?.(`telegram send: ${err.message}`);
        }
      );
    }
  }

  async function sendApproval(chatId, id, description) {
    await call("sendMessage", {
      chat_id: chatId,
      text: `🦞 Claws up — I want to \`${description}\`.\n\nAllow it?`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Allow", callback_data: `ap:${id}:1` },
            { text: "❌ Deny", callback_data: `ap:${id}:0` },
          ],
        ],
      },
    }).catch(async () => {
      await send(chatId, `🦞 I want to \`${description}\`. Reply yes or no.`);
    });
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const incomingText = msg.text || msg.caption || "";
    if (!incomingText) {
      await send(chatId, "🦞 I can only read text for now. Voice notes are on the roadmap — use the web panel mic for talking.");
      return;
    }

    if (!allowed(userId)) {
      log.warn?.(`telegram: blocked unauthorised user ${userId}`);
      await send(
        chatId,
        `🦞 This bot is private.\n\nYour Telegram user id is \`${userId}\`.\n` +
          `Add it to \`TELEGRAM_ALLOWED_IDS\` in .env and restart Pinch to grant access.`
      );
      return;
    }

    const sessionId = `telegram-${chatId}`;
    const approvalReply = pendingApprovalsFor(sessionId).length > 0 &&
      /^(?:yes|no)[.!?]?$/i.test(incomingText.trim());
    const text = formatIncomingTelegramText(msg, { preserveApprovalReply: approvalReply });

    await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    try {
      await routeMessage({
        channel: "telegram",
        text,
        sessionId,
        target: String(chatId),
        send: (t) => send(chatId, t),
        onProgress: async () => {
          await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
        },
        onApproval: ({ id, description }) => sendApproval(chatId, id, description),
      });
    } catch (err) {
      await send(chatId, `🦞 Something jammed: ${err.message}`);
    }
  }

  async function poll() {
    while (running) {
      try {
        const updates = await call("getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) await handleMessage(update.message);
          if (update.callback_query) {
            const [tag, id, decision] = String(update.callback_query.data || "").split(":");
            if (tag === "ap") answerApproval(id, decision === "1");
            await call("answerCallbackQuery", {
              callback_query_id: update.callback_query.id,
              text: decision === "1" ? "Allowed 🔧" : "Denied",
            }).catch(() => {});
            const chatId = update.callback_query.message?.chat?.id;
            if (chatId) await send(chatId, decision === "1" ? "🦞 Allowed. On it." : "🦞 Denied — leaving that alone.");
          }
        }
      } catch (err) {
        log.warn?.(`telegram poll: ${err.message} — retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  (async () => {
    try {
      const me = await call("getMe");
      await call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
      registerSender("telegram", (target, text) => send(target, text));
      log.info?.(`telegram: connected as @${me.username}${approved.size ? ` (${approved.size} allowed id(s))` : ""}`);
      if (!approved.size) {
        log.warn?.(`telegram: TELEGRAM_ALLOWED_IDS is empty — the bot will reply with your id so you can lock it down.`);
      }
      poll();
    } catch (err) {
      log.warn?.(`telegram: could not connect — ${err.message}`);
    }
  })();

  return {
    name: "telegram",
    stop: () => {
      running = false;
    },
  };
}
