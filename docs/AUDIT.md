# Security & robustness audit

**Subject:** Pinch v1.0 — commit `5242ea2`
**Date:** 30 October 2026
**Method:** black-box probing of a running instance, then white-box reading of the code paths the probes implicated
**Environment:** Linux (x86-64 sandbox), Node.js v20.20.2, `LLM_PROVIDER=mock`, zero runtime dependencies, no reverse proxy, `PINCH_KEY` deliberately left empty so the HTTP surface could be reached without a credential

---

## Why this document exists

The repository shipped with 35 passing tests and a green CI run. Then I stopped trusting
the test suite and started attacking the thing from the outside — because **tests written
by the author of the code inherit the author's blind spots**. They test what you thought
about. An adversary tests what you didn't.

That turned out to be the right instinct: six real defects were live in that green build,
including two that let an attacker read files outside the workspace and one that let any
website the user visits drive their personal assistant.

Everything below is reproducible with the commands given. None of it is theoretical, and
none of it is "fixed by documentation" — each finding has a code change and a regression
test that fails on the old code. Test counts were 35 before this audit and 91 after; **27 of
those 91 tests fail against `5242ea2`.**

---

## Result at a glance

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Sandbox escape: symlink in the workspace read `/etc/passwd` | **Critical** | Fixed + tested |
| 2 | Every shell command inherited `PINCH_KEY`, `TELEGRAM_TOKEN`, `OPENAI_API_KEY` | **Critical** | Fixed + tested |
| 3 | Any website could drive the assistant and read replies back (CSRF, no Origin check) | **High** | Fixed + tested |
| 4 | DNS rebinding: `Host: attacker.example` reached the API | **High** | Fixed + tested |
| 5 | Panel markdown renderer allowed attribute injection → XSS from model output | **High** | Fixed + tested |
| 6 | Command screen missed 9 of 18 catastrophic payloads | **Medium** | Fixed (partially — see residual risk) + tested |
| 7 | Timed-out shell command orphaned grandchildren that ran forever | **Medium** | Fixed + tested |
| 8 | Malformed JSON body answered `200` instead of `400` | Low | Fixed + tested |
| 9 | 3 MB body and `%zz` in a path each produced `500` | Low | Fixed + tested |

Severity here means: *given the intended deployment — a personal assistant you message all
day, with shell access to your machine and an LLM reading untrusted text.* Under that
threat model, "a webpage can POST to localhost:7777" is not theoretical.

---

## How the audit was run

Six probe classes, in increasing order of effort:

1. **Path containment probes** — symlinks, `../`, encoded traversal, absolute paths, both
   through `resolveInWorkspace()` directly and through the `read_file` / `write_file` tools.
2. **Command-screen sweep** — 18 payloads spanning destructive filesystem operations,
   privilege operations, remote-code-execution one-liners, and process bombs, each passed
   to `screenCommand()` and compared against the intent of the denylist.
3. **Process lifecycle** — a command that spawns a background child, forced to hit the
   timeout, then `pgrep` afterwards to see what survived.
4. **Injection probes** — five markdown/HTML payloads through the panel's `md()` renderer,
   extracted from `public/index.html` so the test exercises the shipped function rather
   than a copy.
5. **HTTP surface** — forged `Origin`, forged `Host`, malformed JSON, 3 MB body, `%zz`,
   `..%2f` static traversal, unknown endpoints, unsupported methods, 8 concurrent chats.
6. **Fault injection and load** — corrupt every JSON store on disk and reboot; time the
   hot endpoints and the tools, including with 300 sessions on disk.

Each finding below lists what I did, what came back, why it matters, what changed, and the
test that now guards it.

---

## 1. Sandbox escape through a symlink — Critical

**What I did**

```js
resolveInWorkspace('etclink/passwd')   // etclink -> /etc, created inside the workspace
```

**What came back**

The check passed, the path resolved to `/tmp/auditws/etclink/passwd`, and
`read_file` returned the real contents of `/etc/passwd`:

```
root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
```

**Why it matters**

The workspace boundary is the single guarantee that makes shell-adjacent tools tolerable.
It was enforced lexically — `relative(root, absolutePath)` — which is a *string* comparison.
A symlink is a *filesystem* fact. A model following instructions from a poisoned web page
or a pasted file could create the link itself with `shell` (`ln -s /etc etclink`) and then
read anything: SSH keys, browser profiles, cloud credentials, `/etc/shadow` on an
unprivileged account.

This is the archetypal "the guard is a sign, not a wall" bug, and the fix is the
archetypal answer: ask the filesystem where the path actually points.

**What changed** — `src/tools.js`

`resolveInWorkspace()` now canonicalises through `realpathSync()` on the deepest existing
ancestor (so a not-yet-created file is still checked against its real parent), then
re-applies the containment test to the canonical paths of both the target and every allowed
root. The lexical check stays first, purely so the error message can distinguish
"you typed `../`" from "a symlink points outside". A symlink that stays *inside* the
workspace still works, which matters for legitimate `node_modules`-style layouts.

**Guarded by** — `test/audit.test.js`: *a symlink pointing outside the workspace is
refused*, *read_file does not leak a file through a workspace symlink*, *write_file cannot
be aimed outside the workspace through a symlink*, *a symlink to a directory inside the
workspace still works*, *plain ../ traversal is still refused*.

**Residual risk** — TOCTOU: between the realpath check and the `open()`, a symlink could in
principle be swapped. Closing that needs `O_NOFOLLOW`/`openat` semantics, which Node does
not expose portably. In practice the attacker would need concurrent local code execution,
at which point they do not need the agent. Documented, not fixed; the honest answer.

---

## 2. Every tool command inherited the assistant's secrets — Critical

**What I did**

```js
runShell('env | grep -E "TOKEN|KEY|SECRET"')
```

**What came back**

```
PINCH_KEY=...
TELEGRAM_TOKEN=...
OPENAI_API_KEY=...
```

**Why it matters**

`runShell` passed `{ ...process.env }` to the child. So *any* command the agent ran — a
test suite, a `git` hook in a cloned repo, a `postinstall` script, or a command suggested by
a poisoned web page — could read the bot token and the model API key in one line and POST
them anywhere. The approval gate does not help: the human approves `npm install`, not the
credential exfiltration buried in it. This defeated the "bring your own key" model entirely,
because the attacker never had to steal the key — the agent handed it over.

**What changed** — `src/tools.js`

`childEnv()` builds the child environment by filtering out anything matching
`TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|_KEY|SESSION|COOKIE`
(case-insensitive), then sets `PINCH=1`. `PATH`, `HOME`, locale and everything else that
makes commands work survives. When a build genuinely needs a credential, it can be
re-admitted by name:

```bash
PINCH_ENV_PASSTHROUGH=NPM_TOKEN,GITHUB_TOKEN
```

Opt-in and named, rather than all-or-nothing and silent.

**Guarded by** — *childEnv strips credential-shaped variables*, *a shell command cannot read
the assistant's secrets*, *PINCH_ENV_PASSTHROUGH re-admits a named variable*.

**Residual risk** — the filter is name-based. A secret stashed in a variable called
`CONFIG_BLOB` is still passed. That is why Pinch's own config lives in `.env` (read by the
parent, never exported to children) and why the docs pair this with "don't park secrets in
the assistant's environment".

---

## 3. Any website could drive the assistant — High

**What I did**

```bash
curl -X POST http://127.0.0.1:7777/api/chat \
  -H 'Origin: https://evil.example' \
  -H 'content-type: application/json' \
  -d '{"text":"..."}'
```

**What came back**

`200`. The tool ran. And the response carried:

```
access-control-allow-origin: https://evil.example
```

— the request's own `Origin` echoed back, which is the exact condition a browser needs to
hand the response body to the calling page.

**Why it matters**

Two failure modes stacked. Without an `Origin` check, a malicious page can fire
`fetch('http://127.0.0.1:7777/api/chat', {mode:'no-cors', ...})` at the loopback interface
of anyone running Pinch — the browser will deliver it. With the reflected ACAO, it becomes a
*readable* cross-origin request, so the attacker sees the reply: files, memory, whatever the
assistant says. Worse, if a dangerous action is pending, the same page can answer
`{"text":"yes"}` and the approval gate is bypassed by the attacker, not the owner.

The API being "local" is not a defence. Loopback is reachable from every page in the
browser; that is precisely what CSRF is.

**What changed** — `src/server.js`

An `originAllowed()` check runs before routing:

- a browser-supplied `Origin` must resolve to a name in the allowlist (`localhost`,
  `127.0.0.1`, `[::1]`, every LAN address Pinch advertises, plus `PINCH_ALLOWED_HOSTS`);
- the opaque `null` origin is refused;
- requests with **no** `Origin` still work — `curl`, the CLI and native clients don't send
  one, and refusing them would be security theatre that breaks tooling;
- ACAO is only ever set to an origin that passed the check. Never reflected blindly.

**Guarded by** — *a foreign Origin cannot drive the assistant*, *a foreign Origin never gets
an Access-Control-Allow-Origin header*, *an opaque sandbox Origin is refused*, plus the
positive controls *a same-origin browser request is allowed* and *a request with no Origin
is allowed*.

---

## 4. DNS rebinding reached the API — High

**What I did**

```bash
curl http://127.0.0.1:7777/api/health -H 'Host: attacker.example'
```

**What came back**

`200`.

**Why it matters**

Rebinding is the attack the Origin check alone does not stop: the attacker's domain
resolves to `127.0.0.1`, so the browser thinks it is same-origin with `attacker.example` and
sends `Origin: http://attacker.example` — which the naive fix above would also accept. The
`Host` header is the tell, because it is the name the browser actually asked for.

**What changed** — `src/server.js`

`Host` is validated against the same allowlist, before anything else runs. Wildcards are
supported for proxies and tunnels — `PINCH_ALLOWED_HOSTS='*.trycloudflare.com'` — and the
matcher refuses `evil.com.attacker.net` style suffixes, which a naive `endsWith` would let
through. Also: the request URL is now parsed against a constant base, so a forged `Host` can
never influence how Pinch interprets its own path.

**Guarded by** — *a Host header that is not this machine is refused*, *a DNS-rebinding
attempt is refused even with a matching Origin*, *loopback and LAN names are still accepted*.

**Note on deployment** — this is exactly what caught the sandbox preview during this audit:
the preview proxy's hostname was refused until it was added to `PINCH_ALLOWED_HOSTS`. That
is the feature working. The refusal message names the variable to change.

---

## 5. XSS in the panel's markdown renderer — High

**What I did**

```js
md('[x](https://a.example/"onmouseover="alert(1))')
```

**What came back**

```html
<a href="https://a.example/"onmouseover="alert(1)" target="_blank" ...>x</a>
```

The quote inside the URL closed the `href` attribute and opened a real event handler.

**Why it matters**

The renderer escaped `&`, `<`, `>` — but not `"` — *before* capturing the URL, so the quote
survived into the attribute. Model output is not trusted input: the assistant reads web
pages, files and messages, and a prompt injection can put a crafted link in a reply. The
panel is served from the origin that holds the API key and the SSE stream, so a payload
there is not a defaced page — it is the whole assistant.

Worth noting what was *fine*: raw HTML in replies was correctly escaped (three of five
payloads were already inert), and `javascript:` links never matched the `https?://` pattern.
The bug was narrower than "no escaping" — and a test suite that only checked
`<script>` would have missed it.

**What changed** — `public/index.html`

The replacement callback now parses the URL with `new URL()`, allows only `http:`/`https:`
(anything else degrades to plain text), re-serialises it, and percent-encodes
`" ' < >` before insertion. Links also carry `rel="noopener noreferrer"`.

**Guarded by** — *md() neutralises an attempt to break out of the href attribute* (which
parses the emitted tag and asserts the attribute names are exactly
`href rel style target`), *md() refuses javascript: and data: URLs*, *md() escapes raw HTML
in model output*, *md() still renders ordinary links and bold text*, *rendered links can
never reach back into the opener*.

---

## 6. The command screen missed 9 of 18 payloads — Medium

**What I did**

Ran 18 payloads through `screenCommand()`:

| Payload | Before | After |
|---|---|---|
| `rm -rf /` | blocked | blocked |
| `rm -rf /*` | blocked | blocked |
| `rm -rf ~` | blocked | blocked |
| `rm -rf $HOME` | **allowed** | blocked |
| `rm -rf ${HOME}` | **allowed** | blocked |
| `rm -rf ..` | **allowed** | blocked |
| `rm -rf .` | **allowed** | blocked |
| `find / -delete` | **allowed** | blocked |
| `find / -name '*.log' -delete` | **allowed** | blocked |
| `curl … \| sh` | **allowed** | blocked |
| `wget -qO- … \| bash` | **allowed** | blocked |
| `dd if=/dev/zero of=/dev/sda` | blocked | blocked |
| `mkfs.ext4 /dev/sda1` | blocked | blocked |
| fork bomb | blocked | blocked |
| `shutdown -h now` | **allowed** | blocked |
| `echo x > /etc/passwd` | allowed | allowed, **flagged** (outside workspace) |
| `chmod -R 000 /home` | **allowed** | allowed, **flagged** — not fatal enough to block, risky enough to name |
| `git push --force` | allowed | allowed — irreversible on the remote, but not destructive locally; the human sees the command |
| `npm publish` | allowed | allowed — same reasoning: publishing is a decision, not an accident |

**Why it matters**

`rm -rf $HOME` is `rm -rf ~` spelled differently, and it went straight through: the regex
matched literal `/` and `~`, not the shell's expansion of them. `find / -delete` deletes a
filesystem without ever invoking `rm`. `curl | sh` is the standard delivery vehicle for
malware. These are not exotic.

**What changed** — `src/tools.js`

- the denylist now covers `$HOME`/`${HOME}`/`.`/`..`, `find / … -delete`, pipe-to-interpreter
  (`curl|sh`, `wget|bash`, and the `python`/`node`/`perl` variants), `chmod -R 777|000 /`,
  `chown -R … /`, `shutdown|reboot|halt|poweroff`, and keeps the original rocket-fuel cases;
- **and** `describeEscapes()` reports absolute paths in the command that fall outside the
  workspace. The agent surfaces them in the approval prompt:

  ```
  run: cat /etc/shadow      ⚠ outside workspace: /etc/shadow
  ```

  so the human decision is informed rather than blind.

**Why it is only Medium** — because it is a denylist, and denylists are structurally
incomplete. Obscuring a path (`rm -rf $(echo L2hvbWU=|base64 -d)`) will always get past a
regex. The fix is therefore honest about layers: **the screen is a smoke alarm, the approval
gate is the fire door, and the env scrub is the safe.** Pinch does not claim the screen is a
sandbox.

**Guarded by** — 15 *screen blocks* tests and 9 *screen allows routine work* tests, which
exist so a future "tightening" cannot silently break `rm -rf node_modules`.

**Residual risk** — an obfuscated command still reaches the human for approval. That is the
designed last line of defence, and it depends on the human reading the command. Pinch does
not pretend otherwise; the panel shows the exact command, with no truncation, and flags
paths outside the workspace.

---

## 7. Timed-out commands left grandchildren running — Medium

**What I did**

```js
runShell('sh -c "sleep 45 & echo spawned; wait"', { timeoutMs: 1200 })
```

**What came back**

`killed: true`, and one second later a `sleep 45` was still running and still `pgrep`-able.
The timeout killed the shell, not the process group, so anything it had spawned was
reparented to init and ran to completion.

**Why it matters**

Every `timeoutMs` cap was decorative for anything that backgrounded work — a dev server, a
watch loop, a `npm run` with workers. Worse, the surviving child kept the parent's stdio
pipes open, which is why the first full run of the new test file **hung the entire test
runner instead of reporting a failure**. A leaked process that also hangs its parent turns a
timeout into an outage.

**What changed** — `src/tools.js`

Children are spawned `detached` (own process group, POSIX; unchanged on Windows, where the
notion does not exist), and the timeout kills the **group** with `process.kill(-pid, 'SIGKILL')`,
falling back to the single pid if the group is already gone.

**Guarded by** — *a timeout kills the whole process tree, not just the shell* (runs a
uniquely-named script, forces a timeout, then asserts `pgrep` finds nothing), and *runShell
still returns output for commands that finish in time*.

---

## 8–9. HTTP semantics — Low

| Probe | Before | After |
|---|---|---|
| `POST /api/chat` with `{oops` | `200`, body silently treated as prompt text | `400 {"error":"body must be JSON"}` |
| 3 MB JSON body | `500` | `413 {"error":"body larger than 2000 KB"}` |
| `GET /api/%zz` | `500` (URIError escaped the handler) | `404` — a clean 4xx, never a 5xx |
| `GET /..%2f..%2f..%2fetc%2fpasswd` | `500` | `404`, nothing read |
| `GET /api/nope` | `404` | `404` |
| `PUT /api/chat` | `404` | `404` |

**Why it matters** — a `500` is a stack-trace-shaped hint that the parser is brittle, and
"malformed JSON is a prompt" quietly let any client inject text with a broken request. None
of these are exploitable alone; together they are the difference between a service that
degrades cleanly and one that panics.

**What changed** — `src/server.js`: an `HTTPError` type with status codes, JSON body parsing
that refuses rather than guesses, and a top-level guard so no thrown error can escape as an
unhandled rejection. Cookie decoding can no longer throw either. The request URL is parsed
against a constant base and inside the try/catch.

**Guarded by** — *malformed JSON is rejected with 400*, *an oversized body is rejected with
413*, *malformed percent-encoding is a 4xx, never a 500*, *a static path traversal attempt
cannot read /etc/passwd*, *an unknown endpoint is a clean 404*.

---

## What actually held up

An audit that only lists failures is not an audit, it is a hit piece. These were attacked
and did not break:

| Probe | Result |
|---|---|
| Corrupt `sessions/*.json`, `memory.json`, `reminders.json`, then boot | Boots. Bad records are skipped, not fatal; `/api/session/broken` returns `[]`, `/api/memory` returns `{}` |
| Static traversal (`..%2f`, absolute paths, encoded) | Refused; `public/` boundary held (only the *status code* was wrong) |
| Raw HTML / `<script>` in model output | Escaped in the panel |
| `javascript:` / `data:` links in model output | Inert — the renderer only ever matched `https?://` |
| 8 concurrent chats | All 8 persisted; no lost writes |
| Denied approval | The command genuinely did not run (no file created) |
| Honesty guard | Flagged `action-without-evidence` and `invented-email` on fabricated replies |
| Reminder round-trip | Stored, survived a clock rewind, fired through the scheduler |
| Secrets in the repository | `git grep` found none; `.env` is ignored |
| Session id sanitation | Traversal-shaped ids normalised to safe filenames |

Performance, measured in this environment (mock brain, warm process, single thread):

| Operation | Time |
|---|---|
| `GET /api/health` (incl. connection setup) | 39 ms |
| `GET /` (panel HTML, 1 file) | 4.6 ms |
| `GET /api/sessions` (301 sessions, 2.4 MB on disk) | 13.5 ms |
| `POST /api/chat` one mock turn, streamed | 9.3 ms |
| `calculator` ×1000 | 6.8 ms total |
| `grep` over `src/` | 6.1 ms |
| `shell` spawn + echo round-trip | 6.6 ms |
| `resolveInWorkspace` (now with `realpath`) ×1000 | 40 ms total (0.04 ms each) |

The `realpath` fix costs 40 microseconds per tool call. That is the entire price of closing
finding 1.

---

## How to reproduce this audit

```bash
git clone https://github.com/RANJITHROSAN17/pinch && cd pinch
npm install --omit=dev         # zero dependencies; this just writes nothing

# the whole suite, including every regression test above
node --test

# see the regressions fail against the pre-fix code:
git stash push src/ public/
node --test --test-force-exit test/audit.test.js test/http-surface.test.js
git stash pop
```

Before the fixes, that stashed run produced 27 failures — and, on the process-lifecycle
test, did not terminate at all. After them: 91 tests, 91 passing, 0 failing.

---

## Residual risk register — what is still true after the fixes

Honesty is the feature. These are known, accepted, and documented rather than hidden:

| Risk | Why it remains | Mitigation |
|---|---|---|
| The command screen is a denylist | Obfuscation always wins against pattern matching | Approval gate shows the exact command; outside-workspace paths are flagged; `PINCH_AUTO_APPROVE` is off by default |
| Approval depends on a human reading | Social engineering, approval fatigue | The prompt shows the full command, never truncated; dangerous tools are a fixed list of 4 |
| No OS-level sandbox | No containers, no seccomp, no chroot — zero-dependency by design | Documented plainly; "run it as a user you wouldn't mind losing" is the advice, and it is in `docs/SECURITY.md` |
| TOCTOU between `realpath` and `open` | Node exposes no `O_NOFOLLOW`-portable open | Requires concurrent local code execution, which already implies compromise |
| Prompt injection through tool output | Anything the model reads can steer it | Guard audits replies for unbacked claims; dangerous tools still need approval; the env scrub limits what a command can reach |
| Shell commands can still read world-readable system files | Confinement is by workspace *path*, not by privilege | Paths outside the workspace are surfaced in the approval prompt |
| `PINCH_ENV_PASSTHROUGH` re-admits chosen secrets | Needed for real builds | Explicit, per-name opt-in |
| No TLS in the built-in server | A local-first tool should not ship certificate management | Put it behind a proxy if you expose it; `PINCH_ALLOWED_HOSTS` covers the hostname, not the transport |
| WhatsApp channel (unofficial) | Not the official API | Off by default; ToS and ban risk documented in `docs/CHANNELS.md` |
| `data/sessions` is read wholesale to list sessions | Simplicity, at 13 ms for 300 sessions | Fine to thousands of sessions; a real database would break "read your own data with `cat`" |

---

## The lesson worth taking from this

Every one of the six serious findings was invisible to a green test suite, and four of them
were configuration-shaped: an environment variable passed wholesale, a header never checked,
a path compared as a string. Those are the bugs that reviews skip because the code "looks
right". They are only visible when you run the thing and attack it — which is why
`test/audit.test.js` and `test/http-surface.test.js` now exist, and why they are written
from the attacker's side of the fence.

The other lesson is about how a project talks about itself. Pinch's README said "approval
gate, workspace sandbox, honest guard". All three were real. The sandbox still had a hole,
and the right response to finding it is this document — not a quiet patch, and not a
deleted paragraph in the README.

🦞
