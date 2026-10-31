import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The contributor queue bot's whole safety argument is "a human reviews roadmap.json in a PR".
 * That only holds if a half-specified entry fails here, in CI, instead of becoming an issue a
 * newcomer cannot start. These tests pin the four guards that matter.
 */

const SCRIPT = resolve("scripts/validate-roadmap.js");
const MANIFEST = resolve(".github/roadmap.json");

const item = (over = {}) => ({
  id: "x-1",
  title: "t",
  status: "ready",
  difficulty: "easy",
  labels: ["good first issue"],
  files: ["README.md"],
  verify: "node --test",
  body: "## Context\nc\n## Acceptance criteria\n- [ ] a\n## How to verify\n```bash\nnode --test\n```\n## Time estimate\n~1h",
  ...over,
});

function run(manifestPath) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, manifestPath], { encoding: "utf8" });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function fixture(doc) {
  const dir = mkdtempSync(join(tmpdir(), "roadmap-"));
  const path = join(dir, "roadmap.json");
  writeFileSync(path, JSON.stringify(doc));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the committed manifest is valid", () => {
  const { code, out } = run(MANIFEST);
  assert.equal(code, 0, out);
  assert.match(out, /OK/);
});

test("a filing candidate with no acceptance criteria is refused", () => {
  const { path, cleanup } = fixture({
    meta: { open_easy_cap: 3 },
    items: [item({ body: "## Context\nonly context" })],
  });
  try {
    const { code, out } = run(path);
    assert.equal(code, 1);
    assert.match(out, /acceptance criteria/i);
  } finally {
    cleanup();
  }
});

test("a filing candidate with no verification command is refused", () => {
  const { path, cleanup } = fixture({
    meta: { open_easy_cap: 3 },
    items: [item({ verify: undefined })],
  });
  try {
    const { code, out } = run(path);
    assert.equal(code, 1);
    assert.match(out, /verify/i);
  } finally {
    cleanup();
  }
});

test("more than the easy cap is refused, so the queue cannot become a graveyard", () => {
  const items = Array.from({ length: 4 }, (_, i) => item({ id: `e-${i}` }));
  const { path, cleanup } = fixture({ meta: { open_easy_cap: 3 }, items });
  try {
    const { code, out } = run(path);
    assert.equal(code, 1);
    assert.match(out, /cap 3/);
  } finally {
    cleanup();
  }
});

test("backlog entries are exempt from the completeness gate", () => {
  const { path, cleanup } = fixture({
    meta: { open_easy_cap: 3 },
    items: [item({ status: "backlog", body: "rough idea", files: undefined, verify: undefined })],
  });
  try {
    const { code, out } = run(path);
    assert.equal(code, 0, out);
  } finally {
    cleanup();
  }
});

/**
 * Rule 4 of docs/contributing-queue.md: the bot may close only issues it created, and the
 * closing comment must name a release. `PINCH_RELEASE` was set nowhere — no workflow, no
 * .env.example, no script — so the comment always read "Shipped in the next release", a name
 * no reader can open. These two tests pin the repair: a release comes from the reviewed
 * manifest, and when it is missing the bot refuses instead of inventing one.
 */

const WORKFLOW = resolve(".github/workflows/contributor-queue.yml");

test("the closing comment reads its release from the manifest, never from an unset env var", async () => {
  const { readFileSync } = await import("node:fs");
  const yml = readFileSync(WORKFLOW, "utf8");

  // Comments may name the old variable - that history is worth keeping. Executable lines may not.
  const code = yml.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /PINCH_RELEASE/, "PINCH_RELEASE is set nowhere; reading it is how the release name became fiction");
  assert.doesNotMatch(code, /the next release/, "the fabricated fallback name is back");
  assert.match(code, /jq -r '\.meta\.latest_release \/\/ empty' \.github\/roadmap\.json/);
});

test("an unset latest_release makes the bot refuse to close, not guess", async () => {
  const { readFileSync } = await import("node:fs");
  const yml = readFileSync(WORKFLOW, "utf8");

  // The guard must sit between the author check and the close, and must skip this issue only.
  const authorCheck = yml.indexOf("refusing to close #$NUM (author:");
  const guard = yml.indexOf('if [ -z "$RELEASE" ]');
  const comment = yml.indexOf('gh issue comment "$NUM"');
  assert.ok(authorCheck > 0 && guard > authorCheck && comment > guard, "the release guard must run after the author check and before the comment");
  assert.match(yml.slice(guard, comment), /::warning::not closing #\$NUM/);
  assert.match(yml.slice(guard, comment), /\bcontinue\b/, "without continue the loop closes an unnamed release anyway");
});

test("the committed manifest declares latest_release, so the field cannot go missing", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(readFileSync(MANIFEST, "utf8"));
  assert.ok("latest_release" in doc.meta, "meta.latest_release must exist, empty until a release is cut");
});
