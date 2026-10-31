/**
 * docs.test.js — the documentation is a claim, and claims get tested.
 *
 * Written after writing a paragraph that said the read-only allowlist held
 * "eight programs" when it held fifteen. Nothing caught it: prose has no
 * compiler. So the examples in the tier table are now *read out of* docs/GUIDE.md
 * and fed to the classifier. If a future change to src/risk.js moves `git log`
 * from read to act, this test fails on the documentation rather than quietly
 * letting the guide describe a product that no longer exists.
 *
 * Same idea for the two commands added to the CLI table: a documented command
 * that does not exist is worse than an undocumented one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { classifyCommand, READ, ACT, BLOCKED } from "../src/risk.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guide = readFileSync(resolve(root, "docs/GUIDE.md"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

/** Pull the table rows out of the "Commands it runs without asking" section. */
function tierRows() {
  const start = guide.indexOf("## Commands it runs without asking");
  assert.notEqual(start, -1, "the tier section is gone — update or delete these tests");
  const end = guide.indexOf("\n## ", start + 10);
  const section = guide.slice(start, end === -1 ? undefined : end);

  const rows = [];
  for (const line of section.split("\n")) {
    // | **read** | runs, and the panel shows it as a ⚡ line | `ls`, `cat README.md`, ... |
    const m = line.match(/^\|\s*\*\*(read|act|blocked)\*\*\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const tier = m[1];
    const examples = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1].replace(/\\\|/g, "|"));
    for (const e of examples) rows.push({ tier, example: e });
  }
  return rows;
}

test("every command example in the tier table classifies as the table says", () => {
  const rows = tierRows();
  assert.ok(rows.length >= 6, `expected the table to carry examples, found ${rows.length}`);

  const workspace = [root];
  const wrong = [];
  for (const { tier, example } of rows) {
    // The doc writes alternates with a pipe ("node|npm|python3 --version"), and
    // writes one example with an ellipsis. Both are prose, not commands.
    if (example.includes("|") || example.includes("…")) continue;
    const got = classifyCommand(example, { workspaceRoots: workspace }).tier;
    const want = tier === "read" ? READ : tier === "act" ? ACT : BLOCKED;
    if (got !== want) wrong.push(`${example} documented ${tier}, actually ${got}`);
  }
  assert.deepEqual(wrong, [], "the guide and src/risk.js disagree");
});

test("the metacharacter list in the guide is the one the code rejects", () => {
  const src = readFileSync(resolve(root, "src/risk.js"), "utf8");
  const literal = src.match(/const SHELL_METACHAR = \/\[(.+?)\]\//s);
  assert.ok(literal, "SHELL_METACHAR is missing or renamed");

  // Two independent sets: what the code rejects, and what the guide promises.
  const inCode = new Set(literal[1].replace(/\\n/g, "\n").replace(/\\r/g, "\r").split(""));
  const span = guide.slice(guide.indexOf("It contains none of"), guide.indexOf("or a newline", guide.indexOf("It contains none of")));
  const documented = new Set(
    span
      .replace(/``/g, "")
      .split("")
      .filter((c) => /[^\w\s]/.test(c)) // punctuation only
  );

  for (const ch of documented) {
    assert.ok(inCode.has(ch), `the guide says ${JSON.stringify(ch)} forces a prompt; SHELL_METACHAR omits it`);
    // And behaviourally: a chained command using it must never be read-tier.
    const tier = classifyCommand(`ls ${ch} rm -rf build`, { workspaceRoots: [root] }).tier;
    assert.notEqual(tier, READ, `${JSON.stringify(ch)} was treated as read-only`);
  }
  for (const ch of inCode) {
    if (ch === "\n" || ch === "\r") continue;
    assert.ok(documented.has(ch), `SHELL_METACHAR rejects ${JSON.stringify(ch)} but the guide never says so`);
  }
});

test("commands named as deliberately excluded really are excluded", () => {
  // The guide promises these ask, because textconv can run a repository's code.
  for (const cmd of ["git diff", "git show HEAD", "git log -p"]) {
    assert.equal(
      classifyCommand(cmd, { workspaceRoots: [root] }).tier,
      ACT,
      `${cmd} is documented as needing approval but ran unattended`
    );
  }
});

test("the allowlist size the guide claims is the size it is", () => {
  const src = readFileSync(resolve(root, "src/risk.js"), "utf8");
  const entries = [...src.matchAll(/^ {2}\["(\w+)", \{/gm)].map((m) => m[1]);
  const claimed = guide.match(/fifteen entries in all: eleven plain readers/);
  assert.ok(claimed, "the guide no longer states a count — restore it or drop this test");
  assert.equal(entries.length, 15, `allowlist has ${entries.length} entries: ${entries.join(" ")}`);
  const readers = entries.filter((n) => !["node", "npm", "python3", "git"].includes(n));
  assert.equal(readers.length, 11, `plain readers: ${readers.join(" ")}`);
});

test("every command in the CLI table exists in bin/pinch.js", () => {
  const cli = readFileSync(resolve(root, "bin/pinch.js"), "utf8");
  const start = guide.indexOf("## Command line");
  const end = guide.indexOf("\n## ", start + 10);
  const section = guide.slice(start, end);

  const documented = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (!m) continue;
    const cmd = m[1].trim().split(/\s+/);
    if (cmd[0] !== "pinch") continue;
    if (cmd[1]) documented.push(cmd[1].replace(/[^a-z-]/g, ""));
  }
  assert.ok(documented.includes("export") && documented.includes("cost"), "export/cost left the table");

  // `pinch x` is dispatched by string literal in a switch (or by an if chain).
  const missing = documented.filter((c) => !new RegExp(`["'\`]${c}["'\`]`).test(cli));
  assert.deepEqual(missing, [], `documented but not implemented: ${missing.join(", ")}`);
});

test("the README's claim about the gate matches the classifier's behaviour", () => {
  // The corrected claim: read-only commands run through, anything that can
  // change state asks. If someone flips the default back, this catches it.
  assert.match(readme, /`ls`, `cat`, `grep`, `git status` and friends\s*\n?\s*run straight through/);
  for (const cmd of ["ls", "cat README.md", "grep -rn TODO src", "git status"]) {
    assert.equal(classifyCommand(cmd, { workspaceRoots: [root] }).tier, READ);
  }
  assert.equal(classifyCommand("echo hi", { workspaceRoots: [root] }).tier, ACT);
});

test("the documented export and cost commands run", () => {
  const data = execFileSync(process.execPath, ["-e", `
    const { mkdtempSync } = require("node:fs");
    process.stdout.write(mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "pinch-doc-")));
  `]).toString();
  const env = { ...process.env, PINCH_DATA: data, LLM_PROVIDER: "mock", PINCH_KEY: "" };

  const help = execFileSync(process.execPath, [resolve(root, "bin/pinch.js"), "help"], { env }).toString();
  assert.match(help, /pinch export/, "the help text does not mention the documented export command");
  assert.match(help, /pinch cost/, "the help text does not mention the documented cost command");

  const cost = execFileSync(process.execPath, [resolve(root, "bin/pinch.js"), "cost", "7"], { env }).toString();
  assert.match(cost, /No turns recorded/, "cost on an empty store should say so, not invent numbers");
});
