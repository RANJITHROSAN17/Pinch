/**
 * channels/index.js — boot every configured chat app, report which are live.
 *
 * A channel that fails to start (bad token, missing module) is logged and
 * skipped: the rest of Pinch keeps working. Losing Telegram must never take
 * the web panel down with it.
 */
import { config } from "../config.js";
import { startTelegram } from "./telegram.js";
import { startDiscord } from "./discord.js";
import { startSlack } from "./slack.js";
import { startWhatsApp } from "./whatsapp.js";

export async function startChannels(log = console) {
  const started = [];
  const status = {
    web: "on",
    telegram: config.telegram.token ? "starting" : "off",
    discord: config.discord.token ? "starting" : "off",
    slack: config.slack.token ? "starting" : "off",
    whatsapp: config.whatsapp.enabled ? "starting" : "off",
  };

  const boot = async (name, fn) => {
    try {
      const channel = await fn(log);
      if (channel) {
        started.push(channel);
        status[name] = "on";
      } else {
        status[name] = "off";
      }
    } catch (err) {
      status[name] = "error";
      log.warn?.(`${name}: failed to start — ${err.message}`);
    }
  };

  await boot("telegram", () => startTelegram(log));
  await boot("discord", () => startDiscord(log));
  await boot("slack", () => startSlack(log));
  await boot("whatsapp", () => startWhatsApp(log));

  return {
    status,
    stopAll() {
      for (const channel of started) {
        try {
          channel.stop?.();
        } catch {}
      }
    },
  };
}
