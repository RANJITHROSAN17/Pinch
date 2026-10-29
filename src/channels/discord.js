/**
 * discord.js — gateway listener built on Pinch's own tiny WebSocket client.
 *
 * Needs one thing enabled in the Discord developer portal:
 *   Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT (on)
 * Otherwise Discord delivers empty message bodies and Pinch looks deaf.
 */
import { WebSocketClient } from "./ws.js";
import { config } from "../config.js";
import { routeMessage } from "./router.js";
import { registerSender } from "../outbound.js";

const API = "https://discord.com/api/v10";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS, GUILD_MESSAGES, DM, MESSAGE_CONTENT

function chunk(text, size = 1900) {
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

export function startDiscord(log = console) {
  if (!config.discord.token) return null;

  const allowed = new Set(config.discord.channelIds.map(String));
  let ws = null;
  let heartbeatTimer = null;
  let seq = null;
  let sessionId = null;
  let resumeUrl = null;
  let stopped = false;
  let botUserId = null;

  async function rest(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        authorization: `Bot ${config.discord.token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`discord ${path}: ${res.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : {};
  }

  async function send(channelId, text) {
    for (const part of chunk(text)) {
      await rest(`/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
      }).catch((err) => log.warn?.(err.message));
    }
  }

  async function onMessageCreate(payload) {
    const message = payload.d;
    if (!message || message.author?.bot) return;
    if (botUserId && message.author?.id === botUserId) return;
    if (allowed.size && !allowed.has(String(message.channel_id))) return;

    const text = String(message.content || "")
      .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
      .trim();
    if (!text) return;

    try {
      await rest(`/channels/${message.channel_id}/typing`, { method: "POST" }).catch(() => {});
      await routeMessage({
        channel: "discord",
        text,
        sessionId: `discord-${message.channel_id}`,
        target: message.channel_id,
        send: (t) => send(message.channel_id, t),
      });
    } catch (err) {
      await send(message.channel_id, `🦞 Something jammed: ${err.message}`);
    }
  }

  function startHeartbeat(intervalMs) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws?.open) ws.send(JSON.stringify({ op: 1, d: seq }));
    }, intervalMs);
  }

  function connect() {
    if (stopped) return;
    const url = resumeUrl || "wss://gateway.discord.gg/?v=10&encoding=json";
    ws = new WebSocketClient(url).connect();

    ws.on("message", async (raw) => {
      let packet;
      try {
        packet = JSON.parse(raw);
      } catch {
        return;
      }
      if (packet.s !== null && packet.s !== undefined) seq = packet.s;

      switch (packet.op) {
        case 10: {
          startHeartbeat(packet.d.heartbeat_interval);
          if (sessionId && resumeUrl) {
            ws.send(JSON.stringify({
              op: 6,
              d: { token: config.discord.token, session_id: sessionId, seq },
            }));
          } else {
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: config.discord.token,
                intents: INTENTS,
                properties: { os: process.platform, browser: "pinch", device: "pinch" },
              },
            }));
          }
          break;
        }
        case 11: // heartbeat ACK
          break;
        case 7: // reconnect
          ws.close(4000);
          break;
        case 9: // invalid session
          sessionId = null;
          resumeUrl = null;
          setTimeout(connect, 2000);
          break;
        case 0:
          if (packet.t === "READY") {
            sessionId = packet.d.session_id;
            resumeUrl = packet.d.resume_gateway_url ? `${packet.d.resume_gateway_url}/?v=10&encoding=json` : null;
            botUserId = packet.d.user.id;
            log.info?.(`discord: connected as ${packet.d.user.username}#${packet.d.user.discriminator} — watching ${allowed.size || "all"} channel(s)`);
          } else if (packet.t === "MESSAGE_CREATE") {
            onMessageCreate(packet);
          }
          break;
      }
    });

    ws.on("error", (err) => log.warn?.(`discord socket: ${err.message}`));
    ws.on("close", () => {
      clearInterval(heartbeatTimer);
      if (!stopped) setTimeout(connect, 3000);
    });
  }

  registerSender("discord", (target, text) => send(target, text));
  connect();

  return {
    name: "discord",
    stop() {
      stopped = true;
      clearInterval(heartbeatTimer);
      ws?.close();
    },
  };
}
