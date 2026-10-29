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
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { remember, loadMemory, forget, loadTasks, saveTask } from "./store.js";

/* ───────────────────────────── path sandboxing ─────────────────────────── */

export class SafePathError extends Error {}

export function resolveInWorkspace(input) {
  const raw = String(input || ".").replace(/^~(?=$|\/)/, homedir());
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(config.workspaceRoots[0], raw);
  const inside = config.workspaceRoots.some((root) => {
    const rel = relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!inside) {
    throw new SafePathError(
      `Blocked: ${abs} is outside the allowed workspace (${config.workspaceRoots.join(", ")}).` +
        ` Add it to PINCH_WORKSPACE in .env if that is a mistake.`
    );
  }
  return abs;
}

/* ─────────────────────────── catastrophic command guard ────────────────── */

const DENY = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\/\s*$/, why: "recursive delete of the filesystem root" },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~)\s*(\*)?\s*$/, why: "recursive delete of / or ~" },
  { re: /\bmkfs(\.\w+)?\b/, why: "formatting a filesystem" },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/, why: "raw write to a block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: "raw write to a block device" },
  { re: /\bchmod\s+-R\s+777\s+\/\s*$/, why: "unlocking permissions on the whole filesystem" },
];

export function screenCommand(command) {
  const flat = String(command).replace(/\s+/g, " ").trim();
  for (const rule of DENY) {
    if (rule.re.test(flat)) return { allowed: false, reason: rule.why };
  }
  return { allowed: true };
}

/* ────────────────────────────── shell runner ───────────────────────────── */

export function runShell(command, { cwd, timeoutMs = config.shellTimeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      cwd: cwd && !isAbsolute(cwd) ? resolve(config.workspaceRoots[0], cwd) : cwd || config.workspaceRoots[0],
      env: { ...process.env, PINCH: "1" },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
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

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", ".cache", "target", "coverage", ".idea", ".DS_Store",
]);

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
    entries = entries
      .filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") === false || true)
      .filter((e) => !SKIP_DIRS.has(e.name))
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

/* ──────────────────────────────── tool defs ────────────────────────────── */

const stringProp = (description) => ({ type: "string", description });

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
    async run({ path, start_line, lines }) {
      const abs = resolveInWorkspace(path);
      const text = await readFile(abs, "utf8");
      const all = text.split("\n");
      const from = Math.max(0, (start_line || 1) - 1);
      const count = lines || 400;
      const slice = all.slice(from, from + count);
      const header = `${relative(config.workspaceRoots[0], abs) || abs} · lines ${from + 1}-${from + slice.length} of ${all.length}`;
      return { ok: true, output: `${header}\n\n${slice.join("\n")}` };
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
      const re = new RegExp(pattern, "i");
      const hits = [];
      async function walk(dir) {
        if (hits.length >= 60) return;
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (hits.length >= 60) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) await walk(full);
          } else if (entry.isFile()) {
            if (glob && !entry.name.endsWith(`.${glob.replace(/^\./, "")}`)) continue;
            if (glob === undefined && /\.(png|jpe?g|gif|zip|pdf|mp4|mp3|woff2?|ico|lock)$/i.test(entry.name)) continue;
            let text;
            try {
              const info = await stat(full);
              if (info.size > 400_000) continue;
              text = await readFile(full, "utf8");
            } catch {
              continue;
            }
            if (!text.includes("\u0000")) {
              text.split("\n").forEach((line, i) => {
                if (hits.length < 60 && re.test(line)) {
                  hits.push(`${relative(config.workspaceRoots[0], full)}:${i + 1}: ${line.trim().slice(0, 180)}`);
                }
              });
            }
          }
        }
      }
      await walk(abs);
      return { ok: true, output: hits.join("\n") || "No matches." };
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
      return { ok: true, output: `${expression} = ${calculate(expression)}` };
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
    async run({ query }) {
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
          const decode = (s) =>
            s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
          const rawUrl = m[1];
          const clean = rawUrl.includes("uddg=")
            ? decodeURIComponent(rawUrl.split("uddg=")[1].split("&")[0])
            : rawUrl;
          results.push(`${results.length + 1}. ${decode(m[2])}\n   ${clean}\n   ${decode(m[3]).slice(0, 220)}`);
        }
        return { ok: results.length > 0, output: results.join("\n\n") || "No results (or the network is unavailable)." };
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
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool schemas in the shape both Ollama and OpenAI accept. */
export function toolSchemas() {
  return TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export const DANGEROUS = new Set(TOOLS.filter((t) => t.dangerous).map((t) => t.name));
