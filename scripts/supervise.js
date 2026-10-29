#!/usr/bin/env node
/**
 * scripts/supervise.js — "pinch supervise"
 *
 * Keeps Pinch alive: if the process exits for any reason other than a clean
 * SIGINT, it restarts after a short backoff. This is the poor-man's service
 * for people who do not want to learn systemd, and it behaves the same on
 * every OS. Use `pinch service` for a real init integration.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let backoff = 1000;
let stopping = false;

const stamp = () => new Date().toISOString().slice(11, 19);
console.log(`\x1b[38;5;209m🦞 supervisor\x1b[0m  starting pinch (ctrl-c to stop both)\n`);

function start() {
  const child = spawn(process.execPath, [join(ROOT, "src", "index.js")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (stopping) process.exit(0);
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`\x1b[38;5;214m▲\x1b[0m [${stamp()}] pinch exited (${reason}) — restarting in ${backoff / 1000}s`);
    setTimeout(() => {
      start();
      backoff = Math.min(backoff * 2, 30000); // never hammer, never give up
    }, backoff);
  });

  // A healthy start resets the backoff after 30 s of uptime.
  setTimeout(() => {
    backoff = 1000;
  }, 30000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    process.exit(0);
  });
}

start();
