const MAX_REPLY_HEADER_CHARS = 400;

/**
 * Keep quoted Telegram replies with the new message while bounding how much
 * untrusted quoted text enters the model context.
 */
export function formatIncomingTelegramText(msg, { preserveApprovalReply = false } = {}) {
  const text = String(msg?.text || msg?.caption || "");
  if (preserveApprovalReply && /^(?:yes|no)[.!?]?$/i.test(text.trim())) return text;

  const reply = msg?.reply_to_message?.text || msg?.reply_to_message?.caption;
  if (typeof reply !== "string" || !reply.trim()) return text;

  const prefix = "[Replying to: ";
  const suffix = "]\n";
  const chars = Array.from(reply.trim().replace(/\s+/g, " "));
  let quote = chars.slice(0, MAX_REPLY_HEADER_CHARS);
  let truncated = quote.length < chars.length;
  let header = prefix + JSON.stringify(quote.join("") + (truncated ? "…" : "")) + suffix;

  while (header.length > MAX_REPLY_HEADER_CHARS) {
    quote.pop();
    truncated = true;
    header = prefix + JSON.stringify(quote.join("") + (truncated ? "…" : "")) + suffix;
  }

  return header + text;
}
