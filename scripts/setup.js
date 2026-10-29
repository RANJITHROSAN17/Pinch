#!/usr/bin/env node
/**
 * scripts/setup.js — the guided onboarding.
 *
 *   npm run setup          walk through everything, write .env, verify
 *   npm run doctor         just verify (same code, no prompts)
 *
 * Design rules:
 *  • never overwrite a value you already have — it is offered as the default;
 *  • verify tokens against the real API before saving, so you find out now
 *    rather than at 2am wondering why the bot is silent;
 *  • do not require anything. Every step is skippable; Pinch boots with an
 *    almost-empty .env;
 *  • no dependencies — plain readline.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");

/* ────────────────────────────── pretty output ──────────────────────────── */

const C = {
  coral: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  teal: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

const ok = (m) => console.log(`  ${C.green("✔")} ${m}`);
const no = (m) => console.log(`  ${C.red("✖")} ${m}`);
const warn = (m) => console.log(`  ${C.gold("▲")} ${m}`);
const hint = (m) => console.log(`    ${C.dim(m)}`);

function section(title, blurb) {
  console.log(`\n${C.coral("━".repeat(4))} ${C.bold(title)}`);
  if (blurb) console.log(C.dim(`   ${blurb}`));
  console.log("");
}

/* ─────────────────────────────── env parsing ───────────────────────────── */

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function renderEnv(values) {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";
  if (!example) {
    return Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  }
  // Keep the hand-written comments from .env.example, swap in real values.
  return example
    .split(/\r?\n/)
    .map((line) => {
      const m = /^([A-Z0-9_]+)=/.exec(line);
      if (!m) return line;
      const key = m[1];
      return key in values ? `${key}=${values[key]}` : line;
    })
    .join("\n");
}

/* ─────────────────────────────── prompting ─────────────────────────────── */

const rl = createInterface({ input: stdin, output: stdout });

// ── line queue ─────────────────────────────────────────────────────────────
// readline's own question() hangs forever (and Node exits 13) if stdin ends
// mid-prompt, and its 'close' fires before buffered lines are consumed when
// input is piped. A tiny queue fixes both: lines are delivered in order, and
// "no more input" is a normal value we can handle instead of a hang.
const EofError = Object.assign(new Error("input ended"), { code: "PINCH_EOF" });
const lineQueue = [];
const lineWaiters = [];
let inputEnded = false;

rl.on("line", (line) => {
  const waiter = lineWaiters.shift();
  if (waiter) waiter(line);
  else lineQueue.push(line);
});
rl.on("close", () => {
  inputEnded = true;
  while (lineWaiters.length) lineWaiters.shift()(null);
});

function nextLine() {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputEnded) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

async function question(text) {
  stdout.write(text);
  const line = await nextLine();
  if (line === null) throw EofError;
  return line;
}

async function ask(question_, fallback = "") {
  const suffix = fallback ? C.dim(` [${fallback}]`) : "";
  const answer = (await question(`  ${question_}${suffix} ${C.coral("›")} `)).trim();
  return answer || fallback;
}

async function confirm(question_, fallback = true) {
  const answer = (await question(`  ${question_} ${C.dim(`(${fallback ? "Y/n" : "y/N"})`)} ${C.coral("›")} `))
    .trim()
    .toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

async function choose(question_, options, fallbackIndex = 0) {
  console.log(`  ${question_}`);
  options.forEach((opt, i) => console.log(`    ${C.coral(String(i + 1))}. ${opt.label} ${C.dim(opt.hint || "")}`));
  const answer = (await question(`  ${C.dim(`[${fallbackIndex + 1}]`)} ${C.coral("›")} `)).trim();
  const index = answer ? Number(answer) - 1 : fallbackIndex;
  return options[index] && index >= 0 && index < options.length ? options[index] : options[fallbackIndex];
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

const digits = (s) => String(s || "").replace(/\D/g, "");

function lanUrl(port) {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) return `http://${addr.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

async function jsonFetch(url, options = {}, timeout = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

/* ─────────────────────────────── verification ──────────────────────────── */

async function checkOllama(url) {
  try {
    const { ok: good, body } = await jsonFetch(`${url}/api/tags`, {}, 4000);
    if (!good) return { ok: false, error: `HTTP ${body?.status || "error"}` };
    return { ok: true, models: (body.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

/**
 * Tokens get pasted from web pages, PDFs and chat apps, which is exactly how
 * quotes and stray spaces end up inside them. Checking the shape first is
 * better feedback, and it also means the only thing that ever reaches a
 * provider is a string that matches that provider's format — not whatever
 * happened to be on the line in .env.
 */
const TOKEN_SHAPE = {
  telegram: /^\d{6,12}:[A-Za-z0-9_-]{30,}$/,
  discord: /^[A-Za-z0-9._-]{50,}$/,
  slack: /^xox[abposr]-[A-Za-z0-9-]{10,}$/,
};

function shapeOf(kind, token) {
  const re = TOKEN_SHAPE[kind];
  if (!token) return "empty";
  if (re && !re.test(token)) return `${kind} token does not look like a ${kind} token (check for quotes or a missing character)`;
  return null;
}

async function checkTelegram(token) {
  const bad = shapeOf("telegram", token);
  if (bad) return { ok: false, error: bad };
  try {
    // The token is pasted from a browser and ends up in a URL path. Percent-
    // encode it so a stray "/", "?", "#" or space cannot reshape the request
    // to the provider — the shape regex above is a courtesy, this is the
    // actual confinement.
    const { body } = await jsonFetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`);
    if (!body?.ok) return { ok: false, error: body?.description || "invalid token" };
    return { ok: true, label: `@${body.result.username}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkDiscord(token) {
  const bad = shapeOf("discord", token);
  if (bad) return { ok: false, error: bad };
  try {
    const { ok: good, body } = await jsonFetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bot ${token}` },
    });
    if (!good) return { ok: false, error: body?.message || "invalid token" };
    return { ok: true, label: `${body.username}#${body.discriminator}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkSlack(token) {
  const bad = shapeOf("slack", token);
  if (bad) return { ok: false, error: bad };
  try {
    const { body } = await jsonFetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!body?.ok) return { ok: false, error: body?.error || "invalid token" };
    return { ok: true, label: `${body.user} @ ${body.team}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ──────────────────────────────── the wizard ───────────────────────────── */

async function setup() {
  const existing = parseEnvFile(ENV_PATH);
  const values = { ...existing };

  console.log(C.coral(`
   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
      🦞  ${C.bold("P I N C H")} ${C.dim("setup")}
   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀`));
  console.log(`
   Seven short steps. Everything is optional except your name and a brain.
   Press ${C.bold("Enter")} to accept the default shown in brackets.
   ${C.dim("Nothing is uploaded anywhere by this script.")}
`);

  /* 1 ─ identity ───────────────────────────────────────────────────────── */
  section("1/7 · Who am I working for?", "Just so Pinch knows what to call you.");
  values.OWNER_NAME = await ask("Your name", values.OWNER_NAME || "friend");
  const guessTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  values.OWNER_TIMEZONE = await ask("Timezone", values.OWNER_TIMEZONE || guessTz);

  /* 2 ─ brain ──────────────────────────────────────────────────────────── */
  section("2/7 · The brain", "The model that does the thinking. Local is private and free.");
  const provider = await choose(
    "How should Pinch think?",
    [
      { label: "Ollama (local)", hint: "— private, free, recommended" },
      { label: "OpenAI-compatible API", hint: "— OpenAI, Groq, LM Studio, vLLM, OpenRouter" },
      { label: "Mock brain", hint: "— no model, canned replies, just to try the plumbing" },
    ],
    values.LLM_PROVIDER === "openai" ? 1 : values.LLM_PROVIDER === "mock" ? 2 : 0
  );

  if (provider.label.startsWith("Ollama")) {
    values.LLM_PROVIDER = "ollama";
    values.OLLAMA_URL = await ask("Ollama URL", values.OLLAMA_URL || "http://127.0.0.1:11434");
    const probe = await checkOllama(values.OLLAMA_URL);
    if (probe.ok) {
      ok(`Ollama is running — ${probe.models.length} model(s) installed`);
      if (probe.models.length) hint(probe.models.slice(0, 6).join(", "));
      values.OLLAMA_MODEL = await ask(
        "Model",
        values.OLLAMA_MODEL || probe.models[0] || "qwen2.5-coder:7b"
      );
      if (!probe.models.includes(values.OLLAMA_MODEL)) {
        const pull = await confirm(`"${values.OLLAMA_MODEL}" is not installed. Pull it now? (~4GB)`, true);
        if (pull) {
          console.log(C.dim(`\n   streaming: ollama pull ${values.OLLAMA_MODEL}\n`));
          await new Promise((resolve) => {
            const child = spawn("ollama", ["pull", values.OLLAMA_MODEL], { stdio: "inherit" });
            child.on("error", () => {
              warn("could not run `ollama` — install it from https://ollama.com then run the pull yourself");
              resolve();
            });
            child.on("exit", resolve);
          });
        } else {
          hint(`later: ollama pull ${values.OLLAMA_MODEL}`);
        }
      }
    } else {
      warn(`Ollama is not reachable at ${values.OLLAMA_URL} (${probe.error})`);
      hint("Install: https://ollama.com  →  then run `ollama serve` in another terminal.");
      values.OLLAMA_MODEL = await ask("Model to use once it is running", values.OLLAMA_MODEL || "qwen2.5-coder:7b");
      hint(`nobody home yet — Pinch still boots, and will tell you clearly when the brain is down.`);
    }
  } else if (provider.label.startsWith("OpenAI")) {
    values.LLM_PROVIDER = "openai";
    values.OPENAI_BASE_URL = await ask("Base URL", values.OPENAI_BASE_URL || "https://api.openai.com/v1");
    values.OPENAI_KEY = values.OPENAI_KEY || values.OPENAI_API_KEY || "";
    const key = await ask("API key (stored only in .env)", values.OPENAI_KEY ? "•••• (keep)" : "");
    if (key && !key.includes("••••")) values.OPENAI_API_KEY = key;
    values.OPENAI_MODEL = await ask("Model", values.OPENAI_MODEL || "gpt-4o-mini");
    if (values.OPENAI_API_KEY) ok("key saved — Pinch will call this endpoint only when you talk to it");
    else warn("no key set — set OPENAI_API_KEY later or the brain will error");
  } else {
    values.LLM_PROVIDER = "mock";
    warn("mock brain selected: the plumbing works, the intelligence does not.");
  }

  /* 3 ─ workspace ──────────────────────────────────────────────────────── */
  section("3/7 · Where may Pinch work?", "Reading, writing and shell commands are confined to these folders.");
  hint(`current: ${values.PINCH_WORKSPACE || "(your home directory)"}`);
  const ws = await ask("Workspace root(s), comma separated", values.PINCH_WORKSPACE || "");
  if (ws) values.PINCH_WORKSPACE = ws;

  /* 4 ─ chat apps ──────────────────────────────────────────────────────── */
  section("4/7 · Chat apps", "Message Pinch from the apps you already use. Skip any you don't want.");

  // Telegram
  console.log(`\n  ${C.bold("Telegram")} ${C.dim("— easiest, ~2 minutes")}`);
  hint("1. Open Telegram, message @BotFather, send /newbot, pick a name");
  hint("2. Paste the token it gives you here");
  hint("3. Message @userinfobot to get your numeric id (locks the bot to you)");
  if (await confirm("Set up Telegram?", Boolean(values.TELEGRAM_TOKEN))) {
    const token = await ask("Bot token", values.TELEGRAM_TOKEN || "");
    if (token) {
      const result = await checkTelegram(token);
      if (result.ok) {
        ok(`token valid — bot is ${result.label}`);
        values.TELEGRAM_TOKEN = token;
        const ids = await ask("Your Telegram user id(s), comma separated", values.TELEGRAM_ALLOWED_IDS || "");
        values.TELEGRAM_ALLOWED_IDS = digits(ids) ? ids.replace(/[^\d,\s]/g, "") : "";
        if (!values.TELEGRAM_ALLOWED_IDS) {
          warn("no id set — the bot will refuse everyone and show them their id to add.");
        }
      } else {
        no(`token rejected: ${result.error}`);
        values.TELEGRAM_TOKEN = existing.TELEGRAM_TOKEN || "";
      }
    }
  }

  // Discord
  console.log(`\n  ${C.bold("Discord")} ${C.dim("— 5 minutes, needs one intent enabled")}`);
  hint("1. discord.com/developers/applications → New Application → Bot → Reset Token");
  hint("2. In the Bot tab, enable MESSAGE CONTENT INTENT (required)");
  hint("3. OAuth2 → URL Generator → scope `bot` → invite it to your server");
  hint("4. Right-click the channel → Copy Channel ID (enable Developer Mode in settings)");
  if (await confirm("Set up Discord?", Boolean(values.DISCORD_BOT_TOKEN))) {
    const token = await ask("Bot token", values.DISCORD_BOT_TOKEN || "");
    if (token) {
      const result = await checkDiscord(token);
      if (result.ok) {
        ok(`token valid — bot is ${result.label}`);
        values.DISCORD_BOT_TOKEN = token;
        values.DISCORD_CHANNEL_IDS = await ask(
          "Channel id(s) to watch, comma separated (blank = every channel it can see)",
          values.DISCORD_CHANNEL_IDS || ""
        );
        hint("if messages get ignored, MESSAGE CONTENT INTENT is almost always the reason");
      } else {
        no(`token rejected: ${result.error}`);
      }
    }
  }

  // Slack
  console.log(`\n  ${C.bold("Slack")} ${C.dim("— 5 minutes, workspace admin needed")}`);
  hint("api.slack.com/apps → From scratch → OAuth & Permissions → Bot token scopes:");
  hint("chat:write, channels:history, channels:read, users:read");
  hint("Install to workspace → copy the xoxb- token → invite the bot to a channel");
  if (await confirm("Set up Slack?", Boolean(values.SLACK_BOT_TOKEN))) {
    const token = await ask("Bot token (xoxb-…)", values.SLACK_BOT_TOKEN || "");
    if (token) {
      const result = await checkSlack(token);
      if (result.ok) {
        ok(`token valid — ${result.label}`);
        values.SLACK_BOT_TOKEN = token;
        values.SLACK_CHANNEL_IDS = await ask(
          "Channel id(s) to watch (C0123…), comma separated",
          values.SLACK_CHANNEL_IDS || ""
        );
      } else {
        no(`token rejected: ${result.error}`);
      }
    }
  }

  // WhatsApp
  console.log(`\n  ${C.bold("WhatsApp")} ${C.dim("— optional, read this")}`);
  warn("This uses the unofficial WhatsApp Web protocol (Baileys).");
  hint("· Automating a personal account breaks WhatsApp's Terms of Service.");
  hint("· Accounts do get banned for it. Use a SECONDARY number you can lose.");
  hint("· Your messages still pass through WhatsApp's servers, as always.");
  if (await confirm("Enable WhatsApp anyway?", values.WHATSAPP_ENABLED === "true")) {
    values.WHATSAPP_ENABLED = "true";
    values.WHATSAPP_ALLOWED_NUMBERS = await ask(
      "Allowed phone numbers with country code, comma separated (blank = ask on first message)",
      values.WHATSAPP_ALLOWED_NUMBERS || ""
    );
    if (!existsSync(join(ROOT, "node_modules", "@whiskeysockets"))) {
      if (await confirm("Install the WhatsApp bridge now? (npm install, ~40MB)", true)) {
        await new Promise((resolve) => {
          const child = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
          child.on("error", () => { warn("npm install failed — run it yourself later"); resolve(); });
          child.on("exit", resolve);
        });
      }
    }
  } else {
    values.WHATSAPP_ENABLED = "false";
  }

  /* 5 ─ about you ─────────────────────────────────────────────────────── */
  section("5/7 · Tell Pinch about you", "Written once, read every turn, never invented beyond.");
  hint("Like an about-me note. One fact per line, blank line to finish.");
  hint("Example: Name: Ranjith · City: Chennai · Work: ML engineer at Accenture");
  const existingProfile = join(ROOT, "data", "profile.md");
  const profileLines = [];
  // Read without an existsSync probe: ENOENT means "no profile yet", and there
  // is no check-then-use window for a race to slip through.
  let current = "";
  try {
    current = readFileSync(existingProfile, "utf8").trim();
  } catch {
    current = "";
  }
  if (current) {
    ok(`you already have a profile (${current.split("\n").length} line(s)) — press Enter to keep it`);
    hint(current.split("\n").slice(0, 3).join(" · ").slice(0, 150));
  }
  for (let i = 0; i < 6; i++) {
    const line = (await question(`  ${C.dim(i === 0 ? "fact" : "more (blank to stop)")} ${C.coral("›")} `)).trim();
    if (!line) break;
    profileLines.push(line);
  }
  if (profileLines.length) {
    // No existsSync gate: writeFileSync creates or truncates in one step, so
    // there is no window between "does it exist" and "write it".
    try {
      mkdirSync(dirname(existingProfile), { recursive: true });
      // Write-then-rename: the file you already have is either the old one or
      // the new one, never a half-written mixture (same trick store.js uses).
      const tmp = `${existingProfile}.${process.pid}.tmp`;
      writeFileSync(tmp, profileLines.join("\n") + "\n", "utf8");
      renameSync(tmp, existingProfile);
      ok(`saved ${profileLines.length} fact(s) to data/profile.md`);
    } catch (err) {
      warn(`could not write the profile: ${err.message}`);
    }
  }

  /* 6 ─ voice ──────────────────────────────────────────────────────────── */
  section("6/7 · Voice", "Talking to Pinch from your phone.");
  hint("The web panel has a mic button that uses your phone's own speech engine:");
  hint("· iPhone/iPad — Safari (iOS 14.5+), tap 🎙️, speak, it sends automatically");
  hint("· Android   — Chrome, tap 🎙️, speak, it sends automatically");
  hint("Replies can be spoken aloud with the 🔈 button in the header.");
  hint("Add the panel to your home screen for a full-screen, always-on feel.");
  const whisper = await ask(
    "Optional: whisper.cpp URL for transcribing voice notes sent in chat apps (blank to skip)",
    values.WHISPER_URL || ""
  );
  if (whisper) values.WHISPER_URL = whisper;

  /* 6 ─ security ──────────────────────────────────────────────────────── */
  section("7/7 · Locking it down", "Pinch listens on your LAN so your phone can reach it.");
  values.PINCH_PORT = await ask("Port", values.PINCH_PORT || "7777");
  values.PINCH_HOST = "0.0.0.0";
  if (!values.PINCH_KEY) values.PINCH_KEY = randomBytes(18).toString("hex");
  const keepKey = await confirm(
    `Keep the generated access key (${values.PINCH_KEY.slice(0, 6)}…)? Without one, anyone on your Wi-Fi can use Pinch.`,
    true
  );
  if (!keepKey) values.PINCH_KEY = "";

  const autoApprove = await confirm(
    "Let Pinch run shell commands and write files WITHOUT asking each time? (not recommended)",
    values.PINCH_AUTO_APPROVE === "true"
  );
  values.PINCH_AUTO_APPROVE = autoApprove ? "true" : "false";

  /* ── write ───────────────────────────────────────────────────────────── */
  // Copy rather than check-then-copy: if there is no .env, ENOENT tells us so
  // and there is nothing to back up. Same outcome, no race.
  try {
    const backup = `${ENV_PATH}.backup-${Date.now()}`;
    copyFileSync(ENV_PATH, backup);
    hint(`previous .env copied to ${backup.split("/").pop()}`);
  } catch (err) {
    if (err.code !== "ENOENT") hint(`could not back up the old .env: ${err.message}`);
  }
  writeFileSync(ENV_PATH, renderEnv(values), "utf8");
  console.log(`\n  ${C.green("✔")} wrote ${C.bold(".env")} (permissions: keep this file private)\n`);

  /* ── verify ──────────────────────────────────────────────────────────── */
  await doctor(values);
  rl.close();
}

/* ──────────────────────────────── doctor ───────────────────────────────── */

async function doctor(values = parseEnvFile(ENV_PATH)) {
  section("Verifying", "Actually calls each service — no guesses.");
  const port = values.PINCH_PORT || "7777";

  const rows = [];

  const provider = (values.LLM_PROVIDER || "ollama").toLowerCase();
  if (provider === "ollama") {
    const probe = await checkOllama(values.OLLAMA_URL || "http://127.0.0.1:11434");
    if (probe.ok) {
      const has = probe.models.includes(values.OLLAMA_MODEL);
      rows.push([
        has ? "ok" : "warn",
        `brain: ollama` + (has ? ` · ${values.OLLAMA_MODEL}` : ` running, but ${values.OLLAMA_MODEL} not pulled (ollama pull ${values.OLLAMA_MODEL})`),
      ]);
    } else {
      rows.push(["warn", `brain: ollama unreachable (${probe.error}) — start it with \`ollama serve\``]);
    }
  } else if (provider === "openai") {
    rows.push([values.OPENAI_API_KEY ? "ok" : "warn", `brain: ${values.OPENAI_BASE_URL} · ${values.OPENAI_MODEL}${values.OPENAI_API_KEY ? "" : " (no key)"}`]);
  } else {
    rows.push(["warn", "brain: mock (canned replies)"]);
  }

  if (values.TELEGRAM_TOKEN) {
    const result = await checkTelegram(values.TELEGRAM_TOKEN);
    rows.push([
      result.ok ? "ok" : "fail",
      result.ok
        ? `telegram: ${result.label}${values.TELEGRAM_ALLOWED_IDS ? "" : " — no ALLOWED_IDS set, bot will refuse everyone"}`
        : `telegram: ${result.error}`,
    ]);
  } else rows.push(["skip", "telegram: not configured"]);

  if (values.DISCORD_BOT_TOKEN) {
    const result = await checkDiscord(values.DISCORD_BOT_TOKEN);
    rows.push([
      result.ok ? "ok" : "fail",
      result.ok ? `discord: ${result.label}${values.DISCORD_CHANNEL_IDS ? ` · ${values.DISCORD_CHANNEL_IDS.split(",").length} channel(s)` : " · all channels"}` : `discord: ${result.error}`,
    ]);
  } else rows.push(["skip", "discord: not configured"]);

  if (values.SLACK_BOT_TOKEN) {
    const result = await checkSlack(values.SLACK_BOT_TOKEN);
    rows.push([
      result.ok ? "ok" : "fail",
      result.ok ? `slack: ${result.label}${values.SLACK_CHANNEL_IDS ? ` · ${values.SLACK_CHANNEL_IDS.split(",").length} channel(s)` : " · no channels set!"}` : `slack: ${result.error}`,
    ]);
  } else rows.push(["skip", "slack: not configured"]);

  rows.push([
    values.WHATSAPP_ENABLED === "true" ? "warn" : "skip",
    values.WHATSAPP_ENABLED === "true" ? "whatsapp: enabled (unofficial — use a secondary number)" : "whatsapp: disabled",
  ]);

  rows.push([values.PINCH_KEY ? "ok" : "warn", values.PINCH_KEY ? "access key: set" : "access key: EMPTY — anyone on your network can use Pinch"]);
  rows.push([values.PINCH_AUTO_APPROVE === "true" ? "warn" : "ok", values.PINCH_AUTO_APPROVE === "true" ? "approvals: AUTO (pinch can act without asking)" : "approvals: ask in chat"]);

  const paint = { ok: C.green("✔"), warn: C.gold("▲"), fail: C.red("✖"), skip: C.dim("·") };
  for (const [level, message] of rows) console.log(`  ${paint[level]} ${message}`);

  const url = lanUrl(port);
  console.log(`
${C.coral("━".repeat(4))} ${C.bold("Ready")}

   ${C.bold("npm start")}   ${C.dim("or: node src/index.js")}

   panel on this machine   ${C.bold(`http://localhost:${port}`)}${values.PINCH_KEY ? `?key=${values.PINCH_KEY}` : ""}
   panel from your phone   ${C.bold(url)}${values.PINCH_KEY ? `?key=${values.PINCH_KEY}` : ""}

   ${C.dim("Open the phone link once on each device — the key is remembered in a cookie.")}
   ${C.dim("Then: Add to Home Screen, tap 🎙️, and just talk.")}
`);
  return rows;
}

/* ───────────────────────────────── main ────────────────────────────────── */

process.on("SIGINT", () => {
  console.log(`\n\n  ${C.gold("▲")} Interrupted — nothing was written.\n`);
  process.exit(0);
});

const args = process.argv.slice(2);
try {
  if (args.includes("--check") || args.includes("--doctor")) {
    if (!existsSync(ENV_PATH)) {
      console.log(`\n  ${C.gold("▲")} No .env yet. Run ${C.bold("npm run setup")} first.\n`);
      process.exit(0);
    }
    await doctor();
    rl.close();
    process.exit(0);
  }
  await setup();
  process.exit(0);
} catch (err) {
  if (err?.code === "PINCH_EOF") {
    console.log(`\n  ${C.gold("▲")} Input ended before setup finished — ${C.bold("nothing was written")}.`);
    console.log(`    Re-run ${C.bold("npm run setup")} when you are ready.\n`);
    process.exit(0);
  }
  console.error(`\n${C.red("setup failed:")} ${err.message}\n`);
  process.exit(1);
}
