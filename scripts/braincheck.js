#!/usr/bin/env node
/**
 * scripts/brain-test.js — "pinch brain-test"
 *
 * Two questions that actually matter before you trust a local model with your
 * machine: how fast is it, and can it call tools at all? A model that chats
 * beautifully but never emits a tool call makes Pinch a very expensive diary.
 */
import { brain } from "../src/brain.js";
import { config } from "../src/config.js";
import { toolSchemas } from "../src/tools.js";

const C = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  teal: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const model =
  config.llm.provider === "ollama" ? config.llm.ollamaModel : config.llm.openaiModel;

console.log(`\n${C.coral("🦞  brain-test")}  ${C.dim(`${config.llm.provider} · ${model}`)}\n`);

const probe = await brain.probe();
const current = probe[config.llm.provider];
if (!current?.ok) {
  console.log(`  ${C.red("✖")} provider unreachable: ${current?.error || "unknown"}`);
  console.log(`  ${C.dim("ollama: start it with `ollama serve`. openai: check OPENAI_API_KEY.")}\n`);
  process.exit(1);
}
console.log(`  ${C.teal("✔")} provider reachable`);

// ── 1. speed ──────────────────────────────────────────────────────────────
process.stdout.write(`  ${C.dim("speed …")}\r`);
const t0 = Date.now();
let firstTokenAt = null;
let reply;
try {
  reply = await brain.chat([{ role: "user", content: "Reply with exactly: ready" }], {
    onDelta: () => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
    },
  });
} catch (err) {
  console.log(`  ${C.red("✖")} chat failed: ${err.message}\n`);
  process.exit(1);
}
const total = Date.now() - t0;
const ttft = firstTokenAt ? firstTokenAt - t0 : null;
const tps = reply.content ? Math.round((reply.content.split(/\s+/).length / total) * 60000) : 0;

console.log(`  ${C.teal("✔")} first token ${ttft === null ? "n/a (no streaming)" : `${ttft} ms`} · full reply ${total} ms · ~${tps} words/s`);

// ── 2. tool calling ───────────────────────────────────────────────────────
process.stdout.write(`  ${C.dim("tool calling …")}\r`);
let toolOk = false;
let toolName = null;
try {
  const call = await brain.chat(
    [
      { role: "system", content: "You are a tool-using assistant. Use tools when they fit." },
      { role: "user", content: "What is (1200 * 1.18) / 3? Use the calculator tool." },
    ],
    { tools: toolSchemas() }
  );
  toolName = call.toolCalls?.[0]?.name || null;
  toolOk = Boolean(toolName);
} catch (err) {
  console.log(`  ${C.red("✖")} tool test failed: ${err.message}\n`);
  process.exit(1);
}

if (toolOk) {
  console.log(`  ${C.teal("✔")} tool calling works (chose "${toolName}")`);
} else {
  console.log(`  ${C.gold("▲")} the model answered without calling a tool`);
  console.log(`    ${C.dim("It may still work for chat, but Pinch's whole point is doing things.")}`);
  console.log(`    ${C.dim("Use a tool-capable model: qwen2.5-coder:7b, llama3.1:8b, mistral-nemo, qwen3:8b.")}`);
}

// ── verdict ───────────────────────────────────────────────────────────────
const fast = total < 8000;
console.log("");
if (toolOk && fast) {
  console.log(`  ${C.teal("Verdict:")} good to go. ${C.dim(`(${model})`)}\n`);
} else if (toolOk && !fast) {
  console.log(`  ${C.gold("Verdict:")} works, but slow (${(total / 1000).toFixed(1)} s per short reply).`);
  console.log(`  ${C.dim("Try a smaller quant, a smaller model, or check `ollama ps` shows GPU not CPU.")}\n`);
} else {
  console.log(`  ${C.gold("Verdict:")} chat-only. Switch model before relying on the agent tools.\n`);
}
process.exit(toolOk ? 0 : 2);
