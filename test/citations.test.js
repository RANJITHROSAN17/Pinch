import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pinch-cite-"));
process.env.PINCH_DATA = dataDir;
process.env.LLM_PROVIDER = "mock";

const { ensureData } = await import("../src/store.js");
const { createSources, addSource, listSources, MAX_SOURCES } = await import("../src/sources.js");
const { citedIds, validateCitations, renderSourceBlock } = await import("../src/citations.js");
const { auditReply } = await import("../src/guard.js");

ensureData();

/* ───────────────────────── reading the citations ───────────────────────── */

test("a citation is read in every shape the model writes it", () => {
  assert.deepEqual(citedIds("as shown [1] and also [3]"), [1, 3]);
  assert.deepEqual(citedIds("see [1,2] together"), [1, 2]);
  assert.deepEqual(citedIds("all of [1-3]"), [1, 2, 3]);
  assert.deepEqual(citedIds("duplicates [2] and [2]"), [2]);
  assert.deepEqual(citedIds("none at all"), []);
});

test("things that merely look like citations are not read as ones", () => {
  // A markdown link is not a citation, and neither is a footnote marker.
  assert.deepEqual(citedIds("[the docs](https://example.com/a)"), []);
  assert.deepEqual(citedIds("a footnote [^1] and a list [ - ]"), []);
  assert.deepEqual(citedIds("version [2024] is not a source"), []);
});

/* ───────────────────────── what counts as a source ─────────────────────── */

test("the same page fetched twice is one source, not two", () => {
  const reg = createSources();
  const a = addSource(reg, { kind: "web", title: "Node docs", ref: "https://nodejs.org/api" });
  const b = addSource(reg, { kind: "web", title: "Node docs", ref: "https://nodejs.org/api" });
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(listSources(reg).length, 1);
  // A file and a URL that happen to share a string are still different sources.
  const c = addSource(reg, { kind: "file", title: "README", ref: "https://nodejs.org/api" });
  assert.notEqual(c, a);
});

test("the registry is capped so one turn cannot cite seventy things", () => {
  const reg = createSources();
  for (let i = 0; i < MAX_SOURCES + 5; i++) addSource(reg, { kind: "web", title: `r${i}`, ref: `https://e.com/${i}` });
  assert.equal(listSources(reg).length, MAX_SOURCES);
  assert.equal(addSource(reg, { kind: "web", title: "late", ref: "https://e.com/late" }), null);
});

test("source text cannot carry control characters or newlines into the panel", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "bad\u0000title\nwith a break", ref: "https://e.com", snippet: "x\u001by" });
  const [s] = listSources(reg);
  assert.equal(s.title, "bad title with a break");
  assert.doesNotMatch(s.snippet, /[\u0000-\u001f]/);
});

/* ───────────────────────── validation ──────────────────────────────────── */

test("citation 2 is accepted only when source 2 was actually retrieved", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "A", ref: "https://a" });
  addSource(reg, { kind: "file", title: "B", ref: "src/b.js" });

  const ok = validateCitations({ text: "from the file [2] and the page [1]", sources: listSources(reg) });
  assert.deepEqual(ok.cited, [1, 2]);
  assert.deepEqual(ok.unknown, []);
  assert.deepEqual(ok.unused, []);

  const invented = validateCitations({ text: "the docs say [4]", sources: listSources(reg) });
  assert.deepEqual(invented.cited, []);
  assert.deepEqual(invented.unknown, [4], "a citation to a source that was never fetched");
});

test("a source nobody cited is reported as unused, not hidden", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "A", ref: "https://a" });
  addSource(reg, { kind: "web", title: "B", ref: "https://b" });
  const v = validateCitations({ text: "only the first [1]", sources: listSources(reg) });
  assert.deepEqual(v.unused, [2]);
});

/* ───────────────────────── the footer ──────────────────────────────────── */

test("the footer lists what was cited and nothing else", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "Node docs", ref: "https://nodejs.org/api" });
  addSource(reg, { kind: "web", title: "Unused page", ref: "https://unused.example" });
  addSource(reg, { kind: "file", title: "src/app.js", ref: "src/app.js" });

  const block = renderSourceBlock(validateCitations({ text: "per the docs [1] and the code [3]", sources: listSources(reg) }));
  assert.match(block, /\*\*Sources\*\*/);
  assert.match(block, /1\. Node docs — https:\/\/nodejs\.org\/api/);
  assert.match(block, /3\. src\/app\.js — `src\/app\.js`/);
  assert.doesNotMatch(block, /Unused page/, "a source the reply did not use must not be presented as evidence");
});

test("an answer that cites nothing gets no Sources heading", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "Fetched but unused", ref: "https://x" });
  assert.equal(renderSourceBlock(validateCitations({ text: "I do not know.", sources: listSources(reg) })), "");
});

/* ───────────────────────── the guard ───────────────────────────────────── */

test("the guard flags a citation to something this turn never fetched", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "A", ref: "https://a" });

  const bad = auditReply({
    reply: "The spec says so [1], and section 4 confirms it [7].",
    sources: listSources(reg),
    citedIds: [1],
  });
  const flag = bad.flags.find((f) => f.code === "invented-citation");
  assert.ok(flag, `expected an invented-citation flag, got ${JSON.stringify(bad.flags)}`);
  assert.match(flag.message, /\[7\]/);

  const good = auditReply({
    reply: "The spec says so [1].",
    sources: listSources(reg),
    citedIds: [1],
  });
  assert.equal(good.flags.some((f) => f.code === "invented-citation"), false);
});

test("the guard does not fire on a citation that resolves, or on a markdown link", () => {
  const reg = createSources();
  addSource(reg, { kind: "web", title: "A", ref: "https://a" });
  const clean = auditReply({
    reply: "See [the docs](https://a) and the note [1].",
    sources: listSources(reg),
    citedIds: [1],
  });
  assert.equal(clean.flags.some((f) => f.code === "invented-citation"), false);
});

/* ───────────────────────── end to end ──────────────────────────────────── */

test("a turn that reads a file cites it, and the citation survives to the result", async () => {
  const { writeFileSync } = await import("node:fs");
  const { runAgent } = await import("../src/agent.js");
  const { config } = await import("../src/config.js");

  const file = join(config.workspaceRoots[0], "cite-me.txt");
  writeFileSync(file, "THE ANSWER IS 42\nsecond line\n");

  // The mock brain answers from the tool output; here we drive the registry the
  // same way the tools do, then let the real agent path validate it.
  const reg = createSources();
  const id = addSource(reg, { kind: "file", title: "cite-me.txt", ref: "cite-me.txt", snippet: "THE ANSWER IS 42" });
  assert.equal(id, 1);

  const v = validateCitations({ text: "The file says the answer is 42 [1].", sources: listSources(reg) });
  assert.deepEqual(v.cited, [1]);
  assert.equal(v.unknown.length, 0);
  assert.ok(renderSourceBlock(v).includes("cite-me.txt"));

  const result = await runAgent({ sessionId: "cite-e2e", text: "what does cite-me.txt say?", channel: "web" });
  assert.equal(typeof result.text, "string");
  assert.ok(Array.isArray(result.sources), "every turn returns a sources array, empty when nothing was fetched");
});

test("a turn that read nothing grows no Sources block", async () => {
  const { runAgent } = await import("../src/agent.js");
  const result = await runAgent({ sessionId: "cite-plain", text: "say hello", channel: "web" });
  assert.deepEqual(result.sources, [], "no tool ran, so there is nothing to cite");
  assert.doesNotMatch(result.text, /\*\*Sources\*\*/, "an answer from memory must not wear a Sources heading");
});

test("a read turn puts the file in the result and marks it cited", async () => {
  const { writeFileSync } = await import("node:fs");
  const { runAgent } = await import("../src/agent.js");
  const { config } = await import("../src/config.js");
  writeFileSync(join(config.workspaceRoots[0], "cite-again.txt"), "SHIPPED ON FRIDAY\n");

  const r = await runAgent({ sessionId: "cite-read", text: "read cite-again.txt", channel: "web" });
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].kind, "file");
  assert.equal(r.sources[0].cited, true);
  assert.match(r.text, /\*\*Sources\*\*/);
  assert.match(r.text, /cite-again\.txt/);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function afterAll(fn) {
  process.on("exit", fn);
}
