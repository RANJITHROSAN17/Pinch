#!/usr/bin/env node
/**
 * bin/pinch.js — the one command you type.
 *
 *   pinch              start the assistant (panel + chat apps)
 *   pinch setup        guided onboarding: brain, channels, voice, key
 *   pinch doctor       check what is configured and what is broken
 *   pinch ask "..."    one-shot question in the terminal
 *   pinch chat         terminal chat session (no browser)
 */
import { spawn } from "node:child_process";
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
  case "ask": {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error("Usage: pinch ask \"your question\"");
      process.exit(1);
    }
    run("src/cli.js", ["ask", text]);
    break;
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
