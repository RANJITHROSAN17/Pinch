/**
 * slack.js — polls conversations.history with a bot token.
 *
 * Socket Mode would need a second app-level token (xapp-) and a WS handshake;
 * polling a couple of channels every few seconds is simpler, has no public URL,
 * and is indistinguishable from a human typing on a small workspace.
 */
import { config } from "../config.js";
import { routeMessage } from "./router.js";
import { registerSender } from "../outbound.js";

const API = "https://slack.com/api";

function chunk(text, size = 3900) {
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

export function startSlack(log = console) {
  if (!config.slack.token) return null;

  const channels = config.slack.channelIds;
  if (!channels.length) {
    log.warn?.("slack: SLACK_CHANNEL_IDS is empty — nothing to watch.");
    return null;
  }

  const cursors = new Map(channels.map((id) => [id, String(Math.floor(Date.now() / 1000))]));
  let stopped = false;

  async function call(method, payload) {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.slack.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.error}`);
    return json;
  }

  async function send(channel, text, threadTs) {
    for (const part of chunk(text)) {
      await call("chat.postMessage", {
        channel,
        text: part,
        unfurl_links: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }).catch((err) => log.warn?.(`slack send: ${err.message}`));
    }
  }

  async function tick() {
    for (const channel of channels) {
      try {
        const res = await call("conversations.history", {
          channel,
          oldest: cursors.get(channel),
          limit: 20,
        });
        const messages = (res.messages || []).slice().reverse(); // oldest first
        for (const message of messages) {
          if (Number(message.ts) > Number(cursors.get(channel))) cursors.set(channel, message.ts);
          if (message.bot_id || message.subtype === "bot_message" || message.subtype === "channel_join") continue;
          const text = String(message.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
          if (!text) continue;
          await call("reactions.add", { channel, name: "eyes", timestamp: message.ts }).catch(() => {});
          await routeMessage({
            channel: "slack",
            text,
            sessionId: `slack-${channel}`,
            target: channel,
            // Answer in the same thread when the message was in one.
            send: (t) => send(channel, t, message.thread_ts || undefined),
          });
        }
      } catch (err) {
        if (!String(err.message).includes("ratelimited")) log.warn?.(`slack ${channel}: ${err.message}`);
      }
    }
  }

  (async () => {
    try {
      const auth = await call("auth.test");
      log.info?.(`slack: connected as ${auth.user} in ${auth.team} — watching ${channels.length} channel(s)`);
    } catch (err) {
      return log.warn?.(`slack: could not connect — ${err.message}`);
    }
    registerSender("slack", (target, text) => send(target, text));
    while (!stopped) {
      await tick();
      await new Promise((r) => setTimeout(r, 3500));
    }
  })();

  return { name: "slack", stop: () => { stopped = true; } };
}
