/**
 * risk.js — which shell commands may run without asking.
 *
 * The problem this solves is named in docs/AUDIT.md: approval fatigue. When
 * `ls` costs the same attention as `rm -rf`, a person answers both on reflex,
 * and the gate stops being a gate. Measured across 14 comparable assistants,
 * the ones that solved it did it with tiers (zeroclaw: medium-risk asks, high-risk
 * is blocked). This is that idea, implemented the opposite way round from a
 * denylist.
 *
 * THE ONLY SAFE DEFAULT IS A LIST OF THINGS, NOT A LIST OF EXCEPTIONS:
 *
 *   read     positively proven read-only, inside the workspace -> runs, no prompt
 *   act      anything else, including anything unrecognised       -> asks
 *   blocked  the existing catastrophic-command screen             -> refused outright
 *
 * Every rule here fails closed. A command with a pipe, a redirect, a `;`, a
 * `$(`, a backtick or an unknown flag is `act` — because reading the first word
 * and hoping is exactly how `ls; rm -rf ~` gets waved through.
 *
 * The argument that makes auto-allowing `read` acceptable at all: these
 * commands are *already* possible without a prompt through read_file, list_dir
 * and grep. This does not add a capability; it stops charging a human's
 * attention for one they already have. And the moment a path leaves the
 * workspace, the tier drops back to `act` — because `cat /etc/passwd` through
 * the shell is a capability those tools do NOT have.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

export const READ = "read";
export const ACT = "act";
export const BLOCKED = "blocked";

/**
 * Characters that can start a second command, expand into one, or redirect
 * output. If any appears, this is not a read.
 *
 * `*` and `?` are deliberately allowed: glob expansion of filenames cannot
 * execute anything, and rejecting them would reject `ls *.js` for no gain.
 */
const SHELL_METACHAR = /[;&|<>`$(){}\n\r\\!]/;

/**
 * The allowlist. A command is readable only if its first word is a key here,
 * and every flag it carries is in that key's list.
 *
 * `git` is by subcommand and each subcommand's flags are curated. `git diff`,
 * `git show` and `git log -p/--stat` are NOT in it: they run textconv and
 * external diff drivers declared in `.gitattributes`, which execute code from
 * inside the repository being inspected. A read-only list that includes a
 * command able to run a repo's own code is not read-only.
 */
const SAFE = new Map([
  ["ls", { flags: ["-l", "-a", "-la", "-al", "-lh", "-lah", "-1", "-h", "-t", "-r", "-S", "-R", "-A"] }],
  ["pwd", { flags: [] }],
  ["cat", { flags: ["-n", "-A", "-b", "-s"] }],
  ["head", { flags: ["-n", "-c"] }],
  ["tail", { flags: ["-n", "-c"] }],
  ["wc", { flags: ["-l", "-w", "-c"] }],
  ["stat", { flags: [] }],
  ["file", { flags: ["-b", "-i"] }],
  ["du", { flags: ["-s", "-h", "-sh", "-a"] }],
  ["grep", { flags: ["-n", "-i", "-r", "-R", "-l", "-c", "-v", "-E", "-F", "-w", "-rn", "-ri", "-in", "-rni"] }],
  ["which", { flags: [] }],
  ["node", { subcommands: ["--version", "-v"] }],
  ["npm", { subcommands: ["--version", "-v"] }],
  ["python3", { subcommands: ["--version", "-V"] }],
  ["git", {
    subcommands: ["status", "log", "branch", "remote"],
    // Per subcommand. Anything diff-shaped is absent on purpose: see above.
    flags: {
      status: ["--short", "-s", "--porcelain", "--branch", "-b"],
      log: ["--oneline", "-n", "--max-count", "--decorate", "--graph", "--all", "--no-color", "--author", "--grep", "--since", "--until", "-5", "-10", "-20", "-1"],
      branch: ["-a", "-r", "-v", "--all", "--remotes", "--list"],
      remote: ["-v"],
    },
  }],
]);

/** The catastrophic screen from tools.js, applied before anything else. */
function screen(command) {
  const flat = String(command).replace(/\s+/g, " ").trim();
  const DENY = [
    /\brm\s+(-[a-zA-Z]*\s+)*\/\s*$/,
    /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME|\$\{HOME\})\s*\/?\s*(\*)?\s*$/,
    /\b(mkfs|fdisk|parted)\b/,
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node|perl)\b/,
  ];
  return DENY.some((re) => re.test(flat));
}

function insideWorkspace(path, roots) {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // It may not exist yet; fall back to the literal path for the prefix test.
  }
  return roots.some((root) => path === root || path.startsWith(root + "/") || real === root || real.startsWith(root + "/"));
}

/**
 * @param {string} command
 * @param {object} [opts]
 * @param {string[]} [opts.workspaceRoots] absolutes this turn may read
 * @param {string} [opts.cwd] where the command will actually run. The shell tool
 *   accepts an arbitrary cwd, so `cat x` is only inside the workspace if the cwd
 *   is. Ignoring this would let `{command:"cat id_rsa", cwd:"/home/me/.ssh"}`
 *   classify as read-only.
 * @returns {{tier: "read"|"act"|"blocked", why: string}}
 */
export function classifyCommand(command, { workspaceRoots = [], cwd } = {}) {
  const raw = String(command || "").trim();
  if (!raw) return { tier: ACT, why: "empty command" };

  if (screen(raw)) return { tier: BLOCKED, why: "refused by the catastrophic-command screen" };
  if (SHELL_METACHAR.test(raw)) {
    return { tier: ACT, why: "contains a shell metacharacter (pipe, redirect, chain, or substitution)" };
  }

  const words = raw.split(/\s+/);
  const name = words[0];
  const spec = SAFE.get(name);
  // Where relative paths will land. An absolute cwd outside the workspace makes
  // every relative argument an escape, so it fails closed here rather than per path.
  const base = cwd
    ? (isAbsolute(cwd) ? cwd : resolvePath(workspaceRoots[0] || process.cwd(), cwd))
    : workspaceRoots[0] || process.cwd();
  if (spec && workspaceRoots.length && !insideWorkspace(base, workspaceRoots)) {
    return { tier: ACT, why: `the working directory "${base}" is outside the workspace` };
  }
  if (!spec) return { tier: ACT, why: `"${name}" is not on the read-only list` };

  // Version probes: exactly one argument, and it must be the version flag.
  if (spec.subcommands && name !== "git") {
    if (words.length === 2 && spec.subcommands.includes(words[1])) {
      return { tier: READ, why: `${name} ${words[1]} prints a version` };
    }
    return { tier: ACT, why: `${name} with anything but a version flag` };
  }

  let rest = words.slice(1);
  let flagsAllowed = spec.flags || [];

  if (name === "git") {
    const sub = rest[0];
    if (!sub || !spec.subcommands.includes(sub)) {
      return { tier: ACT, why: sub ? `git ${sub} is not on the read-only list` : "git with no subcommand" };
    }
    flagsAllowed = spec.flags[sub] || [];
    rest = rest.slice(1);
  }

  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.startsWith("-")) {
      // `-n 20` and `--max-count 20` are allowed: the flag is listed, the value
      // is the next word and carries no flags of its own.
      if (flagsAllowed.includes(w)) continue;
      if (flagsAllowed.includes(w.split("=")[0])) continue;
      return { tier: ACT, why: `flag "${w}" is not on ${name}'s read-only list` };
    }
    // A path-shaped argument must stay inside the workspace, exactly like
    // read_file. Everything else is a plain word (a grep pattern, a branch name).
    // Any word that could name a file is resolved the way the shell would:
    // against the cwd. `../etc/x`, `/etc/passwd` and `sub/dir` are all paths;
    // a bare word is a grep pattern or a branch name and names no file.
    const looksLikePath = w.startsWith("/") || w.startsWith("~") || w.includes("/") || /\.[a-z0-9]{1,8}$/i.test(w);
    if (!looksLikePath) continue;
    const path = resolvePath(base, w.replace(/^~(?=$|\/)/, homedir()));
    if (workspaceRoots.length && !insideWorkspace(path, workspaceRoots)) {
      return { tier: ACT, why: `"${w}" resolves outside the workspace (${path})` };
    }
  }

  return { tier: READ, why: `${name} is read-only here` };
}

/** One line for a human, or for the transcript. */
export function describeTier(result) {
  if (result.tier === BLOCKED) return `blocked — ${result.why}`;
  if (result.tier === READ) return `read-only, no prompt`;
  return `needs approval — ${result.why}`;
}
