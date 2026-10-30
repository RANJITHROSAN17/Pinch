#!/usr/bin/env node
/**
 * scripts/growth.js — the daily growth loop.
 *
 * What this is: a small, deterministic program that looks at this repository
 * once a day, works out the single most valuable thing to build next, and — if
 * and only if the evidence clears a bar — files it as an issue with enough
 * detail that a human can decide in two minutes.
 *
 * What this is not: an agent that writes code. `.github/prompts/self-improvement.md`
 * argues that case at length, and the argument has not changed. A bot that opens
 * a PR every day is a bot whose PRs stop being read, and this repo runs shell
 * commands on a stranger's laptop — the cost of an unread diff is a wiped machine,
 * not a broken page.
 *
 * Why no model: a model asked "what should we build next?" with no inputs
 * answers from its training data, confidently, and that answer is a year stale.
 * Every signal below is measured from the checkout in front of it — a coverage
 * number, a link that does not resolve, a verb in the help text that the switch
 * does not implement. Facts come from the tree; judgement stays with the human.
 *
 * The gate ("when needed"):
 *   - nothing is filed unless the best candidate scores at least MIN_SCORE;
 *   - nothing is filed while MAX_OPEN growth proposals are already open;
 *   - nothing is re-filed if the same fingerprint was proposed in the last
 *     WINDOW_DAYS, in any state;
 *   - at most one issue per run, ever.
 *
 * Usage:
 *   node scripts/growth.js                 # human-readable report, no side effects
 *   node scripts/growth.js --json          # the decision, machine readable
 *   node scripts/growth.js --md            # the proposal body, markdown
 *   node scripts/growth.js --existing f.json  # dedupe against `gh issue list --json …`
 *   node scripts/growth.js --no-coverage   # skip the (slow) coverage measurement
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const flag = (name) => args.has(name);
const opt = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** A candidate below this is not worth a maintainer's attention. */
const MIN_SCORE = Number(opt("--min", process.env.GROWTH_MIN_SCORE || 3));
/** How many open growth proposals are allowed to pile up before the bot goes quiet. */
const MAX_OPEN = Number(opt("--max-open", process.env.GROWTH_MAX_OPEN || 2));
/** The board cap at hourly cadence, where six open is a week of attention. */
const HOURLY_MAX_OPEN = Number(opt("--hourly-cap", process.env.GROWTH_HOURLY_CAP || 6));
/** A fingerprint proposed inside this window is not proposed again. */
const WINDOW_DAYS = Number(opt("--window", process.env.GROWTH_WINDOW_DAYS || 30));
/** The label every growth issue carries, and how issues are found again. */
const LABEL = "growth";
const TODAY = opt("--today", new Date().toISOString().slice(0, 10));
/** Files the coverage collector will judge. Small files are excluded — a 20-line
 *  module at 40% is two untested lines, not a project problem. */
const COVERAGE_FLOOR = 60;
const COVERAGE_MIN_LINES = 40;

/* ─────────────────────────────── candidates ────────────────────────────── */

/**
 * A candidate is one proposal, with its evidence attached.
 *
 *   kind        which collector found it — used to keep one run from filing
 *               three variations of the same thought
 *   fingerprint stable identity across runs, so dedupe is exact rather than
 *               a title-matching guess
 *   impact      1..5  what changes for the user if this lands
 *   confidence  1..3  is this measured from the tree (3), read from a doc (2),
 *                     or inferred (1)
 *   demand      1..3  did a human already ask for it
 *   effort      1..5  how much work, honestly
 */
function candidate(c) {
  const effort = Math.max(1, c.effort);
  const score = Math.round(((c.impact * c.confidence * c.demand) / effort) * 100) / 100;
  // `effort` is written back explicitly: spreading `c` after computing it would
  // return the caller's 0 alongside a score that was divided by 1, and a
  // proposal whose arithmetic disagrees with its own table is worse than no
  // proposal.
  return { ...c, effort, score };
}

/* ──────────────────────────────── collectors ───────────────────────────── */

/**
 * Measured test coverage. The only signal here that cannot be argued with:
 * the number comes from running the suite, not from counting imports.
 *
 * A file absent from the report was never loaded by any test — that is a
 * different and usually more interesting fact than a low percentage, and it is
 * reported as such rather than as "0%".
 */
function collectCoverage() {
  const out = { candidates: [], note: null, report: null };
  let text = "";
  try {
    text = execFileSync(
      process.execPath,
      ["--test", "--experimental-test-coverage"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    // A failing test still produces a coverage report; a crash does not.
    text = String((err && err.stdout) || "");
    if (!text.includes("coverage report")) {
      out.note = "coverage could not be measured (the suite did not run to completion)";
      return out;
    }
  }

  const files = [];
  for (const line of text.split("\n")) {
    // "# src/brain.js  |  33.58 | 66.67 | 29.41 | 19-44 53-76"
    const m = /^#\s+(\S+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(line);
    if (m) files.push({ file: m[1], line: Number(m[2]), branch: Number(m[3]), funcs: Number(m[4]) });
  }
  out.report = files;
  if (files.length === 0) {
    out.note = "the coverage report could not be parsed (Node format change?)";
    return out;
  }

  const counted = files.filter((f) => f.file.startsWith("src/") || f.file.startsWith("scripts/"));
  for (const f of counted) {
    const lines = countLines(f.file);
    if (lines < COVERAGE_MIN_LINES) continue;
    if (f.line >= COVERAGE_FLOOR) continue;
    out.candidates.push(
      candidate({
        kind: "tests",
        fingerprint: `tests:${slug(f.file)}`,
        title: `Test ${f.file} — ${f.line.toFixed(1)}% covered`,
        impact: 3,
        confidence: 3,
        demand: 1,
        effort: 2,
        what: `${f.file} is ${lines} lines and only ${f.line.toFixed(1)}% of it is executed by the test suite (${f.branch.toFixed(1)}% of branches). The parts nobody runs are the parts that break silently — and this module is on the path between a chat message and an answer.`,
        why: `Measured on ${TODAY} by \`node --test --experimental-test-coverage\` on this checkout. The repo average is ${averageLine(counted).toFixed(1)}%.`,
        where: [`new \`test/${slug(readableBase(f.file))}.test.js\`, modelled on an existing suite`],
        guard: `The new test file itself, plus a line in \`scripts/audit.js\` if the gap is in a guard rail rather than a convenience. Target: past the ${COVERAGE_FLOOR}% floor with branch coverage that is not decorative.`,
        cost: "Tests are the one kind of code that never pays back on its own schedule. Writing them here means not writing a feature this week.",
        risk: lowRisk(f.file),
      }),
    );
  }

  // Modules no test loads at all. These need fakes or process spawning, so they
  // cost more than a missed branch, but a channel adapter nobody exercises is a
  // shape of risk worth naming out loud.
  const seen = new Set(files.map((f) => f.file));
  for (const f of unloadedModules()) {
    if (seen.has(f)) continue;
    out.candidates.push(
      candidate({
        kind: "tests",
        fingerprint: `tests-unloaded:${slug(f)}`,
        title: `Nothing loads ${f} during tests`,
        impact: 3,
        confidence: 3,
        demand: 1,
        effort: 3,
        what: `${f} never appears in the coverage report, which means no test imports it and no test drives it as a process. Every line in it ships unexercised.`,
        why: `Measured on ${TODAY}: the file is absent from \`node --test --experimental-test-coverage\` output entirely, which is stronger evidence than a low percentage.`,
        where: [`new \`test/${slug(readableBase(f))}.test.js\``, "a fake transport on top of the module's own seam"],
        guard: `A test that fails if the module is removed from the build, and that exercises the request/response shape the real transport uses.`,
        cost: "Fakes are only as good as the assumption they encode; a test against a wrong fake is worse than none.",
        risk: "Low — adding tests cannot weaken a guard rail.",
      }),
    );
  }
  return out;
}

function unloadedModules() {
  const out = [];
  for (const dir of [join(ROOT, "src"), join(ROOT, "src", "channels")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      const rel = relative(ROOT, join(dir, name)).split("\\").join("/");
      if (rel.startsWith("src/channels/index")) continue;
      out.push(rel);
    }
  }
  return out;
}

/** Relative links that do not resolve, as `{file, line, target}`. Pure and
 *  root-taking so the test suite can point it at a fixture instead of at this
 *  repository — a linter you cannot test on a known-bad tree is a linter you
 *  find out about in production. */
function findBrokenLinks(root, files) {
  const broken = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const [pathPart] = target.split("#");
        if (!pathPart) continue;
        const abs = resolve(root, dirname(file), decodeURI(pathPart));
        if (existsSync(abs)) continue;
        broken.push({ file, line: i + 1, target: pathPart });
      }
    });
  }
  return broken;
}

/** The same, rendered as proposals. A broken link is a reader standing in front
 *  of a 404 at exactly the moment they were being careful. */
function collectDocDrift(root = ROOT, files = markdownFiles()) {
  return findBrokenLinks(root, files).map((b) =>
    candidate({
      kind: "docs",
      fingerprint: `docs:broken-link:${slug(b.file)}:${slug(b.target)}`,
      title: `\`${b.file}:${b.line}\` links to a file that is not there`,
      impact: 2,
      confidence: 3,
      demand: 1,
      effort: 1,
      what: `\`${b.file}\` line ${b.line} points at \`${b.target}\`, which does not exist in the repository. Anyone following the setup or the audit trail hits a 404 at exactly the moment they were being careful.`,
      why: `Checked on ${TODAY}: \`${b.target}\` is not in the tree.`,
      where: [`${b.file}:${b.line}`],
      guard: "A link check in `scripts/audit.js`, so the next broken link fails a build instead of a reader.",
      cost: "Almost none. This is the cheapest kind of correctness.",
      risk: "None.",
    }),
  );
}

/** Verbs the help text promises but the switch does not implement — or the
 *  reverse, which is a feature nobody can discover. Aliases are not drift:
 *  `case "start": case "serve":` is one verb with two names, not two features. */
function collectCliDrift() {
  const file = join(ROOT, "bin", "pinch.js");
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");

  const usageBlock = /function usage\(\)\s*\{([\s\S]*?)\n\}/.exec(src);
  const promised = new Set();
  if (usageBlock) {
    // The verb is inside the bold tag: c.bold("pinch") or c.bold("pinch pair").
    // Matching bare "pinch <word>" instead picks up the first word of the
    // description — which is how an earlier version of this file decided that
    // `pinch start` was undiscoverable when it is the whole product.
    for (const m of usageBlock[1].matchAll(/c\.bold\("pinch(?: ([a-z][a-z-]+))?"\)/g)) {
      promised.add(m[1] || "start");
    }
  }

  const labels = [...src.matchAll(/case\s+"([a-z][a-z-]+)":/g)].map((m) => ({ verb: m[1], at: m.index + m[0].length }));
  const allLabels = labels.map((l) => l.verb);
  // Group case labels into one feature per group: `case "start": case "serve":`
  // is one verb with two names. A label is an alias when the only thing between
  // it and the label before it is whitespace.
  const groups = [];
  labels.forEach((label, i) => {
    const prev = labels[i - 1];
    const gapBefore = prev ? src.slice(prev.at, label.at - `case "${label.verb}":`.length) : "x";
    if (prev && gapBefore.trim() === "") groups[groups.length - 1].push(label.verb);
    else groups.push([label.verb]);
  });

  const out = [];
  for (const verb of promised) {
    // Implemented by any label, alias or not. The canonical/alias split only
    // matters for the other direction: reporting an alias as undiscoverable is
    // noise, but calling a working verb missing is a false bug report.
    if (allLabels.includes(verb)) continue;
    out.push(
      candidate({
        kind: "first-run",
        fingerprint: `cli:promised-not-implemented:${verb}`,
        title: `\`pinch ${verb}\` is in the help text but not in the switch`,
        impact: 5,
        confidence: 3,
        demand: 1,
        effort: 1,
        what: `\`bin/pinch.js usage()\` advertises \`pinch ${verb}\`. The command switch has no case for it, so a user who follows the help text gets the unknown-command path.`,
        why: `Static check on ${TODAY}: "${verb}" appears in usage() and no \`case\` label implements it.`,
        where: ["bin/pinch.js"],
        guard: "A test that every verb in usage() resolves to a case, run in `npm test`.",
        cost: "None — either implement the verb or remove the line.",
        risk: "Low. First-run friction, not a security path.",
      }),
    );
  }
  for (const group of groups) {
    const verb = group[0];
    if (promised.has(verb) || group.some((v) => promised.has(v))) continue;
    if (verb === "help" || verb.startsWith("-")) continue;
    out.push(
      candidate({
        kind: "first-run",
        fingerprint: `cli:implemented-not-documented:${verb}`,
        title: `\`pinch ${verb}\` works but nobody can find it`,
        impact: 2,
        confidence: 3,
        demand: 1,
        effort: 1,
        what: `The command switch handles \`${verb}\`, but usage() never mentions it. A capability that cannot be discovered is a capability that does not exist for the person who needed it.`,
        why: `Static check on ${TODAY}: "${verb}" is the first label of its case group and usage() has no line for it.`,
        where: ["bin/pinch.js"],
        guard: "The same usage/switch test from the other direction.",
        cost: "One line in a template literal.",
        risk: "None.",
      }),
    );
  }
  return out;
}

/**
 * Environment variables *read* by a source file.
 *
 * Two bugs live in the naive version of this one line, and both produced a
 * confident false proposal:
 *   - `env.PINCH = "1"` is an assignment, not configuration;
 *   - backtracking let the character class stop early, so `env.PINCH` was
 *     reported as a variable called `PINC`.
 * The identifier boundary and the assignment lookahead together fix both.
 */
const ENV_READ = /env\.([A-Z][A-Z0-9_]{3,})(?![A-Z0-9_])(?!\s*=(?!=))/g;

function envReadsIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(ENV_READ)) out.add(m[1]);
  return [...out];
}

/** Configuration the product reads but no document mentions. An assistant with
 *  a switch nobody can find is an assistant with one less feature. */
function collectUndocumentedConfig() {
  const out = [];
  const sources = [];
  for (const dir of ["src", "src/channels"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) if (name.endsWith(".js")) sources.push(`${dir}/${name}`);
  }
  const used = new Map();
  for (const rel of sources) {
    let text;
    try {
      text = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    for (const name of envReadsIn(text)) {
      if (!used.has(name)) used.set(name, new Set());
      used.get(name).add(rel);
    }
  }

  const documented = [".env.example", "README.md", join("docs", "GUIDE.md"), join("docs", "SECURITY.md"), join("docs", "CHANNELS.md"), join("scripts", "setup.js")]
    .map((f) => {
      try {
        return readFileSync(join(ROOT, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

  for (const [name, files] of used) {
    if (new RegExp(`\\b${name}\\b`).test(documented)) continue;
    out.push(
      candidate({
        kind: "docs",
        fingerprint: `config:undocumented:${slug(name)}`,
        title: `${name} works but is documented nowhere`,
        impact: 3,
        confidence: 3,
        demand: 1,
        effort: 1,
        what: `\`${[...files].join("\`, \`")}\` reads \`${name}\` from the environment, but it appears in neither \`.env.example\` nor the guides. The capability exists; nobody can find it or trust that it is supported.`,
        why: `Static check on ${TODAY}: \`${name}\` is read in source and absent from every document that lists configuration.`,
        where: [".env.example", "docs/GUIDE.md"],
        guard: "A test that every environment variable read by `src/` appears in `.env.example`.",
        cost: "Two lines of documentation, and the promise to keep them true.",
        risk: "None. If anything, documenting a switch makes its blast radius clearer.",
      }),
    );
  }
  return out;
}

/** Someone opened an issue asking for something. That is the strongest signal
 *  this bot has, and it is the one a model cannot invent. Rather than file a
 *  duplicate, the bot writes the missing half of the request — where it fits,
 *  what it costs, what could break — as a comment on the original. */
function collectDemand(existing) {
  const out = [];
  const SKIP_LABELS = new Set([LABEL, "security", "dependencies", "duplicate", "wontfix"]);
  for (const issue of existing) {
    if (issue.state !== "open") continue;
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
    if (labels.some((l) => SKIP_LABELS.has(l.toLowerCase()))) continue;
    const body = String(issue.body || "");
    if (body.includes("growth:fingerprint:")) continue;
    const comments = issue.comments || [];
    const annotated = comments.some((c) => String(c.body || "").includes(`growth:spec:#${issue.number}`));
    if (annotated) continue;

    const wanted = labels.some((l) => /enhancement|feature|help.?wanted|good.?first/i.test(l));
    out.push(
      candidate({
        kind: "demand",
        fingerprint: `demand:#${issue.number}`,
        issue: issue.number,
        action: "annotate",
        title: `Spec out #${issue.number}: ${String(issue.title || "").slice(0, 70)}`,
        impact: wanted ? 4 : 3,
        confidence: 3,
        demand: 3,
        effort: 3,
        what: `Issue #${issue.number} — "${issue.title}" — is open and nobody has picked it up. The request exists; the spec does not. The bot can supply the part that takes a maintainer an hour of context-switching: where in this codebase the change lands, what it would cost, which invariant it could touch, and the test that would prove it works.`,
        why: `Opened by a human and still open on ${TODAY}. Demand is the one input that cannot be derived from the tree, which is why an issue counts for more than any measurement here.`,
        where: demandPointers(body),
        guard: "Whatever the comment proposes — the point is that the issue ends up with a testable acceptance criterion instead of a wish.",
        cost: "A proposal on an issue that may be declined. Cheaper than a PR on an issue that was never specified.",
        risk: "None from the comment itself. If the feature touches the approval gate, command screen or workspace sandbox, the risk section below is where it has to be argued.",
      }),
    );
  }
  return out;
}

function demandPointers(body) {
  const hits = [...new Set([...String(body).matchAll(/\b([a-z][a-z0-9-]*\.js)\b/g)].map((m) => m[1]))].filter((f) => existsSync(join(ROOT, "src", f)) || existsSync(join(ROOT, "src", "channels", f)));
  if (hits.length > 0) return hits.map((h) => `\`${h}\` — named in the issue itself`);
  return ["The bot cannot tell from the issue text where this lands — a maintainer should name the seam before anyone writes code. Guessing here would be worse than saying so."];
}

/** The residual-risk register is the repo's own backlog of accepted trade-offs.
 *  It is included so the bot can see it, but scored low on purpose: these were
 *  decided, and re-proposing a decided thing daily is how a bot gets muted. */
function collectResidualRisks() {
  const file = join(ROOT, "docs", "AUDIT.md");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const start = text.indexOf("## Residual risk register");
  if (start < 0) return [];
  const section = text.slice(start);
  const out = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const [, risk, why, mitigation] = m;
    if (/^-+$/.test(risk) || /^risk$/i.test(risk)) continue;
    if (risk.length < 12) continue;
    out.push(
      candidate({
        kind: "accepted-risk",
        fingerprint: `risk:${slug(risk).slice(0, 48)}`,
        title: `Residual risk: ${risk.slice(0, 60)}`,
        impact: 2,
        confidence: 2,
        demand: 1,
        effort: 3,
        what: `The audit register documents "${risk}" as known and accepted. Current mitigation: ${mitigation}.`,
        why: `Read from \`docs/AUDIT.md\` on ${TODAY}. Why it remains: ${why}.`,
        where: ["docs/AUDIT.md#residual-risk-register"],
        guard: "Whatever probe demonstrates the mitigation still holds — `scripts/audit.js` if it is a guard rail.",
        cost: "Accepted risks were accepted for a reason; re-opening one costs the argument that closed it.",
        risk: "Often high — that is why it was accepted. Do not propose this without a new mitigation.",
      }),
    );
  }
  return out;
}

/**
 * Competitive gaps, handed in by scripts/market.js.
 *
 * The bot does not fetch these itself: market research needs the network, and
 * this file is deliberately a pure function of the tree so every decision is
 * reproducible with no signal. The workflow runs the researcher, passes the
 * result here, and the policy field on each capability decides whether a gap is
 * proposable at all — "multi-user" is out-of-scope and never becomes one, no
 * matter how many competitors ship it.
 */
function collectMarket(path) {
  if (!path) return { candidates: [], note: "no market report supplied (offline run)" };
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { candidates: [], note: `could not read ${path} — market gaps skipped` };
  }
  const gaps = Array.isArray(report.gaps) ? report.gaps : [];
  const sources = (report.sources || []).filter((s) => s.ok !== false).length;
  const out = gaps.map((g) =>
    candidate({
      kind: g.kind || "market-gap",
      fingerprint: `market:${g.id}`,
      title: `${g.name} — ${g.coveredBy.length} of ${g.total} comparable assistants document it`,
      // Market evidence is real demand, but second-hand: a human opening an
      // issue still outranks it, which is why demand is 2 and not 3. Impact
      // scales with how unanimous the comparison set is — four of six is a
      // pattern, six of six is table stakes.
      impact: g.coveredBy.length / Math.max(1, g.total) >= 0.8 ? 4 : 3,
      confidence: 3,
      demand: 2,
      effort: g.status === "partial" ? 3 : 4,
      what: `${g.name}. Pinch's inventory currently says **${g.status}**${g.note ? ` — ${g.note}` : ""}. ${g.status === "partial" ? "The capability exists but not to the depth the comparison set ships, which is usually the cheapest kind of improvement available." : "Pinch does not do this at all."}`,
      why: `Read from each project's own README on ${report.today || TODAY} (${sources} sources): ${g.coveredBy.map((c) => c.repo).join(", ")}. Keywords matched: ${[...new Set(g.coveredBy.flatMap((c) => c.keywords))].slice(0, 8).join(", ")}.`,
      where: g.evidence && g.evidence.length ? g.evidence : ["docs/CAPABILITIES.json — the inventory entry that has to change with the code"],
      guard: `An entry in \`docs/CAPABILITIES.json\` flipping from \`${g.status}\` to \`have\`, with evidence a reader can open, plus a test that fails without the behaviour.`,
      cost: "Anything that makes Pinch look more like a hosted product makes it heavier: more surface, more to explain, more to keep secure. The inventory file exists so that trade is visible before the code is written.",
      risk: /plugin|mcp|rag|document|image/i.test(g.id)
        ? "Medium to high. Anything that adds an external input path is a new way to reach the model, and the model can reach the shell. This is the category where review is least optional."
        : "Low to medium — but check `docs/AUDIT.md` before assuming so.",
    }),
  );
  return { candidates: out, note: out.length ? `${out.length} gap(s) from ${sources} sources` : "no proposable gaps" };
}

/* ──────────────────────────────── decision ─────────────────────────────── */

/**
 * Pick at most one thing, and say clearly why nothing was picked.
 *
 * Every early return here is a good day: the point of "when needed" is that a
 * quiet run is a successful run, not a broken one.
 */
function decide(cands, existing) {
  const open = existing.filter((i) => i.state === "open");
  const ranked = [...cands].sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));

  if (ranked.length === 0) {
    return { decision: "skip", reason: "no candidates — nothing in the tree is measurably weak", ranked };
  }

  const top = ranked[0];

  // Demand first, and as a comment rather than a new issue: a human already
  // asked, so the missing piece is the spec, not another copy of the request.
  if (top.action === "annotate") {
    return {
      decision: "annotate",
      reason: `#${top.issue} is an open request from a human (score ${top.score}); it gets a spec comment, not a duplicate issue`,
      chosen: top,
      issue: top.issue,
      ranked,
    };
  }

  if (open.length >= MAX_OPEN) {
    return {
      decision: "skip",
      reason: `${open.length} growth proposals are already open (cap ${MAX_OPEN}) — the backlog is the signal, not another issue`,
      ranked,
    };
  }
  if (top.score < MIN_SCORE) {
    return { decision: "skip", reason: `best candidate scores ${top.score} (floor ${MIN_SCORE}) — below the bar, so silence`, ranked };
  }

  const history = historyFor(top.fingerprint, existing);
  if (history) {
    return {
      decision: "skip",
      reason: `"${top.title}" was already filed as #${history.number} (${history.state}, ${history.age} days ago); re-proposing it is noise`,
      ranked,
    };
  }

  return { decision: "file", reason: `top candidate clears the bar at ${top.score} and is new`, chosen: top, ranked };
}

/**
 * The multi-file version of decide(). "As many as needed, slowly" is a quota,
 * not a flood: the run files up to `quota` new proposals, the caller sets the
 * quota from the track record, and the open-proposal cap still applies across
 * everything already on the board.
 *
 * Annotations are not counted against the quota — answering a human who already
 * asked is never the thing that makes a backlog noisy.
 */
function plan(cands, existing, { quota = 1, maxOpen = MAX_OPEN, shard = null } = {}) {
  const ranked = shard ? rankForShard(cands, shard) : [...cands].sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));
  const open = existing.filter((i) => i.state === "open");
  const openGrowth = open.filter((i) => (i.labels || []).some((l) => (typeof l === "string" ? l : l.name) === LABEL));
  const files = [];
  const annotates = [];
  const skipped = [];

  for (const c of ranked) {
    const history = historyFor(c.fingerprint, existing);

    if (c.action === "annotate") {
      if (history) skipped.push({ fingerprint: c.fingerprint, reason: "already annotated" });
      else annotates.push(c);
      continue;
    }
    if (c.score < MIN_SCORE) {
      skipped.push({ fingerprint: c.fingerprint, reason: `below the floor (${c.score} < ${MIN_SCORE})` });
      continue;
    }
    if (history) {
      skipped.push({ fingerprint: c.fingerprint, reason: `already filed as #${history.number}` });
      continue;
    }
    if (openGrowth.length + files.length >= maxOpen) {
      skipped.push({ fingerprint: c.fingerprint, reason: `open-proposal cap reached (${maxOpen})` });
      continue;
    }
    if (files.length >= quota) {
      skipped.push({ fingerprint: c.fingerprint, reason: `per-run quota reached (${quota})` });
      continue;
    }
    files.push(c);
  }

  const decision = files.length > 0 ? "file" : annotates.length > 0 ? "annotate" : "skip";
  const reason =
    decision === "file"
      ? `filing ${files.length} proposal(s); quota ${quota}, ${openGrowth.length} already open`
      : decision === "annotate"
        ? `${annotates.length} open request(s) from humans get a spec comment`
        : skipped[0]?.reason || "nothing cleared the bar";

  return { decision, reason, files, annotates, skipped, ranked };
}

/**
 * Which class of signal gets first refusal this hour.
 *
 * An hourly loop that re-sorts the same nine gaps 24 times a day is not more
 * responsive, it is just faster at saying the same thing. So the hour of the
 * day rotates attention: this hour looks first at what a human asked for, next
 * hour at the market, then at measurement, then at the repository's own health.
 * Everything is still ranked by score — the shard only breaks ties and decides
 * which category is allowed to lead, so over a day every source gets its turn
 * instead of the loudest one winning every hour.
 */
const SHARDS = [
  { at: 0, kind: "demand", label: "what people asked for" },
  { at: 6, kind: "market-adjacent", label: "capabilities a human can feel" },
  { at: 12, kind: "market-gap", label: "capabilities we do not have at all" },
  { at: 18, kind: "tests", label: "what nothing is testing" },
];

function shardFor(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 0;
  const sorted = [...SHARDS].sort((a, b) => a.at - b.at);
  let chosen = sorted[sorted.length - 1];
  for (const shard of sorted) if (h >= shard.at) chosen = shard;
  return { ...chosen, hour: h };
}

/**
 * Rank with the shard's class pulled forward one place, not to the top.
 *
 * A straight "shard kind first" would let a weak candidate beat a strong one
 * every hour. Promoting it by one band means the rotation changes the order
 * often enough to matter and never enough to file something silly.
 */
function rankForShard(cands, shard) {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));
  const i = sorted.findIndex((c) => c.kind === shard.kind);
  if (i > 0 && i <= 3) {
    // Only within 20% of the candidate above it. Without that guard the
    // rotation becomes a coronation: a score-0.2 gap would outrank a score-9
    // measurement every time its hour came round, which is worse than no
    // rotation at all. The shard breaks ties; it does not overrule evidence.
    const above = sorted[i - 1];
    if (sorted[i].score >= above.score * 0.8) {
      [sorted[i - 1], sorted[i]] = [sorted[i], sorted[i - 1]];
    }
  }
  return sorted;
}

/**
 * How fast the loop is allowed to go.
 *
 * Starts at one proposal per day and earns the right to file more: every two
 * proposals a human merged, the quota goes up by one, capped at five. A loop
 * that has never had a suggestion accepted does not get to open five at once,
 * and one with a track record does not have to be told one at a time.
 *
 * Reverts are not modelled separately: a reverted growth PR is an issue that
 * was closed without a merge, so it never counts as trust earned.
 */
function quotaFor(mergedCount) {
  // Math.max(1, NaN) is NaN, so an unreadable counter would quietly make the
  // bot file nothing rather than fail visibly. Default to the safe minimum.
  if (!Number.isFinite(mergedCount)) return 1;
  return Math.max(1, Math.min(5, 1 + Math.floor(Math.max(0, mergedCount) / 2)));
}

function historyFor(fingerprint, existing) {
  for (const issue of existing) {
    const body = String(issue.body || "");
    if (!body.includes(`growth:fingerprint:${fingerprint}`)) continue;
    const stamp = issue.updatedAt || issue.createdAt || "";
    const ageDays = stamp ? Math.floor((Date.parse(TODAY) - Date.parse(stamp)) / 86_400_000) : 0;
    if (issue.state === "open" || ageDays <= WINDOW_DAYS) {
      return { number: issue.number, state: issue.state, age: ageDays };
    }
  }
  return null;
}

/* ───────────────────────────────── render ──────────────────────────────── */

function renderProposal(chosen, ranked) {
  const others = ranked.filter((c) => c.fingerprint !== chosen.fingerprint).slice(0, 4);
  const lines = [
    `**Growth proposal · ${TODAY}** — filed automatically by \`scripts/growth.js\`, which measured this repository and is not allowed to change it. Deciding is a human job.`,
    "",
    `| | |`,
    `|---|---|`,
    `| **Effort** | ${effortLabel(chosen.effort)} |`,
    `| **Score** | ${chosen.score} — impact ${chosen.impact} × confidence ${chosen.confidence} × demand ${chosen.demand} ÷ effort ${chosen.effort} |`,
    `| **Kind** | ${chosen.kind} |`,
    "",
    "## What",
    chosen.what,
    "",
    "## Why now",
    chosen.why,
  ];
  lines.push(
    "",
    "## Where it fits",
    ...chosen.where.map((w) => `- ${w}`),
    "",
    "## How we would know it works",
    chosen.guard,
    "",
    "## Cost",
    chosen.cost,
    "",
    "## Risk",
    chosen.risk,
    "",
  );
  if (others.length) {
    lines.push(
      "## Ranked below this one",
      "",
      "Shown so the decision is informed, not so all of them get done. Nothing here is filed until the one above is closed.",
      "",
      "| Score | Candidate |",
      "|---|---|",
      ...others.map((c) => `| ${c.score} | ${c.title} |`),
      "",
    );
  }
  lines.push(
    "## What we would have to stop doing",
    "Something. This repository is one person's attention; an issue that does not name its cost is asking for free work.",
    "",
    "---",
    `<sub>Close this if the answer is no — the fingerprint below stops it being proposed again for ${WINDOW_DAYS} days either way.</sub>`,
    `<!-- growth:fingerprint:${chosen.fingerprint} -->`,
  );
  return lines.join("\n");
}

/** The comment left on a human's open request. Same headings as a proposal,
 *  because the person who wrote the issue deserves the same honesty as a
 *  maintainer reading a filed one — including the parts that say "unknown". */
function renderAnnotation(chosen) {
  return [
    `<!-- growth:spec:#${chosen.issue} -->`,
    `**Speculative spec** — written by \`scripts/growth.js\` on ${TODAY} because this issue is open and unclaimed. It is evidence, not a promise, and it is not a claim on your time. Correct anything below; the bot will not edit it.`,
    "",
    "### Where it fits",
    ...chosen.where.map((w) => `- ${w}`),
    "",
    "### How we would know it works",
    chosen.guard,
    "",
    "### Cost",
    chosen.cost,
    "",
    "### The invariant to check first",
    "Pinch's guard rails are the product: the approval gate, the workspace sandbox, `screenCommand()`, host/origin validation and the honesty guard. If this change touches any of them, the PR has to say so and `docs/AUDIT.md` has to grow a line. If it touches none, say that too — it is the fastest way to make a review easy.",
    "",
    "### What would make this a no",
    "A reason that is not effort. \"Nobody has time\" is a scheduling fact; \"it would make the approval prompt less legible\" is a design one.",
  ].join("\n");
}

function effortLabel(effort) {
  return effort <= 2 ? "S" : effort <= 3 ? "M" : "L";
}

/* ───────────────────────────────── main ────────────────────────────────── */

/** Entry point. Only runs when this file is the program being executed, so
 *  the test suite can import the decision logic without launching a scan. */
function main() {
  const existing = loadExisting(opt("--existing", ""));
  const market = collectMarket(opt("--market", ""));
  const all = [
    ...collectDemand(existing),
    ...collectCliDrift(),
    ...collectUndocumentedConfig(),
    ...collectDocDrift(),
    ...(flag("--no-coverage") ? [] : collectCoverage().candidates),
    ...market.candidates,
    ...collectResidualRisks(),
  ];

  // One proposal per kind per run. Two "tests:" issues in one day is the bot
  // talking to itself; the second is already in the ranked table.
  const byKind = new Map();
  for (const c of all.sort((a, b) => b.score - a.score)) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, c);
  }

  const merged = Number(opt("--merged", process.env.GROWTH_MERGED || 0));
  const quota = Number(opt("--quota", quotaFor(merged)));
  // Hourly cadence: the board cap is the real throttle, not the run. Six open
  // proposals is roughly a working week of a single maintainer's attention; past
  // that the loop is producing a queue, not a plan.
  const maxOpen = Math.max(HOURLY_MAX_OPEN, quota + 2);
  const hour = Number(opt("--hour", process.env.GROWTH_HOUR || new Date().getUTCHours()));
  const shard = flag("--no-shard") ? null : shardFor(hour);
  const result = plan([...byKind.values()], existing, { quota, maxOpen, shard });
  result.maxOpen = maxOpen;
  result.shard = shard;
  result.quota = quota;
  result.merged = merged;
  result.marketNote = market.note;

  if (flag("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          decision: result.decision,
          reason: result.reason,
          today: TODAY,
          label: LABEL,
          quota,
          maxOpen: result.maxOpen,
          merged,
          hour: shard ? shard.hour : null,
          shard: shard ? shard.label : "none",
          market: market.note,
          files: result.files.map((c) => ({
            fingerprint: c.fingerprint,
            score: c.score,
            kind: c.kind,
            title: `growth: ${c.title}`,
            markdown: renderProposal(c, result.ranked),
          })),
          annotates: result.annotates.map((c) => ({
            fingerprint: c.fingerprint,
            issue: c.issue,
            score: c.score,
            markdown: renderAnnotation(c),
          })),
          skipped: result.skipped.slice(0, 12),
          ranked: result.ranked.slice(0, 8).map((c) => ({ score: c.score, kind: c.kind, title: c.title })),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const headline = { file: "WOULD FILE", annotate: "WOULD COMMENT", skip: "staying quiet" }[result.decision];
  console.log(`\n🦞 growth — ${TODAY}`);
  console.log(`   quota ${quota} (from ${merged} merged) · cap ${maxOpen} · this hour: ${shard ? shard.label : "no shard"} · market: ${market.note}\n`);
  console.log(`  ${headline}: ${result.reason}\n`);
  for (const c of result.ranked.slice(0, 8)) {
    const mark = result.files.includes(c) ? "→" : result.annotates.includes(c) ? "✎" : " ";
    console.log(`  ${mark} ${String(c.score).padStart(5)}  ${c.kind.padEnd(15)} ${c.title}`);
  }
  for (const c of result.files) {
    console.log("\n── proposal ──\n");
    console.log(renderProposal(c, result.ranked));
  }
  for (const c of result.annotates) {
    console.log("\n── comment ──\n");
    console.log(renderAnnotation(c));
  }
  console.log("");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

/* ──────────────────────────────── helpers ─────────────────────────────── */

function loadExisting(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error(`[growth] could not read ${path} — dedupe disabled for this run`);
    return [];
  }
}

function markdownFiles() {
  const out = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
  const docs = join(ROOT, "docs");
  if (existsSync(docs)) {
    try {
      for (const f of readdirSync(docs)) if (f.endsWith(".md")) out.push(`docs/${f}`);
    } catch {
      /* docs/ replaced by a file: no doc links to check, and no crash either */
    }
  }
  return out.filter((f) => existsSync(join(ROOT, f)));
}

function countLines(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

function averageLine(files) {
  if (files.length === 0) return 0;
  return files.reduce((sum, f) => sum + f.line, 0) / files.length;
}

function readableBase(rel) {
  return rel.split("/").pop().replace(/\.js$/, "");
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lowRisk(file) {
  return /guard|tools|server|store|channels/.test(file)
    ? "None by itself — but if the new test exposes behaviour that contradicts `docs/AUDIT.md`, the test is right and the doc is stale."
    : "None. Tests cannot weaken a guard rail.";
}

// Exported for the test suite. Kept at the bottom so the script reads top-down.
export {
  decide,
  candidate,
  renderProposal,
  renderAnnotation,
  slug,
  collectCliDrift,
  collectUndocumentedConfig,
  collectDocDrift,
  findBrokenLinks,
  collectDemand,
  historyFor,
  plan,
  quotaFor,
  collectMarket,
  envReadsIn,
  shardFor,
  rankForShard,
  HOURLY_MAX_OPEN,
  COVERAGE_FLOOR,
  MIN_SCORE,
  MAX_OPEN,
  WINDOW_DAYS,
};
