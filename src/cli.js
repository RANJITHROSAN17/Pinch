#!/usr/bin/env node
/**
 * cli.js — use Pinch without a browser.
 *
 *   node src/cli.js ask "explain this stack trace"
 *   node src/cli.js chat
 *
 * Same agent, same memory, same approval flow — just a terminal.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runAgent, answerApprovalByChannel, pendingApprovals } from "./agent.js";

const C = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  teal: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
};

function render(event) {
  if (event.type === "status") process.stdout.write(C.dim(`  ${event.message}…\r`));
  else if (event.type === "tool") process.stdout.write(`${C.gold("  🔧")} ${C.dim(`${event.name}: ${event.label}`)}\n`);
  else if (event.type === "tool_done") {
    const icon = event.ok ? C.teal("  ✓") : "\x1b[31m  ✕\x1b[0m";
    process.stdout.write(`${icon} ${C.dim(String(event.preview).split("\n")[0].slice(0, 100))}\n`);
  } else if (event.type === "approval") {
    process.stdout.write(`\n  ${C.gold("🦞 permission:")} ${event.description}\n  ${C.dim("allow? [y/N] ")}`);
  }
}

async function turn(rl, text, sessionId) {
  // A y/n answer resolves a pending prompt instead of starting a new turn.
  if (pendingApprovals("cli").length && /^(y|yes|n|no)$/i.test(text.trim())) {
    answerApprovalByChannel("cli", /^y/i.test(text.trim()));
    return;
  }
  process.stdout.write("\n");
  const result = await runAgent({
    sessionId,
    text,
    channel: "cli",
    onEvent: render,
  });
  process.stdout.write(`\n${C.coral("🦞")} ${result.text}\n\n`);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const rl = createInterface({ input: stdin, output: stdout });

  if (mode === "ask") {
    const question = rest.join(" ").trim();
    if (!question) {
      console.error('usage: node src/cli.js ask "your question"');
      process.exit(1);
    }
    await turn(rl, question, `cli-${new Date().toISOString().slice(0, 10)}`);
    rl.close();
    return;
  }

  const sessionId = `cli-${new Date().toISOString().slice(0, 10)}`;
  console.log(`
${C.coral("🦞 Pinch")} ${C.dim("— terminal mode. /help for commands, /exit to leave.")}
`);
  while (true) {
    const text = (await rl.question(C.coral("you › "))).trim();
    if (!text) continue;
    if (["/exit", "/quit", "exit", "quit"].includes(text)) break;
    if (text === "/help") {
      console.log(`
  /exit   leave
  /help   this
  /status show what is waiting for approval
  anything else is sent to Pinch.
`);
      continue;
    }
    if (text === "/status") {
      console.log(`  pending approvals: ${pendingApprovals("cli").length}`);
      continue;
    }
    await turn(rl, text, sessionId);
  }
  rl.close();
}

main().catch((err) => {
  console.error(`\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});
