/**
 * cost.js — what the turns actually cost, priced locally.
 *
 * Two reasons this is here and not in a dashboard:
 *
 *   1. The honest one. A local model costs nothing to run, and "free" is a
 *      feature. But the moment someone points Pinch at a paid provider, the
 *      absence of a number is the problem — you cannot decide to stop spending
 *      money you are not measuring.
 *   2. The measurement problem. A price table is a fact with an expiry date.
 *      Prices change, a table rots, and a number presented without its date is
 *      a guess wearing a currency symbol. So every report carries the date the
 *      table was checked, and a model that is not in the table reports
 *      "unknown" — never 0, which would read as free.
 *
 * Tokens come from the existing telemetry log (data/telemetry.ndjson): one
 * NDJSON line per turn, already written, already local. Nothing new is measured;
 * this only puts a price on what was already counted.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/** The date these numbers were read. Anything older than a quarter is a warning. */
export const PRICE_TABLE_DATE = "2026-11-01";

/**
 * USD per 1,000,000 tokens, { in, out }.
 *
 * Only the models this product can actually be pointed at. A model absent from
 * this table is reported as unknown rather than guessed — an invented price is
 * worse than no price, because it gets budgeted against.
 */
export const PRICES = Object.freeze({
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "o3-mini": { in: 1.1, out: 4.4 },
  "claude-3-5-haiku": { in: 0.8, out: 4 },
  "claude-sonnet-4": { in: 3, out: 15 },
  "claude-opus-4": { in: 15, out: 75 },
  "deepseek-chat": { in: 0.27, out: 1.1 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
});

/** A local model runs on your own hardware: no per-token price exists. */
export const LOCAL_PROVIDERS = new Set(["ollama", "mock", "llama.cpp", "llamacpp", "lmstudio"]);

export function priceFor({ provider, model }) {
  if (LOCAL_PROVIDERS.has(String(provider || "").toLowerCase())) {
    return { known: true, local: true, in: 0, out: 0, model: model || provider };
  }
  const key = String(model || "").toLowerCase();
  const exact = PRICES[key];
  if (exact) return { known: true, local: false, ...exact, model: key };
  // Prefix match, longest first: "gpt-4o-mini-2024-07-18" is a gpt-4o-mini.
  const candidates = Object.keys(PRICES)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (candidates.length) return { known: true, local: false, ...PRICES[candidates[0]], model: candidates[0] };
  return { known: false, local: false, model: key || "(unnamed)" };
}

/**
 * Telemetry records total tokens per turn, not the input/output split — the
 * providers do not all report it the same way and inventing a split would fake
 * precision. So cost is reported as a range: everything at the input price to
 * everything at the output price. The real number is inside it, and saying so is
 * more useful than a confident middle.
 */
export function costOfTurn(turn) {
  const price = priceFor(turn);
  const tokens = Number(turn.tokens) || 0;
  if (!price.known) return { state: "unknown", tokens, price };
  if (price.local) return { state: "local", tokens, price, low: 0, high: 0 };
  const per = 1_000_000;
  return {
    state: "priced",
    tokens,
    price,
    low: (tokens * price.in) / per,
    high: (tokens * price.out) / per,
  };
}

function readTurns() {
  const file = join(config.dataDir, "telemetry.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.kind === "turn");
}

/**
 * @param {object} [opts]
 * @param {number} [opts.days] window, default 30
 * @param {Date}   [opts.now]
 */
export function costSummary({ days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * 86_400_000;
  const turns = readTurns().filter((t) => {
    const ts = Date.parse(t.ts || t.at || "");
    return Number.isFinite(ts) ? ts >= since : true; // no timestamp = count it, do not hide it
  });

  const byModel = new Map();
  let unknownTokens = 0;
  let unknownTurns = 0;
  let localTurns = 0;
  let low = 0;
  let high = 0;
  let tokens = 0;

  for (const turn of turns) {
    const c = costOfTurn(turn);
    tokens += c.tokens;
    const key = c.price.model || "(unnamed)";
    const row = byModel.get(key) || { model: key, state: c.state, turns: 0, tokens: 0, low: 0, high: 0 };
    row.turns += 1;
    row.tokens += c.tokens;
    if (c.state === "priced") {
      row.low += c.low;
      row.high += c.high;
      low += c.low;
      high += c.high;
    } else if (c.state === "local") {
      localTurns += 1;
    } else {
      unknownTurns += 1;
      unknownTokens += c.tokens;
    }
    byModel.set(key, row);
  }

  return {
    days,
    since: new Date(since).toISOString(),
    turns: turns.length,
    tokens,
    localTurns,
    unknownTurns,
    unknownTokens,
    low: Number(low.toFixed(4)),
    high: Number(high.toFixed(4)),
    priceTableDate: PRICE_TABLE_DATE,
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

const usd = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** The text `pinch cost` prints. */
export function costReport({ days = 30, json = false } = {}) {
  const s = costSummary({ days });
  if (json) return JSON.stringify(s, null, 2);

  if (!s.turns) {
    return `No turns recorded in ${days} days.\nTelemetry is written per turn to data/telemetry.ndjson; run something first.`;
  }

  const lines = [
    "",
    `  last ${days} days · ${s.turns} turns · ${s.tokens.toLocaleString()} tokens`,
    "",
  ];

  for (const m of s.models) {
    const cost =
      m.state === "priced"
        ? `${usd(m.low)}–${usd(m.high)}`
        : m.state === "local"
          ? "free (runs on your hardware)"
          : "unknown model — not in the price table";
    lines.push(`  ${m.model.padEnd(24)} ${String(m.turns).padStart(5)} turns  ${String(m.tokens).padStart(10)} tokens  ${cost}`);
  }

  lines.push("");
  if (s.low || s.high) {
    lines.push(`  Spent      ${usd(s.low)}–${usd(s.high)}   (range: all-input to all-output pricing)`);
    lines.push(`  Because    telemetry records total tokens per turn, not the input/output split.`);
  }
  if (s.localTurns) lines.push(`  Local      ${s.localTurns} turns on a model you host — no per-token cost exists`);
  if (s.unknownTurns) {
    lines.push(`  Unknown    ${s.unknownTurns} turns (${s.unknownTokens.toLocaleString()} tokens) on a model not in the table`);
    lines.push(`             Prices are a fact with an expiry date; nothing is guessed to fill the gap.`);
  }
  lines.push(`  Priced as  ${s.priceTableDate} — set your provider's current prices in src/cost.js if they moved.`);
  lines.push("");
  return lines.join("\n");
}
