/**
 * outbound.js — "message me later", from wherever I am.
 *
 * A reminder created on Telegram must arrive on Telegram, not silently in a
 * web panel you are not looking at. Channels register a sender at boot; the
 * scheduler addresses them with a plain `channel:target` string.
 */
const senders = new Map();

export function registerSender(channel, fn) {
  senders.set(channel, fn);
}

export function hasSender(channel) {
  return senders.has(channel);
}

export function listSenders() {
  return [...senders.keys()];
}

/**
 * @param {string} address "telegram:12345" | "web:main" | "cli:"
 * @param {string} text
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendTo(address, text) {
  const index = String(address || "").indexOf(":");
  if (index === -1) return { ok: false, error: `bad address: ${address}` };
  const channel = address.slice(0, index);
  const target = address.slice(index + 1);
  const fn = senders.get(channel);
  if (!fn) return { ok: false, error: `no live sender for "${channel}"` };
  try {
    await fn(target, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

/** Build the address an agent turn should remember for later delivery. */
export function addressFor(channel, target) {
  return `${channel}:${target ?? ""}`;
}
