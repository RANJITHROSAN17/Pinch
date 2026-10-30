#!/usr/bin/env node
/**
 * scripts/manager.js — the part of the loop that actually fixes things.
 *
 * This is the answer to "why does the bot only file issues?" — it no longer
 * does, for the narrow set of problems where the fix is mechanical and the
 * blast radius is a markdown file. It is deliberately not a general-purpose
 * code-writing agent, and the reason is not caution for its own sake:
 *
 *   Pinch runs shell commands on someone's laptop. A subtle change to
 *   screenCommand() or resolveInWorkspace() does not produce a broken button,
 *   it produces a machine that can be wiped by a prompt injection. For that
 *   code, "the tests passed" is not the same claim as "a human read it".
 *
 * So the manager works inside a fence that is enforced here, in code, not in a
 * prompt that a future edit could talk its way around:
 *
 *   1. PATHS. Only files on ALLOWED below can be touched. src/ is not on the
 *      list — not "should not", cannot. There is no flag that widens this.
 *   2. FIXERS. A file is only edited by a named fixer that matches the issue's
 *      fingerprint. If nothing matches, the manager says so and moves on; it
 *      never improvises.
 *   3. THE SUITE. Edits are applied, `node --test` and `node scripts/audit.js`
 *      run, and a red build means the tree is restored byte for byte. The fix
 *      is dropped, not debugged unattended.
 *   4. ONE AT A TIME. One issue per run, and the workflow refuses to start if
 *      another bot PR is already open. A human merges; branch protection makes
 *      that a fact rather than a courtesy.
 *
 * Usage:
 *   node scripts/manager.js --issues /tmp/issues.json          # dry run
 *   node scripts/manager.js --issues /tmp/issues.json --apply   # edit the tree
 *   node scripts/manager.js --issues /tmp/issues.json --json
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const flag = (n) => args.has(n);
const opt = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/**
 * The fence. A path is editable if it matches one of these, and every fixer
 * below must additionally declare which of them it writes.
 *
 * `bin/pinch.js` is here for one reason: its usage() block is a help string.
 * The fixer that touches it edits inside that template literal only, and a test
 * asserts the switch itself is untouched.
 */
const ALLOWED = [/^\.env\.example$/, /^docs\/[^/]+\.md$/, /^README\.md$/, /^CONTRIBUTING\.md$/];

function isAllowed(relPath) {
  return ALLOWED.some((re) => re.test(relPath));
}

/* ─────────────────────────────── fixers ────────────────────────────────── */

/**
 * Each fixer: `match(fingerprint) -> params | null` and `plan(params) -> edits`.
 * An edit is { path, find?, after?, append? } — either a string replacement or
 * an append. Nothing here runs a shell.
 */

/**
 * config:undocumented:NAME — a variable the product reads and no document
 * mentions. The fix is to document it, using the default found in the source so
 * the comment is true rather than aspirational.
 */
const undocumentedConfig = {
  id: "config-docs",
  match: (fingerprint) => (fingerprint.startsWith("config:undocumented:") ? fingerprint.replace("config:undocumented:", "") : null),
  plan(name) {
    const envName = name.toUpperCase().replace(/-/g, "_");
    const fallback = defaultForEnv(envName);
    const readsIn = filesReading(envName);

    // A hand-written description only where the meaning is actually known. For
    // anything else the honest block points at the line that defines it rather
    // than inventing a sentence about what it does.
    const known = {
      PINCH_DATA: [
        "Where data lives",
        [
          "Pinch keeps sessions, memory and reminders under this directory.",
          "Point it at a synced or removable volume to carry your assistant",
          "between machines.",
        ],
      ],
    }[envName];

    const body = known
      ? known[1]
      : [
          `Read by ${readsIn.join(", ") || "the source"}.`,
          fallback.value ? `Default: ${fallback.value}.` : `No default — see ${fallback.source}.`,
          "Leave it blank to accept the default.",
        ];

    const section = [
      "",
      `# ── ${known ? known[0] : envName} ${"─".repeat(Math.max(4, 46 - envName.length))}`,
      ...body.map((l) => `# ${l}`),
      `${envName}=${fallback.value === "" ? "" : ""}`,
    ].join("\n");

    return {
      summary: `document ${envName} in .env.example`,
      edits: [{ path: ".env.example", append: section }],
      detail: `read by ${readsIn.join(", ") || "the source"}; default ${fallback.value || "(none stated)"} — ${fallback.source}`,
    };
  },
};

/**
 * docs:broken-link:FILE:TARGET — a relative link that does not resolve. The fix
 * is to retarget it at the file that clearly moved, or, if nothing plausible
 * exists, to demote the link to plain text so a reader is not sent to a 404.
 */
const brokenLink = {
  id: "link-repair",
  // Fingerprints slug the path, so the plan step searches rather than trusting
  // a reversed slug to reconstruct what was written.
  match: (fingerprint) => (fingerprint.startsWith("docs:broken-link:") ? fingerprint : null),
  plan(fingerprint, context = {}, root = ROOT) {
    const file = context.file;
    const target = context.target;
    if (!file || !target) return null;
    const replacement = bestMatch(target, root);
    const abs = join(root, file);
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, "utf8");
    if (!text.includes(target)) return null;
    if (replacement) {
      return {
        summary: `retarget ${target} → ${replacement}`,
        edits: [{ path: file, find: target, replace: replacement }],
        detail: `both resolve to ${basename(replacement)}`,
      };
    }
    return {
      summary: `demote the dead link to plain text`,
      edits: [{ path: file, find: `](${target})`, replace: `]` }],
      detail: "no plausible replacement exists, so the sentence stays and the 404 goes",
    };
  },
};

function fixers() {
  return [undocumentedConfig, brokenLink];
}

/* ────────────────────────────── planning ───────────────────────────────── */

/** The default a config key actually has, read from the source that defines it. */
function defaultForEnv(name) {
  const file = join(ROOT, "src", "config.js");
  if (!existsSync(file)) return { value: "", source: "unknown" };
  const src = readFileSync(file, "utf8");
  const line = new RegExp(`env\\.${name}\\s*\\|\\|\\s*([^\\n]+)`).exec(src);
  if (!line) return { value: "", source: `no default in src/config.js` };
  const expr = line[1].trim().replace(/,$/, "");

  // join(ROOT, "data") — the common case. Matched explicitly, because a naive
  // `[^,]+` stops at the comma inside the call and reports no default at all.
  const joined = /^join\(\s*[^,]+,\s*"([^"]+)"\s*\)$/.exec(expr);
  if (joined) return { value: `./${joined[1]}`, source: "src/config.js" };

  const literal = /^"([^"]*)"$/.exec(expr);
  if (literal) return { value: literal[1], source: "src/config.js" };

  // Anything else — an expression, a function call, a ternary — is reported as
  // written rather than guessed at. A wrong default in a config file is a bug
  // report waiting to happen.
  return { value: "", source: `src/config.js: ${expr.slice(0, 40)}` };
}

function filesReading(name) {
  const out = [];
  for (const dir of ["src", "src/channels"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".js")) continue;
      try {
        // Reads only — an assignment is not configuration.
        const text = readFileSync(join(abs, f), "utf8");
        if (new RegExp(`env\\.${name}(?!\\s*=(?!=))`).test(text)) out.push(`${dir}/${f}`);
      } catch {
        /* unreadable is not the same as absent, but it cannot be cited either */
      }
    }
  }
  return out;
}

/** The one existing file a broken target most likely meant. Exact basename
 *  match wins; otherwise nothing, because a wrong target is worse than none. */
function bestMatch(target, root = ROOT) {
  const want = basename(target).toLowerCase();
  const candidates = [];
  for (const dir of ["", "docs"]) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    // existsSync is not "is a directory": if something replaced docs/ with a
    // file, readdirSync throws ENOTDIR and takes the whole run down with it.
    // A missing candidate list is a fine outcome; a crash is not.
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) if (f.endsWith(".md")) candidates.push(dir ? `${dir}/${f}` : f);
  }
  const exact = candidates.find((c) => basename(c).toLowerCase() === want);
  return exact || null;
}

/**
 * Turn an issue into a patch, or explain why it cannot become one. The
 * explanation is the deliverable for everything outside the fence, and it is
 * printed rather than swallowed.
 */
export function planFor(issue, root = ROOT) {
  const body = String(issue.body || "");
  const fingerprint = extractFingerprint(body);
  if (!fingerprint) {
    return { ok: false, reason: "no growth fingerprint in the issue body — not ours to fix" };
  }

  for (const fixer of fixers()) {
    const params = fixer.match(fingerprint);
    if (params == null) continue;
    const context = fingerprint.startsWith("docs:broken-link:") ? fingerprintContext(body) : {};
    const planned = fixer.plan(params, context, root);
    if (!planned) return { ok: false, reason: `${fixer.id}: could not work out a safe edit for ${fingerprint}` };

    const illegal = planned.edits.filter((e) => !isAllowed(e.path));
    if (illegal.length > 0) {
      return { ok: false, reason: `${fixer.id} wanted to edit ${illegal.map((e) => e.path).join(", ")}, which is outside the fence` };
    }
    return { ok: true, fixer: fixer.id, fingerprint, ...planned };
  }
  return { ok: false, reason: `no mechanical fixer matches ${fingerprint} — this one needs a person` };
}

function extractFingerprint(body) {
  const m = /growth:fingerprint:([^\s>]+)/.exec(body);
  return m ? m[1] : null;
}

/** The proposal body names the file and the dead target in its "What" section;
 *  read them back out instead of re-deriving from a slugged fingerprint. */
function fingerprintContext(body) {
  const m = /`([\w./-]+\.md)` line \d+ points at `([^`]+)`/.exec(body);
  return m ? { file: m[1], target: m[2] } : {};
}

/* ────────────────────────────── applying ───────────────────────────────── */

/** Everything the manager is allowed to change, with its original bytes, so a
 *  red build can be undone exactly rather than approximately. */
function snapshot(paths) {
  const saved = new Map();
  for (const p of paths) {
    const abs = join(ROOT, p);
    saved.set(p, existsSync(abs) ? readFileSync(abs, "utf8") : null);
  }
  return saved;
}

function restore(saved) {
  for (const [p, content] of saved) {
    const abs = join(ROOT, p);
    if (content === null) {
      try {
        execFileSync("rm", ["-f", abs]);
      } catch {
        /* nothing to remove */
      }
    } else {
      writeFileSync(abs, content);
    }
  }
}

export function applyEdits(plan) {
  const saved = snapshot(plan.edits.map((e) => e.path));
  for (const edit of plan.edits) {
    const abs = join(ROOT, edit.path);
    let text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    if (edit.find != null) {
      if (!text.includes(edit.find)) {
        restore(saved);
        throw new Error(`edit target not found in ${edit.path}: ${edit.find.slice(0, 40)}`);
      }
      text = text.replace(edit.find, edit.replace);
    }
    if (edit.append) text = text.replace(/\n*$/, "\n") + edit.append + "\n";
    writeFileSync(abs, text);
  }
  return saved;
}

function verify() {
  const run = (cmd, argv) => {
    try {
      execFileSync(cmd, argv, { cwd: ROOT, encoding: "utf8", stdio: "pipe", timeout: 240_000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, out: String((err && (err.stdout || err.message)) || "").slice(-1500) };
    }
  };
  const tests = run(process.execPath, ["--test"]);
  if (!tests.ok) return { ok: false, step: "node --test", detail: tests.out };
  const audit = run(process.execPath, ["scripts/audit.js"]);
  if (!audit.ok) return { ok: false, step: "node scripts/audit.js", detail: audit.out };
  return { ok: true };
}

/* ───────────────────────────────── main ─────────────────────────────────── */

function load(issuesPath) {
  const raw = JSON.parse(readFileSync(issuesPath, "utf8"));
  return Array.isArray(raw) ? raw : [];
}

async function main() {
  const issuesPath = opt("--issues", "");
  if (!issuesPath || !existsSync(issuesPath)) {
    console.error("usage: node scripts/manager.js --issues <file.json> [--apply] [--json]");
    process.exit(2);
  }

  // Newest first: an issue filed this morning is the one still on somebody's
  // mind, and the older ones have had their chance.
  const open = load(issuesPath)
    .filter((i) => i.state === "open")
    .filter((i) => (i.labels || []).some((l) => (typeof l === "string" ? l : l.name) === "growth"))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const reports = [];
  for (const issue of open) {
    const plan = planFor(issue);
    reports.push({ issue: issue.number, title: issue.title, ...plan });
    if (plan.ok && flag("--apply")) {
      // One per run, by design: if two fixes interact, a reviewer has to hold
      // both in their head, and the point of the fence is that they never have to.
      let saved;
      try {
        saved = applyEdits(plan);
      } catch (err) {
        reports[reports.length - 1] = { issue: issue.number, title: issue.title, ok: false, reason: err.message };
        break;
      }
      const verdict = verify();
      if (!verdict.ok) {
        restore(saved);
        reports[reports.length - 1] = {
          issue: issue.number,
          title: issue.title,
          ok: false,
          reason: `the fix broke ${verdict.step}, so it was reverted: ${String(verdict.detail).split("\n").slice(-3).join(" ")}`,
        };
      } else {
        reports[reports.length - 1].verified = true;
      }
      break;
    }
  }

  const applied = reports.find((r) => r.verified);
  if (flag("--json")) {
    process.stdout.write(JSON.stringify({ applied: applied || null, reports }, null, 2) + "\n");
    return;
  }

  console.log(`\n🦞 manager — ${open.length} open proposal(s)\n`);
  for (const r of reports) {
    const mark = r.verified ? "✓ fixed" : r.ok ? "→ planned" : "· left alone";
    console.log(`  ${mark.padEnd(12)} #${r.issue} ${String(r.title).slice(0, 56)}`);
    if (r.ok) console.log(`               ${r.summary} — ${r.detail}`);
    else console.log(`               ${r.reason}`);
  }
  if (!flag("--apply")) console.log("\n  dry run: nothing was written. Add --apply to fix the first mechanical one.\n");
  else if (applied) console.log(`\n  applied #${applied.issue}: ${applied.summary}\n  tests and audit pass; the workflow will open a PR.\n`);
  else console.log("\n  nothing mechanical today.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[manager] failed:", err.message);
    process.exit(1);
  });
}

export { ALLOWED, isAllowed, extractFingerprint, bestMatch };
