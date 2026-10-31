#!/usr/bin/env node
/**
 * bin/pinch.js — the one command you type.
 *
 *   pinch              start the assistant (panel + chat apps)
 *   pinch setup        guided onboarding: brain, channels, voice, key
 *   pinch doctor       check what is configured and what is broken
 *   pinch ask "..."    one-shot question in the terminal
 *   pinch chat         terminal chat session (no browser)
 *   pinch pair         print the URL + QR for your phone
 *   pinch brain-test   measure the model and check it can call tools
 * *   pinch service      autostart snippet for systemd / launchd / Task Scheduler
 *   pinch supervise    restart-on-crash wrapper (any OS)
 *   pinch audit        run the adversarial self-check against this install
 *   pinch radar        what has drifted: runtime, CI, pinned actions
 *   pinch export       everything Pinch knows, in one portable JSON file
 *   pinch cost         token spend for the last 30 days, from telemetry
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [command = "start", ...rest] = process.argv.slice(2);

const c = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function usage() {
  console.log(`
${c.coral("🦞 pinch")} — local, private, yours

  ${c.bold("pinch")}                 start Pinch (web panel + configured chat apps)
  ${c.bold("pinch setup")}           guided setup — brain, Telegram, Discord, Slack, WhatsApp, voice
  ${c.bold("pinch doctor")}          verify configuration and connectivity
  ${c.bold("pinch chat")}            chat in the terminal
  ${c.bold("pinch ask")} "question"  one-shot answer
  ${c.bold("pinch pair")}            print a QR + URL to open Pinch on your phone
  ${c.bold("pinch brain-test")}      measure model speed and tool-calling support
  ${c.bold("pinch service")}         autostart config for systemd / launchd / Windows
  ${c.bold("pinch supervise")}       restart Pinch automatically if it ever crashes
  ${c.bold("pinch audit")}           run the adversarial self-check against this install
  ${c.bold("pinch radar")}           what has drifted: runtime, CI, pinned actions
  ${c.bold("pinch growth")}          what to build next, measured from this checkout
  ${c.bold("pinch export")}          write everything Pinch knows to one JSON file
  ${c.bold("pinch cost")}            what the last 30 days of turns would have cost

Everything is configured in .env — no accounts, no cloud, no telemetry.
`);
}

function run(script, args = []) {
  const child = spawn(process.execPath, [join(root, script), ...args], {
    stdio: "inherit",
    cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

switch (command) {
  case "start":
  case "serve":
    run("src/index.js");
    break;
  case "audit":
    run("scripts/audit.js", rest);
    break;
  case "growth":
    run("scripts/growth.js", rest);
    break;
  case "radar":
    run("scripts/tech-radar.js", rest);
    break;
  case "setup":
    run("scripts/setup.js");
    break;
  case "doctor":
  case "check":
    run("scripts/setup.js", ["--check"]);
    break;
  case "chat":
    run("src/cli.js", ["chat"]);
    break;
  case "pair":
    run("scripts/pair.js");
    break;
  case "brain-test":
  case "braintest":
    run("scripts/braincheck.js");
    break;
  case "service":
    run("scripts/service.js", rest);
    break;
  case "supervise":
  case "daemon":
    run("scripts/supervise.js");
    break;
  case "ask": {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error("Usage: pinch ask \"your question\"");
      process.exit(1);
    }
    run("src/cli.js", ["ask", text]);
    break;
  }
  case "-v":
  case "--version":
    console.log(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    break;
  case "export": {
    const outIdx = rest.indexOf("--out");
    const out = outIdx >= 0 ? rest[outIdx + 1] : null;
    const includeTelemetry = rest.includes("--include-telemetry");
    if (rest.includes("--help")) {
      console.log(`\n  pinch export [--out FILE] [--include-telemetry]\n
  Writes sessions, memory, reminders and schedules as one JSON document.
  Default is stdout, so:  pinch export > backup.json
  --out FILE           write to a file (mode 0600) instead
  --include-telemetry  also include the per-turn timing log
  .env is never included: keys are not part of your data dump.\n`);
      process.exit(0);
    }
    const { writeExport, describeExport } = await import("../src/export.js");
    const res = writeExport({ path: out, includeTelemetry });
    if (res.path) {
      console.error(describeExport(res));
    } else {
      process.stdout.write(res.json);
      console.error(`\n${describeExport(res)}\n`);
    }
    process.exit(0);
  }

  case "cost": {
    const { costReport } = await import("../src/cost.js");
    console.log(costReport({ days: Number(rest[0]) || 30, json: rest.includes("--json") }));
    process.exit(0);
  }

  case "help":
  case "-h":
  case "--help":
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
