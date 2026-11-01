/**
 * custom-tools.js — add your own tools without editing src/tools.js.
 *
 * The gap this closes: `registerTool()` could put a tool in the registry, but the
 * only ways to reach it were editing this repository or shipping an MCP server.
 * MCP is the right answer for someone else's tools. It is a heavy answer for the
 * one command you already run by hand every morning.
 *
 * A manifest is JSON. Pinch never `import()`s, `eval()`s or otherwise executes a
 * manifest — it reads a command *you* wrote, gives it a name and a description,
 * and lets the model fill in arguments you declared. So the trust boundary is:
 * you author the command, the model supplies data, and a human approves every
 * call. Nothing in the file can widen that.
 *
 * Five rules, and the reason each one exists:
 *
 * 1. **`shell: false`.** Arguments go to the program as an argv array. A
 *    model-supplied value of `; rm -rf ~` is one literal argument, not a shell.
 * 2. **The executable is resolved once, at load.** `git` becomes `/usr/bin/git`
 *    and stays that, so a PATH change or a same-named file in the working
 *    directory cannot hi-jack it later.
 * 3. **No tool runs an executable inside the workspace.** The model can write to
 *    the workspace. If a tool's binary lives there, the model can replace the
 *    binary — so that combination is refused at load, not at call time.
 * 4. **A placeholder is data, never a flag.** A value starting with `-` is
 *    rejected unless the parameter says `allowLeadingDash`, because otherwise
 *    `grep {{term}}` becomes `grep --include=…` at the model's discretion.
 * 5. **Always dangerous.** There is no `trusted` field in this format, on
 *    purpose. MCP lets you trust a server because you can read its source; here
 *    the *arguments* come from the model, so no manifest can opt out of the
 *    approval gate.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { childEnv } from "./tools.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const MAX_TOOLS = 32;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 4096;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 12_000; // same budget as the shell tool

/** A manifest entry was unusable. Carries the entry name so the log can name it. */
class ManifestError extends Error {}

/* ────────────────────────────── resolution ─────────────────────────────── */

/**
 * Find the absolute path of `command`, the way a shell would, but once.
 *
 * `spawn()` with a bare name searches PATH at call time. That is a small window
 * we do not need: resolving here means the tool's identity is settled before the
 * model can say anything, and the boot log can print exactly what will run.
 */
export function resolveExecutable(command, { path = process.env.PATH || "" } = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new ManifestError("command must be a non-empty string");
  }
  const raw = command.trim();

  if (raw.includes("/")) {
    const abs = isAbsolute(raw) ? raw : resolve(raw);
    if (!existsSync(abs)) throw new ManifestError(`command "${raw}" does not exist at ${abs}`);
    return abs;
  }

  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = resolve(dir, raw);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new ManifestError(`command "${raw}" was not found on PATH`);
}

/**
 * Refuse an executable the model could overwrite.
 *
 * The workspace is the one tree the agent may write to. A tool that executes a
 * file from there is a tool the model can redefine mid-conversation, which makes
 * the manifest's guarantees meaningless.
 */
function assertOutsideWorkspace(exePath, workspaceRoots) {
  for (const root of workspaceRoots || []) {
    const prefix = resolve(root);
    if (exePath === prefix || exePath.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)) {
      throw new ManifestError(
        `executable ${exePath} is inside the workspace (${prefix}), which the agent can write to. ` +
          "Move it outside PINCH_WORKSPACE, or the model could replace it between calls.",
      );
    }
  }
}

/* ─────────────────────────────── validation ────────────────────────────── */

function asString(value, field, name) {
  if (typeof value !== "string") throw new ManifestError(`"${field}" must be a string (tool "${name}")`);
  return value;
}

function parseParameters(raw, name) {
  if (raw === undefined) return { properties: {}, specs: {}, required: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError(`"parameters" must be an object (tool "${name}")`);
  }

  const properties = {};
  const specs = {};
  const required = [];
  const entries = Object.entries(raw);

  if (entries.length > MAX_ARGS) {
    throw new ManifestError(`tool "${name}" declares more than ${MAX_ARGS} parameters`);
  }

  for (const [key, spec] of entries) {
    if (!NAME_RE.test(key)) {
      throw new ManifestError(`parameter "${key}" in tool "${name}" must be letters, digits, dash or underscore`);
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new ManifestError(`parameter "${key}" in tool "${name}" must be an object`);
    }
    const type = spec.type === undefined ? "string" : String(spec.type);
    if (type !== "string") {
      // Deliberately narrow. A number or boolean would need its own quoting rules
      // and would buy almost nothing; a user who needs one can accept a string and
      // let their program parse it.
      throw new ManifestError(`parameter "${key}" in tool "${name}" must have type "string"`);
    }
    // Two views of the same parameter. `properties` is what the model is shown;
    // `specs` keeps the manifest-only flags (`allowLeadingDash`) out of the schema,
    // because a model that can see a switch will try to reason about it.
    properties[key] = {
      type: "string",
      description: typeof spec.description === "string" ? spec.description : key,
    };
    specs[key] = { allowLeadingDash: spec.allowLeadingDash === true };
    if (spec.required === true) required.push(key);
  }

  return { properties, required, specs };
}

/**
 * Build the argv for one call.
 *
 * Substitution is textual inside a single token, so `--dir={{d}}` works, and the
 * result is always exactly one argument. Unknown keys are a hard error rather
 * than being ignored: a model that passes `{"rm": "-rf"}` to a tool that never
 * declared it should be told the truth, not silently have it dropped.
 */
export function buildArgs(entry, args = {}) {
  const declared = Object.keys(entry.parameters?.properties || {});
  for (const key of Object.keys(args || {})) {
    if (!declared.includes(key)) {
      throw new ManifestError(`tool "${entry.name}" has no parameter "${key}" (declared: ${declared.join(", ") || "none"})`);
    }
  }

  const values = {};
  for (const key of declared) {
    const raw = args?.[key];
    if (raw === undefined || raw === null) {
      if ((entry.parameters.required || []).includes(key)) {
        throw new ManifestError(`tool "${entry.name}" needs parameter "${key}"`);
      }
      values[key] = "";
      continue;
    }
    const value = String(raw);
    if (value.includes("\0")) throw new ManifestError(`parameter "${key}" contains a NUL byte`);
    if (value.length > MAX_ARG_CHARS) {
      throw new ManifestError(`parameter "${key}" is longer than ${MAX_ARG_CHARS} characters`);
    }
    const allowsDash = entry.parameters.specs?.[key]?.allowLeadingDash === true;
    if (value.startsWith("-") && !allowsDash) {
      throw new ManifestError(
        `parameter "${key}" starts with "-", which would be read as a flag by the program. ` +
          `Declare "allowLeadingDash": true for it in the manifest if that is what you want.`,
      );
    }
    values[key] = value;
  }

  return entry.args.map((token) =>
    String(token).replace(PLACEHOLDER_RE, (whole, key) => (key in values ? values[key] : whole)),
  );
}

/* ────────────────────────────────  loading ─────────────────────────────── */

function readManifest(path) {
  if (!existsSync(path)) throw new ManifestError(`manifest not found at ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ManifestError(`manifest is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManifestError("manifest must be a JSON object");
  }
  const tools = parsed.tools;
  if (!Array.isArray(tools)) throw new ManifestError('manifest needs a "tools" array');
  if (tools.length > MAX_TOOLS) throw new ManifestError(`manifest declares more than ${MAX_TOOLS} tools`);
  return tools;
}

/**
 * Turn one manifest entry into a Pinch tool.
 *
 * Throws `ManifestError` for anything unusable; the caller logs and skips, the
 * same way a failing MCP server is skipped rather than stopping the boot.
 */
export function toTool(raw, { workspaceRoots = [], env = process.env } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("each entry in \"tools\" must be an object");
  }
  const name = asString(raw.name, "name", "?");
  if (!NAME_RE.test(name)) {
    throw new ManifestError(`"${name}" must be letters, digits, dash or underscore (max 64)`);
  }
  const description = asString(raw.description, "description", name);
  if (description.trim().length < 8) {
    throw new ManifestError(`tool "${name}" needs a description the model can read`);
  }

  const exe = resolveExecutable(asString(raw.command, "command", name), { path: env.PATH });
  assertOutsideWorkspace(exe, workspaceRoots);

  if (!Array.isArray(raw.args)) throw new ManifestError(`tool "${name}" needs an "args" array`);
  if (raw.args.length > MAX_ARGS) throw new ManifestError(`tool "${name}" has more than ${MAX_ARGS} arguments`);
  for (const token of raw.args) {
    if (typeof token !== "string") throw new ManifestError(`every entry in "args" for "${name}" must be a string`);
  }
  for (const token of raw.args.join(" ").matchAll(PLACEHOLDER_RE)) {
    // A placeholder in the args with no matching parameter would be passed to the
    // program literally, which looks like it worked and did something else.
    if (!(token[1] in (raw.parameters || {}))) {
      throw new ManifestError(`tool "${name}" uses {{${token[1]}}} in args but declares no such parameter`);
    }
  }

  const parameters = parseParameters(raw.parameters, name);
  const timeoutMs = Math.min(Number(raw.timeout_ms) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const entry = { name, args: raw.args, parameters };

  return {
    name,
    // `dangerous` is set by the caller and cannot come from the file.
    description,
    parameters: { type: "object", properties: parameters.properties, required: parameters.required },
    async run(args) {
      let argv;
      try {
        argv = buildArgs(entry, args || {});
      } catch (err) {
        return { ok: false, output: err.message };
      }
      const res = await run(argv, { exe, timeoutMs });
      const parts = [];
      if (res.stdout.trim()) parts.push(res.stdout.trim());
      if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trim()}`);
      if (res.killed) parts.push(`(timed out after ${Math.round(timeoutMs / 1000)}s and was killed)`);
      const body = parts.join("\n\n").slice(0, MAX_OUTPUT) || "(no output)";
      // A command's stdout is exactly as trustworthy as a web page: it can carry
      // text that reads like an instruction. Wrapped the same way MCP results are.
      return {
        ok: res.ok,
        code: res.code,
        output: `<untrusted-source tool="${name}">\n${body}\n</untrusted-source>`,
      };
    },
  };
}

function run(argv, { exe, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, argv, {
      shell: false,
      detached: process.platform !== "win32",
      cwd: undefined,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const cap = (chunk) => chunk.slice(0, MAX_OUTPUT);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += cap(String(d));
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += cap(String(d));
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, stdout, stderr: `${stderr}${err.message}`, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code, stdout, stderr, killed });
    });
  });
}

/**
 * Read `path`, register every usable tool, and report what happened.
 *
 * Mirrors `startMcpTools`: nothing here is fatal. A manifest that cannot be read,
 * or an entry that is wrong, is logged with the reason and skipped — an assistant
 * that refuses to boot because of a typo in one optional file is worse than one
 * that boots with 3 of 4 tools and says so.
 */
export async function startCustomTools({ registerTool, path, workspaceRoots = [], log = console } = {}) {
  const result = { registered: [], skipped: [], path: path || "" };
  if (!path) return result;

  let raw;
  try {
    raw = readManifest(path);
  } catch (err) {
    log?.warn?.(`custom tools: ${err.message} — continuing without them`);
    result.skipped.push({ name: "<manifest>", reason: err.message });
    return result;
  }

  for (const item of raw) {
    let tool;
    try {
      tool = toTool(item, { workspaceRoots });
      registerTool(tool, { dangerous: true });
    } catch (err) {
      const label = typeof item?.name === "string" ? item.name : "<unnamed>";
      // The register path throws its own errors (a name collision with a built-in,
      // for example). Either way the entry is reported, never silently dropped.
      log?.warn?.(`custom tools: skipped "${label}": ${err.message}`);
      result.skipped.push({ name: label, reason: err.message });
      continue;
    }
    result.registered.push(tool.name);
  }

  return result;
}
