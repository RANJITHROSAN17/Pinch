/**
 * test/market.test.js — the research half of "compete with the top assistants".
 *
 * Two things matter here and both are about honesty rather than parsing:
 *
 *   1. A capability Pinch claims to have, with no evidence, is not counted as
 *      present. An inventory that credits itself is how a project talks itself
 *      into complacency.
 *   2. A capability the product has decided against is never proposed, however
 *      unanimous the market is. "Multi-user" is the test case: four of six
 *      competitors ship it, and it is still not backlog.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { featureText, matchCapability, compare, gaps } from "../scripts/market.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function cap(over = {}) {
  return {
    id: "example",
    name: "An example capability",
    keywords: ["web search", "rag"],
    status: "missing",
    policy: "in-scope",
    evidence: [],
    ...over,
  };
}

/** A fake README in the shape these projects actually use. */
const README = `
# Project

![badge](https://example.com/badge.svg)

## Features

- 🔍 **Web search** across the internet with citations
- 📄 Chat with your documents (RAG)
- Some other thing entirely

### Advanced

* Multi-user accounts with roles
`;

test("feature text keeps bullets and headings, drops prose and badges", () => {
  const text = featureText(README);
  assert.match(text, /web search/);
  assert.match(text, /chat with your documents/);
  assert.ok(!text.includes("badge"), "images are not features");
  assert.ok(!text.includes("##"), "markup is stripped");
});

test("an image line is not mistaken for a feature bullet", () => {
  // ![badge](…) starts with "!" — it must not survive as a feature.
  const text = featureText("![logo](x.png)\n- real feature\n");
  assert.ok(!text.includes("logo"));
  assert.match(text, /real feature/);
});

test("keyword matching is case-insensitive and reports what matched", () => {
  const hits = matchCapability(featureText(README), cap());
  assert.deepEqual(hits.sort(), ["rag", "web search"]);
});

test("coverage counts sources that document a capability", () => {
  const caps = [cap()];
  const sources = [
    { repo: "a/a", text: README },
    { repo: "b/b", text: "- web search only\n" },
    { repo: "c/c", text: "nothing relevant here\n" },
    { repo: "d/d", text: "", ok: false },
  ];
  const rows = compare(caps, sources);
  const row = rows.find((r) => r.id === "example");
  assert.equal(row.coveredBy.length, 2);
  assert.equal(row.total, 3, "a source that failed to load is not counted as evidence of absence");
});

test("a gap needs a threshold of the market, not one project's opinion", () => {
  const rows = [{ id: "x", name: "X", status: "missing", policy: "in-scope", coveredBy: [{ repo: "a/a" }], coverage: 1, opportunity: 1 }];
  assert.equal(gaps(rows).length, 0, "one competitor is not a pattern");
  assert.equal(gaps(rows, { threshold: 1 }).length, 1);
});

test("an out-of-scope capability is never proposed, however popular", () => {
  const rows = [
    { id: "multi-user", name: "Multi-user", status: "missing", policy: "out-of-scope", coveredBy: [{ repo: "a" }, { repo: "b" }, { repo: "c" }, { repo: "d" }], coverage: 4, total: 6 },
    { id: "mcp", name: "MCP", status: "missing", policy: "in-scope", coveredBy: [{ repo: "a" }, { repo: "b" }, { repo: "c" }], coverage: 3, total: 6 },
  ];
  const found = gaps(rows);
  assert.deepEqual(found.map((g) => g.id), ["mcp"]);
});

test("a settled capability is shown but not proposed", () => {
  const rows = [{ id: "mobile-app", name: "Native app", status: "partial", policy: "settled", coveredBy: [{ repo: "a" }, { repo: "b" }, { repo: "c" }], coverage: 3, total: 6 }];
  assert.equal(gaps(rows).length, 0);
});

test("already-having a capability is never a gap", () => {
  const rows = [{ id: "y", name: "Y", status: "have", policy: "in-scope", coveredBy: [{ repo: "a" }, { repo: "b" }, { repo: "c" }], coverage: 3, total: 6 }];
  assert.equal(gaps(rows).length, 0);
});

test("partial capability outranks missing one at equal coverage", () => {
  // Closing a shadow of an existing feature is cheaper than building a new one.
  const rows = [
    { id: "missing-one", name: "M", status: "missing", policy: "in-scope", coveredBy: [{ repo: "a" }, { repo: "b" }, { repo: "c" }], coverage: 3, total: 6 },
    { id: "partial-one", name: "P", status: "partial", policy: "in-scope", coveredBy: [{ repo: "a" }, { repo: "b" }, { repo: "c" }], coverage: 3, total: 6 },
  ];
  assert.deepEqual(gaps(rows).map((g) => g.id), ["partial-one", "missing-one"]);
});

/* ─────────────────── the real inventory has to stay honest ──────────────── */

test("every capability in the inventory has a policy", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "docs", "CAPABILITIES.json"), "utf8"));
  const allowed = new Set(["in-scope", "settled", "out-of-scope"]);
  for (const c of data.capabilities) {
    assert.ok(allowed.has(c.policy), `${c.id} has policy "${c.policy}"`);
  }
});

test("nothing claims to be present without evidence", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "docs", "CAPABILITIES.json"), "utf8"));
  for (const c of data.capabilities) {
    if (c.status !== "have") continue;
    assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0, `${c.id} claims 'have' with no evidence`);
  }
});

test("the evidence a 'have' claim cites actually exists on disk", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "docs", "CAPABILITIES.json"), "utf8"));
  for (const c of data.capabilities) {
    if (c.status !== "have") continue;
    for (const ev of c.evidence) {
      // Evidence strings look like "src/brain.js: something" — take the path.
      const path = ev.split(":")[0].trim();
      if (!path.includes("/")) continue; // "README.md: …" has no slash; skip prose
      const exists = (() => {
        try {
          readFileSync(join(ROOT, path));
          return true;
        } catch {
          return false;
        }
      })();
      assert.ok(exists, `${c.id} cites ${path}, which is not in the tree`);
    }
  }
});

test("the product boundary is recorded, not quietly dropped", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "docs", "CAPABILITIES.json"), "utf8"));
  const multi = data.capabilities.find((c) => c.id === "multi-user");
  assert.ok(multi, "multi-user must stay in the inventory so the decision is visible");
  assert.equal(multi.policy, "out-of-scope");
});
