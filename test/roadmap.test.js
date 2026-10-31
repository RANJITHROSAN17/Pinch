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
