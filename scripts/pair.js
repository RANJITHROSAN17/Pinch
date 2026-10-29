#!/usr/bin/env node
/**
 * scripts/pair.js — "pinch pair"
 *
 * Prints the exact URL to open on your phone, as a QR code when the optional
 * qrcode-terminal package is installed. The QR is generated locally; the key
 * never goes to a third-party QR service (which would be a comical way to leak
 * the secret that protects your machine).
 */
import { networkInterfaces } from "node:os";
import { loadEnv } from "../src/config.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv(ROOT);
const port = env.PINCH_PORT || "7777";
const key = env.PINCH_KEY || "";

const C = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
};

function addresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

const lan = addresses();
const url = `http://${lan[0] || "localhost"}:${port}${key ? `?key=${key}` : ""}`;

console.log(`
${C.coral("🦞  Pair your phone")}

   1. Phone and this machine must be on the same Wi-Fi.
   2. Scan this, or type the URL. The key is remembered in a cookie.
   3. Share → Add to Home Screen. Then tap 🎙️ and talk.
`);

let qrcode = null;
try {
  qrcode = (await import("qrcode-terminal")).default;
} catch {
  // optional dependency; fall through to the URL
}

if (qrcode) {
  qrcode.generate(url, { small: true });
} else {
  console.log(C.dim("   (install `qrcode-terminal` for a scannable QR: npm i qrcode-terminal)\n"));
}

console.log(`   ${C.bold(url)}\n`);
for (const addr of lan.slice(1)) {
  console.log(C.dim(`   also: http://${addr}:${port}${key ? `?key=${key}` : ""}`));
}

if (!key) {
  console.log(`\n   ${C.gold("▲")} No PINCH_KEY set — anyone on this network can use Pinch.`);
  console.log(C.dim("     Run `npm run setup` (or set PINCH_KEY in .env) before opening it on a shared network.\n"));
}
if (!existsSync(join(ROOT, ".env"))) {
  console.log(`   ${C.gold("▲")} No .env yet — run \`npm run setup\` first.\n`);
}
console.log(C.dim("   Start Pinch with `npm start`, then open the URL on your phone.\n"));
