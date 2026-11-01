#!/usr/bin/env node
/**
 * roadmap-bots.js — zero-dependency GitHub automation helpers for Pinch.
 *
 * Subcommands:
 *   node scripts/roadmap-bots.js status [--issues-json FILE] [--out FILE]
 *   node scripts/roadmap-bots.js classify-issue --title TEXT --body TEXT
 *   node scripts/roadmap-bots.js pr-context --changed FILE --body FILE [--lines N] [--out FILE]
 *   node scripts/roadmap-bots.js check-workflows
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATUS_MARKER = "<!-- roadmap-status -->";
export const PR_MARKER = "<!-- pr-guide-bot -->";
const ROADMAP_MARKER_RE = /<!--\s*roadmap:([A-Za-z0-9_-]+)\s*-->/;

function argValue(argv, flag, fallback = "") {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
}

export function loadRoadmap(path = join(ROOT, ".github/roadmap.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function extractMarkerId(body) {
  const m = ROADMAP_MARKER_RE.exec(String(body || ""));
  return m ? m[1] : null;
}

export function detectFileDrift(roadmap, repoRoot = ROOT) {
  const missing = [];
  for (const item of roadmap.items || []) {
    if (item.status === "shipped") continue;
    for (const rel of item.files || []) {
      if (rel.startsWith("src/") && !existsSync(join(repoRoot, rel))) {
        missing.push(`${item.id}: missing source path '${rel}'`);
      }
    }
  }
  return missing;
}

export function renderStatusMarkdown(roadmap, issues = [], repoRoot = ROOT) {
  const items = roadmap.items || [];
  const shipped = items.filter((i) => i.status === "shipped");
  const openByMarker = new Map();
  const closedMarkers = new Set();

  for (const iss of issues) {
    if (iss.pull_request) continue;
    const id = extractMarkerId(iss.body);
    if (!id) continue;
    if (String(iss.state || "").toLowerCase() === "open") openByMarker.set(id, iss);
    else closedMarkers.add(id);
  }

  const active = items.filter((i) => openByMarker.has(i.id));
  const queued = items.filter(
    (i) =>
      i.status !== "shipped" &&
      !openByMarker.has(i.id) &&
      !closedMarkers.has(i.id),
  );
  const doneCount =
    shipped.length +
    [...closedMarkers].filter((id) => !shipped.some((s) => s.id === id)).length;
  const total = items.length || 1;
  const filled = Math.round((doneCount / total) * 20);
  const bar = "#".repeat(filled) + ".".repeat(Math.max(0, 20 - filled));

  const lines = [
    STATUS_MARKER,
    "# 🦞 Pinch Roadmap Status",
    "",
    `Progress: \`${bar}\` **${doneCount}/${items.length}** curated tasks completed.`,
    "",
  ];

  if (active.length) {
    lines.push(
      "## Open contributor queue",
      "",
      "| Issue | Task | Difficulty | Area labels |",
      "|---|---|---|---|",
    );
    for (const item of active) {
      const iss = openByMarker.get(item.id);
      const areas =
        (item.labels || []).filter((l) => l.startsWith("area/")).join(", ") ||
        "general";
      lines.push(
        `| #${iss.number} | ${item.title} | ${item.difficulty} | \`${areas}\` |`,
      );
    }
    lines.push("");
  } else {
    lines.push(
      "## Open contributor queue",
      "",
      "_No curated roadmap issues are currently open — `Contributor queue` replenishes automatically from `.github/roadmap.json`._",
      "",
    );
  }

  if (queued.length) {
    lines.push(
      "## Next queued tasks (auto-opened as open issues close)",
      "",
      "| ID | Title | Difficulty | Verify |",
      "|---|---|---|---|",
    );
    for (const item of queued.slice(0, 6)) {
      lines.push(
        `| \`${item.id}\` | ${item.title} | ${item.difficulty} | \`${item.verify || "npm run verify"}\` |`,
      );
    }
    lines.push("");
  }

  const drift = detectFileDrift(roadmap, repoRoot);
  const needsShippedUpdate = items.filter(
    (i) => i.status !== "shipped" && closedMarkers.has(i.id),
  );
  if (drift.length || needsShippedUpdate.length) {
    lines.push("## Drift & maintenance notes", "");
    for (const d of drift) lines.push(`- ⚠️ ${d}`);
    for (const item of needsShippedUpdate) {
      lines.push(
        `- ℹ️ \`${item.id}\` issue was closed; mark \`"status": "shipped"\` in \`.github/roadmap.json\` once released.`,
      );
    }
    lines.push("");
  }

  lines.push(
    "---",
    "<sub>Maintained in place by `roadmap-status-bot.yml` (edited in place — zero notification spam). Source of truth: `.github/roadmap.json` and `docs/CAPABILITIES.json`.</sub>",
  );
  return lines.join("\n") + "\n";
}

const AREA_RULES = [
  ["area/channels", /\b(telegram|discord|slack|whatsapp|channel|router|webhook|polling)\b/i],
  ["area/voice", /\b(voice|whisper|audio|transcri|tts|speech|mic)\b/i],
  ["area/memory", /\b(memory|session|store\.js|history|recall|remember|persona|export|rag)\b/i],
  ["area/mcp", /\b(mcp|json-rpc|stdio|registertool|plugin|third-party tool)\b/i],
  ["area/security", /\b(security|symlink|guard\.js|risk\.js|approval|confinement|rebind|injection|secret)\b/i],
  ["area/cli", /\b(cli|bin\/pinch|doctor|braincheck|setup\.js|npm pack|model switch)\b/i],
  ["area/docs", /\b(readme|docs\/|documentation|typo|guide\.md)\b/i],
];

export function classifyIssue(title, body) {
  const text = `${title || ""}\n${body || ""}`;
  const out = new Set();
  for (const [label, re] of AREA_RULES) {
    if (re.test(text)) out.add(label);
  }
  if (/\b(bug|crash|error|regression|broken|fails|exception)\b/i.test(text)) {
    out.add("type/bug");
  } else if (/\b(feat|feature|enhancement|support|proposal|allow)\b/i.test(text)) {
    out.add("type/feature");
  }
  return [...out];
}

export function labelsForChangedFiles(files, totalLines = 0) {
  const labels = new Set();
  for (const f of files) {
    if (f.startsWith("src/channels/") || f === "src/outbound.js") labels.add("area/channels");
    if (f === "src/server.js" || f === "public/index.html") labels.add("area/voice");
    if (
      f === "src/store.js" ||
      f === "src/prompt.js" ||
      f === "src/export.js" ||
      f === "src/sources.js"
    ) {
      labels.add("area/memory");
    }
    if (f === "src/mcp.js" || f === "src/tools.js") labels.add("area/mcp");
    if (f === "src/guard.js" || f === "src/risk.js" || f === "scripts/audit.js") {
      labels.add("area/security");
    }
    if (f === "bin/pinch.js" || f === "src/cli.js" || f === "scripts/setup.js") {
      labels.add("area/cli");
    }
    if (f.startsWith("docs/") || f.endsWith(".md")) labels.add("area/docs");
    if (f.startsWith(".github/")) labels.add("area/ci");
  }
  if (totalLines < 25) labels.add("size/XS");
  else if (totalLines < 100) labels.add("size/S");
  else if (totalLines < 300) labels.add("size/M");
  else if (totalLines < 600) labels.add("size/L");
  else labels.add("size/XL");
  return [...labels];
}

export function renderPrContext(roadmap, changedFiles, prBody = "") {
  const changed = new Set(changedFiles.filter(Boolean));
  const matches = [];
  for (const item of roadmap.items || []) {
    if (item.status === "shipped") continue;
    const hit = (item.files || []).filter((f) => changed.has(f));
    if (hit.length) matches.push({ item, hit });
  }
  const hasCloses = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+/i.test(prBody || "");
  const lines = [PR_MARKER, "### 🦞 Pinch PR Context"];
  if (!matches.length) {
    lines.push("", "No active `.github/roadmap.json` item directly matches the touched paths.");
  } else {
    lines.push("", "Matched curated roadmap task(s):", "");
    for (const { item, hit } of matches) {
      lines.push(
        `- **\`${item.id}\`** — ${item.title} (touched: ${hit.map((h) => `\`${h}\``).join(", ")})`,
      );
      lines.push(`  - Verify locally: \`${item.verify || "npm run verify"}\``);
    }
    if (!hasCloses) {
      lines.push(
        "",
        "> 💡 **Tip:** If this PR completes an open issue, add `Closes #<issue-number>` to the PR description so GitHub links it and the contributor queue automatically opens the next task on merge.",
      );
    }
  }
  lines.push("", "<sub>Single sticky comment updated in place on push.</sub>");
  return lines.join("\n") + "\n";
}

export function checkWorkflows(repoRoot = ROOT) {
  const dir = join(repoRoot, ".github/workflows");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
  const errors = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const ref = m[1];
      if (ref.startsWith("./")) continue;
      const parts = ref.split("@");
      if (parts.length !== 2 || !/^[0-9a-f]{40}$/.test(parts[1])) {
        errors.push(
          `${file}: action '${ref}' must be pinned to a 40-char commit SHA for OpenSSF Scorecard`,
        );
      }
    }
  }
  return { files: files.length, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "status") {
    const issuesFile = argValue(rest, "--issues-json") || argValue(rest, "--issues");
    const outFile = argValue(rest, "--out");
    const issues =
      issuesFile && existsSync(issuesFile)
        ? JSON.parse(readFileSync(issuesFile, "utf8"))
        : [];
    const md = renderStatusMarkdown(loadRoadmap(), issues);
    if (outFile) writeFileSync(outFile, md);
    else process.stdout.write(md);
  } else if (sub === "classify-issue") {
    const labels = classifyIssue(argValue(rest, "--title"), argValue(rest, "--body"));
    process.stdout.write(JSON.stringify(labels));
  } else if (sub === "pr-context") {
    const changedPath = argValue(rest, "--changed");
    const bodyPath = argValue(rest, "--body");
    const outFile = argValue(rest, "--out");
    const lines = Number(argValue(rest, "--lines", "0")) || 0;
    const files =
      changedPath && existsSync(changedPath)
        ? readFileSync(changedPath, "utf8").split(/\r?\n/).filter(Boolean)
        : [];
    const prBody = bodyPath && existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "";
    const md = renderPrContext(loadRoadmap(), files, prBody);
    const labels = labelsForChangedFiles(files, lines);
    if (outFile) writeFileSync(outFile, JSON.stringify({ comment: md, labels }, null, 2));
    else process.stdout.write(md);
  } else if (sub === "check-workflows") {
    const { files, errors } = checkWorkflows();
    if (errors.length) {
      for (const e of errors) console.error(`check-workflows: ${e}`);
      process.exit(1);
    }
    console.log(`check-workflows: ${files} workflow(s) SHA-pinned and clean`);
  } else {
    console.error(
      "Usage: node scripts/roadmap-bots.js <status|classify-issue|pr-context|check-workflows>",
    );
    process.exit(2);
  }
}
