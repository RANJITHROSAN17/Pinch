# Security notes

**Reporting a vulnerability:** use [GitHub's private advisory form](https://github.com/pinchfoundry/Pinch/security/advisories/new) —
not a public issue. The full policy (what is in scope, response times, what is
already known and accepted) is in the [repository security policy](../SECURITY.md).

Pinch is an agent with a shell. Read this before you leave it running.

> **Audited.** This file describes the design. What an external attacker actually
> achieved against a running build — six defects, including two critical ones — is in
> [`AUDIT.md`](AUDIT.md), with the fixes and the regression tests that guard them. The
> short version: the test suite was green while all six were live, which is why the audit
> exists.

## Threat model

| Adversary | In scope? | Defence |
|---|---|---|
| A stranger who guesses your bot's username | Yes | per-channel allowlists (ids, channels, numbers) |
| Another device on your Wi-Fi | Yes | `PINCH_KEY` on every page and `/api` call |
| A malicious web page or file read by the model (prompt injection) | Yes | approval gate on every mutating action; the model cannot bypass it |
| A buggy or over-eager model | Yes | 8-round cap, command screen, workspace sandbox |
| Someone with physical/OS access to the machine | No | full-disk encryption is on you |
| The model provider, if you choose a cloud one | No — that is the deal | keep `LLM_PROVIDER=ollama` for true local privacy |

## What is enforced in code

1. **Approval gate** — `agent.js` blocks `shell` and `write_file` until a human answers.
   Default deny. 10-minute expiry. Denials are fed back to the model as text so it stops
   rather than retrying.
2. **Workspace sandbox** — `resolveInWorkspace()` canonicalises the path through
   `realpathSync()` (deepest existing ancestor, so new files are checked against their real
   parent), then checks containment of both the target and every allowed root. This closes
   the symlink escape found in the audit: a lexical check passes `link -> /etc` and reads
   `/etc/passwd`. Escapes raise `SafePathError` and are surfaced to the model as a refusal.
3. **Command screen** — `screenCommand()` denies filesystem-wiping, block-device, fork-bomb,
   pipe-to-interpreter (`curl … | sh`), `find / -delete` and power-off patterns with a stated
   reason, before approval is even requested. Absolute paths outside the workspace are
   *flagged in the approval prompt* rather than blocked, so the human sees
   `run: cat /etc/shadow ⚠ outside workspace: /etc/shadow`. The screen is a smoke alarm, not
   a sandbox; the approval gate is the load-bearing control.
4. **No dynamic code** — the calculator is a shunting-yard parser. There is no `eval`,
   no `new Function`, nowhere.
5. **Honesty audit (`src/guard.js`)** — after every reply, code checks the model's claims
   against the tools that actually ran: "I sent it" with no tool that sends, an email address
   nobody supplied, a URL nothing fetched, or "I remember…" with empty memory. Mismatches are
   appended to the reply for the user to see. This defends against a *model* being wrong, which
   prompting alone does not fix.
6. **Reminder delivery is addressed, not broadcast** — a reminder is pinned to the
   `channel:target` that created it, so it cannot leak into another chat. If that channel is
   offline it falls back to the local web panel and logs why; it never silently disappears.
7. **Child processes get a scrubbed environment** — `childEnv()` strips every variable that
   looks like a credential (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `_KEY`, `SESSION`,
   `COOKIE`, …) before `runShell` spawns anything, so a command the model runs — or a
   `postinstall` script in a repo it clones — cannot read `PINCH_KEY`, `TELEGRAM_TOKEN` or
   `OPENAI_API_KEY`. Specific names can be re-admitted with `PINCH_ENV_PASSTHROUGH`.
8. **Host and Origin are validated** — every request is checked before routing: a forged
   `Host` (DNS rebinding) is refused, a foreign `Origin` (CSRF from any page you visit) is
   refused, and `Access-Control-Allow-Origin` is never reflected blindly. Requests with no
   `Origin` still work, so `curl` and the CLI are unaffected. Extra names go in
   `PINCH_ALLOWED_HOSTS`, wildcards included.
9. **Timeouts kill the process group** — a command that backgrounds children is killed with
   `process.kill(-pid, 'SIGKILL')`, so nothing survives the 120 s cap.
10. **Resource bounds** — 8 tool rounds per turn, 120 s per command, stdout capped at 60 KB,
   sessions capped at 200 messages, memory at 500 facts.

## Known risks you accept by running it

- **Approving a destructive command.** The gate shows you exactly what will run. If you tap
  Allow on `rm -rf`, it runs. The human is the last line of defence, on purpose.
- **Prompt injection via tool output.** A search result or file can contain instructions
  aimed at the model. This is why mutating actions are gated: injected text still needs your
  approval to act.
- **WhatsApp automation.** Unofficial protocol; against WhatsApp ToS; accounts get banned.
  Use a secondary number or skip it.
- **Cloud providers.** `LLM_PROVIDER=openai` sends your prompts to that endpoint. Visible in
  `.env`, never the default.
- **Screenshots.** The `screenshot` tool captures the whole screen, which may include things you
  did not intend to show a model. It is behind the approval gate and the file stays local, but
  read the prompt before allowing it.
- **`system_control`** can lock or sleep the machine. Shutdown and reboot are deliberately not
  implemented, so a confused model cannot power off a workstation mid-job.

## Hardening checklist

- [ ] `PINCH_KEY` set (the wizard generates one)
- [ ] `PINCH_AUTO_APPROVE=false`
- [ ] `PINCH_WORKSPACE` narrow — a projects folder, not `~`
- [ ] `PINCH_ENV_PASSTHROUGH` empty unless a build genuinely needs one named secret
- [ ] `PINCH_ALLOWED_HOSTS` set only for a proxy or tunnel you control
- [ ] `node --test` green — 91 tests, including `test/audit.test.js` and `test/http-surface.test.js`
- [ ] allowlists filled for every enabled channel
- [ ] `data/` backed up or excluded from anything you sync to a cloud drive
- [ ] if you only use one machine: `PINCH_HOST=127.0.0.1`
- [ ] honesty guard left on (`PINCH_GUARD=on`)
- [ ] `data/profile.md` contains nothing you would not put in a plain text file
