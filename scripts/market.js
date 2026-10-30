#!/usr/bin/env node
/**
 * scripts/market.js — what do the other assistants have that this one does not?
 *
 * The rule this file exists to enforce: a claim about a competitor comes from
 * that competitor's own documentation, fetched now, quoted with a URL. Not from
 * a model's memory of what ChatGPT did in 2024. Everything below is a plain
 * fetch-and-count against public sources, so a wrong answer is reproducible and
 * therefore fixable.
 *
 * How the comparison works:
 *
 *   1. Pinch's own capabilities come from docs/CAPABILITIES.json, where each
 *      claim carries evidence — a file or symbol. A capability with no evidence
 *      is not counted as "have".
 *   2. Competitor features come from their README, which is where these
 *      projects list what they do. Feature bullets are matched against the
 *      keyword lists in that same file.
 *   3. Coverage = how many competitors document a capability Pinch lacks. Three
 *      or more is a pattern; one is one project's opinion.
 *
 * What it deliberately does not do: rank, recommend, or write code. It produces
 * a table with sources and stops. The scoring happens in growth.js, where the
 * "one person, one laptop, zero dependencies" constraints are applied — several
 * of the biggest gaps here are things Pinch has decided not to do, and the
 * report says so rather than pretending they are backlog.
 *
 * Usage:
 *   node scripts/market.js                  # human-readable table
 *   node scripts/market.js --json           # { gaps, coverage, sources }
 *   node scripts/market.js --offline        # use the cached snapshot, no network
 *   node scripts/market.js --sources a,b    # restrict to specific repos
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const flag = (n) => args.has(n);
const opt = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TODAY = opt("--today", new Date().toISOString().slice(0, 10));
const CACHE = join(ROOT, "docs", "market-snapshot.json");

/**
 * The comparison set, and why each one is here. Chosen to be the projects a
 * person actually evaluates against Pinch: local-first assistants that run on
 * your own machine, plus the two hosted products everyone measures by. A
 * different set gives a different answer — that is why the list is explicit and
 * short enough to argue about.
 */
const SOURCES = [
  { repo: "open-webui/open-webui", why: "the most-installed local web UI", kind: "local" },
  { repo: "librechat-ai/LibreChat", why: "closest feature parity target", kind: "local" },
  { repo: "Mintplex-Labs/anything-llm", why: "documents + agents, works offline", kind: "local" },
  { repo: "janhq/jan", why: "local-first desktop app", kind: "local" },
  { repo: "khoj-ai/khoj", why: "personal assistant with scheduled agents", kind: "local" },
  { repo: "openinterpreter/open-interpreter", why: "the code-execution benchmark", kind: "local" },
];

/* ──────────────────────────── Pinch's own claim ─────────────────────────── */

function loadCapabilities() {
  const file = join(ROOT, "docs", "CAPABILITIES.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const caps = data.capabilities || [];
  // A capability that claims to exist must carry evidence. An inventory that
  // credits itself without proof is how a project talks itself into complacency.
  for (const cap of caps) {
    if (cap.status === "have" && (!cap.evidence || cap.evidence.length === 0)) {
      cap.status = "unproven";
      cap.note = "marked 'have' with no evidence — treated as absent until somebody points at the code";
    }
  }
  return caps;
}

/* ───────────────────────────── fetching ─────────────────────────────────── */

async function fetchReadme(repo) {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/README.md`;
  const res = await fetch(url, {
    headers: { "user-agent": "pinch-market-research" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
  return { repo, url, text: await res.text(), fetched: TODAY };
}

/** Feature bullets, as this project writes them: list items and headings with
 *  the markup stripped. Deliberately dumb — a parser that guesses produces
 *  confident nonsense, and the keyword match below is the only judgement made. */
export function featureText(readme) {
  return readme
    .split("\n")
    .filter((line) => /^\s*([-*+]|\d+\.)\s+\S|^#{2,4}\s+\S/.test(line))
    .map((line) => line.replace(/^[\s#>*+-]+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim())
    .filter((line) => line.length > 2)
    .join("\n")
    .toLowerCase();
}

/** Which of a capability's keywords a project's documentation actually uses. */
export function matchCapability(text, cap) {
  const hits = cap.keywords.filter((k) => text.includes(k.toLowerCase()));
  return hits;
}

/* ───────────────────────────── the comparison ───────────────────────────── */

export function compare(caps, sources) {
  const rows = [];
  for (const cap of caps) {
    const matched = [];
    for (const source of sources) {
      if (!source.text) continue;
      const hits = matchCapability(featureText(source.text), cap);
      if (hits.length > 0) matched.push({ repo: source.repo, keywords: hits });
    }
    rows.push({
      id: cap.id,
      name: cap.name,
      status: cap.status,
      policy: cap.policy || "in-scope",
      evidence: cap.evidence || [],
      note: cap.note || "",
      coveredBy: matched,
      coverage: matched.length,
      total: sources.filter((s) => s.text).length,
    });
  }
  return rows.sort((a, b) => b.coverage - a.coverage || a.id.localeCompare(b.id));
}

/**
 * Gaps worth proposing: Pinch lacks it, and the market has converged on it.
 *
 * `adjacent` is the interesting middle — "partial" means the capability exists
 * but is a shadow of what everyone else ships, which is usually cheaper to
 * close than a missing one and is where the compound improvements live.
 */
export function gaps(rows, { threshold = 3 } = {}) {
  return rows
    .filter((r) => r.status !== "have")
    // The policy gate is the most important line in this file. Without it the
    // researcher happily reports that four of six competitors support multiple
    // accounts — true, and irrelevant, because Pinch is one person on one
    // laptop. A gap the product has decided not to close is not a backlog item,
    // and a bot that proposes it is a bot that has not read the brief.
    .filter((r) => r.policy === "in-scope")
    .filter((r) => r.coverage >= threshold)
    .map((r) => ({
      ...r,
      kind: r.status === "partial" ? "market-adjacent" : "market-gap",
      // Partial + widely covered is the cheapest real improvement available.
      opportunity: r.status === "partial" ? r.coverage + 2 : r.coverage,
    }))
    .sort((a, b) => b.opportunity - a.opportunity);
}

/* ───────────────────────────────── main ─────────────────────────────────── */

async function main() {
  const caps = loadCapabilities();
  let sources = [];

  if (flag("--offline")) {
    if (!existsSync(CACHE)) {
      console.error("no cached snapshot — run once without --offline");
      process.exit(1);
    }
    sources = JSON.parse(readFileSync(CACHE, "utf8")).sources || [];
  } else {
    const only = opt("--sources", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const wanted = only.length > 0 ? SOURCES.filter((s) => only.includes(s.repo)) : SOURCES;
    const results = await Promise.all(
      wanted.map(async (s) => {
        try {
          const r = await fetchReadme(s.repo);
          return { ...r, why: s.why, kind: s.kind, ok: true };
        } catch (err) {
          // A source that will not load is a hole in the comparison, not a
          // reason to fail the run — but it is reported, never silently dropped.
          return { repo: s.repo, why: s.why, kind: s.kind, ok: false, error: err.message, text: "", fetched: TODAY };
        }
      }),
    );
    sources = results;
    try {
      mkdirSync(dirname(CACHE), { recursive: true });
      writeFileSync(CACHE, JSON.stringify({ fetched: TODAY, sources }, null, 2) + "\n");
    } catch {
      /* a cache that cannot be written is not a reason to lose the report */
    }
  }

  const rows = compare(caps, sources);
  const found = gaps(rows);
  const failed = sources.filter((s) => !s.ok);

  if (flag("--json")) {
    process.stdout.write(
      JSON.stringify({ today: TODAY, sources: sources.map(({ text, ...rest }) => rest), rows, gaps: found }, null, 2) + "\n",
    );
    return;
  }

  console.log(`\n🦞 market — ${TODAY}`);
  console.log(`   ${sources.filter((s) => s.ok !== false).length}/${sources.length} sources read\n`);

  if (failed.length) {
    for (const f of failed) console.log(`   ⚠ ${f.repo}: ${f.error}`);
    console.log("");
  }

  const head = "capability".padEnd(30) + "pinch".padEnd(10) + "market".padEnd(9) + "policy";
  console.log("  " + head);
  console.log("  " + "─".repeat(head.length + 8));
  for (const r of rows) {
    const marks = r.coveredBy.length ? `${r.coveredBy.length}/${r.total}` : "—";
    const status = r.status === "have" ? "✓" : r.status === "partial" ? "~" : "·";
    const policy = r.policy === "in-scope" ? "" : ` (${r.policy})`;
    console.log(`  ${status} ${r.name.slice(0, 28).padEnd(28)} ${r.status.padEnd(9)} ${marks.padEnd(9)}${policy}`);
  }

  console.log(`\n  Gaps worth a proposal (${found.length}):\n`);
  for (const g of found) {
    console.log(`  ${String(g.opportunity).padStart(3)}  ${g.kind.padEnd(15)} ${g.name}`);
    console.log(`       covered by ${g.coveredBy.map((c) => c.repo.split("/")[1]).join(", ")}`);
  }
  console.log("\n  Nothing here is a decision. docs/CAPABILITIES.json records what Pinch has chosen not to do.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[market] failed:", err.message);
    process.exit(1);
  });
}
