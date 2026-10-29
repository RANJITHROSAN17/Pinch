# Security notes

Pinch is an agent with a shell. Read this before you leave it running.

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
2. **Workspace sandbox** — `resolveInWorkspace()` resolves symlinks and relative paths, then
   checks containment in `PINCH_WORKSPACE`. Escapes raise `SafePathError` and are surfaced
   to the model as a refusal.
3. **Command screen** — `screenCommand()` denies filesystem-wiping and block-device patterns
   with a stated reason, before approval is even requested.
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
7. **Resource bounds** — 8 tool rounds per turn, 120 s per command, stdout capped at 60 KB,
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
- [ ] allowlists filled for every enabled channel
- [ ] `data/` backed up or excluded from anything you sync to a cloud drive
- [ ] if you only use one machine: `PINCH_HOST=127.0.0.1`
- [ ] honesty guard left on (`PINCH_GUARD=on`)
- [ ] `data/profile.md` contains nothing you would not put in a plain text file
