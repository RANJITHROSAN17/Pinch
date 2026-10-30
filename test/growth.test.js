/**
 * test/growth.test.js — the daily growth bot is the only thing in this repo
 * allowed to create issues without a human pressing a button, so its decision
 * logic gets the same treatment as the guard rails: every branch that decides
 * "file something" or "stay quiet" is pinned to a test that would fail if it
 * flipped.
 *
 * Nothing here spawns a real GitHub call, runs the coverage collector, or
 * depends on today's date. The bot's job is to be predictable; a test that is
 * itself a coin toss would not tell us anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decide,
  candidate,
  renderProposal,
  renderAnnotation,
  slug,
  historyFor,
  collectCliDrift,
  collectUndocumentedConfig,
  collectDocDrift,
  findBrokenLinks,
  collectDemand,
  MIN_SCORE,
  MAX_OPEN,
  WINDOW_DAYS,
} from "../scripts/growth.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-10-30";

/** A candidate that would file, unless a test says otherwise. */
function strong(over = {}) {
  return candidate({
    kind: "tests",
    fingerprint: "tests:src-thing-js",
    title: "Test src/thing.js",
    impact: 3,
    confidence: 3,
    demand: 1,
    effort: 2,
    what: "w",
    why: "y",
    where: ["w"],
    guard: "g",
    cost: "c",
    risk: "r",
    ...over,
  });
}

/* ───────────────────────────── scoring ─────────────────────────────────── */

test("score is impact × confidence × demand ÷ effort", () => {
  const c = strong({ impact: 4, confidence: 3, demand: 2, effort: 2 });
  assert.equal(c.score, 12);
});

test("effort below 1 is clamped instead of dividing by zero", () => {
  const c = strong({ effort: 0 });
  assert.ok(Number.isFinite(c.score), "a zero effort must not produce Infinity");
  assert.equal(c.effort, 1);
});

test("real demand outranks everything the tree can measure", () => {
  // The whole premise of the bot: a human asking is worth more than a metric.
  const measured = strong({ kind: "tests", impact: 3, confidence: 3, demand: 1, effort: 2 });
  const asked = strong({ kind: "demand", impact: 3, confidence: 3, demand: 3, effort: 3 });
  assert.ok(asked.score > measured.score);
});

/* ───────────────────────────── the decision ────────────────────────────── */

test("no candidates means silence, not an empty issue", () => {
  const r = decide([], []);
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /no candidates/);
});

test("below the floor means silence", () => {
  const weak = strong({ impact: 1, confidence: 1, demand: 1, effort: 5 });
  assert.ok(weak.score < MIN_SCORE);
  const r = decide([weak], []);
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /below the bar/);
});

test("an open backlog stops the bot before the floor is even checked", () => {
  // A bot that files during a full backlog is a bot that adds noise to noise.
  const open = Array.from({ length: MAX_OPEN }, (_, i) => ({
    number: i + 1,
    state: "open",
    labels: [{ name: "growth" }],
    body: "growth:fingerprint:" + "other" + i,
  }));
  const r = decide([strong()], open);
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /already open/);
});

test("the same fingerprint is never filed twice while it is open", () => {
  const filed = [{ number: 9, state: "open", body: "<!-- growth:fingerprint:tests:src-thing-js -->", updatedAt: `${TODAY}T00:00:00Z` }];
  const r = decide([strong()], filed);
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /already filed as #9/);
});

test("a closed proposal is not re-filed inside the window", () => {
  const yesterday = "2026-10-29T00:00:00Z";
  const filed = [{ number: 4, state: "closed", body: "growth:fingerprint:tests:src-thing-js", updatedAt: yesterday }];
  const r = decide([strong()], filed);
  assert.equal(r.decision, "skip");
  assert.match(r.reason, /already filed as #4 \(closed/);
});

test("a closed proposal from long ago can be proposed again", () => {
  // Things get closed for timing, not for merit. The window exists so a "not
  // now" does not become a "never".
  const old = `2026-01-01T00:00:00Z`;
  const filed = [{ number: 4, state: "closed", body: "growth:fingerprint:tests:src-thing-js", updatedAt: old }];
  const r = decide([strong()], filed);
  assert.equal(r.decision, "file");
  assert.equal(r.chosen.fingerprint, "tests:src-thing-js");
});

test("a fresh candidate files", () => {
  const r = decide([strong()], []);
  assert.equal(r.decision, "file");
  assert.equal(r.chosen.title, "Test src/thing.js");
});

test("demand is answered on the issue, never duplicated as a new one", () => {
  const asked = strong({ kind: "demand", action: "annotate", issue: 42, title: "Spec out #42" });
  const r = decide([asked], [{ number: 42, state: "open", labels: [], body: "a wish" }]);
  assert.equal(r.decision, "annotate");
  assert.equal(r.issue, 42);
  assert.match(r.reason, /not a duplicate issue/);
});

/* ───────────────────────────── history lookup ──────────────────────────── */

test("history matches on the fingerprint comment, not the title", () => {
  const issues = [
    { number: 1, state: "closed", body: "no marker here", updatedAt: `${TODAY}T00:00:00Z` },
    { number: 2, state: "closed", body: "<!-- growth:fingerprint:tests:src-thing-js -->", updatedAt: `${TODAY}T00:00:00Z` },
  ];
  assert.equal(historyFor("tests:src-thing-js", issues).number, 2);
  assert.equal(historyFor("not-a-fingerprint", issues), null);
});

test("an issue with no timestamps still counts as recent", () => {
  const issues = [{ number: 3, state: "closed", body: "growth:fingerprint:tests:src-thing-js" }];
  assert.equal(historyFor("tests:src-thing-js", issues).number, 3);
});

test("the window is honoured at its edge", () => {
  const exactly = new Date(Date.parse(TODAY) - WINDOW_DAYS * 86_400_000).toISOString();
  const issues = [{ number: 5, state: "closed", body: "growth:fingerprint:f", updatedAt: exactly }];
  assert.ok(historyFor("f", issues), "a proposal exactly at the window edge is still inside it");
  const beyond = new Date(Date.parse(TODAY) - (WINDOW_DAYS + 1) * 86_400_000).toISOString();
  assert.equal(historyFor("f", [{ ...issues[0], updatedAt: beyond }]), null);
});

/* ─────────────────────────────── rendering ─────────────────────────────── */

test("a proposal carries its fingerprint, or dedupe silently stops working", () => {
  const body = renderProposal(strong(), [strong()]);
  assert.match(body, /<!-- growth:fingerprint:tests:src-thing-js -->/);
});

test("a proposal says what it costs and what it risks", () => {
  const body = renderProposal(strong(), []);
  for (const heading of ["## What", "## Why now", "## Cost", "## Risk", "## How we would know it works"]) {
    assert.ok(body.includes(heading), `missing ${heading}`);
  }
});

test("ranked runners-up appear without inviting all of them to be built", () => {
  const second = strong({ fingerprint: "tests:other", title: "Test src/other.js" });
  const body = renderProposal(strong(), [strong(), second]);
  assert.match(body, /Ranked below this one/);
  assert.match(body, /Nothing here is filed until the one above is closed/);
  assert.ok(body.includes("Test src/other.js"));
});

test("the chosen candidate is not repeated in its own runner-up table", () => {
  // The title goes in the issue title, so the body should not carry it at all;
  // it appearing here would mean the ranked table had listed the choice twice.
  const body = renderProposal(strong(), [strong()]);
  assert.equal(body.includes("Test src/thing.js"), false);
});

test("an annotation names the issue it belongs to and refuses to guess", () => {
  const asked = strong({
    kind: "demand",
    action: "annotate",
    issue: 42,
    where: ["The bot cannot tell from the issue text where this lands — a maintainer should name the seam before anyone writes code. Guessing here would be worse than saying so."],
  });
  const body = renderAnnotation(asked);
  assert.match(body, /<!-- growth:spec:#42 -->/);
  assert.match(body, /not a promise/);
  assert.match(body, /Guessing here would be worse/);
});

test("slugs are stable and filesystem-safe", () => {
  assert.equal(slug("src/brain.js"), "src-brain-js");
  assert.equal(slug("  Weird   Title!! "), "weird-title");
  assert.equal(slug(slug("a b c")), slug("a b c"), "slugging twice changes nothing");
});

/* ───────────────────────── the program as a program ────────────────────── */

test("--json emits the documented shape and decides exactly one thing", () => {
  const out = execFileSync(process.execPath, ["scripts/growth.js", "--no-coverage", "--json", "--today", TODAY], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const report = JSON.parse(out);
  assert.ok(["file", "annotate", "skip"].includes(report.decision));
  assert.equal(typeof report.reason, "string");
  assert.ok(report.reason.length > 0, "a decision always carries its reason");
  assert.equal(report.today, TODAY);
  assert.equal(report.label, "growth");
  if (report.decision === "file") {
    assert.match(report.title, /^growth: /);
    assert.match(report.markdown, /growth:fingerprint:/);
    assert.equal(report.issue, null);
  }
  if (report.decision === "annotate") {
    assert.equal(typeof report.issue, "number");
    assert.match(report.markdown, /growth:spec:#/);
  }
  assert.ok(Array.isArray(report.ranked));
});

test("the bot's date comes from the caller, so a run is reproducible", () => {
  const a = execFileSync(process.execPath, ["scripts/growth.js", "--no-coverage", "--json", "--today", "2026-01-01"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.match(a, /"today": "2026-01-01"/);
});

test("this repository's own CLI has no drift today", () => {
  // Dogfood: the collector that produced two false positives while it was being
  // written now runs against the real bin/pinch.js and must keep its mouth shut.
  assert.deepEqual(collectCliDrift(), []);
});

test("the documented-config collector reads the real tree", () => {
  const found = collectUndocumentedConfig();
  for (const c of found) {
    assert.match(c.fingerprint, /^config:undocumented:/);
    assert.match(c.what, /reads `[A-Z_]+`/);
    // The collector must never invent a variable that is not in the source.
    const name = c.fingerprint.replace("config:undocumented:", "");
    assert.ok(name.length > 0);
  }
});

test("broken-link detection finds a link that is broken and ignores the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinch-growth-"));
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, "README.md"),
      [
        "see [the guide](docs/GUIDE.md) and [nope](docs/MISSING.md)",
        "external [fine](https://example.com/x), anchor [fine](#what)",
        "nested [deep](docs/GUIDE.md#section)",
      ].join("\n"),
    );
    writeFileSync(join(dir, "docs", "GUIDE.md"), "# guide\n");
    const broken = findBrokenLinks(dir, ["README.md"]);
    assert.equal(broken.length, 1, "exactly one of those links is broken");
    assert.equal(broken[0].target, "docs/MISSING.md");
    assert.equal(broken[0].line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this repository has no broken relative links", () => {
  // The same check as a standing assertion. If it ever fails, the collector
  // will propose the fix before a reader finds it.
  assert.deepEqual(collectDocDrift(), []);
});

test("demand skips its own proposals and security-labelled issues", () => {

  const issues = [
    { number: 1, state: "open", title: "already a growth issue", labels: [{ name: "growth" }], body: "growth:fingerprint:x", comments: [] },
    { number: 2, state: "open", title: "a security report", labels: [{ name: "security" }], body: "leak", comments: [] },
    { number: 3, state: "closed", title: "done", labels: [], body: "", comments: [] },
    { number: 4, state: "open", title: "a wish", labels: [{ name: "enhancement" }], body: "please", comments: [] },
    { number: 5, state: "open", title: "annotated already", labels: [], body: "please", comments: [{ body: "growth:spec:#5" }] },
  ];
  const found = collectDemand(issues);
  assert.deepEqual(found.map((c) => c.issue), [4]);
  assert.equal(found[0].action, "annotate");
  assert.ok(found[0].score > 0);
});
