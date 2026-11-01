import test from "node:test";
import assert from "node:assert/strict";
import { formatIncomingTelegramText } from "../src/channels/telegram-reply.js";

test("includes quoted reply context before the new message", () => {
  assert.equal(
    formatIncomingTelegramText({
      text: "What about this?",
      reply_to_message: { text: "The original\nmessage" },
    }),
    '[Replying to: "The original message"]\nWhat about this?'
  );
});

test("uses a replied-to caption and the incoming caption", () => {
  assert.equal(
    formatIncomingTelegramText({
      caption: "Follow-up",
      reply_to_message: { caption: "Photo details" },
    }),
    '[Replying to: "Photo details"]\nFollow-up'
  );
});

test("leaves messages unchanged when quoted text is absent or blank", () => {
  assert.equal(formatIncomingTelegramText({ text: "Hello", reply_to_message: { text: "  " } }), "Hello");
  assert.equal(formatIncomingTelegramText({ text: "Hello" }), "Hello");
});

test("bounds the complete quoted header and preserves the new message", () => {
  const result = formatIncomingTelegramText({
    text: "Keep this",
    reply_to_message: { text: "🙂".repeat(1000) },
  });
  const header = result.slice(0, result.indexOf("\n") + 1);
  assert.ok(header.length <= 400);
  assert.match(header, /…"]\n$/);
  assert.ok(result.endsWith("Keep this"));
});

test("preserves yes/no approval replies without adding quoted text", () => {
  for (const answer of ["yes", "Yes!", "no", "NO?"]) {
    assert.equal(
      formatIncomingTelegramText(
        { text: answer, reply_to_message: { text: "untrusted quoted content" } },
        { preserveApprovalReply: true }
      ),
      answer
    );
  }
});

test("quotes and backslashes cannot exceed the header limit", () => {
  const result = formatIncomingTelegramText({
    text: "body",
    reply_to_message: { text: '\\\"'.repeat(1000) },
  });
  const header = result.slice(0, result.indexOf("\n") + 1);
  assert.ok(header.length <= 400);
  assert.ok(result.endsWith("body"));
});


test("only truncates a reply header when its serialized form exceeds the limit", () => {
  const overhead = '[Replying to: ""]\n'.length;
  const fits = "a".repeat(400 - overhead);
  assert.equal(
    formatIncomingTelegramText({ text: "body", reply_to_message: { text: fits } }),
    `[Replying to: ${JSON.stringify(fits)}]\nbody`
  );
  const result = formatIncomingTelegramText({ text: "body", reply_to_message: { text: fits + "a" } });
  const header = result.slice(0, result.indexOf("\n") + 1);
  assert.equal(header.length, 400);
  assert.match(header, /…"]\n$/);
  assert.equal(result.slice(header.length), "body");
});

test("truncated headers remain valid JSON for escaped and supplementary characters", () => {
  for (const reply of ['"'.repeat(1000), "\\".repeat(1000), "\u0000".repeat(1000), "🙂".repeat(1000)]) {
    const result = formatIncomingTelegramText({ text: "untouched body", reply_to_message: { text: reply } });
    const header = result.slice(0, result.indexOf("\n") + 1);
    assert.ok(header.length <= 400);
    const quote = JSON.parse(header.slice("[Replying to: ".length, -2));
    assert.ok(quote.endsWith("…"));
    assert.ok(reply.startsWith(quote.slice(0, -1)));
    assert.equal(result.slice(header.length), "untouched body");
  }
});
