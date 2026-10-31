#!/usr/bin/env node
/**
 * index.js — boot Pinch.
 *
 *   node src/index.js
 *
 * Starts the local web panel + API, then whatever chat channels are
 * configured. Everything else in the repo hangs off this file.
 */
import { config } from "./config.js";
import { createPinchServer, lanAddresses, status } from "./server.js";
import { startChannels } from "./channels/index.js";
import { brain } from "./brain.js";
import { ensureData, pendingReminders } from "./store.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startScheduler } from "./scheduler.js";
import { nodeSupport } from "./runtime.js";
import { startMcpTools } from "./mcp.js";
import { registerTool } from "./tools.js";

const c = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  teal: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
};

const log = {
  info: (m) => console.log(`${c.teal("●")} ${m}`),
  warn: (m) => console.log(`${c.gold("▲")} ${m}`),
  error: (m) => console.log(`\x1b[31m✖\x1b[0m ${m}`),
};

function banner() {
  console.log(
    c.coral(`
   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
      🦞  ${c.bold("P I N C H")}  ${c.dim("v1.0")}
   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`)
  );
  console.log(c.dim(`   your assistant · running locally · ${new Date().toLocaleString()}\n`));
}

async function main() {
  banner();
  ensureData();

  // ── brain ──────────────────────────────────────────────────────────────
  const probe = await brain.probe();
  const current = probe[config.llm.provider];
  if (config.llm.provider === "ollama") {
    if (current?.ok) {
      const has = (current.models || []).some((m) => m.startsWith(config.llm.ollamaModel.split(":")[0]));
      log.info(`brain: ollama at ${config.llm.ollamaUrl} · ${current.models.length} model(s)`);
      if (!current.models.includes(config.llm.ollamaModel)) {
        log.warn(
          `model "${config.llm.ollamaModel}" not pulled yet → ${c.bold(`ollama pull ${config.llm.ollamaModel}`)}` +
            (has ? "" : " (nothing similar installed either)")
        );
      }
    } else {
      log.warn(
        `brain: ollama unreachable at ${config.llm.ollamaUrl} — start it with ${c.bold("ollama serve")}, ` +
          `or set LLM_PROVIDER=mock to try the plumbing. Pinch still boots.`
      );
    }
  } else if (config.llm.provider === "openai") {
    log.info(`brain: ${config.llm.openaiBaseUrl} · ${config.llm.openaiModel}` + (config.llm.openaiKey ? "" : c.gold("  (no API key set!)")));
  } else {
    log.warn(`brain: ${config.llm.provider} — canned replies only. Good for a smoke test, bad for work.`);
  }

  // ── third-party tools (MCP) ────────────────────────────────────────────
  // Before the HTTP server starts, not after.
  //
  // Registering tools *after* listen() looked harmless and was not: /api/health
  // answered immediately, so a message sent in the first second of boot was
  // offered the built-in tools only and the model never learned the others
  // existed. Tools have to be settled before anything can ask for them.
  // A server that fails to start is skipped, not fatal.
  let mcp = { stop: async () => {} };
  if (config.mcpSpec) {
    mcp = await startMcpTools({ registerTool, log });
    if (mcp.registered.length) log.info(`mcp: ${mcp.registered.length} tool(s) from ${mcp.servers.length} server(s)`);
  }

  // ── http ───────────────────────────────────────────────────────────────
  // An assistant with a shell, bound to 0.0.0.0 and holding no key, is an open
  // shell on the LAN — the state a default install used to boot into.
  //
  // Refusing to start would break every existing install on upgrade, so the
  // default case narrows instead: no key and no deliberate host means we bind
  // loopback only and say exactly how to get the phone back. Someone who typed
  // PINCH_HOST=0.0.0.0 made a decision; they get a warning, not a veto.
  const isLoopback = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";
  let bindHost = config.host;
  if (!config.authKey && !isLoopback(config.host)) {
    if (config.hostExplicit) {
      console.log("");
      log.warn(`PINCH_KEY is empty and PINCH_HOST=${config.host} — anyone who can reach this machine can use Pinch.`);
      log.warn("Set PINCH_KEY, or set PINCH_HOST=127.0.0.1 to close it off.");
      console.log("");
    } else {
      bindHost = "127.0.0.1";
      console.log("");
      log.warn("No PINCH_KEY set, so Pinch is listening on localhost only.");
      log.warn(c.dim("   To reach it from your phone: npm run setup   (it generates a key)"));
      console.log("");
    }
  }

  const server = createPinchServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, bindHost, resolve);
  });

  const addrs = isLoopback(bindHost) ? [] : lanAddresses();
  console.log("");

  // ── runtime ────────────────────────────────────────────────────────────
  // Say it once per install, not on every boot. A warning you see forty times
  // a day is wallpaper; one you see once is information.
  const support = nodeSupport();
  if (support.message) {
    let shown = false;
    try {
      const marker = join(config.dataDir, `notice-node-${support.major}`);
      mkdirSync(config.dataDir, { recursive: true });
      // "wx" creates the file only if it is not there, so the write itself
      // answers "have I said this before?" — there is no check to race with.
      try {
        writeFileSync(marker, new Date().toISOString(), { flag: "wx" });
      } catch (err) {
        shown = err.code === "EEXIST";
      }
    } catch {
      shown = false; // unwritable data dir: better to repeat than to stay silent
    }
    if (!shown) log.warn(support.message);
  }
  log.info(`web panel: ${c.bold(`http://localhost:${config.port}`)}`);
  for (const addr of addrs) {
    // No fragment of the key is printed: terminal scrollback ends up in screen
    // shares, bug reports and CI logs. `pinch pair` shows the same URL as a QR
    // generated locally, which is the transfer channel that was intended.
    const suffix = config.authKey ? c.dim("  (needs your key — run `pinch pair` for a QR)") : "";
    console.log(`  ${c.dim("phone/Mac/PC on same Wi-Fi:")} ${c.bold(`http://${addr.address}:${config.port}`)}${suffix}`);
  }
  if (!config.authKey && !isLoopback(bindHost)) {
    log.warn("PINCH_KEY is empty — anyone on your network can use Pinch. Run `npm run setup` to set one.");
  }
  console.log("");

  // ── scheduler (reminders) ──────────────────────────────────────────────
  // Starts before the channels so a reminder that came due while Pinch was
  // off fires as soon as there is something to deliver it to.
  const scheduler = startScheduler(log);

  // ── channels ───────────────────────────────────────────────────────────
  const { status: channelStatus, stopAll } = await startChannels(log);
  Object.assign(status.channels, channelStatus);
  const on = Object.entries(channelStatus).filter(([, v]) => v === "on").map(([k]) => k);
  log.info(`channels live: ${on.join(", ") || "web only"}`);
  const pending = pendingReminders().length;
  if (pending) log.info(`reminders pending: ${pending}`);
  console.log(c.dim(`\n   workspace: ${config.workspaceRoots.join(", ")}`));
  console.log(c.dim(`   approvals: ${config.autoApprove ? "AUTO-APPROVE ON (risky)" : "ask in chat"}`));
  console.log(c.dim(`   data: ${config.dataDir}\n   ctrl-c to stop\n`));

  const shutdown = () => {
    console.log(c.dim("\n🦞 pinching out…"));
    scheduler.stop();
    stopAll();
    mcp.stop().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`\x1b[31mPinch failed to start:\x1b[0m ${err.message}`);
  process.exit(1);
});
