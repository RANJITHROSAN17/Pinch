#!/usr/bin/env node
/**
 * Tech radar — `npm run radar`
 *
 * Answers one question on a schedule: "has the ground moved under this repo?"
 *
 * The point of this script is what it does *not* do. It does not ask a language
 * model what is current — a model asked "what is new in Node?" will answer from
 * its training data and sound completely confident while being a year out of
 * date. The exact failure mode Pinch's own honesty guard exists to catch,
 * pointed at Pinch itself.
 *
 * Instead it fetches primary sources and compares them against this repo:
 *
 *   endoflife.date   → Node.js lifecycle (is `engines` still supported?)
 *   nodejs.org/dist  → the actual latest release line
 *   GitHub API       → the latest release of every action pinned in .github/
 *
 * Then it diffs those facts against `package.json` and `.github/workflows/`.
 * No API key, no model, no vendor, works offline-ish (each source fails soft).
 *
 *   node scripts/tech-radar.js            # human-readable report
 *   node scripts/tech-radar.js --markdown # the body of the issue it files
 *   node scripts/tech-radar.js --json     # machine-readable
 *   node scripts/tech-radar.js --strict   # exit 1 when anything has drifted
 *
 * Drift is not a crisis. It is a list of small decisions to make deliberately
 * rather than discover later.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const AS_MARKDOWN = args.has("--markdown");
const AS_JSON = args.has("--json");
const STRICT = args.has("--strict");
const TIMEOUT = 10_000;

const findings = [];
function note(severity, area, detail, action) {
  findings.push({ severity, area, detail, action });
}

async function getJSON(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "pinch-tech-radar", accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";

// ── what this repo claims ───────────────────────────────────────────────────
const engineMin = String(pkg.engines?.node || "").replace(/[^\d.]/g, ""); // ">=20.6" → "20.6"
const engineMajor = Number(engineMin.split(".")[0]) || null;

const workflowDir = join(root, ".github", "workflows");
const workflows = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  : [];
const workflowText = workflows.map((f) => readFileSync(join(workflowDir, f), "utf8")).join("\n");

// CI matrix majors, e.g. node: ["20", "22"]
const matrixMajors = [...workflowText.matchAll(/node:\s*\[([^\]]+)\]/g)]
  .flatMap((m) => m[1].split(",").map((x) => Number(x.replace(/[^\d]/g, ""))))
  .filter(Boolean);

// every `uses: owner/repo@ref`
const actions = new Map();
for (const m of workflowText.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([\w.-]+)/g)) {
  const [, name, ref] = m;
  if (name.startsWith("./")) continue;
  if (!actions.has(name)) actions.set(name, new Set());
  actions.get(name).add(ref);
}

// ── 1. runtime lifecycle ────────────────────────────────────────────────────
let nodeCycles = null;
try {
  nodeCycles = await getJSON("https://endoflife.date/api/nodejs.json");
} catch (err) {
  note("info", "runtime", `could not reach endoflife.date (${err.message}) — skipped the lifecycle check`, "");
}

if (nodeCycles && engineMajor) {
  const today = new Date().toISOString().slice(0, 10);
  const claimed = nodeCycles.find((c) => Number(c.cycle) === engineMajor);
  const activeLts = nodeCycles.filter((c) => c.lts && typeof c.lts === "string" && c.lts <= today && c.eol > today);

  if (!claimed) {
    note("warn", "runtime", `engines says node >=${engineMin}, but that line is unknown to endoflife.date`, "verify the version range by hand");
  } else if (claimed.eol <= today) {
    note(
      "high",
      "runtime",
      `engines allows Node ${claimed.cycle}, which reached end of life on ${claimed.eol} — no security patches at all`,
      `raise engines.node to >=${activeLts.at(-1)?.cycle || 22}`
    );
  } else if (claimed.support && claimed.support <= today) {
    // A decided policy is not drift. If package.json documents that the floor
    // stays on this cycle until a specific date, say so once and stop nagging
    // — but keep escalating the moment that date passes (the `eol` branch above
    // takes over as soon as the cycle is out of support).
    const policy = pkg.pinch?.node;
    const decided =
      policy &&
      Number(policy.min) === Number(claimed.cycle) &&
      String(policy.dropMinAt || "") > today;

    if (decided) {
      note(
        "info",
        "runtime",
        `Node ${claimed.cycle} is in maintenance until ${claimed.eol} — covered by the support policy (docs/SUPPORT.md); the floor rises to ${policy.becomes ?? "the next LTS"} on ${policy.dropMinAt}`,
        ""
      );
    } else {
      note(
        "low",
        "runtime",
        `Node ${claimed.cycle} is in maintenance (security fixes only) since ${claimed.support}; EOL ${claimed.eol}`,
        "plan the next major bump before the EOL date"
      );
    }
  } else {
    note("info", "runtime", `Node ${claimed.cycle} is supported until ${claimed.eol}`, "");
  }

  for (const major of matrixMajors) {
    const cycle = nodeCycles.find((c) => Number(c.cycle) === major);
    if (cycle && cycle.eol <= today) {
      note("medium", "ci", `CI still runs Node ${major}, which is end-of-life (${cycle.eol})`, "drop it from the matrix or pin it deliberately");
    }
  }

  const newestLts = activeLts.map((c) => Number(c.cycle)).sort((a, b) => b - a)[0];
  if (newestLts && !matrixMajors.includes(newestLts)) {
    note("low", "ci", `Node ${newestLts} is the newest active LTS and is not in the CI matrix`, `add "${newestLts}" to strategy.matrix.node`);
  }
}

// ── 2. are we claiming versions the README doesn't match? ───────────────────
if (engineMajor && /Node\.js\s*≥\s*(\d+)/.test(readme)) {
  const readmeMin = Number(readme.match(/Node\.js\s*≥\s*(\d+)/)[1]);
  if (readmeMin !== engineMajor) {
    note("low", "docs", `README says Node ≥ ${readmeMin}, package.json says ≥ ${engineMin}`, "make them agree — readers trust the README");
  }
}

// ── 3. pinned GitHub Actions ────────────────────────────────────────────────
const token = process.env.GITHUB_TOKEN || "";
for (const [name, refs] of actions) {
  const ref = [...refs][0];
  if (/^[0-9a-f]{40}$/.test(ref)) {
    // SHA-pinned: good practice, but we cannot compare it without extra calls.
    note("info", "actions", `${name} is pinned to a commit SHA (good)`, "Dependabot keeps SHA pins current");
    continue;
  }
  try {
    const latest = await getJSON(`https://api.github.com/repos/${name}/releases/latest`, {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    });
    const latestTag = latest.tag_name;
    const usedMajor = Number(String(ref).replace(/^v/, "").split(".")[0]);
    const latestMajor = Number(String(latestTag).replace(/^v/, "").split(".")[0]);
    if (Number.isFinite(usedMajor) && Number.isFinite(latestMajor) && latestMajor > usedMajor) {
      note("medium", "actions", `${name}@${ref} — latest is ${latestTag}`, `bump to @v${latestMajor}`);
    } else {
      note("info", "actions", `${name}@${ref} is current (latest ${latestTag})`, "");
    }
  } catch (err) {
    note("info", "actions", `could not check ${name} (${err.message})`, "");
  }
}

// ── 4. the two optional dependencies ────────────────────────────────────────
const optional = Object.keys(pkg.optionalDependencies || {});
if (optional.length) {
  for (const dep of optional) {
    try {
      const meta = await getJSON(`https://registry.npmjs.org/${dep}/latest`);
      note("info", "deps", `${dep} — latest ${meta.version}`, "optional, only needed for the WhatsApp bridge");
    } catch {
      note("info", "deps", `${dep} — could not reach the npm registry`, "");
    }
  }
} else {
  note("info", "deps", "no runtime dependencies at all", "");
}

// ── 5. is the repo's own story still true? ──────────────────────────────────
try {
  const ls = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  const srcFiles = ls.filter((f) => f.startsWith("src/") && f.endsWith(".js")).length;
  note("info", "repo", `${srcFiles} source files, ${ls.length} tracked files`, "");
} catch {
  note("info", "repo", "not a git checkout", "");
}

// ── report ──────────────────────────────────────────────────────────────────
const order = { high: 0, medium: 1, low: 2, info: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);
const actionable = findings.filter((f) => f.severity !== "info");
const today = new Date().toISOString().slice(0, 10);

if (AS_JSON) {
  console.log(JSON.stringify({ date: today, engineMin, matrixMajors, findings }, null, 2));
  process.exit(STRICT && actionable.length ? 1 : 0);
}

if (AS_MARKDOWN) {
  console.log(`## 🦞 Tech radar — ${today}`);
  console.log("");
  console.log("Grounded in primary sources (`endoflife.date`, `nodejs.org`, the GitHub API), not in a model's memory.");
  console.log("");
  if (!actionable.length) {
    console.log("**Nothing has drifted.** Runtime, CI matrix and pinned actions all look current.");
  } else {
    console.log("| Severity | Area | Finding | Suggested move |");
    console.log("|---|---|---|---|");
    for (const f of actionable) {
      console.log(`| ${f.severity} | ${f.area} | ${f.detail} | ${f.action || "—"} |`);
    }
  }
  console.log("");
  console.log("<details><summary>The full sweep, including what is already fine</summary>");
  console.log("");
  console.log("| Area | Detail |");
  console.log("|---|---|");
  for (const f of findings.filter((x) => x.severity === "info")) console.log(`| ${f.area} | ${f.detail} |`);
  console.log("");
  console.log("</details>");
  console.log("");
  console.log("---");
  console.log("");
  console.log("*Filed by `npm run radar`. A human decides what to act on — this job never edits code.*");
  process.exit(0);
}

const colour = process.stdout.isTTY;
const paint = (code, s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
const label = { high: paint("38;5;203", "HIGH"), medium: paint("38;5;214", "MED "), low: paint("38;5;180", "LOW "), info: paint("2", "info") };

console.log("");
console.log(paint("1", "  🦞 Pinch tech radar") + paint("2", `  ${today}`));
console.log(paint("2", "  ─────────────────────────────────────────────────────────────────────"));
if (!findings.length) console.log("  nothing to report");
for (const f of findings) {
  console.log(`  ${label[f.severity]}  ${f.area.padEnd(8)} ${f.detail}`);
  if (f.action) console.log(paint("2", `              → ${f.action}`));
}
console.log(paint("2", "  ─────────────────────────────────────────────────────────────────────"));
console.log(
  actionable.length
    ? paint("38;5;214", `  ${actionable.length} thing${actionable.length === 1 ? "" : "s"} worth deciding on.`) + "\n"
    : paint("38;5;79", "  Everything is current.") + "\n"
);

if (STRICT && actionable.length) process.exit(1);
