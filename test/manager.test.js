/**
 * test/manager.test.js — the manager edits files unattended, which makes the
 * fence around it the most important code in this repository after the guard
 * rails themselves. These tests are mostly about what it refuses to do.
 *
 * The one behaviour that must never regress: `src/` is not editable. Not by a
 * fixer, not by a fingerprint, not by an issue body that asks nicely. If a
 * future change makes any of these tests fail, the loop must stop being
 * automatic before it starts being convenient.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { planFor, isAllowed, ALLOWED, extractFingerprint } from "../scripts/manager.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function issue(body, over = {}) {
  return { number: 1, state: "open", title: "growth: something", labels: [{ name: "growth" }], body, createdAt: "2026-10-30T00:00:00Z", ...over };
}

/* ─────────────────────────────── the fence ─────────────────────────────── */

test("src/ is not editable, by any path", () => {
  for (const p of [
    "src/guard.js",
    "src/tools.js",
    "src/server.js",
    "src/store.js",
    "src/channels/telegram.js",
    "scripts/audit.js",
    ".github/workflows/growth.yml",
    "package.json",
    "bin/pinch.js", // help text is fixed by hand, not by the manager
  ]) {
    assert.equal(isAllowed(p), false, `${p} must be outside the fence`);
  }
});

test("documentation is editable", () => {
  for (const p of [".env.example", "docs/GUIDE.md", "README.md", "CONTRIBUTING.md"]) {
    assert.equal(isAllowed(p), true, `${p} should be inside the fence`);
  }
});

test("every allow rule is anchored, so a traversal cannot sneak past it", () => {
  for (const re of ALLOWED) {
    assert.match(re.source, /^\^/, `${re} must be anchored at the start`);
    assert.match(re.source, /\$$/, `${re} must be anchored at the end`);
  }
  assert.equal(isAllowed("docs/../src/guard.js"), false);
  assert.equal(isAllowed("../outside.md"), false);
});

/* ───────────────────────────── matching ────────────────────────────────── */

test("a fingerprinted issue is ours; one without a fingerprint is not", () => {
  assert.equal(extractFingerprint("hello\n<!-- growth:fingerprint:docs:broken-link:a:b -->"), "docs:broken-link:a:b");
  assert.equal(extractFingerprint("a normal bug report"), null);
  const r = planFor(issue("no marker here"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not ours to fix/);
});

test("an unfixable category is refused with a reason, not attempted", () => {
  const r = planFor(issue("<!-- growth:fingerprint:tests:src-brain-js -->"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /needs a person/);
});

test("a demand annotation is not a fix and is left alone", () => {
  const r = planFor(issue("<!-- growth:spec:#42 -->", { labels: [] }));
  assert.equal(r.ok, false);
});

/* ──────────────────────────── the config fixer ─────────────────────────── */

test("the config fixer documents a real variable without inventing a default", () => {
  const r = planFor(issue("<!-- growth:fingerprint:config:undocumented:pinch-data -->"));
  assert.equal(r.ok, true);
  assert.equal(r.fixer, "config-docs");
  const edit = r.edits[0];
  assert.equal(edit.path, ".env.example");
  assert.match(edit.append, /PINCH_DATA=/);
  // The default must come from the source that defines it, and this one is
  // join(ROOT, "data") — a naive [^,]+ regex reports "(none)" here, which is
  // how the first version of this fixer lied.
  assert.match(r.detail, /\.\/data/);
});

test("an unknown variable gets an honest block, not a copy of the data-dir text", () => {
  const r = planFor(issue("<!-- growth:fingerprint:config:undocumented:pinch_imaginary -->"));
  assert.equal(r.ok, true);
  assert.match(r.edits[0].append, /PINCH_IMAGINARY=/);
  assert.doesNotMatch(r.edits[0].append, /Where data lives/);
});

/* ───────────────────────────── the link fixer ──────────────────────────── */

test("a broken link to a file that exists elsewhere is retargeted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinch-link-"));
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "start\nsee [the guide](doc/GUIDE.md) for more\n");
    writeFileSync(join(dir, "docs", "GUIDE.md"), "# guide\n");
    const body = [
      "<!-- growth:fingerprint:docs:broken-link:readme-md:doc-guide-md -->",
      "`README.md` line 2 points at `doc/GUIDE.md`, which does not exist in the repository.",
    ].join("\n");
    const r = planFor(issue(body), dir);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.fixer, "link-repair");
    assert.equal(r.edits[0].path, "README.md");
    assert.equal(r.edits[0].find, "doc/GUIDE.md");
    assert.equal(r.edits[0].replace, "docs/GUIDE.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a link with no plausible target is demoted rather than pointed at a guess", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinch-link-"));
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "see [gone](docs/gone.md)\n");
    const body = [
      "<!-- growth:fingerprint:docs:broken-link:readme-md:docs-gone-md -->",
      "`README.md` line 1 points at `docs/gone.md`, which does not exist in the repository.",
    ].join("\n");
    const r = planFor(issue(body), dir);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.edits[0].replace, "]");
    assert.match(r.detail, /no plausible replacement/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a link the file does not actually contain is refused, not force-edited", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinch-link-"));
  try {
    writeFileSync(join(dir, "README.md"), "unrelated text\n");
    writeFileSync(join(dir, "docs"), "not a directory");
    const body = [
      "<!-- growth:fingerprint:docs:broken-link:readme-md:docs-no-such-link-md -->",
      "`README.md` line 9 points at `docs/no-such-link.md`, which does not exist in the repository.",
    ].join("\n");
    const r = planFor(issue(body), dir);
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────────────────── the program as a program ────────────────────── */

test("a dry run writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinch-mgr-"));
  try {
    const file = join(dir, "issues.json");
    writeFileSync(file, JSON.stringify([issue("<!-- growth:fingerprint:config:undocumented:pinch-data -->")]));
    const before = readFileSync(join(ROOT, ".env.example"), "utf8");
    execFileSync(process.execPath, ["scripts/manager.js", "--issues", file, "--json"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    assert.equal(readFileSync(join(ROOT, ".env.example"), "utf8"), before, "--json without --apply must not touch the tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only issues labelled growth are considered", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinch-mgr-"));
  try {
    const file = join(dir, "issues.json");
    writeFileSync(
      file,
      JSON.stringify([
        issue("<!-- growth:fingerprint:config:undocumented:pinch-data -->", { number: 1, labels: [{ name: "bug" }] }),
        issue("<!-- growth:fingerprint:config:undocumented:pinch-data -->", { number: 2, labels: [{ name: "growth" }] }),
      ]),
    );
    const out = execFileSync(process.execPath, ["scripts/manager.js", "--issues", file, "--json"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    const report = JSON.parse(out);
    assert.equal(report.reports.length, 1);
    assert.equal(report.reports[0].issue, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing issues file is a usage error, not a crash", () => {
  let code = 0;
  try {
    execFileSync(process.execPath, ["scripts/manager.js"], { cwd: ROOT, encoding: "utf8", stdio: "pipe", timeout: 60_000 });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 2);
});

test("every fixer names a file inside the fence", () => {
  // A structural guard: even a future fixer that misbehaves cannot reach src/,
  // because planFor refuses any edit the fence does not cover.
  const cases = [
    "<!-- growth:fingerprint:config:undocumented:pinch-data -->",
    "<!-- growth:fingerprint:docs:broken-link:readme-md:missing-md -->\n`README.md` line 2 points at `docs/missing.md`, which does not exist in the repository.",
  ];
  for (const body of cases) {
    const plan = planFor(issue(body));
    if (!plan.ok) continue;
    for (const edit of plan.edits) assert.equal(isAllowed(edit.path), true, `${edit.path} from ${plan.fixer}`);
  }
});
