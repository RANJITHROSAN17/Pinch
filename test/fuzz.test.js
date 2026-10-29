/**
 * Property-based fuzzing for the parts that parse hostile input.
 *
 * Everything Pinch reads is attacker-shaped: web pages, files, chat messages,
 * model output. The unit tests check the cases somebody thought of; this checks
 * the ones nobody did, by throwing a few thousand random strings at each entry
 * point and asserting the *properties* that must always hold:
 *
 *   calculator      never throws, never returns non-arithmetic
 *   parseWhen       never throws, never invents a time (null, not a guess)
 *   screenCommand   never throws; a refusal always carries a reason
 *   sessionPath     never leaves data/sessions
 *   markdown md()   never emits an event handler, script tag or javascript: link
 *   search decode   never leaves a tag behind
 *
 * Seeded, so a failure is reproducible: the seed is printed with the input.
 * Run with FUZZ_ITERATIONS=200000 for a long soak; CI runs the default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.env.FUZZ_ITERATIONS || 1500);
const SEED = Number(process.env.FUZZ_SEED || 0x1a5b3c);
process.on("exit", () => {
  try {
    rmSync(process.env.PINCH_DATA, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Scratch dirs in the OS temp area, never inside the repo — a test that litters
// the working tree is a test that eventually gets committed by accident.
process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-fuzz-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-fuzz-data-"));

const { calculate, screenCommand, TOOL_MAP } = await import("../src/tools.js");
const { parseWhen } = await import("../src/timeparse.js");
const { splitForLimit } = await import("../src/channels/router.js");
const { sessionPath } = await import("../src/store.js");
const { config } = await import("../src/config.js");

// ── deterministic randomness ────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "abcABC012 <>/?\\'\"`&;$(){}[]|:.-_=+*%#@!?~^\n\t\r\0\u00e9\u4e2d🦞";
const TRICKY = [
  "<script>alert(1)</script>",
  "https://a.example/\"onmouseover=\"alert(1)",
  "javascript:alert(1)",
  "\0\0\0",
  "../../../etc/passwd",
  "rm -rf $HOME",
  "'; DROP TABLE sessions; --",
  "${HOME}",
  "&amp;lt;script&amp;gt;",
];

function randomString(rng, maxLen = 120) {
  if (rng() < 0.12) return TRICKY[Math.floor(rng() * TRICKY.length)];
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

function forEachFuzz(fn) {
  const rng = mulberry32(SEED);
  for (let i = 0; i < N; i++) {
    const input = randomString(rng);
    try {
      fn(input);
    } catch (err) {
      throw new Error(`input #${i} ${JSON.stringify(input)} (seed ${SEED}) threw: ${err.message}`);
    }
  }
}

// ── the properties ──────────────────────────────────────────────────────────

test(`calculator and its tool wrapper survive ${N} random inputs`, async () => {
  forEachFuzz((input) => {
    // The parser may reject — it must not return junk, and it must not return
    // anything that is not a finite number.
    let value;
    try {
      value = calculate(input);
    } catch (err) {
      assert.ok(err instanceof Error, "calculate threw a non-Error");
      assert.ok(err.message.length > 3 && err.message.length < 200, `unhelpful parser error: ${err.message}`);
      return;
    }
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value), `calculator returned ${value}`);
  });

  // And the layer the model actually talks to must never reject.
  for (const input of ["", "abc", "rm -rf /", "1/0", "2+2", "<script>", "0x1f"]) {
    const r = await TOOL_MAP.get("calculator").run({ expression: input });
    assert.equal(typeof r.ok, "boolean", `tool rejected instead of returning for ${JSON.stringify(input)}`);
    assert.equal(typeof r.output, "string");
  }
});

test(`parseWhen never throws and never invents a time`, () => {
  forEachFuzz((input) => {
    // parseWhen(phrase, now) — a Date, not an options bag (fuzzer's first catch).
    const r = parseWhen(input, new Date("2026-10-30T12:00:00Z"));
    if (r !== null) {
      assert.ok(r.at instanceof Date, "parseWhen returned something without a date");
      assert.ok(!Number.isNaN(r.at.getTime()), "parseWhen returned an Invalid Date");
    }
  });
});

test(`screenCommand never throws, and a refusal always explains itself`, () => {
  forEachFuzz((input) => {
    const v = screenCommand(input);
    assert.equal(typeof v.allowed, "boolean");
    if (!v.allowed) {
      assert.equal(typeof v.reason, "string");
      assert.ok(v.reason.length > 3, "a blocked command with no reason is a bug report waiting to happen");
    }
  });
});

test(`sessionPath never leaves data/sessions`, () => {
  const dir = resolve(config.dataDir, "sessions");
  forEachFuzz((input) => {
    let p;
    try {
      p = sessionPath(input);
    } catch (err) {
      assert.match(err.message, /invalid session id/, `unexpected error: ${err.message}`);
      return;
    }
    assert.ok(p.endsWith(".json"), "session file must be .json");
    assert.ok(!/[\\/]\.\./.test(p), `traversal in path: ${p}`);
    const rel = resolve(p);
    assert.ok(rel.startsWith(dir + sep), `escaped data/sessions: ${rel}`);
  });
});

test(`splitForLimit never loses characters`, () => {
  forEachFuzz((input) => {
    const limit = 1 + Math.floor((input.length % 40) + 1);
    const parts = splitForLimit(input, limit);
    // Splitting deliberately trims newlines at the seam so a message never
    // starts with a blank line — so compare content, not whitespace.
    assert.equal(
      parts.join("").replace(/\s/g, ""),
      input.replace(/\s/g, ""),
      "characters were lost while splitting"
    );
    for (const part of parts) assert.ok(part.length <= limit, `part over the limit: ${part.length} > ${limit}`);
  });
});

// ── the panel renderer, extracted so the shipped function is what runs ──────
const panel = readFileSync(join(root, "public", "index.html"), "utf8");
function loadMarkdown() {
  const start = panel.indexOf("function md(src)");
  let depth = 0;
  let i = panel.indexOf("{", start);
  for (; i < panel.length; i++) {
    if (panel[i] === "{") depth++;
    else if (panel[i] === "}" && --depth === 0) break;
  }
  return new Function(`${panel.slice(start, i + 1)} return md;`)();
}

test(`md() never emits an event handler, script tag or javascript: URL`, () => {
  const md = loadMarkdown();
  forEachFuzz((input) => {
    const html = md(input);
    assert.doesNotMatch(html, /<script/i, "emitted a <script");
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "emitted an inline event handler");
    assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i, "emitted a javascript: href");
    // Every anchor we generate must have exactly these attributes.
    for (const tag of html.match(/<a\b[^>]*>/g) || []) {
      const names = [...tag.matchAll(/\s([a-z-]+)=/gi)].map((m) => m[1].toLowerCase()).sort();
      assert.deepEqual(names, ["href", "rel", "style", "target"], `unexpected attributes: ${names.join(",")}`);
    }
  });
});

test(`the search-result sanitiser never leaves a tag behind`, () => {
  // Same algorithm as src/tools.js search_web; mirrored here so the property is
  // pinned even if that code moves.
  const strip = (s) => {
    let out = s;
    for (let pass = 0; pass < 5; pass++) {
      const next = out.replace(/<[^>]*>/g, "");
      if (next === out) break;
      out = next;
    }
    if (/[<>]/.test(out)) out = out.replace(/[<>]/g, "");
    return out;
  };
  forEachFuzz((input) => {
    const out = strip(input);
    assert.doesNotMatch(out, /<[a-z/!]/i, `tag survived: ${JSON.stringify(out.slice(0, 60))}`);
  });
});
